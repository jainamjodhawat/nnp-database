require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

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

// API Routes
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
