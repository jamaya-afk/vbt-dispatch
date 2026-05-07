// VBT Dispatch — Clean Build
// Core scope: Login, POs, Board, Driver guided flow, Approvals, Ready to Bill, Sheets sync
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const qb = require('./qb');

const app = express();
app.use(express.json({
  limit: '25mb',
  verify: (req, _res, buf) => { if (req.path === '/api/stripe/webhook') req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));

const IS_PROD = process.env.NODE_ENV === 'production';

// Hard-fail at boot in production if DATABASE_URL is missing — we never want
// to silently fall back to data.json on a Railway deploy and lose data.
if (IS_PROD && !process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is required in production.');
  process.exit(1);
}

// Feature flag: until per-company stores ship in Phase 2, keep public signup
// disabled so a new company can't log in and accidentally see the existing
// shared VBT data.
const SIGNUP_ENABLED = process.env.ENABLE_SIGNUP === 'true';

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

// ── SUPABASE STORAGE (for photo uploads — Phase 2) ──────────────────────────
const SUPABASE_URL    = process.env.SUPABASE_URL || '';
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'vbt-photos';
let supabaseEnabled = false;
let supabase = null;

// ── STRIPE (Phase 5 — disabled for now) ─────────────────────────────────────
// The Stripe checkout / portal / webhook routes were merged before the
// multi-tenant foundation that they depend on. They're left in place so the
// merge history reads cleanly, but they're behind these stubs so a
// ReferenceError can't crash a request handler. Stripe re-enables in Phase 5.
let stripe = null;
const STRIPE_PRICE_ID       = process.env.STRIPE_PRICE_ID || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_SUCCESS_URL    = process.env.STRIPE_SUCCESS_URL || '/app/';
const STRIPE_CANCEL_URL     = process.env.STRIPE_CANCEL_URL  || '/app/';
async function getSubscriptionStatus(_companyId) {
  // Until Stripe is wired up, every authenticated company is treated as
  // an active internal account so the dispatch UI keeps working.
  return { status: 'active', periodEnd: null };
}
function invalidateSubscriptionCache(_companyId) { /* no-op until Phase 5 */ }

// Per-company stores land in Phase 2. Declared here so /signup and any
// stragglers don't ReferenceError when they touch it.
let stores = {};
function makeEmptyStore() {
  return {
    pos: [], loads: [], archive: [],
    vendors: [], vendorPrices: {},
    customers: [], customerPrices: {},
    defaultRates: null,
    auditLog: [],
    nextPoNum: 1001,
    nextLoadId: 1,
  };
}
async function saveCompanyStore(_companyId) { /* no-op until Phase 2 */ }

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
  console.log('⚠ Supabase not configured — photo uploads will be rejected (no DB/file fallback by design)');
}

// Generate a strong random folder path so public URLs are unguessable
function randomKey(len = 16) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// Upload a base64 image to Supabase, return its public URL
async function uploadPhoto(kind, dataUrl, loadId) {
  console.log(`[uploadPhoto] called: kind=${kind}, loadId=${loadId}, supabaseEnabled=${supabaseEnabled}, bucket=${SUPABASE_BUCKET}`);

  if (!supabaseEnabled) {
    console.log('[uploadPhoto] Supabase not enabled, throwing');
    throw new Error('Supabase not configured');
  }
  if (!dataUrl || !dataUrl.startsWith('data:')) {
    console.log('[uploadPhoto] Invalid data URL');
    throw new Error('Invalid image data');
  }

  const match = dataUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/);
  if (!match) {
    console.log('[uploadPhoto] Bad format, dataUrl starts with:', dataUrl.slice(0, 50));
    throw new Error('Invalid data URL format');
  }
  const contentType = match[1];
  const base64 = match[2];
  const buffer = Buffer.from(base64, 'base64');
  console.log(`[uploadPhoto] parsed ${contentType}, buffer size: ${buffer.length} bytes`);

  const ext = contentType === 'image/png' ? 'png' : 'jpg';
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const folder = (kind === 'signature') ? 'signatures' : 'tickets';
  const path = `${folder}/${yyyy}/${mm}/${loadId || 'unknown'}-${randomKey(16)}.${ext}`;

  console.log(`[uploadPhoto] uploading to: bucket="${SUPABASE_BUCKET}", path="${path}"`);

  const { data: uploadData, error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .upload(path, buffer, { contentType, upsert: false });

  if (error) {
    console.error('[uploadPhoto] SUPABASE ERROR:', JSON.stringify(error, null, 2));
    console.error('[uploadPhoto] error.message:', error.message);
    console.error('[uploadPhoto] error.statusCode:', error.statusCode);
    throw new Error(`Supabase upload failed: ${error.message || JSON.stringify(error)}`);
  }
  console.log('[uploadPhoto] upload succeeded, data:', uploadData);

  const { data: urlData } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(path);
  console.log('[uploadPhoto] public URL:', urlData.publicUrl);
  return urlData.publicUrl;
}

// ── USERS & TRUCKS ───────────────────────────────────────────────────────────
// ── USERS ────────────────────────────────────────────────────────────────────
// Roles:
//   admin   — full access. Can manage pricing, delete records, archive, sync, everything.
//             Currently: Oscar, Perla, Joshua.
//   manager — reserved for future office staff (e.g. dispatcher hires) who do day-to-day
//             dispatch but shouldn't touch pricing or destructive actions. Unused for now.
//   driver  — locked-down mobile flow, sees only their own loads.
const USERS = {
  // Admins (full power)
  joshua:   { password: process.env.JOSHUA_PASS   || 'joshua123',  role: 'admin',   truckId: null,       displayName: 'Joshua'   },
  oscar:    { password: process.env.OSCAR_PASS    || 'oscar123',   role: 'admin',   truckId: null,       displayName: 'Oscar'    },
  perla:    { password: process.env.PERLA_PASS    || 'perla123',   role: 'admin',   truckId: null,       displayName: 'Perla'    },
  // Drivers
  beryle:   { password: process.env.BERYLE_PASS   || 'beryle123',  role: 'driver',  truckId: 'beryle',   displayName: 'Beryle'   },
  matthew:  { password: process.env.MATTHEW_PASS  || 'matthew123', role: 'driver',  truckId: 'matthew',  displayName: 'Matthew'  },
  rigo:     { password: process.env.RIGO_PASS     || 'rigo123',    role: 'driver',  truckId: 'rigo',     displayName: 'Rigo'     },
  leonardo: { password: process.env.LEONARDO_PASS || 'leo123',     role: 'driver',  truckId: 'leonardo', displayName: 'Leonardo' },
  carlos:   { password: process.env.CARLOS_PASS   || 'carlos123',  role: 'driver',  truckId: 'carlos',   displayName: 'Carlos'   },
};

const TRUCKS = [
  { id: 'beryle',   label: 'Beryle',   truckNum: 'Truck #2'  },
  { id: 'matthew',  label: 'Matthew',  truckNum: 'Truck #4'  },
  { id: 'rigo',     label: 'Rigo',     truckNum: 'Truck #14' },
  { id: 'leonardo', label: 'Leonardo', truckNum: 'Truck #12' },
  { id: 'carlos',   label: 'Carlos',   truckNum: 'Truck #2B' },
];

// Generic fallback materials list (for the "Other" vendor or legacy data)
const MATERIALS = ['Fill Sand','Gravel','Rock','3/4 Rock','Cold Mix','Recycle Base','Dirt','Base Rock','Other'];

// System constants
const TONS_PER_LOAD = 25;  // 1 truck load = 25 tons (per business rule from owner)

// System-wide default rates — used as fallback when a customer has no negotiated rate.
// Editable by admin in the Vendors & Prices → Default Rates tab.
// Both customer (revenue) and vendor (cost) defaults; per-material.
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

// Default vendors seeded the first time the app runs
// Each vendor has its own list of materials with unit/price/notes
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

// Default per-vendor prices (just a starting set — manager edits these)
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

// ── DATA STORE — Postgres primary, file backup ───────────────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');
let pg = null;
let store = {
  pos: [],
  loads: [],
  archive: [],
  vendors: [],          // [{ id, name, location, active }]
  vendorPrices: {},     // { vendorId: [{ id, material, unit, price, active, notes }] }
  customers: [],        // [{ id, name, code, address, city, phone, email, notes, active, createdAt }]
  customerPrices: {},   // { customerNameLower: [{ id, material, unit, price, active, notes }] }
  defaultRates: null,   // { customer: { mat: { unit, price } }, vendor: { mat: { unit, price } } }
  auditLog: [],         // [{ id, at, user, displayName, role, action, target, details }]
  nextPoNum: 1001,
  nextLoadId: 1,
};

// Default company every legacy VBT record belongs to. Phase 2 will add real
// per-company stores; for now, every existing PO/load/customer is logically
// owned by this company.
const DEFAULT_COMPANY_ID   = 'vbt';
const DEFAULT_COMPANY_NAME = 'Valley Best Trucking';
const DEFAULT_COMPANY_SLUG = 'vbt';

async function initPg() {
  if (!process.env.DATABASE_URL) {
    if (IS_PROD) {
      // Caught earlier at boot, but defensively re-fail here.
      console.error('FATAL: DATABASE_URL is required in production.');
      process.exit(1);
    }
    console.warn('⚠ No DATABASE_URL — dev mode, using file storage (data resets on redeploy!)');
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
      pg = sessionPool;  // reuse same pool
    }
    await pg.query('SELECT 1');
    await pg.query(`CREATE TABLE IF NOT EXISTS dispatch_data (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

    // Multi-tenant scaffolding tables. Created here so Phase 2 (per-company
    // stores) can layer on without another migration step.
    await pg.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id                      TEXT PRIMARY KEY,
        name                    TEXT NOT NULL,
        slug                    TEXT NOT NULL UNIQUE,
        active                  BOOLEAN NOT NULL DEFAULT true,
        plan                    TEXT NOT NULL DEFAULT 'trial',
        subscription_status     TEXT NOT NULL DEFAULT 'trialing',
        stripe_customer_id      TEXT,
        stripe_subscription_id  TEXT,
        current_period_end      TIMESTAMPTZ,
        trial_ends_at           TIMESTAMPTZ,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pg.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        username      TEXT NOT NULL,
        password      TEXT NOT NULL,
        role          TEXT NOT NULL,
        truck_id      TEXT,
        display_name  TEXT,
        active        BOOLEAN NOT NULL DEFAULT true,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (company_id, username)
      )
    `);
    console.log('✓ Postgres connected');
  } catch (e) {
    console.error('✗ Postgres connection failed:', e.message);
    if (IS_PROD) {
      console.error('FATAL: cannot start without database in production.');
      process.exit(1);
    }
    pg = null;
  }
}

// Idempotent: seed the default VBT company + migrate the hardcoded USERS map
// into the users table. Run after initPg(). Safe to call on every boot.
async function seedDefaultCompanyAndUsers() {
  if (!pg) return;
  try {
    await pg.query(`
      INSERT INTO companies (id, name, slug, active, plan, subscription_status)
      VALUES ($1, $2, $3, true, 'internal', 'active')
      ON CONFLICT (id) DO NOTHING
    `, [DEFAULT_COMPANY_ID, DEFAULT_COMPANY_NAME, DEFAULT_COMPANY_SLUG]);

    // Only seed the legacy USERS map on a brand-new database. After a
    // reset (scripts/reset-app.js) the admin rows still exist, so this
    // skips and the hardcoded drivers stay deleted instead of silently
    // re-appearing on the next boot.
    const userCount = await pg.query(
      'SELECT COUNT(*)::int AS c FROM users WHERE company_id = $1',
      [DEFAULT_COMPANY_ID]
    );
    if (userCount.rows[0].c > 0) {
      console.log(`✓ Default company "${DEFAULT_COMPANY_ID}" already has ${userCount.rows[0].c} user(s) — skipping legacy seed`);
      return;
    }

    for (const [uname, u] of Object.entries(USERS)) {
      const userId = `user-${DEFAULT_COMPANY_ID}-${uname}`;
      await pg.query(`
        INSERT INTO users (id, company_id, username, password, role, truck_id, display_name, active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, true)
        ON CONFLICT (company_id, username) DO NOTHING
      `, [userId, DEFAULT_COMPANY_ID, uname, u.password, u.role, u.truckId || null, u.displayName || uname]);
    }
    console.log(`✓ Seeded default company "${DEFAULT_COMPANY_ID}" + ${Object.keys(USERS).length} legacy users`);
  } catch (e) {
    console.error('✗ Seed default company/users failed:', e.message);
    // Don't crash — legacy hardcoded login will still work.
  }
}

async function loadData() {
  // Postgres first
  if (pg) {
    try {
      const r = await pg.query("SELECT value FROM dispatch_data WHERE key='store'");
      if (r.rows.length) {
        store = JSON.parse(r.rows[0].value);
        normalizeStore();
        console.log(`✓ Loaded from Postgres: ${store.pos.length} POs, ${store.loads.length} loads`);
        return;
      }
    } catch (e) { console.error('PG read error:', e.message); }
  }
  // File fallback — DEV ONLY. In production we hard-fail above instead of
  // silently using ephemeral disk that resets on every Railway redeploy.
  if (!IS_PROD && fs.existsSync(DATA_FILE)) {
    try {
      store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      normalizeStore();
      console.log(`✓ Loaded from file: ${store.pos.length} POs`);
      if (pg) { await saveData(); console.log('✓ Migrated file data to Postgres'); }
      return;
    } catch (e) { console.warn('File read error:', e.message); }
  }
  // Nothing loaded — still normalize so the seed defaults (trucks, vendors,
  // etc.) populate even on a brand-new database.
  normalizeStore();
}

async function saveData() {
  const j = JSON.stringify(store);
  if (pg) {
    try {
      await pg.query(
        "INSERT INTO dispatch_data(key,value) VALUES('store',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
        [j]
      );
      return;
    } catch (e) {
      console.error('PG write error:', e.message);
      // In prod, never fall back to local disk — the next deploy will wipe it.
      if (IS_PROD) throw e;
    }
  }
  if (!IS_PROD) {
    try { fs.writeFileSync(DATA_FILE, j); } catch (e) {}
  }
}

// Ensure all loads have required fields (backward compat for old data)
function normalizeStore() {
  if (!store.pos)     store.pos = [];
  if (!store.loads)   store.loads = [];
  if (!store.archive) store.archive = [];
  if (!Array.isArray(store.auditLog)) store.auditLog = [];
  if (!store.customerPrices || typeof store.customerPrices !== 'object') store.customerPrices = {};
  if (!store.defaultRates || typeof store.defaultRates !== 'object') {
    store.defaultRates = JSON.parse(JSON.stringify(DEFAULT_RATES));
  }
  // ONE-TIME wipe: starting fresh with named user accounts.
  // After first run with auditLogResetV1=true, this block does nothing.
  if (!store.auditLogResetV1) {
    if (store.auditLog.length > 0) {
      console.log(`[normalize] Wiping ${store.auditLog.length} legacy audit entries (pre-named-accounts)`);
    }
    store.auditLog = [];
    store.auditLogResetV1 = true;
  }
  // Seed vendors only if missing (preserves user edits)
  if (!Array.isArray(store.vendors) || store.vendors.length === 0) {
    store.vendors = JSON.parse(JSON.stringify(DEFAULT_VENDORS));
  }
  if (!store.vendorPrices || typeof store.vendorPrices !== 'object') {
    store.vendorPrices = JSON.parse(JSON.stringify(DEFAULT_VENDOR_PRICES));
  } else {
    // Make sure every existing vendor has an entry (even if empty)
    store.vendors.forEach(v => {
      if (!Array.isArray(store.vendorPrices[v.id])) store.vendorPrices[v.id] = [];
    });
  }
  if (!store.nextPoNum)  store.nextPoNum = 1001;
  if (!store.nextLoadId) store.nextLoadId = 1;

  // Trucks: seeded from the legacy TRUCKS constant on first boot, then
  // edited via the Fleet admin UI. Each truck's id is also the driver's
  // username for backward compatibility with existing loads.
  if (!Array.isArray(store.trucks) || store.trucks.length === 0) {
    store.trucks = JSON.parse(JSON.stringify(TRUCKS));
  }
  store.trucks.forEach(t => {
    if (t.active === undefined) t.active = true;
  });

  store.loads.forEach(l => {
    if (!l.timestamps)     l.timestamps = {};
    if (!l.gps)            l.gps = {};
    if (!l.pod)            l.pod = { signedBy: '', signature: '', signedAt: '' };
    if (!l.approvalStatus) l.approvalStatus = l.status === 'completed' ? 'approved' : 'pending';
    if (!l.billStatus)     l.billStatus = 'not-ready';
    if (!l.ticketImage)    l.ticketImage = '';
    if (l.locked === undefined) l.locked = false;
    if (l.voided === undefined) l.voided = false;
    if (l.loadsDelivered === undefined) l.loadsDelivered = 0;
    // Date-move tracking
    if (!l.originalScheduledDate) l.originalScheduledDate = l.deliveryDate;
    if (!Array.isArray(l.moveHistory)) l.moveHistory = [];
  });
  store.pos.forEach(p => {
    if (!p.materials) p.materials = [];
  });

  // Customer master list — backfill from existing PO customer names so the
  // dropdown is populated on first deploy. This runs only when there's no
  // master list yet; once it exists, manager edits via /api/customers stay.
  if (!Array.isArray(store.customers)) store.customers = [];
  if (store.customers.length === 0 && store.pos.length > 0) {
    const seen = new Map();  // lowercased name → preserve first-seen casing
    store.pos.forEach(p => {
      const name = (p.customer || '').trim();
      if (!name) return;
      const k = name.toLowerCase();
      if (!seen.has(k)) seen.set(k, name);
    });
    seen.forEach((name) => {
      // Sample address/city from the most recent PO that uses this name
      const sample = store.pos.slice().reverse().find(p =>
        (p.customer || '').toLowerCase().trim() === name.toLowerCase()
      ) || {};
      store.customers.push({
        id: 'cust-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
        name,
        code: '',
        address: sample.address || '',
        city: sample.city || '',
        phone: '',
        email: '',
        notes: '',
        active: true,
        createdAt: new Date().toISOString(),
      });
    });
    if (store.customers.length) {
      console.log(`[normalize] Seeded customer master with ${store.customers.length} entries from existing POs`);
    }
  }
  // Make sure customers all have required fields (in case loaded from older shape)
  store.customers.forEach(c => {
    if (!c.id) c.id = 'cust-' + Date.now() + '-' + Math.floor(Math.random() * 10000);
    if (c.active === undefined) c.active = true;
    if (!c.createdAt) c.createdAt = new Date().toISOString();
    if (!('qbCustomerId' in c)) c.qbCustomerId = '';
  });
  store.vendors.forEach(v => {
    if (!('qbVendorId' in v)) v.qbVendorId = '';
  });

  // ── QuickBooks state ───────────────────────────────────────────────────────
  if (!store.qbConnection || typeof store.qbConnection !== 'object') {
    store.qbConnection = {
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
  if (!Array.isArray(store.billingBatches)) store.billingBatches = [];
  if (!Array.isArray(store.qbSyncLog))      store.qbSyncLog = [];
  if (!Array.isArray(store.vendorBills))    store.vendorBills = [];

  // Backfill load fields used by billing batches
  store.loads.forEach(l => {
    if (!('billingBatchId' in l))      l.billingBatchId = '';
    if (!('qbInvoiceId' in l))         l.qbInvoiceId = '';
    if (!('qbInvoiceNumber' in l))     l.qbInvoiceNumber = '';
    if (!('sentToQuickBooksAt' in l))  l.sentToQuickBooksAt = '';
    if (!('vendorBillId' in l))        l.vendorBillId = '';
    if (!('qbBillId' in l))            l.qbBillId = '';
  });
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

// ── PRICING HELPERS ──────────────────────────────────────────────────────────
// Customer key uses lowercase for case-insensitive lookup
function customerKey(name) { return String(name || '').toLowerCase().trim(); }

// Resolve customer rate for a customer + material.
// Returns { unit, price, isDefault } — isDefault flags when default rate was used (for UI badge)
function resolveCustomerRate(customer, material) {
  const key = customerKey(customer);
  const list = store.customerPrices[key] || [];
  const found = list.find(p => p.material === material && p.active);
  if (found) return { unit: found.unit || 'ton', price: Number(found.price) || 0, isDefault: false };
  // Fallback to system default
  const def = (store.defaultRates?.customer || {})[material] || (DEFAULT_RATES.customer[material]) || { unit: 'ton', price: 25 };
  return { unit: def.unit || 'ton', price: Number(def.price) || 0, isDefault: true };
}

// Resolve vendor rate for a vendor + material.
// VBT Yard returns 0 (internal inventory).
function resolveVendorRate(vendorId, material) {
  if (vendorId === 'vbt') return { unit: 'ton', price: 0, isDefault: false, isInternal: true };
  const list = store.vendorPrices[vendorId] || [];
  const found = list.find(p => p.material === material && p.active);
  if (found) return { unit: found.unit || 'ton', price: Number(found.price) || 0, isDefault: false };
  const def = (store.defaultRates?.vendor || {})[material] || (DEFAULT_RATES.vendor[material]) || { unit: 'ton', price: 22 };
  return { unit: def.unit || 'ton', price: Number(def.price) || 0, isDefault: true };
}

// Compute revenue for a load given its snapshot rates and delivered count
// Handles unit='load' (price per load) vs unit='ton' (price × tons-per-load × loads delivered)
function computeRevenue(load) {
  const rate = Number(load.customerRate) || 0;
  const unit = load.customerUnit || 'ton';
  const delivered = Number(load.loadsDelivered) || 0;
  if (unit === 'load') return rate * delivered;
  // 'ton' (or anything else): rate × tons per load × loads delivered
  const tons = Number(load.tonsPerLoad) || TONS_PER_LOAD;
  return rate * tons * delivered;
}

// Compute cost for a load given its snapshot vendor rate
// VBT Yard loads have vendorRate=0 → cost is always 0
function computeCost(load) {
  const rate = Number(load.vendorRate) || 0;
  const unit = load.vendorUnit || 'ton';
  const delivered = Number(load.loadsDelivered) || 0;
  if (unit === 'load') return rate * delivered;
  const tons = Number(load.tonsPerLoad) || TONS_PER_LOAD;
  return rate * tons * delivered;
}

// ── AUDIT LOG ────────────────────────────────────────────────────────────────
// Records every meaningful manager action — used for activity log + future QBO push tracking
// action: short verb-noun like 'approved-load', 'rejected-load', 'moved-loads', 'reassigned-load',
//         'edited-price', 'deleted-vendor', 'archived-batch', 'marked-billed', 'created-po',
//         'updated-po', 'deleted-po', 'created-vendor', 'updated-vendor', 'added-price', 'deleted-price'
// target: short id reference (loadId, poId, vendorId, batchId, etc.)
// details: object with anything useful — old/new values, count, reason, etc.
function logAction(user, action, target, details) {
  try {
    // user may be a session object or just a username string — accept both
    let username = 'system';
    let displayName = 'System';
    let role = '';
    if (typeof user === 'string') {
      username = user;
      const u = USERS[user];
      displayName = u?.displayName || (user.charAt(0).toUpperCase() + user.slice(1));
      role = u?.role || '';
    } else if (user && typeof user === 'object') {
      username = user.username || 'system';
      displayName = user.displayName || username;
      role = user.role || '';
    }
    const entry = {
      id: 'AUD-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      at: new Date().toISOString(),
      user: username,
      displayName,
      role,
      action,
      target: target || '',
      details: details || {},
    };
    if (!Array.isArray(store.auditLog)) store.auditLog = [];
    store.auditLog.push(entry);
    // Cap at 5000 entries; older ones are still in archive batches
    if (store.auditLog.length > 5000) {
      store.auditLog = store.auditLog.slice(-5000);
    }
    return entry;
  } catch (e) {
    // Audit logging must never break the operation it's recording.
    console.error('[logAction] failed:', e.message, '— action:', action, 'target:', target);
    return null;
  }
}


// ── AUTH ─────────────────────────────────────────────────────────────────────
function reqAuth(req, res, next) { if (req.session?.user) return next(); res.redirect('/login'); }
function reqMgr(req, res, next)   { const r = req.session?.user?.role; if (r === 'admin' || r === 'manager') return next(); res.status(403).json({ error: 'Office access required' }); }
function reqAdmin(req, res, next) { if (req.session?.user?.role === 'admin') return next(); res.status(403).json({ error: 'Admin access required' }); }

app.get('/healthz', (req, res) => res.json({
  ok: true,
  hasDb: !!process.env.DATABASE_URL,
  pgConnected: !!pg,
  supabaseEnabled,
  signupEnabled: SIGNUP_ENABLED,
  prod: IS_PROD,
  time: new Date().toISOString(),
}));
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
  const cleanName = username?.toLowerCase().trim();
  if (!cleanName || !password) return res.redirect('/login?error=1');

  // 1) DB-backed users (seeded for VBT, plus any future signup companies).
  if (pg) {
    try {
      const r = await pg.query(
        'SELECT id, company_id, username, password, role, truck_id, display_name, active FROM users WHERE username = $1',
        [cleanName]
      );
      const dbUser = r.rows.find(row => row.active && row.password === password);
      if (dbUser) {
        req.session.user = {
          username:    dbUser.username,
          role:        dbUser.role,
          truckId:     dbUser.truck_id,
          displayName: dbUser.display_name || dbUser.username,
          companyId:   dbUser.company_id,
        };
        console.log(`[LOGIN] SUCCESS (db): username="${dbUser.username}", company="${dbUser.company_id}", role="${dbUser.role}"`);
        return res.redirect('/app/');
      }
    } catch (e) {
      console.error('[LOGIN] DB lookup error:', e.message);
      // fall through to hardcoded users
    }
  }

  // 2) Legacy fallback: ADMIN ONLY. Drivers / managers must come through
  //    the database. Otherwise after running scripts/reset-app.js the
  //    hardcoded drivers (beryle/matthew/rigo/leonardo/carlos) could still
  //    log in via these baked-in credentials, defeating the reset.
  const u = USERS[cleanName];
  if (!u || u.role !== 'admin' || u.password !== password) {
    console.log(`[LOGIN] FAILED: username="${cleanName}"`);
    return res.redirect('/login?error=1');
  }
  req.session.user = {
    username:    cleanName,
    role:        u.role,
    truckId:     u.truckId,
    displayName: u.displayName || (cleanName.charAt(0).toUpperCase() + cleanName.slice(1)),
    companyId:   DEFAULT_COMPANY_ID,
  };
  console.log(`[LOGIN] SUCCESS (legacy admin): username="${cleanName}"`);
  res.redirect('/app/');
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// ── SIGNUP ────────────────────────────────────────────────────────────────────
const SIGNUP_STYLE = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',system-ui,sans-serif;background:linear-gradient(135deg,#0a0e1a 0%,#1a2342 50%,#0a0e1a 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;color:#fff}
.card{background:rgba(255,255,255,.05);backdrop-filter:blur(20px);border-radius:18px;border:1px solid rgba(255,255,255,.1);padding:40px 36px;width:100%;max-width:420px;box-shadow:0 8px 40px rgba(0,0,0,.4)}
h2{font-size:18px;font-weight:700;margin-bottom:6px;text-align:center}
.sub{font-size:12px;color:rgba(255,255,255,.45);text-align:center;margin-bottom:28px}
label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:rgba(255,255,255,.55);display:block;margin-bottom:6px;font-weight:600}
input{width:100%;padding:11px 14px;border:1px solid rgba(255,255,255,.12);border-radius:10px;font-size:14px;font-family:inherit;margin-bottom:14px;color:#fff;background:rgba(255,255,255,.05)}
input:focus{outline:none;border-color:#60a8f0;background:rgba(255,255,255,.08)}
input::placeholder{color:rgba(255,255,255,.3)}
button{width:100%;padding:12px;background:linear-gradient(135deg,#3b82f6 0%,#2563eb 100%);color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:600;font-family:inherit;cursor:pointer;margin-top:4px}
button:hover{box-shadow:0 8px 24px rgba(59,130,246,.4)}
.err{color:#fca5a5;font-size:12px;margin-bottom:16px;background:rgba(220,38,38,.12);padding:10px 14px;border-radius:8px;border:1px solid rgba(220,38,38,.3);text-align:center}
.login-link{font-size:11px;color:rgba(255,255,255,.4);text-align:center;margin-top:20px}
.login-link a{color:#60a8f0;text-decoration:none}
`;

app.get('/signup', (req, res) => {
  if (req.session?.user) return res.redirect('/app/');
  const err = req.query.error ? `<p class="err">${decodeURIComponent(req.query.error)}</p>` : '';
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Create Account — VBT Dispatch</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${SIGNUP_STYLE}</style></head><body><div class="card">
  <h2>Create your account</h2>
  <p class="sub">14-day free trial · no credit card required</p>
  ${err}
  <form method="POST" action="/signup">
    <label>Company Name</label><input name="companyName" placeholder="e.g. Acme Trucking" required>
    <label>Your Username</label><input name="username" autocapitalize="none" autocorrect="off" placeholder="admin" required>
    <label>Password</label><input name="password" type="password" placeholder="at least 8 characters" required>
    <label>Confirm Password</label><input name="passwordConfirm" type="password" placeholder="repeat password" required>
    <button type="submit">Create account &amp; start free trial</button>
  </form>
  <p class="login-link">Already have an account? <a href="/login">Sign in</a></p>
</div></body></html>`);
});

app.post('/signup', async (req, res) => {
  if (!SIGNUP_ENABLED) {
    return res.redirect('/signup?error=' + encodeURIComponent(
      'Signup is invite-only right now. Email us to request access.'
    ));
  }
  if (!pg) return res.redirect('/signup?error=' + encodeURIComponent('Database not available'));
  const { companyName, username, password, passwordConfirm } = req.body;
  const name     = String(companyName || '').trim();
  const uname    = String(username || '').toLowerCase().trim();
  const pass     = String(password || '');
  const passConf = String(passwordConfirm || '');

  const errRedirect = msg => res.redirect('/signup?error=' + encodeURIComponent(msg));

  if (!name)  return errRedirect('Company name is required');
  if (!uname) return errRedirect('Username is required');
  if (pass.length < 8) return errRedirect('Password must be at least 8 characters');
  if (pass !== passConf) return errRedirect('Passwords do not match');
  if (!/^[a-z0-9_.-]+$/.test(uname)) return errRedirect('Username may only contain letters, numbers, _ . -');

  // Build a URL-safe slug from the company name
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
             + '-' + Date.now().toString(36);
  const companyId = slug;

  try {
    // Check if slug/company already exists
    const existing = await pg.query('SELECT 1 FROM companies WHERE slug = $1', [slug]);
    if (existing.rows.length) return errRedirect('Company name already taken — please choose another');

    const trialEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    await pg.query(`
      INSERT INTO companies (id, name, slug, active, plan, subscription_status, current_period_end, trial_ends_at)
      VALUES ($1, $2, $3, true, 'trial', 'trialing', $4, $4)
    `, [companyId, name, slug, trialEnd]);

    const userId = `user-${companyId}-${uname}`;
    await pg.query(`
      INSERT INTO users (id, company_id, username, password, role, display_name, active)
      VALUES ($1, $2, $3, $4, 'admin', $5, true)
    `, [userId, companyId, uname, pass, uname.charAt(0).toUpperCase() + uname.slice(1)]);

    // Initialize in-memory store for new company
    stores[companyId] = makeEmptyStore();
    normalizeStore(stores[companyId]);
    await saveCompanyStore(companyId);

    req.session.user = {
      username: uname,
      role: 'admin',
      truckId: null,
      displayName: uname.charAt(0).toUpperCase() + uname.slice(1),
      companyId,
    };
    console.log(`[SIGNUP] New company created: "${companyId}" (slug: ${slug}), admin: "${uname}"`);
    res.redirect('/app/');
  } catch (e) {
    console.error('[SIGNUP] error:', e.message);
    res.redirect('/signup?error=' + encodeURIComponent('Something went wrong — please try again'));
  }
});

// Static + protected app shell
app.use('/app', reqAuth, express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
app.get(['/app', '/app/'], reqAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/', (req, res) => res.redirect(req.session?.user ? '/app/' : '/login'));

// ── API: WHO AM I ────────────────────────────────────────────────────────────
app.get('/api/me', reqAuth, (req, res) => {
  const u = req.session.user;
  console.log(`[/api/me] username="${u.username}", role="${u.role}", company="${u.companyId || ''}"`);
  res.json({
    username:    u.username,
    role:        u.role,
    truckId:     u.truckId,
    displayName: u.displayName || u.username,
    companyId:   u.companyId || DEFAULT_COMPANY_ID,
  });
});

// ── API: SUBSCRIPTION STATUS ─────────────────────────────────────────────────
app.get('/api/subscription-status', reqAuth, async (req, res) => {
  const cid = req.session.user.companyId;
  const sub = await getSubscriptionStatus(cid);
  const isActive  = sub.status === 'active' || sub.status === 'trialing';
  const notExpired = !sub.periodEnd || sub.periodEnd > new Date();
  const daysLeft = sub.periodEnd
    ? Math.max(0, Math.ceil((sub.periodEnd - new Date()) / 86400000))
    : null;
  res.json({
    active: isActive && notExpired,
    status: sub.status,
    periodEnd: sub.periodEnd,
    daysLeft,
    stripeEnabled: !!stripe,
  });
});

// ── API: STRIPE — CHECKOUT SESSION ──────────────────────────────────────────
app.post('/api/stripe/checkout', reqAuth, reqMgr, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  if (!STRIPE_PRICE_ID) return res.status(503).json({ error: 'STRIPE_PRICE_ID not set' });
  const cid = req.session.user.companyId;
  try {
    const companyRow = await pg.query('SELECT * FROM companies WHERE id = $1', [cid]);
    const company = companyRow.rows[0];

    let customerId = company?.stripe_customer_id || '';
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: company?.name || cid,
        metadata: { company_id: cid },
      });
      customerId = customer.id;
      await pg.query('UPDATE companies SET stripe_customer_id = $1 WHERE id = $2', [customerId, cid]);
      invalidateSubscriptionCache(cid);
    }

    const appUrl = `${req.protocol}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: STRIPE_SUCCESS_URL.startsWith('http') ? STRIPE_SUCCESS_URL : appUrl + STRIPE_SUCCESS_URL,
      cancel_url:  STRIPE_CANCEL_URL.startsWith('http')  ? STRIPE_CANCEL_URL  : appUrl + STRIPE_CANCEL_URL,
      metadata: { company_id: cid },
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('[stripe/checkout] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── API: STRIPE — CUSTOMER PORTAL ───────────────────────────────────────────
app.post('/api/stripe/portal', reqAuth, reqMgr, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  const cid = req.session.user.companyId;
  try {
    const companyRow = await pg.query('SELECT stripe_customer_id FROM companies WHERE id = $1', [cid]);
    const customerId = companyRow.rows[0]?.stripe_customer_id;
    if (!customerId) return res.status(400).json({ error: 'No Stripe customer on file — subscribe first' });
    const appUrl = `${req.protocol}://${req.get('host')}`;
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: appUrl + '/app/',
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('[stripe/portal] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── API: STRIPE — WEBHOOK ────────────────────────────────────────────────────
// Stripe sends raw JSON; we captured req.rawBody via express.json verify callback.
app.post('/api/stripe/webhook', async (req, res) => {
  if (!stripe) return res.status(200).send('ok'); // no-op if Stripe not configured
  const sig = req.headers['stripe-signature'];
  if (!sig || !STRIPE_WEBHOOK_SECRET) {
    console.error('[stripe/webhook] missing signature or secret');
    return res.status(400).send('Webhook signature missing');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('[stripe/webhook] signature verification failed:', e.message);
    return res.status(400).send(`Webhook signature error: ${e.message}`);
  }

  const obj = event.data.object;
  const companyId = obj.metadata?.company_id;

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        // Session completed; subscription is now active. The subscription.updated
        // event will also fire, but update here too for immediate effect.
        const subId = obj.subscription;
        const custId = obj.customer;
        const cid = obj.metadata?.company_id;
        if (cid && subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          await pg.query(`
            UPDATE companies SET
              stripe_customer_id     = $1,
              stripe_subscription_id = $2,
              subscription_status    = $3,
              current_period_end     = to_timestamp($4),
              plan                   = 'monthly'
            WHERE id = $5
          `, [custId, subId, sub.status, sub.current_period_end, cid]);
          invalidateSubscriptionCache(cid);
          console.log(`[stripe/webhook] checkout.session.completed → company "${cid}" status="${sub.status}"`);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const cid = companyId || await companyIdFromCustomer(obj.customer);
        if (cid) {
          await pg.query(`
            UPDATE companies SET
              stripe_subscription_id = $1,
              subscription_status    = $2,
              current_period_end     = to_timestamp($3),
              plan                   = CASE WHEN plan = 'internal' THEN 'internal' ELSE 'monthly' END
            WHERE id = $4
          `, [obj.id, obj.status, obj.current_period_end, cid]);
          invalidateSubscriptionCache(cid);
          console.log(`[stripe/webhook] ${event.type} → company "${cid}" status="${obj.status}"`);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const cid = companyId || await companyIdFromCustomer(obj.customer);
        if (cid) {
          await pg.query(`
            UPDATE companies SET subscription_status = 'canceled', current_period_end = now()
            WHERE id = $1 AND plan != 'internal'
          `, [cid]);
          invalidateSubscriptionCache(cid);
          console.log(`[stripe/webhook] subscription.deleted → company "${cid}" canceled`);
        }
        break;
      }
      case 'invoice.payment_failed': {
        const custId = obj.customer;
        const cid = companyId || await companyIdFromCustomer(custId);
        if (cid) {
          await pg.query(`
            UPDATE companies SET subscription_status = 'past_due'
            WHERE id = $1 AND plan != 'internal'
          `, [cid]);
          invalidateSubscriptionCache(cid);
          console.log(`[stripe/webhook] invoice.payment_failed → company "${cid}" past_due`);
        }
        break;
      }
      case 'invoice.paid': {
        const custId = obj.customer;
        const cid = companyId || await companyIdFromCustomer(custId);
        if (cid) {
          await pg.query(`
            UPDATE companies SET subscription_status = 'active'
            WHERE id = $1 AND subscription_status = 'past_due'
          `, [cid]);
          invalidateSubscriptionCache(cid);
          console.log(`[stripe/webhook] invoice.paid → company "${cid}" active`);
        }
        break;
      }
      default:
        // Unhandled event type — ignore
        break;
    }
  } catch (e) {
    console.error(`[stripe/webhook] handler error for ${event.type}:`, e.message);
    // Still return 200 so Stripe doesn't retry unnecessarily for handler bugs
  }

  res.json({ received: true });
});

async function companyIdFromCustomer(stripeCustomerId) {
  if (!stripeCustomerId || !pg) return null;
  try {
    const r = await pg.query('SELECT id FROM companies WHERE stripe_customer_id = $1 LIMIT 1', [stripeCustomerId]);
    return r.rows[0]?.id || null;
  } catch { return null; }
}

// ── API: PHOTO UPLOAD (Supabase Storage) ────────────────────────────────────
// Body: { kind: 'ticket' | 'signature', loadId, dataUrl }
// Returns: { url } — the load record then stores this URL instead of base64
app.post('/api/upload-photo', reqAuth, async (req, res) => {
  if (!supabaseEnabled) {
    return res.status(503).json({ error: 'Photo upload service not configured', fallback: true });
  }
  const { kind, loadId, dataUrl } = req.body;
  if (!kind || !dataUrl) return res.status(400).json({ error: 'kind and dataUrl required' });
  if (!['ticket', 'signature'].includes(kind)) return res.status(400).json({ error: 'Invalid kind' });

  // Driver auth: must own the load they're uploading for
  if (req.session.user.role === 'driver') {
    const l = store.loads.find(x => x.id === loadId);
    if (!l) return res.status(404).json({ error: 'Load not found' });
    if (l.truckId !== req.session.user.truckId) return res.status(403).json({ error: 'Not your load' });
    if (l.locked) return res.status(403).json({ error: 'Load is locked' });
  }

  try {
    const url = await uploadPhoto(kind, dataUrl, loadId);
    console.log(`[upload-photo] ${kind} for ${loadId} → ${url}`);
    res.json({ success: true, url });
  } catch (e) {
    console.error('[upload-photo] failed:', e.message);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

// ── API: DATA (board, lists, etc.) ──────────────────────────────────────────
app.get('/api/data', reqAuth, async (req, res) => {
  const u = req.session.user;
  // Self-heal stale PO statuses on every fetch (cheap operation, fixes legacy data)
  if (u.role !== 'driver') {
    const fixed = reconcilePoStatuses();
    if (fixed.length) {
      console.log(`[/api/data] Reconciled ${fixed.length} stale POs`);
      await saveData();
    }
  }
  // Build "yards" view (just the active vendors with name + location, for the driver yard picker)
  const yards = store.vendors.filter(v => v.active).map(v => ({ id: v.id, name: v.name, location: v.location }));

  if (u.role === 'driver') {
    const myLoads = store.loads.filter(l => l.truckId === u.truckId && !l.voided);
    const myPoIds = new Set(myLoads.map(l => l.poId));
    const myPos = store.pos.filter(p => myPoIds.has(p.id));
    return res.json({ trucks: store.trucks.filter(t => t.active !== false), materials: MATERIALS, yards, pos: myPos, loads: myLoads });
  }
  // Manager sees full vendor data
  res.json({
    trucks: store.trucks,
    drivers: listDrivers(),
    materials: MATERIALS,
    yards,
    vendors: store.vendors,
    vendorPrices: store.vendorPrices,
    customers: store.customers || [],
    pos: store.pos,
    loads: store.loads
  });
});

// ── API: DRIVER DISPATCH (enriched view for drivers — guided flow) ──────────
app.get('/api/my-dispatch', reqAuth, (req, res) => {
  const u = req.session.user;
  if (u.role !== 'driver') return res.status(403).json({ error: 'Driver only' });

  // === DIAGNOSTIC LOGGING ===
  console.log(`\n[my-dispatch] Driver "${u.username}" requested loads`);
  console.log(`[my-dispatch] Logged-in driver user ID: "${u.username}"`);
  console.log(`[my-dispatch] Logged-in driver truckId: "${u.truckId}"`);
  console.log(`[my-dispatch] Total loads in store: ${store.loads.length}`);

  // Show all loads' truckIds so we can see what's actually saved
  const truckIdSummary = {};
  store.loads.forEach(l => {
    const key = l.truckId || '(unassigned)';
    truckIdSummary[key] = (truckIdSummary[key] || 0) + 1;
  });
  console.log(`[my-dispatch] Loads grouped by truckId:`, JSON.stringify(truckIdSummary));

  // Check exact match
  const exactMatch = store.loads.filter(l => l.truckId === u.truckId);
  console.log(`[my-dispatch] Loads with EXACT truckId match: ${exactMatch.length}`);

  const myLoads = store.loads.filter(l =>
    l.truckId === u.truckId &&
    !l.voided &&
    l.status !== 'completed' &&
    l.approvalStatus !== 'approved'
  );

  console.log(`[my-dispatch] Loads after filtering (not voided, not completed, not approved): ${myLoads.length}`);

  // Show why loads were filtered out (if any)
  if (exactMatch.length > 0 && myLoads.length === 0) {
    console.log(`[my-dispatch] WARNING: ${exactMatch.length} loads matched truckId but were filtered out:`);
    exactMatch.forEach(l => {
      console.log(`  - ${l.id}: voided=${l.voided}, status="${l.status}", approvalStatus="${l.approvalStatus}"`);
    });
  }
  myLoads.forEach(l => {
    console.log(`[my-dispatch] Returning: ${l.id} (${l.material}, ${l.loadsAssigned} loads, status=${l.status}, approvalStatus=${l.approvalStatus})`);
  });

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
  try {
  const { po, splits } = req.body;
  console.log(`\n[create-PO] Manager creating PO`);
  console.log(`[create-PO] PO data:`, JSON.stringify(po));
  console.log(`[create-PO] Splits received:`, JSON.stringify(splits));
  if (!po?.customer || !po?.deliveryDate) return res.status(400).json({ error: 'Customer and date required' });

  // If a customerId was supplied, use its canonical name (defends against the
  // client sending stale text). If only a name was supplied, look it up in
  // the master; if it doesn't exist, auto-add it so the master stays in sync.
  if (!Array.isArray(store.customers)) store.customers = [];
  let resolvedCustomer = String(po.customer || '').trim();
  if (po.customerId) {
    const c = store.customers.find(x => x.id === po.customerId);
    if (c) resolvedCustomer = c.name;
  } else {
    const lc = resolvedCustomer.toLowerCase();
    const existing = store.customers.find(x => String(x.name || '').toLowerCase().trim() === lc);
    if (existing) {
      resolvedCustomer = existing.name;  // canonicalize spelling
    } else if (resolvedCustomer) {
      // Auto-add to the master. Use the address/city from this PO as initial fields.
      const newCust = {
        id: 'cust-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
        name: resolvedCustomer,
        code: '', address: po.address || '', city: po.city || '',
        phone: '', email: '', notes: '',
        active: true, createdAt: new Date().toISOString(),
      };
      store.customers.push(newCust);
      console.log(`[create-PO] Auto-added customer to master: "${resolvedCustomer}"`);
    }
  }

  const poNumber = po.poNumber || `PO-${store.nextPoNum++}`;
  const newPo = {
    id: 'PO-' + Date.now(),
    poNumber,
    customer:        resolvedCustomer,
    job:             po.job || resolvedCustomer,
    jobCode:         po.jobCode || '',                                 // optional customer job code
    address:         po.address || '',
    city:            po.city || '',
    deliveryDate:    po.deliveryDate,
    pickup:          po.pickup || 'VBT Yard',                          // human label of planned pickup
    plannedVendorId: po.plannedVendorId || 'vbt',                      // structured planned pickup vendor
    notes:           po.notes || '',
    status:          po.deliveryDate > todayStr() ? 'scheduled' : 'active',
    materials:       [],
    createdAt:       new Date().toISOString(),
  };

  // Aggregate materials from splits
  const matCounts = {};
  (splits || []).forEach(s => {
    if (!s.material || !s.loadsAssigned) return;
    matCounts[s.material] = (matCounts[s.material] || 0) + Number(s.loadsAssigned);
  });
  newPo.materials = Object.keys(matCounts).map(m => ({ material: m, totalLoads: matCounts[m] }));

  store.pos.push(newPo);

  // Create one load record per split
  (splits || []).forEach(s => {
    if (!s.material || !s.loadsAssigned) {
      console.log(`[create-PO] SKIPPING split — missing material or loadsAssigned:`, JSON.stringify(s));
      return;
    }
    const truck = store.trucks.find(t => t.id === s.truckId);
    const vendor = s.vendorId ? store.vendors.find(v => v.id === s.vendorId) : null;
    console.log(`[create-PO] Creating load: truckId="${s.truckId}", material="${s.material}", loads=${s.loadsAssigned}, driver="${truck?.label || '(unassigned)'}", vendor="${vendor?.name || '(none)'}"`);

    // Pricing snapshots — locked at PO creation
    let customerRate = { price: 25, unit: 'ton', isDefault: true };
    let vendorRate   = { price: 22, unit: 'ton', isDefault: true, isInternal: false };
    try {
      customerRate = resolveCustomerRate(newPo.customer, s.material);
      vendorRate   = resolveVendorRate(s.vendorId, s.material);
    } catch (e) {
      console.warn('[create-PO] price resolution failed, using fallback defaults:', e.message);
    }

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
      // Pricing snapshots
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

  // Audit logging is best-effort — never let it block PO/load creation
  try {
    logAction(req.session.user, 'created-po', newPo.id, {
      poNumber: newPo.poNumber,
      customer: newPo.customer,
      deliveryDate: newPo.deliveryDate,
      loadCount: store.loads.filter(l => l.poId === newPo.id).length,
    });
  } catch (e) {
    console.error('[create-PO] audit log failed (non-fatal):', e.message);
  }

  try {
    await saveData();
  } catch (e) {
    console.error('[create-PO] saveData failed:', e.message);
  }
  console.log(`[create-PO] DONE. Total POs: ${store.pos.length}, total loads: ${store.loads.length}`);
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
  const idx = store.pos.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const old = store.pos[idx];
  const updated = { ...old, ...req.body, id: old.id };
  store.pos[idx] = updated;
  // If delivery date changed, sync to all linked loads
  if (req.body.deliveryDate && req.body.deliveryDate !== old.deliveryDate) {
    store.loads.filter(l => l.poId === old.id && !l.locked).forEach(l => l.deliveryDate = req.body.deliveryDate);
  }
  logAction(req.session.user, 'updated-po', updated.id, {
    poNumber: updated.poNumber,
    changes: Object.keys(req.body),
    dateChanged: req.body.deliveryDate && req.body.deliveryDate !== old.deliveryDate,
  });
  await saveData();
  res.json({ success: true, po: updated });
});

// ── API: DELETE PO ──────────────────────────────────────────────────────────
app.delete('/api/pos/:id', reqMgr, async (req, res) => {
  const idx = store.pos.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  // Refuse to delete if any linked loads are approved (data integrity)
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
  });
  await saveData();
  res.json({ success: true });
});

// ── API: UPDATE LOAD (manager: anything | driver: limited) ──────────────────
app.put('/api/loads/:id', reqAuth, async (req, res) => {
  const u = req.session.user;
  const idx = store.loads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const l = store.loads[idx];
  if (l.locked) return res.status(403).json({ error: 'Load is locked' });

  if (u.role === 'driver') {
    if (l.truckId !== u.truckId) return res.status(403).json({ error: 'Not your load' });
    // Drivers can only update progress/timestamps/pod/ticket
    const allowed = {};
    if (req.body.loadsDelivered !== undefined) allowed.loadsDelivered = Number(req.body.loadsDelivered);
    if (req.body.timestamps) allowed.timestamps = { ...l.timestamps, ...req.body.timestamps };
    if (req.body.gps)        allowed.gps        = { ...l.gps, ...req.body.gps };
    if (req.body.pod)        allowed.pod        = { ...l.pod, ...req.body.pod };
    if (req.body.ticketImage){ allowed.ticketImage = req.body.ticketImage; allowed.ticketImageAt = new Date().toISOString(); }
    if (req.body.ticketImageUrl){ allowed.ticketImageUrl = req.body.ticketImageUrl; allowed.ticketImageAt = new Date().toISOString(); allowed.ticketImage = ''; /* clear legacy base64 */ }
    if (req.body.notes !== undefined) allowed.notes = req.body.notes;
    store.loads[idx] = { ...l, ...allowed };
  } else {
    // Manager — anything goes
    const updated = { ...l, ...req.body, id: l.id, poId: l.poId };
    let auditAction = 'updated-load';
    let auditDetails = { changes: Object.keys(req.body) };
    if (req.body.truckId !== undefined) {
      const t = store.trucks.find(t => t.id === req.body.truckId);
      updated.driverName = t?.label || '';
      updated.status = req.body.truckId ? 'active' : 'unassigned';
      // Treat driver change as a separate action type
      if (req.body.truckId !== l.truckId) {
        auditAction = 'reassigned-load';
        auditDetails = {
          fromDriver: l.driverName || l.truckId || 'Unassigned',
          toDriver:   updated.driverName || 'Unassigned',
        };
      }
    }
    store.loads[idx] = updated;
    logAction(req.session.user, auditAction, l.id, auditDetails);
  }
  await saveData();
  res.json({ success: true, load: store.loads[idx] });
});

// ── API: DELETE LOAD (manager only) ─────────────────────────────────────────
app.delete('/api/loads/:id', reqMgr, async (req, res) => {
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
  });
  await saveData();
  res.json({ success: true });
});

// ── PER-TRIP HELPERS ────────────────────────────────────────────────────────
// A "load" is a manager-assigned bundle of N truck trips between yard and
// jobsite. Each individual yard→jobsite cycle is a "trip" and gets its own
// timestamps inside `load.trips[]`. The top-level `timestamps` object on the
// load mirrors the CURRENT trip's progress so existing UI/code (board status,
// step tracker, single-trip analytics) keeps working.
//
// Schema:
//   load.trips = [
//     { tripNum: 1, timestamps: {start, arrivedPickup, loadedAt, arrivedJobsite, completed},
//                   isoStamps:  {same fields, ISO instants},
//                   gps:        {same fields, lat/lng objects} },
//     { tripNum: 2, ... },
//     ...
//   ]
//
// Migration: a legacy load that has top-level `timestamps` but no `trips[]`
// gets its existing stamps moved into trips[0] the first time it's touched.
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

// Index of the trip currently in progress (latest trip without `completed`).
// Returns load.trips.length if all existing trips are complete (= where a new
// trip would go).
function activeTripIdx(load) {
  ensureTripsMigrated(load);
  for (let i = load.trips.length - 1; i >= 0; i--) {
    if (!load.trips[i].timestamps?.completed) return i;
  }
  return load.trips.length;
}

// ── API: DRIVER TRIP ACTIONS ────────────────────────────────────────────────
// Per-trip flow: each trip is one yard→jobsite cycle. A load with
// loadsAssigned=5 means the driver does 5 trips. Each trip captures all five
// timestamps; analytics and the load detail timeline see them individually.
//
// Action sequence per trip:
//   start-trip → arrived-pickup → loaded → arrived-jobsite → trip-complete
//
// After each trip-complete:
//   - If loadsDelivered < loadsAssigned: driver sees "Trip N of M complete"
//     and a "Start Trip N+1" button which calls start-trip for the next trip.
//   - If loadsDelivered === loadsAssigned: driver sees "All trips complete —
//     upload ticket + signature → submit" which goes through the existing
//     ticket / signature flow and then calls `delivered` to lock & submit.
//
// `incomplete` is for "I'm stopping early" — driver submits with a partial
// count of loads delivered.
app.post('/api/loads/:id/trip-action', reqAuth, async (req, res) => {
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

  // Get (or create) the trip this action applies to. `delivered` /
  // `incomplete` are load-level finalizers — they don't need an active trip.
  const isFinalizer = (action === 'delivered' || action === 'incomplete');
  // Guard: don't allow starting more trips than the assigned count
  if (action === 'start-trip' && (l.loadsDelivered || 0) >= l.loadsAssigned) {
    return res.status(400).json({ error: 'All assigned loads already delivered — submit when ready' });
  }
  const tripIdx = activeTripIdx(l);
  let trip = l.trips[tripIdx];
  if (!trip && action === 'start-trip') {
    // Starting a fresh trip — create it
    trip = { tripNum: tripIdx + 1, timestamps: {}, isoStamps: {}, gps: {} };
    l.trips[tripIdx] = trip;
    // If this is trip ≥ 2, reset top-level intermediate stamps so the step
    // tracker shows the new trip from a clean state. The previous trip's
    // data lives in trips[tripIdx - 1] and is preserved.
    if (trip.tripNum > 1) {
      l.timestamps = {};
      l.isoStamps  = {};
    }
  } else if (!trip && isFinalizer && l.trips.length) {
    // All trips done — finalizer references the most recent trip for any
    // last-second `completed` stamp logic below.
    trip = l.trips[l.trips.length - 1];
  }
  if (!trip) {
    // No trip at all and not starting one — caller is out of sequence
    return res.status(400).json({ error: 'No active trip — press Start Trip to begin' });
  }

  // Helper: stamp a step on the active trip AND mirror to top-level for
  // backward compat (so existing UI/board/status code keeps working).
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
        // Stamp the yard onto this trip too so per-trip analytics know which
        // yard each trip used (a driver could rotate yards across trips).
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
    // Ends the current trip. Increments loadsDelivered. Does NOT submit for
    // approval — that's the `delivered` action below, which fires only after
    // the LAST trip's ticket + signature are captured.
    if (!trip.timestamps?.arrivedJobsite) return res.status(400).json({ error: 'Must mark arrived at job site first' });
    if (trip.timestamps?.completed)        return res.status(400).json({ error: 'Trip already complete' });
    stampBoth('completed');
    l.loadsDelivered = (l.loadsDelivered || 0) + 1;
    // If that was the LAST trip, also stamp the load-level "completed" so the
    // existing board/status code recognizes the load as ready-to-submit.
    if (l.loadsDelivered >= l.loadsAssigned) {
      l.allTripsDone = true;
    }
  } else if (action === 'delivered' || action === 'incomplete') {
    // Final submission — collect ticket + signature, lock and submit for approval.
    if (!l.ticketImage && !l.ticketImageUrl)
      return res.status(400).json({ error: 'Ticket photo required' });
    if (!l.pod?.signedBy || (!l.pod.signature && !l.pod.signatureUrl))
      return res.status(400).json({ error: 'Customer signature required' });

    if (action === 'incomplete') {
      // Driver is stopping early — close the active trip if it's mid-cycle but
      // not yet completed. Then accept the partial count.
      if (!trip.timestamps?.completed && trip.timestamps?.arrivedJobsite) {
        stampBoth('completed');
        l.loadsDelivered = (l.loadsDelivered || 0) + 1;
      }
      const reported = Math.max(0, Math.min(Number(req.body.delivered) || l.loadsDelivered || 0, l.loadsAssigned));
      if (reported <= 0) return res.status(400).json({ error: 'How many loads did you deliver? Enter a number greater than 0.' });
      l.loadsDelivered = reported;
      l.isPartial = (reported < l.loadsAssigned);
    } else {
      // 'delivered' — backward compat with the single-trip flow: if the active
      // trip hasn't been closed via trip-complete yet, close it now and count
      // it. This also means a load with loadsAssigned=1 keeps its old
      // "ticket → sig → submit" UX without needing a separate "Confirm Drop".
      if (!trip.timestamps?.completed && trip.timestamps?.arrivedJobsite) {
        stampBoth('completed');
        l.loadsDelivered = (l.loadsDelivered || 0) + 1;
      }
      if (l.loadsDelivered >= l.loadsAssigned) {
        l.loadsDelivered = l.loadsAssigned;
        l.isPartial = false;
      } else {
        // Submitting before all trips done with no incomplete count — treat as partial
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
  l.locked         = true;  // permanently locked
  // Mark PO completed if all loads done
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
  });
  await saveData();
  res.json({ success: true });
});

app.post('/api/loads/:id/reject', reqMgr, async (req, res) => {
  const idx = store.loads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const l = store.loads[idx];
  if (l.approvalStatus !== 'submitted') return res.status(400).json({ error: 'Load not submitted' });
  l.approvalStatus = 'rejected';
  l.rejectReason   = req.body.reason || 'No reason provided';
  l.locked         = false;  // unlock so driver can fix
  const po = store.pos.find(p => p.id === l.poId);
  logAction(req.session.user, 'rejected-load', l.id, {
    poNumber: po?.poNumber || '',
    driver:   l.driverName,
    reason:   l.rejectReason,
  });
  await saveData();
  res.json({ success: true });
});

// ── API: BILLING ─────────────────────────────────────────────────────────────
app.get('/api/ready-to-bill', reqMgr, (req, res) => {
  const filters = req.query;
  let items = store.loads.filter(l => l.approvalStatus === 'approved' && l.billStatus === 'ready' && !l.voided);
  if (filters.month)    items = items.filter(l => (l.deliveryDate || '').startsWith(filters.month));
  if (filters.material) items = items.filter(l => l.material === filters.material);
  if (filters.truckId)  items = items.filter(l => l.truckId === filters.truckId);
  if (filters.poId)     items = items.filter(l => l.poId === filters.poId);
  // Enrich with PO data
  const enriched = items.map(l => {
    const po = store.pos.find(p => p.id === l.poId) || {};
    return { ...l, poNumber: po.poNumber, customer: po.customer, city: po.city, address: po.address };
  });
  res.json({ items: enriched });
});

app.post('/api/loads/bill', reqMgr, async (req, res) => {
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
    logAction(req.session.user, 'marked-billed', '', {
      count,
      loadIds: billedIds,
    });
  }
  await saveData();
  res.json({ success: true, billed: count });
});

// ═══════════════════════════════════════════════════════════════════════════
// QUICKBOOKS ONLINE INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════
// Loads only enter QB after admin approval AND an explicit "Send to QuickBooks"
// click on a billing batch. Approved loads are locked from deletion; if a batch
// is wrong, it is voided (not deleted), and a correction batch may be created.

function genId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function logQbSync(entry) {
  try {
    const e = {
      id: genId('QBL'),
      at: new Date().toISOString(),
      actionType: entry.actionType,
      relatedLoadIds: entry.relatedLoadIds || [],
      relatedBatchId: entry.relatedBatchId || '',
      qbEntityType: entry.qbEntityType || '',
      qbEntityId: entry.qbEntityId || '',
      requestSummary: entry.requestSummary || '',
      responseStatus: entry.responseStatus || 'success',  // success | error
      statusCode: entry.statusCode || 0,
      errorMessage: entry.errorMessage || '',
      user: entry.user || '',
    };
    if (!Array.isArray(store.qbSyncLog)) store.qbSyncLog = [];
    store.qbSyncLog.push(e);
    if (store.qbSyncLog.length > 5000) store.qbSyncLog = store.qbSyncLog.slice(-5000);
    return e;
  } catch (err) {
    console.error('[logQbSync] failed:', err.message);
    return null;
  }
}

// Group selected approved loads into one billing batch per (customer, PO, jobsite, week-range).
// Returns { groups: [{ key, customer, poNumber, ..., loadIds, lineItems, total }] }
function buildBillingGroups(loadIds) {
  const out = new Map();
  for (const id of loadIds) {
    const l = store.loads.find(x => x.id === id);
    if (!l) continue;
    if (l.approvalStatus !== 'approved') continue;
    if (l.billStatus !== 'ready') continue;
    if (l.voided) continue;
    if (l.billingBatchId) continue;  // already in a batch
    const po = store.pos.find(p => p.id === l.poId) || {};
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

    // Group line items by material+unit+rate (so different rates don't collapse)
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
    const totalAmount = lineItems.reduce((s, ln) => s + ln.amount, 0);
    const totalLoads  = lineItems.reduce((s, ln) => s + ln.loads, 0);
    const totalTons   = lineItems.reduce((s, ln) => s + ln.tons, 0);

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
// Status (no token data) — visible to managers so they know if billing will work.
app.get('/api/quickbooks/status', reqMgr, (req, res) => {
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

// Begin OAuth — admin only. Stores random state in session and redirects.
app.get('/api/quickbooks/connect', reqAdmin, (req, res) => {
  if (!qb.isConfigured()) {
    return res.status(400).send('QuickBooks not configured. Set QB_CLIENT_ID, QB_CLIENT_SECRET, and QB_REDIRECT_URI.');
  }
  const state = require('crypto').randomBytes(24).toString('hex');
  req.session.qbOauthState = state;
  req.session.qbOauthUser  = req.session.user.username;
  res.redirect(qb.buildAuthUrl(state));
});

// OAuth callback — Intuit redirects here with code, state, and realmId.
app.get('/api/quickbooks/callback', reqAuth, async (req, res) => {
  try {
    const { code, state, realmId, error, error_description } = req.query;
    if (error) {
      logQbSync({ actionType: 'oauth_connect', responseStatus: 'error', errorMessage: `${error}: ${error_description || ''}`, user: req.session.user?.username });
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

    logQbSync({ actionType: 'oauth_connect', qbEntityType: 'Realm', qbEntityId: String(realmId), user: req.session.user.username, requestSummary: `Connected to ${qb.QB_ENVIRONMENT}` });
    logAction(req.session.user, 'qb-connected', String(realmId), { environment: qb.QB_ENVIRONMENT });
    await saveData();
    res.send(`<html><body style="font-family:system-ui;padding:40px;text-align:center">
      <h2 style="color:#0a8a3a">QuickBooks connected</h2>
      <p>Realm: <code>${realmId}</code> · Environment: <strong>${qb.QB_ENVIRONMENT}</strong></p>
      <p><a href="/app/">Return to dispatch</a></p>
      <script>setTimeout(()=>{location.href='/app/#qb-settings'},1500)</script>
    </body></html>`);
  } catch (e) {
    console.error('[qb callback]', e);
    logQbSync({ actionType: 'oauth_connect', responseStatus: 'error', errorMessage: e.message, user: req.session.user?.username });
    res.status(500).send(`QuickBooks connect failed: ${e.message}`);
  }
});

app.post('/api/quickbooks/disconnect', reqAdmin, async (req, res) => {
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
    logQbSync({ actionType: 'oauth_disconnect', user: req.session.user.username });
    logAction(req.session.user, 'qb-disconnected', '', {});
    await saveData();
    res.json({ success: true });
  }
});

// ── BILLING BATCH ENDPOINTS ─────────────────────────────────────────────────
// Preview groups for a selection without persisting anything
app.post('/api/billing-batches/preview', reqMgr, (req, res) => {
  const ids = req.body?.loadIds || [];
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'loadIds required' });
  const groups = buildBillingGroups(ids);
  if (!groups.length) return res.status(400).json({ error: 'No eligible loads to bill (must be approved, ready, and not yet in a batch)' });
  res.json({ groups });
});

// Create batch records from a selection. Marks loads with billingBatchId so they
// can't be reused. Does NOT call QuickBooks yet — that happens on /send.
app.post('/api/billing-batches', reqMgr, async (req, res) => {
  const ids = req.body?.loadIds || [];
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'loadIds required' });
  const groups = buildBillingGroups(ids);
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
    // Mark loads as part of this batch (lock against duplicate billing)
    for (const lid of g.loadIds) {
      const l = store.loads.find(x => x.id === lid);
      if (l) l.billingBatchId = batchId;
    }
    created.push(batch);
  }
  logAction(req.session.user, 'created-billing-batches', '', {
    count: created.length, batchIds: created.map(b => b.id), totalLoads: created.reduce((s, b) => s + b.totalLoads, 0),
  });
  await saveData();
  res.json({ success: true, batches: created });
});

// List billing batches with filters
app.get('/api/billing-batches', reqMgr, (req, res) => {
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
  const b = store.billingBatches.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Batch not found' });
  // Enrich with load detail so the UI can show full ticket/signature URLs
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

// Send a batch to QuickBooks: ensures customer exists, creates invoice, attaches
// ticket photos + signatures, writes IDs back to the batch and each load.
app.post('/api/billing-batches/:id/send', reqMgr, async (req, res) => {
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
    // 1. Find or create customer in QB and remember the mapping
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
      });
    }
    b.qbCustomerId = qbCustomerId;

    // 2. Build invoice memo with PO + job + dates + batch ID
    const memoParts = [];
    if (b.poNumber)      memoParts.push(`PO ${b.poNumber}`);
    if (b.jobCode)       memoParts.push(`Job ${b.jobCode}`);
    if (b.address)       memoParts.push(b.address + (b.city ? `, ${b.city}` : ''));
    if (b.deliveryStart) memoParts.push(b.deliveryStart === b.deliveryEnd ? b.deliveryStart : `${b.deliveryStart} to ${b.deliveryEnd}`);
    memoParts.push(`Batch ${b.id}`);
    const memo = memoParts.join(' · ');

    // 3. Create invoice
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
    });

    // 4. Mark loads as sent
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

    // Save before attempting attachments — if attachments fail we still have a valid invoice.
    await saveData();

    // 5. Attach supporting documents (best-effort; failures are logged but don't fail the send)
    const attachmentIds = [];
    for (const ref of (b.ticketImageRefs || [])) {
      if (!ref.url) continue;  // skip base64-only legacy
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
        logQbSync({ actionType: 'attach_file', relatedBatchId: b.id, relatedLoadIds: [ref.loadId], qbEntityType: 'Invoice', qbEntityId: invoice.Id, requestSummary: `ticket-${ref.loadId}`, user });
      } catch (e) {
        logQbSync({ actionType: 'attach_file', relatedBatchId: b.id, relatedLoadIds: [ref.loadId], qbEntityType: 'Invoice', qbEntityId: invoice.Id, responseStatus: 'error', errorMessage: e.message, user });
      }
    }
    // Also attach signatures stored as remote URL on the load (pod.signatureUrl)
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
        logQbSync({ actionType: 'attach_file', relatedBatchId: b.id, relatedLoadIds: [ref.loadId], qbEntityType: 'Invoice', qbEntityId: invoice.Id, requestSummary: `signature-${ref.loadId}`, user });
      } catch (e) {
        logQbSync({ actionType: 'attach_file', relatedBatchId: b.id, relatedLoadIds: [ref.loadId], qbEntityType: 'Invoice', qbEntityId: invoice.Id, responseStatus: 'error', errorMessage: e.message, user });
      }
    }
    b.attachmentIds = attachmentIds;
    logAction(req.session.user, 'sent-to-quickbooks', b.id, {
      invoiceId: invoice.Id, invoiceNumber: invoice.DocNumber, amount: b.totalAmount, loads: b.loadIds.length,
    });
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
    });
    await saveData();
    res.status(500).json({ error: e.message, batch: b });
  }
});

// Void a batch — reverses our local lock so a corrected batch can be created.
// Optionally also voids the QB invoice (default true if it was sent).
app.post('/api/billing-batches/:id/void', reqMgr, async (req, res) => {
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
      logQbSync({ actionType: 'void_invoice', relatedBatchId: b.id, qbEntityType: 'Invoice', qbEntityId: b.qbInvoiceId, requestSummary: reason, user: req.session.user.username });
    } catch (e) {
      logQbSync({ actionType: 'void_invoice', relatedBatchId: b.id, qbEntityType: 'Invoice', qbEntityId: b.qbInvoiceId, responseStatus: 'error', errorMessage: e.message, user: req.session.user.username });
      return res.status(500).json({ error: `Failed to void in QuickBooks: ${e.message}` });
    }
  }

  b.syncStatus = 'voided';
  b.voidedAt = new Date().toISOString();
  b.voidedBy = req.session.user.username;
  b.voidReason = reason;

  // Free the loads so a corrected batch can be created. Loads themselves are
  // NOT deleted — they keep their approved/locked status and full audit trail.
  for (const lid of b.loadIds) {
    const l = store.loads.find(x => x.id === lid);
    if (l) {
      l.billingBatchId = '';
      l.billStatus = 'ready';     // back to ready-to-bill so a corrected batch can pick it up
      l.qbInvoiceId = '';
      l.qbInvoiceNumber = '';
      l.sentToQuickBooksAt = '';
      l.billedAt = '';
    }
  }
  logAction(req.session.user, 'voided-billing-batch', b.id, { reason, qbVoided, loads: b.loadIds.length });
  await saveData();
  res.json({ success: true, batch: b, qbVoided });
});

// Retry a failed send (same logic as /send; allowed when status === 'failed')
app.post('/api/billing-batches/:id/retry', reqMgr, async (req, res) => {
  const b = store.billingBatches.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Batch not found' });
  if (b.syncStatus !== 'failed') return res.status(400).json({ error: 'Only failed batches can be retried' });
  // Reset and forward to /send via internal redirect-style call
  b.syncStatus = 'ready_to_bill';
  b.errorMessage = '';
  await saveData();
  // Re-issue a request to /send by calling the handler directly is tricky; the
  // simpler approach is to have the client POST to /send after /retry. So just
  // confirm reset and let the client trigger /send.
  res.json({ success: true, batch: b });
});

// ── VENDOR BILLS (PAYABLES) ─────────────────────────────────────────────────
function buildVendorBillGroups(loadIds) {
  const out = new Map();
  for (const id of loadIds) {
    const l = store.loads.find(x => x.id === id);
    if (!l) continue;
    if (l.approvalStatus !== 'approved') continue;
    if (l.voided) continue;
    if (l.vendorBillId) continue;  // already in a bill
    const vendorId = l.vendorId || l.yardId || '';
    if (!vendorId || vendorId === 'vbt') continue;  // skip internal yard
    const v = store.vendors.find(x => x.id === vendorId);
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
  const ids = req.body?.loadIds || [];
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'loadIds required' });
  const groups = buildVendorBillGroups(ids);
  if (!groups.length) return res.status(400).json({ error: 'No eligible vendor costs (loads must be approved, vendor must be external)' });
  res.json({ groups });
});

app.post('/api/vendor-bills', reqMgr, async (req, res) => {
  const ids = req.body?.loadIds || [];
  const groups = buildVendorBillGroups(ids);
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
  logAction(req.session.user, 'created-vendor-bills', '', { count: created.length, billIds: created.map(b => b.id) });
  await saveData();
  res.json({ success: true, bills: created });
});

app.get('/api/vendor-bills', reqMgr, (req, res) => {
  const f = req.query;
  let items = [...(store.vendorBills || [])];
  if (f.status)   items = items.filter(b => b.syncStatus === f.status);
  if (f.vendorId) items = items.filter(b => b.vendorId === f.vendorId);
  if (f.month)    items = items.filter(b => (b.deliveryStart || '').startsWith(f.month));
  items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json({ items });
});

app.post('/api/vendor-bills/:id/send', reqMgr, async (req, res) => {
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
      logQbSync({ actionType: lookup.created ? 'create_vendor' : 'find_vendor', relatedBatchId: b.id, qbEntityType: 'Vendor', qbEntityId: qbVendorId, requestSummary: `${lookup.created ? 'Created' : 'Matched'} vendor "${b.vendorName}"`, user });
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
    logQbSync({ actionType: 'create_bill', relatedBatchId: b.id, relatedLoadIds: b.loadIds, qbEntityType: 'Bill', qbEntityId: bill.Id, requestSummary: `Bill for ${b.vendorName} — $${b.totalAmount.toFixed(2)}`, user });
    logAction(req.session.user, 'sent-vendor-bill', b.id, { qbBillId: bill.Id, vendor: b.vendorName, amount: b.totalAmount });
    await saveData();
    res.json({ success: true, bill: b });
  } catch (e) {
    console.error('[vendor bill send]', e);
    b.syncStatus = 'failed';
    b.errorMessage = e.message;
    logQbSync({ actionType: 'create_bill', relatedBatchId: b.id, relatedLoadIds: b.loadIds, responseStatus: 'error', errorMessage: e.message, statusCode: e.statusCode || 0, user });
    await saveData();
    res.status(500).json({ error: e.message, bill: b });
  }
});

// ── QB SYNC LOG ─────────────────────────────────────────────────────────────
app.get('/api/qb-sync-log', reqMgr, (req, res) => {
  const f = req.query || {};
  let items = [...(store.qbSyncLog || [])];
  if (f.status)     items = items.filter(e => e.responseStatus === f.status);
  if (f.actionType) items = items.filter(e => e.actionType === f.actionType);
  if (f.batchId)    items = items.filter(e => e.relatedBatchId === f.batchId);
  if (f.loadId)     items = items.filter(e => (e.relatedLoadIds || []).includes(f.loadId));
  items.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  // Cap to most recent 500 entries unless `limit` is set
  const limit = Math.min(parseInt(f.limit || '500', 10) || 500, 5000);
  res.json({ items: items.slice(0, limit) });
});

// ── API: MOVE LOADS TO A NEW DATE ────────────────────────────────────────────
// Body:
//   { scope: 'po' | 'remaining' | 'single', poId?, loadId?, newDate, reason }
// scope='po'        → moves all unlocked loads belonging to a PO
// scope='remaining' → moves only loads that are NOT yet completed/approved (i.e. undelivered)
// scope='single'    → moves one specific load
app.post('/api/loads/move', reqMgr, async (req, res) => {
  const { scope, poId, loadId, newDate, reason } = req.body;
  if (!newDate) return res.status(400).json({ error: 'New date is required' });
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'Reason is required' });

  // Figure out which loads to move
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
      // Only loads that haven't been delivered/approved/billed
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

  // Locked loads (approved/billed) can't be moved — skip them
  const movable = toMove.filter(l => !l.locked);
  const skipped = toMove.length - movable.length;

  if (!movable.length) return res.status(400).json({ error: 'All eligible loads are locked (approved or billed)' });

  const movedAt = new Date().toISOString();
  const movedBy = req.session.user.username;

  movable.forEach(l => {
    const fromDate = l.deliveryDate;
    if (!l.originalScheduledDate) l.originalScheduledDate = fromDate;
    l.moveHistory = l.moveHistory || [];
    l.moveHistory.push({
      from:    fromDate,
      to:      newDate,
      reason:  reason.trim(),
      movedBy, movedAt, scope
    });
    l.deliveryDate = newDate;
  });

  // If we moved every load on the PO and the PO has its own deliveryDate,
  // update the PO's deliveryDate to match (keeps the PO list consistent).
  // But ONLY for scope='po' — for 'remaining' and 'single' the PO date stays the same.
  if (scope === 'po' && poId) {
    const po = store.pos.find(p => p.id === poId);
    if (po) {
      if (!po.originalDeliveryDate) po.originalDeliveryDate = po.deliveryDate;
      po.deliveryDate = newDate;
      po.poMoveHistory = po.poMoveHistory || [];
      po.poMoveHistory.push({ from: po.originalDeliveryDate, to: newDate, reason: reason.trim(), movedBy, movedAt });
      // If the PO was completed and we move it, reactivate it
      if (po.status === 'completed') po.status = 'active';
    }
  }

  // Audit log entry
  const targetPo = store.pos.find(p => p.id === poId);
  logAction(req.session.user, 'moved-loads', loadId || poId, {
    scope,
    newDate,
    reason: reason.trim(),
    poNumber:  targetPo?.poNumber || '',
    customer:  targetPo?.customer || '',
    moved:     movable.length,
    skipped,
  });

  await saveData();
  res.json({
    success: true,
    moved: movable.length,
    skipped,
    newDate,
    loadIds: movable.map(l => l.id)
  });
});

// ── API: VENDORS & PRICING ───────────────────────────────────────────────────
// List vendors (manager only — drivers get this through /api/data as 'yards')
app.get('/api/vendors', reqMgr, (req, res) => {
  res.json({ vendors: store.vendors, vendorPrices: store.vendorPrices });
});

// Add a new vendor
app.post('/api/vendors', reqMgr, async (req, res) => {
  const { name, location } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || ('vendor-' + Date.now());
  if (store.vendors.find(v => v.id === id)) return res.status(400).json({ error: 'A vendor with that name already exists' });
  const newVendor = { id, name: name.trim(), location: (location || '').trim(), active: true };
  store.vendors.push(newVendor);
  store.vendorPrices[id] = [];
  logAction(req.session.user, 'created-vendor', id, { name: newVendor.name });
  await saveData();
  res.json({ success: true, vendor: newVendor });
});

// Update a vendor (rename/relocate/toggle active)
app.put('/api/vendors/:id', reqMgr, async (req, res) => {
  const v = store.vendors.find(x => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  const before = { name: v.name, location: v.location, active: v.active };
  if (req.body.name !== undefined)     v.name = String(req.body.name).trim();
  if (req.body.location !== undefined) v.location = String(req.body.location).trim();
  if (req.body.active !== undefined)   v.active = !!req.body.active;
  logAction(req.session.user, 'updated-vendor', v.id, {
    name: v.name,
    changes: Object.keys(req.body),
    before,
  });
  await saveData();
  res.json({ success: true, vendor: v });
});

// Delete a vendor (only if no active loads reference it)
app.delete('/api/vendors/:id', reqMgr, async (req, res) => {
  const id = req.params.id;
  const idx = store.vendors.findIndex(v => v.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  // Refuse if any active load uses this vendor
  const inUse = store.loads.some(l => l.vendorId === id && !l.voided);
  if (inUse) return res.status(400).json({ error: 'Cannot delete — there are loads using this vendor. Mark inactive instead.' });
  const deleted = store.vendors[idx];
  store.vendors.splice(idx, 1);
  delete store.vendorPrices[id];
  logAction(req.session.user, 'deleted-vendor', id, { name: deleted.name });
  await saveData();
  res.json({ success: true });
});

// Add a material price to a vendor
app.post('/api/vendors/:id/prices', reqMgr, async (req, res) => {
  const v = store.vendors.find(x => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Vendor not found' });
  const { material, unit, price, notes } = req.body;
  if (!material || !material.trim()) return res.status(400).json({ error: 'Material required' });
  if (!store.vendorPrices[v.id]) store.vendorPrices[v.id] = [];
  // Prevent dupes (same material+unit on the same vendor)
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
    vendorName: v.name,
    material:   newPrice.material,
    unit:       newPrice.unit,
    price:      newPrice.price,
  });
  await saveData();
  res.json({ success: true, price: newPrice });
});

// Update a price row
app.put('/api/vendors/:id/prices/:priceId', reqMgr, async (req, res) => {
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
  // Only log price-edits if price actually changed (not on every blur from inline editing)
  const priceChanged = req.body.price !== undefined && Number(req.body.price) !== before.price;
  if (priceChanged || req.body.active !== undefined) {
    logAction(req.session.user, 'edited-price', req.params.id + ':' + p.id, {
      vendorName: v?.name || req.params.id,
      material:   p.material,
      unit:       p.unit,
      before:     { price: before.price, active: before.active },
      after:      { price: p.price, active: p.active },
    });
  }
  await saveData();
  res.json({ success: true, price: p });
});

// Delete a price row
app.delete('/api/vendors/:id/prices/:priceId', reqMgr, async (req, res) => {
  const list = store.vendorPrices[req.params.id];
  if (!list) return res.status(404).json({ error: 'Vendor not found' });
  const idx = list.findIndex(x => x.id === req.params.priceId);
  if (idx === -1) return res.status(404).json({ error: 'Price not found' });
  const deleted = list[idx];
  const v = store.vendors.find(x => x.id === req.params.id);
  list.splice(idx, 1);
  logAction(req.session.user, 'deleted-price', req.params.id + ':' + deleted.id, {
    vendorName: v?.name || req.params.id,
    material:   deleted.material,
    price:      deleted.price,
  });
  await saveData();
  res.json({ success: true });
});

// ── API: AUDIT LOG ───────────────────────────────────────────────────────────
// Filterable: ?user=manager&action=approved-load&since=2026-04-01&until=2026-04-30&limit=200
app.get('/api/audit-log', reqMgr, (req, res) => {
  const { user, action, since, until } = req.query;
  const limit = Math.min(Number(req.query.limit) || 500, 2000);

  let entries = (store.auditLog || []).slice();  // newest last in storage; we'll reverse for display

  if (user)   entries = entries.filter(e => e.user === user);
  if (action) entries = entries.filter(e => e.action === action);
  if (since)  entries = entries.filter(e => e.at >= since);
  if (until)  entries = entries.filter(e => e.at <= (until + 'T23:59:59'));

  // Newest first for display
  entries.reverse();
  const total = entries.length;
  entries = entries.slice(0, limit);

  // Distinct lists for filter dropdowns — show displayName, send username back as filter value
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

// ── API: FLEET (Drivers + Trucks admin) ──────────────────────────────────────
// Drivers live in the `users` table (companies/users seeded in initPg).
// Trucks live in the JSON store. Both share an id (the driver's username) so
// existing loads and history stay valid when drivers/trucks are renamed.

// Helper: list all driver-role users for the active company. Falls back to
// the legacy hardcoded USERS map when the DB isn't reachable so the dispatch
// board never goes blank.
function listDrivers() {
  // Hardcoded legacy fallback used when DB lookup fails.
  return Object.entries(USERS)
    .filter(([, u]) => u.role === 'driver')
    .map(([username, u]) => ({
      username,
      role: u.role,
      truckId: u.truckId || username,
      displayName: u.displayName || username,
      active: true,
    }));
}

async function listDriversFromDb(companyId) {
  if (!pg) return listDrivers();
  try {
    const r = await pg.query(
      `SELECT username, role, truck_id, display_name, active
         FROM users
        WHERE company_id = $1 AND role = 'driver'
        ORDER BY display_name`,
      [companyId]
    );
    return r.rows.map(row => ({
      username:    row.username,
      role:        row.role,
      truckId:     row.truck_id || row.username,
      displayName: row.display_name || row.username,
      active:      row.active !== false,
    }));
  } catch (e) {
    console.error('[listDriversFromDb] failed:', e.message);
    return listDrivers();
  }
}

// GET /api/fleet — admins only. Returns trucks + drivers.
app.get('/api/fleet', reqMgr, async (req, res) => {
  const cid = req.session.user.companyId || DEFAULT_COMPANY_ID;
  const drivers = await listDriversFromDb(cid);
  res.json({ trucks: store.trucks, drivers });
});

// ── Trucks CRUD ──
app.post('/api/trucks', reqMgr, async (req, res) => {
  const { id, label, truckNum } = req.body || {};
  const cleanId = String(id || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
  if (!cleanId)  return res.status(400).json({ error: 'id is required (e.g. "truck-7")' });
  if (!label)    return res.status(400).json({ error: 'label is required (driver display name)' });
  if (!truckNum) return res.status(400).json({ error: 'truckNum is required (e.g. "Truck #7")' });
  if (store.trucks.some(t => t.id === cleanId)) {
    return res.status(409).json({ error: 'A truck with that id already exists' });
  }
  const truck = { id: cleanId, label: String(label).trim(), truckNum: String(truckNum).trim(), active: true };
  store.trucks.push(truck);
  await saveData();
  logAction(req.session.user, 'created-truck', cleanId, { truck });
  res.json({ ok: true, truck });
});

app.put('/api/trucks/:id', reqMgr, async (req, res) => {
  const truck = store.trucks.find(t => t.id === req.params.id);
  if (!truck) return res.status(404).json({ error: 'Truck not found' });
  const before = { ...truck };
  if (req.body.label    !== undefined) truck.label    = String(req.body.label).trim();
  if (req.body.truckNum !== undefined) truck.truckNum = String(req.body.truckNum).trim();
  if (req.body.active   !== undefined) truck.active   = !!req.body.active;
  await saveData();
  logAction(req.session.user, 'updated-truck', truck.id, { before, after: truck });
  res.json({ ok: true, truck });
});

app.delete('/api/trucks/:id', reqMgr, async (req, res) => {
  const idx = store.trucks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Truck not found' });
  // Refuse to hard-delete if any non-voided load references this truck —
  // historical attribution would break. Soft-disable instead.
  const inUse = store.loads.some(l => l.truckId === req.params.id && !l.voided);
  if (inUse) {
    store.trucks[idx].active = false;
    await saveData();
    logAction(req.session.user, 'disabled-truck', req.params.id, { reason: 'in-use' });
    return res.json({ ok: true, softDeleted: true });
  }
  const removed = store.trucks.splice(idx, 1)[0];
  await saveData();
  logAction(req.session.user, 'deleted-truck', req.params.id, { removed });
  res.json({ ok: true });
});

// ── Drivers CRUD (writes the users table) ──
app.post('/api/drivers', reqMgr, async (req, res) => {
  if (!pg) return res.status(503).json({ error: 'Database not available' });
  const { username, password, displayName, truckId } = req.body || {};
  const uname = String(username || '').toLowerCase().trim();
  if (!uname || !/^[a-z0-9_.-]+$/.test(uname)) {
    return res.status(400).json({ error: 'username must be lowercase letters/numbers/_.-' });
  }
  if (!password || String(password).length < 4) {
    return res.status(400).json({ error: 'password must be at least 4 characters' });
  }
  const cid    = req.session.user.companyId || DEFAULT_COMPANY_ID;
  const userId = `user-${cid}-${uname}`;
  const tId    = String(truckId || uname);
  const dName  = String(displayName || '').trim() || (uname.charAt(0).toUpperCase() + uname.slice(1));
  try {
    const existing = await pg.query('SELECT 1 FROM users WHERE company_id=$1 AND username=$2', [cid, uname]);
    if (existing.rows.length) return res.status(409).json({ error: 'username already exists' });
    await pg.query(
      `INSERT INTO users (id, company_id, username, password, role, truck_id, display_name, active)
       VALUES ($1, $2, $3, $4, 'driver', $5, $6, true)`,
      [userId, cid, uname, password, tId, dName]
    );
    logAction(req.session.user, 'created-driver', uname, { displayName: dName, truckId: tId });
    const drivers = await listDriversFromDb(cid);
    res.json({ ok: true, drivers });
  } catch (e) {
    console.error('[POST /api/drivers]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/drivers/:username', reqMgr, async (req, res) => {
  if (!pg) return res.status(503).json({ error: 'Database not available' });
  const cid = req.session.user.companyId || DEFAULT_COMPANY_ID;
  const uname = String(req.params.username || '').toLowerCase();
  const { displayName, truckId, password, active } = req.body || {};
  const sets = [];
  const vals = [];
  let i = 1;
  if (displayName !== undefined) { sets.push(`display_name = $${i++}`); vals.push(String(displayName).trim()); }
  if (truckId     !== undefined) { sets.push(`truck_id     = $${i++}`); vals.push(String(truckId)); }
  if (active      !== undefined) { sets.push(`active       = $${i++}`); vals.push(!!active); }
  if (password    !== undefined && String(password).length >= 4) {
    sets.push(`password = $${i++}`); vals.push(String(password));
  }
  if (!sets.length) return res.status(400).json({ error: 'no fields to update' });
  vals.push(cid, uname);
  try {
    const r = await pg.query(
      `UPDATE users SET ${sets.join(', ')} WHERE company_id = $${i++} AND username = $${i++} RETURNING username`,
      vals
    );
    if (!r.rowCount) return res.status(404).json({ error: 'driver not found' });
    logAction(req.session.user, 'updated-driver', uname, { fields: Object.keys(req.body || {}) });
    const drivers = await listDriversFromDb(cid);
    res.json({ ok: true, drivers });
  } catch (e) {
    console.error('[PUT /api/drivers]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/drivers/:username', reqMgr, async (req, res) => {
  if (!pg) return res.status(503).json({ error: 'Database not available' });
  const cid = req.session.user.companyId || DEFAULT_COMPANY_ID;
  const uname = String(req.params.username || '').toLowerCase();
  // Soft-delete by default so any historical loads keep their driver
  // attribution. Hard delete only when ?hard=1 and the driver has no loads.
  try {
    if (req.query.hard === '1') {
      const inUse = store.loads.some(l => l.truckId === uname && !l.voided);
      if (inUse) return res.status(409).json({ error: 'driver has loads — disable instead of deleting' });
      const r = await pg.query('DELETE FROM users WHERE company_id=$1 AND username=$2', [cid, uname]);
      if (!r.rowCount) return res.status(404).json({ error: 'driver not found' });
      logAction(req.session.user, 'deleted-driver', uname, {});
    } else {
      const r = await pg.query('UPDATE users SET active=false WHERE company_id=$1 AND username=$2', [cid, uname]);
      if (!r.rowCount) return res.status(404).json({ error: 'driver not found' });
      logAction(req.session.user, 'disabled-driver', uname, {});
    }
    const drivers = await listDriversFromDb(cid);
    res.json({ ok: true, drivers });
  } catch (e) {
    console.error('[DELETE /api/drivers]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── API: CUSTOMER MASTER ────────────────────────────────────────────────────
// The Customer Master is the canonical list of customers used as a dropdown
// when creating POs. This prevents typos that fragment a single real customer
// into multiple billing/pricing/report entries (e.g. "ABC Concrete" vs
// "A.B.C Concrete" vs "ABC Conrete"). On first deploy normalizeStore()
// backfills the master from distinct customer names already used on POs.
//
// Note: Customer pricing in store.customerPrices is still keyed by
// customerKey(name). That stays the same — the dropdown just enforces a
// consistent name spelling so no two records collide.

app.get('/api/customers', reqMgr, (req, res) => {
  const customers = (store.customers || []).slice().sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''))
  );
  // Annotate each with usage stats so the admin UI can show "5 POs · 2 prices"
  const annotated = customers.map(c => {
    const lc = String(c.name || '').toLowerCase().trim();
    const poCount = store.pos.filter(p => String(p.customer || '').toLowerCase().trim() === lc).length;
    const priceCount = (store.customerPrices?.[lc] || []).length;
    return { ...c, poCount, priceCount };
  });
  res.json({ customers: annotated });
});

app.post('/api/customers', reqMgr, async (req, res) => {
  const { name, code, address, city, phone, email, notes } = req.body;
  const trimmed = String(name || '').trim();
  if (!trimmed) return res.status(400).json({ error: 'Customer name required' });
  // Reject duplicates (case-insensitive). This is the whole point of the master.
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
  logAction(req.session.user, 'created-customer', newCust.id, { name: newCust.name });
  await saveData();
  res.json({ success: true, customer: newCust });
});

app.put('/api/customers/:id', reqMgr, async (req, res) => {
  const c = (store.customers || []).find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  const oldName = c.name;
  const newName = req.body.name !== undefined ? String(req.body.name).trim() : c.name;
  // If the name is being changed, refuse if the new name collides with another customer
  if (newName.toLowerCase() !== c.name.toLowerCase()) {
    if ((store.customers || []).some(x => x.id !== c.id && String(x.name || '').toLowerCase().trim() === newName.toLowerCase())) {
      return res.status(400).json({ error: 'Another customer already has that name' });
    }
    if (!newName) return res.status(400).json({ error: 'Customer name required' });
  }
  // Apply changes
  c.name = newName;
  if (req.body.code    !== undefined) c.code    = String(req.body.code    || '').trim();
  if (req.body.address !== undefined) c.address = String(req.body.address || '').trim();
  if (req.body.city    !== undefined) c.city    = String(req.body.city    || '').trim();
  if (req.body.phone   !== undefined) c.phone   = String(req.body.phone   || '').trim();
  if (req.body.email   !== undefined) c.email   = String(req.body.email   || '').trim();
  if (req.body.notes   !== undefined) c.notes   = String(req.body.notes   || '').trim();
  if (req.body.active  !== undefined) c.active  = !!req.body.active;
  // If the name changed, propagate to existing POs and re-key any pricing.
  // POs store the customer NAME (so all the existing pricing/billing/reports
  // code works unchanged), and pricing tables key by lowercased name. So a
  // rename has to update both: rewrite po.customer on every PO, and re-key
  // store.customerPrices.
  if (newName !== oldName) {
    let renamed = 0;
    store.pos.forEach(p => {
      if (String(p.customer || '').toLowerCase().trim() === oldName.toLowerCase().trim()) {
        p.customer = newName;
        if (p.job === oldName) p.job = newName;
        renamed++;
      }
    });
    // Loads cache the customer via po.customer at render time, but archives
    // store snapshots. Update those too for consistency.
    (store.archive || []).forEach(b => {
      (b.pos || []).forEach(p => {
        if (String(p.customer || '').toLowerCase().trim() === oldName.toLowerCase().trim()) {
          p.customer = newName;
          if (p.job === oldName) p.job = newName;
        }
      });
    });
    // Re-key customerPrices
    const oldKey = oldName.toLowerCase().trim();
    const newKey = newName.toLowerCase().trim();
    if (oldKey !== newKey && store.customerPrices?.[oldKey]) {
      store.customerPrices[newKey] = (store.customerPrices[newKey] || []).concat(store.customerPrices[oldKey]);
      delete store.customerPrices[oldKey];
    }
    logAction(req.session.user, 'renamed-customer', c.id, { from: oldName, to: newName, posUpdated: renamed });
  } else {
    logAction(req.session.user, 'updated-customer', c.id, { name: c.name, changes: Object.keys(req.body) });
  }
  await saveData();
  res.json({ success: true, customer: c });
});

app.delete('/api/customers/:id', reqMgr, async (req, res) => {
  const idx = (store.customers || []).findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Customer not found' });
  const c = store.customers[idx];
  // Refuse if this customer is referenced by any non-archived POs.
  const lc = String(c.name || '').toLowerCase().trim();
  const linkedPos = store.pos.filter(p => String(p.customer || '').toLowerCase().trim() === lc).length;
  if (linkedPos > 0) {
    return res.status(403).json({ error: `Cannot delete — ${linkedPos} active PO${linkedPos===1?'':'s'} reference this customer. Mark inactive instead.` });
  }
  store.customers.splice(idx, 1);
  // Drop pricing rows tied to this customer
  if (store.customerPrices?.[lc]) delete store.customerPrices[lc];
  logAction(req.session.user, 'deleted-customer', c.id, { name: c.name });
  await saveData();
  res.json({ success: true });
});

// ── API: CUSTOMER PRICING ────────────────────────────────────────────────────
// Get all customer prices (manager+admin)
app.get('/api/customer-prices', reqMgr, (req, res) => {
  // Build a sorted list of customers with their price arrays
  const customers = Object.entries(store.customerPrices || {})
    .map(([key, prices]) => {
      // Find display name (capitalized) from existing POs that match this customer key
      const samplePo = store.pos.find(p => customerKey(p.customer) === key);
      const displayName = samplePo?.customer || key;
      return { key, displayName, prices };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  // Also list customers from existing POs that don't yet have prices set (for the dropdown)
  const allPoCustomers = [...new Set(store.pos.map(p => p.customer).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  res.json({ customers, allPoCustomers, defaultRates: store.defaultRates });
});

// Add a customer price row
app.post('/api/customer-prices', reqMgr, async (req, res) => {
  const { customer, material, unit, price, notes } = req.body;
  if (!customer || !customer.trim()) return res.status(400).json({ error: 'Customer name required' });
  if (!material || !material.trim()) return res.status(400).json({ error: 'Material required' });

  const key = customerKey(customer);
  if (!Array.isArray(store.customerPrices[key])) store.customerPrices[key] = [];

  // Reject duplicates (same material+unit on same customer)
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
  });
  await saveData();
  res.json({ success: true, price: newPrice, customer: customer.trim() });
});

// Update a customer price row
app.put('/api/customer-prices/:customerKey/:priceId', reqMgr, async (req, res) => {
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
    });
  }
  await saveData();
  res.json({ success: true, price: p });
});

// Delete a customer price row
app.delete('/api/customer-prices/:customerKey/:priceId', reqMgr, async (req, res) => {
  const list = store.customerPrices[req.params.customerKey];
  if (!list) return res.status(404).json({ error: 'Customer not found' });
  const idx = list.findIndex(x => x.id === req.params.priceId);
  if (idx === -1) return res.status(404).json({ error: 'Price not found' });
  const deleted = list[idx];
  list.splice(idx, 1);
  // Clean up empty customer entry
  if (list.length === 0) delete store.customerPrices[req.params.customerKey];
  logAction(req.session.user, 'deleted-customer-price', req.params.customerKey + ':' + deleted.id, {
    customerKey: req.params.customerKey, material: deleted.material, price: deleted.price,
  });
  await saveData();
  res.json({ success: true });
});

// ── API: DEFAULT RATES (admin-only) ─────────────────────────────────────────
app.get('/api/default-rates', reqMgr, (req, res) => {
  res.json({ defaultRates: store.defaultRates, materials: MATERIALS });
});

app.put('/api/default-rates', reqAdmin, async (req, res) => {
  const { side, material, unit, price } = req.body;  // side: 'customer' | 'vendor'
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
  });
  await saveData();
  res.json({ success: true, defaultRates: store.defaultRates });
});

// ── API: PRICING PREVIEW (for PO modal — show rate before saving) ────────────
// GET /api/pricing-preview?customer=Wilson%20Homes&material=3/4%20Rock&vendorId=vulcan
app.get('/api/pricing-preview', reqMgr, (req, res) => {
  const { customer, material, vendorId } = req.query;
  if (!customer || !material) return res.status(400).json({ error: 'customer and material required' });

  const cust = resolveCustomerRate(customer, material);
  const vend = resolveVendorRate(vendorId || '', material);
  const tons = TONS_PER_LOAD;

  // Compute per-load revenue, cost, margin (assuming 1 load, 25 tons)
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
// Computes average duration breakdowns from driver timestamps. Used by Admin to
// see which yards/jobsites/materials/drivers are eating the most time.
//
// Five duration intervals per load (all in MINUTES, only included when both
// endpoints are recorded):
//   startToYard      = arrivedPickup  - start
//   yardService      = loadedAt       - arrivedPickup    ← key for yard ranking
//   yardToJobsite    = arrivedJobsite - loadedAt
//   jobsiteService   = completed      - arrivedJobsite
//   total            = completed      - start
//
// Filters (all optional, all combinable):
//   ?from=YYYY-MM-DD   only loads with deliveryDate >= from
//   ?to=YYYY-MM-DD     only loads with deliveryDate <= to
//   ?driver=truckId    only loads dispatched to that driver
//   ?yard=vendorId     only loads where ACTUAL yard (or planned vendor) matches
//   ?customer=name     case-insensitive exact match against po.customer
//   ?city=name         case-insensitive exact match against po.city
//   ?material=name     exact match against load.material
//   ?po=poNumber       exact match against po.poNumber
//   ?status=...        approval status (approved | submitted | rejected | pending)
//
// Returns aggregations grouped by yard, customer, jobcode, city, material,
// driver — each with avg / median / p90 / count / min / max minutes for every
// duration interval. Also returns slowest/fastest yard leaderboards on the
// yardService interval.
app.get('/api/duration-analytics', reqMgr, (req, res) => {
  const { from, to, driver, yard, customer, city, material, po, status } = req.query;

  // Pull from active store + archive so historical months still count
  const archivedLoads = (store.archive || []).flatMap(b => b.loads || []);
  const allLoads = [...store.loads, ...archivedLoads];
  const lcEq = (a, b) => String(a || '').toLowerCase().trim() === String(b || '').toLowerCase().trim();

  // Apply filters
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

  // Compute per-load durations in minutes. Returns null when an interval can't
  // be computed (missing endpoint).
  const durationsForLoad = (l) => {
    const iso = l.isoStamps || {};
    const ts  = l.timestamps || {};
    const baseDate = l.deliveryDate || '';

    // Get a Date for a step. Prefer the ISO stamp (accurate). Fall back to
    // parsing the display string against the load's deliveryDate, which is
    // best-effort for legacy loads (pre-isoStamps).
    const at = (key) => {
      if (iso[key]) return new Date(iso[key]);
      if (ts[key] && baseDate) {
        // ts[key] looks like "02:34 PM" — combine with the load's date
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
      let d = (b - a) / 60000;  // ms → minutes
      // If the trip rolled past midnight using legacy display-only stamps, b may
      // appear earlier than a — add a day. Only do this for legacy fallback;
      // ISO stamps don't have this issue.
      if (d < 0 && d > -1440 && !iso[Object.keys(iso)[0]]) d += 1440;
      return d > 0 ? Math.round(d * 10) / 10 : null;  // drop nonsensical negatives
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

  // Aggregate helper — given a list of numbers, compute count/avg/median/p90/min/max
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

  // Group loads by an arbitrary key fn, returning aggregations per group + per
  // duration interval.
  const groupBy = (keyFn, labelFn = (k) => k) => {
    const buckets = new Map();
    matched.forEach(l => {
      const k = keyFn(l);
      if (!k) return;  // skip loads with no group identity (e.g. no driver)
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
    const t = store.trucks.find(x => x.id === id);
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

  // Slowest / fastest yards on yard service time (only yards with ≥3 loads
  // for stat stability)
  const yardsWithEnough = byYard.filter(g => g.yardService.count >= 3);
  const slowestYards = [...yardsWithEnough].sort((a, b) => (b.yardService.avg || 0) - (a.yardService.avg || 0)).slice(0, 5);
  const fastestYards = [...yardsWithEnough].sort((a, b) => (a.yardService.avg || 0) - (b.yardService.avg || 0)).slice(0, 5);
  const slowestJobsites = byCustomer
    .filter(g => g.jobsiteService.count >= 3)
    .sort((a, b) => (b.jobsiteService.avg || 0) - (a.jobsiteService.avg || 0))
    .slice(0, 5);

  // Overall summary on the matched set
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
// Returns revenue / cost / margin breakdown by customer, by job code, by load
// Optional filter: ?month=YYYY-MM (defaults to all-time)
// Only counts loads that have actually been delivered (loadsDelivered > 0)
app.get('/api/profitability', reqMgr, (req, res) => {
  const monthFilter = req.query.month || '';

  // Active store + archived loads — both count for historical profitability
  const archivedLoads = (store.archive || []).flatMap(b => b.loads || []);
  const allLoads = [...store.loads, ...archivedLoads];
  const allPos   = [...store.pos,   ...((store.archive || []).flatMap(b => b.pos || []))];

  let eligible = allLoads.filter(l => {
    if (l.voided) return false;
    if (Number(l.loadsDelivered || 0) <= 0) return false;
    if (monthFilter && !(l.deliveryDate || '').startsWith(monthFilter)) return false;
    return true;
  });

  // Aggregations
  const byCustomer = {};   // { customerKey: { displayName, loads, revenue, cost, margin } }
  const byJobCode  = {};   // similar but keyed by jobCode (skip blanks)
  const byVendor   = {};   // { vendorId: { name, loads, revenue, cost, margin, ... } }
  const topLoads   = [];   // each: { id, poNumber, customer, material, driver, delivered, rev, cost, margin }
  let grandRev = 0, grandCost = 0, grandLoads = 0;

  eligible.forEach(l => {
    const po = allPos.find(p => p.id === l.poId) || {};
    const rev    = computeRevenue(l);
    const cost   = computeCost(l);
    const margin = rev - cost;

    grandRev   += rev;
    grandCost  += cost;
    grandLoads += Number(l.loadsDelivered) || 0;

    // By customer
    const custKey = customerKey(po.customer || '');
    if (custKey) {
      if (!byCustomer[custKey]) byCustomer[custKey] = { displayName: po.customer, loads: 0, revenue: 0, cost: 0, margin: 0 };
      byCustomer[custKey].loads   += Number(l.loadsDelivered) || 0;
      byCustomer[custKey].revenue += rev;
      byCustomer[custKey].cost    += cost;
      byCustomer[custKey].margin  += margin;
    }

    // By job code (only if PO has one)
    if (po.jobCode) {
      const jcKey = po.jobCode;
      if (!byJobCode[jcKey]) byJobCode[jcKey] = { jobCode: po.jobCode, customer: po.customer || '', loads: 0, revenue: 0, cost: 0, margin: 0 };
      byJobCode[jcKey].loads   += Number(l.loadsDelivered) || 0;
      byJobCode[jcKey].revenue += rev;
      byJobCode[jcKey].cost    += cost;
      byJobCode[jcKey].margin  += margin;
    }

    // By vendor (where the cost goes — payables)
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

    // Individual load entry (for top/bottom load lists)
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

  // Sort top/bottom (top 10 most profitable, bottom 10 least)
  const sortedByMargin = [...topLoads].sort((a, b) => b.margin - a.margin);
  const topByMargin = sortedByMargin.slice(0, 10);
  const bottomByMargin = sortedByMargin.slice(-10).reverse();

  // Available month options for filter
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

// ── API: VENDOR / MATERIAL COSTS (payables — what VBT owes outside vendors) ─
// Returns totals broken down by vendor. VBT Yard is excluded (internal inventory, no cost).
app.get('/api/material-costs', reqMgr, (req, res) => {
  // Filter by month if supplied (YYYY-MM), otherwise all-time
  const monthFilter = req.query.month || '';

  // We use the ACTUAL pickup yard (where the driver said they went) as the cost source.
  // If the driver hasn't arrived yet, fall back to the PO's planned vendor.
  const eligible = store.loads.filter(l => {
    if (l.voided) return false;
    if (monthFilter && !(l.deliveryDate || '').startsWith(monthFilter)) return false;
    return true;
  });

  // Build per-vendor totals
  const byVendor = {};   // { vendorId: { name, totalLoads, totalCost, byMaterial: { mat: { loads, cost } } } }

  eligible.forEach(l => {
    // Determine which vendor this load was picked up from
    const vendorId = l.actualYardId || l.vendorId || (store.pos.find(p => p.id === l.poId) || {}).plannedVendorId;
    if (!vendorId) return;
    if (vendorId === 'vbt') return;  // VBT Yard = internal, no cost

    const v = store.vendors.find(x => x.id === vendorId);
    if (!v) return;

    if (!byVendor[vendorId]) {
      byVendor[vendorId] = { name: v.name, location: v.location, totalLoads: 0, totalCost: 0, byMaterial: {} };
    }
    const delivered = Number(l.loadsDelivered) || 0;
    if (delivered === 0) return;  // only count loads actually delivered (so cost is real)

    // Find the vendor's price for this material at the time it was used
    let unitPrice = 0;
    let unit = '';
    if (l.pricePerUnit !== undefined && l.pricePerUnit !== null) {
      // Snapshot saved at PO creation
      unitPrice = Number(l.pricePerUnit) || 0;
      unit = l.unit || '';
    } else {
      // Fall back to current vendor price table
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

  // List of available months (for filter dropdown)
  const months = [...new Set(store.loads.map(l => (l.deliveryDate || '').slice(0, 7)).filter(Boolean))].sort().reverse();

  // Grand total
  const grandTotal = Object.values(byVendor).reduce((s, v) => s + v.totalCost, 0);
  const grandLoads = Object.values(byVendor).reduce((s, v) => s + v.totalLoads, 0);

  res.json({
    vendors: byVendor,
    months,
    monthFilter,
    grandTotal,
    grandLoads
  });
});

// ── PO STATUS RECONCILIATION ─────────────────────────────────────────────────
// Walks through every PO and corrects its status based on the actual state of its loads.
// Returns the list of POs that got fixed.
function reconcilePoStatuses() {
  const fixed = [];
  store.pos.forEach(p => {
    const linked = store.loads.filter(l => l.poId === p.id && !l.voided);
    if (linked.length === 0) {
      // PO has no live loads — leave its status alone
      return;
    }
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
  // Self-heal stale PO statuses (POs that should be 'completed' but stuck on 'active')
  const fixed = reconcilePoStatuses();
  if (fixed.length) {
    console.log(`[reports] Reconciled ${fixed.length} stale PO statuses:`, fixed);
    await saveData();
  }

  // Driver performance
  const driverStats = {};
  store.trucks.forEach(t => {
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

  // Customer volume
  const custStats = {};
  store.pos.forEach(p => {
    if (!custStats[p.customer]) custStats[p.customer] = { pos: 0, loads: 0, delivered: 0 };
    custStats[p.customer].pos++;
    const pLoads = store.loads.filter(l => l.poId === p.id);
    custStats[p.customer].loads     += pLoads.reduce((s, l) => s + (Number(l.loadsAssigned) || 0), 0);
    custStats[p.customer].delivered += pLoads.reduce((s, l) => s + (Number(l.loadsDelivered) || 0), 0);
  });

  // Material breakdown
  const matStats = {};
  store.loads.forEach(l => {
    if (l.voided) return;
    if (!matStats[l.material]) matStats[l.material] = { ordered: 0, delivered: 0 };
    matStats[l.material].ordered   += Number(l.loadsAssigned) || 0;
    matStats[l.material].delivered += Number(l.loadsDelivered) || 0;
  });

  // Weekly trend (last 8 weeks)
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

  // Totals
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

// ── API: HISTORY (billed loads, ready to archive) ───────────────────────────
app.get('/api/history', reqMgr, (req, res) => {
  // Loads that are billed (waiting to be archived)
  const billed = store.loads.filter(l => l.billStatus === 'billed' && !l.voided)
    .map(l => {
      const po = store.pos.find(p => p.id === l.poId) || {};
      return { ...l, poNumber: po.poNumber, customer: po.customer, city: po.city, address: po.address, pickup: po.pickup };
    });
  res.json({ billed, archive: store.archive });
});

// Archive billed loads → push to Sheets and remove from active store
app.post('/api/history/archive', reqMgr, async (req, res) => {
  const billed = store.loads.filter(l => l.billStatus === 'billed' && !l.voided);
  if (!billed.length) return res.status(400).json({ error: 'No billed loads to archive' });

  const billedPoIds = new Set(billed.map(l => l.poId));
  // Only archive POs whose ALL loads are billed (otherwise leave the PO active)
  const fullyBilledPos = [...billedPoIds].filter(pid => {
    const all = store.loads.filter(l => l.poId === pid && !l.voided);
    return all.length > 0 && all.every(l => l.billStatus === 'billed');
  });
  const archivedPos = store.pos.filter(p => fullyBilledPos.includes(p.id));

  // Try to push to Sheets first — only delete if it succeeds
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
      // Append (don't clear) so history accumulates over time
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'Archive!A1',
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: archiveRows },
      }).catch(async err => {
        // If tab doesn't exist, create it then retry
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

  // Move archived data to archive[] for in-app reference
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
  });
  // Cap archive log at 50 batches
  if (store.archive.length > 50) store.archive = store.archive.slice(0, 50);

  // Remove archived loads + their fully-completed POs from the active store
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
  if (!sheets) return res.status(503).json({ error: 'Sheets not configured' });
  try {
    // POs sheet
    const poRows = [['PO Number', 'Customer', 'Job', 'Address', 'City', 'Delivery Date', 'Status', 'Created']];
    store.pos.forEach(p => poRows.push([p.poNumber, p.customer, p.job, p.address, p.city, p.deliveryDate, p.status, p.createdAt]));
    await writeSheet('POs', poRows);

    // Loads sheet
    const loadRows = [['Load ID', 'PO Number', 'Material', 'Driver', 'Truck', 'Loads Assigned', 'Loads Delivered', 'Date', 'Status', 'Approval', 'Bill Status', 'Submitted', 'Approved By']];
    store.loads.forEach(l => {
      const po = store.pos.find(p => p.id === l.poId) || {};
      loadRows.push([l.id, po.poNumber || '', l.material, l.driverName, l.truckId, l.loadsAssigned, l.loadsDelivered, l.deliveryDate, l.status, l.approvalStatus, l.billStatus, l.submittedAt, l.approvedBy]);
    });
    await writeSheet('Loads', loadRows);

    logAction(req.session.user, 'synced-sheets', '', {
      pos: store.pos.length,
      loads: store.loads.length,
    });
    res.json({ success: true, pos: store.pos.length, loads: store.loads.length });
  } catch (e) {
    console.error('Sync error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

async function writeSheet(tab, rows) {
  // Make sure tab exists
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] }
    });
  } catch (e) { /* tab already exists */ }
  // Clear and write
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
  await seedDefaultCompanyAndUsers();
  await loadData();
  app.listen(PORT, () => {
    console.log(`VBT Dispatch on port ${PORT}`);
    if (!pg) console.warn('⚠ No Postgres — data will reset on redeploy');
  });
})();
