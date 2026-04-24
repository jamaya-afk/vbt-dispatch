const express = require('express');
const { google } = require('googleapis');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Session middleware — mounted at module load (before any route) ───────────
const sessionOpts = {
  secret: process.env.SESSION_SECRET || 'vbt-2025-secret',
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7, httpOnly: true, sameSite: 'lax' }
};
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    const sessionPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    const pgSession = require('connect-pg-simple')(session);
    sessionOpts.store = new pgSession({
      pool: sessionPool,
      tableName: 'user_sessions',
      createTableIfMissing: true,
      pruneSessionInterval: 60 * 15
    });
    console.log('✓ Session store: Postgres');
  } catch (e) {
    console.warn('⚠ Postgres session store failed, using memory:', e.message);
  }
} else {
  console.warn('⚠ Using in-memory session store (no DATABASE_URL)');
}
app.use(session(sessionOpts));

// ── Config ────────────────────────────────────────────────────────────────────
const SHEET_ID  = '1T5pOeXmLmZyKKfq4YRl9aymXn9MQnNrqmcuyJluMhQs';
const DATA_FILE = path.join(__dirname, 'data.json');

const USERS = {
  manager:  { password: process.env.MANAGER_PASS  || 'vbt2025!',   role: 'manager', truckId: null       },
  beryle:   { password: process.env.BERYLE_PASS   || 'beryle123',  role: 'driver',  truckId: 'beryle'   },
  matthew:  { password: process.env.MATTHEW_PASS  || 'matthew123', role: 'driver',  truckId: 'matthew'  },
  rigo:     { password: process.env.RIGO_PASS     || 'rigo123',    role: 'driver',  truckId: 'rigo'     },
  leonardo: { password: process.env.LEONARDO_PASS || 'leo123',     role: 'driver',  truckId: 'leonardo' },
  carlos:   { password: process.env.CARLOS_PASS   || 'carlos123',  role: 'driver',  truckId: 'carlos'   },
};

const DEFAULT_TRUCKS = [
  { id: 'beryle',   label: 'Beryle',   truckNum: 'Truck #2',  baseLocation: 'Fowler, CA',       lat: 36.6327, lng: -119.6793 },
  { id: 'matthew',  label: 'Matthew',  truckNum: 'Truck #4',  baseLocation: 'Fresno, CA',        lat: 36.7378, lng: -119.7871 },
  { id: 'rigo',     label: 'Rigo',     truckNum: 'Truck #14', baseLocation: 'Fresno, CA',        lat: 36.7378, lng: -119.7871 },
  { id: 'leonardo', label: 'Leonardo', truckNum: 'Truck #12', baseLocation: 'Bakersfield, CA',   lat: 35.3733, lng: -119.0187 },
  { id: 'carlos',   label: 'Carlos',   truckNum: 'Truck #2B', baseLocation: 'Merced, CA',        lat: 37.3022, lng: -120.4830 },
];

// Vendor table — real suppliers with per-material pricing
// Match a load to the logged-in driver safely. Older saved data may have truckId as
// "Beryle" instead of "beryle", so compare id, label, driverName, and username.
function normDriver(v) { return String(v || '').trim().toLowerCase().replace(/[^a-z0-9]/g, ''); }
function driverOwnsLoad(user, load) {
  if (!user || user.role !== 'driver' || !load) return false;
  const uTruck = normDriver(user.truckId);
  const uName = normDriver(user.username);
  const trucksList = store?.trucks?.length ? store.trucks : DEFAULT_TRUCKS;
  const truck = trucksList.find(t => normDriver(t.id) === uTruck || normDriver(t.label) === uName)
             || DEFAULT_TRUCKS.find(t => normDriver(t.id) === uTruck || normDriver(t.label) === uName);
  const mine = new Set([uTruck, uName]);
  if (truck) { mine.add(normDriver(truck.id)); mine.add(normDriver(truck.label)); }
  return mine.has(normDriver(load.truckId)) || mine.has(normDriver(load.driverName));
}

const DEFAULT_VENDORS = [
  { id: 'cemex',               name: 'CEMEX',               location: 'Clovis, CA',        active: true },
  { id: 'vulcan-sanger',       name: 'Vulcan Sanger',       location: 'Sanger, CA',        active: true },
  { id: 'keith-farms',         name: 'Keith Farms',         location: 'Fresno, CA',        active: true },
  { id: 'precision-bakersfield', name: 'Precision Bakersfield', location: 'Bakersfield, CA', active: true },
  { id: 'vbt-yard',            name: 'VBT Yard',            location: 'Fresno, CA',        active: true },
];

// Default vendor prices: { vendorId: { material: pricePerUnit } }
const DEFAULT_VENDOR_PRICES = {
  'cemex':               { 'Fill Sand': 12.50, 'Gravel': 18.00, 'Rock': 22.00, '3/4 Rock': 20.00, 'Base Rock': 16.50 },
  'vulcan-sanger':       { 'Gravel': 17.00, 'Rock': 21.50, '3/4 Rock': 19.00, 'Base Rock': 15.50 },
  'keith-farms':         { 'Fill Sand': 11.00, 'Dirt': 7.50 },
  'precision-bakersfield': { 'Cold Mix': 48.00, 'Base Rock': 17.00 },
  'vbt-yard':            { 'Fill Sand': 10.00, 'Dirt': 6.00, 'Recycle Base': 9.00 },
};

// Material units (CY = cubic yard, TN = ton)
const MATERIAL_UNITS = {
  'Fill Sand': 'CY', 'Gravel': 'TN', 'Rock': 'TN', 'Cold Mix': 'TN',
  '3/4 Rock': 'TN', 'Recycle Base': 'CY', 'Dirt': 'CY', 'Base Rock': 'TN', 'Other': 'CY'
};

// Material price table — editable via API
const DEFAULT_MATERIAL_PRICES = {
  'Fill Sand':     120,
  'Gravel':        140,
  'Rock':          160,
  'Cold Mix':      150,
  '3/4 Rock':      155,
  'Recycle Base':  110,
  'Dirt':           80,
  'Base Rock':     130,
  'Other':         100,
};

// ── Store schema ──────────────────────────────────────────────────────────────
// pos[]: {
//   id, poNumber, customer, address, city, deliveryDate, supervisor,
//   pickup, notes, type, recurrenceRule, status, createdAt, completedAt,
//   materials: [{ material, totalLoads, pricePerLoad }],   ← multi-material
//   invoice: { paymentStatus, amountPaid, notes }
// }
// loads[]: {
//   id, poId, material, pricePerLoad, loadsAssigned,
//   truckId, driverName, deliveryDate, status,
//   loadsDelivered, timestamps:{start,arrived,completed},
//   pod:{signedBy,signature,signedAt,notes}, notes, completedAt
// }
// payments[]: { id, poId, amount, method, note, paidAt }
// materialPrices: { [material]: price }

// ── Postgres setup — fully awaited before app starts ─────────────────────────
let pg = null;

async function initPg() {
  if (!process.env.DATABASE_URL) {
    console.log('No DATABASE_URL — using file storage (data will reset on redeploy!)');
    return;
  }
  try {
    const { Pool } = require('pg');
    pg = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
    });
    // Test the connection
    await pg.query('SELECT 1');
    // Create table if not exists (safe, never drops data)
    await pg.query(`
      CREATE TABLE IF NOT EXISTS dispatch_data (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    console.log('✓ Postgres connected and ready');
  } catch(e) {
    console.error('✗ Postgres connection failed:', e.message);
    console.log('  Falling back to file storage — SET DATABASE_URL to persist data across deploys');
    pg = null;
  }
}

let store = {
  trucks: DEFAULT_TRUCKS,
  pos: [], loads: [], payments: [],
  activity: [],          // activity feed events
  materialPrices: { ...DEFAULT_MATERIAL_PRICES },
  vendors: [...DEFAULT_VENDORS],
  vendorPrices: { ...DEFAULT_VENDOR_PRICES },
  auditLog: [],          // immutable audit trail
  nextPoNum: 1001, nextLoadId: 1, nextPayId: 1, nextAuditId: 1
};

async function loadData() {
  // Always try Postgres first if available
  if (pg) {
    try {
      const r = await pg.query("SELECT value FROM dispatch_data WHERE key='store'");
      if (r.rows.length) {
        store = JSON.parse(r.rows[0].value);
        fixStore();
        console.log(`✓ Loaded from Postgres: ${store.pos.length} POs, ${store.loads.length} loads`);
        return;
      } else {
        console.log('Postgres table empty — checking file backup...');
      }
    } catch(e) {
      console.error('Postgres read error:', e.message);
    }
  }

  // File fallback (only used when Postgres is unavailable)
  if (fs.existsSync(DATA_FILE)) {
    try {
      store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      fixStore();
      console.log(`✓ Loaded from file: ${store.pos.length} POs`);
      // If Postgres just came online with empty table, seed it from file
      if (pg && store.pos.length > 0) {
        console.log('Migrating file data to Postgres...');
        await saveData();
        console.log('✓ Migration to Postgres complete');
      }
    } catch(e) {
      console.warn('File read error:', e.message);
    }
  } else {
    console.log('No existing data found — starting fresh');
  }
}

function fixStore() {
  if (!store.payments)       store.payments = [];
  if (!store.activity)       store.activity = [];
  if (!store.materialPrices) store.materialPrices = { ...DEFAULT_MATERIAL_PRICES };
  if (!store.vendors)        store.vendors = [...DEFAULT_VENDORS];
  if (!store.vendorPrices)   store.vendorPrices = { ...DEFAULT_VENDOR_PRICES };
  if (!store.auditLog)       store.auditLog = [];
  if (!store.nextPayId)      store.nextPayId = 1;
  if (!store.nextPoNum)      store.nextPoNum = 1001;
  if (!store.nextLoadId)     store.nextLoadId = 1;
  if (!store.nextAuditId)    store.nextAuditId = 1;
  // Ensure default vendors always exist (add any missing from DEFAULT_VENDORS — never remove)
  DEFAULT_VENDORS.forEach(v => {
    if (!store.vendors.find(x => x.id === v.id)) store.vendors.push(v);
  });
  // Migrate old flat POs (no materials array) to new format
  store.pos.forEach(p => {
    if (!p.materials) {
      p.materials = [{ material: p.material || 'Fill Sand', totalLoads: Number(p.totalLoads) || 0, pricePerLoad: p.invoice?.pricePerLoad || store.materialPrices[p.material] || 100 }];
    }
    if (!p.invoice) p.invoice = { paymentStatus: 'unpaid', amountPaid: 0, notes: '' };
    if (!p.job) p.job = p.customer || '';
    if (!p.budget) p.budget = 0;
  });
  store.loads.forEach(l => {
    if (!l.pod)        l.pod = { signedBy: '', signature: '', signedAt: '', notes: '' };
    if (!l.timestamps) l.timestamps = {};
    if (l.pricePerLoad === undefined) l.pricePerLoad = store.materialPrices[l.material] || 100;
    // Phase 1 additions — default existing loads to safe values
    if (!l.approvalStatus) l.approvalStatus = l.status === 'completed' ? 'approved' : 'pending';
    if (!l.ticketImage)    l.ticketImage = '';     // base64 ticket photo
    if (!l.ticketImageAt)  l.ticketImageAt = '';
    if (!l.vendorId)       l.vendorId = '';
    if (!l.vendorCost)     l.vendorCost = 0;       // what VBT paid vendor
    if (!l.unit)           l.unit = MATERIAL_UNITS[l.material] || 'CY';
    if (!l.submittedAt)    l.submittedAt = '';
    if (!l.submittedBy)    l.submittedBy = '';
    if (!l.approvedAt)     l.approvedAt = '';
    if (!l.approvedBy)     l.approvedBy = '';
    if (!l.billStatus)     l.billStatus = 'not-ready';  // not-ready | ready | billed
    if (!l.billedAt)       l.billedAt = '';
    if (!l.gps)            l.gps = { start: null, arrived: null, completed: null };
    if (!l.locked)         l.locked = false;
    if (!l.voided)         l.voided = false;
  });
}

async function saveData() {
  const j = JSON.stringify(store);
  // Always write to Postgres if available
  if (pg) {
    try {
      await pg.query(
        "INSERT INTO dispatch_data(key,value) VALUES('store',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
        [j]
      );
    } catch(e) {
      console.error('Postgres write error:', e.message);
      // If Postgres fails, still write to file as emergency backup
      try { fs.writeFileSync(DATA_FILE, j); } catch(fe) {}
    }
  } else {
    // File-only mode
    try { fs.writeFileSync(DATA_FILE, j); }
    catch(e) { console.warn('File write error:', e.message); }
  }
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

function pushActivity(type, data) {
  const event = { id: Date.now(), type, ...data, at: new Date().toISOString() };
  store.activity.unshift(event);          // newest first
  if (store.activity.length > 200) store.activity = store.activity.slice(0, 200); // cap at 200
}

// Immutable audit log — never edited, never deleted
function audit(action, entityType, entityId, user, before, after, extra) {
  store.auditLog.push({
    id: store.nextAuditId++,
    action,         // 'create'|'update'|'approve'|'submit'|'void'|'bill'|'correct'
    entityType,     // 'load'|'po'|'payment'|'vendor'
    entityId,
    user: user || 'system',
    at: new Date().toISOString(),
    before: before || null,
    after: after || null,
    ...(extra || {})
  });
}

function promoteScheduled() {
  const t = todayStr();
  store.pos.forEach(p => {
    if (p.status === 'scheduled' && p.deliveryDate <= t) {
      p.status = 'active';
      store.loads.filter(l => l.poId === p.id && l.status === 'scheduled').forEach(l => l.status = 'unassigned');
    }
  });
}

function nextRecurrence(fromDate, rule) {
  const d = new Date(fromDate + 'T12:00:00');
  if (rule === 'weekly')   d.setDate(d.getDate() + 7);
  if (rule === 'biweekly') d.setDate(d.getDate() + 14);
  if (rule === 'monthly')  d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

// PO totals: sum across all loads (includes multi-material)
function poInvoiceTotals(poId) {
  const ls = store.loads.filter(l => l.poId === poId);
  const totalLoads = ls.reduce((s, l) => s + (Number(l.loadsAssigned) || 0), 0);
  const completedLoads = ls.filter(l => l.status === 'completed').reduce((s, l) => s + (Number(l.loadsDelivered) || 0), 0);
  const deliveredLoads = ls.reduce((s, l) => s + (Number(l.loadsDelivered) || 0), 0);
  const totalDue = ls.reduce((s, l) => s + (Number(l.loadsDelivered) || 0) * (Number(l.pricePerLoad) || 0), 0);
  const totalInvoiced = ls.reduce((s, l) => s + (Number(l.loadsAssigned) || 0) * (Number(l.pricePerLoad) || 0), 0);
  const paid = store.payments.filter(p => p.poId === poId).reduce((s, p) => s + p.amount, 0);
  return { totalLoads, completedLoads, deliveredLoads, totalDue, totalInvoiced, paid, balance: totalInvoiced - paid };
}

// Google Sheets
let sa;
if (process.env.SERVICE_ACCOUNT_JSON) { sa = JSON.parse(process.env.SERVICE_ACCOUNT_JSON); }
else { try { sa = require('./service-account.json'); } catch(e) {} }
const auth = new google.auth.GoogleAuth({ credentials: sa, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version: 'v4', auth });

async function ensureTab(name) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  if (!meta.data.sheets.some(s => s.properties.title === name)) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title: name } } }] } });
  }
}
async function getTab(tab) {
  try { const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A:Z` }); return r.data.values || []; }
  catch(e) { return []; }
}
async function appendRows(tab, rows) {
  await sheets.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: `${tab}!A1`, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', requestBody: { values: rows } });
}
async function updateRow(tab, rowIdx, vals) {
  await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `${tab}!A${rowIdx}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [vals] } });
}

// Auth middleware
function reqAuth(req, res, next) { if (req.session?.user) return next(); res.redirect('/login'); }
function reqMgr(req, res, next)  { if (req.session?.user?.role === 'manager') return next(); res.status(403).json({ error: 'Manager only' }); }

// Serve logo publicly (no auth required) so login page can display it
app.get('/logo.png', (req, res) => res.sendFile(path.join(__dirname, 'public', 'logo.png')));

app.use('/app', reqAuth, express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => { if (req.session?.user) return res.redirect('/app'); res.redirect('/login'); });

app.get('/login', (req, res) => {
  const err = req.query.error ? '<p class="err">Invalid username or password</p>' : '';
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Valley Best Concrete — Dispatch</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',system-ui,sans-serif;background:linear-gradient(135deg,#0a0e1a 0%,#1a2342 50%,#0a0e1a 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;color:#fff}
    .card{background:rgba(255,255,255,.04);backdrop-filter:blur(20px);border-radius:18px;border:1px solid rgba(255,255,255,.08);padding:40px 36px;width:100%;max-width:400px;box-shadow:0 8px 40px rgba(0,0,0,.4)}
    .logo-wrap{text-align:center;margin-bottom:24px}
    .logo-wrap img{max-width:220px;width:100%;height:auto}
    .tagline{font-size:11px;color:rgba(255,255,255,.5);text-align:center;margin-top:10px;letter-spacing:.15em;text-transform:uppercase;font-weight:500}
    h2{font-size:18px;font-weight:600;color:#fff;text-align:center;margin-bottom:6px;letter-spacing:-.01em}
    .sub{font-size:13px;color:rgba(255,255,255,.55);margin-bottom:28px;text-align:center}
    label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:rgba(255,255,255,.55);display:block;margin-bottom:6px;font-weight:600}
    input,select{width:100%;padding:11px 14px;border:1px solid rgba(255,255,255,.12);border-radius:10px;font-size:14px;font-family:inherit;margin-bottom:14px;color:#fff;background:rgba(255,255,255,.05);transition:border-color .15s,background .15s}
    input:focus,select:focus{outline:none;border-color:#60a8f0;background:rgba(255,255,255,.08)}
    input::placeholder{color:rgba(255,255,255,.3)}
    select option{background:#111827;color:#fff}
    button{width:100%;padding:12px;background:linear-gradient(135deg,#3b82f6 0%,#2563eb 100%);color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:600;font-family:inherit;cursor:pointer;margin-top:8px;transition:transform .1s,box-shadow .15s;letter-spacing:.01em}
    button:hover{box-shadow:0 8px 24px rgba(59,130,246,.4)}
    button:active{transform:translateY(1px)}
    .err{color:#fca5a5;font-size:12px;margin-bottom:16px;background:rgba(220,38,38,.12);padding:10px 14px;border-radius:8px;border:1px solid rgba(220,38,38,.3);text-align:center}
    .footer{font-size:10px;color:rgba(255,255,255,.3);text-align:center;margin-top:24px;letter-spacing:.05em}
  </style>
  </head><body><div class="card">
    <div class="logo-wrap">
      <img src="/logo.png" alt="Valley Best Concrete">
      <div class="tagline">Dispatch System</div>
    </div>
    ${err}
    <form method="POST" action="/login">
      <label>Username</label>
      <input name="username" placeholder="e.g. beryle" autocomplete="username" autocapitalize="none" autocorrect="off">
      <label>Password</label>
      <input name="password" type="password" placeholder="••••••••" autocomplete="current-password">
      <div class="hint">Drivers log in with their own username. Assigned loads appear automatically based on the driver&apos;s login.</div>
      <button type="submit">Sign in</button>
    </form>
    <div class="footer">Authorized access only</div>
  </div></body></html>`);
});

app.post('/login', (req, res) => {
  const username = (req.body.username || '').toLowerCase().trim();
  const { password } = req.body;
  const user = USERS[username];
  if (!user || user.password !== password) return res.redirect('/login?error=1');


  req.session.user = { username, role: user.role, truckId: user.truckId };
  res.redirect('/app');
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });
app.get('/api/me', reqAuth, (req, res) => {
  const user = req.session.user;
  let username = user.username;
  if (user.role === 'driver') {
    const truck = (store.trucks || DEFAULT_TRUCKS).find(t => t.id === user.truckId) || DEFAULT_TRUCKS.find(t => t.id === user.truckId);
    if (truck?.label) username = truck.label;
  }
  res.json({ username, role: user.role, truckId: user.truckId || null });
});

// ── GET DATA ──────────────────────────────────────────────────────────────────
app.get('/api/data', reqAuth, (req, res) => {
  promoteScheduled();
  const user = req.session.user;
  if (user.role === 'driver') {
    const myLoads = store.loads.filter(l => driverOwnsLoad(user, l) && !l.voided);
    const myPoIds = new Set(myLoads.map(l => l.poId));
    const myPos = store.pos.filter(p => myPoIds.has(p.id)).map(p => ({
      id: p.id, poNumber: p.poNumber, customer: p.customer, city: p.city,
      address: p.address, deliveryDate: p.deliveryDate, pickup: p.pickup,
      supervisor: p.supervisor, notes: p.notes, status: p.status, job: p.job,
      materials: p.materials.map(m => ({ material: m.material, totalLoads: m.totalLoads }))
    }));
    return res.json({ trucks: store.trucks, pos: myPos, loads: myLoads, payments: [], materialPrices: {}, vendors: store.vendors });
  }
  res.json({
    trucks: store.trucks, pos: store.pos, loads: store.loads,
    payments: store.payments, materialPrices: store.materialPrices,
    vendors: store.vendors, vendorPrices: store.vendorPrices
  });
});

// ── MATERIAL PRICES ───────────────────────────────────────────────────────────
app.get('/api/material-prices', reqMgr, (req, res) => res.json(store.materialPrices));
app.put('/api/material-prices', reqMgr, async (req, res) => {
  store.materialPrices = { ...store.materialPrices, ...req.body };
  await saveData();
  res.json({ success: true, materialPrices: store.materialPrices });
});

// ── CREATE PO ─────────────────────────────────────────────────────────────────
// Body: { po: {...}, splits: [{truckId, driverName, material, loadsAssigned, deliveryDate}] }
app.post('/api/pos', reqMgr, async (req, res) => {
  const { po, splits } = req.body;
  if (!po?.customer) return res.status(400).json({ error: 'Customer required' });
  if (!splits?.length) return res.status(400).json({ error: 'At least one load assignment required' });

  const today = todayStr();
  const deliveryDate = po.deliveryDate || today;
  const type = po.type || 'one-time';
  const status = type === 'scheduled' && deliveryDate > today ? 'scheduled' : 'active';
  const poId = po.poNumber || ('PO-' + store.nextPoNum++);

  // Build materials array from splits
  const matMap = {};
  splits.forEach(s => {
    if (!matMap[s.material]) matMap[s.material] = 0;
    matMap[s.material] += Number(s.loadsAssigned) || 0;
  });
  const materials = Object.entries(matMap).map(([material, totalLoads]) => ({
    material, totalLoads, pricePerLoad: po.prices?.[material] || store.materialPrices[material] || 100
  }));

  store.pos.push({
    id: poId, poNumber: poId, customer: po.customer, address: po.address || '', city: po.city || po.address || '',
    deliveryDate, pickup: po.pickup || 'VBT Yard', supervisor: po.supervisor || '',
    notes: po.notes || '', type, recurrenceRule: type === 'recurring' ? po.recurrenceRule : null,
    status, createdAt: new Date().toISOString(), completedAt: null,
    materials,
    invoice: { paymentStatus: 'unpaid', amountPaid: 0, notes: '' }
  });

  splits.forEach(s => {
    const price = po.prices?.[s.material] || store.materialPrices[s.material] || 100;
    const vendorId = s.vendorId || '';
    const vendorCost = vendorId && store.vendorPrices[vendorId]?.[s.material] || 0;
    const newLoad = {
      id: 'LOAD-' + store.nextLoadId++, poId,
      material: s.material, pricePerLoad: price,
      unit: MATERIAL_UNITS[s.material] || 'CY',
      vendorId, vendorCost,
      loadsAssigned: Number(s.loadsAssigned) || 0, loadsDelivered: 0,
      truckId: s.truckId || null, driverName: s.driverName || '',
      deliveryDate: s.deliveryDate || deliveryDate,
      status: s.truckId ? (status === 'scheduled' ? 'scheduled' : 'active') : 'unassigned',
      timestamps: {}, pod: { signedBy: '', signature: '', signedAt: '', notes: '' },
      notes: '', completedAt: null,
      approvalStatus: 'pending', ticketImage: '', ticketImageAt: '',
      submittedAt: '', submittedBy: '', approvedAt: '', approvedBy: '',
      billStatus: 'not-ready', billedAt: '',
      gps: { start: null, arrived: null, completed: null },
      locked: false, voided: false
    };
    store.loads.push(newLoad);
    audit('create', 'load', newLoad.id, req.session.user.username, null, newLoad);
  });

  await saveData();
  res.json({ success: true, pos: store.pos, loads: store.loads });
});

// ── UPDATE PO ─────────────────────────────────────────────────────────────────
app.put('/api/pos/:id', reqMgr, async (req, res) => {
  const idx = store.pos.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'PO not found' });
  const existing = store.pos[idx];
  store.pos[idx] = { ...existing, ...req.body, id: req.params.id, invoice: existing.invoice, createdAt: existing.createdAt };
  if (req.body.invoice) store.pos[idx].invoice = { ...existing.invoice, ...req.body.invoice };
  await saveData();
  res.json({ success: true, po: store.pos[idx] });
});

app.delete('/api/pos/:id', reqMgr, async (req, res) => {
  store.loads    = store.loads.filter(l => l.poId !== req.params.id);
  store.payments = store.payments.filter(p => p.poId !== req.params.id);
  store.pos      = store.pos.filter(p => p.id !== req.params.id);
  await saveData();
  res.json({ success: true });
});

app.post('/api/pos/:id/rollover', reqMgr, async (req, res) => {
  const po = store.pos.find(p => p.id === req.params.id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  const { newDate } = req.body;
  store.loads.filter(l => l.poId === po.id && l.status !== 'completed').forEach(l => l.deliveryDate = newDate);
  po.deliveryDate = newDate;
  await saveData();
  res.json({ success: true });
});

// ── ADD LOAD(S) TO PO ─────────────────────────────────────────────────────────
app.post('/api/pos/:id/loads', reqMgr, async (req, res) => {
  const po = store.pos.find(p => p.id === req.params.id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  const splits = Array.isArray(req.body) ? req.body : [req.body];
  splits.forEach(s => {
    const price = s.pricePerLoad || store.materialPrices[s.material] || 100;
    store.loads.push({
      id: 'LOAD-' + store.nextLoadId++, poId: po.id,
      material: s.material || 'Fill Sand', pricePerLoad: price,
      loadsAssigned: Number(s.loadsAssigned) || 0, loadsDelivered: 0,
      truckId: s.truckId || null, driverName: s.driverName || '',
      deliveryDate: s.deliveryDate || po.deliveryDate,
      status: s.truckId ? 'active' : 'unassigned',
      timestamps: {}, pod: { signedBy: '', signature: '', signedAt: '', notes: '' },
      notes: '', completedAt: null
    });
    // Update PO materials list
    const existing = po.materials.find(m => m.material === s.material);
    if (existing) existing.totalLoads += Number(s.loadsAssigned) || 0;
    else po.materials.push({ material: s.material, totalLoads: Number(s.loadsAssigned) || 0, pricePerLoad: price });
  });
  await saveData();
  res.json({ success: true, loads: store.loads.filter(l => l.poId === po.id) });
});

// ── UPDATE LOAD ───────────────────────────────────────────────────────────────
app.put('/api/loads/:id', reqAuth, async (req, res) => {
  const user = req.session.user;
  const idx = store.loads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Load not found' });
  const l = store.loads[idx];
  if (user.role === 'driver' && !driverOwnsLoad(user, l)) return res.status(403).json({ error: 'Not your load' });

  const po = store.pos.find(p => p.id === l.poId) || {};
  if (user.role === 'driver') {
    const prev = { ...l };
    store.loads[idx] = {
      ...l,
      loadsDelivered: req.body.loadsDelivered !== undefined ? Number(req.body.loadsDelivered) : l.loadsDelivered,
      notes: req.body.notes !== undefined ? req.body.notes : l.notes,
      timestamps: req.body.timestamps ? { ...l.timestamps, ...req.body.timestamps } : l.timestamps,
      pod: req.body.pod ? { ...l.pod, ...req.body.pod } : l.pod
    };
    const updated = store.loads[idx];
    // Log activity events
    if (req.body.loadsDelivered !== undefined && Number(req.body.loadsDelivered) !== Number(prev.loadsDelivered)) {
      pushActivity('loads_logged', { driver: l.driverName || user.username, truckId: l.truckId, poNumber: po.poNumber, customer: po.customer, material: l.material, count: Number(req.body.loadsDelivered), assigned: l.loadsAssigned });
    }
    if (req.body.timestamps) {
      const ts = req.body.timestamps;
      if (ts.start && !prev.timestamps?.start)    pushActivity('ts_start',    { driver: l.driverName || user.username, truckId: l.truckId, poNumber: po.poNumber, customer: po.customer, time: ts.start });
      if (ts.arrived && !prev.timestamps?.arrived) pushActivity('ts_arrived',  { driver: l.driverName || user.username, truckId: l.truckId, poNumber: po.poNumber, customer: po.customer, city: po.city || po.address, time: ts.arrived });
      if (ts.completed && !prev.timestamps?.completed) pushActivity('ts_done', { driver: l.driverName || user.username, truckId: l.truckId, poNumber: po.poNumber, customer: po.customer, time: ts.completed });
    }
    if (req.body.pod?.signedBy && !prev.pod?.signedBy) {
      pushActivity('pod_signed', { driver: l.driverName || user.username, truckId: l.truckId, poNumber: po.poNumber, customer: po.customer, signedBy: req.body.pod.signedBy });
    }
    if (req.body.notes && req.body.notes !== prev.notes) {
      pushActivity('note_added', { driver: l.driverName || user.username, truckId: l.truckId, poNumber: po.poNumber, customer: po.customer, note: req.body.notes });
    }
  } else {
    const updated = { ...l, ...req.body, id: l.id, poId: l.poId };
    if (req.body.truckId !== undefined) {
      updated.status = req.body.truckId ? 'active' : 'unassigned';
      updated.driverName = req.body.truckId ? (req.body.driverName || store.trucks.find(t => t.id === req.body.truckId)?.label || '') : '';
      if (req.body.truckId && req.body.truckId !== l.truckId) {
        pushActivity('reassigned', { by: user.username, poNumber: po.poNumber, customer: po.customer, material: l.material, driver: updated.driverName });
      }
    }
    store.loads[idx] = updated;
  }
  await saveData();
  res.json({ success: true, load: store.loads[idx] });
});

// ── COMPLETE LOAD ─────────────────────────────────────────────────────────────
app.post('/api/loads/:id/complete', reqAuth, async (req, res) => {
  const user = req.session.user;
  const idx = store.loads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Load not found' });
  const l = store.loads[idx];
  if (user.role === 'driver' && !driverOwnsLoad(user, l)) return res.status(403).json({ error: 'Not your load' });

  store.loads[idx].status = 'completed';
  store.loads[idx].completedAt = new Date().toISOString();
  if (req.body.pod) store.loads[idx].pod = { ...l.pod, ...req.body.pod };
  const cPo = store.pos.find(p => p.id === l.poId) || {};
  pushActivity('load_completed', { driver: l.driverName || user.username, truckId: l.truckId, poNumber: cPo.poNumber, customer: cPo.customer, material: l.material, delivered: l.loadsDelivered, assigned: l.loadsAssigned });

  // Check if entire PO is done
  const poId = l.poId;
  const allDone = store.loads.filter(x => x.poId === poId).every(x => x.status === 'completed');
  if (allDone) {
    const poIdx = store.pos.findIndex(p => p.id === poId);
    if (poIdx !== -1) {
      store.pos[poIdx].status = 'completed';
      store.pos[poIdx].completedAt = new Date().toISOString();
      // Recurring: spawn next
      const po = store.pos[poIdx];
      if (po.type === 'recurring' && po.recurrenceRule) {
        const nextDate = nextRecurrence(po.deliveryDate, po.recurrenceRule);
        const today2 = todayStr();
        const nextPoId = 'PO-' + store.nextPoNum++;
        store.pos.push({ ...po, id: nextPoId, poNumber: nextPoId, deliveryDate: nextDate, status: nextDate > today2 ? 'scheduled' : 'active', completedAt: null, createdAt: new Date().toISOString(), invoice: { paymentStatus: 'unpaid', amountPaid: 0, notes: '' } });
        store.loads.filter(x => x.poId === poId).forEach(x => {
          store.loads.push({ ...x, id: 'LOAD-' + store.nextLoadId++, poId: nextPoId, loadsDelivered: 0, status: nextDate > today2 ? 'scheduled' : (x.truckId ? 'active' : 'unassigned'), deliveryDate: nextDate, timestamps: {}, pod: { signedBy: '', signature: '', signedAt: '', notes: '' }, completedAt: null });
        });
      }
    }
  }

  await saveData();
  res.json({ success: true, pos: store.pos, loads: store.loads });
});

app.delete('/api/loads/:id', reqMgr, async (req, res) => {
  store.loads = store.loads.filter(l => l.id !== req.params.id);
  await saveData();
  res.json({ success: true });
});

// ── PAYMENTS ──────────────────────────────────────────────────────────────────
app.post('/api/payments', reqMgr, async (req, res) => {
  const { poId, amount, method, note } = req.body;
  const po = store.pos.find(p => p.id === poId);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  const payment = { id: 'PAY-' + store.nextPayId++, poId, amount: Number(amount), method: method || '', note: note || '', paidAt: new Date().toISOString() };
  store.payments.push(payment);
  const totalPaid = store.payments.filter(p => p.poId === poId).reduce((s, p) => s + p.amount, 0);
  const { totalInvoiced } = poInvoiceTotals(poId);
  po.invoice.amountPaid = totalPaid;
  po.invoice.paymentStatus = totalPaid <= 0 ? 'unpaid' : totalPaid >= totalInvoiced ? 'paid' : 'partial';
  await saveData();
  res.json({ success: true, payment, po });
});

app.put('/api/pos/:id/invoice', reqMgr, async (req, res) => {
  const po = store.pos.find(p => p.id === req.params.id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  po.invoice = { ...po.invoice, ...req.body };
  await saveData();
  res.json({ success: true, po });
});

// ── TRUCKS ────────────────────────────────────────────────────────────────────
app.post('/api/trucks', reqMgr, async (req, res) => {
  store.trucks = req.body;
  await saveData();
  res.json({ success: true });
});

// ── GOOGLE SHEETS SYNC (append-only) ─────────────────────────────────────────
app.post('/api/sync', reqMgr, async (req, res) => {
  try {
    const tabs = ['POs', 'Loads', 'Payments', 'Signatures', 'Dashboard'];
    for (const t of tabs) await ensureTab(t);
    const ts = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });

    // ── POs ──────────────────────────────────────────────────────────────────
    const poHeaders = ['PO Number','Customer','Address','Delivery Date','Pickup','Supervisor','Type','Status','Materials Summary','Total Loads Ordered','Total Delivered','Total Invoiced','Amount Paid','Balance','Payment Status','Notes','Created At','Completed At','Last Synced'];
    const existingPos = await getTab('POs');
    if (!existingPos.length) await appendRows('POs', [poHeaders]);
    const existingPoNums = new Set((existingPos.slice(1) || []).map(r => r[0]));
    const newPoRows = [];
    for (const po of store.pos) {
      const t = poInvoiceTotals(po.id);
      const matSummary = po.materials.map(m => `${m.totalLoads} ${m.material} @$${m.pricePerLoad}`).join(' | ');
      if (!existingPoNums.has(po.poNumber)) {
        newPoRows.push([po.poNumber, po.customer, po.city || po.address, po.deliveryDate, po.pickup, po.supervisor, po.type, po.status, matSummary, t.totalLoads, t.deliveredLoads, t.totalInvoiced, t.paid, t.balance, po.invoice.paymentStatus, po.notes, po.createdAt, po.completedAt || '', ts]);
      }
    }
    if (newPoRows.length) await appendRows('POs', newPoRows);
    // Update existing PO rows (status, delivered, payment)
    const refreshedPos = await getTab('POs');
    for (let i = 1; i < refreshedPos.length; i++) {
      const po = store.pos.find(p => p.poNumber === refreshedPos[i][0]);
      if (po) {
        const t = poInvoiceTotals(po.id);
        refreshedPos[i][7]  = po.status;
        refreshedPos[i][10] = t.deliveredLoads;
        refreshedPos[i][11] = t.totalInvoiced;
        refreshedPos[i][12] = t.paid;
        refreshedPos[i][13] = t.balance;
        refreshedPos[i][14] = po.invoice.paymentStatus;
        refreshedPos[i][17] = po.completedAt || '';
        refreshedPos[i][18] = ts;
        await updateRow('POs', i + 1, refreshedPos[i]);
      }
    }

    // ── Loads ────────────────────────────────────────────────────────────────
    const loadHeaders = ['Load ID','PO Number','Customer','Material','Price/Load','Driver','Truck #','Delivery Date','Loads Assigned','Loads Delivered','Missing','Status','Start Time','Arrived Time','Completed Time','Signed By','Signed At','POD Notes','Load Notes','Completed At','Last Synced'];
    const existingLoads = await getTab('Loads');
    if (!existingLoads.length) await appendRows('Loads', [loadHeaders]);
    const existingLoadIds = new Set((existingLoads.slice(1) || []).map(r => r[0]));
    const newLoadRows = [];
    for (const l of store.loads) {
      if (existingLoadIds.has(l.id)) continue;
      const po = store.pos.find(p => p.id === l.poId);
      const tk = store.trucks.find(t => t.id === l.truckId);
      const ts2 = l.timestamps || {};
      const pod = l.pod || {};
      const miss = Math.max(0, (Number(l.loadsAssigned) || 0) - (Number(l.loadsDelivered) || 0));
      newLoadRows.push([l.id, po?.poNumber || l.poId, po?.customer || '', l.material, l.pricePerLoad || 0, l.driverName || '', tk?.truckNum || '', l.deliveryDate, l.loadsAssigned, l.loadsDelivered, miss, l.status, ts2.start || '', ts2.arrived || '', ts2.completed || '', pod.signedBy || '', pod.signedAt || '', pod.notes || '', l.notes || '', l.completedAt || '', ts]);
    }
    if (newLoadRows.length) await appendRows('Loads', newLoadRows);
    // Update completed loads
    const refreshedLoads = await getTab('Loads');
    for (let i = 1; i < refreshedLoads.length; i++) {
      const l = store.loads.find(x => x.id === refreshedLoads[i][0]);
      if (l && l.status === 'completed') {
        const ts2 = l.timestamps || {};
        const pod = l.pod || {};
        refreshedLoads[i][9]  = l.loadsDelivered;
        refreshedLoads[i][10] = Math.max(0, (Number(l.loadsAssigned) || 0) - (Number(l.loadsDelivered) || 0));
        refreshedLoads[i][11] = l.status;
        refreshedLoads[i][12] = ts2.start || '';
        refreshedLoads[i][13] = ts2.arrived || '';
        refreshedLoads[i][14] = ts2.completed || '';
        refreshedLoads[i][15] = pod.signedBy || '';
        refreshedLoads[i][16] = pod.signedAt || '';
        refreshedLoads[i][19] = l.completedAt || '';
        refreshedLoads[i][20] = ts;
        await updateRow('Loads', i + 1, refreshedLoads[i]);
      }
    }

    // ── Payments ──────────────────────────────────────────────────────────────
    const payHeaders = ['Payment ID','PO Number','Customer','Amount','Method','Note','Paid At'];
    const existingPay = await getTab('Payments');
    if (!existingPay.length) await appendRows('Payments', [payHeaders]);
    const existingPayIds = new Set((existingPay.slice(1) || []).map(r => r[0]));
    const newPayRows = [];
    for (const p of store.payments) {
      if (existingPayIds.has(p.id)) continue;
      const po = store.pos.find(x => x.id === p.poId);
      newPayRows.push([p.id, po?.poNumber || p.poId, po?.customer || '', p.amount, p.method, p.note, p.paidAt]);
    }
    if (newPayRows.length) await appendRows('Payments', newPayRows);

    // ── Signatures ────────────────────────────────────────────────────────────
    const sigHeaders = ['Load ID','PO Number','Customer','Material','Driver','Signed By','Signed At','POD Notes'];
    const existingSigs = await getTab('Signatures');
    if (!existingSigs.length) await appendRows('Signatures', [sigHeaders]);
    const existingSigIds = new Set((existingSigs.slice(1) || []).map(r => r[0]));
    const newSigRows = [];
    for (const l of store.loads) {
      const pod = l.pod || {};
      if (pod.signedBy && pod.signedAt && !existingSigIds.has(l.id)) {
        const po = store.pos.find(p => p.id === l.poId);
        newSigRows.push([l.id, po?.poNumber || l.poId, po?.customer || '', l.material, l.driverName, pod.signedBy, pod.signedAt, pod.notes || '']);
      }
    }
    if (newSigRows.length) await appendRows('Signatures', newSigRows);

    // ── Dashboard ─────────────────────────────────────────────────────────────
    await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: 'Dashboard!A:Z' });
    const activePOs    = store.pos.filter(p => p.status === 'active');
    const completedPOs = store.pos.filter(p => p.status === 'completed');
    const tRev  = store.pos.reduce((s, p) => s + poInvoiceTotals(p.id).totalInvoiced, 0);
    const tPaid = store.payments.reduce((s, p) => s + p.amount, 0);
    const tDel  = store.loads.reduce((s, l) => s + (Number(l.loadsDelivered) || 0), 0);
    const tOrd  = store.loads.reduce((s, l) => s + (Number(l.loadsAssigned) || 0), 0);

    // Material breakdown
    const matMap = {};
    store.loads.forEach(l => {
      if (!matMap[l.material]) matMap[l.material] = { ordered: 0, delivered: 0, revenue: 0 };
      matMap[l.material].ordered   += Number(l.loadsAssigned) || 0;
      matMap[l.material].delivered += Number(l.loadsDelivered) || 0;
      matMap[l.material].revenue   += (Number(l.loadsDelivered) || 0) * (Number(l.pricePerLoad) || 0);
    });

    // Customer breakdown
    const custMap = {};
    store.pos.forEach(p => {
      if (!custMap[p.customer]) custMap[p.customer] = { pos: 0, loads: 0, revenue: 0 };
      custMap[p.customer].pos++;
      custMap[p.customer].loads   += poInvoiceTotals(p.id).deliveredLoads;
      custMap[p.customer].revenue += poInvoiceTotals(p.id).totalDue;
    });

    const dash = [
      ['VBT DISPATCH — BUSINESS DASHBOARD', '', `Last updated: ${ts}`],
      [],
      ['OVERVIEW'],
      ['Total POs', store.pos.length],
      ['Active POs', activePOs.length],
      ['Completed POs', completedPOs.length],
      ['Scheduled POs', store.pos.filter(p => p.status === 'scheduled').length],
      [],
      ['LOADS'],
      ['Total Loads Ordered', tOrd],
      ['Total Loads Delivered', tDel],
      ['Missing Loads', tOrd - tDel],
      ['Delivery Rate %', tOrd > 0 ? `${Math.round(tDel / tOrd * 100)}%` : '0%'],
      [],
      ['REVENUE'],
      ['Total Invoiced', `$${tRev.toFixed(2)}`],
      ['Total Collected', `$${tPaid.toFixed(2)}`],
      ['Outstanding', `$${(tRev - tPaid).toFixed(2)}`],
      ['Collection Rate %', tRev > 0 ? `${Math.round(tPaid / tRev * 100)}%` : '0%'],
      [],
      ['PAYMENT STATUS'],
      ['Unpaid POs',  store.pos.filter(p => p.invoice?.paymentStatus === 'unpaid').length],
      ['Partial POs', store.pos.filter(p => p.invoice?.paymentStatus === 'partial').length],
      ['Paid POs',    store.pos.filter(p => p.invoice?.paymentStatus === 'paid').length],
      [],
      ['MATERIAL BREAKDOWN'],
      ['Material', 'Loads Ordered', 'Loads Delivered', 'Revenue'],
      ...Object.entries(matMap).map(([m, d]) => [m, d.ordered, d.delivered, `$${d.revenue.toFixed(2)}`]),
      [],
      ['TOP CUSTOMERS'],
      ['Customer', 'POs', 'Loads Delivered', 'Revenue'],
      ...Object.entries(custMap).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 10).map(([c, d]) => [c, d.pos, d.loads, `$${d.revenue.toFixed(2)}`]),
    ];
    await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: 'Dashboard!A1', valueInputOption: 'USER_ENTERED', requestBody: { values: dash } });

    res.json({ success: true, message: `${newPoRows.length} new POs, ${newLoadRows.length} new loads, ${newPayRows.length} payments, ${newSigRows.length} signatures` });
  } catch(err) {
    console.error('Sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DRIVER LOCATIONS (live GPS from mobile, fallback to base) ────────────────
app.post('/api/driver-location', reqAuth, async (req, res) => {
  const user = req.session.user;
  if (user.role !== 'driver') return res.status(403).json({ error: 'Drivers only' });
  const { lat, lng, accuracy } = req.body;
  if (!lat || !lng) return res.status(400).json({ error: 'lat/lng required' });
  const truck = store.trucks.find(t => t.id === user.truckId);
  if (truck) {
    truck.currentLat = lat;
    truck.currentLng = lng;
    truck.locationAccuracy = accuracy;
    truck.locationUpdatedAt = new Date().toISOString();
    await saveData();
  }
  res.json({ success: true });
});

// ── DISTANCE MATRIX (server-side using Google Maps) ───────────────────────────
// Uses straight-line (Haversine) math — no Maps API key needed, accurate enough for dispatch
app.post('/api/distances', reqMgr, (req, res) => {
  const { destination, trucks: truckIds } = req.body;
  if (!destination) return res.status(400).json({ error: 'destination required' });

  // Geocode the destination using a simple lookup for common CA cities,
  // or use lat/lng if provided directly
  let destLat = req.body.destLat;
  let destLng = req.body.destLng;

  // Common city geocode table for Central Valley / CA
  const CITY_COORDS = {
    'fresno':       [36.7378, -119.7871],
    'bakersfield':  [35.3733, -119.0187],
    'merced':       [37.3022, -120.4830],
    'modesto':      [37.6391, -120.9969],
    'visalia':      [36.3302, -119.2921],
    'hanford':      [36.3274, -119.6457],
    'lemoore':      [36.3002, -119.7829],
    'clovis':       [36.8252, -119.7029],
    'madera':       [36.9613, -120.0607],
    'fowler':       [36.6327, -119.6793],
    'sanger':       [36.7077, -119.5551],
    'reedley':      [36.5960, -119.4502],
    'selma':        [36.5710, -119.6121],
    'kingsburg':    [36.5138, -119.5534],
    'tulare':       [36.2077, -119.3473],
    'porterville':  [36.0654, -119.0168],
    'delano':       [35.7688, -119.2470],
    'wasco':        [35.5938, -119.3412],
    'santa maria':  [34.9530, -120.4357],
    'los angeles':  [34.0522, -118.2437],
    'san francisco':[37.7749, -122.4194],
    'stockton':     [37.9577, -121.2908],
    'chico':        [39.7285, -121.8375],
    'sacramento':   [38.5816, -121.4944],
  };

  if (!destLat || !destLng) {
    // Try to match city name from destination string
    const lower = destination.toLowerCase();
    for (const [city, coords] of Object.entries(CITY_COORDS)) {
      if (lower.includes(city)) { destLat = coords[0]; destLng = coords[1]; break; }
    }
  }

  const targetTrucks = truckIds
    ? store.trucks.filter(t => truckIds.includes(t.id))
    : store.trucks;

  const results = targetTrucks.map(t => {
    // Use live GPS if available and recent (< 2 hours old)
    let fromLat = t.baseLocation ? t.lat : null;
    let fromLng = t.baseLocation ? t.lng : null;
    let locationSource = 'base';
    if (t.currentLat && t.locationUpdatedAt) {
      const age = (Date.now() - new Date(t.locationUpdatedAt).getTime()) / 60000; // minutes
      if (age < 120) { fromLat = t.currentLat; fromLng = t.currentLng; locationSource = 'live'; }
    }

    let distanceMiles = null;
    let estMinutes = null;
    if (fromLat && fromLng && destLat && destLng) {
      // Haversine formula
      const R = 3958.8; // Earth radius in miles
      const dLat = (destLat - fromLat) * Math.PI / 180;
      const dLng = (destLng - fromLng) * Math.PI / 180;
      const a = Math.sin(dLat/2)**2 + Math.cos(fromLat*Math.PI/180)*Math.cos(destLat*Math.PI/180)*Math.sin(dLng/2)**2;
      distanceMiles = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      // Estimate drive time: avg 55 mph for highways + 10 min buffer
      estMinutes = Math.round(distanceMiles / 55 * 60) + 10;
    }

    const activeLoads = store.loads.filter(l => l.truckId === t.id && l.status === 'active').length;

    return {
      truckId: t.id,
      label: t.label,
      truckNum: t.truckNum,
      baseLocation: t.baseLocation || 'Unknown',
      currentLocation: locationSource === 'live' ? 'Live GPS' : (t.baseLocation || 'Unknown'),
      locationSource,
      locationUpdatedAt: t.locationUpdatedAt || null,
      distanceMiles: distanceMiles !== null ? Math.round(distanceMiles * 10) / 10 : null,
      estMinutes,
      activeLoads,
      canCalculate: !!(fromLat && fromLng && destLat && destLng),
    };
  });

  // Sort: drivers with calculable distance first, then by distance
  results.sort((a, b) => {
    if (a.distanceMiles === null && b.distanceMiles === null) return a.activeLoads - b.activeLoads;
    if (a.distanceMiles === null) return 1;
    if (b.distanceMiles === null) return -1;
    return a.distanceMiles - b.distanceMiles;
  });

  res.json({ success: true, results, destFound: !!(destLat && destLng), destination });
});

const PORT = process.env.PORT || 3000;

// ── VENDORS ───────────────────────────────────────────────────────────────────
app.get('/api/vendors', reqAuth, (req, res) => {
  res.json({ vendors: store.vendors, vendorPrices: store.vendorPrices, materialUnits: MATERIAL_UNITS });
});

app.post('/api/vendors', reqMgr, async (req, res) => {
  const v = req.body;
  if (!v.name) return res.status(400).json({ error: 'Vendor name required' });
  const id = v.id || v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (store.vendors.find(x => x.id === id)) return res.status(400).json({ error: 'Vendor already exists' });
  const vendor = { id, name: v.name, location: v.location || '', active: true };
  store.vendors.push(vendor);
  if (v.prices) store.vendorPrices[id] = v.prices;
  audit('create', 'vendor', id, req.session.user.username, null, vendor);
  await saveData();
  res.json({ success: true, vendor });
});

app.put('/api/vendors/:id', reqMgr, async (req, res) => {
  const idx = store.vendors.findIndex(v => v.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Vendor not found' });
  const before = { ...store.vendors[idx] };
  store.vendors[idx] = { ...store.vendors[idx], ...req.body, id: req.params.id };
  audit('update', 'vendor', req.params.id, req.session.user.username, before, store.vendors[idx]);
  await saveData();
  res.json({ success: true, vendor: store.vendors[idx] });
});

app.put('/api/vendor-prices/:vendorId', reqMgr, async (req, res) => {
  const vid = req.params.vendorId;
  if (!store.vendors.find(v => v.id === vid)) return res.status(404).json({ error: 'Vendor not found' });
  const before = { ...(store.vendorPrices[vid] || {}) };
  store.vendorPrices[vid] = { ...(store.vendorPrices[vid] || {}), ...req.body };
  audit('update', 'vendor-prices', vid, req.session.user.username, before, store.vendorPrices[vid]);
  await saveData();
  res.json({ success: true, prices: store.vendorPrices[vid] });
});

// ── DRIVER DISPATCH CARD — guided view ────────────────────────────────────────
// Returns all info a driver needs with ZERO manual entry
app.get('/api/my-dispatch', reqAuth, (req, res) => {
  const user = req.session.user;
  if (user.role !== 'driver') return res.status(403).json({ error: 'Driver only' });
  const myLoads = store.loads.filter(l => driverOwnsLoad(user, l) && !l.voided && l.status !== 'completed');
  // Enrich each load with guide info — driver doesn't need to know anything beyond this
  const enriched = myLoads.map(l => {
    const po = store.pos.find(p => p.id === l.poId) || {};
    const vendor = store.vendors.find(v => v.id === l.vendorId) || null;
    return {
      loadId: l.id,
      poNumber: po.poNumber,
      jobName: po.job || po.customer,
      customer: po.customer,
      pickupLocation: vendor ? `${vendor.name} — ${vendor.location}` : (po.pickup || 'VBT Yard'),
      deliveryLocation: po.address || po.city || '',
      city: po.city || '',
      material: l.material,
      unit: l.unit || MATERIAL_UNITS[l.material] || 'CY',
      vendor: vendor ? vendor.name : null,
      vendorId: l.vendorId || '',
      loadsAssigned: l.loadsAssigned,
      loadsDelivered: l.loadsDelivered,
      supervisor: po.supervisor || '',
      notes: po.notes || l.notes || '',
      deliveryDate: l.deliveryDate,
      timestamps: l.timestamps || {},
      pod: l.pod || {},
      ticketImage: l.ticketImage || '',
      ticketImageAt: l.ticketImageAt || '',
      approvalStatus: l.approvalStatus,
      gps: l.gps || {},
    };
  });
  res.json({ loads: enriched });
});

// ── DRIVER TRIP ACTIONS — guided step-by-step ────────────────────────────────
// POST /api/loads/:id/trip-action  body: { action, gps: {lat,lng} }
// action: 'start-trip' | 'arrived-pickup' | 'delivered'
app.post('/api/loads/:id/trip-action', reqAuth, async (req, res) => {
  const user = req.session.user;
  const idx = store.loads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Load not found' });
  const l = store.loads[idx];
  if (user.role === 'driver' && !driverOwnsLoad(user, l)) return res.status(403).json({ error: 'Not your load' });
  if (l.locked || l.voided) return res.status(403).json({ error: 'This load is locked and cannot be changed' });

  const { action, gps } = req.body;
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const po = store.pos.find(p => p.id === l.poId) || {};
  const before = { ...l };

  if (action === 'start-trip') {
    if (l.timestamps?.start) return res.status(400).json({ error: 'Trip already started' });
    l.timestamps = { ...l.timestamps, start: timeStr };
    l.gps = { ...l.gps, start: gps || null };
    pushActivity('ts_start', { driver: l.driverName || user.username, truckId: l.truckId, poNumber: po.poNumber, customer: po.customer, time: timeStr });
  } else if (action === 'arrived-pickup') {
    if (!l.timestamps?.start) return res.status(400).json({ error: 'Must start trip first' });
    l.timestamps = { ...l.timestamps, arrivedPickup: timeStr };
    l.gps = { ...l.gps, arrivedPickup: gps || null };
    // Driver confirms which vendor/yard they arrived at
    if (req.body.vendorId) {
      l.vendorId = req.body.vendorId;
      // Auto-update vendor cost based on their price table
      const vPrice = store.vendorPrices?.[req.body.vendorId]?.[l.material];
      if (vPrice) l.vendorCost = vPrice;
    }
    const vendor = l.vendorId ? (store.vendors.find(v => v.id === l.vendorId) || {}) : null;
    pushActivity('ts_arrived_pickup', {
      driver: l.driverName || user.username, truckId: l.truckId,
      poNumber: po.poNumber, pickup: vendor?.name || po.pickup, time: timeStr
    });
  } else if (action === 'delivered') {
    if (!l.timestamps?.start) return res.status(400).json({ error: 'Must start trip first' });
    if (!l.ticketImage) return res.status(400).json({ error: 'Ticket image required before delivery' });
    if (!l.pod?.signature) return res.status(400).json({ error: 'Customer signature required before delivery' });
    l.timestamps = { ...l.timestamps, completed: timeStr, arrived: l.timestamps?.arrived || timeStr };
    l.gps = { ...l.gps, completed: gps || null };
    l.loadsDelivered = l.loadsAssigned;  // Assume full delivery on "Delivered" button
    l.approvalStatus = 'submitted';
    l.submittedAt = now.toISOString();
    l.submittedBy = user.username;
    pushActivity('load_submitted', { driver: l.driverName || user.username, truckId: l.truckId, poNumber: po.poNumber, customer: po.customer, material: l.material, loads: l.loadsDelivered });
  } else {
    return res.status(400).json({ error: 'Unknown action' });
  }

  audit(action, 'load', l.id, user.username, before, { ...l });
  await saveData();
  res.json({ success: true, load: l });
});

// ── UPLOAD TICKET IMAGE ──────────────────────────────────────────────────────
app.post('/api/loads/:id/ticket-image', reqAuth, async (req, res) => {
  const user = req.session.user;
  const idx = store.loads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Load not found' });
  const l = store.loads[idx];
  if (user.role === 'driver' && !driverOwnsLoad(user, l)) return res.status(403).json({ error: 'Not your load' });
  if (l.locked || l.voided) return res.status(403).json({ error: 'Load is locked' });
  if (!req.body.image) return res.status(400).json({ error: 'Image data required' });
  const before = { ticketImage: l.ticketImage, ticketImageAt: l.ticketImageAt };
  l.ticketImage = req.body.image;  // base64 data URL
  l.ticketImageAt = new Date().toISOString();
  audit('upload-ticket', 'load', l.id, user.username, before, { ticketImageAt: l.ticketImageAt });
  await saveData();
  res.json({ success: true });
});

// ── APPROVAL WORKFLOW (manager only) ──────────────────────────────────────────
app.post('/api/loads/:id/approve', reqMgr, async (req, res) => {
  const idx = store.loads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Load not found' });
  const l = store.loads[idx];
  if (l.voided) return res.status(400).json({ error: 'Voided load cannot be approved' });
  if (l.approvalStatus === 'approved') return res.status(400).json({ error: 'Already approved' });
  if (!l.ticketImage) return res.status(400).json({ error: 'Ticket image required before approval' });
  if (!l.pod?.signature) return res.status(400).json({ error: 'Signature required before approval' });
  const before = { ...l };
  l.approvalStatus = 'approved';
  l.approvedAt = new Date().toISOString();
  l.approvedBy = req.session.user.username;
  l.status = 'completed';
  if (!l.completedAt) l.completedAt = l.approvedAt;
  l.billStatus = 'ready';
  l.locked = true;       // Approved loads are immutable
  audit('approve', 'load', l.id, req.session.user.username, before, { ...l });
  const po = store.pos.find(p => p.id === l.poId) || {};
  pushActivity('load_approved', { by: req.session.user.username, driver: l.driverName, poNumber: po.poNumber, customer: po.customer, material: l.material });
  await saveData();
  res.json({ success: true, load: l });
});

app.post('/api/loads/:id/reject', reqMgr, async (req, res) => {
  const idx = store.loads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Load not found' });
  const l = store.loads[idx];
  const before = { ...l };
  l.approvalStatus = 'rejected';
  l.rejectReason = req.body.reason || '';
  l.rejectedAt = new Date().toISOString();
  l.rejectedBy = req.session.user.username;
  audit('reject', 'load', l.id, req.session.user.username, before, { ...l });
  await saveData();
  res.json({ success: true, load: l });
});

// Void (soft delete) — preserves record
app.post('/api/loads/:id/void', reqMgr, async (req, res) => {
  const idx = store.loads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Load not found' });
  const l = store.loads[idx];
  const before = { ...l };
  l.voided = true;
  l.voidedAt = new Date().toISOString();
  l.voidedBy = req.session.user.username;
  l.voidReason = req.body.reason || '';
  audit('void', 'load', l.id, req.session.user.username, before, { ...l });
  await saveData();
  res.json({ success: true });
});

// Mark ready-to-bill loads as billed
app.post('/api/loads/bill', reqMgr, async (req, res) => {
  const { loadIds } = req.body;
  if (!Array.isArray(loadIds)) return res.status(400).json({ error: 'loadIds required' });
  const billed = [];
  for (const id of loadIds) {
    const l = store.loads.find(x => x.id === id);
    if (!l || l.voided) continue;
    if (l.billStatus === 'billed') continue;  // No duplicates
    if (l.approvalStatus !== 'approved') continue;  // Must be approved
    const before = { ...l };
    l.billStatus = 'billed';
    l.billedAt = new Date().toISOString();
    l.billedBy = req.session.user.username;
    audit('bill', 'load', l.id, req.session.user.username, before, { ...l });
    billed.push(l.id);
  }
  await saveData();
  res.json({ success: true, billedCount: billed.length, billedIds: billed });
});

// ── READY TO BILL view ────────────────────────────────────────────────────────
app.get('/api/ready-to-bill', reqMgr, (req, res) => {
  const { month, city, job, vendor, material, customer } = req.query;
  let rtb = store.loads.filter(l =>
    l.approvalStatus === 'approved' &&
    l.billStatus === 'ready' &&
    !l.voided
  );

  if (month) rtb = rtb.filter(l => (l.completedAt || l.deliveryDate || '').startsWith(month));
  if (vendor) rtb = rtb.filter(l => l.vendorId === vendor);
  if (material) rtb = rtb.filter(l => l.material === material);

  // Need PO info for city/job/customer filters
  rtb = rtb.map(l => {
    const po = store.pos.find(p => p.id === l.poId) || {};
    return { ...l, po };
  });
  if (city)     rtb = rtb.filter(l => (l.po.city || '').toLowerCase().includes(city.toLowerCase()));
  if (job)      rtb = rtb.filter(l => (l.po.job || l.po.customer || '').toLowerCase().includes(job.toLowerCase()));
  if (customer) rtb = rtb.filter(l => (l.po.customer || '').toLowerCase().includes(customer.toLowerCase()));

  res.json({ loads: rtb });
});

// ── ACTIVITY FEED ─────────────────────────────────────────────────────────────
app.get('/api/activity', reqMgr, (req, res) => {
  const limit = Number(req.query.limit) || 50;
  const since = req.query.since; // ISO string
  let feed = store.activity;
  if (since) feed = feed.filter(e => e.at > since);
  res.json({ activity: feed.slice(0, limit), serverTime: new Date().toISOString() });
});

// ── REPORTS ────────────────────────────────────────────────────────────────────
app.get('/api/reports', reqMgr, (req, res) => {
  // Driver performance (all time)
  const driverStats = {};
  store.trucks.forEach(t => {
    const tLoads = store.loads.filter(l => l.truckId === t.id);
    driverStats[t.id] = {
      label: t.label, truckNum: t.truckNum,
      totalLoads: tLoads.reduce((s,l)=>s+(Number(l.loadsAssigned)||0),0),
      delivered:  tLoads.reduce((s,l)=>s+(Number(l.loadsDelivered)||0),0),
      completed:  tLoads.filter(l=>l.status==='completed').length,
      active:     tLoads.filter(l=>l.status==='active').length,
    };
  });

  // Customer volume
  const custStats = {};
  store.pos.forEach(p => {
    if (!custStats[p.customer]) custStats[p.customer] = { pos: 0, loads: 0, delivered: 0 };
    custStats[p.customer].pos++;
    const pLoads = store.loads.filter(l=>l.poId===p.id);
    custStats[p.customer].loads     += pLoads.reduce((s,l)=>s+(Number(l.loadsAssigned)||0),0);
    custStats[p.customer].delivered += pLoads.reduce((s,l)=>s+(Number(l.loadsDelivered)||0),0);
  });

  // Material volume
  const matStats = {};
  store.loads.forEach(l => {
    if (!matStats[l.material]) matStats[l.material] = { ordered: 0, delivered: 0 };
    matStats[l.material].ordered   += Number(l.loadsAssigned)||0;
    matStats[l.material].delivered += Number(l.loadsDelivered)||0;
  });

  // Weekly trend (last 8 weeks)
  const weeks = [];
  for (let w=7; w>=0; w--) {
    const wStart = new Date(); wStart.setDate(wStart.getDate() - w*7 - wStart.getDay()+1); wStart.setHours(0,0,0,0);
    const wEnd   = new Date(wStart); wEnd.setDate(wStart.getDate()+6);
    const wStartStr = wStart.toISOString().slice(0,10);
    const wEndStr   = wEnd.toISOString().slice(0,10);
    const wLoads = store.loads.filter(l=>l.deliveryDate>=wStartStr&&l.deliveryDate<=wEndStr);
    weeks.push({
      label: wStart.toLocaleDateString('en-US',{month:'short',day:'numeric'}),
      ordered:   wLoads.reduce((s,l)=>s+(Number(l.loadsAssigned)||0),0),
      delivered: wLoads.reduce((s,l)=>s+(Number(l.loadsDelivered)||0),0),
    });
  }

  res.json({ driverStats, custStats, matStats, weeks });
});

// ── Safe startup: init data → start server ───────────────────────────────────
(async () => {
  await initPg();      // Init pool + verify connection for business data
  await loadData();    // Load existing data (never resets)
  app.listen(PORT, () => {
    console.log(`VBT Dispatch running on port ${PORT}`);
    if (!pg) {
      console.warn('⚠ WARNING: Running without Postgres. Data will be lost on redeploy.');
      console.warn('  Add a Postgres database in Railway to persist data permanently.');
    }
  });
})();
