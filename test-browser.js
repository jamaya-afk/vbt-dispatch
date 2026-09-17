#!/usr/bin/env node
// Browser test: drives the real app in headless Chromium as office and driver.
// Covers what curl cannot — the page renders, the Fleet Map draws real
// positions, selection stays in sync, refresh never reloads the page, and no
// JS error or failed API call happens anywhere.
//
//   npm i --no-save playwright-core        (once; not a project dependency)
//   PORT=4630 node server.js &  then  node test-browser.js
//   CHROME_EXE=/path/to/chrome  overrides the browser binary.
const B = process.env.BASE || `http://localhost:${process.env.PORT || 4630}`;
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch { console.error('playwright-core not installed: npm i --no-save playwright-core'); process.exit(2); }
const fs = require('fs');
function findChrome() {
  if (process.env.CHROME_EXE) return process.env.CHROME_EXE;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const cands = fs.existsSync(root) ? fs.readdirSync(root) : [];
  const shell = cands.find(d => d.startsWith('chromium_headless_shell'));
  if (shell) return `${root}/${shell}/chrome-linux/headless_shell`;
  const chrome = cands.find(d => d.startsWith('chromium-'));
  return chrome ? `${root}/${chrome}/chrome-linux/chrome` : undefined;
}

let PASS = 0, FAIL = 0;
const chk = (name, got, want) => { const ok = String(got) === String(want); ok ? PASS++ : FAIL++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — got '${got}' want '${want}'`}`); };

// Plain HTTP helpers (node fetch) with a cookie jar per user.
async function login(user, pass) {
  const r = await fetch(B + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `username=${user}&password=${pass}`, redirect: 'manual' });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
async function call(cookie, method, path, body) {
  const r = await fetch(B + path, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

(async () => {
  const exe = findChrome();
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const problems = [];
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

  // ── Fixture: a load for beryle, trip started, real GPS posted by beryle ──
  const mgr = await login('joshua', 'joshua123');
  const drv = await login('beryle', 'beryle123');
  await call(mgr, 'POST', '/api/pos', { po: { poNumber: '10482', customer: 'ABC Materials', deliveryDate: today, address: '500 Main St', city: 'Merced', plannedVendorId: 'vulcan' },
    splits: [{ truckId: 'beryle', truckUnitId: 'truck-12', material: '3/4 Rock', loadsAssigned: 3, vendorId: 'vulcan' }] });
  const data = (await call(mgr, 'GET', '/api/data')).data;
  const po = data.pos.find(p => p.poNumber === '10482');
  const load = data.loads.find(l => l.poId === po.id);
  await call(drv, 'POST', `/api/loads/${load.id}/trip-action`, { action: 'start-trip' });
  await call(drv, 'POST', '/api/driver-location', { lat: 36.7401, lng: -119.7701, accuracy: 9 });
  await call(drv, 'POST', `/api/loads/${load.id}/trip-action`, { action: 'arrived-pickup', yardId: 'vulcan' });
  await call(drv, 'POST', `/api/loads/${load.id}/trip-action`, { action: 'loaded' });
  await call(mgr, 'POST', '/api/_test/backdate-location', { driverId: 'beryle', seconds: 25 });
  await call(drv, 'POST', '/api/driver-location', { lat: 36.7420, lng: -119.7650, accuracy: 7 });

  async function session(user, pass, mobile) {
    const ctx = await browser.newContext(mobile
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 36.73, longitude: -119.78 }, permissions: ['geolocation'] }
      : { viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const requests = [];
    page.on('pageerror', e => problems.push(`[${user}] pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !/ERR_CERT_AUTHORITY_INVALID|net::ERR_/.test(m.text())) problems.push(`[${user}] console.error: ${m.text().slice(0, 160)}`); });
    page.on('request', r => { if (r.url().startsWith(B)) requests.push(`${r.method()} ${r.url().replace(B, '')}`); else if (/googleapis\.com\/(?!css)|sheets\.google/.test(r.url())) problems.push(`[${user}] Google Sheets request: ${r.url()}`); });
    page.on('response', r => { const u = r.url(); if (u.includes('/api/') && r.status() >= 400 && r.status() !== 202) problems.push(`[${user}] ${r.request().method()} ${u.replace(B, '')} -> ${r.status()}`); });
    await page.goto(B + '/login');
    await page.fill('input[name=username]', user);
    await page.fill('input[name=password]', pass);
    await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
    await page.waitForTimeout(1200);
    return { ctx, page, requests };
  }

  console.log('── Office: every tab renders ──');
  const { ctx, page, requests } = await session('joshua', 'joshua123', false);
  for (const t of ['today', 'board', 'approvals', 'pos', 'billing', 'quickbooks', 'reports', 'fleet', 'history', 'vendors']) {
    await page.evaluate(tab => goTab(tab), t);
    await page.waitForTimeout(500);
    const visible = await page.evaluate(tab => { const el = document.getElementById('sec-' + tab); return el ? getComputedStyle(el).display !== 'none' : null; }, t);
    chk(`tab ${t} visible`, visible, true);
  }

  chk('no /api/sync call and no Google Sheets request from the app', requests.some(r => /\/api\/sync\b/.test(r)) || problems.some(p => /Google Sheets request/.test(p)), false);
  chk('History tab has no Sheets wording', await page.evaluate(() => { goTab('history'); return new Promise(r => setTimeout(() => r(/Sheets/i.test(document.getElementById('sec-history').innerText)), 600)); }), false);
  chk('Board topbar has no Sync button', await page.evaluate(() => { goTab('board'); return /Sync/.test(document.getElementById('topbar-actions').innerText); }), false);

  console.log('── Office: drag/drop never assigns by itself ──');
  const writesBefore = requests.filter(r => /\/assign$|^PUT \/api\/loads\//.test(r)).length;
  await page.evaluate(() => goTab('board')); await page.waitForTimeout(400);
  const drop = await page.evaluate(async () => {
    const l = (loads || []).find(x => !x.locked); if (!l) return 'no-load';
    dragId = l.id; await onDrop({ preventDefault() {}, currentTarget: { classList: { remove() {} } } }, 'rigo');
    await new Promise(r => setTimeout(r, 500));
    return document.getElementById('qa-sheet-bg') ? `sheet-open driver=${qaPick && qaPick.driverId}` : 'no-sheet';
  });
  chk('drop opens the confirm sheet with the target preselected', drop, 'sheet-open driver=rigo');
  chk('no assignment written during the drop', requests.filter(r => /\/assign$|^PUT \/api\/loads\//.test(r)).length - writesBefore, 0);
  await page.evaluate(() => qaClose());

  console.log('── Fleet Map ──');
  const navCount = await page.evaluate(() => Array.from(document.querySelectorAll('.nav-item')).filter(b => b.textContent.includes('Fleet Map') && getComputedStyle(b).display !== 'none').length);
  chk('1. manager sees the Fleet Map tab', navCount, 1);
  const loadsBefore = await page.evaluate(() => performance.getEntriesByType('navigation').length);
  await page.evaluate(() => goTab('map'));
  await page.waitForFunction(() => window.L && fm.map && fm.data, null, { timeout: 15000 }).catch(() => problems.push('[joshua] map never initialised'));
  await page.waitForTimeout(800);
  const st = await page.evaluate(() => ({
    rows: document.querySelectorAll('.fm-row').length,
    markers: Object.keys(fm.markers).length,
    beryle: fm.markers.beryle ? fm.markers.beryle.getLatLng() : null,
    noGps: fm.data.trucks.filter(t => !t.gps).map(t => t.driverId),
    noGpsMarkers: fm.data.trucks.filter(t => !t.gps && fm.markers[t.driverId]).length,
    rowText: document.querySelector('[data-driver="beryle"]').innerText.replace(/\s+/g, ' '),
    offlineRows: Array.from(document.querySelectorAll('.fm-row.offline')).length,
    tiles: fm.map._layers && Object.values(fm.map._layers).some(l => l._url && l._url.includes('openstreetmap')),
  }));
  chk('4. five drivers listed', st.rows, 5);
  chk('5. live truck marker at its real GPS point', st.beryle && `${st.beryle.lat.toFixed(4)},${st.beryle.lng.toFixed(4)}`, '36.7420,-119.7650');
  chk('   one marker only (four drivers have no GPS)', st.markers, 1);
  chk('7. drivers without GPS have no marker (no fake position)', st.noGpsMarkers, 0);
  chk('   ...and are listed Offline · No GPS', st.offlineRows, 4);
  chk('   live row shows workflow status and age', /Loaded \/ En Route.*Updated \d+ sec ago/.test(st.rowText), true);
  chk('   OpenStreetMap tile layer present', st.tiles, true);

  // 8/9. selection sync + card content
  const trailReqBefore = requests.filter(r => r.includes('/track')).length;
  await page.evaluate(() => fmSelect('beryle', true));
  await page.waitForTimeout(900);
  const sel = await page.evaluate(() => ({
    rowSel: document.querySelector('.fm-row.sel')?.dataset.driver,
    markerSel: document.querySelector('.fm-marker.sel')?.dataset.marker,
    card: document.getElementById('fm-card').innerText.replace(/\s+/g, ' '),
    center: fm.map.getCenter(),
  }));
  chk('8. list click selects the row', sel.rowSel, 'beryle');
  chk('   ...and highlights the marker', sel.markerSel, 'beryle');
  chk('   ...and centers the map on it', `${sel.center.lat.toFixed(3)},${sel.center.lng.toFixed(3)}`, '36.742,-119.765');
  chk('9. card shows PO / customer / material / load / trip / pickup / destination',
    /PO 10482.*Customer ABC Materials.*Material 3\/4 Rock.*Load 1 of 3.*Trip 1.*Pickup Vulcan.*Destination 500 Main St, Merced/.test(sel.card), true);
  chk('   card shows GPS accuracy and update time', /GPS accuracy ±7 m/.test(sel.card) && /Updated/.test(sel.card), true);
  // marker click → same selection state
  await page.evaluate(() => fmSelect('rigo', true));
  await page.evaluate(() => { fm.markers.beryle.fire('click'); });
  await page.waitForTimeout(300);
  chk('   marker click selects the same row in the list', await page.evaluate(() => document.querySelector('.fm-row.sel')?.dataset.driver), 'beryle');

  // 10/11. trail
  const trailReqs = requests.filter(r => r.includes('/track')).slice(trailReqBefore);
  chk('10. trail requested for the selected load only', trailReqs.every(r => r === `GET /api/loads/${load.id}/track`) && trailReqs.length >= 1, true);
  // Trail points live in Postgres; in file mode /track answers with a note and no rows.
  const trackProbe = (await call(mgr, 'GET', `/api/loads/${load.id}/track`)).data;
  const hasHistory = !trackProbe.note;
  if (hasHistory) chk('    trail drawn from the current trip points', await page.evaluate(() => fm.trail ? fm.trail.getLatLngs().length : 0), 2);
  else console.log('  SKIP  trail geometry (server has no Postgres — run against a DATABASE_URL server to cover it)');
  chk('11. no all-day driver trail requested', requests.some(r => /driver-locations\/|\/drivers\/[^/]+\/(track|history|trail)/.test(r)), false);

  // 12. refresh moves the marker in place, no reload
  await call(mgr, 'POST', '/api/_test/backdate-location', { driverId: 'beryle', seconds: 25 });
  await call(drv, 'POST', '/api/driver-location', { lat: 36.7500, lng: -119.7500, accuracy: 6 });
  await page.evaluate(() => refreshFleetMap());
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => ({ pos: fm.markers.beryle.getLatLng(), navs: performance.getEntriesByType('navigation').length, refreshes: fm.refreshes, trail: fm.trail ? fm.trail.getLatLngs().length : 0 }));
  chk('12. refresh moved the marker to the new point', `${after.pos.lat.toFixed(4)},${after.pos.lng.toFixed(4)}`, '36.7500,-119.7500');
  chk('    ...without a page reload', after.navs, loadsBefore);
  if (hasHistory) chk('    ...trail grew with the trip', after.trail, 3);

  // Step 4: pickup yard + jobsite coordinates around the selected truck
  console.log('── Fleet Map: Truck → Pickup → Jobsite ──');
  const gcBefore = (await call(mgr, 'GET', '/api/_test/geocode-calls')).data.calls;
  let places = await page.evaluate(() => ({ pins: document.querySelectorAll('.fm-place').length, lines: fm.places.length }));
  chk('no coordinates → no pickup/jobsite pins, no invented markers', places.pins, 0);
  await call(mgr, 'PUT', '/api/vendors/vulcan/location', { lat: 36.6900, lng: -119.7300 });   // only pickup
  await page.evaluate(() => refreshFleetMap()); await page.waitForTimeout(700);
  places = await page.evaluate(() => ({ pickup: !!document.querySelector('.fm-place.pickup'), jobsite: !!document.querySelector('.fm-place.jobsite'), chain: fm.places.length, card: document.getElementById('fm-card').innerText.replace(/\s+/g, ' ') }));
  chk('only pickup coordinates → pickup pin, no jobsite pin', `${places.pickup} ${places.jobsite}`, 'true false');
  chk('   card names the jobsite without coordinates', /Destination 500 Main St, Merced \(no coordinates\)/.test(places.card), true);
  await call(mgr, 'PUT', `/api/pos/${po.id}/location`, { lat: 37.3022, lng: -120.4830 });
  await page.evaluate(() => refreshFleetMap()); await page.waitForTimeout(700);
  places = await page.evaluate(() => {
    const line = fm.places.find(x => x.getLatLngs);
    return { pickup: !!document.querySelector('.fm-place.pickup'), jobsite: !!document.querySelector('.fm-place.jobsite'), chain: line ? line.getLatLngs().map(p => `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`).join(' > ') : '', card: document.getElementById('fm-card').innerText.replace(/\s+/g, ' ') };
  });
  chk('both → pickup and jobsite pins', `${places.pickup} ${places.jobsite}`, 'true true');
  chk('Truck → Pickup → Jobsite chain drawn in that order', places.chain, '36.750,-119.750 > 36.690,-119.730 > 37.302,-120.483');
  chk('   card marks both as located', /Pickup Vulcan 📍.*Destination 500 Main St, Merced 📍/.test(places.card), true);
  await call(mgr, 'PUT', '/api/vendors/vulcan/location', { clear: true });
  await page.evaluate(() => refreshFleetMap()); await page.waitForTimeout(700);
  places = await page.evaluate(() => { const line = fm.places.find(x => x.getLatLngs); return { pickup: !!document.querySelector('.fm-place.pickup'), jobsite: !!document.querySelector('.fm-place.jobsite'), n: line ? line.getLatLngs().length : 0 }; });
  chk('only jobsite coordinates → jobsite pin, chain Truck → Jobsite', `${places.pickup} ${places.jobsite} ${places.n}`, 'false true 2');
  chk('map refreshes never called the geocoder', (await call(mgr, 'GET', '/api/_test/geocode-calls')).data.calls - gcBefore, 0);
  chk('no geocode request left the browser', requests.some(r => /geocod/i.test(r)), false);

  // 6. stale → Offline, grey, last-known kept
  await call(mgr, 'POST', '/api/_test/backdate-location', { driverId: 'beryle', seconds: 301 });
  await page.evaluate(() => refreshFleetMap());
  await page.waitForTimeout(600);
  const stale = await page.evaluate(() => ({
    row: document.querySelector('[data-driver="beryle"]').innerText.replace(/\s+/g, ' '),
    rowOffline: document.querySelector('[data-driver="beryle"]').classList.contains('offline'),
    markerOffline: !!document.querySelector('.fm-marker[data-marker="beryle"].offline'),
    still: !!fm.markers.beryle,
    card: document.getElementById('fm-card').innerText.replace(/\s+/g, ' '),
  }));
  chk('6. stale GPS → row says Offline with last-seen age', /Offline · was Loaded \/ En Route.*Last seen 5 min ago/.test(stale.row), true);
  chk('   ...row and marker greyed', stale.rowOffline && stale.markerOffline, true);
  chk('   ...last known location still on the map', stale.still, true);
  chk('   ...card keeps the workflow stage', /Stage Loaded \/ En Route/.test(stale.card), true);
  await ctx.close();

  console.log('── Driver: phone view, no fleet access ──');
  const d = await session('beryle', 'beryle123', true);
  await d.page.waitForTimeout(2500);
  const dv = await d.page.evaluate(() => ({
    driverTab: getComputedStyle(document.getElementById('sec-driver')).display !== 'none',
    mapNav: Array.from(document.querySelectorAll('.nav-item')).filter(b => b.textContent.includes('Fleet Map') && getComputedStyle(b).display !== 'none').length,
  }));
  chk('driver view renders', dv.driverTab, true);
  chk('   driver cannot see the Fleet Map tab', dv.mapNav, 0);
  chk('   driver phone posted its own GPS', d.requests.some(r => r === 'POST /api/driver-location'), true);
  await d.ctx.close();
  // Access probes with the driver's own session cookie (outside the page, so
  // the page's console stays clean of expected 403s).
  chk('2. driver gets 403 from /api/fleet/live', (await call(drv, 'GET', '/api/fleet/live')).status, 403);
  chk('   driver cannot read other drivers\' locations', (await call(drv, 'GET', '/api/driver-locations')).status, 403);
  chk('   driver cannot read a trail', (await call(drv, 'GET', `/api/loads/${load.id}/track`)).status, 403);
  const expected403 = /^$/;

  console.log('── Anonymous ──');
  chk('3. anonymous gets 403 from /api/fleet/live', (await fetch(B + '/api/fleet/live')).status, 403);

  await browser.close();
  const real = [...new Set(problems)].filter(p => !expected403.test(p));
  chk('13. no JavaScript errors', real.filter(p => /pageerror|console.error/.test(p)).length, 0);
  chk('14. no failed API calls', real.filter(p => /->/.test(p)).length, 0);
  if (real.length) console.log('  problems:\n    ' + real.join('\n    '));
  console.log(`\n════ browser: ${PASS} passed, ${FAIL} failed ════`);
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('browser test failed:', e); process.exit(2); });
