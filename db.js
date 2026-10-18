require('dotenv').config();
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'yatra.db');
const JSON_BACKUP_PATH = path.join(DATA_DIR, 'yatra.json');

// Ensure local data directory exists for local backups
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let activeDriver = 'local'; // 'mongodb' | 'postgres' | 'sqlite' | 'json'
let mongoClient = null;
let mongoDb = null;
let pgPool = null;
let sqliteDb = null;
let lastCloudError = null;

// Atomically write JSON file for local snapshot
function atomicWriteJson(filePath, data) {
  try {
    const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (e) {
    console.error('Failed to write local JSON snapshot:', e.message);
  }
}

function readJsonBackup() {
  if (fs.existsSync(JSON_BACKUP_PATH)) {
    try {
      const raw = fs.readFileSync(JSON_BACKUP_PATH, 'utf8');
      return JSON.parse(raw);
    } catch (e) {}
  }
  return null;
}

// -------------------------------------------------------------
// 1. MONGODB ATLAS CLOUD DRIVER
// -------------------------------------------------------------
async function initMongo(uri) {
  const cleanUri = String(uri).trim().replace(/^["']|["']$/g, '');
  const { MongoClient } = require('mongodb');
  mongoClient = new MongoClient(cleanUri, {
    serverSelectionTimeoutMS: 30000,
    connectTimeoutMS: 30000,
  });
  console.log('Connecting to MongoDB Atlas (timeout: 30s)...');
  await mongoClient.connect();
  // Use db from URI or default to 'yatra_desk'
  const urlObj = new URL(cleanUri.replace('mongodb+srv://', 'http://').replace('mongodb://', 'http://'));
  const dbName = (urlObj.pathname && urlObj.pathname.length > 1) ? urlObj.pathname.slice(1) : 'yatra_desk';
  mongoDb = mongoClient.db(dbName);
  
  // Create indexes
  await mongoDb.collection('trips').createIndex({ id: 1 }, { unique: true });
  await mongoDb.collection('people').createIndex({ id: 1 }, { unique: true });
  await mongoDb.collection('regs').createIndex({ id: 1 }, { unique: true });
  
  activeDriver = 'mongodb';
  console.log(`✓ Connected to Cloud Database: MongoDB Atlas (${dbName})`);
}

async function mongoGetAll() {
  const [tripsDocs, peopleDocs, regsDocs, metaDoc] = await Promise.all([
    mongoDb.collection('trips').find({}).toArray(),
    mongoDb.collection('people').find({}).toArray(),
    mongoDb.collection('regs').find({}).toArray(),
    mongoDb.collection('meta').findOne({ _id: 'lastModified' })
  ]);

  const trips = {};
  for (const d of tripsDocs) {
    const id = d.id || d._id;
    delete d._id;
    trips[id] = d;
  }
  const people = {};
  for (const d of peopleDocs) {
    const id = d.id || d._id;
    delete d._id;
    people[id] = d;
  }
  const regs = {};
  for (const d of regsDocs) {
    const id = d.id || d._id;
    delete d._id;
    regs[id] = d;
  }

  return {
    people,
    regs,
    trips,
    lastModified: metaDoc ? metaDoc.val : Date.now()
  };
}

async function mongoSaveAll(data) {
  const people = data.people || {};
  const regs = data.regs || {};
  const trips = data.trips || {};
  const lastModified = Date.now();

  const session = mongoClient.startSession();
  try {
    await session.withTransaction(async () => {
      // 1. Trips: replace or update
      const tripList = Object.entries(trips).map(([id, t]) => ({ ...t, id, _id: id }));
      await mongoDb.collection('trips').deleteMany({ id: { $nin: Object.keys(trips) } }, { session });
      if (tripList.length > 0) {
        const ops = tripList.map(t => ({
          replaceOne: {
            filter: { _id: t._id },
            replacement: t,
            upsert: true
          }
        }));
        await mongoDb.collection('trips').bulkWrite(ops, { session });
      }

      // 2. People
      const peopleList = Object.entries(people).map(([id, p]) => ({ ...p, id, _id: id }));
      await mongoDb.collection('people').deleteMany({ id: { $nin: Object.keys(people) } }, { session });
      if (peopleList.length > 0) {
        const ops = peopleList.map(p => ({
          replaceOne: {
            filter: { _id: p._id },
            replacement: p,
            upsert: true
          }
        }));
        await mongoDb.collection('people').bulkWrite(ops, { session });
      }

      // 3. Regs
      const regsList = Object.entries(regs).map(([id, r]) => ({ ...r, id, _id: id }));
      await mongoDb.collection('regs').deleteMany({ id: { $nin: Object.keys(regs) } }, { session });
      if (regsList.length > 0) {
        const ops = regsList.map(r => ({
          replaceOne: {
            filter: { _id: r._id },
            replacement: r,
            upsert: true
          }
        }));
        await mongoDb.collection('regs').bulkWrite(ops, { session });
      }

      // 4. Meta
      await mongoDb.collection('meta').updateOne(
        { _id: 'lastModified' },
        { $set: { val: lastModified } },
        { upsert: true, session }
      );
    });
  } finally {
    await session.endSession();
  }

  // Local snapshot
  atomicWriteJson(JSON_BACKUP_PATH, { people, regs, trips, lastModified });
  return { ok: true, lastModified };
}

// -------------------------------------------------------------
// 2. POSTGRESQL CLOUD DRIVER (Supabase, Neon, Render Postgres)
// -------------------------------------------------------------
async function initPostgres(connString) {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: connString,
    ssl: connString.includes('localhost') ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000
  });

  const client = await pgPool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS trips (
        id TEXT PRIMARY KEY,
        name TEXT,
        dest TEXT,
        start TEXT,
        "end" TEXT,
        cap INTEGER,
        status TEXT,
        special TEXT,
        created BIGINT,
        data JSONB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS people (
        id TEXT PRIMARY KEY,
        first TEXT,
        last TEXT,
        nk TEXT,
        gender TEXT,
        age INTEGER,
        phone TEXT,
        wa TEXT,
        email TEXT,
        id_last4 TEXT,
        id_hash TEXT,
        created BIGINT,
        data JSONB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS regs (
        id TEXT PRIMARY KEY,
        trip_id TEXT,
        person_id TEXT,
        paid BOOLEAN,
        chk BOOLEAN,
        special TEXT,
        data JSONB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        val TEXT NOT NULL
      );
    `);
    activeDriver = 'postgres';
    console.log('✓ Connected to Cloud Database: PostgreSQL');
  } finally {
    client.release();
  }
}

async function pgGetAll() {
  const [tRes, pRes, rRes, mRes] = await Promise.all([
    pgPool.query('SELECT id, data FROM trips'),
    pgPool.query('SELECT id, data FROM people'),
    pgPool.query('SELECT id, data FROM regs'),
    pgPool.query("SELECT val FROM meta WHERE key = 'lastModified'")
  ]);

  const trips = {};
  for (const row of tRes.rows) {
    trips[row.id] = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  }
  const people = {};
  for (const row of pRes.rows) {
    people[row.id] = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  }
  const regs = {};
  for (const row of rRes.rows) {
    regs[row.id] = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  }
  const lastModified = mRes.rows.length ? Number(mRes.rows[0].val) : Date.now();

  return { people, regs, trips, lastModified };
}

async function pgSaveAll(data) {
  const people = data.people || {};
  const regs = data.regs || {};
  const trips = data.trips || {};
  const lastModified = Date.now();

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');

    // Trips
    const tripIds = Object.keys(trips);
    if (tripIds.length === 0) {
      await client.query('DELETE FROM trips');
    } else {
      await client.query('DELETE FROM trips WHERE NOT (id = ANY($1))', [tripIds]);
      for (const [id, t] of Object.entries(trips)) {
        await client.query(`
          INSERT INTO trips (id, name, dest, start, "end", cap, status, special, created, data)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT(id) DO UPDATE SET
            name = EXCLUDED.name, dest = EXCLUDED.dest, start = EXCLUDED.start,
            "end" = EXCLUDED."end", cap = EXCLUDED.cap, status = EXCLUDED.status,
            special = EXCLUDED.special, created = EXCLUDED.created, data = EXCLUDED.data
        `, [
          id, t.name || '', t.dest || '', t.start || '', t.end || '',
          +t.cap || 0, t.status || '', t.special || '', t.created || Date.now(),
          JSON.stringify(t)
        ]);
      }
    }

    // People
    const peopleIds = Object.keys(people);
    if (peopleIds.length === 0) {
      await client.query('DELETE FROM people');
    } else {
      await client.query('DELETE FROM people WHERE NOT (id = ANY($1))', [peopleIds]);
      for (const [id, p] of Object.entries(people)) {
        await client.query(`
          INSERT INTO people (id, first, last, nk, gender, age, phone, wa, email, id_last4, id_hash, created, data)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          ON CONFLICT(id) DO UPDATE SET
            first = EXCLUDED.first, last = EXCLUDED.last, nk = EXCLUDED.nk,
            gender = EXCLUDED.gender, age = EXCLUDED.age, phone = EXCLUDED.phone,
            wa = EXCLUDED.wa, email = EXCLUDED.email, id_last4 = EXCLUDED.id_last4,
            id_hash = EXCLUDED.id_hash, created = EXCLUDED.created, data = EXCLUDED.data
        `, [
          id, p.first || '', p.last || '', p.nk || '', p.gender || '',
          p.age ?? null, p.phone || '', p.wa || '', p.email || '',
          p.idLast4 || '', p.idHash || '', p.created || Date.now(),
          JSON.stringify(p)
        ]);
      }
    }

    // Regs
    const regIds = Object.keys(regs);
    if (regIds.length === 0) {
      await client.query('DELETE FROM regs');
    } else {
      await client.query('DELETE FROM regs WHERE NOT (id = ANY($1))', [regIds]);
      for (const [id, r] of Object.entries(regs)) {
        await client.query(`
          INSERT INTO regs (id, trip_id, person_id, paid, chk, special, data)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT(id) DO UPDATE SET
            trip_id = EXCLUDED.trip_id, person_id = EXCLUDED.person_id,
            paid = EXCLUDED.paid, chk = EXCLUDED.chk, special = EXCLUDED.special,
            data = EXCLUDED.data
        `, [
          id, r.t || '', r.p || '', !!r.paid, !!r.chk,
          r.special || '', JSON.stringify(r)
        ]);
      }
    }

    // Meta
    await client.query(`
      INSERT INTO meta (key, val) VALUES ('lastModified', $1)
      ON CONFLICT(key) DO UPDATE SET val = EXCLUDED.val
    `, [String(lastModified)]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  atomicWriteJson(JSON_BACKUP_PATH, { people, regs, trips, lastModified });
  return { ok: true, lastModified };
}

// -------------------------------------------------------------
// 3. LOCAL SQLITE DRIVER (Fallback when offline or no cloud DB set)
// -------------------------------------------------------------
function initSqlite() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    sqliteDb = new DatabaseSync(DB_PATH);
    sqliteDb.exec('PRAGMA journal_mode = WAL;');
    sqliteDb.exec('PRAGMA synchronous = NORMAL;');
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS trips (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS regs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, val TEXT NOT NULL);
    `);
    activeDriver = 'sqlite';
    console.log('✓ Local SQLite storage active at:', DB_PATH);
  } catch (e) {
    activeDriver = 'json';
    console.log('✓ Local JSON storage active at:', JSON_BACKUP_PATH);
  }
}

function sqliteGetAll() {
  if (sqliteDb) {
    const trips = {};
    for (const r of sqliteDb.prepare('SELECT id, data FROM trips').all()) {
      try { trips[r.id] = JSON.parse(r.data); } catch (e) {}
    }
    const people = {};
    for (const r of sqliteDb.prepare('SELECT id, data FROM people').all()) {
      try { people[r.id] = JSON.parse(r.data); } catch (e) {}
    }
    const regs = {};
    for (const r of sqliteDb.prepare('SELECT id, data FROM regs').all()) {
      try { regs[r.id] = JSON.parse(r.data); } catch (e) {}
    }
    const m = sqliteDb.prepare("SELECT val FROM meta WHERE key = 'lastModified'").get();
    return { people, regs, trips, lastModified: m ? Number(m.val) : Date.now() };
  }
  const backup = readJsonBackup();
  return backup || { people: {}, regs: {}, trips: {}, lastModified: Date.now() };
}

function sqliteSaveAll(data) {
  const people = data.people || {};
  const regs = data.regs || {};
  const trips = data.trips || {};
  const lastModified = Date.now();

  if (sqliteDb) {
    sqliteDb.exec('BEGIN IMMEDIATE;');
    try {
      sqliteDb.exec('DELETE FROM trips;');
      const stmtTrip = sqliteDb.prepare('INSERT INTO trips (id, data) VALUES (?, ?)');
      for (const [id, t] of Object.entries(trips)) {
        stmtTrip.run(id, JSON.stringify(t));
      }

      sqliteDb.exec('DELETE FROM people;');
      const stmtPerson = sqliteDb.prepare('INSERT INTO people (id, data) VALUES (?, ?)');
      for (const [id, p] of Object.entries(people)) {
        stmtPerson.run(id, JSON.stringify(p));
      }

      sqliteDb.exec('DELETE FROM regs;');
      const stmtReg = sqliteDb.prepare('INSERT INTO regs (id, data) VALUES (?, ?)');
      for (const [id, r] of Object.entries(regs)) {
        stmtReg.run(id, JSON.stringify(r));
      }

      sqliteDb.prepare(`
        INSERT INTO meta (key, val) VALUES ('lastModified', ?)
        ON CONFLICT(key) DO UPDATE SET val = excluded.val
      `).run(String(lastModified));

      sqliteDb.exec('COMMIT;');
    } catch (e) {
      sqliteDb.exec('ROLLBACK;');
      throw e;
    }
  }

  atomicWriteJson(JSON_BACKUP_PATH, { people, regs, trips, lastModified });
  return { ok: true, lastModified };
}

// -------------------------------------------------------------
// AUTO-MIGRATION / BOOTSTRAP TO CLOUD
// -------------------------------------------------------------
async function bootstrapCloudIfEmpty() {
  if (activeDriver !== 'mongodb' && activeDriver !== 'postgres') return;
  try {
    const currentData = await getAll();
    const isCloudEmpty = Object.keys(currentData.trips).length === 0 && Object.keys(currentData.people).length === 0;
    if (isCloudEmpty) {
      const localBackup = readJsonBackup();
      if (localBackup && (Object.keys(localBackup.trips || {}).length > 0 || Object.keys(localBackup.people || {}).length > 0)) {
        console.log('Uploading local existing data to Cloud Database...');
        await saveAll(localBackup);
        console.log('✓ Local data successfully migrated to Cloud Database!');
      }
    }
  } catch (e) {
    console.error('Bootstrap migration check notice:', e.message);
  }
}

// -------------------------------------------------------------
// PUBLIC UNIFIED API
// -------------------------------------------------------------
async function init() {
  const rawMongo = process.env.MONGODB_URI;
  const mongoUri = rawMongo ? String(rawMongo).trim().replace(/^["']|["']$/g, '') : null;
  const pgUri = process.env.DATABASE_URL || process.env.POSTGRES_URL;

  console.log('Checking database configuration...');
  if (mongoUri) {
    const masked = mongoUri.replace(/:([^:@]+)@/, ':****@');
    console.log('Detected MONGODB_URI in environment:', masked);
    if (mongoUri.includes('cluster0.abcde.mongodb.net') || mongoUri.includes('<username>') || mongoUri.includes('<password>')) {
      lastCloudError = 'MONGODB_URI still contains placeholder "cluster0.abcde.mongodb.net"';
      console.warn('⚠️ MONGODB_URI contains example placeholder ("cluster0.abcde.mongodb.net").');
      console.warn('   Please replace it with your real cluster address from MongoDB Atlas.');
      console.log('Falling back to local storage in the meantime.');
    } else {
      try {
        await initMongo(mongoUri);
        await bootstrapCloudIfEmpty();
        lastCloudError = null;
        return;
      } catch (err) {
        lastCloudError = err.name + ': ' + err.message;
        console.error('⚠️ Could not connect to MongoDB Atlas cloud:', err.message);
        if (err.cause) console.error('  Cause:', err.cause);
        console.log('Falling back to local storage.');
      }
    }
  } else if (pgUri) {
    try {
      await initPostgres(pgUri);
      await bootstrapCloudIfEmpty();
      lastCloudError = null;
      return;
    } catch (err) {
      lastCloudError = err.name + ': ' + err.message;
      console.error('⚠️ Could not connect to PostgreSQL cloud:', err.message);
      console.log('Falling back to local storage.');
    }
  } else {
    lastCloudError = 'No MONGODB_URI or DATABASE_URL found in environment variables';
    console.log(`
ℹ️  No cloud database URI specified.
   To connect to a free cloud database:
   • MongoDB Atlas (Free): Add MONGODB_URI=mongodb+srv://... to your environment variables
   • Supabase / Neon (Free): Add DATABASE_URL=postgres://... to your environment variables
`);
  }

  // Fallback to local
  initSqlite();
}

async function getAll() {
  if (activeDriver === 'mongodb') return mongoGetAll();
  if (activeDriver === 'postgres') return pgGetAll();
  return sqliteGetAll();
}

async function saveAll(data) {
  if (activeDriver === 'mongodb') return mongoSaveAll(data);
  if (activeDriver === 'postgres') return pgSaveAll(data);
  return sqliteSaveAll(data);
}

async function getBackup() {
  return getAll();
}

async function restoreBackup(backupData) {
  if (!backupData || typeof backupData !== 'object') {
    throw new Error('Invalid backup data format');
  }
  return saveAll(backupData);
}

async function getCounts() {
  const data = await getAll();
  const driverLabels = {
    mongodb: 'MongoDB Atlas (Free Cloud Database)',
    postgres: 'PostgreSQL (Cloud Database)',
    sqlite: 'Local SQLite (Fallback)',
    json: 'Local JSON (Fallback)'
  };
  return {
    trips: Object.keys(data.trips).length,
    people: Object.keys(data.people).length,
    regs: Object.keys(data.regs).length,
    storage: driverLabels[activeDriver] || activeDriver,
    cloudActive: activeDriver === 'mongodb' || activeDriver === 'postgres',
    activeDriver,
    cloudError: lastCloudError,
    envMongoSet: !!process.env.MONGODB_URI
  };
}

module.exports = {
  init,
  getAll,
  saveAll,
  getBackup,
  restoreBackup,
  getCounts,
  DATA_DIR
};
