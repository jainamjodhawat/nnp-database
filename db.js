const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'yatra.db');
const JSON_BACKUP_PATH = path.join(DATA_DIR, 'yatra.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let sqliteDb = null;
let useSqlite = false;

// Check if node:sqlite built-in is available
try {
  const { DatabaseSync } = require('node:sqlite');
  sqliteDb = new DatabaseSync(DB_PATH);
  sqliteDb.exec('PRAGMA journal_mode = WAL;');
  sqliteDb.exec('PRAGMA synchronous = NORMAL;');
  
  // Create schema
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS trips (
      id TEXT PRIMARY KEY,
      name TEXT,
      dest TEXT,
      start TEXT,
      end TEXT,
      cap INTEGER,
      status TEXT,
      special TEXT,
      created INTEGER,
      data TEXT NOT NULL
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
      created INTEGER,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS regs (
      id TEXT PRIMARY KEY,
      trip_id TEXT,
      person_id TEXT,
      paid INTEGER,
      chk INTEGER,
      special TEXT,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      val TEXT NOT NULL
    );
  `);
  
  useSqlite = true;
  console.log('✓ SQLite database initialized at:', DB_PATH);
} catch (err) {
  console.warn('Notice: Built-in node:sqlite not available, falling back to atomic JSON store.', err.message);
  useSqlite = false;
}

// Atomically write JSON file
function atomicWriteJson(filePath, data) {
  const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

// Read JSON backup file safely
function readJsonBackup() {
  if (fs.existsSync(JSON_BACKUP_PATH)) {
    try {
      const raw = fs.readFileSync(JSON_BACKUP_PATH, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      console.error('Error reading yatra.json backup:', e);
    }
  }
  return null;
}

// Initial bootstrap check: if SQLite is empty but JSON backup exists, import from JSON
if (useSqlite) {
  try {
    const tripCount = sqliteDb.prepare('SELECT count(*) as count FROM trips').get().count;
    const peopleCount = sqliteDb.prepare('SELECT count(*) as count FROM people').get().count;
    if (tripCount === 0 && peopleCount === 0) {
      const backup = readJsonBackup();
      if (backup && (backup.trips || backup.people || backup.regs)) {
        console.log('Restoring existing JSON data into SQLite...');
        saveToSqlite(backup);
      }
    }
  } catch (e) {
    console.error('Initial bootstrap check error:', e);
  }
}

function saveToSqlite(data) {
  const people = data.people || {};
  const regs = data.regs || {};
  const trips = data.trips || {};

  sqliteDb.exec('BEGIN IMMEDIATE;');
  try {
    // 1. Trips
    const existingTripIds = new Set(sqliteDb.prepare('SELECT id FROM trips').all().map(r => r.id));
    const newTripIds = new Set(Object.keys(trips));
    for (const oldId of existingTripIds) {
      if (!newTripIds.has(oldId)) {
        sqliteDb.prepare('DELETE FROM trips WHERE id = ?').run(oldId);
      }
    }
    const stmtTrip = sqliteDb.prepare(`
      INSERT INTO trips (id, name, dest, start, end, cap, status, special, created, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, dest=excluded.dest, start=excluded.start, end=excluded.end,
        cap=excluded.cap, status=excluded.status, special=excluded.special,
        created=excluded.created, data=excluded.data
    `);
    for (const [id, t] of Object.entries(trips)) {
      stmtTrip.run(
        id,
        t.name || '',
        t.dest || '',
        t.start || '',
        t.end || '',
        +t.cap || 0,
        t.status || '',
        t.special || '',
        t.created || Date.now(),
        JSON.stringify(t)
      );
    }

    // 2. People
    const existingPeopleIds = new Set(sqliteDb.prepare('SELECT id FROM people').all().map(r => r.id));
    const newPeopleIds = new Set(Object.keys(people));
    for (const oldId of existingPeopleIds) {
      if (!newPeopleIds.has(oldId)) {
        sqliteDb.prepare('DELETE FROM people WHERE id = ?').run(oldId);
      }
    }
    const stmtPerson = sqliteDb.prepare(`
      INSERT INTO people (id, first, last, nk, gender, age, phone, wa, email, id_last4, id_hash, created, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        first=excluded.first, last=excluded.last, nk=excluded.nk, gender=excluded.gender,
        age=excluded.age, phone=excluded.phone, wa=excluded.wa, email=excluded.email,
        id_last4=excluded.id_last4, id_hash=excluded.id_hash, created=excluded.created, data=excluded.data
    `);
    for (const [id, p] of Object.entries(people)) {
      stmtPerson.run(
        id,
        p.first || '',
        p.last || '',
        p.nk || '',
        p.gender || '',
        p.age ?? null,
        p.phone || '',
        p.wa || '',
        p.email || '',
        p.idLast4 || '',
        p.idHash || '',
        p.created || Date.now(),
        JSON.stringify(p)
      );
    }

    // 3. Regs
    const existingRegIds = new Set(sqliteDb.prepare('SELECT id FROM regs').all().map(r => r.id));
    const newRegIds = new Set(Object.keys(regs));
    for (const oldId of existingRegIds) {
      if (!newRegIds.has(oldId)) {
        sqliteDb.prepare('DELETE FROM regs WHERE id = ?').run(oldId);
      }
    }
    const stmtReg = sqliteDb.prepare(`
      INSERT INTO regs (id, trip_id, person_id, paid, chk, special, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        trip_id=excluded.trip_id, person_id=excluded.person_id, paid=excluded.paid,
        chk=excluded.chk, special=excluded.special, data=excluded.data
    `);
    for (const [id, r] of Object.entries(regs)) {
      stmtReg.run(
        id,
        r.t || '',
        r.p || '',
        r.paid ? 1 : 0,
        r.chk ? 1 : 0,
        r.special || '',
        JSON.stringify(r)
      );
    }

    // 4. Meta
    const lastModified = Date.now();
    sqliteDb.prepare(`
      INSERT INTO meta (key, val) VALUES ('lastModified', ?)
      ON CONFLICT(key) DO UPDATE SET val=excluded.val
    `).run(String(lastModified));

    sqliteDb.exec('COMMIT;');
    return lastModified;
  } catch (err) {
    sqliteDb.exec('ROLLBACK;');
    throw err;
  }
}

function getFromSqlite() {
  const trips = {};
  for (const row of sqliteDb.prepare('SELECT id, data FROM trips').all()) {
    try { trips[row.id] = JSON.parse(row.data); } catch (e) {}
  }
  const people = {};
  for (const row of sqliteDb.prepare('SELECT id, data FROM people').all()) {
    try { people[row.id] = JSON.parse(row.data); } catch (e) {}
  }
  const regs = {};
  for (const row of sqliteDb.prepare('SELECT id, data FROM regs').all()) {
    try { regs[row.id] = JSON.parse(row.data); } catch (e) {}
  }
  const metaRow = sqliteDb.prepare("SELECT val FROM meta WHERE key = 'lastModified'").get();
  const lastModified = metaRow ? Number(metaRow.val) : Date.now();

  return { people, regs, trips, lastModified };
}

// Public API
function getAll() {
  if (useSqlite) {
    return getFromSqlite();
  }
  const backup = readJsonBackup();
  if (backup) {
    return {
      people: backup.people || {},
      regs: backup.regs || {},
      trips: backup.trips || {},
      lastModified: backup.lastModified || Date.now()
    };
  }
  return { people: {}, regs: {}, trips: {}, lastModified: Date.now() };
}

function saveAll(data) {
  const payload = {
    people: data.people || {},
    regs: data.regs || {},
    trips: data.trips || {},
    lastModified: Date.now()
  };

  if (useSqlite) {
    payload.lastModified = saveToSqlite(payload);
  }

  // Always keep an atomic JSON snapshot in sync
  try {
    atomicWriteJson(JSON_BACKUP_PATH, payload);
  } catch (e) {
    console.error('Failed to write JSON backup:', e);
  }

  return { ok: true, lastModified: payload.lastModified };
}

function getBackup() {
  return getAll();
}

function restoreBackup(backupData) {
  if (!backupData || typeof backupData !== 'object') {
    throw new Error('Invalid backup data format');
  }
  return saveAll(backupData);
}

function getCounts() {
  const data = getAll();
  return {
    trips: Object.keys(data.trips).length,
    people: Object.keys(data.people).length,
    regs: Object.keys(data.regs).length,
    storage: useSqlite ? 'SQLite (WAL) + JSON snapshot' : 'Atomic JSON store',
    dbPath: useSqlite ? DB_PATH : JSON_BACKUP_PATH
  };
}

module.exports = {
  getAll,
  saveAll,
  getBackup,
  restoreBackup,
  getCounts,
  DATA_DIR
};
