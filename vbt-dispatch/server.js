const express = require('express');
const { google } = require('googleapis');
const session = require('express-session');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Session ──────────────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'vbt-dispatch-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 7 days
}));

// ── Config ───────────────────────────────────────────────────────────────────
const SHEET_ID  = '1T5pOeXmLmZyKKfq4YRl9aymXn9MQnNrqmcuyJluMhQs';
const SHEET_TAB = 'Dispatch';

// Users: { username: { password, role: 'manager' | 'driver' } }
const USERS = {
  manager: { password: process.env.MANAGER_PASS || 'vbt2025!',  role: 'manager' },
  driver:  { password: process.env.DRIVER_PASS  || 'driver123', role: 'driver'  },
};

// ── Google Auth ───────────────────────────────────────────────────────────────
let serviceAccount;
if (process.env.SERVICE_ACCOUNT_JSON) {
  serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
} else {
  try { serviceAccount = require('./service-account.json'); }
  catch(e) { console.warn('No service-account.json found. Set SERVICE_ACCOUNT_JSON env var.'); }
}
const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.redirect('/login');
}
function requireManager(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'manager') return next();
  res.status(403).json({ error: 'Manager access required' });
}

// ── Static files (serve app) ─────────────────────────────────────────────────
app.use('/app', requireAuth, express.static(path.join(__dirname, 'public')));

// ── Login page ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/app');
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  const error = req.query.error ? '<p class="err">Invalid username or password</p>' : '';
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>VBT Dispatch — Login</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'IBM Plex Sans',system-ui,sans-serif;background:#f4f3ef;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .card{background:#fff;border-radius:16px;border:0.5px solid #ddd;padding:36px 32px;width:100%;max-width:360px}
    h1{font-family:'IBM Plex Mono',monospace;font-size:18px;font-weight:500;margin-bottom:6px;color:#111}
    .sub{font-size:13px;color:#888;margin-bottom:28px}
    label{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#666;display:block;margin-bottom:5px}
    input{width:100%;padding:9px 12px;border:0.5px solid #ccc;border-radius:8px;font-size:14px;font-family:inherit;margin-bottom:14px;color:#111;background:#fff}
    input:focus{outline:none;border-color:#888}
    button{width:100%;padding:10px;background:#111;color:#fff;border:none;border-radius:8px;font-size:14px;font-family:inherit;cursor:pointer;margin-top:4px}
    button:hover{background:#333}
    .err{color:#c00;font-size:13px;margin-bottom:14px;background:#fff0f0;padding:8px 12px;border-radius:8px;border:0.5px solid #fcc}
  </style>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500&family=IBM+Plex+Sans&display=swap" rel="stylesheet">
</head>
<body>
  <div class="card">
    <h1>VBT Dispatch</h1>
    <p class="sub">Sign in to access the schedule</p>
    ${error}
    <form method="POST" action="/login">
      <label>Username</label>
      <input name="username" placeholder="manager or driver" autocomplete="username">
      <label>Password</label>
      <input name="password" type="password" placeholder="••••••••" autocomplete="current-password">
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = USERS[username];
  if (!user || user.password !== password) {
    return res.redirect('/login?error=1');
  }
  req.session.user = { username, role: user.role };
  res.redirect('/app');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ── API: current user info ────────────────────────────────────────────────────
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.session.user.username, role: req.session.user.role });
});

// ── API: sync to Google Sheets ────────────────────────────────────────────────
app.post('/api/sync', requireAuth, async (req, res) => {
  try {
    const { jobs, trucks } = req.body;
    if (!Array.isArray(jobs)) return res.status(400).json({ error: 'Invalid payload' });

    const headers = [
      'ID','Truck','Truck #','Day','Supervisor','Driver','Customer',
      'Job Code','Material','Loads Ordered','Pickup','PO #',
      'City / Address','Loads Delivered','Missing Loads','Notes','Last Updated'
    ];

    const rows = jobs.map(j => {
      const t = (trucks || []).find(x => x.id === j.truck);
      const l = Number(j.loads) || 0;
      const d = Number(j.delivered) || 0;
      return [
        j.id,
        t ? t.label : j.truck,
        t ? t.truckNum : '',
        j.day,
        j.supervisor || '',
        j.driver || '',
        j.customer || '',
        j.code || '',
        j.material || '',
        l,
        j.pickup || '',
        j.po || '',
        j.city || '',
        d,
        Math.max(0, l - d),
        j.notes || '',
        new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })
      ];
    });

    // Clear existing data then write fresh
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A:Q`,
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers, ...rows] },
    });

    res.json({ success: true, rowsWritten: rows.length });
  } catch (err) {
    console.error('Sheets sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`VBT Dispatch running at http://localhost:${PORT}`);
});
