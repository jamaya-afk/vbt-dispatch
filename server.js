// VBT Dispatch — Clean Build
// Core scope: Login, POs, Board, Driver guided flow, Approvals, Ready to Bill, Sheets sync
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const IS_PROD = process.env.NODE_ENV === 'production';

// ── REQUIRED SECRETS ─────────────────────────────────────────────────────────
// Production refuses to boot without these. There are deliberately no
// fallback values anywhere in the source: a known default session secret lets
// anyone forge a login cookie, a known default encryption key makes the stored
// QuickBooks tokens readable, and a missing DATABASE_URL would silently write
// the day's dispatch to a disk Railway wipes on the next deploy.
const REQUIRED_PROD_SECRETS = {
  DATABASE_URL:      'Postgres connection string — the only durable store',
  SESSION_SECRET:    'signs login cookies (any long random string)',
  QB_ENCRYPTION_KEY: 'encrypts QuickBooks OAuth tokens at rest (any long random string)',
};
if (IS_PROD) {
  const missing = Object.keys(REQUIRED_PROD_SECRETS).filter(k => !String(process.env[k] || '').trim());
  if (missing.length) {
    console.error('FATAL: required production secrets are not set:');
    for (const k of missing) console.error(`  ${k.padEnd(18)} — ${REQUIRED_PROD_SECRETS[k]}`);
    console.error('Set them in the Railway service variables and redeploy.');
    process.exit(1);
  }
}
// Dev only: a per-process random value, never a literal in the source.
// Sessions and dev-only QuickBooks tokens reset on each restart, which is fine
// locally and impossible in production because of the guard above.
if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('⚠ SESSION_SECRET not set — using a random per-process value (dev only; sessions reset on restart).');
}
if (!process.env.QB_ENCRYPTION_KEY) {
  process.env.QB_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  console.warn('⚠ QB_ENCRYPTION_KEY not set — using a random per-process value (dev only; QuickBooks tokens reset on restart).');
}

const qb = require('./qb');
const mailer = require('./mailer');

const app = express();

// ── ASYNC ROUTE SAFETY ───────────────────────────────────────────────────────
// Express 4 does not catch a rejected promise from an async handler: the
// request hangs forever and the caller sees nothing, while the in-memory
// store may already be half-changed. Every handler registered through
// app.<verb>() is wrapped here once, centrally, so a throw becomes next(err)
// and the error middleware at the bottom answers with a real 500.
// test-e2e.sh section 20 fails if this block is removed.
function wrapAsyncHandler(fn) {
  if (Array.isArray(fn)) return fn.map(wrapAsyncHandler);
  if (typeof fn !== 'function' || fn.length === 4) return fn;   // error middleware stays as-is
  return function asyncSafe(req, res, next) {
    let out;
    try { out = fn(req, res, next); } catch (e) { return next(e); }
    if (out && typeof out.then === 'function') out.then(undefined, next);
  };
}
for (const verb of ['get', 'post', 'put', 'delete', 'patch', 'all']) {
  const original = app[verb].bind(app);
  app[verb] = function (pathArg, ...handlers) {
    if (verb === 'get' && handlers.length === 0) return original(pathArg);   // app.get('setting name')
    return original(pathArg, ...handlers.map(wrapAsyncHandler));
  };
}

app.use(express.json({
  limit: '25mb',
}));
app.use(express.urlencoded({ extended: true }));

// ── SESSION (Postgres-backed when DATABASE_URL is set) ───────────────────────
const sessionOpts = {
  secret: process.env.SESSION_SECRET,
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7, httpOnly: true, sameSite: 'lax' }
};
// Railway/Supabase Postgres needs TLS; a local test database does not.
// `?sslmode=disable` in DATABASE_URL (or PGSSL=disable) turns it off.
function pgSsl() {
  const url = String(process.env.DATABASE_URL || '');
  if (process.env.PGSSL === 'disable' || /sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}
let sessionPool = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    sessionPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: pgSsl(),
      connectionTimeoutMillis: 10000,   // never hang boot forever on a dead host
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

// ── SINGLE COMPANY ───────────────────────────────────────────────────────────
// This is Valley Best's own internal system. There is no multi-tenancy, no
// signup, no subscriptions and no Stripe — all of that was removed
// deliberately. There is exactly one operation and one dataset.
//
// The users table still carries a company_id column because it holds real
// driver logins and dropping a column from a live table risks losing them.
// It is pinned to the single constant below and is never varied.

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

// LEGACY NAMING: `TRUCKS` is really the DRIVER roster — `id` is the driver's
// login and `load.truckId` points at a driver, not a vehicle. Renaming that
// field would touch a hundred call sites and every saved load, so it stays.
// The real vehicle fleet lives in `store.trucks` (see DEFAULT_TRUCKS below)
// and a load's vehicle is `load.truckUnitId`.
const TRUCKS = [
  { id: 'beryle',   label: 'Beryle',   truckNum: 'Truck #2'  },
  { id: 'matthew',  label: 'Matthew',  truckNum: 'Truck #4'  },
  { id: 'rigo',     label: 'Rigo',     truckNum: 'Truck #14' },
  { id: 'leonardo', label: 'Leonardo', truckNum: 'Truck #12' },
  { id: 'carlos',   label: 'Carlos',   truckNum: 'Truck #2B' },
];

// ── FLEET — real vehicles, independent of drivers ────────────────────────────
// Seeded once from the five trucks Valley Best already runs, preserving each
// truck number and its historical driver. After seeding these are ordinary
// editable records: any driver can take any truck.
const DEFAULT_TRUCKS = [
  { id: 'truck-2',   truckNum: 'Truck #2',   type: 'End Dump',   status: 'available', defaultDriverId: 'beryle',   mileage: null, maintenanceNotes: '', active: true },
  { id: 'truck-4',   truckNum: 'Truck #4',   type: 'End Dump',   status: 'available', defaultDriverId: 'matthew',  mileage: null, maintenanceNotes: '', active: true },
  { id: 'truck-14',  truckNum: 'Truck #14',  type: 'End Dump',   status: 'available', defaultDriverId: 'rigo',     mileage: null, maintenanceNotes: '', active: true },
  { id: 'truck-12',  truckNum: 'Truck #12',  type: 'End Dump',   status: 'available', defaultDriverId: 'leonardo', mileage: null, maintenanceNotes: '', active: true },
  { id: 'truck-2b',  truckNum: 'Truck #2B',  type: 'End Dump',   status: 'available', defaultDriverId: 'carlos',   mileage: null, maintenanceNotes: '', active: true },
];

const TRUCK_STATUSES  = ['available', 'in-service', 'maintenance', 'out-of-service'];
const DRIVER_STATUSES = ['available', 'working', 'off'];

// The DRIVER roster in the legacy `{ id, label, truckNum }` shape the UI's
// Driver dropdown still expects. Kept separate from store.trucks, which is the
// vehicle fleet — conflating the two is what put truck ids in the driver
// picker and left driverName blank on every new load.
function driverRoster() {
  const fleet = store.trucks || [];
  const src = (store.drivers || []).filter(d => d.active !== false);
  if (!src.length) return TRUCKS.map(t => ({ ...t, active: true }));
  return src.map(d => {
    const t = fleet.find(x => x.id === d.defaultTruckId);
    return { id: d.id, label: d.name || d.id, truckNum: t ? t.truckNum : '', active: true };
  });
}

// ONE driver roster. store.drivers is the dispatch source of truth (name,
// default truck, status, active); the Postgres users table only holds the
// login for that same id (users.truck_id === driver id === load.truckId).
// Everything that names a driver — Drivers & Trucks, Quick Assign, PO
// creation, assignment validation, driver login — resolves through here.
function rosterDriver(id) {
  return (store.drivers || []).find(d => d.id === id) || null;
}
function upsertRosterDriver({ id, name, defaultTruckId, active, status, phone, notes }) {
  if (!Array.isArray(store.drivers)) store.drivers = [];
  let d = rosterDriver(id);
  if (!d) {
    d = { id, name: name || id, login: id, phone: '', status: 'available', defaultTruckId: null, active: true, notes: '' };
    store.drivers.push(d);
  }
  if (name !== undefined && String(name).trim()) d.name = String(name).trim();
  if (defaultTruckId !== undefined) d.defaultTruckId = defaultTruckId || null;
  if (active !== undefined) d.active = !!active;
  if (status !== undefined && DRIVER_STATUSES.includes(status)) d.status = status;
  if (phone !== undefined) d.phone = phone;
  if (notes !== undefined) d.notes = notes;
  return d;
}
// Roster + login state, for the Drivers & Trucks screen.
async function fleetDrivers() {
  const logins = new Map();
  if (pg) {
    try {
      const r = await pg.query(`SELECT username, truck_id, active FROM users WHERE company_id = $1 AND role = 'driver'`, [DEFAULT_COMPANY_ID]);
      r.rows.forEach(row => logins.set(row.truck_id || row.username, { username: row.username, active: row.active !== false }));
    } catch (e) { console.error('[fleetDrivers] users lookup failed:', e.message); }
  }
  return (store.drivers || []).map(d => {
    const login = logins.get(d.id);
    return {
      id: d.id, username: d.id, displayName: d.name || d.id,
      defaultTruckId: d.defaultTruckId || null, status: d.status || 'available',
      active: d.active !== false, phone: d.phone || '', notes: d.notes || '',
      hasLogin: !!login, loginActive: login ? login.active : false,
    };
  });
}

// The truck a load is running on. Falls back to the driver's historical truck
// so loads created before the fleet existed still show the right vehicle.
function getTruckForLoad(l) {
  if (!l) return null;
  const fleet = store.trucks || [];
  if (l.truckUnitId) {
    const t = fleet.find(x => x.id === l.truckUnitId);
    if (t) return t;
  }
  // No fallback to the driver's usual truck: showing a truck number the
  // dispatcher never assigned is worse than showing none.
  return null;
}

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
    { id: 'v1', material: '3/4 Rock',   unit: 'TON', price: 38, active: true, notes: '' },
    { id: 'v2', material: 'Base Rock',  unit: 'TON', price: 22, active: true, notes: '' },
    { id: 'v3', material: 'Sand',       unit: 'TON', price: 28, active: true, notes: '' },
  ],
  teichert: [
    { id: 't1', material: 'Fill Sand',  unit: 'TON', price: 18, active: true, notes: '' },
    { id: 't2', material: 'Gravel',     unit: 'TON', price: 32, active: true, notes: '' },
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
    { id: 'k1', material: 'Fill Sand',  unit: 'TON', price: 16, active: true, notes: '' },
    { id: 'k2', material: 'Recycle Base', unit: 'TON', price: 14, active: true, notes: '' },
  ],
  hanson: [
    { id: 'h1', material: 'Rock',       unit: 'TON', price: 32, active: true, notes: '' },
  ],
  vbt: [
    { id: 'vb1', material: 'Dirt',      unit: 'TON', price: 0, active: true, notes: 'Internal yard' },
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
    persistence.mode = 'file';
    persistence.durable = false;
    console.warn('⚠ No DATABASE_URL — dev mode, using file storage (data resets on redeploy!)');
    return;
  }
  try {
    if (!sessionPool) {
      const { Pool } = require('pg');
      pg = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: pgSsl(),
        connectionTimeoutMillis: 10000,
      });
    } else {
      pg = sessionPool;  // reuse same pool
    }
    await pg.query('SELECT 1');
    await pg.query(`CREATE TABLE IF NOT EXISTS dispatch_data (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    // Additive only: lets /api/admin/backups show when each restore point was written.
    await pg.query(`ALTER TABLE dispatch_data ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`);

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
    persistence.mode = 'postgres';
    persistence.durable = true;
    console.log('✓ Postgres connected — Valley Best data is durable');
  } catch (e) {
    console.error('✗ Postgres connection failed:', e.message);
    persistence.mode = 'file';
    persistence.durable = false;
    persistence.lastError = e.message;
    persistence.degradedSince = new Date().toISOString();
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

// A store row must be a JSON object. Anything else (bad JSON, an array, a
// string) means the row is damaged and must NOT be silently replaced.
function parseStoreRow(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('store row is not a JSON object');
  return parsed;
}

// Load the store. `persistence.loaded` becomes true ONLY after an existing
// store row was read and validated, or after the database was proven to be
// genuinely empty (no store row AND no backup rows). A successful connection
// is not a successful load: if the read fails for any reason the process
// stays in a locked state where saveData() refuses to write, so a transient
// read error can never turn into "seed an empty store over production".
async function loadData() {
  persistence.loaded = false;
  persistence.loadError = '';
  if (pg) {
    const r = await pg.query("SELECT value FROM dispatch_data WHERE key='store'");
    if (r.rows.length) {
      store = parseStoreRow(r.rows[0].value);
      normalizeStore();
      persistence.loaded = true;
      console.log(`✓ Loaded from Postgres: ${store.pos.length} POs, ${store.loads.length} loads`);
      return;
    }
    // No store row. Before treating this as a brand-new database, make sure
    // there is no backup row either — a missing store next to an existing
    // backup means the row was lost, not that the company is new.
    const backups = await pg.query("SELECT key FROM dispatch_data WHERE key LIKE 'store_%'");
    if (backups.rows.length) {
      throw new Error(`'store' row is missing but backups exist (${backups.rows.map(x => x.key).join(', ')}) — refusing to seed. Restore a backup instead.`);
    }
    // Genuinely empty database: seed defaults, and in dev migrate data.json.
    if (!IS_PROD && fs.existsSync(DATA_FILE)) {
      try {
        store = parseStoreRow(fs.readFileSync(DATA_FILE, 'utf8'));
        normalizeStore();
        persistence.loaded = true;
        await saveData();
        console.log(`✓ Migrated data.json to Postgres: ${store.pos.length} POs`);
        return;
      } catch (e) { console.warn('File read error (ignored, DB is empty):', e.message); }
    }
    normalizeStore();
    persistence.loaded = true;
    console.log('✓ Empty database — seeded defaults (no store row, no backups)');
    return;
  }
  // File mode — DEV ONLY (production exits at boot without DATABASE_URL).
  if (fs.existsSync(DATA_FILE)) {
    store = parseStoreRow(fs.readFileSync(DATA_FILE, 'utf8'));
    normalizeStore();
    persistence.loaded = true;
    console.log(`✓ Loaded from file: ${store.pos.length} POs`);
    return;
  }
  normalizeStore();
  persistence.loaded = true;
}

// One extra restore point that a couple of quick saves cannot rotate away:
// the store exactly as it was when this process booted. Written once, after
// a successful load, never on a locked process.
async function snapshotBootStore() {
  if (!pg || !persistence.loaded) return;
  try {
    await pg.query(`
      INSERT INTO dispatch_data(key, value, updated_at)
      SELECT 'store_boot', value, now() FROM dispatch_data WHERE key = 'store'
      ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `);
  } catch (e) { console.warn('store_boot snapshot skipped:', e.message); }
}

const RESTORE_KEYS = ['store_prev', 'store_boot'];
async function listBackups() {
  if (!pg) return [];
  const r = await pg.query(`SELECT key, length(value) AS bytes, updated_at FROM dispatch_data WHERE key = 'store' OR key LIKE 'store_%' ORDER BY key`);
  // Sizes and timestamps only — a backup is never parsed into the live store here.
  return r.rows.map(row => ({ key: row.key, bytes: Number(row.bytes), updatedAt: row.updated_at }));
}

// Restore the live store from a backup row. Safe by construction:
//   1. the current 'store' row (whatever state it is in) is copied to
//      'store_before_restore' first, so the restore itself is reversible;
//   2. the backup is parsed and validated BEFORE anything is written;
//   3. the in-memory store is reloaded from the database afterwards, which
//      also clears the locked state if the process booted with a bad row.
async function restoreFromBackup(key) {
  if (!pg) throw new Error('Restore requires Postgres');
  if (!RESTORE_KEYS.includes(key)) throw new Error(`Unknown backup "${key}"`);
  const r = await pg.query('SELECT value FROM dispatch_data WHERE key = $1', [key]);
  if (!r.rows.length) throw new Error(`Backup "${key}" does not exist`);
  const candidate = parseStoreRow(r.rows[0].value);   // validate first
  await pg.query(`
    INSERT INTO dispatch_data(key, value, updated_at)
    SELECT 'store_before_restore', value, now() FROM dispatch_data WHERE key = 'store'
    ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `);
  await pg.query(
    "INSERT INTO dispatch_data(key, value, updated_at) VALUES('store', $1, now()) ON CONFLICT(key) DO UPDATE SET value = $1, updated_at = now()",
    [r.rows[0].value]
  );
  await loadData();
  return { restoredFrom: key, pos: (candidate.pos || []).length, loads: (candidate.loads || []).length };
}

// Persistence health, surfaced to /healthz and to the dispatcher's screen.
// A silent fallback to a local file is the single most dangerous failure mode
// here: everything looks fine until Railway redeploys and the day's loads are
// gone. So it is tracked and reported loudly rather than logged once.
const persistence = {
  mode: 'unknown',        // 'postgres' | 'file' | 'unknown'
  durable: false,
  loaded: false,          // true ONLY after the existing store was read and validated
  loadError: '',
  lastSaveOk: null,
  lastSaveAt: '',
  lastError: '',
  degradedSince: '',
};

async function saveData() {
  // The single most important line in this file. If the store was never
  // successfully loaded, whatever is in memory is seed data or nothing, and
  // writing it would overwrite the company's real records.
  if (!persistence.loaded) {
    const msg = 'REFUSED: store was never loaded from the database — writing now would overwrite production data';
    persistence.lastSaveOk = false;
    persistence.lastError = msg;
    throw new Error(msg);
  }
  const j = JSON.stringify(store);
  if (pg) {
    try {
      // Snapshot the previous value before overwriting. The whole operation
      // lives in one row, so a bad write would otherwise be unrecoverable.
      // Both statements run in one transaction so the backup and the new
      // value can never disagree.
      const client = await pg.connect();
      try {
        await client.query('BEGIN');
        await client.query(`
          INSERT INTO dispatch_data(key, value, updated_at)
          SELECT 'store_prev', value, now() FROM dispatch_data WHERE key = 'store'
          ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        `);
        await client.query(
          "INSERT INTO dispatch_data(key,value,updated_at) VALUES('store',$1,now()) ON CONFLICT(key) DO UPDATE SET value=$1, updated_at=now()",
          [j]
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      persistence.lastSaveOk = true;
      persistence.lastSaveAt = new Date().toISOString();
      persistence.lastError = '';
      persistence.degradedSince = '';
      return;
    } catch (e) {
      console.error('PG write error:', e.message);
      persistence.lastSaveOk = false;
      persistence.lastError = e.message;
      if (!persistence.degradedSince) persistence.degradedSince = new Date().toISOString();
      // Never fall back to local disk when Postgres is the configured store —
      // a file write would look like success and vanish on the next deploy.
      throw e;
    }
  }
  {
    try {
      fs.writeFileSync(DATA_FILE, j);
      persistence.lastSaveOk = true;
      persistence.lastSaveAt = new Date().toISOString();
    } catch (e) {
      persistence.lastSaveOk = false;
      persistence.lastError = e.message;
    }
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
  // An empty {} counts as unseeded — a fresh install starts with vendorPrices:{},
  // which is a truthy object, so the old check fell through to the else branch
  // and gave every yard an empty price list instead of the defaults.
  if (!store.vendorPrices || typeof store.vendorPrices !== 'object' || Object.keys(store.vendorPrices).length === 0) {
    store.vendorPrices = JSON.parse(JSON.stringify(DEFAULT_VENDOR_PRICES));
  } else {
    // Make sure every existing vendor has an entry (even if empty)
    store.vendors.forEach(v => {
      if (!Array.isArray(store.vendorPrices[v.id])) store.vendorPrices[v.id] = [];
    });
  }
  // ── FLEET & DRIVERS ────────────────────────────────────────────────────────
  // Seeded once, then owned by the user. Never overwrites existing records —
  // only adds a truck/driver that isn't there yet, so edits survive restarts.
  if (!Array.isArray(store.trucks)) store.trucks = [];
  DEFAULT_TRUCKS.forEach(dt => {
    if (!store.trucks.some(t => t.id === dt.id)) store.trucks.push({ ...dt });
  });
  store.trucks.forEach(t => {
    if (!t.status) t.status = 'available';
    if (t.active === undefined) t.active = true;
    if (!('mileage' in t)) t.mileage = null;
    if (!('maintenanceNotes' in t)) t.maintenanceNotes = '';
    if (!('type' in t)) t.type = '';
  });

  if (!Array.isArray(store.drivers)) store.drivers = [];
  TRUCKS.forEach(d => {
    if (!store.drivers.some(x => x.id === d.id)) {
      store.drivers.push({
        id: d.id,                       // matches the login + legacy load.truckId
        name: d.label,
        login: d.id,
        phone: '',
        status: 'available',
        defaultTruckId: (DEFAULT_TRUCKS.find(t => t.defaultDriverId === d.id) || {}).id || null,
        active: true,
        notes: '',
      });
    }
  });
  store.drivers.forEach(d => {
    if (!d.status) d.status = 'available';
    if (d.active === undefined) d.active = true;
  });

  // ONE-TIME backfill: loads that existed before the fleet did get the truck
  // their driver historically ran, so past deliveries keep truck attribution.
  // Guarded by a flag — after this runs once, a load with no truck stays
  // unassigned rather than silently inheriting the driver's usual vehicle.
  if (!store.truckUnitBackfillV1) {
    let n = 0;
    store.loads.forEach(l => {
      if (!l.truckUnitId) {
        const t = DEFAULT_TRUCKS.find(x => x.defaultDriverId === l.truckId);
        if (t) { l.truckUnitId = t.id; n++; }
      }
    });
    store.truckUnitBackfillV1 = true;
    if (n) console.log(`[normalize] Backfilled truck on ${n} pre-fleet load(s)`);
  }
  store.loads.forEach(l => { if (!('truckUnitId' in l)) l.truckUnitId = null; });

  // ── CUSTOMER NOTIFICATIONS ─────────────────────────────────────────────────
  // Off for every PO unless a dispatcher turns it on. Existing POs are
  // backfilled to OFF so enabling the feature never emails a past customer.
  if (!Array.isArray(store.notificationLog)) store.notificationLog = [];
  store.pos.forEach(p => {
    if (!p.notifications || typeof p.notifications !== 'object') {
      p.notifications = { enabled: false, contacts: [], events: { ...DEFAULT_NOTIFY_EVENTS } };
    }
    if (!Array.isArray(p.notifications.contacts)) p.notifications.contacts = [];
    p.notifications.events = { ...DEFAULT_NOTIFY_EVENTS, ...(p.notifications.events || {}) };
    if (p.notifications.enabled === undefined) p.notifications.enabled = false;
  });

  // ── UNIT CONFIG (P4) ───────────────────────────────────────────────────────
  // Quantity of each unit in one load. Seeded only with what Valley Best has
  // actually stated (1 load = 25 tons). Everything else stays unset until
  // management enters the real figure — the app reports "unpriced" rather
  // than guessing.
  if (!store.unitConfig || typeof store.unitConfig !== 'object') {
    store.unitConfig = { byUnit: { ...DEFAULT_UNIT_QTY_PER_LOAD }, byMaterial: {} };
  }
  if (!store.unitConfig.byUnit)     store.unitConfig.byUnit = { ...DEFAULT_UNIT_QTY_PER_LOAD };
  // Earlier builds seeded hour:1 and mile:1 as "quantity per load", which
  // silently turned a per-mile rate into rate × 1. Those units are measured
  // per load now; the fabricated seed value is removed (a deliberately
  // configured different number is left alone).
  for (const u of Object.keys(MEASURED_UNITS)) {
    if (Number(store.unitConfig.byUnit[u]) === 1) { delete store.unitConfig.byUnit[u]; console.log(`[normalize] removed fabricated ${u}:1 quantity-per-load seed`); }
  }
  if (!store.unitConfig.byMaterial) store.unitConfig.byMaterial = {};

  // ── COST RATES (P5) ────────────────────────────────────────────────────────
  // Operating-cost inputs. Deliberately null: inventing a wage or a fuel price
  // would produce confident, wrong margins. Each stays out of the cost total
  // until management sets it.
  if (!store.costRates || typeof store.costRates !== 'object') {
    store.costRates = {
      driverWagePerHour:  null,
      fuelPricePerGallon: null,
      truckMpgLoaded:     null,
      truckCostPerMile:   null,
      updatedAt: '', updatedBy: '',
    };
  }

  if (!store.nextPoNum)  store.nextPoNum = 1001;
  if (!store.nextLoadId) store.nextLoadId = 1;

  // MIGRATION — store.trucks ended up holding two different kinds of record.
  // One branch wrote the DRIVER roster into it ({id:'beryle', label:'Beryle'})
  // and another wrote the VEHICLE fleet ({id:'truck-2', truckNum:'Truck #2'}).
  // Both seeds could run, leaving people and vehicles mixed in one array —
  // which is why the PO form's Driver dropdown was listing truck ids and every
  // new load came out with a blank driver name.
  //
  // Split them: store.trucks keeps vehicles, store.drivers keeps people.
  // Nothing is discarded — a driver entry found here is folded into
  // store.drivers if it isn't already there.
  if (Array.isArray(store.trucks)) {
    const isDriverRow = (t) => t && !String(t.id || '').startsWith('truck-') && USERS[t.id];
    const strays = store.trucks.filter(isDriverRow);
    if (strays.length) {
      strays.forEach(s => {
        const existing = store.drivers.find(d => d.id === s.id);
        if (existing) {
          if (!existing.name && s.label) existing.name = s.label;
        } else {
          const veh = DEFAULT_TRUCKS.find(t => t.defaultDriverId === s.id);
          store.drivers.push({
            id: s.id, name: s.label || s.id, login: s.id, phone: '',
            status: 'available', defaultTruckId: veh ? veh.id : null,
            active: s.active !== false, notes: '',
          });
        }
      });
      store.trucks = store.trucks.filter(t => !isDriverRow(t));
      console.log(`[normalize] Split ${strays.length} driver record(s) out of the vehicle fleet`);
    }
  }
  store.trucks.forEach(t => { if (t.active === undefined) t.active = true; });

  store.loads.forEach(l => {
    if (!l.timestamps)     l.timestamps = {};
    if (!l.gps)            l.gps = {};
    if (!l.pod)            l.pod = { signedBy: '', signature: '', signedAt: '' };
    if (!l.approvalStatus) l.approvalStatus = l.status === 'completed' ? 'approved' : 'pending';
    if (!l.billStatus)     l.billStatus = 'not-ready';
    if (!l.ticketImage)    l.ticketImage = '';
    // `locked` is DERIVED from the approval state, never stored independently:
    // submitted and approved loads are locked, everything else is editable.
    // (Old data had approved loads with locked=false, which let the generic
    // manager update rewrite approved work.)
    l.locked = l.approvalStatus === 'approved' || l.approvalStatus === 'submitted';
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
  if (!store.driverLocations || typeof store.driverLocations !== 'object') store.driverLocations = {};
  if (!Array.isArray(store.billingBatches)) store.billingBatches = [];
  // A batch still 'syncing' when the process starts was interrupted mid-send.
  // The invoice may or may not exist in QuickBooks, so it becomes 'failed'
  // with an explicit instruction rather than silently re-sendable.
  store.billingBatches.forEach(b => {
    if (b.syncStatus === 'syncing') {
      b.syncStatus = 'failed';
      b.errorMessage = 'Send was interrupted by a server restart. Check QuickBooks for an invoice for this batch before retrying.';
      b.syncingSince = '';
    }
  });
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

// Valley Best runs on Pacific time. "Today" is the Pacific calendar date,
// never the UTC one (which flips to tomorrow at 4–5pm in Fresno and would
// end every driver's day mid-afternoon).
const OPERATING_TZ = process.env.OPERATING_TZ || 'America/Los_Angeles';
function todayStrAt(d) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: OPERATING_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function todayStr() { return todayStrAt(new Date()); }

// The driver's workday: their own loads that are today or earlier and still
// open. Never future work, never other drivers' work. One definition, used by
// every endpoint the driver app reads.
function driverWorkdayLoads(u) {
  const today = todayStr();
  return store.loads.filter(l =>
    l.truckId === u.truckId &&
    !l.voided &&
    l.status !== 'completed' &&
    l.approvalStatus !== 'approved' &&
    (l.deliveryDate || today) <= today
  );
}
// Rates and billing state are office information; the driver payload never
// carries them.
const DRIVER_HIDDEN_LOAD_FIELDS = [
  'customerRate', 'customerUnit', 'customerRateIsDefault', 'vendorRate', 'vendorUnit', 'vendorRateIsDefault',
  'vendorIsInternal', 'pricePerUnit', 'tonsPerLoad', 'billStatus', 'billedAt', 'billingBatchId',
  'qbInvoiceId', 'qbInvoiceNumber', 'sentToQuickBooksAt',
];
function driverSafeLoad(l) {
  const out = { ...l };
  for (const k of DRIVER_HIDDEN_LOAD_FIELDS) delete out[k];
  return out;
}
function driverSafePo(p) {
  const { notifications, ...rest } = p;
  return rest;
}

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
// ── CUSTOMER NOTIFICATIONS ───────────────────────────────────────────────────
// Which milestones a customer can be told about. All default OFF: a dispatcher
// opts a PO in, then picks the events. Nothing is ever sent by default.
const DEFAULT_NOTIFY_EVENTS = {
  driverAssigned: false,
  arrivedPickup:  false,
  loaded:         false,
  arrivedJobsite: false,
  delivered:      false,
  podReady:       false,
  delay:          false,
};

// Guarantees a PO has notification settings. Belt and braces: normalizeStore
// backfills at boot and PO creation sets them, but any PO reaching this code
// without them would otherwise throw inside an async handler.
function ensureNotifyCfg(po) {
  if (!po) return null;
  if (!po.notifications || typeof po.notifications !== 'object') {
    po.notifications = { enabled: false, contacts: [], events: { ...DEFAULT_NOTIFY_EVENTS } };
  }
  if (!Array.isArray(po.notifications.contacts)) po.notifications.contacts = [];
  po.notifications.events = { ...DEFAULT_NOTIFY_EVENTS, ...(po.notifications.events || {}) };
  return po.notifications;
}

function logNotification(entry) {
  try {
    if (!Array.isArray(store.notificationLog)) store.notificationLog = [];
    store.notificationLog.push({
      id: 'NTF-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
      at: new Date().toISOString(),
      event: entry.event,
      loadId: entry.loadId || '',
      poId: entry.poId || '',
      poNumber: entry.poNumber || '',
      customer: entry.customer || '',
      to: entry.to || '',
      subject: entry.subject || '',
      status: entry.status,              // sent | dry-run | failed | skipped
      reason: entry.reason || '',
      messageId: entry.messageId || '',
      triggeredBy: entry.triggeredBy || '',
    });
    if (store.notificationLog.length > 5000) store.notificationLog = store.notificationLog.slice(-5000);
  } catch (e) {
    console.error('[logNotification] failed:', e.message);
  }
}

// Fire a customer update for a load milestone.
//
// Deliberately fire-and-forget: a slow or failing mail server must never
// delay a driver tapping "Loaded" in a yard with one bar of signal. The
// result is recorded in the notification log either way.
function notifyLoadEvent(load, po, eventKey, opts = {}) {
  try {
    if (!po || !load) return;
    const cfg = ensureNotifyCfg(po);
    const base = {
      event: eventKey, loadId: load.id, poId: po.id,
      poNumber: po.poNumber, customer: po.customer, triggeredBy: opts.user || '',
    };
    if (!cfg || !cfg.enabled)          return logNotification({ ...base, status: 'skipped', reason: 'notifications off for this PO' });
    if (!cfg.events?.[eventKey])       return logNotification({ ...base, status: 'skipped', reason: `event "${eventKey}" not selected` });
    const recipients = (cfg.contacts || []).filter(c => c && c.email).map(c => c.email);
    if (!recipients.length)            return logNotification({ ...base, status: 'skipped', reason: 'no contact email on this PO' });

    const truck = getTruckForLoad(load);
    const pickup = resolvePickupYard(load, po, opts.trip);
    const { subject, text, html } = mailer.buildMessage(eventKey, {
      customer: po.customer,
      jobName: po.job || po.customer,
      address: po.address, city: po.city,
      material: load.material,
      loadNum: opts.loadNum || (load.loadsDelivered || 0) + 1,
      totalLoads: load.loadsAssigned,
      truckNum: truck ? truck.truckNum : '',
      yardName: pickup.name,
      poNumber: po.poNumber,
      when: new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }),
      note: opts.note || '',
    });

    for (const to of recipients) {
      mailer.send({ to, subject, text, html })
        .then(r => {
          logNotification({
            ...base, to, subject,
            status: r.sent ? 'sent' : r.dryRun ? 'dry-run' : 'failed',
            reason: r.error || '', messageId: r.messageId || '',
          });
          return saveData();
        })
        .catch(e => {
          logNotification({ ...base, to, subject, status: 'failed', reason: e.message });
        });
    }
  } catch (e) {
    console.error('[notifyLoadEvent] failed:', e.message);
  }
}

// ── PICKUP YARD — SINGLE SOURCE OF TRUTH ─────────────────────────────────────
// The yard the driver is sent to must always come from the load assignment,
// never from a free-text PO label. Previously the driver was shown
// `po.pickup`, a string that defaulted to "VBT Yard" — so a dispatcher who
// assigned Vulcan on the load still sent the driver to the Valley Best yard.
//
// Authority, highest first:
//   1. trip.actualYardId    — where the driver actually went on THIS trip
//   2. load.actualYardId    — where the driver actually went on this load
//   3. load.vendorId        — what the dispatcher assigned for this load
//   4. po.plannedVendorId   — PO-level fallback for legacy rows
//   5. 'vbt'                — the internal yard
// The NAME is always looked up from the vendor record, so the label can never
// drift from the id.
function resolvePickupYard(load, po, trip) {
  const id =
    (trip && trip.actualYardId) ||
    load?.actualYardId ||
    load?.vendorId ||
    po?.plannedVendorId ||
    'vbt';
  const v = store.vendors.find(x => x.id === id);
  const isActual = !!((trip && trip.actualYardId) || load?.actualYardId);
  return {
    id,
    name: v?.name || load?.vendorName || 'VBT Yard',
    location: v?.location || '',
    isInternal: id === 'vbt',
    isActual,
  };
}

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
// ── UNIT MODEL ───────────────────────────────────────────────────────────────
// How much of a unit fits in one Valley Best truck load. This is a BUSINESS
// FACT, not something the code may assume.
//
// The old code multiplied by tonsPerLoad (25) for every unit that wasn't
// 'load' — so a $38/CY rock price became $950 per load, while
// /api/material-costs used a different formula entirely and reported $76 for
// the very same load. Both cannot be right, and guessing a cubic-yards-per-
// load figure would just bake in a new wrong number.
//
// So: units Valley Best has actually defined get a quantity. Units that have
// not been defined return null, and every caller reports the load as
// "unpriced — set quantity per load" instead of inventing a total.
//
// CONFIRMED Valley Best rule: 1 truck load = 25 tons. Valley Best hauls and
// delivers material by weight — CY is a concrete-placement unit and is not
// part of this workflow, so it is deliberately absent here and never appears
// as a configuration warning.
//
//   ton  → 25   confirmed: 1 Valley Best load = 25 tons
//   load → 1    the rate already IS per load
//   hour → 1    hourly work; the rate is per load-hour
//   mile → 1    per-mile rate, multiplied by miles at call time
//
// The engine stays open: any other unit can be given a quantity per load in
// costing settings, and only units actually in use are ever flagged.
const DEFAULT_UNIT_QTY_PER_LOAD = {
  ton:  TONS_PER_LOAD,   // the single definition of the 25-ton rule
  load: 1,
};
// Units whose quantity is MEASURED on each load, never configured as a
// constant: a per-mile or per-hour rate needs the miles/hours recorded on
// that load (load.miles / load.hours). Until they are, the amount is
// reported as not calculable — never as rate × 1.
const MEASURED_UNITS = { mile: 'miles', hour: 'hours' };

// Units Valley Best actually operates in. Anything outside this list still
// works if configured, but these are what the UI offers by default.
const SUPPORTED_UNITS = ['ton', 'load', 'hour', 'mile'];

function unitKey(unit) { return String(unit || 'ton').trim().toLowerCase(); }

// Quantity of `unit` in one load, optionally overridden per material
// (crushed rock and sand do not weigh the same per cubic yard).
// Returns null when Valley Best has not defined it.
function qtyPerLoad(unit, material) {
  const u = unitKey(unit);
  if (MEASURED_UNITS[u]) return null;   // miles/hours come from the load itself
  const cfg = store.unitConfig || {};
  const perMat = (cfg.byMaterial || {})[material];
  if (perMat && perMat[u] != null && perMat[u] !== '') return Number(perMat[u]);
  const byUnit = cfg.byUnit || {};
  if (byUnit[u] != null && byUnit[u] !== '') return Number(byUnit[u]);
  if (DEFAULT_UNIT_QTY_PER_LOAD[u] != null) return DEFAULT_UNIT_QTY_PER_LOAD[u];
  return null;  // unconfigured — caller must not fabricate a number
}

// The one money calculation. Every screen uses this so the same load can
// never show two different figures.
//   { amount, unconfigured, unit, qtyPerLoad, rate, delivered }
//   `measured` = { miles, hours } recorded on the load, for mile/hour units.
//   An unconfigured result carries `reason` so every screen can say WHY the
//   figure is missing instead of showing $0.
function computeAmount(rate, unit, delivered, material, tonsPerLoadOverride, measured) {
  const r = Number(rate) || 0;
  const n = Number(delivered) || 0;
  const u = unitKey(unit);
  const base = { unit: u, rate: r, delivered: n };
  if (MEASURED_UNITS[u]) {
    const field = MEASURED_UNITS[u];
    const m = measured && measured[field];
    if (m == null || m === '' || !isFinite(Number(m))) {
      return { ...base, amount: null, unconfigured: true, qtyPerLoad: null, quantity: null,
               reason: `${field} not recorded on this load — a per-${u} rate cannot be calculated yet` };
    }
    return { ...base, amount: r * Number(m), unconfigured: false, qtyPerLoad: null, quantity: Number(m), reason: '' };
  }
  // A per-load snapshot of tons wins for ton-priced loads (legacy loads carry it)
  const qty = (u === 'ton' && tonsPerLoadOverride) ? Number(tonsPerLoadOverride) : qtyPerLoad(u, material);
  if (qty == null) {
    return { ...base, amount: null, unconfigured: true, qtyPerLoad: null, quantity: null,
             reason: `no quantity per load configured for unit "${u}" (Costing settings)` };
  }
  return { ...base, amount: r * qty * n, unconfigured: false, qtyPerLoad: qty, quantity: qty * n, reason: '' };
}

function revenueDetail(load) {
  return computeAmount(load.customerRate, load.customerUnit || 'ton', load.loadsDelivered, load.material, load.tonsPerLoad, { miles: load.miles, hours: load.hours });
}
function costDetail(load) {
  return computeAmount(load.vendorRate, load.vendorUnit || 'ton', load.loadsDelivered, load.material, load.tonsPerLoad, { miles: load.miles, hours: load.hours });
}

// Back-compat numeric wrappers. An unconfigured unit yields 0 rather than a
// made-up figure; callers that care read the *Detail form and surface the
// `unconfigured` flag to the user.
function computeRevenue(load) { const d = revenueDetail(load); return d.amount == null ? 0 : d.amount; }
function computeCost(load)    { const d = costDetail(load);    return d.amount == null ? 0 : d.amount; }

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
// Manager and admin are treated as equivalent permission levels.
function reqAdmin(req, res, next) {
  const r = req.session?.user?.role;
  if (r === 'admin' || r === 'manager') return next();
  res.status(403).json({ error: 'Admin access required' });
}

app.get('/healthz', (req, res) => res.json({
  ok: true,
  hasDb: !!process.env.DATABASE_URL,
  // `loaded` is the truth about the data: durable=true only says Postgres is
  // reachable. A process that could not read its store reports loaded=false
  // and refuses every write.
  loaded: persistence.loaded,
  loadError: persistence.loadError,
  persistence: {
    mode: persistence.mode,
    durable: persistence.durable && persistence.loaded,
    loaded: persistence.loaded,
    loadError: persistence.loadError,
    lastSaveOk: persistence.lastSaveOk,
    lastSaveAt: persistence.lastSaveAt,
    lastError: persistence.lastError,
    degradedSince: persistence.degradedSince,
  },
  fileStorage: supabaseEnabled ? 'supabase' : 'base64-in-database',
  // merged in from the second /healthz the branch merge left behind — Express
  // only ever ran the first registration, so those fields were being dropped
  pgConnected: !!pg,
  supabaseEnabled,
  prod: IS_PROD,
  time: new Date().toISOString(),
}));

// Persistence banner for the dispatcher. If data is not reaching Postgres,
// the person entering loads is the one who needs to know — not just the log.
app.get('/api/persistence', reqAuth, (req, res) => {
  res.json({
    ...persistence,
    fileStorage: supabaseEnabled ? 'supabase' : 'base64-in-database',
    warning: !persistence.loaded
      ? 'LOCKED: the dispatch data could not be read from the database. Nothing has been changed or overwritten. An admin can restore a backup from Settings.'
      : !persistence.durable
      ? 'Data is NOT in Postgres — it will be lost on the next redeploy. Set DATABASE_URL.'
      : persistence.lastSaveOk === false
        ? 'The last save did not reach Postgres. Recent changes may be at risk.'
        : '',
  });
});

// ── STORE LOCK ───────────────────────────────────────────────────────────────
// While the store is not loaded, every dispatch API answers 503 instead of
// serving an empty board that the office could mistake for lost data, and
// instead of accepting a write that saveData() would refuse anyway. Health,
// identity and the backup/restore endpoints stay reachable so the situation
// can be seen and fixed.
const LOCK_EXEMPT = new Set(['/api/persistence', '/api/me', '/api/admin/backups', '/api/admin/restore']);
app.use('/api', (req, res, next) => {
  if (persistence.loaded || LOCK_EXEMPT.has(req.originalUrl.split('?')[0])) return next();
  res.status(503).json({
    error: 'Dispatch data is locked: the store could not be loaded from the database. Nothing was overwritten.',
    locked: true,
    loadError: persistence.loadError,
  });
});

// ── BACKUP / RESTORE (admin) ─────────────────────────────────────────────────
// store_prev = the value before the most recent save; store_boot = the value
// when this process last started. Restoring first copies the current row to
// store_before_restore, so a restore is itself undoable.
app.get('/api/admin/backups', reqAdmin, async (req, res) => {
  const rows = await listBackups();
  res.json({ loaded: persistence.loaded, loadError: persistence.loadError, restorable: RESTORE_KEYS, backups: rows });
});
app.post('/api/admin/restore', reqAdmin, async (req, res) => {
  const { from, confirm } = req.body || {};
  if (!RESTORE_KEYS.includes(from)) return res.status(400).json({ error: `from must be one of ${RESTORE_KEYS.join(', ')}` });
  if (confirm !== 'RESTORE') return res.status(400).json({ error: 'Pass confirm: "RESTORE" to replace the live dispatch data with this backup' });
  try {
    const result = await restoreFromBackup(from);
    logAction(req.session.user, 'restore-backup', from, { pos: result.pos, loads: result.loads });
    await saveData();   // persists the audit entry; also proves the store is writable again
    res.json({ success: true, ...result, loaded: persistence.loaded });
  } catch (e) {
    res.status(409).json({ error: e.message, loaded: persistence.loaded });
  }
});

// Test-only hooks. Never mounted in production; used by test-e2e.sh to prove
// the async wrapper above is still in place (a hung request = missing wrapper).
if (process.env.VBT_TEST_HOOKS === '1' && !IS_PROD) {
  // Fake QuickBooks: replaces the qb module's network calls so the billing
  // state machine (concurrency, failure, retry, void) can be exercised
  // without Intuit. `mode` = ok | fail | slow.
  const fakeQb = { mode: 'ok', delayMs: 0, invoicesCreated: 0, invoicesVoided: 0, invoices: [] };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  app.post('/api/_test/qb-fake', reqMgr, async (req, res) => {
    Object.assign(fakeQb, { mode: req.body?.mode || 'ok', delayMs: Number(req.body?.delayMs || 0) });
    if (req.body?.connected !== false) {
      store.qbConnection = { ...(store.qbConnection || {}), realmId: 'test-realm', status: 'connected', companyName: 'Fake QB', connectedAt: new Date().toISOString() };
    } else if (store.qbConnection) {
      store.qbConnection.status = 'disconnected';
    }
    qb.findOrCreateCustomer = async (conn, c) => ({ customer: { Id: 'CUST-' + (c.name || 'x').replace(/\W/g, ''), DisplayName: c.name }, created: false });
    qb.createInvoice = async (conn, args) => {
      if (fakeQb.mode === 'slow') await wait(fakeQb.delayMs || 1500);
      if (fakeQb.mode === 'fail') { const e = new Error('Fake QuickBooks: invoice rejected'); e.statusCode = 400; throw e; }
      fakeQb.invoicesCreated++;
      const inv = { Id: 'INV-' + fakeQb.invoicesCreated, DocNumber: String(1000 + fakeQb.invoicesCreated), memo: args.memo };
      fakeQb.invoices.push(inv);
      return inv;
    };
    qb.voidInvoice = async (conn, id) => {
      if (fakeQb.mode === 'fail') throw new Error('Fake QuickBooks: void rejected');
      fakeQb.invoicesVoided++;
      return { Id: id, status: 'Voided' };
    };
    qb.createBill = async () => ({ Id: 'BILL-1' });
    res.json({ ok: true, fakeQb });
  });
  app.get('/api/_test/qb-fake', reqMgr, (req, res) => res.json(fakeQb));
  app.get('/api/_test/today', (req, res) => res.json({ tz: OPERATING_TZ, today: todayStrAt(req.query.at ? new Date(String(req.query.at)) : new Date()) }));
  app.get('/api/_test/async-throw', async (req, res) => { throw new Error('test: async throw'); });
  app.get('/api/_test/async-reject', (req, res) => Promise.reject(new Error('test: rejected promise')));
  app.get('/api/_test/sync-throw', (req, res) => { throw new Error('test: sync throw'); });
}
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

  // 1) DB-backed users — the real driver/office login store, written by the
  //    Drivers & Trucks screen.
  if (pg) {
    try {
      const r = await pg.query(
        'SELECT id, company_id, username, password, role, truck_id, display_name, active FROM users WHERE username = $1',
        [cleanName]
      );
      const dbUser = r.rows.find(row => row.active && row.password === password);
      if (dbUser) {
        // A driver's session truckId must be a roster id (that is what
        // load.truckId holds). users.truck_id normally equals the username;
        // if it was ever set to something that is not a roster driver (an
        // old screen let it hold a vehicle id), fall back to the username so
        // the driver still sees their own loads.
        let sessTruckId = dbUser.truck_id;
        if (dbUser.role === 'driver' && !rosterDriver(sessTruckId)) sessTruckId = dbUser.username;
        req.session.user = {
          username:    dbUser.username,
          role:        dbUser.role,
          truckId:     sessTruckId,
          displayName: dbUser.display_name || dbUser.username,
        };
        console.log(`[LOGIN] SUCCESS (db): username="${dbUser.username}", role="${dbUser.role}"`);
        return res.redirect('/app/');
      }
      // The users table answered and did not accept this login. That is the
      // final word: it must NOT fall through to the hardcoded legacy map,
      // otherwise a changed password or a deactivated account would still be
      // openable with the original seed password.
      console.log(`[LOGIN] FAILED (db): username="${cleanName}"`);
      return res.redirect('/login?error=1');
    } catch (e) {
      console.error('[LOGIN] DB lookup error:', e.message);
      if (IS_PROD) return res.redirect('/login?error=1');
      // dev only: fall through to the hardcoded map if the table is unreachable
    }
  }

  // 2) Legacy fallback: hardcoded VBT users (dev / no-database mode only).
  const u = USERS[cleanName];
  if (!u || u.password !== password) {
    console.log(`[LOGIN] FAILED: username="${cleanName}"`);
    return res.redirect('/login?error=1');
  }
  req.session.user = {
    username:    cleanName,
    role:        u.role,
    truckId:     u.truckId,
    displayName: u.displayName || (cleanName.charAt(0).toUpperCase() + cleanName.slice(1)),
  };
  console.log(`[LOGIN] SUCCESS (legacy): username="${cleanName}", role="${u.role}"`);
  res.redirect('/app/');
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// ── STATIC + PROTECTED APP SHELL ─────────────────────────────────────────────
// These three serve the actual application. Without them the site answers
// "Cannot GET /" — Express has no route for the root and never serves
// public/index.html. They sat next to the Stripe routes and were lost when
// those were removed by line range.
app.use('/app', reqAuth, express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
app.get(['/app', '/app/'], reqAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/', (req, res) => res.redirect(req.session?.user ? '/app/' : '/login'));

// ── API: WHO AM I ────────────────────────────────────────────────────────────
app.get('/api/me', reqAuth, (req, res) => {
  const u = req.session.user;
  console.log(`[/api/me] username="${u.username}", role="${u.role}"`);
  res.json({
    username:    u.username,
    role:        u.role,
    truckId:     u.truckId,
    displayName: u.displayName || u.username,
  });
});

// ── API: SUBSCRIPTION STATUS ─────────────────────────────────────────────────
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

// ── API: DRIVER LOCATION ─────────────────────────────────────────────────────
// Last-known position per driver, sent by the driver app in the background.
// Only the latest point is kept (no track history — that is ELD territory and
// deliberately not built here), so the store stays small. Throttled to one
// accepted point per driver per 20s; more frequent posts are acknowledged
// and dropped.
const LOCATION_MIN_INTERVAL_MS = 20 * 1000;
app.post('/api/driver-location', reqAuth, async (req, res) => {
  const u = req.session.user;
  if (u.role !== 'driver') return res.status(403).json({ error: 'Driver only' });
  const lat = Number(req.body?.lat), lng = Number(req.body?.lng);
  const accuracy = req.body?.accuracy == null ? null : Number(req.body.accuracy);
  if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'lat/lng out of range' });
  }
  if (accuracy != null && (!isFinite(accuracy) || accuracy < 0 || accuracy > 100000)) {
    return res.status(400).json({ error: 'accuracy out of range' });
  }
  if (!store.driverLocations) store.driverLocations = {};
  const prev = store.driverLocations[u.truckId];
  const now = Date.now();
  if (prev && now - Date.parse(prev.at) < LOCATION_MIN_INTERVAL_MS) {
    return res.status(202).json({ accepted: false, reason: 'throttled' });
  }
  const current = driverWorkdayLoads(u).find(l => (l.trips || []).length && !l.locked) || null;
  store.driverLocations[u.truckId] = {
    driverId: u.truckId, lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6,
    accuracy: accuracy == null ? null : Math.round(accuracy), at: new Date(now).toISOString(),
    loadId: current ? current.id : null,
  };
  // The office reads positions from memory. Persisting the whole store for
  // every ping would write megabytes to Postgres every few seconds across
  // five trucks, so location-only changes are flushed at most every 5 min
  // (any other save carries them along anyway).
  if (now - lastLocationFlush > 5 * 60 * 1000) { lastLocationFlush = now; await saveData(); }
  res.json({ accepted: true });
});
let lastLocationFlush = 0;
// Office view: where each driver was last seen.
app.get('/api/driver-locations', reqMgr, (req, res) => {
  const rows = Object.values(store.driverLocations || {}).map(loc => {
    const d = rosterDriver(loc.driverId);
    return { ...loc, driverName: d ? d.name : loc.driverId, ageSeconds: Math.max(0, Math.round((Date.now() - Date.parse(loc.at)) / 1000)) };
  });
  res.json({ locations: rows });
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
    // Same workday scope as /api/my-dispatch, and no pricing/billing fields.
    const myLoads = driverWorkdayLoads(u).map(driverSafeLoad);
    const myPoIds = new Set(myLoads.map(l => l.poId));
    const myPos = store.pos.filter(p => myPoIds.has(p.id)).map(driverSafePo);
    return res.json({ trucks: driverRoster(), materials: MATERIALS, yards, pos: myPos, loads: myLoads });
  }
  // Manager sees full vendor data
  res.json({
    trucks: driverRoster(),          // legacy contract: the DRIVER dropdown
    fleet:  store.trucks || [],      // the actual vehicles
    drivers: store.drivers || [],    // the roster (same list Quick Assign uses)
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

  // Drivers see only their CURRENT WORKDAY — today's loads, plus anything
  // older still open (a load that ran past midnight or was left unfinished
  // must not silently vanish on the driver). Never future work.
  const myLoads = driverWorkdayLoads(u);

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
    // Resolve against the CURRENT trip so a per-trip yard change is reflected
    const curTrip = (Array.isArray(l.trips) && l.trips.length) ? l.trips[activeTripIdx(l)] : null;
    const pickup  = resolvePickupYard(l, po, curTrip);
    const truck   = getTruckForLoad(l);
    return {
      loadId: l.id,
      truckId:    l.truckUnitId || null,
      truckLabel: truck ? (truck.truckNum || truck.label || '') : '',
      truckType:  truck ? (truck.type || '') : '',
      // Per-trip pickup history so the driver can see where each haul went
      trips: (l.trips || []).map(t => ({
        tripNum: t.tripNum,
        timestamps: t.timestamps || {},
        yardId: t.actualYardId || pickup.id,
        yardName: t.actualYardName || (store.vendors.find(v => v.id === (t.actualYardId || pickup.id)) || {}).name || pickup.name,
      })),
      poNumber: po.poNumber || '—',
      customer: po.customer || '',
      jobName: po.job || po.customer || '',
      jobCode: po.jobCode || '',
      // Pickup comes from the load assignment, never the PO's free-text label.
      pickupLocation:  pickup.name,
      pickupYardId:    pickup.id,
      pickupIsInternal: pickup.isInternal,
      pickupIsActual:  pickup.isActual,
      plannedVendorId: pickup.id,
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
    // Customer updates start OFF on every new PO. A dispatcher opts in.
    notifications:   { enabled: false, contacts: [], events: { ...DEFAULT_NOTIFY_EVENTS } },
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
    const truck = driverRoster().find(t => t.id === s.truckId);   // DRIVER, not vehicle
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
      truckId: s.truckId || null,               // legacy name: this is the DRIVER
      driverName: truck?.label || '',
      // Vehicle, chosen independently of the driver. Deliberately NOT defaulted
      // to that driver's historical truck — a driver can run a different truck
      // any day, and silently assuming one would put the wrong truck number in
      // front of the driver. Unset until the dispatcher picks.
      truckUnitId: s.truckUnitId || null,
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
      tonsPerLoad: qtyPerLoad('ton', s.material),
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
  // Once any load on this PO is approved, the fields that identify the PO on
  // an invoice are frozen — otherwise approved work could be re-labelled to
  // another customer or PO number after the fact.
  const hasApproved = store.loads.some(l => l.poId === old.id && l.approvalStatus === 'approved');
  if (hasApproved) {
    const frozen = ['poNumber', 'customer', 'jobCode', 'job', 'address', 'city'].filter(k => k in req.body && req.body[k] !== old[k]);
    if (frozen.length) return res.status(403).json({ error: `This PO has approved loads; ${frozen.join(', ')} cannot change.`, frozenFields: frozen });
  }
  const updated = { ...old, ...req.body, id: old.id, createdAt: old.createdAt };
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
  // Deleting a PO deletes its loads. Approved work — voided or not — is
  // historical evidence (ticket, signature, GPS, who approved it) and is
  // never deleted; neither is anything that has reached a billing batch.
  // Voided ≠ deleted: a voided approved load stays on the record.
  const linked = store.loads.filter(l => l.poId === req.params.id);
  const blocking = linked.filter(l => l.approvalStatus === 'approved' || l.billingBatchId || l.qbInvoiceId);
  if (blocking.length) {
    const voidedCount = blocking.filter(l => l.voided).length;
    return res.status(403).json({
      error: `Cannot delete — ${blocking.length} approved load${blocking.length === 1 ? '' : 's'} on this PO`
           + (voidedCount ? ` (${voidedCount} voided)` : '')
           + '. Approved deliveries are kept as history even after voiding; this PO stays on record.',
      blockingLoadIds: blocking.map(l => l.id),
    });
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
const PROTECTED_LOAD_FIELDS = new Set([
  'id', 'poId',
  'approvalStatus', 'approvedAt', 'approvedBy', 'submittedAt', 'rejectReason',
  'billStatus', 'billedAt', 'billingBatchId', 'qbInvoiceId', 'qbInvoiceNumber',
  'voided', 'voidedAt', 'voidedBy', 'voidReason', 'unvoidedAt', 'unvoidedBy',
  'locked', 'trips', 'completedAt',
]);
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
    // Manager — most fields, but NEVER the state machine. Approval, billing,
    // void and trip history change only through their own endpoints
    // (/approve, /reject, /void, /unvoid, /trip-action, billing batches), so
    // a generic update can neither approve work nor un-bill it.
    const touched = Object.keys(req.body || {}).filter(k => PROTECTED_LOAD_FIELDS.has(k));
    if (touched.length) {
      return res.status(400).json({
        error: `These fields cannot be changed through a load update: ${touched.join(', ')}. Use the approve / reject / void / billing actions.`,
        protectedFields: touched,
      });
    }
    const updated = { ...l, ...req.body, id: l.id, poId: l.poId };
    let auditAction = 'updated-load';
    let auditDetails = { changes: Object.keys(req.body) };
    if (req.body.truckId !== undefined) {
      const t = driverRoster().find(t => t.id === req.body.truckId);   // DRIVER
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
    // Fired after the yard is stamped so the customer is told the correct one
    notifyLoadEvent(l, store.pos.find(p => p.id === l.poId), 'arrivedPickup', { user: u.username, trip, loadNum: (l.loadsDelivered || 0) + 1 });
  } else if (action === 'loaded') {
    if (!trip.timestamps?.arrivedPickup) return res.status(400).json({ error: 'Must mark arrived at pickup first' });
    stampBoth('loadedAt');
    notifyLoadEvent(l, store.pos.find(p => p.id === l.poId), 'loaded', { user: u.username, trip, loadNum: (l.loadsDelivered || 0) + 1 });
  } else if (action === 'arrived-jobsite') {
    if (!trip.timestamps?.loadedAt) return res.status(400).json({ error: 'Must mark loaded / leaving yard first' });
    stampBoth('arrivedJobsite');
    notifyLoadEvent(l, store.pos.find(p => p.id === l.poId), 'arrivedJobsite', { user: u.username, trip, loadNum: (l.loadsDelivered || 0) + 1 });
  } else if (action === 'trip-complete') {
    // Ends the current trip. Increments loadsDelivered. Does NOT submit for
    // approval — that's the `delivered` action below, which fires only after
    // the LAST trip's ticket + signature are captured.
    if (!trip.timestamps?.arrivedJobsite) return res.status(400).json({ error: 'Must mark arrived at job site first' });
    if (trip.timestamps?.completed)        return res.status(400).json({ error: 'Trip already complete' });
    stampBoth('completed');
    l.loadsDelivered = (l.loadsDelivered || 0) + 1;
    notifyLoadEvent(l, store.pos.find(p => p.id === l.poId), 'delivered', { user: u.username, trip, loadNum: l.loadsDelivered });
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

// ── API: VOID / UNVOID A LOAD ────────────────────────────────────────────────
// The correction path for delivered work. Approved loads are never deleted —
// the ticket, signature, GPS and timestamps are legal proof and stay on the
// record permanently. Voiding marks the load as not counting: it drops out of
// dispatch, Ready to Bill, analytics and reporting, but the evidence remains
// and the reason is on the audit trail.
//
// Until now `load.voided` was read in dozens of places and set by nothing, so
// "void it instead" was advice with no way to follow it.
app.post('/api/loads/:id/void', reqMgr, async (req, res) => {
  const l = store.loads.find(x => x.id === req.params.id);
  if (!l) return res.status(404).json({ error: 'Load not found' });
  if (l.voided) return res.status(400).json({ error: 'This load is already voided' });

  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required to void a load' });

  // A load already invoiced must be corrected through the billing batch, or
  // our records and QuickBooks would disagree about what was billed.
  if (l.billingBatchId || l.qbInvoiceId) {
    const b = (store.billingBatches || []).find(x => x.id === l.billingBatchId);
    return res.status(409).json({
      error: 'This load is on a billing batch'
        + (l.qbInvoiceNumber ? ` (QuickBooks invoice ${l.qbInvoiceNumber})` : '')
        + '. Void the batch first — that releases the load and keeps QuickBooks in step.',
      billingBatchId: l.billingBatchId || '',
      batchStatus: b ? b.syncStatus : '',
    });
  }

  const po = store.pos.find(p => p.id === l.poId) || {};
  l.voided     = true;
  l.voidedAt   = new Date().toISOString();
  l.voidedBy   = req.session.user.displayName || req.session.user.username;
  l.voidReason = reason;
  l.billStatus = 'voided';   // out of Ready to Bill; approvalStatus is left as history

  logAction(req.session.user, 'voided-load', l.id, {
    poNumber: po.poNumber || '', customer: po.customer || '',
    material: l.material, driver: l.driverName,
    delivered: l.loadsDelivered, wasApproved: l.approvalStatus === 'approved',
    reason,
  });
  await saveData();
  res.json({ success: true, load: l });
});

// Reverse a void. Voiding by mistake should not be permanent — this restores
// the load rather than recreating it, so the original evidence is unchanged.
app.post('/api/loads/:id/unvoid', reqMgr, async (req, res) => {
  const l = store.loads.find(x => x.id === req.params.id);
  if (!l) return res.status(404).json({ error: 'Load not found' });
  if (!l.voided) return res.status(400).json({ error: 'This load is not voided' });

  l.voided = false;
  l.billStatus = l.approvalStatus === 'approved' ? 'ready' : 'not-ready';
  const prior = l.voidReason;
  l.unvoidedAt = new Date().toISOString();
  l.unvoidedBy = req.session.user.displayName || req.session.user.username;
  l.voidReason = '';
  l.voidedAt = '';
  l.voidedBy = '';

  logAction(req.session.user, 'unvoided-load', l.id, { previousReason: prior });
  await saveData();
  res.json({ success: true, load: l });
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
  const skipped = [];
  store.loads.forEach(l => {
    if (!ids.includes(l.id)) return;
    if (l.approvalStatus !== 'approved' || l.billStatus !== 'ready') return;
    // Duplicate-billing guard: a load already claimed by a billing batch must
    // not be manually marked billed — void the batch first to release it.
    if (l.billingBatchId || l.qbInvoiceId) { skipped.push(l.id); return; }
    l.billStatus = 'billed';
    l.billedAt   = new Date().toISOString();
    billedIds.push(l.id);
    count++;
  });
  if (skipped.length) {
    return res.status(409).json({
      error: `${skipped.length} load(s) already belong to a billing batch — void the batch before billing them manually.`,
      skipped,
    });
  }
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
    const unconfiguredLoadIds = [];

    // Group line items by material+unit+rate (so different rates don't collapse)
    const lineMap = new Map();
    for (const { load, po } of g.loads) {
      loadIdsInGroup.push(load.id);
      const revD = revenueDetail(load);
      const rev = revD.amount == null ? 0 : revD.amount;
      // Tons come from the engine's quantity-per-load (per-load snapshot or
      // configured), not a hardcoded constant.
      const tons = (revD.unit === 'ton' && revD.qtyPerLoad != null) ? revD.qtyPerLoad * (Number(load.loadsDelivered) || 0) : 0;
      const unit = revD.unit;
      const rate = Number(load.customerRate) || 0;
      const lk = `${load.material}|${unit}|${rate}`;
      if (!lineMap.has(lk)) {
        lineMap.set(lk, {
          material: load.material,
          unit, rate,
          loads: 0, tons: 0, amount: 0,
          unconfigured: false, reasons: [],
          loadIds: [],
        });
      }
      const ln = lineMap.get(lk);
      ln.loads += Number(load.loadsDelivered) || 0;
      ln.tons  += tons;
      ln.amount += rev;
      ln.loadIds.push(load.id);
      if (revD.unconfigured) { ln.unconfigured = true; if (!ln.reasons.includes(revD.reason)) ln.reasons.push(revD.reason); unconfiguredLoadIds.push(load.id); }

      if (load.ticketImageUrl) ticketImages.push({ loadId: load.id, url: load.ticketImageUrl });
      else if (load.ticketImage) ticketImages.push({ loadId: load.id, dataUrl: true });
      if (load.pod?.signature) signatureImages.push({ loadId: load.id, dataUrl: true });
      if (load.approvedAt) approvalStamps.push({ loadId: load.id, at: load.approvedAt, by: load.approvedBy });
    }

    const lineItems = [...lineMap.values()].map(ln => ({
      ...ln,
      description: `${ln.material} — ${ln.loads} load${ln.loads === 1 ? '' : 's'}`
        + (ln.unit === 'ton' ? ` (${ln.tons.toFixed(2)} ton @ $${ln.rate}/ton)` : ` (@ $${ln.rate}/${ln.unit})`)
        + (ln.unconfigured ? ' [NOT PRICEABLE]' : ''),
    }));
    const totalAmount = lineItems.reduce((s, ln) => s + ln.amount, 0);
    const totalLoads  = lineItems.reduce((s, ln) => s + ln.loads, 0);
    const totalTons   = lineItems.reduce((s, ln) => s + ln.tons, 0);
    const unconfigured = lineItems.some(ln => ln.unconfigured);

    groups.push({
      // A group with any line the engine could not price is flagged so it is
      // shown as such in the preview and refused as a batch — never sent as $0.
      unconfigured,
      unconfiguredLoadIds: [...new Set(unconfiguredLoadIds)],
      unconfiguredReasons: [...new Set(lineItems.flatMap(ln => ln.reasons || []))],
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
    if (!['admin', 'manager'].includes(req.session.user.role)) {
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
  const bad = groups.filter(g => g.unconfigured);
  if (bad.length) {
    return res.status(400).json({
      error: 'Some loads cannot be priced yet, so no batch was created: ' + [...new Set(bad.flatMap(g => g.unconfiguredReasons))].join('; ')
           + '. Fix the pricing or unit configuration, then bill again.',
      unconfiguredLoadIds: bad.flatMap(g => g.unconfiguredLoadIds),
    });
  }

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
  // Duplicate-invoice guards, checked BEFORE the first await so two
  // simultaneous requests cannot both pass (Node runs this section without
  // interleaving). Any batch that already has a QuickBooks invoice id is
  // never re-sent, whatever its status says.
  if (b.qbInvoiceId) {
    return res.status(400).json({ error: `Already sent (invoice ${b.qbInvoiceNumber || b.qbInvoiceId}). Void the batch to correct it.` });
  }
  if (b.syncStatus === 'syncing') {
    return res.status(409).json({ error: 'This batch is already being sent to QuickBooks. Wait for it to finish.', batch: b });
  }
  if (b.syncStatus === 'voided') return res.status(400).json({ error: 'Cannot send a voided batch' });
  if (b.syncStatus === 'failed') return res.status(400).json({ error: 'This batch failed earlier. Use Retry, which checks it first.', batch: b });
  if ((b.lineItems || []).some(ln => ln.unconfigured || ln.amount == null)) {
    return res.status(400).json({ error: 'This batch has a line the costing engine could not price. It will not be sent as $0; void it, fix the pricing, and re-bill.' });
  }
  const conn = store.qbConnection;
  if (!conn?.realmId || conn.status !== 'connected') return res.status(400).json({ error: 'QuickBooks not connected' });

  b.syncStatus = 'syncing';
  b.syncingSince = new Date().toISOString();
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
    b.syncingSince = '';

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
    b.syncingSince = '';
    b.errorMessage = b.qbInvoiceId
      ? `Invoice ${b.qbInvoiceNumber || b.qbInvoiceId} was created in QuickBooks but finishing the batch failed: ${e.message}. Do not resend; void the batch to correct it.`
      : e.message;
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

  if (b.syncStatus === 'syncing') return res.status(409).json({ error: 'This batch is being sent right now. Wait for it to finish, then void it.' });

  // A batch that has a QuickBooks invoice can only be voided here if that
  // invoice is voided too — otherwise the loads would go back to Ready to
  // Bill while a live invoice for them still exists in QuickBooks. The one
  // exception is an explicit statement that the invoice was already voided
  // in QuickBooks by hand (alreadyVoidedInQuickBooks: true), which is logged.
  const conn = store.qbConnection;
  let qbVoided = false;
  if (b.qbInvoiceId) {
    if (req.body?.alreadyVoidedInQuickBooks === true) {
      logQbSync({ actionType: 'void_invoice', relatedBatchId: b.id, qbEntityType: 'Invoice', qbEntityId: b.qbInvoiceId, requestSummary: `Operator states invoice was voided in QuickBooks manually: ${reason}`, user: req.session.user.username });
    } else {
      if (!conn || conn.status !== 'connected') {
        return res.status(409).json({
          error: `QuickBooks invoice ${b.qbInvoiceNumber || b.qbInvoiceId} exists for this batch and QuickBooks is not connected. `
               + 'Reconnect QuickBooks so the invoice can be voided, or void it in QuickBooks yourself and then void this batch with "already voided in QuickBooks".',
          qbInvoiceId: b.qbInvoiceId, qbInvoiceNumber: b.qbInvoiceNumber,
        });
      }
      try {
        await qb.voidInvoice(conn, b.qbInvoiceId);
        qbVoided = true;
        logQbSync({ actionType: 'void_invoice', relatedBatchId: b.id, qbEntityType: 'Invoice', qbEntityId: b.qbInvoiceId, requestSummary: reason, user: req.session.user.username });
      } catch (e) {
        logQbSync({ actionType: 'void_invoice', relatedBatchId: b.id, qbEntityType: 'Invoice', qbEntityId: b.qbInvoiceId, responseStatus: 'error', errorMessage: e.message, user: req.session.user.username });
        return res.status(502).json({ error: `Failed to void in QuickBooks: ${e.message}. The batch and its loads are unchanged.` });
      }
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
  logAction(req.session.user, 'voided-billing-batch', b.id, { reason, qbVoided, manualQbVoid: req.body?.alreadyVoidedInQuickBooks === true, loads: b.loadIds.length });
  await saveData();
  res.json({ success: true, batch: b, qbVoided });
});

// Retry a failed send (same logic as /send; allowed when status === 'failed')
app.post('/api/billing-batches/:id/retry', reqMgr, async (req, res) => {
  const b = store.billingBatches.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Batch not found' });
  if (b.syncStatus !== 'failed') return res.status(400).json({ error: 'Only failed batches can be retried' });
  if (b.qbInvoiceId) {
    return res.status(409).json({ error: `Invoice ${b.qbInvoiceNumber || b.qbInvoiceId} already exists in QuickBooks for this batch. Retrying would create a second one; void the batch instead.` });
  }
  // Reset so the client can POST /send again.
  b.syncStatus = 'ready_to_bill';
  b.errorMessage = '';
  b.syncingSince = '';
  logAction(req.session.user, 'retry-billing-batch', b.id, {});
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
      const costD = costDetail(l);
      const cost = costD.amount == null ? 0 : costD.amount;
      total += cost;
      const lk = `${l.material}|${costD.unit}|${l.vendorRate || 0}`;
      if (!lineMap.has(lk)) {
        lineMap.set(lk, { material: l.material, unit: costD.unit, rate: Number(l.vendorRate) || 0, loads: 0, tons: 0, amount: 0, loadIds: [], unconfigured: false, reasons: [] });
      }
      const ln = lineMap.get(lk);
      ln.loads += Number(l.loadsDelivered) || 0;
      ln.tons  += (costD.unit === 'ton' && costD.qtyPerLoad != null) ? costD.qtyPerLoad * (Number(l.loadsDelivered) || 0) : 0;
      ln.amount += cost;
      ln.loadIds.push(l.id);
      if (costD.unconfigured) { ln.unconfigured = true; if (!ln.reasons.includes(costD.reason)) ln.reasons.push(costD.reason); }
    }
    const lineItems = [...lineMap.values()].map(ln => ({
      ...ln,
      description: `${ln.material} — ${ln.loads} load${ln.loads === 1 ? '' : 's'}` + (ln.unit === 'ton' ? ` (${ln.tons.toFixed(2)} ton @ $${ln.rate}/ton)` : ` (@ $${ln.rate}/${ln.unit})`) + (ln.unconfigured ? ' [NOT PRICEABLE]' : ''),
    }));
    groups.push({
      unconfigured: lineItems.some(ln => ln.unconfigured),
      unconfiguredReasons: [...new Set(lineItems.flatMap(ln => ln.reasons || []))],
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
  const bad = groups.filter(g => g.unconfigured);
  if (bad.length) return res.status(400).json({ error: 'Some loads cannot be costed yet: ' + [...new Set(bad.flatMap(g => g.unconfiguredReasons))].join('; ') });
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
// GET /api/fleet — office only. Vehicles + the driver roster with login state.
app.get('/api/fleet', reqMgr, async (req, res) => {
  res.json({ trucks: store.trucks || [], drivers: await fleetDrivers(), truckStatuses: TRUCK_STATUSES, driverStatuses: DRIVER_STATUSES });
});

// ── Drivers CRUD — roster first, login second ──
// Creating a driver here makes them dispatchable immediately (roster) and
// able to log in (users table, when Postgres is available).
app.post('/api/drivers', reqMgr, async (req, res) => {
  const { username, password, displayName } = req.body || {};
  const defaultTruckId = req.body?.defaultTruckId ?? req.body?.truckId ?? '';
  const uname = String(username || '').toLowerCase().trim();
  if (!uname || !/^[a-z0-9_.-]+$/.test(uname)) {
    return res.status(400).json({ error: 'username must be lowercase letters/numbers/_.-' });
  }
  if (rosterDriver(uname)) return res.status(409).json({ error: 'A driver with that username already exists' });
  if (defaultTruckId && !(store.trucks || []).some(t => t.id === defaultTruckId)) {
    return res.status(400).json({ error: 'Unknown truck for default truck' });
  }
  const dName = String(displayName || '').trim() || (uname.charAt(0).toUpperCase() + uname.slice(1));
  let loginCreated = false;
  if (pg) {
    if (!password || String(password).length < 4) return res.status(400).json({ error: 'password must be at least 4 characters' });
    try {
      const existing = await pg.query('SELECT 1 FROM users WHERE company_id=$1 AND username=$2', [DEFAULT_COMPANY_ID, uname]);
      if (existing.rows.length) return res.status(409).json({ error: 'username already exists' });
      await pg.query(
        `INSERT INTO users (id, company_id, username, password, role, truck_id, display_name, active)
         VALUES ($1, $2, $3, $4, 'driver', $5, $6, true)`,
        [`user-${DEFAULT_COMPANY_ID}-${uname}`, DEFAULT_COMPANY_ID, uname, password, uname, dName]
      );
      loginCreated = true;
    } catch (e) {
      console.error('[POST /api/drivers]', e.message);
      return res.status(500).json({ error: 'Could not create the login: ' + e.message });
    }
  }
  upsertRosterDriver({ id: uname, name: dName, defaultTruckId: defaultTruckId || null, active: true });
  logAction(req.session.user, 'created-driver', uname, { displayName: dName, defaultTruckId: defaultTruckId || null, loginCreated });
  await saveData();
  res.json({ ok: true, loginCreated, drivers: await fleetDrivers(), roster: driverRoster() });
});

app.put('/api/drivers/:username', reqMgr, async (req, res) => {
  const uname = String(req.params.username || '').toLowerCase();
  const d = rosterDriver(uname);
  if (!d) return res.status(404).json({ error: 'driver not found' });
  const b = req.body || {};
  const defaultTruckId = b.defaultTruckId ?? b.truckId;
  if (defaultTruckId && !(store.trucks || []).some(t => t.id === defaultTruckId)) {
    return res.status(400).json({ error: 'Unknown truck for default truck' });
  }
  if (b.status !== undefined && !DRIVER_STATUSES.includes(b.status)) {
    return res.status(400).json({ error: `Status must be one of: ${DRIVER_STATUSES.join(', ')}` });
  }
  upsertRosterDriver({ id: uname, name: b.displayName ?? b.name, defaultTruckId, active: b.active, status: b.status, phone: b.phone, notes: b.notes });
  if (pg) {
    const sets = []; const vals = []; let i = 1;
    if (b.displayName !== undefined) { sets.push(`display_name = $${i++}`); vals.push(String(b.displayName).trim()); }
    if (b.active !== undefined)      { sets.push(`active = $${i++}`); vals.push(!!b.active); }
    if (b.password !== undefined && String(b.password).length >= 4) { sets.push(`password = $${i++}`); vals.push(String(b.password)); }
    // truck_id is the driver's roster id, never a vehicle.
    sets.push(`truck_id = $${i++}`); vals.push(uname);
    vals.push(DEFAULT_COMPANY_ID, uname);
    try {
      await pg.query(`UPDATE users SET ${sets.join(', ')} WHERE company_id = $${i++} AND username = $${i++}`, vals);
    } catch (e) {
      console.error('[PUT /api/drivers]', e.message);
      return res.status(500).json({ error: 'Roster updated but the login could not be updated: ' + e.message });
    }
  }
  logAction(req.session.user, 'updated-driver', uname, { fields: Object.keys(b) });
  await saveData();
  res.json({ ok: true, drivers: await fleetDrivers(), roster: driverRoster() });
});

// Disable by default so historical loads keep their driver. ?hard=1 removes
// a driver with no load history at all.
app.delete('/api/drivers/:username', reqMgr, async (req, res) => {
  const uname = String(req.params.username || '').toLowerCase();
  const d = rosterDriver(uname);
  if (!d) return res.status(404).json({ error: 'driver not found' });
  const inUse = store.loads.some(l => l.truckId === uname);
  if (req.query.hard === '1') {
    if (inUse) return res.status(409).json({ error: 'driver has loads — disable instead of deleting' });
    store.drivers = store.drivers.filter(x => x.id !== uname);
    if (pg) await pg.query('DELETE FROM users WHERE company_id=$1 AND username=$2', [DEFAULT_COMPANY_ID, uname]).catch(e => console.error('[DELETE /api/drivers]', e.message));
    logAction(req.session.user, 'deleted-driver', uname, {});
  } else {
    d.active = false;
    if (pg) await pg.query('UPDATE users SET active=false WHERE company_id=$1 AND username=$2', [DEFAULT_COMPANY_ID, uname]).catch(e => console.error('[DELETE /api/drivers]', e.message));
    logAction(req.session.user, 'disabled-driver', uname, {});
  }
  await saveData();
  res.json({ ok: true, drivers: await fleetDrivers(), roster: driverRoster() });
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

  // Same engine as billing and profitability, for exactly one load. A unit
  // that cannot be priced yet comes back as null with the reason — never $0.
  const revD  = computeAmount(cust.price, cust.unit, 1, material, null, {});
  const costD = computeAmount(vend.price, vend.unit, 1, material, null, {});
  const revPerLoad  = revD.amount;
  const costPerLoad = costD.amount;
  const marginPerLoad = (revPerLoad == null || costPerLoad == null) ? null : revPerLoad - costPerLoad;

  res.json({
    customer: { rate: cust.price, unit: cust.unit, isDefault: cust.isDefault, perLoad: revPerLoad, unconfigured: revD.unconfigured, reason: revD.reason, qtyPerLoad: revD.qtyPerLoad },
    vendor:   { rate: vend.price, unit: vend.unit, isDefault: vend.isDefault, isInternal: vend.isInternal || false, perLoad: costPerLoad, unconfigured: costD.unconfigured, reason: costD.reason, qtyPerLoad: costD.qtyPerLoad },
    margin:   { perLoad: marginPerLoad, percent: (marginPerLoad != null && revPerLoad > 0) ? (marginPerLoad / revPerLoad * 100) : null },
    calculable: marginPerLoad != null,
    tonsPerLoad: qtyPerLoad('ton', material),
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

  // Compute durations in minutes for ONE trip. Returns null for an interval
  // that can't be computed (missing endpoint).
  //
  // The source of truth is the individual trip record in load.trips[]. The
  // load-level timestamps/isoStamps are only a mirror of the CURRENT trip and
  // are reset when a new trip starts, so reading them reported a 3-trip load
  // as a single data point and discarded trips 1 and 2.
  const durationsForTrip = (l, source) => {
    const iso = source.isoStamps || {};
    const ts  = source.timestamps || {};
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

  // Expand every matched load into one record PER TRIP. A load with
  // loadsAssigned=3 yields three records, each with its own timings and its
  // own pickup yard (a driver can rotate yards between trips).
  //
  // Legacy loads saved before per-trip tracking have no trips[]; they fall
  // back to their load-level stamps as a single synthetic trip so historical
  // data is preserved rather than dropped.
  const tripRecords = [];
  matched.forEach(l => {
    const trips = (Array.isArray(l.trips) && l.trips.length)
      ? l.trips
      : [{
          tripNum: 1,
          timestamps: l.timestamps || {},
          isoStamps:  l.isoStamps  || {},
          actualYardId: l.actualYardId,
        }];
    trips.forEach((t, i) => {
      tripRecords.push({
        load: l,
        tripNum: t.tripNum || (i + 1),
        // Per-trip yard wins, then the load's actual yard, then the assignment
        yardId: t.actualYardId || l.actualYardId || l.vendorId || '',
        d: durationsForTrip(l, t),
      });
    });
  });

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
  // keyFn receives a TRIP RECORD ({ load, tripNum, yardId, d }), so a load
  // whose trips used different yards contributes to each yard's stats.
  const groupBy = (keyFn, labelFn = (k) => k) => {
    const buckets = new Map();
    tripRecords.forEach(r => {
      const k = keyFn(r);
      if (!k) return;  // skip records with no group identity (e.g. no driver)
      if (!buckets.has(k)) buckets.set(k, { rows: [], loadIds: new Set() });
      buckets.get(k).rows.push(r.d);
      buckets.get(k).loadIds.add(r.load.id);
    });
    const out = [];
    for (const [k, b] of buckets.entries()) {
      const arr = b.rows;
      out.push({
        key: k,
        label: labelFn(k),
        trips: arr.length,          // number of individual hauls measured
        loads: b.loadIds.size,      // number of distinct load records behind them
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
    const t = driverRoster().find(x => x.id === id);
    return t ? t.label : id;
  };

  const poFor = (l) =>
    store.pos.find(p => p.id === l.poId)
    || (store.archive || []).flatMap(b => b.pos || []).find(p => p.id === l.poId)
    || {};

  const byYard     = groupBy(r => r.yardId, yardLabel);
  const byCustomer = groupBy(r => poFor(r.load).customer || '', x => x);
  const byJobCode  = groupBy(r => poFor(r.load).jobCode  || '', x => x || '(no job code)');
  const byCity     = groupBy(r => poFor(r.load).city     || '', x => x || '(no city)');
  const byMaterial = groupBy(r => r.load.material || '', x => x);
  const byDriver   = groupBy(r => r.load.truckId || '',  truckLabel);

  // Slowest / fastest yards on yard service time (only yards with ≥3 loads
  // for stat stability)
  const MIN_SAMPLE = 3;
  const yardsWithEnough = byYard.filter(g => g.yardService.count >= MIN_SAMPLE);
  const slowestYards = [...yardsWithEnough].sort((a, b) => (b.yardService.avg || 0) - (a.yardService.avg || 0)).slice(0, 5);
  const fastestYards = [...yardsWithEnough].sort((a, b) => (a.yardService.avg || 0) - (b.yardService.avg || 0)).slice(0, 5);
  const slowestJobsites = byCustomer
    .filter(g => g.jobsiteService.count >= 3)
    .sort((a, b) => (b.jobsiteService.avg || 0) - (a.jobsiteService.avg || 0))
    .slice(0, 5);

  // Overall summary — every trip across every matched load
  const all = tripRecords.map(r => r.d);
  const overall = {
    matchedLoads: matched.length,
    matchedTrips: tripRecords.length,
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
  // Loads whose unit has no quantity-per-load defined contribute $0 cost,
  // which makes margin look better than it is. Count them so the UI can say
  // the figure is incomplete instead of quietly overstating profit.
  const unpriced = { costLoads: 0, revenueLoads: 0, units: new Set() };

  eligible.forEach(l => {
    const po = allPos.find(p => p.id === l.poId) || {};
    const revD = revenueDetail(l);
    const costD = costDetail(l);
    if (costD.unconfigured) { unpriced.costLoads++; unpriced.units.add(costD.unit); }
    if (revD.unconfigured)  { unpriced.revenueLoads++; unpriced.units.add(revD.unit); }
    const rev    = revD.amount == null ? 0 : revD.amount;
    const cost   = costD.amount == null ? 0 : costD.amount;
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
      // Truthfulness flags — see `unpriced` above
      unpricedCostLoads: unpriced.costLoads,
      unpricedRevenueLoads: unpriced.revenueLoads,
      unpricedUnits: [...unpriced.units],
      costIncomplete: unpriced.costLoads > 0,
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

    // Use the SAME costing function as /api/profitability. These two screens
    // previously ran different formulas and reported the same load 25x apart.
    const det = costDetail(l);
    const unitPrice = det.rate;
    const unit = det.unit;
    const cost = det.amount == null ? 0 : det.amount;

    byVendor[vendorId].totalLoads += delivered;
    byVendor[vendorId].totalCost  += cost;
    if (det.unconfigured) {
      byVendor[vendorId].unconfigured = true;
      byVendor[vendorId].unconfiguredUnits = [...new Set([...(byVendor[vendorId].unconfiguredUnits || []), unit])];
    }

    if (!byVendor[vendorId].byMaterial[l.material]) {
      byVendor[vendorId].byMaterial[l.material] = { loads: 0, cost: 0, unit, unitPrice, unconfigured: false };
    }
    byVendor[vendorId].byMaterial[l.material].loads += delivered;
    byVendor[vendorId].byMaterial[l.material].cost  += cost;
    if (det.unconfigured) byVendor[vendorId].byMaterial[l.material].unconfigured = true;
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
  driverRoster().forEach(t => {
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
  // Archive batches carry full load copies; keep photo payloads out of this list.
  const slim = l => ({ ...l, ticketImage: l.ticketImage ? '[stored]' : '', pod: l.pod ? { ...l.pod, signature: l.pod.signature ? '[stored]' : '' } : l.pod });
  const archive = (store.archive || []).map(b => ({ ...b, loads: (b.loads || []).map(slim) }));
  res.json({ billed, archive });
});

// Archive billed loads → push to Sheets and remove from active store
app.post('/api/history/archive', reqMgr, async (req, res) => {
  // Archiving moves records out of the active lists. Without Sheets there is
  // no external copy, so it is refused rather than quietly done anyway.
  if (!sheets) return res.status(503).json({ error: 'Google Sheets is not configured — nothing was archived. Set GOOGLE_SERVICE_ACCOUNT_JSON.' });
  const billed = store.loads.filter(l => l.billStatus === 'billed' && !l.voided);
  if (!billed.length) return res.status(400).json({ error: 'No billed loads to archive' });

  const billedPoIds = new Set(billed.map(l => l.poId));
  // Only archive POs whose ALL loads are billed (otherwise leave the PO active)
  const fullyBilledPos = [...billedPoIds].filter(pid => {
    const all = store.loads.filter(l => l.poId === pid && !l.voided);
    return all.length > 0 && all.every(l => l.billStatus === 'billed');
  });
  const archivedPos = store.pos.filter(p => fullyBilledPos.includes(p.id));

  // Push to Sheets first — only move records if it succeeds
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
    // Full copies, not just counts: the approved evidence stays in the
    // database even though it leaves the active board.
    pos: archivedPos,
    loads: billed,
  });
  logAction(req.session.user, 'archived-batch', batchId, {
    poCount: archivedPos.length,
    loadCount: billed.length,
    syncedToSheet: sheetSuccess,
  });
  // No cap: each batch now carries the archived records themselves.

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
// The service-account credential comes ONLY from the environment
// (GOOGLE_SERVICE_ACCOUNT_JSON: the key file's JSON, raw or base64). A
// service-account.json on disk is deliberately ignored — one was committed to
// this repo's history and has to be treated as compromised, so the app must
// never quietly pick a file like that back up.
let sheets = null;
function loadGoogleCredentials() {
  const raw = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) return null;
  const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const creds = JSON.parse(text);
  if (creds.type !== 'service_account' || !creds.client_email || !creds.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not a service-account key');
  }
  return creds;
}
try {
  if (fs.existsSync(path.join(__dirname, 'service-account.json'))) {
    console.warn('⚠ SECURITY: service-account.json is present on disk and is IGNORED. Delete it; use GOOGLE_SERVICE_ACCOUNT_JSON.');
  }
  const credentials = loadGoogleCredentials();
  if (credentials) {
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheets = google.sheets({ version: 'v4', auth });
    console.log(`✓ Google Sheets ready (${credentials.client_email})`);
  } else {
    console.log('· Google Sheets not configured (GOOGLE_SERVICE_ACCOUNT_JSON unset) — archive/sync disabled');
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

// ── LIVE REFRESH ─────────────────────────────────────────────────────────────
// A tiny fingerprint of what the caller should currently be seeing. Clients
// poll this and only pull the full payload when the value changes, so a phone
// sitting in a truck cab all day costs almost nothing.
//
// Polling on purpose: for a five-truck fleet it is far more reliable than a
// WebSocket that has to survive cell handoffs, tunnels and screen sleep.
function dispatchFingerprint(loads) {
  const parts = loads.map(l => [
    l.id, l.truckId || '-', l.truckUnitId || '-', l.vendorId || '-',
    l.actualYardId || '-', l.loadsAssigned, l.loadsDelivered,
    l.status, l.approvalStatus, l.deliveryDate,
    (l.trips || []).length,
  ].join(':'));
  parts.sort();
  return require('crypto').createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

app.get('/api/dispatch-version', reqAuth, (req, res) => {
  const u = req.session.user;
  const today = todayStr();
  const scope = u.role === 'driver'
    ? driverWorkdayLoads(u)
    : store.loads.filter(l => !l.voided && l.deliveryDate === today);
  res.json({ version: dispatchFingerprint(scope), count: scope.length, at: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════════════════════
// FLEET (TRUCKS) & DRIVERS — real, independent entities
// ═══════════════════════════════════════════════════════════════════════════
// NOTE: /api/fleet is registered earlier (the company-scoped version added on
// the other branch). Express only runs the first match, so the duplicate that
// the branch merge left here was dead code and has been removed. Live driver
// and truck availability for Quick Assign comes from /api/today instead.

// ── TODAY BOARD — everything Quick Assign needs in ONE call ─────────────────
// The dispatcher must never wait on several round trips to assign a load.
app.get('/api/today', reqMgr, (req, res) => {
  const day = req.query.date || todayStr();
  const dayLoads = store.loads.filter(l => !l.voided && l.deliveryDate === day);

  const bucketOf = (l) => {
    if (l.approvalStatus === 'approved') return 'completed';
    if (l.approvalStatus === 'submitted') return 'awaiting-approval';
    if (!l.truckId || l.truckId === 'unassigned') return 'unassigned';
    if ((l.loadsDelivered || 0) > 0 || (l.trips || []).length > 0) return 'in-progress';
    return 'assigned';
  };

  const loads = dayLoads.map(l => {
    const po = store.pos.find(p => p.id === l.poId) || {};
    const pickup = resolvePickupYard(l, po);
    const truck = getTruckForLoad(l);
    return {
      id: l.id,
      bucket: bucketOf(l),
      poId: l.poId,
      notifyOn: !!po.notifications?.enabled,
      poNumber: po.poNumber || '', customer: po.customer || '',
      jobName: po.job || po.customer || '', jobCode: po.jobCode || '',
      address: po.address || '', city: po.city || '',
      material: l.material,
      loadsAssigned: l.loadsAssigned, loadsDelivered: l.loadsDelivered || 0,
      driverId: l.truckId || null, driverName: l.driverName || '',
      truckUnitId: l.truckUnitId || null, truckNum: truck ? truck.truckNum : '',
      yardId: pickup.id, yardName: pickup.name,
      locked: !!l.locked,
      approvalStatus: l.approvalStatus,
      missingTicket: !l.ticketImage && !l.ticketImageUrl,
    };
  });

  // Driver availability, derived from today's actual work
  const busyBy = new Map();
  dayLoads.forEach(l => {
    if (!l.truckId || l.approvalStatus === 'approved') return;
    if (!busyBy.has(l.truckId)) busyBy.set(l.truckId, []);
    busyBy.get(l.truckId).push(l.id);
  });
  const drivers = (store.drivers || []).filter(d => d.active).map(d => ({
    id: d.id, name: d.name, status: d.status,
    openLoadIds: busyBy.get(d.id) || [],
    available: (busyBy.get(d.id) || []).length === 0 && d.status !== 'off',
    lastSeen: (store.driverLocations || {})[d.id] || null,
  }));

  const truckBusy = new Map();
  dayLoads.forEach(l => {
    if (l.truckUnitId && l.approvalStatus !== 'approved') truckBusy.set(l.truckUnitId, l.id);
  });
  const trucks = (store.trucks || []).filter(t => t.active).map(t => ({
    id: t.id, truckNum: t.truckNum, type: t.type, status: t.status,
    inUseOnLoadId: truckBusy.get(t.id) || null,
    available: !truckBusy.has(t.id) && t.status === 'available',
  }));

  const count = (b) => loads.filter(l => l.bucket === b).length;
  res.json({
    date: day,
    version: dispatchFingerprint(dayLoads),
    loads, drivers, trucks,
    yards: store.vendors.filter(v => v.active).map(v => ({ id: v.id, name: v.name, isInternal: v.id === 'vbt' })),
    summary: {
      jobs: new Set(dayLoads.map(l => l.poId)).size,
      loads: dayLoads.length,
      unassigned: count('unassigned'),
      assigned: count('assigned'),
      inProgress: count('in-progress'),
      completed: count('completed'),
      awaitingApproval: count('awaiting-approval'),
      driversWorking: drivers.filter(d => d.openLoadIds.length > 0).length,
      driversAvailable: drivers.filter(d => d.available).length,
      missingTicket: loads.filter(l => l.missingTicket && l.bucket === 'awaiting-approval').length,
    },
  });
});

app.post('/api/fleet/trucks', reqMgr, async (req, res) => {
  const { truckNum, type, status, mileage, maintenanceNotes, defaultDriverId } = req.body || {};
  if (!truckNum || !String(truckNum).trim()) return res.status(400).json({ error: 'Truck number is required' });
  const num = String(truckNum).trim();
  if ((store.trucks || []).some(t => t.truckNum.toLowerCase() === num.toLowerCase())) {
    return res.status(400).json({ error: 'A truck with that number already exists' });
  }
  const truck = {
    id: 'truck-' + num.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Math.floor(Math.random() * 1000),
    truckNum: num,
    type: type || '',
    status: TRUCK_STATUSES.includes(status) ? status : 'available',
    mileage: mileage === '' || mileage == null ? null : Number(mileage),
    maintenanceNotes: maintenanceNotes || '',
    defaultDriverId: defaultDriverId || null,
    active: true,
  };
  store.trucks.push(truck);
  logAction(req.session.user, 'added-truck', truck.id, { truckNum: truck.truckNum });
  await saveData();
  res.json({ success: true, truck });
});

app.put('/api/fleet/trucks/:id', reqMgr, async (req, res) => {
  const t = (store.trucks || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Truck not found' });
  const before = { ...t };
  const b = req.body || {};
  if (b.truckNum !== undefined && String(b.truckNum).trim()) t.truckNum = String(b.truckNum).trim();
  if (b.type !== undefined) t.type = b.type;
  if (b.status !== undefined) {
    if (!TRUCK_STATUSES.includes(b.status)) return res.status(400).json({ error: `Status must be one of: ${TRUCK_STATUSES.join(', ')}` });
    t.status = b.status;
  }
  if (b.mileage !== undefined) t.mileage = b.mileage === '' || b.mileage == null ? null : Number(b.mileage);
  if (b.maintenanceNotes !== undefined) t.maintenanceNotes = b.maintenanceNotes;
  if (b.defaultDriverId !== undefined) t.defaultDriverId = b.defaultDriverId || null;
  if (b.active !== undefined) t.active = !!b.active;
  logAction(req.session.user, 'updated-truck', t.id, { truckNum: t.truckNum, before, after: { ...t } });
  await saveData();
  res.json({ success: true, truck: t });
});

// Trucks are never deleted once they have history — deactivate instead.
app.delete('/api/fleet/trucks/:id', reqMgr, async (req, res) => {
  const t = (store.trucks || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Truck not found' });
  const used = store.loads.some(l => l.truckUnitId === t.id);
  if (used) {
    t.active = false;
    logAction(req.session.user, 'deactivated-truck', t.id, { truckNum: t.truckNum, reason: 'has load history' });
    await saveData();
    return res.json({ success: true, deactivated: true, message: 'Truck has delivery history — deactivated instead of deleted.' });
  }
  store.trucks = store.trucks.filter(x => x.id !== t.id);
  logAction(req.session.user, 'deleted-truck', t.id, { truckNum: t.truckNum });
  await saveData();
  res.json({ success: true, deactivated: false });
});


// ── QUICK ASSIGN — driver, truck and pickup yard in one mobile-friendly call ──
// Everything else (customer, job, material, quantity, PO, date) already lives
// on the load and is never re-entered.
app.post('/api/loads/:id/assign', reqMgr, async (req, res) => {
  const l = store.loads.find(x => x.id === req.params.id);
  if (!l) return res.status(404).json({ error: 'Load not found' });
  if (l.locked) return res.status(403).json({ error: 'Load is approved and locked' });
  const { driverId, truckUnitId, yardId } = req.body || {};
  const changes = {};

  if (driverId !== undefined) {
    const drv = driverId ? driverRoster().find(t => t.id === driverId) : null;   // active roster only
    if (driverId && !drv) return res.status(400).json({ error: 'Unknown or inactive driver' });
    const rd = driverId ? rosterDriver(driverId) : null;
    if (rd && rd.status === 'off') return res.status(400).json({ error: `${rd.name} is marked off today` });
    changes.driver = { from: l.driverName || 'Unassigned', to: drv?.label || 'Unassigned' };
    l.truckId = driverId || null;
    l.driverName = drv?.label || '';
    l.status = driverId ? (l.status === 'unassigned' ? 'active' : l.status) : 'unassigned';
  }
  if (truckUnitId !== undefined) {
    const t = truckUnitId ? (store.trucks || []).find(x => x.id === truckUnitId) : null;
    if (truckUnitId && !t) return res.status(400).json({ error: 'Unknown truck' });
    if (t && t.active === false) return res.status(400).json({ error: `${t.truckNum} is deactivated` });
    if (t && (t.status === 'maintenance' || t.status === 'out-of-service')) return res.status(400).json({ error: `${t.truckNum} is ${t.status}` });
    changes.truck = { from: (getTruckForLoad(l) || {}).truckNum || 'none', to: t?.truckNum || 'none' };
    l.truckUnitId = truckUnitId || null;
  }
  if (yardId !== undefined) {
    const v = store.vendors.find(x => x.id === yardId);
    if (yardId && !v) return res.status(400).json({ error: 'Unknown pickup yard' });
    changes.yard = { from: resolvePickupYard(l, store.pos.find(p => p.id === l.poId)).name, to: v?.name || '' };
    l.vendorId = yardId || null;
    l.vendorName = v?.name || '';
    // actualYardId is a load-level mirror of the CURRENT trip's yard. A new
    // assignment must win over that mirror, otherwise the driver keeps seeing
    // the yard they used on the last completed trip. The permanent per-trip
    // record in trips[].actualYardId is deliberately left untouched — that is
    // delivery history and must never be rewritten.
    l.actualYardId = null;
    l.actualYardName = '';
    // Re-price against the new yard so cost follows the actual supplier.
    if (yardId) {
      const vr = resolveVendorRate(yardId, l.material);
      l.vendorRate = vr.price;
      l.vendorUnit = vr.unit;
      l.vendorRateIsDefault = vr.isDefault;
      l.vendorIsInternal = !!vr.isInternal;
      l.pricePerUnit = vr.price;
    }
  }

  logAction(req.session.user, 'quick-assigned-load', l.id, changes);
  // Tell the customer only when a driver was actually put on the load —
  // not when the truck or yard alone changed.
  if (changes.driver && l.truckId) {
    notifyLoadEvent(l, store.pos.find(p => p.id === l.poId), 'driverAssigned', { user: req.session.user.username });
  }
  await saveData();
  const po = store.pos.find(p => p.id === l.poId) || {};
  res.json({ success: true, load: l, pickup: resolvePickupYard(l, po), truck: getTruckForLoad(l) });
});

// ═══════════════════════════════════════════════════════════════════════════
// COSTING SETTINGS — unit model (P4) and operating rates (P5)
// ═══════════════════════════════════════════════════════════════════════════
// Reports which units are actually in use and which of them still have no
// quantity-per-load defined, so management can see exactly what to fill in.
app.get('/api/costing/settings', reqMgr, (req, res) => {
  const unitsInUse = new Map();
  store.loads.forEach(l => {
    [[l.vendorUnit, 'cost'], [l.customerUnit, 'revenue']].forEach(([u, side]) => {
      const k = unitKey(u || 'ton');
      if (!unitsInUse.has(k)) unitsInUse.set(k, { unit: k, side: new Set(), loads: 0, materials: new Set() });
      const e = unitsInUse.get(k);
      e.side.add(side); e.loads++; if (l.material) e.materials.add(l.material);
    });
  });
  const units = [...unitsInUse.values()].map(e => ({
    unit: e.unit,
    usedFor: [...e.side],
    loads: e.loads,
    materials: [...e.materials],
    qtyPerLoad: qtyPerLoad(e.unit, null),
    configured: qtyPerLoad(e.unit, null) != null,
  }));
  res.json({
    unitConfig: store.unitConfig,
    costRates: store.costRates,
    unitsInUse: units,
    // Units genuinely in use on real loads that cannot be priced: an
    // unconfigured quantity-per-load, or a measured unit (mile/hour) — those
    // need miles/hours recorded on each load rather than a setting.
    needsAttention: units.filter(u => !u.configured && u.loads > 0).map(u => u.unit),
    measuredUnits: MEASURED_UNITS,
    supportedUnits: SUPPORTED_UNITS,
    tonsPerLoadRule: TONS_PER_LOAD,
  });
});

app.put('/api/costing/units', reqMgr, async (req, res) => {
  const { byUnit, byMaterial } = req.body || {};
  const clean = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
      if (v === '' || v === null) { out[unitKey(k)] = null; continue; }
      const n = Number(v);
      if (!isFinite(n) || n <= 0) return { error: `Quantity per load for "${k}" must be a positive number` };
      out[unitKey(k)] = n;
    }
    return { out };
  };
  if (byUnit !== undefined) {
    const r = clean(byUnit);
    if (r.error) return res.status(400).json({ error: r.error });
    store.unitConfig.byUnit = { ...store.unitConfig.byUnit, ...r.out };
  }
  if (byMaterial !== undefined) {
    for (const [mat, units] of Object.entries(byMaterial || {})) {
      const r = clean(units);
      if (r.error) return res.status(400).json({ error: `${mat}: ${r.error}` });
      store.unitConfig.byMaterial[mat] = { ...(store.unitConfig.byMaterial[mat] || {}), ...r.out };
    }
  }
  logAction(req.session.user, 'updated-unit-config', '', { byUnit, byMaterial });
  await saveData();
  res.json({ success: true, unitConfig: store.unitConfig });
});

app.put('/api/costing/rates', reqMgr, async (req, res) => {
  const fields = ['driverWagePerHour', 'fuelPricePerGallon', 'truckMpgLoaded', 'truckCostPerMile'];
  const before = { ...store.costRates };
  for (const f of fields) {
    if (!(f in (req.body || {}))) continue;
    const v = req.body[f];
    if (v === '' || v === null) { store.costRates[f] = null; continue; }
    const n = Number(v);
    if (!isFinite(n) || n < 0) return res.status(400).json({ error: `${f} must be a non-negative number` });
    store.costRates[f] = n;
  }
  store.costRates.updatedAt = new Date().toISOString();
  store.costRates.updatedBy = req.session.user.username;
  logAction(req.session.user, 'updated-cost-rates', '', { before, after: { ...store.costRates } });
  await saveData();
  res.json({ success: true, costRates: store.costRates });
});

// ═══════════════════════════════════════════════════════════════════════════
// CUSTOMER NOTIFICATIONS — Gmail
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/notifications/status', reqMgr, (req, res) => {
  res.json({
    mailer: mailer.status(),
    eventKeys: Object.keys(DEFAULT_NOTIFY_EVENTS),
    posEnabled: store.pos.filter(p => p.notifications && p.notifications.enabled).length,
    totalPos: store.pos.length,
  });
});

// Verify the Gmail credentials without emailing a customer.
app.post('/api/notifications/verify', reqMgr, async (req, res) => {
  const r = await mailer.verify();
  res.json(r);
});

// Send a test message to the signed-in dispatcher (or a given address).
// `force` bypasses the dry-run flag — this is the one path where that is safe,
// because the operator chose the recipient themselves.
app.post('/api/notifications/test', reqMgr, async (req, res) => {
  const to = (req.body?.to || '').trim();
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: 'A valid email address is required' });
  const { subject, text, html } = mailer.buildMessage('delivered', {
    customer: 'Test Customer', jobName: 'Test Job', address: '123 Example St', city: 'Fresno',
    material: '3/4 Rock', loadNum: 1, totalLoads: 1, truckNum: 'Truck #12',
    yardName: 'VBT Yard', poNumber: 'PO-TEST',
    when: new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }),
    note: 'This is a test from Valley Best Dispatch. No real delivery is involved.',
  });
  const r = await mailer.send({ to, subject: '[TEST] ' + subject, text, html, force: true });
  logNotification({ event: 'test', to, subject, status: r.sent ? 'sent' : 'failed', reason: r.error || '', messageId: r.messageId || '', triggeredBy: req.session.user.username });
  await saveData();
  res.json(r.sent ? { success: true, messageId: r.messageId } : { error: r.error || 'Send failed' });
});

// Per-PO settings
app.get('/api/pos/:id/notifications', reqMgr, (req, res) => {
  const po = store.pos.find(p => p.id === req.params.id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  ensureNotifyCfg(po);
  const cust = store.customers.find(c => (c.name || '').toLowerCase().trim() === (po.customer || '').toLowerCase().trim());
  res.json({
    notifications: po.notifications,
    eventKeys: Object.keys(DEFAULT_NOTIFY_EVENTS),
    // Offer the customer-master email as a starting point, don't auto-use it
    suggestedEmail: cust?.email || '',
    mailer: mailer.status(),
  });
});

app.put('/api/pos/:id/notifications', reqMgr, async (req, res) => {
  const po = store.pos.find(p => p.id === req.params.id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  ensureNotifyCfg(po);
  const b = req.body || {};

  if (b.contacts !== undefined) {
    if (!Array.isArray(b.contacts)) return res.status(400).json({ error: 'contacts must be a list' });
    const clean = [];
    for (const c of b.contacts) {
      const email = String(c?.email || '').trim();
      if (!email) continue;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: `"${email}" is not a valid email address` });
      clean.push({ name: String(c.name || '').trim(), email });
    }
    po.notifications.contacts = clean;
  }
  if (b.events !== undefined) {
    const ev = { ...po.notifications.events };
    for (const [k, v] of Object.entries(b.events || {})) {
      if (k in DEFAULT_NOTIFY_EVENTS) ev[k] = !!v;
    }
    po.notifications.events = ev;
  }
  if (b.enabled !== undefined) {
    // Refuse to arm notifications with nowhere to send them — otherwise the
    // dispatcher believes the customer is being kept informed and they are not.
    if (b.enabled && !po.notifications.contacts.length) {
      return res.status(400).json({ error: 'Add at least one customer email before turning updates on' });
    }
    po.notifications.enabled = !!b.enabled;
  }

  logAction(req.session.user, 'updated-po-notifications', po.id, {
    poNumber: po.poNumber, enabled: po.notifications.enabled,
    contacts: po.notifications.contacts.length,
    events: Object.entries(po.notifications.events).filter(([, v]) => v).map(([k]) => k),
  });
  await saveData();
  res.json({ success: true, notifications: po.notifications });
});

app.get('/api/notifications/log', reqMgr, (req, res) => {
  const f = req.query || {};
  let items = [...(store.notificationLog || [])];
  if (f.poId)   items = items.filter(e => e.poId === f.poId);
  if (f.loadId) items = items.filter(e => e.loadId === f.loadId);
  if (f.status) items = items.filter(e => e.status === f.status);
  items.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  res.json({ items: items.slice(0, Math.min(parseInt(f.limit || '300', 10) || 300, 2000)) });
});

// ── RESILIENCE ───────────────────────────────────────────────────────────────
// Drivers are in the field and the dispatcher may be on a phone. One bad
// request must degrade to a 500 for that caller — never take the whole
// dispatch system offline for everyone.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  // A malformed or oversized request body is the caller's mistake, not ours.
  // Returning 500 for it hides real server faults in the noise.
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    console.warn(`[bad request] ${req.method} ${req.originalUrl}: ${err.message}`);
    return res.status(400).json({ error: 'Malformed JSON in request body' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Upload too large (limit 25MB)' });
  }
  console.error(`[express error] ${req.method} ${req.originalUrl}:`, err && err.stack || err);
  res.status(500).json({ error: 'Server error — please retry. If it persists, check the server log.' });
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] staying alive:', reason && reason.stack || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] staying alive:', err && err.stack || err);
});

// ── STARTUP ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
(async () => {
  await initPg();
  await seedDefaultCompanyAndUsers();
  try {
    await loadData();
    await snapshotBootStore();
  } catch (e) {
    // Fail SAFE, not fail closed: the process stays up so /healthz and the
    // dispatcher's screen show exactly what happened and an admin can restore
    // a backup — but every read of dispatch data and every write is refused
    // (see the lock middleware and saveData) until a load succeeds.
    persistence.loaded = false;
    persistence.loadError = e.message;
    console.error('✗ STORE LOAD FAILED — running LOCKED, nothing will be written:', e.message);
  }
  app.listen(PORT, () => {
    console.log(`VBT Dispatch on port ${PORT}${persistence.loaded ? '' : ' (LOCKED — store not loaded)'}`);
    if (!pg) console.warn('⚠ No Postgres — data will reset on redeploy');
  });
})();
