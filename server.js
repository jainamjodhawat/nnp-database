require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Auth configuration
const APP_PASSWORD = process.env.APP_PASSWORD ? String(process.env.APP_PASSWORD).trim() : '';

// Derive auth secret deterministically from APP_PASSWORD so tokens remain valid across server restarts
const AUTH_SECRET = APP_PASSWORD
  ? crypto.createHash('sha256').update('yatra_salt:' + APP_PASSWORD).digest('hex')
  : 'no_auth';

function generateAuthToken() {
  const timestamp = Date.now();
  const raw = `authenticated:${timestamp}`;
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(raw).digest('hex');
  return Buffer.from(`${raw}:${sig}`).toString('base64');
}

function verifyAuthToken(token) {
  if (!APP_PASSWORD) return true;
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length !== 3 || parts[0] !== 'authenticated') return false;
    const raw = `${parts[0]}:${parts[1]}`;
    const sig = parts[2];
    const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(raw).digest('hex');
    return sig === expectedSig;
  } catch (e) {
    return false;
  }
}

function checkAuth(req) {
  if (!APP_PASSWORD) return true;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (verifyAuthToken(token)) return true;
  }
  if (req.headers['x-app-password'] && req.headers['x-app-password'] === APP_PASSWORD) {
    return true;
  }
  if (req.query && req.query.token && verifyAuthToken(req.query.token)) {
    return true;
  }
  return false;
}

// Middleware
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Server-Sent Events (SSE) subscribers for live cross-device sync
let sseClients = [];

function broadcastUpdate(lastModified) {
  const data = JSON.stringify({ type: 'update', lastModified });
  sseClients.forEach(client => {
    try {
      client.write(`data: ${data}\n\n`);
    } catch (e) {}
  });
}

// Keep-alive heartbeat for SSE (every 25 seconds)
setInterval(() => {
  sseClients.forEach(client => {
    try {
      client.write(': keepalive\n\n');
    } catch (e) {}
  });
}, 25000);

// Public Auth Endpoints
app.get('/api/auth/status', (req, res) => {
  const authRequired = !!APP_PASSWORD;
  const authenticated = checkAuth(req);
  res.json({ authRequired, authenticated });
});

app.post('/api/auth/login', (req, res) => {
  if (!APP_PASSWORD) {
    return res.json({ ok: true, token: 'no_auth', message: 'No password required' });
  }
  const { password } = req.body || {};
  if (password === APP_PASSWORD) {
    const token = generateAuthToken();
    return res.json({ ok: true, token });
  }
  return res.status(401).json({ ok: false, error: 'Incorrect password' });
});

// Protect all remaining /api/* routes with password check
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path === '/health') return next();
  if (!checkAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized', authRequired: true });
  }
  next();
});

// Protected API Routes
app.get('/api/data', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const data = await db.getAll();
    const counts = await db.getCounts();
    res.json({
      ...data,
      storage: counts.storage,
      cloudActive: counts.cloudActive
    });
  } catch (err) {
    console.error('Error fetching data:', err);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

app.post('/api/save', async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'Invalid payload' });
    }
    const result = await db.saveAll(payload);
    broadcastUpdate(result.lastModified);
    res.json(result);
  } catch (err) {
    console.error('Error saving data:', err);
    res.status(500).json({ error: 'Failed to save data' });
  }
});

// SSE endpoint
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  sseClients.push(res);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

// Export full database backup
app.get('/api/backup', async (req, res) => {
  try {
    const backup = await db.getBackup();
    const dateStr = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Disposition', `attachment; filename="yatra-backup-${dateStr}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(backup, null, 2));
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ error: 'Failed to create backup' });
  }
});

// Restore database from backup
app.post('/api/backup/restore', async (req, res) => {
  try {
    const backupData = req.body;
    const result = await db.restoreBackup(backupData);
    broadcastUpdate(result.lastModified);
    res.json({ ok: true, message: 'Database restored successfully', lastModified: result.lastModified });
  } catch (err) {
    console.error('Restore error:', err);
    res.status(500).json({ error: 'Failed to restore backup: ' + err.message });
  }
});

// Health check endpoint (for deployment monitoring e.g. Render, Railway, Fly, Docker)
app.get('/api/health', async (req, res) => {
  try {
    const counts = await db.getCounts();
    res.json({
      status: 'ok',
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      authProtection: !!APP_PASSWORD,
      ...counts
    });
  } catch (err) {
    res.status(500).json({ error: 'Healthcheck error: ' + err.message });
  }
});

// Fallback to single page app
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
let server;
async function start() {
  await db.init();
  const counts = await db.getCounts();

  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`
=====================================================
  🛕 Yatra Desk is running!
  URL: http://localhost:${PORT}
  Active Database: ${counts.storage}
  Password Protection: ${APP_PASSWORD ? 'ENABLED (Locked)' : 'DISABLED (Open access)'}
  Ready for production deployment.
=====================================================
`);
  });
}

start().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

// Graceful shutdown
const shutdown = () => {
  console.log('Shutting down server gracefully...');
  if (server) {
    server.close(() => {
      console.log('Server stopped.');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
