const express = require('express');
const { google } = require('googleapis');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'vbt-dispatch-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

const SHEET_ID  = '1T5pOeXmLmZyKKfq4YRl9aymXn9MQnNrqmcuyJluMhQs';
const SHEET_TAB = 'Dispatch';
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

// ── Postgres or file storage ──────────────────────────────────────────────────
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

// store.jobs schema:
// { id, title, type: 'one-time'|'scheduled'|'recurring',
//   status: 'active'|'scheduled'|'completed',
//   dueDate: 'YYYY-MM-DD', recurrenceRule: 'weekly'|'biweekly'|'monthly'|null,
//   completedAt: ISO string|null,
//   truck, supervisor, driver, customer, code, material, loads,
//   pickup, po, city, delivered, notes, timestamps }

let store = { trucks: DEFAULT_TRUCKS, jobs: [], completedJobs: [], nextId: 1 };

async function loadData() {
  try {
    if (pg) {
      const r = await pg.query("SELECT value FROM dispatch_data WHERE key='store'");
      if (r.rows.length) { store = JSON.parse(r.rows[0].value); console.log(`Loaded ${store.jobs.length} jobs from Postgres`); return; }
    }
    if (fs.existsSync(DATA_FILE)) {
      store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (!store.completedJobs) store.completedJobs = [];
      console.log(`Loaded ${store.jobs.length} jobs from file`);
    }
  } catch(e) { console.warn('loadData error:', e.message); }
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

// ── Promote scheduled jobs whose dueDate has arrived ─────────────────────────
function promoteScheduledJobs() {
  const today = new Date().toISOString().slice(0, 10);
  store.jobs.forEach(j => {
    if (j.status === 'scheduled' && j.dueDate && j.dueDate <= today) {
      j.status = 'active';
    }
  });
}

// ── Next recurrence date ──────────────────────────────────────────────────────
function nextRecurrenceDate(fromDate, rule) {
  const d = new Date(fromDate + 'T12:00:00');
  if (rule === 'weekly')    d.setDate(d.getDate() + 7);
  if (rule === 'biweekly')  d.setDate(d.getDate() + 14);
  if (rule === 'monthly')   d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

// Google Auth
let serviceAccount;
if (process.env.SERVICE_ACCOUNT_JSON) {
  serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
} else {
  try { serviceAccount = require('./service-account.json'); }
  catch(e) { console.warn('No service-account.json'); }
}
const auth = new google.auth.GoogleAuth({ credentials: serviceAccount, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version: 'v4', auth });

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.redirect('/login');
}
function requireManager(req, res, next) {
  if (req.session?.user?.role === 'manager') return next();
  res.status(403).json({ error: 'Manager only' });
}

app.use('/app', requireAuth, express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  if (req.session?.user) return res.redirect('/app');
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  const error = req.query.error ? '<p class="err">Invalid username or password</p>' : '';
  res.send(`<!DOCTYPE html><html><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>VBT Dispatch</title>
  <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'IBM Plex Sans',system-ui,sans-serif;background:#f4f3ef;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.card{background:#fff;border-radius:16px;border:0.5px solid #ddd;padding:36px 32px;width:100%;max-width:360px}h1{font-family:'IBM Plex Mono',monospace;font-size:18px;font-weight:500;margin-bottom:6px;color:#111}.sub{font-size:13px;color:#888;margin-bottom:28px}label{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#666;display:block;margin-bottom:5px}input{width:100%;padding:9px 12px;border:0.5px solid #ccc;border-radius:8px;font-size:14px;font-family:inherit;margin-bottom:14px;color:#111;background:#fff}input:focus{outline:none;border-color:#888}button{width:100%;padding:10px;background:#111;color:#fff;border:none;border-radius:8px;font-size:14px;font-family:inherit;cursor:pointer;margin-top:4px}button:hover{background:#333}.err{color:#c00;font-size:13px;margin-bottom:14px;background:#fff0f0;padding:8px 12px;border-radius:8px;border:0.5px solid #fcc}</style>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500&family=IBM+Plex+Sans&display=swap" rel="stylesheet">
  </head><body><div class="card">
  <h1>VBT Dispatch</h1><p class="sub">Sign in to access your schedule</p>${error}
  <form method="POST" action="/login">
    <label>Username</label><input name="username" placeholder="e.g. beryle" autocomplete="username">
    <label>Password</label><input name="password" type="password" placeholder="••••••••" autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form></div></body></html>`);
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = USERS[username?.toLowerCase().trim()];
  if (!user || user.password !== password) return res.redirect('/login?error=1');
  req.session.user = { username, role: user.role, truckId: user.truckId };
  res.redirect('/app');
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.session.user.username, role: req.session.user.role, truckId: req.session.user.truckId || null });
});

app.get('/api/data', requireAuth, (req, res) => {
  promoteScheduledJobs();
  const user = req.session.user;
  const isDriver = user.role === 'driver';
  const activeJobs = isDriver
    ? store.jobs.filter(j => j.truck === user.truckId && j.status === 'active')
    : store.jobs.filter(j => j.status === 'active');
  const scheduledJobs = isDriver
    ? store.jobs.filter(j => j.truck === user.truckId && j.status === 'scheduled')
    : store.jobs.filter(j => j.status === 'scheduled');
  const completedJobs = isDriver
    ? store.completedJobs.filter(j => j.truck === user.truckId)
    : store.completedJobs;
  res.json({ trucks: store.trucks, jobs: activeJobs, scheduledJobs, completedJobs });
});

// Create or update a job
app.post('/api/jobs', requireAuth, async (req, res) => {
  const user = req.session.user;
  const job = req.body;

  if (job.id) {
    const idx = store.jobs.findIndex(j => j.id === Number(job.id));
    if (idx === -1) return res.status(404).json({ error: 'Job not found' });
    if (user.role === 'driver') {
      if (store.jobs[idx].truck !== user.truckId) return res.status(403).json({ error: 'Not your job' });
      store.jobs[idx] = { ...store.jobs[idx], delivered: Number(job.delivered)||0, notes: job.notes||'', timestamps: job.timestamps||{} };
    } else {
      store.jobs[idx] = { ...store.jobs[idx], ...job, id: Number(job.id) };
    }
  } else {
    if (user.role !== 'manager') return res.status(403).json({ error: 'Manager only' });
    if (!job.customer) return res.status(400).json({ error: 'Customer required' });
    const today = new Date().toISOString().slice(0, 10);
    const dueDate = job.dueDate || today;
    const type = job.type || 'one-time';
    const status = (type === 'scheduled' && dueDate > today) ? 'scheduled' : 'active';
    store.jobs.push({ ...job, id: store.nextId++, type, status, dueDate, completedAt: null });
  }
  await saveData();
  promoteScheduledJobs();
  const returnJobs = user.role === 'driver' ? store.jobs.filter(j => j.truck === user.truckId && j.status === 'active') : store.jobs.filter(j => j.status === 'active');
  res.json({ success: true, jobs: returnJobs });
});

// Complete a job
app.post('/api/jobs/:id/complete', requireAuth, async (req, res) => {
  const user = req.session.user;
  const id = Number(req.params.id);
  const idx = store.jobs.findIndex(j => j.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Job not found' });
  const job = store.jobs[idx];
  if (user.role === 'driver' && job.truck !== user.truckId) return res.status(403).json({ error: 'Not your job' });

  const completed = { ...job, status: 'completed', completedAt: new Date().toISOString() };
  store.completedJobs.unshift(completed); // newest first
  store.jobs.splice(idx, 1);

  // If recurring, generate next instance
  if (job.type === 'recurring' && job.recurrenceRule) {
    const nextDate = nextRecurrenceDate(job.dueDate || new Date().toISOString().slice(0,10), job.recurrenceRule);
    const today = new Date().toISOString().slice(0, 10);
    store.jobs.push({
      ...job,
      id: store.nextId++,
      status: nextDate > today ? 'scheduled' : 'active',
      dueDate: nextDate,
      delivered: 0,
      timestamps: {},
      completedAt: null,
    });
  }

  await saveData();
  const returnJobs = user.role === 'driver' ? store.jobs.filter(j => j.truck === user.truckId && j.status === 'active') : store.jobs.filter(j => j.status === 'active');
  const scheduledJobs = user.role === 'driver' ? store.jobs.filter(j => j.truck === user.truckId && j.status === 'scheduled') : store.jobs.filter(j => j.status === 'scheduled');
  const completedJobs = user.role === 'driver' ? store.completedJobs.filter(j => j.truck === user.truckId) : store.completedJobs;
  res.json({ success: true, jobs: returnJobs, scheduledJobs, completedJobs });
});

app.delete('/api/jobs/:id', requireManager, async (req, res) => {
  const id = Number(req.params.id);
  store.jobs = store.jobs.filter(j => j.id !== id);
  store.completedJobs = store.completedJobs.filter(j => j.id !== id);
  await saveData();
  res.json({ success: true });
});

app.post('/api/trucks', requireManager, async (req, res) => {
  store.trucks = req.body;
  await saveData();
  res.json({ success: true });
});

app.post('/api/sync', requireManager, async (req, res) => {
  try {
    const allJobs = [...store.jobs, ...store.completedJobs];
    const headers = ['ID','Status','Type','Due Date','Truck','Truck #','Supervisor','Driver','Customer','Job Code','Material','Loads Ordered','Pickup','PO #','City','Loads Delivered','Missing','Notes','Start Time','First Load','Last Load','Completed At','Last Updated'];
    const rows = allJobs.map(j => {
      const t = store.trucks.find(x => x.id === j.truck);
      const l = Number(j.loads)||0, d = Number(j.delivered)||0;
      const ts = j.timestamps||{};
      return [j.id, j.status, j.type||'one-time', j.dueDate||'', t?t.label:j.truck, t?t.truckNum:'', j.supervisor||'', j.driver||'', j.customer||'', j.code||'', j.material||'', l, j.pickup||'', j.po||'', j.city||'', d, Math.max(0,l-d), j.notes||'', ts.start||'', ts.first||'', ts.last||'', j.completedAt||'', new Date().toLocaleString('en-US',{timeZone:'America/Los_Angeles'})];
    });
    await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${SHEET_TAB}!A:W` });
    await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `${SHEET_TAB}!A1`, valueInputOption: 'RAW', requestBody: { values: [headers, ...rows] } });
    res.json({ success: true, rowsWritten: rows.length });
  } catch(err) {
    console.error('Sheets sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
loadData().then(() => {
  app.listen(PORT, () => console.log(`VBT Dispatch running on port ${PORT}`));
});
