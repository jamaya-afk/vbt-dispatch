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

const MATERIALS = ['Fill Sand','Gravel','Rock','3/4 Rock','Cold Mix','Recycle Base','Dirt','Base Rock','Other'];

// Pickup yards / vendors — drivers pick which yard they actually arrived at
const YARDS = [
  { id: 'vbt',           name: 'VBT Yard',       location: 'Fresno, CA' },
  { id: 'cemex-fresno',  name: 'CEMEX',          location: 'Fresno, CA' },
  { id: 'vulcan',        name: 'Vulcan',         location: 'Fresno, CA' },
  { id: 'keith-farms',   name: 'Keith Farms',    location: 'Fowler, CA' },
  { id: 'graniterock',   name: 'Graniterock',    location: 'Madera, CA' },
  { id: 'other',         name: 'Other',          location: '' },
];

// ── DATA STORE — Postgres primary, file backup ───────────────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');
let pg = null;
let store = {
  pos: [],         // active POs
  loads: [],       // active loads
  archive: [],     // { archivedAt, batchId, pos: [...], loads: [...] } — billed loads moved here when sent to Sheets
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

// ── API: DATA (board, lists, etc.) ──────────────────────────────────────────
app.get('/api/data', reqAuth, (req, res) => {
  const u = req.session.user;
  if (u.role === 'driver') {
    // Drivers only get THEIR own loads + the linked POs
    const myLoads = store.loads.filter(l => l.truckId === u.truckId && !l.voided);
    const myPoIds = new Set(myLoads.map(l => l.poId));
    const myPos = store.pos.filter(p => myPoIds.has(p.id));
    return res.json({ trucks: TRUCKS, materials: MATERIALS, yards: YARDS, pos: myPos, loads: myLoads });
  }
  res.json({ trucks: TRUCKS, materials: MATERIALS, yards: YARDS, pos: store.pos, loads: store.loads });
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
      pickupLocation: po.pickup || 'VBT Yard',
      deliveryLocation: po.address || po.city || '',
      city: po.city || '',
      material: l.material,
      loadsAssigned: l.loadsAssigned,
      loadsDelivered: l.loadsDelivered,
      notes: po.notes || '',
      deliveryDate: l.deliveryDate,
      timestamps: l.timestamps || {},
      pod: l.pod || {},
      ticketImage: l.ticketImage || '',
      ticketImageAt: l.ticketImageAt || '',
      approvalStatus: l.approvalStatus,
      rejectReason: l.rejectReason || '',
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
    customer:     po.customer || '',
    job:          po.job || po.customer || '',
    address:      po.address || '',
    city:         po.city || '',
    deliveryDate: po.deliveryDate,
    pickup:       po.pickup || 'VBT Yard',
    notes:        po.notes || '',
    status:       po.deliveryDate > todayStr() ? 'scheduled' : 'active',
    materials:    [],
    createdAt:    new Date().toISOString(),
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
      const yard = YARDS.find(y => y.id === req.body.yardId);
      if (yard) {
        l.actualYardId   = yard.id;
        l.actualYardName = yard.name;
      }
    }
  } else if (action === 'delivered') {
    if (!l.timestamps?.start)         return res.status(400).json({ error: 'Must start trip first' });
    if (!l.timestamps?.arrivedPickup) return res.status(400).json({ error: 'Must mark arrived at pickup first' });
    if (!l.ticketImage)               return res.status(400).json({ error: 'Ticket photo required' });
    if (!l.pod?.signedBy)             return res.status(400).json({ error: 'Customer signature required' });
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
