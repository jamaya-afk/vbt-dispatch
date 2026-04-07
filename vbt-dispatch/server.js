const express = require('express');
const { google } = require('googleapis');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'vbt-dispatch-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

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
  { id: 'beryle',   label: 'Beryle',   truckNum: 'Truck #2',  driver: 'Beryle'   },
  { id: 'matthew',  label: 'Matthew',  truckNum: 'Truck #4',  driver: 'Matthew'  },
  { id: 'rigo',     label: 'Rigo',     truckNum: 'Truck #14', driver: 'Rigo'     },
  { id: 'leonardo', label: 'Leonardo', truckNum: 'Truck #12', driver: 'Leonardo' },
  { id: 'carlos',   label: 'Carlos',   truckNum: 'Truck #2B', driver: 'Carlos'   },
];

// ── Postgres ──────────────────────────────────────────────────────────────────
let pg = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    pg = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    pg.query(`CREATE TABLE IF NOT EXISTS dispatch_data (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
      .then(() => console.log('Postgres connected'))
      .catch(e => { console.warn('Postgres error:', e.message); pg = null; });
  } catch(e) { pg = null; }
}

// ── Store ─────────────────────────────────────────────────────────────────────
// pos[]:  { id, poNumber, customer, code, material, totalLoads, deliveryDate,
//           pickup, supervisor, city, address, notes, type, recurrenceRule,
//           status: active|completed|scheduled,
//           invoice: { pricePerLoad, paymentStatus: unpaid|partial|paid,
//                      amountPaid, notes },
//           createdAt, completedAt }
//
// loads[]: { id, poId, truckId, driverName, loadsAssigned, loadsDelivered,
//            status: active|completed|scheduled, deliveryDate,
//            timestamps: { start, arrived, completed },
//            pod: { signedBy, signature, signedAt, notes },
//            notes, completedAt }
//
// payments[]: { id, poId, amount, method, note, paidAt }

let store = {
  trucks: DEFAULT_TRUCKS,
  pos: [], loads: [], payments: [],
  nextPoNum: 1001, nextLoadId: 1, nextPaymentId: 1
};

async function loadData() {
  try {
    if (pg) {
      const r = await pg.query("SELECT value FROM dispatch_data WHERE key='store'");
      if (r.rows.length) { store = JSON.parse(r.rows[0].value); ensureDefaults(); console.log(`Loaded ${store.pos.length} POs`); return; }
    }
    if (fs.existsSync(DATA_FILE)) {
      store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      ensureDefaults();
      console.log(`Loaded ${store.pos.length} POs from file`);
    }
  } catch(e) { console.warn('loadData error:', e.message); }
}

function ensureDefaults() {
  if (!store.payments) store.payments = [];
  if (!store.nextPaymentId) store.nextPaymentId = 1;
  if (!store.nextPoNum) store.nextPoNum = 1001;
  if (!store.nextLoadId) store.nextLoadId = 1;
  store.pos.forEach(p => {
    if (!p.invoice) p.invoice = { pricePerLoad: 0, paymentStatus: 'unpaid', amountPaid: 0, notes: '' };
  });
  store.loads.forEach(l => {
    if (!l.pod) l.pod = { signedBy: '', signature: '', signedAt: '', notes: '' };
    if (!l.timestamps) l.timestamps = {};
  });
}

async function saveData() {
  try {
    const json = JSON.stringify(store);
    if (pg) {
      await pg.query("INSERT INTO dispatch_data(key,value) VALUES('store',$1) ON CONFLICT(key) DO UPDATE SET value=$1", [json]);
    } else {
      fs.writeFileSync(DATA_FILE, json);
    }
  } catch(e) { console.warn('saveData error:', e.message); }
}

function promoteScheduled() {
  const today = new Date().toISOString().slice(0,10);
  store.pos.forEach(po => {
    if (po.status === 'scheduled' && po.deliveryDate <= today) {
      po.status = 'active';
      store.loads.filter(l => l.poId === po.id && l.status === 'scheduled').forEach(l => l.status = 'active');
    }
  });
}

function nextRecurrence(fromDate, rule) {
  const d = new Date(fromDate + 'T12:00:00');
  if (rule === 'weekly')   d.setDate(d.getDate() + 7);
  if (rule === 'biweekly') d.setDate(d.getDate() + 14);
  if (rule === 'monthly')  d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0,10);
}

function poStats(poId) {
  const ls = store.loads.filter(l => l.poId === poId);
  const totalAssigned = ls.reduce((s,l) => s + (Number(l.loadsAssigned)||0), 0);
  const totalDelivered = ls.reduce((s,l) => s + (Number(l.loadsDelivered)||0), 0);
  const completedLoads = ls.filter(l => l.status === 'completed').length;
  return { totalAssigned, totalDelivered, completedLoads, loadCount: ls.length };
}

// Google Auth
let serviceAccount;
if (process.env.SERVICE_ACCOUNT_JSON) { serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON); }
else { try { serviceAccount = require('./service-account.json'); } catch(e) {} }
const auth = new google.auth.GoogleAuth({ credentials: serviceAccount, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version: 'v4', auth });

// ── Sheets helpers ────────────────────────────────────────────────────────────
async function ensureSheet(name) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === name);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: name } } }] }
    });
  }
}

async function getSheetData(tab) {
  try {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A:Z` });
    return r.data.values || [];
  } catch(e) { return []; }
}

async function appendRows(tab, rows) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: `${tab}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows }
  });
}

async function updateRow(tab, rowIndex, values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] }
  });
}

function requireAuth(req, res, next) { if (req.session?.user) return next(); res.redirect('/login'); }
function requireManager(req, res, next) { if (req.session?.user?.role === 'manager') return next(); res.status(403).json({ error: 'Manager only' }); }

app.use('/app', requireAuth, express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => { if (req.session?.user) return res.redirect('/app'); res.redirect('/login'); });

app.get('/login', (req, res) => {
  const err = req.query.error ? '<p class="err">Invalid username or password</p>' : '';
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VBT Dispatch</title>
  <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'IBM Plex Sans',system-ui,sans-serif;background:#f4f3ef;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.card{background:#fff;border-radius:16px;border:0.5px solid #ddd;padding:36px 32px;width:100%;max-width:360px}h1{font-family:'IBM Plex Mono',monospace;font-size:18px;font-weight:500;margin-bottom:6px;color:#111}.sub{font-size:13px;color:#888;margin-bottom:28px}label{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#666;display:block;margin-bottom:5px}input{width:100%;padding:9px 12px;border:0.5px solid #ccc;border-radius:8px;font-size:14px;font-family:inherit;margin-bottom:14px;color:#111;background:#fff}input:focus{outline:none;border-color:#888}button{width:100%;padding:10px;background:#111;color:#fff;border:none;border-radius:8px;font-size:14px;font-family:inherit;cursor:pointer;margin-top:4px}button:hover{background:#333}.err{color:#c00;font-size:13px;margin-bottom:14px;background:#fff0f0;padding:8px 12px;border-radius:8px;border:0.5px solid #fcc}</style>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500&family=IBM+Plex+Sans&display=swap" rel="stylesheet">
  </head><body><div class="card"><h1>VBT Dispatch</h1><p class="sub">Sign in to access your schedule</p>${err}
  <form method="POST" action="/login"><label>Username</label><input name="username" placeholder="e.g. beryle" autocomplete="username"><label>Password</label><input name="password" type="password" placeholder="••••••••" autocomplete="current-password"><button type="submit">Sign in</button></form>
  </div></body></html>`);
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = USERS[username?.toLowerCase().trim()];
  if (!user || user.password !== password) return res.redirect('/login?error=1');
  req.session.user = { username, role: user.role, truckId: user.truckId };
  res.redirect('/app');
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });
app.get('/api/me', requireAuth, (req, res) => res.json({ username: req.session.user.username, role: req.session.user.role, truckId: req.session.user.truckId||null }));

app.get('/api/data', requireAuth, (req, res) => {
  promoteScheduled();
  const user = req.session.user;
  if (user.role === 'driver') {
    const myLoads = store.loads.filter(l => l.truckId === user.truckId);
    const myPoIds = new Set(myLoads.map(l => l.poId));
    const myPos = store.pos.filter(p => myPoIds.has(p.id)).map(p => ({ ...p, invoice: undefined }));
    return res.json({ trucks: store.trucks, pos: myPos, loads: myLoads, payments: [] });
  }
  res.json({ trucks: store.trucks, pos: store.pos, loads: store.loads, payments: store.payments });
});

// ── PO CRUD ───────────────────────────────────────────────────────────────────
app.post('/api/pos', requireManager, async (req, res) => {
  const { po, splits } = req.body;
  if (!po.customer) return res.status(400).json({ error: 'Customer required' });
  if (!splits?.length) return res.status(400).json({ error: 'At least one split required' });
  const today = new Date().toISOString().slice(0,10);
  const deliveryDate = po.deliveryDate || today;
  const type = po.type || 'one-time';
  const status = type === 'scheduled' && deliveryDate > today ? 'scheduled' : 'active';
  const poId = po.poNumber || ('PO-' + store.nextPoNum++);
  store.pos.push({
    id: poId, poNumber: poId, customer: po.customer, code: po.code||'',
    material: po.material||'Fill Sand', totalLoads: Number(po.totalLoads)||0,
    deliveryDate, pickup: po.pickup||'VBT Yard', supervisor: po.supervisor||'',
    city: po.city||po.address||'', address: po.address||po.city||'',
    notes: po.notes||'', type, recurrenceRule: type==='recurring'?po.recurrenceRule:null,
    status, createdAt: new Date().toISOString(), completedAt: null,
    invoice: { pricePerLoad: Number(po.pricePerLoad)||0, paymentStatus: 'unpaid', amountPaid: 0, notes: '' }
  });
  splits.forEach(s => {
    store.loads.push({
      id: 'LOAD-' + store.nextLoadId++, poId,
      truckId: s.truckId, driverName: s.driverName||'',
      loadsAssigned: Number(s.loadsAssigned)||0, loadsDelivered: 0,
      status: status === 'scheduled' ? 'scheduled' : 'active',
      deliveryDate: s.deliveryDate || deliveryDate,
      timestamps: {}, pod: { signedBy:'', signature:'', signedAt:'', notes:'' },
      notes: '', completedAt: null
    });
  });
  await saveData();
  res.json({ success: true, pos: store.pos, loads: store.loads });
});

app.put('/api/pos/:id', requireManager, async (req, res) => {
  const idx = store.pos.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'PO not found' });
  const existing = store.pos[idx];
  store.pos[idx] = { ...existing, ...req.body, id: req.params.id, invoice: existing.invoice, createdAt: existing.createdAt };
  if (req.body.invoice) store.pos[idx].invoice = { ...existing.invoice, ...req.body.invoice };
  await saveData();
  res.json({ success: true, po: store.pos[idx] });
});

app.delete('/api/pos/:id', requireManager, async (req, res) => {
  store.loads = store.loads.filter(l => l.poId !== req.params.id);
  store.payments = store.payments.filter(p => p.poId !== req.params.id);
  store.pos = store.pos.filter(p => p.id !== req.params.id);
  await saveData();
  res.json({ success: true });
});

app.post('/api/pos/:id/splits', requireManager, async (req, res) => {
  const po = store.pos.find(p => p.id === req.params.id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  const splits = Array.isArray(req.body) ? req.body : [req.body];
  splits.forEach(s => {
    store.loads.push({
      id: 'LOAD-' + store.nextLoadId++, poId: po.id,
      truckId: s.truckId, driverName: s.driverName||'',
      loadsAssigned: Number(s.loadsAssigned)||0, loadsDelivered: 0,
      status: po.status === 'scheduled' ? 'scheduled' : 'active',
      deliveryDate: s.deliveryDate || po.deliveryDate,
      timestamps: {}, pod: { signedBy:'', signature:'', signedAt:'', notes:'' },
      notes: '', completedAt: null
    });
  });
  await saveData();
  res.json({ success: true, loads: store.loads.filter(l => l.poId === po.id) });
});

app.post('/api/pos/:id/rollover', requireManager, async (req, res) => {
  const po = store.pos.find(p => p.id === req.params.id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  const { newDate } = req.body;
  store.loads.filter(l => l.poId === po.id && l.status !== 'completed').forEach(l => l.deliveryDate = newDate);
  po.deliveryDate = newDate;
  await saveData();
  res.json({ success: true });
});

// ── LOAD CRUD ─────────────────────────────────────────────────────────────────
app.put('/api/loads/:id', requireAuth, async (req, res) => {
  const user = req.session.user;
  const idx = store.loads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Load not found' });
  if (user.role === 'driver' && store.loads[idx].truckId !== user.truckId) return res.status(403).json({ error: 'Not your load' });
  if (user.role === 'driver') {
    const l = store.loads[idx];
    store.loads[idx] = {
      ...l,
      loadsDelivered: req.body.loadsDelivered !== undefined ? Number(req.body.loadsDelivered) : l.loadsDelivered,
      notes: req.body.notes !== undefined ? req.body.notes : l.notes,
      timestamps: req.body.timestamps ? { ...l.timestamps, ...req.body.timestamps } : l.timestamps,
      pod: req.body.pod ? { ...l.pod, ...req.body.pod } : l.pod
    };
  } else {
    store.loads[idx] = { ...store.loads[idx], ...req.body, id: store.loads[idx].id, poId: store.loads[idx].poId };
  }
  await saveData();
  res.json({ success: true, load: store.loads[idx] });
});

app.post('/api/loads/:id/complete', requireAuth, async (req, res) => {
  const user = req.session.user;
  const idx = store.loads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Load not found' });
  if (user.role === 'driver' && store.loads[idx].truckId !== user.truckId) return res.status(403).json({ error: 'Not your load' });
  store.loads[idx].status = 'completed';
  store.loads[idx].completedAt = new Date().toISOString();
  if (req.body.pod) store.loads[idx].pod = { ...store.loads[idx].pod, ...req.body.pod };
  // Check if all PO loads done
  const poId = store.loads[idx].poId;
  const allDone = store.loads.filter(l => l.poId === poId).every(l => l.status === 'completed');
  if (allDone) {
    const poIdx = store.pos.findIndex(p => p.id === poId);
    if (poIdx !== -1) {
      store.pos[poIdx].status = 'completed';
      store.pos[poIdx].completedAt = new Date().toISOString();
      // Recurring next instance
      const po = store.pos[poIdx];
      if (po.type === 'recurring' && po.recurrenceRule) {
        const nextDate = nextRecurrence(po.deliveryDate, po.recurrenceRule);
        const today2 = new Date().toISOString().slice(0,10);
        const nextPoId = 'PO-' + store.nextPoNum++;
        store.pos.push({ ...po, id: nextPoId, poNumber: nextPoId, deliveryDate: nextDate, status: nextDate > today2 ? 'scheduled' : 'active', completedAt: null, createdAt: new Date().toISOString(), invoice: { ...po.invoice, paymentStatus: 'unpaid', amountPaid: 0 } });
        store.loads.filter(l => l.poId === poId).forEach(l => {
          store.loads.push({ ...l, id: 'LOAD-' + store.nextLoadId++, poId: nextPoId, loadsDelivered: 0, status: nextDate > today2 ? 'scheduled' : 'active', deliveryDate: nextDate, timestamps: {}, pod: { signedBy:'', signature:'', signedAt:'', notes:'' }, completedAt: null });
        });
      }
    }
  }
  await saveData();
  res.json({ success: true, pos: store.pos, loads: store.loads });
});

app.delete('/api/loads/:id', requireManager, async (req, res) => {
  store.loads = store.loads.filter(l => l.id !== req.params.id);
  await saveData();
  res.json({ success: true });
});

// ── PAYMENTS ──────────────────────────────────────────────────────────────────
app.post('/api/payments', requireManager, async (req, res) => {
  const { poId, amount, method, note } = req.body;
  if (!poId || !amount) return res.status(400).json({ error: 'poId and amount required' });
  const po = store.pos.find(p => p.id === poId);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  const payment = { id: 'PAY-' + store.nextPaymentId++, poId, amount: Number(amount), method: method||'', note: note||'', paidAt: new Date().toISOString() };
  store.payments.push(payment);
  // Update PO invoice
  const totalPaid = store.payments.filter(p => p.poId === poId).reduce((s,p) => s + p.amount, 0);
  const totalDue = (po.invoice?.pricePerLoad||0) * (po.totalLoads||0);
  po.invoice.amountPaid = totalPaid;
  po.invoice.paymentStatus = totalPaid <= 0 ? 'unpaid' : totalPaid >= totalDue ? 'paid' : 'partial';
  await saveData();
  res.json({ success: true, payment, po });
});

app.put('/api/pos/:id/invoice', requireManager, async (req, res) => {
  const po = store.pos.find(p => p.id === req.params.id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  po.invoice = { ...po.invoice, ...req.body };
  await saveData();
  res.json({ success: true, po });
});

app.post('/api/trucks', requireManager, async (req, res) => {
  store.trucks = req.body;
  await saveData();
  res.json({ success: true });
});

// ── GOOGLE SHEETS SYNC (append-only per tab) ──────────────────────────────────
app.post('/api/sync', requireManager, async (req, res) => {
  try {
    const tabs = ['POs', 'Loads', 'Payments', 'Signatures', 'Dashboard'];
    for (const tab of tabs) await ensureSheet(tab);
    const ts = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });

    // ── POs tab ────────────────────────────────────────────────────────────────
    const poHeaders = ['PO Number','Customer','Code','Material','Total Loads','Delivered','Delivery Date','Pickup','Address','Supervisor','Type','Status','Price/Load','Amount Paid','Balance','Payment Status','Notes','Created At','Completed At','Last Synced'];
    const existingPos = await getSheetData('POs');
    if (existingPos.length === 0) await appendRows('POs', [poHeaders]);
    const existingPoNums = new Set((existingPos.slice(1)||[]).map(r => r[0]));
    const newPoRows = [];
    for (const po of store.pos) {
      const stats = poStats(po.id);
      const inv = po.invoice || {};
      const totalDue = (inv.pricePerLoad||0) * (po.totalLoads||0);
      const balance = totalDue - (inv.amountPaid||0);
      if (!existingPoNums.has(po.poNumber)) {
        newPoRows.push([po.poNumber, po.customer, po.code||'', po.material, po.totalLoads, stats.totalDelivered, po.deliveryDate, po.pickup||'', po.city||'', po.supervisor||'', po.type||'one-time', po.status, inv.pricePerLoad||0, inv.amountPaid||0, balance, inv.paymentStatus||'unpaid', po.notes||'', po.createdAt||'', po.completedAt||'', ts]);
      }
    }
    if (newPoRows.length) await appendRows('POs', newPoRows);
    // Update existing PO rows (status, delivered, payment)
    const refreshedPos = await getSheetData('POs');
    for (let i = 1; i < refreshedPos.length; i++) {
      const poNum = refreshedPos[i][0];
      const po = store.pos.find(p => p.poNumber === poNum);
      if (po) {
        const stats = poStats(po.id);
        const inv = po.invoice || {};
        const totalDue = (inv.pricePerLoad||0) * (po.totalLoads||0);
        refreshedPos[i][5] = stats.totalDelivered;
        refreshedPos[i][11] = po.status;
        refreshedPos[i][13] = inv.amountPaid||0;
        refreshedPos[i][14] = totalDue - (inv.amountPaid||0);
        refreshedPos[i][15] = inv.paymentStatus||'unpaid';
        refreshedPos[i][18] = po.completedAt||'';
        refreshedPos[i][19] = ts;
        await updateRow('POs', i+1, refreshedPos[i]);
      }
    }

    // ── Loads tab ──────────────────────────────────────────────────────────────
    const loadHeaders = ['Load ID','PO Number','Customer','Driver','Truck','Loads Assigned','Loads Delivered','Missing','Delivery Date','Status','Start Time','Arrived Time','Completed Time','Signed By','Signed At','POD Notes','Load Notes','Completed At','Last Synced'];
    const existingLoads = await getSheetData('Loads');
    if (existingLoads.length === 0) await appendRows('Loads', [loadHeaders]);
    const existingLoadIds = new Set((existingLoads.slice(1)||[]).map(r => r[0]));
    const newLoadRows = [];
    for (const l of store.loads) {
      const po = store.pos.find(p => p.id === l.poId);
      const t = store.trucks.find(x => x.id === l.truckId);
      const ts2 = l.timestamps||{};
      const pod = l.pod||{};
      const missing = Math.max(0,(Number(l.loadsAssigned)||0)-(Number(l.loadsDelivered)||0));
      if (!existingLoadIds.has(l.id)) {
        newLoadRows.push([l.id, po?.poNumber||l.poId, po?.customer||'', l.driverName||'', t?.truckNum||'', l.loadsAssigned, l.loadsDelivered, missing, l.deliveryDate, l.status, ts2.start||'', ts2.arrived||'', ts2.completed||'', pod.signedBy||'', pod.signedAt||'', pod.notes||'', l.notes||'', l.completedAt||'', ts]);
      }
    }
    if (newLoadRows.length) await appendRows('Loads', newLoadRows);
    // Update completed loads
    const refreshedLoads = await getSheetData('Loads');
    for (let i = 1; i < refreshedLoads.length; i++) {
      const loadId = refreshedLoads[i][0];
      const l = store.loads.find(x => x.id === loadId);
      if (l && l.status === 'completed') {
        const ts2 = l.timestamps||{};
        const pod = l.pod||{};
        refreshedLoads[i][6] = l.loadsDelivered;
        refreshedLoads[i][7] = Math.max(0,(Number(l.loadsAssigned)||0)-(Number(l.loadsDelivered)||0));
        refreshedLoads[i][9] = l.status;
        refreshedLoads[i][10] = ts2.start||'';
        refreshedLoads[i][11] = ts2.arrived||'';
        refreshedLoads[i][12] = ts2.completed||'';
        refreshedLoads[i][13] = pod.signedBy||'';
        refreshedLoads[i][14] = pod.signedAt||'';
        refreshedLoads[i][17] = l.completedAt||'';
        refreshedLoads[i][18] = ts;
        await updateRow('Loads', i+1, refreshedLoads[i]);
      }
    }

    // ── Payments tab ───────────────────────────────────────────────────────────
    const payHeaders = ['Payment ID','PO Number','Customer','Amount','Method','Note','Paid At'];
    const existingPay = await getSheetData('Payments');
    if (existingPay.length === 0) await appendRows('Payments', [payHeaders]);
    const existingPayIds = new Set((existingPay.slice(1)||[]).map(r => r[0]));
    const newPayRows = [];
    for (const p of store.payments) {
      const po = store.pos.find(x => x.id === p.poId);
      if (!existingPayIds.has(p.id)) {
        newPayRows.push([p.id, po?.poNumber||p.poId, po?.customer||'', p.amount, p.method||'', p.note||'', p.paidAt]);
      }
    }
    if (newPayRows.length) await appendRows('Payments', newPayRows);

    // ── Signatures tab ─────────────────────────────────────────────────────────
    const sigHeaders = ['Load ID','PO Number','Customer','Driver','Signed By','Signed At','Notes'];
    const existingSigs = await getSheetData('Signatures');
    if (existingSigs.length === 0) await appendRows('Signatures', [sigHeaders]);
    const existingSigIds = new Set((existingSigs.slice(1)||[]).map(r => r[0]));
    const newSigRows = [];
    for (const l of store.loads) {
      const pod = l.pod||{};
      if (pod.signedBy && pod.signedAt && !existingSigIds.has(l.id)) {
        const po = store.pos.find(p => p.id === l.poId);
        newSigRows.push([l.id, po?.poNumber||l.poId, po?.customer||'', l.driverName||'', pod.signedBy, pod.signedAt, pod.notes||'']);
      }
    }
    if (newSigRows.length) await appendRows('Signatures', newSigRows);

    // ── Dashboard tab (full rewrite) ────────────────────────────────────────────
    await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: 'Dashboard!A:Z' });
    const activePOs = store.pos.filter(p => p.status === 'active');
    const completedPOs = store.pos.filter(p => p.status === 'completed');
    const totalRevenue = store.pos.reduce((s,p) => s + (p.invoice?.pricePerLoad||0)*(p.totalLoads||0), 0);
    const totalPaid = store.payments.reduce((s,p) => s + p.amount, 0);
    const totalLoadsOrdered = store.pos.reduce((s,p) => s + (Number(p.totalLoads)||0), 0);
    const totalDelivered = store.loads.reduce((s,l) => s + (Number(l.loadsDelivered)||0), 0);
    const dashRows = [
      ['VBT DISPATCH — BUSINESS DASHBOARD', '', '', `Last updated: ${ts}`],
      [],
      ['OVERVIEW', '', '', ''],
      ['Total POs', store.pos.length, '', ''],
      ['Active POs', activePOs.length, '', ''],
      ['Completed POs', completedPOs.length, '', ''],
      ['Scheduled POs', store.pos.filter(p=>p.status==='scheduled').length, '', ''],
      [],
      ['LOADS', '', '', ''],
      ['Total Loads Ordered', totalLoadsOrdered, '', ''],
      ['Total Loads Delivered', totalDelivered, '', ''],
      ['Total Missing Loads', totalLoadsOrdered - totalDelivered, '', ''],
      ['Delivery Rate', totalLoadsOrdered > 0 ? `=B11/B10` : '0%', '', ''],
      [],
      ['REVENUE', '', '', ''],
      ['Total Revenue (invoiced)', totalRevenue, '', ''],
      ['Total Collected', totalPaid, '', ''],
      ['Outstanding Balance', totalRevenue - totalPaid, '', ''],
      ['Collection Rate', totalRevenue > 0 ? `=B17/B16` : '0%', '', ''],
      [],
      ['PAYMENT BREAKDOWN', '', '', ''],
      ['Unpaid POs', store.pos.filter(p=>p.invoice?.paymentStatus==='unpaid').length, '', ''],
      ['Partial POs', store.pos.filter(p=>p.invoice?.paymentStatus==='partial').length, '', ''],
      ['Paid POs', store.pos.filter(p=>p.invoice?.paymentStatus==='paid').length, '', ''],
      [],
      ['TOP CUSTOMERS (by loads)', '', '', ''],
      ['Customer', 'POs', 'Loads Ordered', 'Loads Delivered'],
    ];
    const customerMap = {};
    store.pos.forEach(p => {
      if (!customerMap[p.customer]) customerMap[p.customer] = { pos:0, ordered:0, delivered:0 };
      customerMap[p.customer].pos++;
      customerMap[p.customer].ordered += Number(p.totalLoads)||0;
      customerMap[p.customer].delivered += store.loads.filter(l=>l.poId===p.id).reduce((s,l)=>s+(Number(l.loadsDelivered)||0),0);
    });
    Object.entries(customerMap).sort((a,b)=>b[1].ordered-a[1].ordered).slice(0,10).forEach(([cust,d]) => {
      dashRows.push([cust, d.pos, d.ordered, d.delivered]);
    });
    await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: 'Dashboard!A1', valueInputOption: 'USER_ENTERED', requestBody: { values: dashRows } });

    res.json({ success: true, message: `Synced: ${newPoRows.length} new POs, ${newLoadRows.length} new loads, ${newPayRows.length} new payments, ${newSigRows.length} new signatures` });
  } catch(err) {
    console.error('Sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
loadData().then(() => app.listen(PORT, () => console.log(`VBT Dispatch on port ${PORT}`)));
