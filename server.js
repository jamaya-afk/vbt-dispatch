// VBT Dispatch — Clean Build
// Core scope: Login, POs, Board, Driver guided flow, Approvals, Ready to Bill, Sheets sync
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

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

// Generate a strong random folder path so public URLs are unguessable
function randomKey(len = 16) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// Upload a base64 image to Supabase, return its public URL
async function uploadPhoto(kind, dataUrl, loadId) {
  if (!supabaseEnabled) throw new Error('Supabase not configured');
  if (!dataUrl || !dataUrl.startsWith('data:')) throw new Error('Invalid image data');

  // Parse the data URL
  const match = dataUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid data URL format');
  const contentType = match[1];
  const base64 = match[2];
  const buffer = Buffer.from(base64, 'base64');

  // Build a random, unguessable path: tickets/2026/04/LOAD-42-a8f3d2e1.jpg
  const ext = contentType === 'image/png' ? 'png' : 'jpg';
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const folder = (kind === 'signature') ? 'signatures' : 'tickets';
  const path = `${folder}/${yyyy}/${mm}/${loadId || 'unknown'}-${randomKey(16)}.${ext}`;

  const { error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .upload(path, buffer, { contentType, upsert: false });

  if (error) throw error;

  // Public bucket — get the public URL
  const { data: urlData } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(path);
  return urlData.publicUrl;
}

// ── USERS & TRUCKS ───────────────────────────────────────────────────────────
const USERS = {
  manager:  { password: process.env.MANAGER_PASS  || 'vbt2025!',   role: 'manager', truckId: null       },
  beryle:   { password: process.env.BERYLE_PASS   || 'beryle123',  role: 'driver',  truckId: 'beryle'   },
  matthew:  { password: process.env.MATTHEW_PASS  || 'matthew123', role: 'driver',  truckId: 'matthew'  },
  rigo:     { password: process.env.RIGO_PASS     || 'rigo123',    role: 'driver',  truckId: 'rigo'     },
  leonardo: { password: process.env.LEONARDO_PASS || 'leo123',     role: 'driver',  truckId: 'leonardo' },
  carlos:   { password: process.env.CARLOS_PASS   || 'carlos123',  role: 'driver',  truckId: 'carlos'   },
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
  nextPoNum: 1001,
  nextLoadId: 1,
};

async function initPg() {
  if (!process.env.DATABASE_URL) {
    console.warn('⚠ No DATABASE_URL — using file storage (data resets on redeploy!)');
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
    console.log('✓ Postgres connected');
  } catch (e) {
    console.error('✗ Postgres connection failed:', e.message);
    pg = null;
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
  // File fallback
  if (fs.existsSync(DATA_FILE)) {
    try {
      store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      normalizeStore();
      console.log(`✓ Loaded from file: ${store.pos.length} POs`);
      if (pg) { await saveData(); console.log('✓ Migrated file data to Postgres'); }
    } catch (e) { console.warn('File read error:', e.message); }
  }
}

async function saveData() {
  const j = JSON.stringify(store);
  if (pg) {
    try {
      await pg.query(
        "INSERT INTO dispatch_data(key,value) VALUES('store',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
        [j]
      );
    } catch (e) {
      console.error('PG write error:', e.message);
      try { fs.writeFileSync(DATA_FILE, j); } catch (fe) {}
    }
  } else {
    try { fs.writeFileSync(DATA_FILE, j); } catch (e) {}
  }
}

// Ensure all loads have required fields (backward compat for old data)
function normalizeStore() {
  if (!store.pos)     store.pos = [];
  if (!store.loads)   store.loads = [];
  if (!store.archive) store.archive = [];
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
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

// ── AUTH ─────────────────────────────────────────────────────────────────────
function reqAuth(req, res, next) { if (req.session?.user) return next(); res.redirect('/login'); }
function reqMgr(req, res, next)  { if (req.session?.user?.role === 'manager') return next(); res.status(403).json({ error: 'Manager only' }); }

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

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const cleanName = username?.toLowerCase().trim();
  const u = USERS[cleanName];
  if (!u || u.password !== password) {
    console.log(`[LOGIN] FAILED: username="${cleanName}"`);
    return res.redirect('/login?error=1');
  }
  req.session.user = { username: cleanName, role: u.role, truckId: u.truckId };
  console.log(`[LOGIN] SUCCESS: username="${cleanName}", role="${u.role}", truckId="${u.truckId}"`);
  res.redirect('/app/');
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// Static + protected app shell
app.use('/app', reqAuth, express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
app.get(['/app', '/app/'], reqAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/', (req, res) => res.redirect(req.session?.user ? '/app/' : '/login'));

// ── API: WHO AM I ────────────────────────────────────────────────────────────
app.get('/api/me', reqAuth, (req, res) => {
  const u = req.session.user;
  console.log(`[/api/me] username="${u.username}", role="${u.role}", truckId="${u.truckId}"`);
  res.json({ username: u.username, role: u.role, truckId: u.truckId });
});

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
app.get('/api/data', reqAuth, (req, res) => {
  const u = req.session.user;
  // Build "yards" view (just the active vendors with name + location, for the driver yard picker)
  const yards = store.vendors.filter(v => v.active).map(v => ({ id: v.id, name: v.name, location: v.location }));

  if (u.role === 'driver') {
    const myLoads = store.loads.filter(l => l.truckId === u.truckId && !l.voided);
    const myPoIds = new Set(myLoads.map(l => l.poId));
    const myPos = store.pos.filter(p => myPoIds.has(p.id));
    return res.json({ trucks: TRUCKS, materials: MATERIALS, yards, pos: myPos, loads: myLoads });
  }
  // Manager sees full vendor data
  res.json({
    trucks: TRUCKS,
    materials: MATERIALS,
    yards,
    vendors: store.vendors,
    vendorPrices: store.vendorPrices,
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
  const { po, splits } = req.body;
  console.log(`\n[create-PO] Manager creating PO`);
  console.log(`[create-PO] PO data:`, JSON.stringify(po));
  console.log(`[create-PO] Splits received:`, JSON.stringify(splits));
  if (!po?.customer || !po?.deliveryDate) return res.status(400).json({ error: 'Customer and date required' });

  const poNumber = po.poNumber || `PO-${store.nextPoNum++}`;
  const newPo = {
    id: 'PO-' + Date.now(),
    poNumber,
    customer:        po.customer || '',
    job:             po.job || po.customer || '',
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
    const truck = TRUCKS.find(t => t.id === s.truckId);
    console.log(`[create-PO] Creating load: truckId="${s.truckId}", material="${s.material}", loads=${s.loadsAssigned}, driver="${truck?.label || '(unassigned)'}"`);
    const newLoad = {
      id: 'LOAD-' + store.nextLoadId++,
      poId: newPo.id,
      material: s.material,
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
    };
    store.loads.push(newLoad);
  });

  await saveData();
  console.log(`[create-PO] DONE. Total POs: ${store.pos.length}, total loads: ${store.loads.length}`);
  res.json({ success: true, po: newPo });
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
  store.pos.splice(idx, 1);
  store.loads = store.loads.filter(l => l.poId !== req.params.id);
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
    if (req.body.truckId !== undefined) {
      const t = TRUCKS.find(t => t.id === req.body.truckId);
      updated.driverName = t?.label || '';
      updated.status = req.body.truckId ? 'active' : 'unassigned';
    }
    store.loads[idx] = updated;
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
  store.loads.splice(idx, 1);
  await saveData();
  res.json({ success: true });
});

// ── API: DRIVER TRIP ACTIONS ────────────────────────────────────────────────
// action: 'start-trip' | 'arrived-pickup' | 'delivered'
app.post('/api/loads/:id/trip-action', reqAuth, async (req, res) => {
  const u = req.session.user;
  const idx = store.loads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const l = store.loads[idx];
  if (u.role === 'driver' && l.truckId !== u.truckId) return res.status(403).json({ error: 'Not your load' });
  if (l.locked) return res.status(403).json({ error: 'Load is locked' });

  const { action, gps } = req.body;
  const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' });

  if (action === 'start-trip') {
    l.timestamps = { ...l.timestamps, start: time };
    l.gps        = { ...l.gps, start: gps || null };
  } else if (action === 'arrived-pickup') {
    if (!l.timestamps?.start) return res.status(400).json({ error: 'Must start trip first' });
    l.timestamps = { ...l.timestamps, arrivedPickup: time };
    l.gps        = { ...l.gps, arrivedPickup: gps || null };
    // Driver can confirm which yard they actually arrived at
    if (req.body.yardId) {
      const yard = store.vendors.find(y => y.id === req.body.yardId);
      if (yard) {
        l.actualYardId   = yard.id;
        l.actualYardName = yard.name;
      }
    }
  } else if (action === 'delivered') {
    if (!l.timestamps?.start)         return res.status(400).json({ error: 'Must start trip first' });
    if (!l.timestamps?.arrivedPickup) return res.status(400).json({ error: 'Must mark arrived at pickup first' });
    if (!l.ticketImage && !l.ticketImageUrl)               return res.status(400).json({ error: 'Ticket photo required' });
    if (!l.pod?.signedBy || (!l.pod.signature && !l.pod.signatureUrl)) return res.status(400).json({ error: 'Customer signature required' });
    l.timestamps = { ...l.timestamps, completed: time };
    l.gps        = { ...l.gps, completed: gps || null };
    l.loadsDelivered = l.loadsAssigned;
    // Auto-submit for approval
    l.approvalStatus = 'submitted';
    l.submittedAt    = new Date().toISOString();
    l.locked         = true;  // immutable until manager approves/rejects
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
  l.approvedBy     = req.session.user.username;
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
  store.loads.forEach(l => {
    if (ids.includes(l.id) && l.approvalStatus === 'approved' && l.billStatus === 'ready') {
      l.billStatus = 'billed';
      l.billedAt   = new Date().toISOString();
      count++;
    }
  });
  await saveData();
  res.json({ success: true, billed: count });
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
  await saveData();
  res.json({ success: true, vendor: newVendor });
});

// Update a vendor (rename/relocate/toggle active)
app.put('/api/vendors/:id', reqMgr, async (req, res) => {
  const v = store.vendors.find(x => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  if (req.body.name !== undefined)     v.name = String(req.body.name).trim();
  if (req.body.location !== undefined) v.location = String(req.body.location).trim();
  if (req.body.active !== undefined)   v.active = !!req.body.active;
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
  store.vendors.splice(idx, 1);
  delete store.vendorPrices[id];
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
  await saveData();
  res.json({ success: true, price: newPrice });
});

// Update a price row
app.put('/api/vendors/:id/prices/:priceId', reqMgr, async (req, res) => {
  const list = store.vendorPrices[req.params.id];
  if (!list) return res.status(404).json({ error: 'Vendor not found' });
  const p = list.find(x => x.id === req.params.priceId);
  if (!p) return res.status(404).json({ error: 'Price not found' });
  if (req.body.material !== undefined) p.material = String(req.body.material).trim();
  if (req.body.unit !== undefined)     p.unit     = String(req.body.unit).trim();
  if (req.body.price !== undefined)    p.price    = Number(req.body.price) || 0;
  if (req.body.active !== undefined)   p.active   = !!req.body.active;
  if (req.body.notes !== undefined)    p.notes    = String(req.body.notes).trim();
  await saveData();
  res.json({ success: true, price: p });
});

// Delete a price row
app.delete('/api/vendors/:id/prices/:priceId', reqMgr, async (req, res) => {
  const list = store.vendorPrices[req.params.id];
  if (!list) return res.status(404).json({ error: 'Vendor not found' });
  const idx = list.findIndex(x => x.id === req.params.priceId);
  if (idx === -1) return res.status(404).json({ error: 'Price not found' });
  list.splice(idx, 1);
  await saveData();
  res.json({ success: true });
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

// ── API: REPORTS / FINANCE ───────────────────────────────────────────────────
app.get('/api/reports', reqMgr, (req, res) => {
  // Driver performance
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
  await loadData();
  app.listen(PORT, () => {
    console.log(`VBT Dispatch on port ${PORT}`);
    if (!pg) console.warn('⚠ No Postgres — data will reset on redeploy');
  });
})();
