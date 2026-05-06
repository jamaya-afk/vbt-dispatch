// VBT Dispatch — Multi-tenant Build
// Core scope: Login (DB-backed users), POs, Board, Driver guided flow, Approvals,
//             Ready to Bill, Sheets sync. All data is keyed by company_id.
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const qb = require('./qb');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

const IS_PROD = process.env.NODE_ENV === 'production';

// ── SESSION (Postgres-backed when DATABASE_URL is set) ───────────────────────
const sessionOpts = {
  secret: process.env.SESSION_SECRET || 'vbt-2025-secret',
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7, httpOnly: true, sameSite: 'lax' }
};
let sessionPool = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    sessionPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    sessionPool.on('error', e => console.error('Session pool error:', e.message));
    const pgSession = require('connect-pg-simple')(session);
    sessionOpts.store = new pgSession({
      pool: sessionPool,
      tableName: 'user_sessions',
      createTableIfMissing: true,
      pruneSessionInterval: 60 * 15
    });
    console.log('✓ Session store: Postgres');
  } catch (e) {
    console.error('⚠ Postgres session store failed:', e.message);
  }
}
app.use(session(sessionOpts));

// ── SUPABASE STORAGE (for photo uploads) ────────────────────────────────────
const SUPABASE_URL    = process.env.SUPABASE_URL || '';
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'vbt-photos';
let supabaseEnabled = false;
let supabase = null;

console.log('[Supabase config] URL:', SUPABASE_URL ? SUPABASE_URL : '(missing)');
console.log('[Supabase config] KEY:', SUPABASE_KEY ? `[${SUPABASE_KEY.slice(0,8)}...${SUPABASE_KEY.slice(-4)}, len=${SUPABASE_KEY.length}]` : '(missing)');
console.log('[Supabase config] BUCKET:', SUPABASE_BUCKET);

if (SUPABASE_URL && SUPABASE_KEY) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    supabaseEnabled = true;
    console.log('✓ Supabase Storage configured (bucket: ' + SUPABASE_BUCKET + ')');
  } catch (e) {
    console.error('⚠ Supabase init failed:', e.message);
  }
} else {
  console.log('⚠ Supabase not configured — uploads will fall back to base64-in-database');
}

function randomKey(len = 16) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function uploadPhoto(kind, dataUrl, loadId) {
  console.log(`[uploadPhoto] called: kind=${kind}, loadId=${loadId}, supabaseEnabled=${supabaseEnabled}, bucket=${SUPABASE_BUCKET}`);
  if (!supabaseEnabled) throw new Error('Supabase not configured');
  if (!dataUrl || !dataUrl.startsWith('data:')) throw new Error('Invalid image data');

  const match = dataUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid data URL format');
  const contentType = match[1];
  const base64 = match[2];
  const buffer = Buffer.from(base64, 'base64');

  const ext = contentType === 'image/png' ? 'png' : 'jpg';
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const folder = (kind === 'signature') ? 'signatures' : 'tickets';
  const path = `${folder}/${yyyy}/${mm}/${loadId || 'unknown'}-${randomKey(16)}.${ext}`;

  const { data: uploadData, error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .upload(path, buffer, { contentType, upsert: false });
  if (error) throw new Error(`Supabase upload failed: ${error.message || JSON.stringify(error)}`);

  const { data: urlData } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(path);
  return urlData.publicUrl;
}

// ── TRUCKS / MATERIALS / DEFAULTS ────────────────────────────────────────────
// TRUCKS is still global for now — eventually moves to a per-company table.
const TRUCKS = [
  { id: 'beryle',   label: 'Beryle',   truckNum: 'Truck #2'  },
  { id: 'matthew',  label: 'Matthew',  truckNum: 'Truck #4'  },
  { id: 'rigo',     label: 'Rigo',     truckNum: 'Truck #14' },
  { id: 'leonardo', label: 'Leonardo', truckNum: 'Truck #12' },
  { id: 'carlos',   label: 'Carlos',   truckNum: 'Truck #2B' },
];

const MATERIALS = ['Fill Sand','Gravel','Rock','3/4 Rock','Cold Mix','Recycle Base','Dirt','Base Rock','Other'];

const TONS_PER_LOAD = 25;

const DEFAULT_RATES = {
  customer: {
    'Fill Sand':    { unit: 'ton', price: 25 },
    'Gravel':       { unit: 'ton', price: 25 },
    'Rock':         { unit: 'ton', price: 25 },
    '3/4 Rock':     { unit: 'ton', price: 25 },
    'Cold Mix':     { unit: 'ton', price: 25 },
    'Recycle Base': { unit: 'ton', price: 25 },
    'Dirt':         { unit: 'ton', price: 25 },
    'Base Rock':    { unit: 'ton', price: 25 },
    'Other':        { unit: 'ton', price: 25 },
  },
  vendor: {
    'Fill Sand':    { unit: 'ton', price: 22 },
    'Gravel':       { unit: 'ton', price: 22 },
    'Rock':         { unit: 'ton', price: 22 },
    '3/4 Rock':     { unit: 'ton', price: 22 },
    'Cold Mix':     { unit: 'ton', price: 22 },
    'Recycle Base': { unit: 'ton', price: 22 },
    'Dirt':         { unit: 'ton', price: 22 },
    'Base Rock':    { unit: 'ton', price: 22 },
    'Other':        { unit: 'ton', price: 22 },
  },
};

const DEFAULT_VENDORS = [
  { id: 'vulcan',     name: 'Vulcan',                 location: 'Fresno, CA',      active: true },
  { id: 'teichert',   name: 'Teichert',               location: 'Sacramento, CA',  active: true },
  { id: 'granite',    name: 'Granite Construction',   location: 'Fresno, CA',      active: true },
  { id: 'cemex',      name: 'CEMEX',                  location: 'Fresno, CA',      active: true },
  { id: 'keith',      name: 'Keith Farms',            location: 'Fowler, CA',      active: true },
  { id: 'hanson',     name: 'Hanson',                 location: 'Bakersfield, CA', active: true },
  { id: 'vbt',        name: 'VBT Yard',               location: 'Fresno, CA',      active: true },
  { id: 'other',      name: 'Other',                  location: '',                active: true },
];

const DEFAULT_VENDOR_PRICES = {
  vulcan: [
    { id: 'v1', material: '3/4 Rock',   unit: 'CY',  price: 38, active: true, notes: '' },
    { id: 'v2', material: 'Base Rock',  unit: 'TON', price: 22, active: true, notes: '' },
    { id: 'v3', material: 'Sand',       unit: 'CY',  price: 28, active: true, notes: '' },
  ],
  teichert: [
    { id: 't1', material: 'Fill Sand',  unit: 'CY',  price: 18, active: true, notes: '' },
    { id: 't2', material: 'Gravel',     unit: 'CY',  price: 32, active: true, notes: '' },
  ],
  granite: [
    { id: 'g1', material: '3/4 Rock',   unit: 'TON', price: 30, active: true, notes: '' },
    { id: 'g2', material: 'Rock',       unit: 'TON', price: 26, active: true, notes: '' },
  ],
  cemex: [
    { id: 'c1', material: 'Cold Mix',   unit: 'TON', price: 95, active: true, notes: '' },
    { id: 'c2', material: 'Base Rock',  unit: 'TON', price: 24, active: true, notes: '' },
  ],
  keith: [
    { id: 'k1', material: 'Fill Sand',  unit: 'CY',  price: 16, active: true, notes: '' },
    { id: 'k2', material: 'Recycle Base', unit: 'TON', price: 14, active: true, notes: '' },
  ],
  hanson: [
    { id: 'h1', material: 'Rock',       unit: 'TON', price: 32, active: true, notes: '' },
  ],
  vbt: [
    { id: 'vb1', material: 'Dirt',      unit: 'CY',  price: 0, active: true, notes: 'Internal yard' },
  ],
  other: []
};

// ── DEFAULT VBT COMPANY + USERS ──────────────────────────────────────────────
// Seed values used the FIRST time the app boots against a fresh Postgres.
// Passwords are kept in sync from env vars on every boot (ON CONFLICT DO UPDATE).
const DEFAULT_COMPANY_ID   = 'vbt';
const DEFAULT_COMPANY_NAME = 'VBT';
const DEFAULT_COMPANY_SLUG = 'vbt';

const SEED_USERS = [
  // Admins
  { username: 'joshua',   password: process.env.JOSHUA_PASS   || 'joshua123',  role: 'admin',   truckId: null,       displayName: 'Joshua'   },
  { username: 'oscar',    password: process.env.OSCAR_PASS    || 'oscar123',   role: 'admin',   truckId: null,       displayName: 'Oscar'    },
  { username: 'perla',    password: process.env.PERLA_PASS    || 'perla123',   role: 'admin',   truckId: null,       displayName: 'Perla'    },
  // Drivers
  { username: 'beryle',   password: process.env.BERYLE_PASS   || 'beryle123',  role: 'driver',  truckId: 'beryle',   displayName: 'Beryle'   },
  { username: 'matthew',  password: process.env.MATTHEW_PASS  || 'matthew123', role: 'driver',  truckId: 'matthew',  displayName: 'Matthew'  },
  { username: 'rigo',     password: process.env.RIGO_PASS     || 'rigo123',    role: 'driver',  truckId: 'rigo',     displayName: 'Rigo'     },
  { username: 'leonardo', password: process.env.LEONARDO_PASS || 'leo123',     role: 'driver',  truckId: 'leonardo', displayName: 'Leonardo' },
  { username: 'carlos',   password: process.env.CARLOS_PASS   || 'carlos123',  role: 'driver',  truckId: 'carlos',   displayName: 'Carlos'   },
];

// ── DATA STORE — multi-tenant, keyed by companyId ────────────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');  // dev-only fallback
let pg = null;
let stores = {};

function makeEmptyStore() {
  return {
    pos: [],
    loads: [],
    archive: [],
    vendors: [],
    vendorPrices: {},
    customers: [],
    customerPrices: {},
    defaultRates: null,
    auditLog: [],
    nextPoNum: 1001,
    nextLoadId: 1,
  };
}

function getCompanyStore(cid) {
  if (!stores[cid]) {
    stores[cid] = makeEmptyStore();
    normalizeStore(stores[cid]);
  }
  return stores[cid];
}

async function initPg() {
  if (!process.env.DATABASE_URL) {
    if (IS_PROD) {
      console.error('FATAL: DATABASE_URL is required in production. Aborting.');
      process.exit(1);
    }
    console.warn('⚠ No DATABASE_URL — running in dev mode with file fallback (NOT for production)');
    return;
  }
  try {
    if (!sessionPool) {
      const { Pool } = require('pg');
      pg = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 10000,
      });
    } else {
      pg = sessionPool;
    }
    await pg.query('SELECT 1');

    await pg.query(`CREATE TABLE IF NOT EXISTS dispatch_data (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    await pg.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        slug        TEXT NOT NULL UNIQUE,
        active      BOOLEAN NOT NULL DEFAULT true,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pg.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        username      TEXT NOT NULL,
        password      TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'driver',
        truck_id      TEXT,
        display_name  TEXT,
        active        BOOLEAN NOT NULL DEFAULT true,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(company_id, username)
      )
    `);
    console.log('✓ Postgres connected; companies/users/dispatch_data ready');

    await pg.query(`
      INSERT INTO companies (id, name, slug, active)
      VALUES ($1, $2, $3, true)
      ON CONFLICT (id) DO NOTHING
    `, [DEFAULT_COMPANY_ID, DEFAULT_COMPANY_NAME, DEFAULT_COMPANY_SLUG]);

    // Seed/refresh users from env-var-driven SEED_USERS into VBT.
    // Once we add a user-management UI, we'll switch this to DO NOTHING.
    for (const u of SEED_USERS) {
      const id = `user-${DEFAULT_COMPANY_ID}-${u.username}`;
      await pg.query(`
        INSERT INTO users (id, company_id, username, password, role, truck_id, display_name, active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, true)
        ON CONFLICT (company_id, username) DO UPDATE SET
          password     = EXCLUDED.password,
          role         = EXCLUDED.role,
          truck_id     = EXCLUDED.truck_id,
          display_name = EXCLUDED.display_name
      `, [id, DEFAULT_COMPANY_ID, u.username, u.password, u.role, u.truckId, u.displayName]);
    }
    console.log(`✓ Seeded/synced ${SEED_USERS.length} users for company "${DEFAULT_COMPANY_ID}"`);

    // ONE-TIME MIGRATION: legacy single-company blob → store:vbt
    // Old shape: dispatch_data WHERE key='store' contained the whole VBT store.
    // New shape: dispatch_data WHERE key='store:<companyId>'.
    const legacy = await pg.query("SELECT value FROM dispatch_data WHERE key = 'store'");
    if (legacy.rows.length) {
      const tenantKey = `store:${DEFAULT_COMPANY_ID}`;
      const existing = await pg.query("SELECT 1 FROM dispatch_data WHERE key = $1", [tenantKey]);
      if (!existing.rows.length) {
        await pg.query(
          "INSERT INTO dispatch_data (key, value) VALUES ($1, $2)",
          [tenantKey, legacy.rows[0].value]
        );
        console.log(`✓ Migrated legacy "store" blob → "${tenantKey}" (data preserved)`);
      } else {
        console.log(`ℹ Both "store" and "${tenantKey}" exist — keeping tenant copy, leaving legacy untouched`);
      }
    }
  } catch (e) {
    console.error('✗ Postgres init failed:', e.message);
    if (IS_PROD) {
      console.error('FATAL: cannot start in production without working Postgres.');
      process.exit(1);
    }
    pg = null;
  }
}

async function loadAllStores() {
  if (!pg) {
    if (IS_PROD) {
      console.error('FATAL: refusing to start without Postgres in production');
      process.exit(1);
    }
    if (fs.existsSync(DATA_FILE)) {
      try {
        const blob = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        stores[DEFAULT_COMPANY_ID] = blob;
        normalizeStore(stores[DEFAULT_COMPANY_ID]);
        console.log(`✓ Dev: loaded VBT from ${DATA_FILE}`);
      } catch (e) { console.warn('Dev file read error:', e.message); }
    }
    if (!stores[DEFAULT_COMPANY_ID]) {
      stores[DEFAULT_COMPANY_ID] = makeEmptyStore();
      normalizeStore(stores[DEFAULT_COMPANY_ID]);
    }
    return;
  }
  try {
    const cs = await pg.query("SELECT id FROM companies WHERE active = true");
    for (const row of cs.rows) {
      const cid = row.id;
      const r = await pg.query("SELECT value FROM dispatch_data WHERE key = $1", [`store:${cid}`]);
      if (r.rows.length) {
        try { stores[cid] = JSON.parse(r.rows[0].value); }
        catch (pe) { console.error(`✗ Corrupt store JSON for "${cid}":`, pe.message); stores[cid] = makeEmptyStore(); }
      } else {
        stores[cid] = makeEmptyStore();
      }
      normalizeStore(stores[cid]);
      console.log(`✓ Loaded company "${cid}": ${stores[cid].pos.length} POs, ${stores[cid].loads.length} loads`);
    }
    if (!stores[DEFAULT_COMPANY_ID]) {
      stores[DEFAULT_COMPANY_ID] = makeEmptyStore();
      normalizeStore(stores[DEFAULT_COMPANY_ID]);
    }
  } catch (e) {
    console.error('loadAllStores error:', e.message);
    if (IS_PROD) process.exit(1);
  }
}

async function saveCompanyStore(cid) {
  const s = stores[cid];
  if (!s) return;
  const j = JSON.stringify(s);
  if (pg) {
    try {
      await pg.query(
        "INSERT INTO dispatch_data(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2",
        [`store:${cid}`, j]
      );
    } catch (e) {
      console.error(`PG write error for "${cid}":`, e.message);
      if (!IS_PROD) {
        try { fs.writeFileSync(DATA_FILE, j); } catch (fe) {}
      }
    }
  } else if (!IS_PROD) {
    try { fs.writeFileSync(DATA_FILE, j); } catch (e) {}
  }
}

function normalizeStore(s) {
  if (!s.pos)     s.pos = [];
  if (!s.loads)   s.loads = [];
  if (!s.archive) s.archive = [];
  if (!Array.isArray(s.auditLog)) s.auditLog = [];
  if (!s.customerPrices || typeof s.customerPrices !== 'object') s.customerPrices = {};
  if (!s.defaultRates || typeof s.defaultRates !== 'object') {
    s.defaultRates = JSON.parse(JSON.stringify(DEFAULT_RATES));
  }
  if (!s.auditLogResetV1) {
    if (s.auditLog.length > 0) {
      console.log(`[normalize] Wiping ${s.auditLog.length} legacy audit entries (pre-named-accounts)`);
    }
    s.auditLog = [];
    s.auditLogResetV1 = true;
  }
  if (!Array.isArray(s.vendors) || s.vendors.length === 0) {
    s.vendors = JSON.parse(JSON.stringify(DEFAULT_VENDORS));
  }
  if (!s.vendorPrices || typeof s.vendorPrices !== 'object') {
    s.vendorPrices = JSON.parse(JSON.stringify(DEFAULT_VENDOR_PRICES));
  } else {
    s.vendors.forEach(v => {
      if (!Array.isArray(s.vendorPrices[v.id])) s.vendorPrices[v.id] = [];
    });
  }
  if (!s.nextPoNum)  s.nextPoNum = 1001;
  if (!s.nextLoadId) s.nextLoadId = 1;

  s.loads.forEach(l => {
    if (!l.timestamps)     l.timestamps = {};
    if (!l.gps)            l.gps = {};
    if (!l.pod)            l.pod = { signedBy: '', signature: '', signedAt: '' };
    if (!l.approvalStatus) l.approvalStatus = l.status === 'completed' ? 'approved' : 'pending';
    if (!l.billStatus)     l.billStatus = 'not-ready';
    if (!l.ticketImage)    l.ticketImage = '';
    if (l.locked === undefined) l.locked = false;
    if (l.voided === undefined) l.voided = false;
    if (l.loadsDelivered === undefined) l.loadsDelivered = 0;
    if (!l.originalScheduledDate) l.originalScheduledDate = l.deliveryDate;
    if (!Array.isArray(l.moveHistory)) l.moveHistory = [];
  });
  s.pos.forEach(p => {
    if (!p.materials) p.materials = [];
  });

  if (!Array.isArray(s.customers)) s.customers = [];
  if (s.customers.length === 0 && s.pos.length > 0) {
    const seen = new Map();
    s.pos.forEach(p => {
      const name = (p.customer || '').trim();
      if (!name) return;
      const k = name.toLowerCase();
      if (!seen.has(k)) seen.set(k, name);
    });
    seen.forEach((name) => {
      const sample = s.pos.slice().reverse().find(p =>
        (p.customer || '').toLowerCase().trim() === name.toLowerCase()
      ) || {};
      s.customers.push({
        id: 'cust-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
        name,
        code: '',
        address: sample.address || '',
        city: sample.city || '',
        phone: '', email: '', notes: '',
        active: true,
        createdAt: new Date().toISOString(),
      });
    });
    if (s.customers.length) {
      console.log(`[normalize] Seeded customer master with ${s.customers.length} entries from existing POs`);
    }
  }
  s.customers.forEach(c => {
    if (!c.id) c.id = 'cust-' + Date.now() + '-' + Math.floor(Math.random() * 10000);
    if (c.active === undefined) c.active = true;
    if (!c.createdAt) c.createdAt = new Date().toISOString();
    if (!('qbCustomerId' in c)) c.qbCustomerId = '';
  });
  s.vendors.forEach(v => {
    if (!('qbVendorId' in v)) v.qbVendorId = '';
  });

  if (!s.qbConnection || typeof s.qbConnection !== 'object') {
    s.qbConnection = {
      status: 'disconnected',
      environment: '',
      realmId: '',
      accessTokenEnc: '',
      refreshTokenEnc: '',
      accessExpiresAt: '',
      refreshExpiresAt: '',
      connectedAt: '',
      connectedBy: '',
      lastError: '',
      lastSyncAt: '',
    };
  }
  if (!Array.isArray(s.billingBatches)) s.billingBatches = [];
  if (!Array.isArray(s.qbSyncLog))      s.qbSyncLog = [];
  if (!Array.isArray(s.vendorBills))    s.vendorBills = [];

  s.loads.forEach(l => {
    if (!('billingBatchId' in l))      l.billingBatchId = '';
    if (!('qbInvoiceId' in l))         l.qbInvoiceId = '';
    if (!('qbInvoiceNumber' in l))     l.qbInvoiceNumber = '';
    if (!('sentToQuickBooksAt' in l))  l.sentToQuickBooksAt = '';
    if (!('vendorBillId' in l))        l.vendorBillId = '';
    if (!('qbBillId' in l))            l.qbBillId = '';
  });
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

// ── PRICING HELPERS (now take store as last arg) ─────────────────────────────
function customerKey(name) { return String(name || '').toLowerCase().trim(); }

function resolveCustomerRate(customer, material, s) {
  const key = customerKey(customer);
  const list = s.customerPrices[key] || [];
  const found = list.find(p => p.material === material && p.active);
  if (found) return { unit: found.unit || 'ton', price: Number(found.price) || 0, isDefault: false };
  const def = (s.defaultRates?.customer || {})[material] || (DEFAULT_RATES.customer[material]) || { unit: 'ton', price: 25 };
  return { unit: def.unit || 'ton', price: Number(def.price) || 0, isDefault: true };
}

function resolveVendorRate(vendorId, material, s) {
  if (vendorId === 'vbt') return { unit: 'ton', price: 0, isDefault: false, isInternal: true };
  const list = s.vendorPrices[vendorId] || [];
  const found = list.find(p => p.material === material && p.active);
  if (found) return { unit: found.unit || 'ton', price: Number(found.price) || 0, isDefault: false };
  const def = (s.defaultRates?.vendor || {})[material] || (DEFAULT_RATES.vendor[material]) || { unit: 'ton', price: 22 };
  return { unit: def.unit || 'ton', price: Number(def.price) || 0, isDefault: true };
}

function computeRevenue(load) {
  const rate = Number(load.customerRate) || 0;
  const unit = load.customerUnit || 'ton';
  const delivered = Number(load.loadsDelivered) || 0;
  if (unit === 'load') return rate * delivered;
  const tons = Number(load.tonsPerLoad) || TONS_PER_LOAD;
  return rate * tons * delivered;
}

function computeCost(load) {
  const rate = Number(load.vendorRate) || 0;
  const unit = load.vendorUnit || 'ton';
  const delivered = Number(load.loadsDelivered) || 0;
  if (unit === 'load') return rate * delivered;
  const tons = Number(load.tonsPerLoad) || TONS_PER_LOAD;
  return rate * tons * delivered;
}

// ── AUDIT LOG (writes into the per-company store passed in) ──────────────────
function logAction(user, action, target, details, s) {
  try {
    let username = 'system';
    let displayName = 'System';
    let role = '';
    if (typeof user === 'string') {
      username = user;
      displayName = user.charAt(0).toUpperCase() + user.slice(1);
    } else if (user && typeof user === 'object') {
      username = user.username || 'system';
      displayName = user.displayName || username;
      role = user.role || '';
    }
    const entry = {
      id: 'AUD-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      at: new Date().toISOString(),
      user: username, displayName, role,
      action, target: target || '', details: details || {},
    };
    if (!s) return entry;
    if (!Array.isArray(s.auditLog)) s.auditLog = [];
    s.auditLog.push(entry);
    if (s.auditLog.length > 5000) s.auditLog = s.auditLog.slice(-5000);
    return entry;
  } catch (e) {
    console.error('[logAction] failed:', e.message, '— action:', action);
    return null;
  }
}

// ── AUTH ─────────────────────────────────────────────────────────────────────
function reqAuth(req, res, next) { if (req.session?.user) return next(); res.redirect('/login'); }
function reqMgr(req, res, next)   { const r = req.session?.user?.role; if (r === 'admin' || r === 'manager') return next(); res.status(403).json({ error: 'Office access required' }); }
function reqAdmin(req, res, next) { if (req.session?.user?.role === 'admin') return next(); res.status(403).json({ error: 'Admin access required' }); }

// ── REQUEST-SCOPED STORE BINDING ─────────────────────────────────────────────
// Every authenticated request gets req.store and req.saveStore bound to the
// company in their session. Route handlers shadow `store` at the top with
// `const store = req.store;` so the existing per-handler logic doesn't change.
app.use((req, res, next) => {
  const cid = req.session?.user?.companyId;
  if (cid) {
    req.store = getCompanyStore(cid);
    req.saveStore = () => saveCompanyStore(cid);
  }
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true, hasDb: !!process.env.DATABASE_URL, time: new Date().toISOString() }));
app.get('/logo.png', (req, res) => res.sendFile(path.join(__dirname, 'public', 'logo.png')));

app.get('/login', (req, res) => {
  const err = req.query.error ? '<p class="err">Invalid username or password</p>' : '';
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Valley Best Concrete — Dispatch</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',system-ui,sans-serif;background:linear-gradient(135deg,#0a0e1a 0%,#1a2342 50%,#0a0e1a 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;color:#fff}
.card{background:rgba(255,255,255,.05);backdrop-filter:blur(20px);border-radius:18px;border:1px solid rgba(255,255,255,.1);padding:40px 36px;width:100%;max-width:400px;box-shadow:0 8px 40px rgba(0,0,0,.4)}
.logo-wrap{text-align:center;margin-bottom:24px}
.logo-wrap img{max-width:220px;width:100%;height:auto}
.tagline{font-size:11px;color:rgba(255,255,255,.5);text-align:center;margin-top:10px;letter-spacing:.15em;text-transform:uppercase;font-weight:500}
label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:rgba(255,255,255,.55);display:block;margin-bottom:6px;font-weight:600}
input{width:100%;padding:11px 14px;border:1px solid rgba(255,255,255,.12);border-radius:10px;font-size:14px;font-family:inherit;margin-bottom:14px;color:#fff;background:rgba(255,255,255,.05)}
input:focus{outline:none;border-color:#60a8f0;background:rgba(255,255,255,.08)}
input::placeholder{color:rgba(255,255,255,.3)}
button{width:100%;padding:12px;background:linear-gradient(135deg,#3b82f6 0%,#2563eb 100%);color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:600;font-family:inherit;cursor:pointer;margin-top:8px}
button:hover{box-shadow:0 8px 24px rgba(59,130,246,.4)}
.err{color:#fca5a5;font-size:12px;margin-bottom:16px;background:rgba(220,38,38,.12);padding:10px 14px;border-radius:8px;border:1px solid rgba(220,38,38,.3);text-align:center}
.footer{font-size:10px;color:rgba(255,255,255,.3);text-align:center;margin-top:24px}
</style></head><body><div class="card">
  <div class="logo-wrap"><img src="/logo.png" alt="VBC"><div class="tagline">Dispatch System</div></div>
  ${err}
  <form method="POST" action="/login">
    <label>Username</label><input name="username" autocapitalize="none" autocorrect="off" autocomplete="username">
    <label>Password</label><input name="password" type="password" autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form>
  <div class="footer">Authorized access only</div>
</div></body></html>`);
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const cleanName = String(username || '').toLowerCase().trim();
  if (!cleanName || !password) return res.redirect('/login?error=1');

  if (!pg) {
    console.log('[LOGIN] FAILED: no Postgres connection (cannot authenticate)');
    return res.redirect('/login?error=1');
  }
  try {
    const r = await pg.query(`
      SELECT u.id, u.username, u.password, u.role, u.truck_id, u.display_name,
             u.company_id, u.active AS user_active, c.active AS company_active
      FROM users u
      JOIN companies c ON c.id = u.company_id
      WHERE LOWER(u.username) = $1
      LIMIT 1
    `, [cleanName]);
    if (!r.rows.length) {
      console.log(`[LOGIN] FAILED: no user "${cleanName}"`);
      return res.redirect('/login?error=1');
    }
    const u = r.rows[0];
    if (!u.user_active || !u.company_active) {
      console.log(`[LOGIN] FAILED: inactive user/company ("${cleanName}")`);
      return res.redirect('/login?error=1');
    }
    if (u.password !== password) {
      console.log(`[LOGIN] FAILED: bad password for "${cleanName}"`);
      return res.redirect('/login?error=1');
    }
    req.session.user = {
      username: u.username,
      role: u.role,
      truckId: u.truck_id,
      displayName: u.display_name || (u.username.charAt(0).toUpperCase() + u.username.slice(1)),
      companyId: u.company_id,
    };
    console.log(`[LOGIN] SUCCESS: user="${u.username}" company="${u.company_id}" role="${u.role}"`);
    res.redirect('/app/');
  } catch (e) {
    console.error('[LOGIN] error:', e.message);
    res.redirect('/login?error=1');
  }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// Static + protected app shell
app.use('/app', reqAuth, express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
app.get(['/app', '/app/'], reqAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/', (req, res) => res.redirect(req.session?.user ? '/app/' : '/login'));

// ── API: WHO AM I ────────────────────────────────────────────────────────────
app.get('/api/me', reqAuth, (req, res) => {
  const u = req.session.user;
  res.json({
    username: u.username, role: u.role, truckId: u.truckId,
    displayName: u.displayName || u.username, companyId: u.companyId,
  });
});

// ── API: PHOTO UPLOAD (Supabase Storage) ────────────────────────────────────
app.post('/api/upload-photo', reqAuth, async (req, res) => {
  const store = req.store;
  if (!supabaseEnabled) {
    return res.status(503).json({ error: 'Photo upload service not configured', fallback: true });
  }
  const { kind, loadId, dataUrl } = req.body;
  if (!kind || !dataUrl) return res.status(400).json({ error: 'kind and dataUrl required' });
  if (!['ticket', 'signature'].includes(kind)) return res.status(400).json({ error: 'Invalid kind' });

  if (req.session.user.role === 'driver') {
    const l = store.loads.find(x => x.id === loadId);
    if (!l) return res.status(404).json({ error: 'Load not found' });
    if (l.truckId !== req.session.user.truckId) return res.status(403).json({ error: 'Not your load' });
    if (l.locked) return res.status(403).json({ error: 'Load is locked' });
  }

  try {
    const url = await uploadPhoto(kind, dataUrl, loadId);
    res.json({ success: true, url });
  } catch (e) {
    console.error('[upload-photo] failed:', e.message);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

// ── API: DATA (board, lists, etc.) ──────────────────────────────────────────
app.get('/api/data', reqAuth, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const u = req.session.user;
  if (u.role !== 'driver') {
    const fixed = reconcilePoStatuses(store);
    if (fixed.length) {
      console.log(`[/api/data] Reconciled ${fixed.length} stale POs`);
      await saveData();
    }
  }
  const yards = store.vendors.filter(v => v.active).map(v => ({ id: v.id, name: v.name, location: v.location }));

  if (u.role === 'driver') {
    const myLoads = store.loads.filter(l => l.truckId === u.truckId && !l.voided);
    const myPoIds = new Set(myLoads.map(l => l.poId));
    const myPos = store.pos.filter(p => myPoIds.has(p.id));
    return res.json({ trucks: TRUCKS, materials: MATERIALS, yards, pos: myPos, loads: myLoads });
  }
  res.json({
    trucks: TRUCKS,
    materials: MATERIALS,
    yards,
    vendors: store.vendors,
    vendorPrices: store.vendorPrices,
    customers: store.customers || [],
    pos: store.pos,
    loads: store.loads
  });
});

// ── API: DRIVER DISPATCH ────────────────────────────────────────────────────
app.get('/api/my-dispatch', reqAuth, (req, res) => {
  const store = req.store;
  const u = req.session.user;
  if (u.role !== 'driver') return res.status(403).json({ error: 'Driver only' });

  const myLoads = store.loads.filter(l =>
    l.truckId === u.truckId &&
    !l.voided &&
    l.status !== 'completed' &&
    l.approvalStatus !== 'approved'
  );

  const enriched = myLoads.map(l => {
    const po = store.pos.find(p => p.id === l.poId) || {};
    return {
      loadId: l.id,
      poNumber: po.poNumber || '—',
      customer: po.customer || '',
      jobName: po.job || po.customer || '',
      jobCode: po.jobCode || '',
      pickupLocation: po.pickup || 'VBT Yard',
      plannedVendorId: po.plannedVendorId || null,
      deliveryLocation: po.address || po.city || '',
      city: po.city || '',
      material: l.material,
      loadsAssigned: l.loadsAssigned,
      loadsDelivered: l.loadsDelivered,
      notes: po.notes || '',
      deliveryDate: l.deliveryDate,
      timestamps: l.timestamps || {},
      pod: l.pod || {},
      ticketImage:    l.ticketImage    || '',
      ticketImageUrl: l.ticketImageUrl || '',
      ticketImageAt:  l.ticketImageAt  || '',
      isPartial:      !!l.isPartial,
      approvalStatus: l.approvalStatus,
      rejectReason: l.rejectReason || '',
      moveHistory:  l.moveHistory || [],
      originalScheduledDate: l.originalScheduledDate || l.deliveryDate,
    };
  });
  res.json({ loads: enriched });
});

// ── API: CREATE PO ──────────────────────────────────────────────────────────
app.post('/api/pos', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  try {
  const { po, splits } = req.body;
  if (!po?.customer || !po?.deliveryDate) return res.status(400).json({ error: 'Customer and date required' });

  if (!Array.isArray(store.customers)) store.customers = [];
  let resolvedCustomer = String(po.customer || '').trim();
  if (po.customerId) {
    const c = store.customers.find(x => x.id === po.customerId);
    if (c) resolvedCustomer = c.name;
  } else {
    const lc = resolvedCustomer.toLowerCase();
    const existing = store.customers.find(x => String(x.name || '').toLowerCase().trim() === lc);
    if (existing) {
      resolvedCustomer = existing.name;
    } else if (resolvedCustomer) {
      const newCust = {
        id: 'cust-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
        name: resolvedCustomer,
        code: '', address: po.address || '', city: po.city || '',
        phone: '', email: '', notes: '',
        active: true, createdAt: new Date().toISOString(),
      };
      store.customers.push(newCust);
    }
  }

  const poNumber = po.poNumber || `PO-${store.nextPoNum++}`;
  const newPo = {
    id: 'PO-' + Date.now(),
    poNumber,
    customer:        resolvedCustomer,
    job:             po.job || resolvedCustomer,
    jobCode:         po.jobCode || '',
    address:         po.address || '',
    city:            po.city || '',
    deliveryDate:    po.deliveryDate,
    pickup:          po.pickup || 'VBT Yard',
    plannedVendorId: po.plannedVendorId || 'vbt',
    notes:           po.notes || '',
    status:          po.deliveryDate > todayStr() ? 'scheduled' : 'active',
    materials:       [],
    createdAt:       new Date().toISOString(),
  };

  const matCounts = {};
  (splits || []).forEach(s => {
    if (!s.material || !s.loadsAssigned) return;
    matCounts[s.material] = (matCounts[s.material] || 0) + Number(s.loadsAssigned);
  });
  newPo.materials = Object.keys(matCounts).map(m => ({ material: m, totalLoads: matCounts[m] }));

  store.pos.push(newPo);

  (splits || []).forEach(s => {
    if (!s.material || !s.loadsAssigned) return;
    const truck = TRUCKS.find(t => t.id === s.truckId);
    const vendor = s.vendorId ? store.vendors.find(v => v.id === s.vendorId) : null;

    let customerRate = { price: 25, unit: 'ton', isDefault: true };
    let vendorRate   = { price: 22, unit: 'ton', isDefault: true, isInternal: false };
    try {
      customerRate = resolveCustomerRate(newPo.customer, s.material, store);
      vendorRate   = resolveVendorRate(s.vendorId, s.material, store);
    } catch (e) { console.warn('[create-PO] price resolution failed:', e.message); }

    const newLoad = {
      id: 'LOAD-' + store.nextLoadId++,
      poId: newPo.id,
      material: s.material,
      vendorId: s.vendorId || null,
      vendorName: vendor?.name || '',
      unit: s.unit || customerRate.unit || 'ton',
      pricePerUnit: vendorRate.price,
      loadsAssigned: Number(s.loadsAssigned) || 0,
      loadsDelivered: 0,
      truckId: s.truckId || null,
      driverName: truck?.label || '',
      deliveryDate: newPo.deliveryDate,
      status: s.truckId ? 'active' : 'unassigned',
      timestamps: {},
      gps: {},
      pod: { signedBy: '', signature: '', signedAt: '' },
      ticketImage: '',
      ticketImageAt: '',
      approvalStatus: 'pending',
      submittedAt: '',
      approvedAt: '',
      approvedBy: '',
      rejectReason: '',
      billStatus: 'not-ready',
      billedAt: '',
      locked: false,
      voided: false,
      notes: '',
      tonsPerLoad: TONS_PER_LOAD,
      customerRate: customerRate.price,
      customerUnit: customerRate.unit,
      customerRateIsDefault: customerRate.isDefault,
      vendorRate: vendorRate.price,
      vendorUnit: vendorRate.unit,
      vendorRateIsDefault: vendorRate.isDefault,
      vendorIsInternal: vendorRate.isInternal || false,
    };
    store.loads.push(newLoad);
  });

  try {
    logAction(req.session.user, 'created-po', newPo.id, {
      poNumber: newPo.poNumber,
      customer: newPo.customer,
      deliveryDate: newPo.deliveryDate,
      loadCount: store.loads.filter(l => l.poId === newPo.id).length,
    }, store);
  } catch (e) { console.error('[create-PO] audit log failed (non-fatal):', e.message); }

  try { await saveData(); } catch (e) { console.error('[create-PO] saveData failed:', e.message); }
  res.json({ success: true, po: newPo });
  } catch (err) {
    console.error('[create-PO] CRASH:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to create PO: ' + (err.message || 'unknown error') });
    }
  }
});

// ── API: UPDATE PO ──────────────────────────────────────────────────────────
app.put('/api/pos/:id', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const idx = store.pos.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const old = store.pos[idx];
  const updated = { ...old, ...req.body, id: old.id };
  store.pos[idx] = updated;
  if (req.body.deliveryDate && req.body.deliveryDate !== old.deliveryDate) {
    store.loads.filter(l => l.poId === old.id && !l.locked).forEach(l => l.deliveryDate = req.body.deliveryDate);
  }
  logAction(req.session.user, 'updated-po', updated.id, {
    poNumber: updated.poNumber,
    changes: Object.keys(req.body),
    dateChanged: req.body.deliveryDate && req.body.deliveryDate !== old.deliveryDate,
  }, store);
  await saveData();
  res.json({ success: true, po: updated });
});

// ── API: DELETE PO ──────────────────────────────────────────────────────────
app.delete('/api/pos/:id', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const idx = store.pos.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const linked = store.loads.filter(l => l.poId === req.params.id);
  if (linked.some(l => l.approvalStatus === 'approved')) {
    return res.status(403).json({ error: 'Cannot delete — has approved loads. Void individual loads instead.' });
  }
  const deletedPo = store.pos[idx];
  const linkedCount = store.loads.filter(l => l.poId === req.params.id).length;
  store.pos.splice(idx, 1);
  store.loads = store.loads.filter(l => l.poId !== req.params.id);
  logAction(req.session.user, 'deleted-po', req.params.id, {
    poNumber: deletedPo.poNumber,
    customer: deletedPo.customer,
    loadsRemoved: linkedCount,
  }, store);
  await saveData();
  res.json({ success: true });
});

// ── API: UPDATE LOAD ────────────────────────────────────────────────────────
app.put('/api/loads/:id', reqAuth, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const u = req.session.user;
  const idx = store.loads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const l = store.loads[idx];
  if (l.locked) return res.status(403).json({ error: 'Load is locked' });

  if (u.role === 'driver') {
    if (l.truckId !== u.truckId) return res.status(403).json({ error: 'Not your load' });
    const allowed = {};
    if (req.body.loadsDelivered !== undefined) allowed.loadsDelivered = Number(req.body.loadsDelivered);
    if (req.body.timestamps) allowed.timestamps = { ...l.timestamps, ...req.body.timestamps };
    if (req.body.gps)        allowed.gps        = { ...l.gps, ...req.body.gps };
    if (req.body.pod)        allowed.pod        = { ...l.pod, ...req.body.pod };
    if (req.body.ticketImage){ allowed.ticketImage = req.body.ticketImage; allowed.ticketImageAt = new Date().toISOString(); }
    if (req.body.ticketImageUrl){ allowed.ticketImageUrl = req.body.ticketImageUrl; allowed.ticketImageAt = new Date().toISOString(); allowed.ticketImage = ''; }
    if (req.body.notes !== undefined) allowed.notes = req.body.notes;
    store.loads[idx] = { ...l, ...allowed };
  } else {
    const updated = { ...l, ...req.body, id: l.id, poId: l.poId };
    let auditAction = 'updated-load';
    let auditDetails = { changes: Object.keys(req.body) };
    if (req.body.truckId !== undefined) {
      const t = TRUCKS.find(t => t.id === req.body.truckId);
      updated.driverName = t?.label || '';
      updated.status = req.body.truckId ? 'active' : 'unassigned';
      if (req.body.truckId !== l.truckId) {
        auditAction = 'reassigned-load';
        auditDetails = {
          fromDriver: l.driverName || l.truckId || 'Unassigned',
          toDriver:   updated.driverName || 'Unassigned',
        };
      }
    }
    store.loads[idx] = updated;
    logAction(req.session.user, auditAction, l.id, auditDetails, store);
  }
  await saveData();
  res.json({ success: true, load: store.loads[idx] });
});

// ── API: DELETE LOAD (manager only) ─────────────────────────────────────────
app.delete('/api/loads/:id', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const idx = store.loads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  if (store.loads[idx].approvalStatus === 'approved') {
    return res.status(403).json({ error: 'Approved loads cannot be deleted (void instead)' });
  }
  if (store.loads[idx].billingBatchId || store.loads[idx].qbInvoiceId) {
    return res.status(403).json({ error: 'Load is in a billing batch — void the batch instead of deleting' });
  }
  const deleted = store.loads[idx];
  store.loads.splice(idx, 1);
  logAction(req.session.user, 'deleted-load', deleted.id, {
    poId: deleted.poId, material: deleted.material, driver: deleted.driverName
  }, store);
  await saveData();
  res.json({ success: true });
});

// ── PER-TRIP HELPERS (pure) ──────────────────────────────────────────────────
function ensureTripsMigrated(load) {
  if (Array.isArray(load.trips) && load.trips.length) return;
  load.trips = [];
  const ts = load.timestamps || {};
  const iso = load.isoStamps || {};
  const gps = load.gps || {};
  if (ts.start || ts.arrivedPickup || ts.loadedAt || ts.arrivedJobsite || ts.completed) {
    load.trips.push({
      tripNum: 1,
      timestamps: { ...ts },
      isoStamps:  { ...iso },
      gps:        { ...gps },
    });
  }
}

function activeTripIdx(load) {
  ensureTripsMigrated(load);
  for (let i = load.trips.length - 1; i >= 0; i--) {
    if (!load.trips[i].timestamps?.completed) return i;
  }
  return load.trips.length;
}

// ── API: DRIVER TRIP ACTIONS ────────────────────────────────────────────────
app.post('/api/loads/:id/trip-action', reqAuth, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const u = req.session.user;
  const idx = store.loads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const l = store.loads[idx];
  if (u.role === 'driver' && l.truckId !== u.truckId) return res.status(403).json({ error: 'Not your load' });
  if (l.locked) return res.status(403).json({ error: 'Load is locked' });

  const { action, gps } = req.body;
  const now = new Date();
  const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' });
  const iso  = now.toISOString();

  const isFinalizer = (action === 'delivered' || action === 'incomplete');
  if (action === 'start-trip' && (l.loadsDelivered || 0) >= l.loadsAssigned) {
    return res.status(400).json({ error: 'All assigned loads already delivered — submit when ready' });
  }
  const tripIdx = activeTripIdx(l);
  let trip = l.trips[tripIdx];
  if (!trip && action === 'start-trip') {
    trip = { tripNum: tripIdx + 1, timestamps: {}, isoStamps: {}, gps: {} };
    l.trips[tripIdx] = trip;
    if (trip.tripNum > 1) {
      l.timestamps = {};
      l.isoStamps  = {};
    }
  } else if (!trip && isFinalizer && l.trips.length) {
    trip = l.trips[l.trips.length - 1];
  }
  if (!trip) return res.status(400).json({ error: 'No active trip — press Start Trip to begin' });

  const stampBoth = (key) => {
    trip.timestamps = { ...trip.timestamps, [key]: time };
    trip.isoStamps  = { ...trip.isoStamps,  [key]: iso };
    trip.gps        = { ...trip.gps,        [key]: gps || null };
    l.timestamps    = { ...l.timestamps,    [key]: time };
    l.isoStamps     = { ...l.isoStamps,     [key]: iso };
    l.gps           = { ...l.gps,           [key]: gps || null };
  };

  if (action === 'start-trip') {
    stampBoth('start');
  } else if (action === 'arrived-pickup') {
    if (!trip.timestamps?.start) return res.status(400).json({ error: 'Must start trip first' });
    stampBoth('arrivedPickup');
    if (req.body.yardId) {
      const yard = store.vendors.find(y => y.id === req.body.yardId);
      if (yard) {
        l.actualYardId   = yard.id;
        l.actualYardName = yard.name;
        trip.actualYardId   = yard.id;
        trip.actualYardName = yard.name;
      }
    }
  } else if (action === 'loaded') {
    if (!trip.timestamps?.arrivedPickup) return res.status(400).json({ error: 'Must mark arrived at pickup first' });
    stampBoth('loadedAt');
  } else if (action === 'arrived-jobsite') {
    if (!trip.timestamps?.loadedAt) return res.status(400).json({ error: 'Must mark loaded / leaving yard first' });
    stampBoth('arrivedJobsite');
  } else if (action === 'trip-complete') {
    if (!trip.timestamps?.arrivedJobsite) return res.status(400).json({ error: 'Must mark arrived at job site first' });
    if (trip.timestamps?.completed)        return res.status(400).json({ error: 'Trip already complete' });
    stampBoth('completed');
    l.loadsDelivered = (l.loadsDelivered || 0) + 1;
    if (l.loadsDelivered >= l.loadsAssigned) {
      l.allTripsDone = true;
    }
  } else if (action === 'delivered' || action === 'incomplete') {
    if (!l.ticketImage && !l.ticketImageUrl)
      return res.status(400).json({ error: 'Ticket photo required' });
    if (!l.pod?.signedBy || (!l.pod.signature && !l.pod.signatureUrl))
      return res.status(400).json({ error: 'Customer signature required' });

    if (action === 'incomplete') {
      if (!trip.timestamps?.completed && trip.timestamps?.arrivedJobsite) {
        stampBoth('completed');
        l.loadsDelivered = (l.loadsDelivered || 0) + 1;
      }
      const reported = Math.max(0, Math.min(Number(req.body.delivered) || l.loadsDelivered || 0, l.loadsAssigned));
      if (reported <= 0) return res.status(400).json({ error: 'How many loads did you deliver? Enter a number greater than 0.' });
      l.loadsDelivered = reported;
      l.isPartial = (reported < l.loadsAssigned);
    } else {
      if (!trip.timestamps?.completed && trip.timestamps?.arrivedJobsite) {
        stampBoth('completed');
        l.loadsDelivered = (l.loadsDelivered || 0) + 1;
      }
      if (l.loadsDelivered >= l.loadsAssigned) {
        l.loadsDelivered = l.loadsAssigned;
        l.isPartial = false;
      } else {
        l.isPartial = true;
      }
    }

    l.approvalStatus = 'submitted';
    l.submittedAt    = new Date().toISOString();
    l.locked         = true;
  } else {
    return res.status(400).json({ error: 'Unknown action: ' + action });
  }
  await saveData();
  res.json({ success: true, load: l });
});

// ── API: MANAGER APPROVALS ──────────────────────────────────────────────────
app.post('/api/loads/:id/approve', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const idx = store.loads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const l = store.loads[idx];
  if (l.approvalStatus !== 'submitted') return res.status(400).json({ error: 'Load not submitted for approval' });
  l.approvalStatus = 'approved';
  l.approvedAt     = new Date().toISOString();
  l.approvedBy     = req.session.user.displayName || req.session.user.username;
  l.status         = 'completed';
  l.completedAt    = new Date().toISOString();
  l.billStatus     = 'ready';
  l.locked         = true;
  const po = store.pos.find(p => p.id === l.poId);
  if (po) {
    const remaining = store.loads.filter(x => x.poId === po.id && x.status !== 'completed' && !x.voided);
    if (!remaining.length) { po.status = 'completed'; po.completedAt = new Date().toISOString(); }
  }
  logAction(req.session.user, 'approved-load', l.id, {
    poNumber: po?.poNumber || '',
    customer: po?.customer || '',
    material: l.material,
    driver:   l.driverName,
    delivered: l.loadsDelivered,
    assigned:  l.loadsAssigned,
    isPartial: !!l.isPartial,
  }, store);
  await saveData();
  res.json({ success: true });
});

app.post('/api/loads/:id/reject', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const idx = store.loads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const l = store.loads[idx];
  if (l.approvalStatus !== 'submitted') return res.status(400).json({ error: 'Load not submitted' });
  l.approvalStatus = 'rejected';
  l.rejectReason   = req.body.reason || 'No reason provided';
  l.locked         = false;
  const po = store.pos.find(p => p.id === l.poId);
  logAction(req.session.user, 'rejected-load', l.id, {
    poNumber: po?.poNumber || '',
    driver:   l.driverName,
    reason:   l.rejectReason,
  }, store);
  await saveData();
  res.json({ success: true });
});

// ── API: BILLING ─────────────────────────────────────────────────────────────
app.get('/api/ready-to-bill', reqMgr, (req, res) => {
  const store = req.store;
  const filters = req.query;
  let items = store.loads.filter(l => l.approvalStatus === 'approved' && l.billStatus === 'ready' && !l.voided);
  if (filters.month)    items = items.filter(l => (l.deliveryDate || '').startsWith(filters.month));
  if (filters.material) items = items.filter(l => l.material === filters.material);
  if (filters.truckId)  items = items.filter(l => l.truckId === filters.truckId);
  if (filters.poId)     items = items.filter(l => l.poId === filters.poId);
  const enriched = items.map(l => {
    const po = store.pos.find(p => p.id === l.poId) || {};
    return { ...l, poNumber: po.poNumber, customer: po.customer, city: po.city, address: po.address };
  });
  res.json({ items: enriched });
});

app.post('/api/loads/bill', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const ids = req.body.loadIds || [];
  let count = 0;
  const billedIds = [];
  store.loads.forEach(l => {
    if (ids.includes(l.id) && l.approvalStatus === 'approved' && l.billStatus === 'ready') {
      l.billStatus = 'billed';
      l.billedAt   = new Date().toISOString();
      billedIds.push(l.id);
      count++;
    }
  });
  if (count > 0) {
    logAction(req.session.user, 'marked-billed', '', { count, loadIds: billedIds }, store);
  }
  await saveData();
  res.json({ success: true, billed: count });
});

// ═══════════════════════════════════════════════════════════════════════════
// QUICKBOOKS ONLINE INTEGRATION (per-company)
// ═══════════════════════════════════════════════════════════════════════════

function genId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function logQbSync(entry, s) {
  try {
    const e = {
      id: genId('QBL'),
      at: new Date().toISOString(),
      actionType: entry.actionType,
      relatedBatchId: entry.relatedBatchId || '',
      relatedLoadIds: entry.relatedLoadIds || [],
      qbEntityType: entry.qbEntityType || '',
      qbEntityId: entry.qbEntityId || '',
      requestSummary: entry.requestSummary || '',
      responseStatus: entry.responseStatus || 'ok',
      errorMessage: entry.errorMessage || '',
      statusCode: entry.statusCode || 0,
      user: entry.user || '',
    };
    if (!s) return e;
    if (!Array.isArray(s.qbSyncLog)) s.qbSyncLog = [];
    s.qbSyncLog.push(e);
    if (s.qbSyncLog.length > 5000) s.qbSyncLog = s.qbSyncLog.slice(-5000);
    return e;
  } catch (err) {
    console.error('[logQbSync] failed:', err.message);
    return null;
  }
}

function buildBillingGroups(loadIds, s) {
  const out = new Map();
  for (const id of loadIds) {
    const l = s.loads.find(x => x.id === id);
    if (!l) continue;
    if (l.approvalStatus !== 'approved') continue;
    if (l.billStatus !== 'ready') continue;
    if (l.voided) continue;
    if (l.billingBatchId) continue;
    const po = s.pos.find(p => p.id === l.poId) || {};
    const key = [
      (po.customer || '').toLowerCase().trim(),
      po.poNumber || '',
      (po.address || '').toLowerCase().trim(),
      (po.city || '').toLowerCase().trim(),
    ].join('|');
    if (!out.has(key)) {
      out.set(key, {
        key,
        customer: po.customer || '',
        poNumber: po.poNumber || '',
        poId: po.id || '',
        jobCode: po.jobCode || '',
        address: po.address || '',
        city: po.city || '',
        loads: [],
      });
    }
    out.get(key).loads.push({ load: l, po });
  }

  const groups = [];
  for (const g of out.values()) {
    const dates = g.loads.map(x => x.load.deliveryDate).filter(Boolean).sort();
    const ticketImages   = [];
    const signatureImages = [];
    const approvalStamps = [];
    const loadIdsInGroup = [];

    const lineMap = new Map();
    for (const { load, po } of g.loads) {
      loadIdsInGroup.push(load.id);
      const rev = computeRevenue(load);
      const tons = (Number(load.tonsPerLoad) || TONS_PER_LOAD) * (Number(load.loadsDelivered) || 0);
      const unit = load.customerUnit || 'ton';
      const rate = Number(load.customerRate) || 0;
      const lk = `${load.material}|${unit}|${rate}`;
      if (!lineMap.has(lk)) {
        lineMap.set(lk, {
          material: load.material,
          unit, rate,
          loads: 0, tons: 0, amount: 0,
          loadIds: [],
        });
      }
      const ln = lineMap.get(lk);
      ln.loads += Number(load.loadsDelivered) || 0;
      ln.tons  += tons;
      ln.amount += rev;
      ln.loadIds.push(load.id);

      if (load.ticketImageUrl) ticketImages.push({ loadId: load.id, url: load.ticketImageUrl });
      else if (load.ticketImage) ticketImages.push({ loadId: load.id, dataUrl: true });
      if (load.pod?.signature) signatureImages.push({ loadId: load.id, dataUrl: true });
      if (load.approvedAt) approvalStamps.push({ loadId: load.id, at: load.approvedAt, by: load.approvedBy });
    }

    const lineItems = [...lineMap.values()].map(ln => ({
      ...ln,
      description: `${ln.material} — ${ln.loads} load${ln.loads === 1 ? '' : 's'}`
        + (ln.unit === 'ton' ? ` (${ln.tons.toFixed(2)} ton @ $${ln.rate}/ton)` : ` (@ $${ln.rate}/load)`),
    }));
    const totalAmount = lineItems.reduce((sum, ln) => sum + ln.amount, 0);
    const totalLoads  = lineItems.reduce((sum, ln) => sum + ln.loads, 0);
    const totalTons   = lineItems.reduce((sum, ln) => sum + ln.tons, 0);

    groups.push({
      key: g.key,
      customer: g.customer,
      poNumber: g.poNumber,
      poId: g.poId,
      jobCode: g.jobCode,
      address: g.address,
      city: g.city,
      deliveryStart: dates[0] || '',
      deliveryEnd: dates[dates.length - 1] || '',
      loadIds: loadIdsInGroup,
      totalLoads, totalTons, totalAmount,
      lineItems,
      ticketImages, signatureImages, approvalStamps,
    });
  }
  return groups;
}

// ── QB CONNECTION ENDPOINTS ──────────────────────────────────────────────────
app.get('/api/quickbooks/status', reqMgr, (req, res) => {
  const store = req.store;
  const cfg = qb.configSummary();
  const c = store.qbConnection || {};
  res.json({
    config: cfg,
    connection: {
      status: c.status || 'disconnected',
      environment: c.environment || cfg.environment,
      realmId: c.realmId || '',
      connectedAt: c.connectedAt || '',
      connectedBy: c.connectedBy || '',
      accessExpiresAt: c.accessExpiresAt || '',
      refreshExpiresAt: c.refreshExpiresAt || '',
      lastError: c.lastError || '',
      lastSyncAt: c.lastSyncAt || '',
    },
  });
});

app.get('/api/quickbooks/connect', reqAdmin, (req, res) => {
  if (!qb.isConfigured()) {
    return res.status(400).send('QuickBooks not configured. Set QB_CLIENT_ID, QB_CLIENT_SECRET, and QB_REDIRECT_URI.');
  }
  const state = require('crypto').randomBytes(24).toString('hex');
  req.session.qbOauthState = state;
  req.session.qbOauthUser  = req.session.user.username;
  res.redirect(qb.buildAuthUrl(state));
});

app.get('/api/quickbooks/callback', reqAuth, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  try {
    const { code, state, realmId, error, error_description } = req.query;
    if (error) {
      logQbSync({ actionType: 'oauth_connect', responseStatus: 'error', errorMessage: `${error}: ${error_description || ''}`, user: req.session.user?.username }, store);
      return res.status(400).send(`QuickBooks authorization failed: ${error_description || error}`);
    }
    if (!code || !state || !realmId) {
      return res.status(400).send('Missing code/state/realmId from QuickBooks callback.');
    }
    if (state !== req.session.qbOauthState) {
      return res.status(400).send('OAuth state mismatch — please try connecting again.');
    }
    if (req.session.user.role !== 'admin') {
      return res.status(403).send('Only an admin can complete QuickBooks setup.');
    }
    const tok = await qb.exchangeCodeForToken(code);
    const conn = store.qbConnection;
    qb.applyTokenToConnection(conn, tok);
    conn.realmId = String(realmId);
    conn.environment = qb.QB_ENVIRONMENT;
    conn.connectedAt = new Date().toISOString();
    conn.connectedBy = req.session.user.username;
    conn.lastError = '';
    delete req.session.qbOauthState;

    logQbSync({ actionType: 'oauth_connect', qbEntityType: 'Realm', qbEntityId: String(realmId), user: req.session.user.username, requestSummary: `Connected to ${qb.QB_ENVIRONMENT}` }, store);
    logAction(req.session.user, 'qb-connected', String(realmId), { environment: qb.QB_ENVIRONMENT }, store);
    await saveData();
    res.send(`<html><body style="font-family:system-ui;padding:40px;text-align:center">
      <h2 style="color:#0a8a3a">QuickBooks connected</h2>
      <p>Realm: <code>${realmId}</code> · Environment: <strong>${qb.QB_ENVIRONMENT}</strong></p>
      <p><a href="/app/">Return to dispatch</a></p>
      <script>setTimeout(()=>{location.href='/app/#qb-settings'},1500)</script>
    </body></html>`);
  } catch (e) {
    console.error('[qb callback]', e);
    logQbSync({ actionType: 'oauth_connect', responseStatus: 'error', errorMessage: e.message, user: req.session.user?.username }, store);
    res.status(500).send(`QuickBooks connect failed: ${e.message}`);
  }
});

app.post('/api/quickbooks/disconnect', reqAdmin, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const conn = store.qbConnection;
  try {
    if (conn.refreshTokenEnc) {
      const refresh = qb.decrypt(conn.refreshTokenEnc);
      await qb.revokeToken(refresh).catch(() => {});
    }
  } finally {
    conn.status = 'disconnected';
    conn.realmId = '';
    conn.accessTokenEnc = '';
    conn.refreshTokenEnc = '';
    conn.accessExpiresAt = '';
    conn.refreshExpiresAt = '';
    conn.connectedAt = '';
    conn.connectedBy = '';
    conn.lastError = '';
    logQbSync({ actionType: 'oauth_disconnect', user: req.session.user.username }, store);
    logAction(req.session.user, 'qb-disconnected', '', {}, store);
    await saveData();
    res.json({ success: true });
  }
});

// ── BILLING BATCH ENDPOINTS ─────────────────────────────────────────────────
app.post('/api/billing-batches/preview', reqMgr, (req, res) => {
  const store = req.store;
  const ids = req.body?.loadIds || [];
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'loadIds required' });
  const groups = buildBillingGroups(ids, store);
  if (!groups.length) return res.status(400).json({ error: 'No eligible loads to bill (must be approved, ready, and not yet in a batch)' });
  res.json({ groups });
});

app.post('/api/billing-batches', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const ids = req.body?.loadIds || [];
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'loadIds required' });
  const groups = buildBillingGroups(ids, store);
  if (!groups.length) return res.status(400).json({ error: 'No eligible loads to bill' });

  const created = [];
  const now = new Date().toISOString();
  for (const g of groups) {
    const batchId = genId('BB');
    const batch = {
      id: batchId,
      customer: g.customer,
      poNumber: g.poNumber,
      poId: g.poId,
      jobCode: g.jobCode,
      address: g.address,
      city: g.city,
      deliveryStart: g.deliveryStart,
      deliveryEnd: g.deliveryEnd,
      loadIds: g.loadIds,
      totalLoads: g.totalLoads,
      totalTons: g.totalTons,
      totalAmount: g.totalAmount,
      lineItems: g.lineItems,
      ticketImageRefs: g.ticketImages,
      signatureImageRefs: g.signatureImages,
      approvalStamps: g.approvalStamps,
      qbCustomerId: '',
      qbInvoiceId: '',
      qbInvoiceNumber: '',
      qbDocNumber: '',
      attachmentIds: [],
      syncStatus: 'ready_to_bill',
      errorMessage: '',
      createdAt: now,
      createdBy: req.session.user.username,
      sentAt: '', sentBy: '',
      voidedAt: '', voidedBy: '', voidReason: '',
    };
    store.billingBatches.push(batch);
    for (const lid of g.loadIds) {
      const l = store.loads.find(x => x.id === lid);
      if (l) l.billingBatchId = batchId;
    }
    created.push(batch);
  }
  logAction(req.session.user, 'created-billing-batches', '', {
    count: created.length, batchIds: created.map(b => b.id), totalLoads: created.reduce((s, b) => s + b.totalLoads, 0),
  }, store);
  await saveData();
  res.json({ success: true, batches: created });
});

app.get('/api/billing-batches', reqMgr, (req, res) => {
  const store = req.store;
  const f = req.query;
  let items = [...(store.billingBatches || [])];
  if (f.status)   items = items.filter(b => b.syncStatus === f.status);
  if (f.customer) items = items.filter(b => (b.customer || '').toLowerCase().includes(String(f.customer).toLowerCase()));
  if (f.poNumber) items = items.filter(b => (b.poNumber || '').toLowerCase().includes(String(f.poNumber).toLowerCase()));
  if (f.month)    items = items.filter(b => (b.deliveryStart || '').startsWith(f.month));
  if (f.city)     items = items.filter(b => (b.city || '').toLowerCase().includes(String(f.city).toLowerCase()));
  items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json({ items });
});

app.get('/api/billing-batches/:id', reqMgr, (req, res) => {
  const store = req.store;
  const b = store.billingBatches.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Batch not found' });
  const loads = b.loadIds.map(lid => store.loads.find(l => l.id === lid)).filter(Boolean).map(l => ({
    id: l.id,
    deliveryDate: l.deliveryDate,
    material: l.material,
    loadsDelivered: l.loadsDelivered,
    driverName: l.driverName,
    ticketImageUrl: l.ticketImageUrl || '',
    podSignatureUrl: l.pod?.signatureUrl || '',
    qbInvoiceId: l.qbInvoiceId,
    qbInvoiceNumber: l.qbInvoiceNumber,
  }));
  res.json({ batch: b, loads });
});

app.post('/api/billing-batches/:id/send', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const b = store.billingBatches.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Batch not found' });
  if (b.syncStatus === 'sent_to_quickbooks' && b.qbInvoiceId) {
    return res.status(400).json({ error: `Already sent (invoice ${b.qbInvoiceNumber || b.qbInvoiceId})` });
  }
  if (b.syncStatus === 'voided') return res.status(400).json({ error: 'Cannot send a voided batch' });
  const conn = store.qbConnection;
  if (!conn?.realmId || conn.status !== 'connected') return res.status(400).json({ error: 'QuickBooks not connected' });

  b.syncStatus = 'syncing';
  b.errorMessage = '';
  await saveData();

  const user = req.session.user.username;
  try {
    const localCust = store.customers.find(c => (c.name || '').toLowerCase().trim() === (b.customer || '').toLowerCase().trim());
    let qbCustomerId = localCust?.qbCustomerId || '';
    if (!qbCustomerId) {
      const lookup = await qb.findOrCreateCustomer(conn, {
        name: b.customer,
        address: b.address,
        city: b.city,
        phone: localCust?.phone || '',
        email: localCust?.email || '',
      });
      qbCustomerId = lookup.customer?.Id;
      if (!qbCustomerId) throw new Error('QuickBooks did not return a customer ID');
      if (localCust) localCust.qbCustomerId = qbCustomerId;
      logQbSync({
        actionType: lookup.created ? 'create_customer' : 'find_customer',
        relatedBatchId: b.id,
        qbEntityType: 'Customer',
        qbEntityId: qbCustomerId,
        requestSummary: `${lookup.created ? 'Created' : 'Matched'} customer "${b.customer}"`,
        user,
      }, store);
    }
    b.qbCustomerId = qbCustomerId;

    const memoParts = [];
    if (b.poNumber)      memoParts.push(`PO ${b.poNumber}`);
    if (b.jobCode)       memoParts.push(`Job ${b.jobCode}`);
    if (b.address)       memoParts.push(b.address + (b.city ? `, ${b.city}` : ''));
    if (b.deliveryStart) memoParts.push(b.deliveryStart === b.deliveryEnd ? b.deliveryStart : `${b.deliveryStart} to ${b.deliveryEnd}`);
    memoParts.push(`Batch ${b.id}`);
    const memo = memoParts.join(' · ');

    const invoice = await qb.createInvoice(conn, {
      qbCustomerId,
      lines: b.lineItems.map(ln => ({
        description: ln.description,
        quantity: ln.unit === 'ton' ? ln.tons : ln.loads,
        amount: ln.amount,
      })),
      memo,
      privateNote: `VBT Dispatch billing batch ${b.id}. PO ${b.poNumber}. Loads: ${b.loadIds.join(', ')}`,
      docNumber: b.poNumber ? String(b.poNumber).slice(0, 21) : undefined,
      txnDate: b.deliveryEnd || b.deliveryStart || undefined,
    });
    if (!invoice?.Id) throw new Error('QuickBooks did not return an invoice ID');
    b.qbInvoiceId = invoice.Id;
    b.qbInvoiceNumber = invoice.DocNumber || '';
    b.qbDocNumber = invoice.DocNumber || '';
    b.sentAt = new Date().toISOString();
    b.sentBy = user;
    b.syncStatus = 'sent_to_quickbooks';

    logQbSync({
      actionType: 'create_invoice',
      relatedBatchId: b.id,
      relatedLoadIds: b.loadIds,
      qbEntityType: 'Invoice',
      qbEntityId: invoice.Id,
      requestSummary: `Invoice ${invoice.DocNumber || invoice.Id} for ${b.customer} — $${b.totalAmount.toFixed(2)}`,
      user,
    }, store);

    for (const lid of b.loadIds) {
      const l = store.loads.find(x => x.id === lid);
      if (l) {
        l.qbInvoiceId = invoice.Id;
        l.qbInvoiceNumber = invoice.DocNumber || '';
        l.sentToQuickBooksAt = b.sentAt;
        l.billStatus = 'billed';
        l.billedAt = b.sentAt;
      }
    }
    conn.lastSyncAt = b.sentAt;

    await saveData();

    const attachmentIds = [];
    for (const ref of (b.ticketImageRefs || [])) {
      if (!ref.url) continue;
      try {
        const { buffer, contentType } = await qb.fetchRemoteAsBuffer(ref.url);
        const ext = (contentType.split('/')[1] || 'jpg').split(';')[0];
        const att = await qb.attachToEntity(conn, {
          entityType: 'Invoice',
          entityId: invoice.Id,
          fileName: `ticket-${ref.loadId}.${ext}`,
          contentType,
          buffer,
          includeOnSend: true,
        });
        if (att?.Id) attachmentIds.push({ kind: 'ticket', loadId: ref.loadId, qbAttachableId: att.Id });
        logQbSync({ actionType: 'attach_file', relatedBatchId: b.id, relatedLoadIds: [ref.loadId], qbEntityType: 'Invoice', qbEntityId: invoice.Id, requestSummary: `ticket-${ref.loadId}`, user }, store);
      } catch (e) {
        logQbSync({ actionType: 'attach_file', relatedBatchId: b.id, relatedLoadIds: [ref.loadId], qbEntityType: 'Invoice', qbEntityId: invoice.Id, responseStatus: 'error', errorMessage: e.message, user }, store);
      }
    }
    for (const ref of (b.signatureImageRefs || [])) {
      const l = store.loads.find(x => x.id === ref.loadId);
      const url = l?.pod?.signatureUrl;
      if (!url) continue;
      try {
        const { buffer, contentType } = await qb.fetchRemoteAsBuffer(url);
        const ext = (contentType.split('/')[1] || 'png').split(';')[0];
        const att = await qb.attachToEntity(conn, {
          entityType: 'Invoice',
          entityId: invoice.Id,
          fileName: `signature-${ref.loadId}.${ext}`,
          contentType,
          buffer,
          includeOnSend: true,
        });
        if (att?.Id) attachmentIds.push({ kind: 'signature', loadId: ref.loadId, qbAttachableId: att.Id });
        logQbSync({ actionType: 'attach_file', relatedBatchId: b.id, relatedLoadIds: [ref.loadId], qbEntityType: 'Invoice', qbEntityId: invoice.Id, requestSummary: `signature-${ref.loadId}`, user }, store);
      } catch (e) {
        logQbSync({ actionType: 'attach_file', relatedBatchId: b.id, relatedLoadIds: [ref.loadId], qbEntityType: 'Invoice', qbEntityId: invoice.Id, responseStatus: 'error', errorMessage: e.message, user }, store);
      }
    }
    b.attachmentIds = attachmentIds;
    logAction(req.session.user, 'sent-to-quickbooks', b.id, {
      invoiceId: invoice.Id, invoiceNumber: invoice.DocNumber, amount: b.totalAmount, loads: b.loadIds.length,
    }, store);
    await saveData();
    res.json({ success: true, batch: b });
  } catch (e) {
    console.error('[qb send]', e);
    b.syncStatus = 'failed';
    b.errorMessage = e.message;
    if (store.qbConnection) store.qbConnection.lastError = e.message;
    logQbSync({
      actionType: 'create_invoice',
      relatedBatchId: b.id,
      relatedLoadIds: b.loadIds,
      responseStatus: 'error',
      errorMessage: e.message,
      statusCode: e.statusCode || 0,
      user,
    }, store);
    await saveData();
    res.status(500).json({ error: e.message, batch: b });
  }
});

app.post('/api/billing-batches/:id/void', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const b = store.billingBatches.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Batch not found' });
  if (b.syncStatus === 'voided') return res.status(400).json({ error: 'Already voided' });
  const reason = (req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Reason required' });

  const conn = store.qbConnection;
  let qbVoided = false;
  if (b.qbInvoiceId && conn?.status === 'connected' && req.body?.voidInQuickBooks !== false) {
    try {
      await qb.voidInvoice(conn, b.qbInvoiceId);
      qbVoided = true;
      logQbSync({ actionType: 'void_invoice', relatedBatchId: b.id, qbEntityType: 'Invoice', qbEntityId: b.qbInvoiceId, requestSummary: reason, user: req.session.user.username }, store);
    } catch (e) {
      logQbSync({ actionType: 'void_invoice', relatedBatchId: b.id, qbEntityType: 'Invoice', qbEntityId: b.qbInvoiceId, responseStatus: 'error', errorMessage: e.message, user: req.session.user.username }, store);
      return res.status(500).json({ error: `Failed to void in QuickBooks: ${e.message}` });
    }
  }

  b.syncStatus = 'voided';
  b.voidedAt = new Date().toISOString();
  b.voidedBy = req.session.user.username;
  b.voidReason = reason;

  for (const lid of b.loadIds) {
    const l = store.loads.find(x => x.id === lid);
    if (l) {
      l.billingBatchId = '';
      l.billStatus = 'ready';
      l.qbInvoiceId = '';
      l.qbInvoiceNumber = '';
      l.sentToQuickBooksAt = '';
    }
  }
  logAction(req.session.user, 'voided-billing-batch', b.id, { reason, qbVoided }, store);
  await saveData();
  res.json({ success: true, batch: b });
});

app.post('/api/billing-batches/:id/retry', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const b = store.billingBatches.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Batch not found' });
  if (b.syncStatus !== 'failed') return res.status(400).json({ error: 'Only failed batches can be retried' });
  b.syncStatus = 'ready_to_bill';
  b.errorMessage = '';
  await saveData();
  res.json({ success: true, batch: b });
});

// ── VENDOR BILLS (PAYABLES) ─────────────────────────────────────────────────
function buildVendorBillGroups(loadIds, s) {
  const out = new Map();
  for (const id of loadIds) {
    const l = s.loads.find(x => x.id === id);
    if (!l) continue;
    if (l.approvalStatus !== 'approved') continue;
    if (l.voided) continue;
    if (l.vendorBillId) continue;
    const vendorId = l.vendorId || l.yardId || '';
    if (!vendorId || vendorId === 'vbt') continue;
    const v = s.vendors.find(x => x.id === vendorId);
    if (!v) continue;
    const key = vendorId;
    if (!out.has(key)) out.set(key, { vendorId, vendor: v, loads: [] });
    out.get(key).loads.push(l);
  }
  const groups = [];
  for (const g of out.values()) {
    const dates = g.loads.map(l => l.deliveryDate).filter(Boolean).sort();
    const lineMap = new Map();
    let total = 0;
    const loadIds = [];
    for (const l of g.loads) {
      loadIds.push(l.id);
      const cost = computeCost(l);
      total += cost;
      const lk = `${l.material}|${l.vendorUnit || 'ton'}|${l.vendorRate || 0}`;
      if (!lineMap.has(lk)) {
        lineMap.set(lk, { material: l.material, unit: l.vendorUnit || 'ton', rate: Number(l.vendorRate) || 0, loads: 0, tons: 0, amount: 0, loadIds: [] });
      }
      const ln = lineMap.get(lk);
      ln.loads += Number(l.loadsDelivered) || 0;
      ln.tons  += (Number(l.tonsPerLoad) || TONS_PER_LOAD) * (Number(l.loadsDelivered) || 0);
      ln.amount += cost;
      ln.loadIds.push(l.id);
    }
    const lineItems = [...lineMap.values()].map(ln => ({
      ...ln,
      description: `${ln.material} — ${ln.loads} load${ln.loads === 1 ? '' : 's'}` + (ln.unit === 'ton' ? ` (${ln.tons.toFixed(2)} ton @ $${ln.rate}/ton)` : ` (@ $${ln.rate}/load)`),
    }));
    groups.push({
      vendorId: g.vendorId,
      vendorName: g.vendor.name,
      deliveryStart: dates[0] || '',
      deliveryEnd: dates[dates.length - 1] || '',
      loadIds,
      totalAmount: total,
      lineItems,
    });
  }
  return groups;
}

app.post('/api/vendor-bills/preview', reqMgr, (req, res) => {
  const store = req.store;
  const ids = req.body?.loadIds || [];
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'loadIds required' });
  const groups = buildVendorBillGroups(ids, store);
  if (!groups.length) return res.status(400).json({ error: 'No eligible vendor costs (loads must be approved, vendor must be external)' });
  res.json({ groups });
});

app.post('/api/vendor-bills', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const ids = req.body?.loadIds || [];
  const groups = buildVendorBillGroups(ids, store);
  if (!groups.length) return res.status(400).json({ error: 'No eligible vendor costs' });
  const created = [];
  const now = new Date().toISOString();
  for (const g of groups) {
    const bill = {
      id: genId('VB'),
      vendorId: g.vendorId,
      vendorName: g.vendorName,
      deliveryStart: g.deliveryStart,
      deliveryEnd: g.deliveryEnd,
      loadIds: g.loadIds,
      totalAmount: g.totalAmount,
      lineItems: g.lineItems,
      qbVendorId: '', qbBillId: '', qbDocNumber: '',
      syncStatus: 'ready',
      errorMessage: '',
      createdAt: now,
      createdBy: req.session.user.username,
      sentAt: '', sentBy: '',
    };
    store.vendorBills.push(bill);
    for (const lid of g.loadIds) {
      const l = store.loads.find(x => x.id === lid);
      if (l) l.vendorBillId = bill.id;
    }
    created.push(bill);
  }
  logAction(req.session.user, 'created-vendor-bills', '', { count: created.length, billIds: created.map(b => b.id) }, store);
  await saveData();
  res.json({ success: true, bills: created });
});

app.get('/api/vendor-bills', reqMgr, (req, res) => {
  const store = req.store;
  const f = req.query;
  let items = [...(store.vendorBills || [])];
  if (f.status)   items = items.filter(b => b.syncStatus === f.status);
  if (f.vendorId) items = items.filter(b => b.vendorId === f.vendorId);
  if (f.month)    items = items.filter(b => (b.deliveryStart || '').startsWith(f.month));
  items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json({ items });
});

app.post('/api/vendor-bills/:id/send', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const b = store.vendorBills.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Bill not found' });
  if (b.syncStatus === 'sent' && b.qbBillId) return res.status(400).json({ error: 'Already sent' });
  const conn = store.qbConnection;
  if (!conn?.realmId || conn.status !== 'connected') return res.status(400).json({ error: 'QuickBooks not connected' });
  const user = req.session.user.username;
  b.syncStatus = 'syncing'; b.errorMessage = ''; await saveData();
  try {
    const localVendor = store.vendors.find(v => v.id === b.vendorId);
    let qbVendorId = localVendor?.qbVendorId || '';
    if (!qbVendorId) {
      const lookup = await qb.findOrCreateVendor(conn, { name: b.vendorName });
      qbVendorId = lookup.vendor?.Id;
      if (!qbVendorId) throw new Error('QuickBooks did not return a vendor ID');
      if (localVendor) localVendor.qbVendorId = qbVendorId;
      logQbSync({ actionType: lookup.created ? 'create_vendor' : 'find_vendor', relatedBatchId: b.id, qbEntityType: 'Vendor', qbEntityId: qbVendorId, requestSummary: `${lookup.created ? 'Created' : 'Matched'} vendor "${b.vendorName}"`, user }, store);
    }
    b.qbVendorId = qbVendorId;

    const memo = `VBT Dispatch vendor bill ${b.id} · ${b.deliveryStart}${b.deliveryEnd && b.deliveryEnd !== b.deliveryStart ? ' to ' + b.deliveryEnd : ''} · Loads: ${b.loadIds.join(', ')}`;
    const bill = await qb.createBill(conn, {
      qbVendorId,
      lines: b.lineItems.map(ln => ({ description: ln.description, amount: ln.amount })),
      memo,
      docNumber: b.id.slice(0, 21),
      txnDate: b.deliveryEnd || b.deliveryStart || undefined,
    });
    if (!bill?.Id) throw new Error('QuickBooks did not return a bill ID');
    b.qbBillId = bill.Id;
    b.qbDocNumber = bill.DocNumber || '';
    b.syncStatus = 'sent';
    b.sentAt = new Date().toISOString();
    b.sentBy = user;
    for (const lid of b.loadIds) {
      const l = store.loads.find(x => x.id === lid);
      if (l) l.qbBillId = bill.Id;
    }
    logQbSync({ actionType: 'create_bill', relatedBatchId: b.id, relatedLoadIds: b.loadIds, qbEntityType: 'Bill', qbEntityId: bill.Id, requestSummary: `Bill for ${b.vendorName} — $${b.totalAmount.toFixed(2)}`, user }, store);
    logAction(req.session.user, 'sent-vendor-bill', b.id, { qbBillId: bill.Id, vendor: b.vendorName, amount: b.totalAmount }, store);
    await saveData();
    res.json({ success: true, bill: b });
  } catch (e) {
    console.error('[vendor bill send]', e);
    b.syncStatus = 'failed';
    b.errorMessage = e.message;
    logQbSync({ actionType: 'create_bill', relatedBatchId: b.id, relatedLoadIds: b.loadIds, responseStatus: 'error', errorMessage: e.message, statusCode: e.statusCode || 0, user }, store);
    await saveData();
    res.status(500).json({ error: e.message, bill: b });
  }
});

// ── QB SYNC LOG ─────────────────────────────────────────────────────────────
app.get('/api/qb-sync-log', reqMgr, (req, res) => {
  const store = req.store;
  const f = req.query || {};
  let items = [...(store.qbSyncLog || [])];
  if (f.status)     items = items.filter(e => e.responseStatus === f.status);
  if (f.actionType) items = items.filter(e => e.actionType === f.actionType);
  if (f.batchId)    items = items.filter(e => e.relatedBatchId === f.batchId);
  if (f.loadId)     items = items.filter(e => (e.relatedLoadIds || []).includes(f.loadId));
  items.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  const limit = Math.min(parseInt(f.limit || '500', 10) || 500, 5000);
  res.json({ items: items.slice(0, limit) });
});

// ── API: MOVE LOADS TO A NEW DATE ────────────────────────────────────────────
app.post('/api/loads/move', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const { scope, poId, loadId, newDate, reason } = req.body;
  if (!newDate) return res.status(400).json({ error: 'New date is required' });
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'Reason is required' });

  let toMove = [];
  if (scope === 'single') {
    if (!loadId) return res.status(400).json({ error: 'loadId required for single move' });
    const l = store.loads.find(x => x.id === loadId);
    if (!l) return res.status(404).json({ error: 'Load not found' });
    toMove = [l];
  } else if (scope === 'po' || scope === 'remaining') {
    if (!poId) return res.status(400).json({ error: 'poId required' });
    let candidates = store.loads.filter(l => l.poId === poId && !l.voided);
    if (scope === 'remaining') {
      candidates = candidates.filter(l =>
        l.approvalStatus !== 'approved' &&
        l.approvalStatus !== 'submitted' &&
        l.billStatus !== 'billed' &&
        l.status !== 'completed'
      );
    }
    toMove = candidates;
  } else {
    return res.status(400).json({ error: 'Invalid scope' });
  }

  if (!toMove.length) return res.status(400).json({ error: 'No eligible loads to move' });

  const movable = toMove.filter(l => !l.locked);
  const skipped = toMove.length - movable.length;

  if (!movable.length) return res.status(400).json({ error: 'All eligible loads are locked (approved or billed)' });

  const movedAt = new Date().toISOString();
  const movedBy = req.session.user.username;

  movable.forEach(l => {
    const fromDate = l.deliveryDate;
    if (!l.originalScheduledDate) l.originalScheduledDate = fromDate;
    l.moveHistory = l.moveHistory || [];
    l.moveHistory.push({ from: fromDate, to: newDate, reason: reason.trim(), movedBy, movedAt, scope });
    l.deliveryDate = newDate;
  });

  if (scope === 'po' && poId) {
    const po = store.pos.find(p => p.id === poId);
    if (po) {
      if (!po.originalDeliveryDate) po.originalDeliveryDate = po.deliveryDate;
      po.deliveryDate = newDate;
      po.poMoveHistory = po.poMoveHistory || [];
      po.poMoveHistory.push({ from: po.originalDeliveryDate, to: newDate, reason: reason.trim(), movedBy, movedAt });
      if (po.status === 'completed') po.status = 'active';
    }
  }

  const targetPo = store.pos.find(p => p.id === poId);
  logAction(req.session.user, 'moved-loads', loadId || poId, {
    scope, newDate, reason: reason.trim(),
    poNumber:  targetPo?.poNumber || '',
    customer:  targetPo?.customer || '',
    moved:     movable.length,
    skipped,
  }, store);

  await saveData();
  res.json({ success: true, moved: movable.length, skipped, newDate, loadIds: movable.map(l => l.id) });
});

// ── API: VENDORS & PRICING ───────────────────────────────────────────────────
app.get('/api/vendors', reqMgr, (req, res) => {
  const store = req.store;
  res.json({ vendors: store.vendors, vendorPrices: store.vendorPrices });
});

app.post('/api/vendors', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const { name, location } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || ('vendor-' + Date.now());
  if (store.vendors.find(v => v.id === id)) return res.status(400).json({ error: 'A vendor with that name already exists' });
  const newVendor = { id, name: name.trim(), location: (location || '').trim(), active: true };
  store.vendors.push(newVendor);
  store.vendorPrices[id] = [];
  logAction(req.session.user, 'created-vendor', id, { name: newVendor.name }, store);
  await saveData();
  res.json({ success: true, vendor: newVendor });
});

app.put('/api/vendors/:id', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const v = store.vendors.find(x => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  const before = { name: v.name, location: v.location, active: v.active };
  if (req.body.name !== undefined)     v.name = String(req.body.name).trim();
  if (req.body.location !== undefined) v.location = String(req.body.location).trim();
  if (req.body.active !== undefined)   v.active = !!req.body.active;
  logAction(req.session.user, 'updated-vendor', v.id, { name: v.name, changes: Object.keys(req.body), before }, store);
  await saveData();
  res.json({ success: true, vendor: v });
});

app.delete('/api/vendors/:id', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const id = req.params.id;
  const idx = store.vendors.findIndex(v => v.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const inUse = store.loads.some(l => l.vendorId === id && !l.voided);
  if (inUse) return res.status(400).json({ error: 'Cannot delete — there are loads using this vendor. Mark inactive instead.' });
  const deleted = store.vendors[idx];
  store.vendors.splice(idx, 1);
  delete store.vendorPrices[id];
  logAction(req.session.user, 'deleted-vendor', id, { name: deleted.name }, store);
  await saveData();
  res.json({ success: true });
});

app.post('/api/vendors/:id/prices', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const v = store.vendors.find(x => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Vendor not found' });
  const { material, unit, price, notes } = req.body;
  if (!material || !material.trim()) return res.status(400).json({ error: 'Material required' });
  if (!store.vendorPrices[v.id]) store.vendorPrices[v.id] = [];
  if (store.vendorPrices[v.id].some(p => p.material === material.trim() && (p.unit || '') === (unit || ''))) {
    return res.status(400).json({ error: 'That material already exists for this vendor' });
  }
  const newPrice = {
    id: 'price-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    material: material.trim(),
    unit: (unit || '').trim(),
    price: Number(price) || 0,
    active: true,
    notes: (notes || '').trim(),
  };
  store.vendorPrices[v.id].push(newPrice);
  logAction(req.session.user, 'added-price', v.id + ':' + newPrice.id, {
    vendorName: v.name, material: newPrice.material, unit: newPrice.unit, price: newPrice.price,
  }, store);
  await saveData();
  res.json({ success: true, price: newPrice });
});

app.put('/api/vendors/:id/prices/:priceId', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const list = store.vendorPrices[req.params.id];
  if (!list) return res.status(404).json({ error: 'Vendor not found' });
  const p = list.find(x => x.id === req.params.priceId);
  if (!p) return res.status(404).json({ error: 'Price not found' });
  const v = store.vendors.find(x => x.id === req.params.id);
  const before = { material: p.material, unit: p.unit, price: p.price, active: p.active };
  if (req.body.material !== undefined) p.material = String(req.body.material).trim();
  if (req.body.unit !== undefined)     p.unit     = String(req.body.unit).trim();
  if (req.body.price !== undefined)    p.price    = Number(req.body.price) || 0;
  if (req.body.active !== undefined)   p.active   = !!req.body.active;
  if (req.body.notes !== undefined)    p.notes    = String(req.body.notes).trim();
  const priceChanged = req.body.price !== undefined && Number(req.body.price) !== before.price;
  if (priceChanged || req.body.active !== undefined) {
    logAction(req.session.user, 'edited-price', req.params.id + ':' + p.id, {
      vendorName: v?.name || req.params.id, material: p.material, unit: p.unit,
      before: { price: before.price, active: before.active },
      after:  { price: p.price, active: p.active },
    }, store);
  }
  await saveData();
  res.json({ success: true, price: p });
});

app.delete('/api/vendors/:id/prices/:priceId', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const list = store.vendorPrices[req.params.id];
  if (!list) return res.status(404).json({ error: 'Vendor not found' });
  const idx = list.findIndex(x => x.id === req.params.priceId);
  if (idx === -1) return res.status(404).json({ error: 'Price not found' });
  const deleted = list[idx];
  const v = store.vendors.find(x => x.id === req.params.id);
  list.splice(idx, 1);
  logAction(req.session.user, 'deleted-price', req.params.id + ':' + deleted.id, {
    vendorName: v?.name || req.params.id, material: deleted.material, price: deleted.price,
  }, store);
  await saveData();
  res.json({ success: true });
});

// ── API: AUDIT LOG ───────────────────────────────────────────────────────────
app.get('/api/audit-log', reqMgr, (req, res) => {
  const store = req.store;
  const { user, action, since, until } = req.query;
  const limit = Math.min(Number(req.query.limit) || 500, 2000);

  let entries = (store.auditLog || []).slice();

  if (user)   entries = entries.filter(e => e.user === user);
  if (action) entries = entries.filter(e => e.action === action);
  if (since)  entries = entries.filter(e => e.at >= since);
  if (until)  entries = entries.filter(e => e.at <= (until + 'T23:59:59'));

  entries.reverse();
  const total = entries.length;
  entries = entries.slice(0, limit);

  const userMap = {};
  (store.auditLog || []).forEach(e => {
    if (e.user && !userMap[e.user]) userMap[e.user] = e.displayName || e.user;
  });
  const allUsers = Object.entries(userMap)
    .map(([username, displayName]) => ({ username, displayName }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const allActions = [...new Set((store.auditLog || []).map(e => e.action))].sort();

  res.json({ entries, total, allUsers, allActions });
});

// ── API: CUSTOMER MASTER ────────────────────────────────────────────────────
app.get('/api/customers', reqMgr, (req, res) => {
  const store = req.store;
  const customers = (store.customers || []).slice().sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''))
  );
  const annotated = customers.map(c => {
    const lc = String(c.name || '').toLowerCase().trim();
    const poCount = store.pos.filter(p => String(p.customer || '').toLowerCase().trim() === lc).length;
    const priceCount = (store.customerPrices?.[lc] || []).length;
    return { ...c, poCount, priceCount };
  });
  res.json({ customers: annotated });
});

app.post('/api/customers', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const { name, code, address, city, phone, email, notes } = req.body;
  const trimmed = String(name || '').trim();
  if (!trimmed) return res.status(400).json({ error: 'Customer name required' });
  const lc = trimmed.toLowerCase();
  if ((store.customers || []).some(c => String(c.name || '').toLowerCase().trim() === lc)) {
    return res.status(400).json({ error: 'A customer with that name already exists' });
  }
  const newCust = {
    id: 'cust-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
    name: trimmed,
    code:    String(code    || '').trim(),
    address: String(address || '').trim(),
    city:    String(city    || '').trim(),
    phone:   String(phone   || '').trim(),
    email:   String(email   || '').trim(),
    notes:   String(notes   || '').trim(),
    active:  true,
    createdAt: new Date().toISOString(),
  };
  store.customers.push(newCust);
  logAction(req.session.user, 'created-customer', newCust.id, { name: newCust.name }, store);
  await saveData();
  res.json({ success: true, customer: newCust });
});

app.put('/api/customers/:id', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const c = (store.customers || []).find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  const oldName = c.name;
  const newName = req.body.name !== undefined ? String(req.body.name).trim() : c.name;
  if (newName.toLowerCase() !== c.name.toLowerCase()) {
    if ((store.customers || []).some(x => x.id !== c.id && String(x.name || '').toLowerCase().trim() === newName.toLowerCase())) {
      return res.status(400).json({ error: 'Another customer already has that name' });
    }
    if (!newName) return res.status(400).json({ error: 'Customer name required' });
  }
  c.name = newName;
  if (req.body.code    !== undefined) c.code    = String(req.body.code    || '').trim();
  if (req.body.address !== undefined) c.address = String(req.body.address || '').trim();
  if (req.body.city    !== undefined) c.city    = String(req.body.city    || '').trim();
  if (req.body.phone   !== undefined) c.phone   = String(req.body.phone   || '').trim();
  if (req.body.email   !== undefined) c.email   = String(req.body.email   || '').trim();
  if (req.body.notes   !== undefined) c.notes   = String(req.body.notes   || '').trim();
  if (req.body.active  !== undefined) c.active  = !!req.body.active;
  if (newName !== oldName) {
    let renamed = 0;
    store.pos.forEach(p => {
      if (String(p.customer || '').toLowerCase().trim() === oldName.toLowerCase().trim()) {
        p.customer = newName;
        if (p.job === oldName) p.job = newName;
        renamed++;
      }
    });
    (store.archive || []).forEach(b => {
      (b.pos || []).forEach(p => {
        if (String(p.customer || '').toLowerCase().trim() === oldName.toLowerCase().trim()) {
          p.customer = newName;
          if (p.job === oldName) p.job = newName;
        }
      });
    });
    const oldKey = oldName.toLowerCase().trim();
    const newKey = newName.toLowerCase().trim();
    if (oldKey !== newKey && store.customerPrices?.[oldKey]) {
      store.customerPrices[newKey] = (store.customerPrices[newKey] || []).concat(store.customerPrices[oldKey]);
      delete store.customerPrices[oldKey];
    }
    logAction(req.session.user, 'renamed-customer', c.id, { from: oldName, to: newName, posUpdated: renamed }, store);
  } else {
    logAction(req.session.user, 'updated-customer', c.id, { name: c.name, changes: Object.keys(req.body) }, store);
  }
  await saveData();
  res.json({ success: true, customer: c });
});

app.delete('/api/customers/:id', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const idx = (store.customers || []).findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Customer not found' });
  const c = store.customers[idx];
  const lc = String(c.name || '').toLowerCase().trim();
  const linkedPos = store.pos.filter(p => String(p.customer || '').toLowerCase().trim() === lc).length;
  if (linkedPos > 0) {
    return res.status(403).json({ error: `Cannot delete — ${linkedPos} active PO${linkedPos===1?'':'s'} reference this customer. Mark inactive instead.` });
  }
  store.customers.splice(idx, 1);
  if (store.customerPrices?.[lc]) delete store.customerPrices[lc];
  logAction(req.session.user, 'deleted-customer', c.id, { name: c.name }, store);
  await saveData();
  res.json({ success: true });
});

// ── API: CUSTOMER PRICING ────────────────────────────────────────────────────
app.get('/api/customer-prices', reqMgr, (req, res) => {
  const store = req.store;
  const customers = Object.entries(store.customerPrices || {})
    .map(([key, prices]) => {
      const samplePo = store.pos.find(p => customerKey(p.customer) === key);
      const displayName = samplePo?.customer || key;
      return { key, displayName, prices };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const allPoCustomers = [...new Set(store.pos.map(p => p.customer).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  res.json({ customers, allPoCustomers, defaultRates: store.defaultRates });
});

app.post('/api/customer-prices', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const { customer, material, unit, price, notes } = req.body;
  if (!customer || !customer.trim()) return res.status(400).json({ error: 'Customer name required' });
  if (!material || !material.trim()) return res.status(400).json({ error: 'Material required' });

  const key = customerKey(customer);
  if (!Array.isArray(store.customerPrices[key])) store.customerPrices[key] = [];

  if (store.customerPrices[key].some(p => p.material === material.trim() && (p.unit || '') === (unit || ''))) {
    return res.status(400).json({ error: 'That material already has a price for this customer' });
  }
  const newPrice = {
    id: 'cprice-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    material: material.trim(),
    unit: (unit || 'ton').trim(),
    price: Number(price) || 0,
    active: true,
    notes: (notes || '').trim(),
  };
  store.customerPrices[key].push(newPrice);
  logAction(req.session.user, 'added-customer-price', key + ':' + newPrice.id, {
    customer: customer.trim(), material: newPrice.material, unit: newPrice.unit, price: newPrice.price,
  }, store);
  await saveData();
  res.json({ success: true, price: newPrice, customer: customer.trim() });
});

app.put('/api/customer-prices/:customerKey/:priceId', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const list = store.customerPrices[req.params.customerKey];
  if (!list) return res.status(404).json({ error: 'Customer not found' });
  const p = list.find(x => x.id === req.params.priceId);
  if (!p) return res.status(404).json({ error: 'Price not found' });

  const before = { material: p.material, unit: p.unit, price: p.price, active: p.active };
  if (req.body.material !== undefined) p.material = String(req.body.material).trim();
  if (req.body.unit !== undefined)     p.unit     = String(req.body.unit).trim();
  if (req.body.price !== undefined)    p.price    = Number(req.body.price) || 0;
  if (req.body.active !== undefined)   p.active   = !!req.body.active;
  if (req.body.notes !== undefined)    p.notes    = String(req.body.notes).trim();

  const priceChanged = req.body.price !== undefined && Number(req.body.price) !== before.price;
  if (priceChanged || req.body.active !== undefined) {
    logAction(req.session.user, 'edited-customer-price', req.params.customerKey + ':' + p.id, {
      customerKey: req.params.customerKey, material: p.material,
      before: { price: before.price, active: before.active },
      after:  { price: p.price, active: p.active },
    }, store);
  }
  await saveData();
  res.json({ success: true, price: p });
});

app.delete('/api/customer-prices/:customerKey/:priceId', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const list = store.customerPrices[req.params.customerKey];
  if (!list) return res.status(404).json({ error: 'Customer not found' });
  const idx = list.findIndex(x => x.id === req.params.priceId);
  if (idx === -1) return res.status(404).json({ error: 'Price not found' });
  const deleted = list[idx];
  list.splice(idx, 1);
  if (list.length === 0) delete store.customerPrices[req.params.customerKey];
  logAction(req.session.user, 'deleted-customer-price', req.params.customerKey + ':' + deleted.id, {
    customerKey: req.params.customerKey, material: deleted.material, price: deleted.price,
  }, store);
  await saveData();
  res.json({ success: true });
});

// ── API: DEFAULT RATES (admin-only) ─────────────────────────────────────────
app.get('/api/default-rates', reqMgr, (req, res) => {
  const store = req.store;
  res.json({ defaultRates: store.defaultRates, materials: MATERIALS });
});

app.put('/api/default-rates', reqAdmin, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const { side, material, unit, price } = req.body;
  if (!['customer', 'vendor'].includes(side)) return res.status(400).json({ error: 'Invalid side' });
  if (!material) return res.status(400).json({ error: 'Material required' });
  if (!store.defaultRates[side]) store.defaultRates[side] = {};
  const before = store.defaultRates[side][material] ? { ...store.defaultRates[side][material] } : null;
  store.defaultRates[side][material] = {
    unit: (unit || 'ton').trim(),
    price: Number(price) || 0,
  };
  logAction(req.session.user, 'edited-default-rate', side + ':' + material, {
    side, material, before, after: store.defaultRates[side][material],
  }, store);
  await saveData();
  res.json({ success: true, defaultRates: store.defaultRates });
});

// ── API: PRICING PREVIEW ─────────────────────────────────────────────────────
app.get('/api/pricing-preview', reqMgr, (req, res) => {
  const store = req.store;
  const { customer, material, vendorId } = req.query;
  if (!customer || !material) return res.status(400).json({ error: 'customer and material required' });

  const cust = resolveCustomerRate(customer, material, store);
  const vend = resolveVendorRate(vendorId || '', material, store);
  const tons = TONS_PER_LOAD;

  const revPerLoad  = cust.unit === 'load' ? cust.price : cust.price * tons;
  const costPerLoad = vend.unit === 'load' ? vend.price : vend.price * tons;
  const marginPerLoad = revPerLoad - costPerLoad;

  res.json({
    customer: { rate: cust.price, unit: cust.unit, isDefault: cust.isDefault, perLoad: revPerLoad },
    vendor:   { rate: vend.price, unit: vend.unit, isDefault: vend.isDefault, isInternal: vend.isInternal || false, perLoad: costPerLoad },
    margin:   { perLoad: marginPerLoad, percent: revPerLoad > 0 ? (marginPerLoad / revPerLoad * 100) : 0 },
    tonsPerLoad: tons,
  });
});

// ── API: DURATION ANALYTICS ──────────────────────────────────────────────────
app.get('/api/duration-analytics', reqMgr, (req, res) => {
  const store = req.store;
  const { from, to, driver, yard, customer, city, material, po, status } = req.query;

  const archivedLoads = (store.archive || []).flatMap(b => b.loads || []);
  const allLoads = [...store.loads, ...archivedLoads];
  const lcEq = (a, b) => String(a || '').toLowerCase().trim() === String(b || '').toLowerCase().trim();

  const matched = allLoads.filter(l => {
    if (l.voided) return false;
    const poRow = store.pos.find(p => p.id === l.poId)
              || (store.archive || []).flatMap(b => b.pos || []).find(p => p.id === l.poId)
              || {};
    if (from && (l.deliveryDate || '') < from) return false;
    if (to   && (l.deliveryDate || '') > to)   return false;
    if (driver   && l.truckId !== driver)                                 return false;
    if (yard     && (l.actualYardId || l.vendorId) !== yard)              return false;
    if (customer && !lcEq(poRow.customer, customer))                      return false;
    if (city     && !lcEq(poRow.city, city))                              return false;
    if (material && l.material !== material)                              return false;
    if (po       && poRow.poNumber !== po)                                return false;
    if (status   && (l.approvalStatus || 'pending') !== status)           return false;
    return true;
  });

  const durationsForLoad = (l) => {
    const iso = l.isoStamps || {};
    const ts  = l.timestamps || {};
    const baseDate = l.deliveryDate || '';

    const at = (key) => {
      if (iso[key]) return new Date(iso[key]);
      if (ts[key] && baseDate) {
        const m = String(ts[key]).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
        if (m) {
          let h = Number(m[1]); const mn = Number(m[2]); const ap = (m[3] || '').toUpperCase();
          if (ap === 'PM' && h < 12) h += 12;
          if (ap === 'AM' && h === 12) h = 0;
          return new Date(`${baseDate}T${String(h).padStart(2,'0')}:${String(mn).padStart(2,'0')}:00`);
        }
      }
      return null;
    };

    const diff = (a, b) => {
      if (!a || !b) return null;
      let d = (b - a) / 60000;
      if (d < 0 && d > -1440 && !iso[Object.keys(iso)[0]]) d += 1440;
      return d > 0 ? Math.round(d * 10) / 10 : null;
    };

    const start          = at('start');
    const arrivedPickup  = at('arrivedPickup');
    const loadedAt       = at('loadedAt');
    const arrivedJobsite = at('arrivedJobsite');
    const completed      = at('completed');

    return {
      startToYard:    diff(start, arrivedPickup),
      yardService:    diff(arrivedPickup, loadedAt),
      yardToJobsite:  diff(loadedAt, arrivedJobsite),
      jobsiteService: diff(arrivedJobsite, completed),
      total:          diff(start, completed),
    };
  };

  const stats = (nums) => {
    const xs = nums.filter(n => typeof n === 'number' && isFinite(n));
    if (!xs.length) return { count: 0, avg: null, median: null, p90: null, min: null, max: null };
    const sorted = [...xs].sort((a, b) => a - b);
    const sum = xs.reduce((s, x) => s + x, 0);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    return {
      count: xs.length,
      avg:    Math.round(sum / xs.length * 10) / 10,
      median: pct(0.5),
      p90:    pct(0.9),
      min:    sorted[0],
      max:    sorted[sorted.length - 1],
    };
  };

  const groupBy = (keyFn, labelFn = (k) => k) => {
    const buckets = new Map();
    matched.forEach(l => {
      const k = keyFn(l);
      if (!k) return;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(durationsForLoad(l));
    });
    const out = [];
    for (const [k, arr] of buckets.entries()) {
      out.push({
        key: k,
        label: labelFn(k),
        loads: arr.length,
        startToYard:    stats(arr.map(d => d.startToYard)),
        yardService:    stats(arr.map(d => d.yardService)),
        yardToJobsite:  stats(arr.map(d => d.yardToJobsite)),
        jobsiteService: stats(arr.map(d => d.jobsiteService)),
        total:          stats(arr.map(d => d.total)),
      });
    }
    return out;
  };

  const yardLabel = (id) => {
    const v = store.vendors.find(x => x.id === id);
    return v ? v.name : id;
  };
  const truckLabel = (id) => {
    const t = TRUCKS.find(x => x.id === id);
    return t ? t.label : id;
  };

  const poFor = (l) =>
    store.pos.find(p => p.id === l.poId)
    || (store.archive || []).flatMap(b => b.pos || []).find(p => p.id === l.poId)
    || {};

  const byYard     = groupBy(l => l.actualYardId || l.vendorId, yardLabel);
  const byCustomer = groupBy(l => poFor(l).customer || '', x => x);
  const byJobCode  = groupBy(l => poFor(l).jobCode  || '', x => x || '(no job code)');
  const byCity     = groupBy(l => poFor(l).city     || '', x => x || '(no city)');
  const byMaterial = groupBy(l => l.material || '', x => x);
  const byDriver   = groupBy(l => l.truckId || '',  truckLabel);

  const yardsWithEnough = byYard.filter(g => g.yardService.count >= 3);
  const slowestYards = [...yardsWithEnough].sort((a, b) => (b.yardService.avg || 0) - (a.yardService.avg || 0)).slice(0, 5);
  const fastestYards = [...yardsWithEnough].sort((a, b) => (a.yardService.avg || 0) - (b.yardService.avg || 0)).slice(0, 5);
  const slowestJobsites = byCustomer
    .filter(g => g.jobsiteService.count >= 3)
    .sort((a, b) => (b.jobsiteService.avg || 0) - (a.jobsiteService.avg || 0))
    .slice(0, 5);

  const all = matched.map(durationsForLoad);
  const overall = {
    matchedLoads: matched.length,
    startToYard:    stats(all.map(d => d.startToYard)),
    yardService:    stats(all.map(d => d.yardService)),
    yardToJobsite:  stats(all.map(d => d.yardToJobsite)),
    jobsiteService: stats(all.map(d => d.jobsiteService)),
    total:          stats(all.map(d => d.total)),
  };

  res.json({
    overall,
    byYard, byCustomer, byJobCode, byCity, byMaterial, byDriver,
    slowestYards, fastestYards, slowestJobsites,
  });
});

// ── API: PROFITABILITY ───────────────────────────────────────────────────────
app.get('/api/profitability', reqMgr, (req, res) => {
  const store = req.store;
  const monthFilter = req.query.month || '';

  const archivedLoads = (store.archive || []).flatMap(b => b.loads || []);
  const allLoads = [...store.loads, ...archivedLoads];
  const allPos   = [...store.pos,   ...((store.archive || []).flatMap(b => b.pos || []))];

  let eligible = allLoads.filter(l => {
    if (l.voided) return false;
    if (Number(l.loadsDelivered || 0) <= 0) return false;
    if (monthFilter && !(l.deliveryDate || '').startsWith(monthFilter)) return false;
    return true;
  });

  const byCustomer = {};
  const byJobCode  = {};
  const byVendor   = {};
  const topLoads   = [];
  let grandRev = 0, grandCost = 0, grandLoads = 0;

  eligible.forEach(l => {
    const po = allPos.find(p => p.id === l.poId) || {};
    const rev    = computeRevenue(l);
    const cost   = computeCost(l);
    const margin = rev - cost;

    grandRev   += rev;
    grandCost  += cost;
    grandLoads += Number(l.loadsDelivered) || 0;

    const custKey = customerKey(po.customer || '');
    if (custKey) {
      if (!byCustomer[custKey]) byCustomer[custKey] = { displayName: po.customer, loads: 0, revenue: 0, cost: 0, margin: 0 };
      byCustomer[custKey].loads   += Number(l.loadsDelivered) || 0;
      byCustomer[custKey].revenue += rev;
      byCustomer[custKey].cost    += cost;
      byCustomer[custKey].margin  += margin;
    }

    if (po.jobCode) {
      const jcKey = po.jobCode;
      if (!byJobCode[jcKey]) byJobCode[jcKey] = { jobCode: po.jobCode, customer: po.customer || '', loads: 0, revenue: 0, cost: 0, margin: 0 };
      byJobCode[jcKey].loads   += Number(l.loadsDelivered) || 0;
      byJobCode[jcKey].revenue += rev;
      byJobCode[jcKey].cost    += cost;
      byJobCode[jcKey].margin  += margin;
    }

    const vId = l.actualYardId || l.vendorId || po.plannedVendorId;
    if (vId) {
      const v = store.vendors.find(x => x.id === vId);
      if (!byVendor[vId]) byVendor[vId] = {
        name: v?.name || vId,
        isInternal: vId === 'vbt',
        loads: 0, revenue: 0, cost: 0, margin: 0
      };
      byVendor[vId].loads   += Number(l.loadsDelivered) || 0;
      byVendor[vId].revenue += rev;
      byVendor[vId].cost    += cost;
      byVendor[vId].margin  += margin;
    }

    topLoads.push({
      id: l.id,
      poId: l.poId,
      poNumber: po.poNumber || '',
      customer: po.customer || '',
      jobCode:  po.jobCode  || '',
      material: l.material,
      driver:   l.driverName || '',
      delivered: Number(l.loadsDelivered) || 0,
      assigned:  Number(l.loadsAssigned)  || 0,
      isPartial: !!l.isPartial,
      vendorName: l.actualYardName || l.vendorName || '',
      vendorIsInternal: vId === 'vbt',
      deliveryDate: l.deliveryDate || '',
      revenue: rev,
      cost,
      margin,
      marginPct: rev > 0 ? (margin / rev * 100) : 0,
    });
  });

  const sortedByMargin = [...topLoads].sort((a, b) => b.margin - a.margin);
  const topByMargin = sortedByMargin.slice(0, 10);
  const bottomByMargin = sortedByMargin.slice(-10).reverse();

  const months = [...new Set(allLoads.map(l => (l.deliveryDate || '').slice(0, 7)).filter(Boolean))].sort().reverse();

  res.json({
    monthFilter,
    months,
    grand: {
      revenue: grandRev,
      cost: grandCost,
      margin: grandRev - grandCost,
      marginPct: grandRev > 0 ? ((grandRev - grandCost) / grandRev * 100) : 0,
      loads: grandLoads,
      loadCount: eligible.length,
    },
    byCustomer: Object.entries(byCustomer)
      .map(([k, v]) => ({ key: k, ...v, marginPct: v.revenue > 0 ? (v.margin / v.revenue * 100) : 0 }))
      .sort((a, b) => b.margin - a.margin),
    byJobCode: Object.entries(byJobCode)
      .map(([k, v]) => ({ key: k, ...v, marginPct: v.revenue > 0 ? (v.margin / v.revenue * 100) : 0 }))
      .sort((a, b) => b.margin - a.margin),
    byVendor: Object.entries(byVendor)
      .map(([k, v]) => ({ key: k, ...v, marginPct: v.revenue > 0 ? (v.margin / v.revenue * 100) : 0 }))
      .sort((a, b) => b.margin - a.margin),
    topByMargin,
    bottomByMargin,
  });
});

// ── API: VENDOR / MATERIAL COSTS ─────────────────────────────────────────────
app.get('/api/material-costs', reqMgr, (req, res) => {
  const store = req.store;
  const monthFilter = req.query.month || '';

  const eligible = store.loads.filter(l => {
    if (l.voided) return false;
    if (monthFilter && !(l.deliveryDate || '').startsWith(monthFilter)) return false;
    return true;
  });

  const byVendor = {};

  eligible.forEach(l => {
    const vendorId = l.actualYardId || l.vendorId || (store.pos.find(p => p.id === l.poId) || {}).plannedVendorId;
    if (!vendorId) return;
    if (vendorId === 'vbt') return;

    const v = store.vendors.find(x => x.id === vendorId);
    if (!v) return;

    if (!byVendor[vendorId]) {
      byVendor[vendorId] = { name: v.name, location: v.location, totalLoads: 0, totalCost: 0, byMaterial: {} };
    }
    const delivered = Number(l.loadsDelivered) || 0;
    if (delivered === 0) return;

    let unitPrice = 0;
    let unit = '';
    if (l.pricePerUnit !== undefined && l.pricePerUnit !== null) {
      unitPrice = Number(l.pricePerUnit) || 0;
      unit = l.unit || '';
    } else {
      const priceRow = (store.vendorPrices[vendorId] || []).find(p => p.material === l.material);
      if (priceRow) { unitPrice = priceRow.price; unit = priceRow.unit; }
    }

    const cost = delivered * unitPrice;
    byVendor[vendorId].totalLoads += delivered;
    byVendor[vendorId].totalCost  += cost;

    if (!byVendor[vendorId].byMaterial[l.material]) {
      byVendor[vendorId].byMaterial[l.material] = { loads: 0, cost: 0, unit, unitPrice };
    }
    byVendor[vendorId].byMaterial[l.material].loads += delivered;
    byVendor[vendorId].byMaterial[l.material].cost  += cost;
  });

  const months = [...new Set(store.loads.map(l => (l.deliveryDate || '').slice(0, 7)).filter(Boolean))].sort().reverse();

  const grandTotal = Object.values(byVendor).reduce((s, v) => s + v.totalCost, 0);
  const grandLoads = Object.values(byVendor).reduce((s, v) => s + v.totalLoads, 0);

  res.json({ vendors: byVendor, months, monthFilter, grandTotal, grandLoads });
});

// ── PO STATUS RECONCILIATION ─────────────────────────────────────────────────
function reconcilePoStatuses(s) {
  const fixed = [];
  s.pos.forEach(p => {
    const linked = s.loads.filter(l => l.poId === p.id && !l.voided);
    if (linked.length === 0) return;
    const allDone = linked.every(l =>
      l.status === 'completed' ||
      l.approvalStatus === 'approved' ||
      l.billStatus === 'billed'
    );
    const correctStatus = allDone
      ? 'completed'
      : (p.deliveryDate > todayStr() ? 'scheduled' : 'active');

    if (p.status !== correctStatus) {
      const before = p.status;
      p.status = correctStatus;
      if (correctStatus === 'completed' && !p.completedAt) p.completedAt = new Date().toISOString();
      fixed.push({ id: p.id, poNumber: p.poNumber, before, after: correctStatus });
    }
  });
  return fixed;
}

// ── API: REPORTS / FINANCE ───────────────────────────────────────────────────
app.get('/api/reports', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const fixed = reconcilePoStatuses(store);
  if (fixed.length) {
    console.log(`[reports] Reconciled ${fixed.length} stale PO statuses:`, fixed);
    await saveData();
  }

  const driverStats = {};
  TRUCKS.forEach(t => {
    const tLoads = store.loads.filter(l => l.truckId === t.id && !l.voided);
    driverStats[t.id] = {
      label: t.label,
      truckNum: t.truckNum,
      totalLoads: tLoads.reduce((s, l) => s + (Number(l.loadsAssigned) || 0), 0),
      delivered: tLoads.reduce((s, l) => s + (Number(l.loadsDelivered) || 0), 0),
      completed: tLoads.filter(l => l.status === 'completed').length,
      active:    tLoads.filter(l => l.status === 'active').length,
    };
  });

  const custStats = {};
  store.pos.forEach(p => {
    if (!custStats[p.customer]) custStats[p.customer] = { pos: 0, loads: 0, delivered: 0 };
    custStats[p.customer].pos++;
    const pLoads = store.loads.filter(l => l.poId === p.id);
    custStats[p.customer].loads     += pLoads.reduce((s, l) => s + (Number(l.loadsAssigned) || 0), 0);
    custStats[p.customer].delivered += pLoads.reduce((s, l) => s + (Number(l.loadsDelivered) || 0), 0);
  });

  const matStats = {};
  store.loads.forEach(l => {
    if (l.voided) return;
    if (!matStats[l.material]) matStats[l.material] = { ordered: 0, delivered: 0 };
    matStats[l.material].ordered   += Number(l.loadsAssigned) || 0;
    matStats[l.material].delivered += Number(l.loadsDelivered) || 0;
  });

  const weeks = [];
  for (let w = 7; w >= 0; w--) {
    const wStart = new Date();
    wStart.setDate(wStart.getDate() - w * 7 - wStart.getDay() + 1);
    wStart.setHours(0, 0, 0, 0);
    const wEnd = new Date(wStart);
    wEnd.setDate(wStart.getDate() + 6);
    const wStartStr = wStart.toISOString().slice(0, 10);
    const wEndStr   = wEnd.toISOString().slice(0, 10);
    const wLoads = store.loads.filter(l => l.deliveryDate >= wStartStr && l.deliveryDate <= wEndStr);
    weeks.push({
      label: wStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      ordered:   wLoads.reduce((s, l) => s + (Number(l.loadsAssigned) || 0), 0),
      delivered: wLoads.reduce((s, l) => s + (Number(l.loadsDelivered) || 0), 0),
    });
  }

  const billed = store.loads.filter(l => l.billStatus === 'billed' && !l.voided);
  const ready  = store.loads.filter(l => l.approvalStatus === 'approved' && l.billStatus === 'ready' && !l.voided);

  res.json({
    driverStats, custStats, matStats, weeks,
    totals: {
      activePOs:    store.pos.filter(p => p.status === 'active').length,
      scheduledPOs: store.pos.filter(p => p.status === 'scheduled').length,
      totalLoads:   store.loads.filter(l => !l.voided).length,
      readyToBill:  ready.length,
      billedThisMonth: billed.filter(l => (l.billedAt || '').startsWith(new Date().toISOString().slice(0, 7))).length,
    }
  });
});

// ── API: HISTORY ─────────────────────────────────────────────────────────────
app.get('/api/history', reqMgr, (req, res) => {
  const store = req.store;
  const billed = store.loads.filter(l => l.billStatus === 'billed' && !l.voided)
    .map(l => {
      const po = store.pos.find(p => p.id === l.poId) || {};
      return { ...l, poNumber: po.poNumber, customer: po.customer, city: po.city, address: po.address, pickup: po.pickup };
    });
  res.json({ billed, archive: store.archive });
});

app.post('/api/history/archive', reqMgr, async (req, res) => {
  const store = req.store;
  const saveData = req.saveStore;
  const billed = store.loads.filter(l => l.billStatus === 'billed' && !l.voided);
  if (!billed.length) return res.status(400).json({ error: 'No billed loads to archive' });

  const billedPoIds = new Set(billed.map(l => l.poId));
  const fullyBilledPos = [...billedPoIds].filter(pid => {
    const all = store.loads.filter(l => l.poId === pid && !l.voided);
    return all.length > 0 && all.every(l => l.billStatus === 'billed');
  });
  const archivedPos = store.pos.filter(p => fullyBilledPos.includes(p.id));

  let sheetSuccess = false;
  if (sheets) {
    try {
      const archiveRows = [['Archived At', 'PO', 'Customer', 'City', 'Material', 'Loads', 'Driver', 'Date', 'Yard', 'Approved By', 'Billed At']];
      billed.forEach(l => {
        const po = store.pos.find(p => p.id === l.poId) || {};
        archiveRows.push([
          new Date().toISOString(),
          po.poNumber || '', po.customer || '', po.city || '',
          l.material, l.loadsDelivered, l.driverName, l.deliveryDate,
          l.actualYardName || po.pickup || '',
          l.approvedBy || '', l.billedAt || ''
        ]);
      });
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'Archive!A1',
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: archiveRows },
      }).catch(async err => {
        if (String(err.message).includes('Unable to parse range')) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SHEET_ID,
            requestBody: { requests: [{ addSheet: { properties: { title: 'Archive' } } }] }
          }).catch(() => {});
          await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: 'Archive!A1',
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
            requestBody: { values: archiveRows },
          });
        } else { throw err; }
      });
      sheetSuccess = true;
    } catch (e) {
      console.error('Archive sync error:', e.message);
      return res.status(500).json({ error: 'Failed to push to Sheets: ' + e.message + '. Nothing was archived.' });
    }
  }

  const batchId = 'BATCH-' + Date.now();
  store.archive.unshift({
    batchId,
    archivedAt: new Date().toISOString(),
    archivedBy: req.session.user.username,
    poCount: archivedPos.length,
    loadCount: billed.length,
    syncedToSheet: sheetSuccess,
  });
  logAction(req.session.user, 'archived-batch', batchId, {
    poCount: archivedPos.length,
    loadCount: billed.length,
    syncedToSheet: sheetSuccess,
  }, store);
  if (store.archive.length > 50) store.archive = store.archive.slice(0, 50);

  const billedIds = new Set(billed.map(l => l.id));
  store.loads = store.loads.filter(l => !billedIds.has(l.id));
  store.pos   = store.pos.filter(p => !fullyBilledPos.includes(p.id));

  await saveData();
  res.json({
    success: true,
    archived: { pos: archivedPos.length, loads: billed.length, batchId, syncedToSheet: sheetSuccess }
  });
});

// ── API: GOOGLE SHEETS SYNC ──────────────────────────────────────────────────
const SHEET_ID = process.env.SHEET_ID || '1T5pOeXmLmZyKKfq4YRl9aymXn9MQnNrqmcuyJluMhQs';
let sheets = null;
try {
  if (fs.existsSync(path.join(__dirname, 'service-account.json'))) {
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({
      keyFile: path.join(__dirname, 'service-account.json'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheets = google.sheets({ version: 'v4', auth });
    console.log('✓ Google Sheets ready');
  }
} catch (e) { console.warn('Sheets init failed:', e.message); }

app.post('/api/sync', reqMgr, async (req, res) => {
  const store = req.store;
  if (!sheets) return res.status(503).json({ error: 'Sheets not configured' });
  try {
    const poRows = [['PO Number', 'Customer', 'Job', 'Address', 'City', 'Delivery Date', 'Status', 'Created']];
    store.pos.forEach(p => poRows.push([p.poNumber, p.customer, p.job, p.address, p.city, p.deliveryDate, p.status, p.createdAt]));
    await writeSheet('POs', poRows);

    const loadRows = [['Load ID', 'PO Number', 'Material', 'Driver', 'Truck', 'Loads Assigned', 'Loads Delivered', 'Date', 'Status', 'Approval', 'Bill Status', 'Submitted', 'Approved By']];
    store.loads.forEach(l => {
      const po = store.pos.find(p => p.id === l.poId) || {};
      loadRows.push([l.id, po.poNumber || '', l.material, l.driverName, l.truckId, l.loadsAssigned, l.loadsDelivered, l.deliveryDate, l.status, l.approvalStatus, l.billStatus, l.submittedAt, l.approvedBy]);
    });
    await writeSheet('Loads', loadRows);

    logAction(req.session.user, 'synced-sheets', '', {
      pos: store.pos.length,
      loads: store.loads.length,
    }, store);
    res.json({ success: true, pos: store.pos.length, loads: store.loads.length });
  } catch (e) {
    console.error('Sync error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

async function writeSheet(tab, rows) {
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] }
    });
  } catch (e) { /* tab already exists */ }
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${tab}!A:Z` });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });
}

// ── STARTUP ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
(async () => {
  await initPg();
  await loadAllStores();
  app.listen(PORT, () => {
    console.log(`VBT Dispatch on port ${PORT}`);
    console.log(`Companies loaded: ${Object.keys(stores).join(', ') || '(none)'}`);
  });
})();
