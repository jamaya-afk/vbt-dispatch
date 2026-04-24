# VBT Dispatch — Setup & Deploy Guide

## What's in this folder

```
vbt-dispatch/
├── server.js            ← Node.js backend (auth + Google Sheets sync)
├── service-account.json ← Google service account key (keep private!)
├── package.json         ← Dependencies
├── railway.toml         ← Railway deploy config
├── .gitignore           ← Keeps service-account.json out of git
└── public/
    └── index.html       ← The dispatch app
```

---

## Passwords

| Role    | Username  | Default Password | Can do                          |
|---------|-----------|------------------|---------------------------------|
| Manager | `manager` | `vbt2025!`       | Add/edit/delete jobs, sync Sheets, edit truck #s |
| Driver  | `driver`  | `driver123`      | View their schedule, log loads delivered |

**Change passwords** by editing `server.js` lines 19-22:
```js
const USERS = {
  manager: { password: 'YOUR_NEW_MANAGER_PASSWORD', role: 'manager' },
  driver:  { password: 'YOUR_NEW_DRIVER_PASSWORD',  role: 'driver'  },
};
```

---

## Google Sheet Setup (one time)

1. Open your Google Sheet:
   https://docs.google.com/spreadsheets/d/1T5pOeXmLmZyKKfq4YRl9aymXn9MQnNrqmcuyJluMhQs

2. Share it with the service account email as **Editor**:
   `jamaya@valley-best-test.iam.gserviceaccount.com`

3. Create a tab named exactly: **Dispatch**
   (Sheet → right-click bottom tab → Rename → type "Dispatch")

That's it. The sync button will now write all jobs to that tab.

---

## Option A: Run locally (on your office computer)

### Requirements
- Node.js 18 or newer: https://nodejs.org

### Steps

1. Unzip this folder somewhere on your computer

2. Open Terminal (Mac) or Command Prompt (Windows) in that folder

3. Install dependencies:
   ```
   npm install
   ```

4. Start the app:
   ```
   npm start
   ```

5. Open browser on your computer:
   ```
   http://localhost:3000
   ```

### Let drivers access it on their phones (same WiFi)

1. Find your computer's local IP address:
   - Mac: System Preferences → Network → look for something like `192.168.1.45`
   - Windows: Open Command Prompt → type `ipconfig` → look for IPv4 Address

2. Drivers go to (replace with your actual IP):
   ```
   http://192.168.1.45:3000
   ```

> This only works when everyone is on the same WiFi network.
> For access from anywhere, use Option B below.

---

## Option B: Deploy to Railway (recommended — access from anywhere)

Railway gives you a real public URL like `https://vbt-dispatch.up.railway.app`
that works on any phone, anywhere, no WiFi required.

### Steps

1. Create a free account at https://railway.app

2. Install Railway CLI:
   ```
   npm install -g @railway/cli
   ```

3. In your project folder, run:
   ```
   railway login
   railway init
   railway up
   ```

4. Railway will give you a URL. Go to that URL and you're live.

5. Set environment variables in Railway dashboard (optional but recommended):
   - `MANAGER_PASS` → your manager password
   - `DRIVER_PASS`  → your driver password
   - `SESSION_SECRET` → any random string like `vbt-abc-xyz-2025`

### Sharing with drivers
Send drivers the URL (e.g. `https://vbt-dispatch.up.railway.app`) and the driver password.
They log in as username `driver` and can see their schedule and log loads.

---

## Option C: Deploy to Render (also free)

1. Create account at https://render.com
2. New → Web Service → Upload or connect this folder
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add environment variables same as Railway above

---

## Customizing trucks / drivers

Edit `server.js` — there's no database, trucks are stored in the browser.
To change the default truck list, edit the `trucks` array in `public/index.html` around line 180:

```js
let trucks = [
  {id:'beryle',   label:'Beryle',   truckNum:'Truck #2',  driver:'Beryle'},
  {id:'matthew',  label:'Matthew',  truckNum:'Truck #4',  driver:'Matthew'},
  // Add more here...
];
```

---

## Troubleshooting

**"Sheet tab not found"** — Make sure you created a tab named exactly `Dispatch` in your Google Sheet.

**"Auth error"** — Make sure you shared the sheet with `jamaya@valley-best-test.iam.gserviceaccount.com` as Editor.

**Drivers can't connect** — If using local network (Option A), make sure they're on the same WiFi. If deployed (Option B/C), check the URL is correct.

**Port already in use** — Change the port in server.js last line: `const PORT = 3001`
