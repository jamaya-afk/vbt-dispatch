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
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
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
  const trailer = (await call(mgr, 'POST', '/api/fleet/trailers', { number: '3B', type: 'Transfer' })).data.trailer;
  await call(mgr, 'POST', `/api/loads/${load.id}/assign`, { trailerId: trailer.id });
  await call(drv, 'POST', `/api/loads/${load.id}/trip-action`, { action: 'loaded', ticket: { source: 'supplier', number: '37432733', netTons: 23.2, photo: PNG } });
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

  await page.evaluate(() => goTab('fleet')); await page.waitForTimeout(600);
  chk('Drivers & Trucks lists trailers as their own table with 3B', await page.evaluate(() => { const el = document.getElementById('fleet-trailers'); return !!el && /Trailers/.test(el.innerText) && (el.querySelector('[data-trailer-id][data-field="number"]') || {}).value === '3B'; }), true);
  chk('no /api/sync call and no Google Sheets request from the app', requests.some(r => /\/api\/sync\b/.test(r)) || problems.some(p => /Google Sheets request/.test(p)), false);
  chk('History tab has no Sheets wording', await page.evaluate(() => { goTab('history'); return new Promise(r => setTimeout(() => r(/Sheets/i.test(document.getElementById('sec-history').innerText)), 600)); }), false);
  chk('Board topbar has no Sync button', await page.evaluate(() => { goTab('board'); return /Sync/.test(document.getElementById('topbar-actions').innerText); }), false);

  console.log('── New PO form: two steps, unique PO number, truck per load ──');
  await page.evaluate(() => goTab('board')); await page.waitForTimeout(300);
  await page.evaluate(() => openNewPO()); await page.waitForTimeout(500);
  let f = await page.evaluate(() => ({ open: document.getElementById('po-modal').style.display !== 'none', step2hidden: document.getElementById('po-body-2').style.display === 'none', date: document.getElementById('po-date').value, yard: document.getElementById('po-vendor').value }));
  chk('modal opens on step 1 with today and VBT yard preset', `${f.open} ${f.step2hidden} ${f.date === today} ${f.yard}`, 'true true true vbt');
  await page.fill('#po-number', '10482'); await page.waitForTimeout(500);
  chk('typing an existing PO number shows the message inline', /^PO #10482 already exists \(ABC Materials, .+\)\. Please enter a different PO number\.$/.test(await page.evaluate(() => document.getElementById('po-number-msg').innerText)), true);
  await page.fill('#po-customer', 'ABC Materials'); await page.evaluate(() => onPoCustomerInput('ABC Materials')); await page.waitForTimeout(400);
  chk('Next is refused while the number is a duplicate', await page.evaluate(() => { poStep(2); return document.getElementById('po-body-2').style.display === 'none'; }), true);
  await page.fill('#po-number', '10483'); await page.waitForTimeout(500);
  chk('   ...a free number is confirmed available', await page.evaluate(() => document.getElementById('po-number-msg').innerText), 'PO #10483 is available.');
  chk('jobsite picker lists the customer\'s previous address', await page.evaluate(() => Array.from(document.querySelectorAll('#po-jobsite option')).some(o => /500 Main St, Merced/.test(o.textContent))), true);
  await page.evaluate(() => { const sel = document.getElementById('po-jobsite'); sel.value = '0'; onPoJobsitePick('0'); });
  chk('   ...picking it fills address and city', await page.evaluate(() => document.getElementById('po-address').value + ' / ' + document.getElementById('po-city').value), '500 Main St / Merced');
  await page.evaluate(() => poStep(2)); await page.waitForTimeout(600);
  f = await page.evaluate(() => ({ step2: document.getElementById('po-body-2').style.display !== 'none', cards: document.querySelectorAll('.po-card').length, jobline: document.getElementById('po-jobline').innerText.replace(/\s+/g, ' ') }));
  chk('step 2 shows the job line and one load card', `${f.step2} ${f.cards}`, 'true 1');
  chk('   job line names PO, customer, site, yard', /PO 10483.*ABC Materials.*500 Main St, Merced.*Yard: VBT Yard/.test(f.jobline), true);
  await page.evaluate(() => { onSplitDriverChange(0, 'rigo'); });
  await page.waitForTimeout(600);
  f = await page.evaluate(() => ({ truck: splits[0].truckUnitId, drvOpt: document.querySelector('.po-card select option[value="beryle"]').textContent, money: document.getElementById('pricing-preview-0').innerText.replace(/\s+/g, ' '), summary: document.getElementById('po-summary').innerText.replace(/\s+/g, ' ') }));
  chk('choosing a driver pre-fills the usual truck', f.truck, 'truck-14');
  chk('driver list shows availability for that day', /Beryle — 1 load that day/.test(f.drvOpt), true);
  chk('card shows quantity in tons and money from the engine', /1 load × 25 t = 25 tons.*Rev.*Cost.*VBT internal.*Margin/.test(f.money), true);
  chk('summary bar totals loads, drivers and margin', /1 load · 25 tons 1 driver Revenue \$.*Margin/.test(f.summary), true);
  await page.evaluate(() => savePO()); await page.waitForTimeout(1200);
  const created = (await call(mgr, 'GET', '/api/data')).data;
  const np = created.pos.find(p => p.poNumber === '10483'); const nl = np && created.loads.find(l => l.poId === np.id);
  chk('Save creates the PO with driver and truck from the form', np && nl ? `${np.customer} ${nl.truckId} ${nl.truckUnitId}` : 'missing', 'ABC Materials rigo truck-14');
  chk('   modal closed', await page.evaluate(() => document.getElementById('po-modal').style.display), 'none');

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
  chk('   sheet offers an optional trailer step listing 3B', await page.evaluate(() => { const t = document.getElementById('qa-sheet-bg').innerText; return /4 · Trailer/i.test(t) && /3B/.test(t); }), true);
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
  chk('   card shows trailer, the current ticket and running actual tons', /Trailer 3B.*Ticket #37432733 · 23\.20 t.*Actual tons 23\.20 t from 1 ticket/.test(sel.card), true);
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
  // Finish trip 1 and bring trip 2 to the yard, so the phone shows the Loaded step.
  await call(drv, 'POST', `/api/loads/${load.id}/trip-action`, { action: 'arrived-jobsite' });
  await call(drv, 'POST', `/api/loads/${load.id}/trip-action`, { action: 'trip-complete' });
  await call(drv, 'POST', `/api/loads/${load.id}/trip-action`, { action: 'start-trip' });
  await call(drv, 'POST', `/api/loads/${load.id}/trip-action`, { action: 'arrived-pickup', yardId: 'vulcan' });
  const d = await session('beryle', 'beryle123', true);
  await d.page.waitForTimeout(2500);
  const dv = await d.page.evaluate(() => ({
    driverTab: getComputedStyle(document.getElementById('sec-driver')).display !== 'none',
    mapNav: Array.from(document.querySelectorAll('.nav-item')).filter(b => b.textContent.includes('Fleet Map') && getComputedStyle(b).display !== 'none').length,
    card: document.getElementById('driver-trips') ? document.getElementById('driver-trips').innerText.replace(/\s+/g, ' ') : document.getElementById('sec-driver').innerText.replace(/\s+/g, ' '),
    loadedBtn: Array.from(document.querySelectorAll('.trip-action')).map(b => b.innerText.trim()).find(t => /Loaded/.test(t)) || '',
  }));
  chk('driver view renders', dv.driverTab, true);
  chk('   driver cannot see the Fleet Map tab', dv.mapNav, 0);
  chk('   driver phone posted its own GPS', d.requests.some(r => r === 'POST /api/driver-location'), true);
  console.log('── Driver: Start day ──');
  chk('day card offers Start day before anything else', await d.page.evaluate(() => /Your day has not started/.test(document.getElementById('day-card').innerText)), true);
  await d.page.evaluate(() => openStartDay()); await d.page.waitForTimeout(400);
  let sd = await d.page.evaluate(() => ({ open: document.getElementById('startday-modal').style.display === 'flex', truck: document.getElementById('sd-truck').value, trailer: document.getElementById('sd-trailer').options.length, allok: document.getElementById('sd-allok').checked }));
  chk('Start day form: usual truck prefilled, trailer list, inspection defaults to all satisfactory', `${sd.open} ${sd.truck} ${sd.trailer > 1} ${sd.allok}`, 'true truck-2 true true');
  await d.page.fill('#sd-odo', '41000');
  await d.page.evaluate(() => submitStartDay()); await d.page.waitForTimeout(400);
  chk('   refused without a signature (no day created)', (await call(mgr, 'GET', '/api/today')).data.shifts.length, 0);
  await d.page.evaluate(() => { const c = document.getElementById('sd-sig'); const ctx = c.getContext('2d'); ctx.beginPath(); ctx.moveTo(20, 80); ctx.lineTo(200, 90); ctx.stroke(); sdSig.markInk(); });
  await d.page.evaluate(() => submitStartDay()); await d.page.waitForTimeout(1500);
  const shifts = (await call(mgr, 'GET', '/api/today')).data.shifts;
  chk('   day started: Beryle on Truck #12 at 41,000, inspection satisfactory, signed', shifts.length === 1 ? `${shifts[0].driverName} ${shifts[0].truckNum} ${shifts[0].startOdometer} ${shifts[0].inspection.satisfactory} ${shifts[0].inspection.hasSignature}` : 'none', 'Beryle Truck #2 41000 true true');
  chk('   day card now shows the open day with Break, Change truck, End day', await d.page.evaluate(() => { const t = document.getElementById('day-card').innerText.replace(/\s+/g, ' '); return /Day open · Truck #2/.test(t) && /Break/.test(t) && /Change truck/.test(t) && /End day/.test(t); }), true);
  console.log('── Driver: Loaded captures the ticket once ──');
  chk('card shows truck + trailer and the trip 1 ticket', /Rig Truck #12 \+ trailer 3B/i.test(dv.card) && /Load 1 · #37432733 supplier 23\.20 t/.test(dv.card), true);
  chk('the Loaded button asks for the ticket', dv.loadedBtn, 'Loaded — enter ticket');
  await d.page.evaluate(() => openLoadedForm(window._currentDispatch.find(l => l.trips && l.trips.length).loadId)); await d.page.waitForTimeout(300);
  let lf = await d.page.evaluate(() => ({ open: document.getElementById('loaded-modal').style.display === 'flex', src: loadedForm.source, srcBtn: document.getElementById('loaded-src-supplier').className }));
  chk('Loaded form opens; Vulcan pickup defaults to a supplier scale ticket', `${lf.open} ${lf.src} ${/primary/.test(lf.srcBtn)}`, 'true supplier true');
  await d.page.fill('#loaded-number', '37432733'); await d.page.waitForTimeout(700);
  chk('typing trip 1\'s number warns inline and names the owner', /already recorded on .* load 1 of 3, Beryle/.test(await d.page.evaluate(() => document.getElementById('loaded-number-msg').innerText)), true);
  await d.page.fill('#loaded-number', '37432799'); await d.page.waitForTimeout(700);
  chk('   a fresh number is confirmed free', await d.page.evaluate(() => document.getElementById('loaded-number-msg').innerText), 'Ticket #37432799 is not on file yet.');
  await d.page.fill('#loaded-tons', '23.19');
  const writesBeforeLoaded = d.requests.filter(r => r === `POST /api/loads/${load.id}/trip-action`).length;
  await d.page.evaluate(() => confirmLoaded()); await d.page.waitForTimeout(500);
  chk('confirm without a photo is refused on the phone (no request sent)', d.requests.filter(r => r === `POST /api/loads/${load.id}/trip-action`).length - writesBeforeLoaded, 0);
  await d.page.evaluate((png) => { loadedForm.photo = png; }, PNG);
  await d.page.evaluate(() => confirmLoaded()); await d.page.waitForTimeout(1800);
  const trip2 = (await call(mgr, 'GET', '/api/data')).data.loads.find(l => l.id === load.id);
  chk('confirm stamps Loaded with ticket 37432799 / 23.19 t on trip 2', `${trip2.trips[1].timestamps.loadedAt ? 'loaded' : 'not-loaded'} ${trip2.trips[1].ticket && trip2.trips[1].ticket.number} ${trip2.trips[1].ticket && trip2.trips[1].ticket.netTons} ${trip2.trips[1].ticket && trip2.trips[1].ticket.entry}`, 'loaded 37432799 23.19 typed');
  chk('   load-level photo came from trip 1, no second upload asked', !!(trip2.ticketImage || trip2.ticketImageUrl), true);
  console.log('── Driver: freight starts at the yard, finishes explicitly, then End day ──');
  await call(drv, 'POST', `/api/loads/${load.id}/trip-action`, { action: 'arrived-jobsite' });
  await call(drv, 'POST', `/api/loads/${load.id}/trip-action`, { action: 'trip-complete' });
  await call(drv, 'POST', `/api/loads/${load.id}/trip-action`, { action: 'start-trip' });
  await d.page.evaluate(() => renderDriver()); await d.page.waitForTimeout(1200);
  await d.page.evaluate(async () => { yardLoadId = window._currentDispatch[0].loadId; await confirmYard('vulcan'); }); await d.page.waitForTimeout(500);
  let fsm = await d.page.evaluate(() => ({ open: document.getElementById('freightstart-modal').style.display === 'flex', intro: document.getElementById('fs-intro').innerText.replace(/\s+/g, ' '), hint: document.getElementById('fs-odo-hint').innerText }));
  chk('first arrival with the day open asks for one odometer reading, naming the freight', `${fsm.open} ${/ABC Materials.*Vulcan → 500 Main St, Merced/.test(fsm.intro)} ${fsm.hint}`, 'true true Must be at least 41,000');
  chk('   nothing stamped yet', (await call(mgr, 'GET', '/api/data')).data.loads.find(l => l.id === load.id).trips[2].timestamps.arrivedPickup || 'none', 'none');
  await d.page.fill('#fs-odo', '41010'); await d.page.evaluate(() => submitFreightStart()); await d.page.waitForTimeout(1800);
  const segs = (await call(mgr, 'GET', '/api/freight-segments')).data.segments;
  chk('   segment opened at 41,010 for ABC Materials, Vulcan → Merced, trip stamped', segs.length === 1 ? `${segs[0].customer} ${segs[0].originName} ${segs[0].odStart} ${segs[0].status} ${segs[0].tripCount}` : `${segs.length} segments`, 'ABC Materials Vulcan 41010 open 1');
  chk('   day card shows the freight in progress with Finish freight', await d.page.evaluate(() => { const t = document.getElementById('day-card').innerText.replace(/\s+/g, ' '); return /Freight in progress/i.test(t) && /ABC Materials/.test(t) && /Finish freight — ABC Materials/.test(t); }), true);
  await call(drv, 'POST', `/api/loads/${load.id}/trip-action`, { action: 'loaded', ticket: { source: 'supplier', number: '37432862', netTons: 24.45, photo: PNG } });
  await call(drv, 'POST', `/api/loads/${load.id}/trip-action`, { action: 'arrived-jobsite' });
  await call(drv, 'POST', `/api/loads/${load.id}/trip-action`, { action: 'trip-complete' });
  await d.page.evaluate(() => renderDriver()); await d.page.waitForTimeout(1200);
  chk('   the last delivery did not close the freight', (await call(mgr, 'GET', '/api/freight-segments')).data.segments[0].status, 'open');
  await d.page.evaluate(() => openEndDay()); await d.page.waitForTimeout(300);
  chk('End day with freight open shows the segment and blocks the button', await d.page.evaluate(() => document.getElementById('ed-open-seg').style.display !== 'none' && /Freight segment still open/.test(document.getElementById('ed-open-seg').innerText) && document.getElementById('ed-save').disabled), true);
  await d.page.evaluate(() => closeEndDay());
  await d.page.evaluate(() => openFinishFreight(window._shiftInfo.shift.openSegment.id)); await d.page.waitForTimeout(300);
  chk('Finish freight asks the ending odometer with the start as the floor', await d.page.evaluate(() => document.getElementById('finishfreight-modal').style.display === 'flex' && /Must be at least 41,010/.test(document.getElementById('ff-odo-hint').innerText)), true);
  await d.page.fill('#ff-odo', '41050'); await d.page.evaluate(() => submitFinishFreight()); await d.page.waitForTimeout(1500);
  const closedSeg = (await call(mgr, 'GET', '/api/freight-segments')).data.segments[0];
  chk('   segment closed by the driver: 40 billable miles', `${closedSeg.status} ${closedSeg.billableMiles} ${closedSeg.closedBy}`, 'closed 40 beryle');
  await d.page.evaluate(() => openEndDay()); await d.page.waitForTimeout(300);
  await d.page.fill('#ed-odo', '41080'); await d.page.evaluate(() => submitEndDay()); await d.page.waitForTimeout(1500);
  const ended = (await call(mgr, 'GET', '/api/today')).data.shifts.find(x => x.driverId === 'beryle');
  chk('End day: 80 daily, 40 billable, 40 non-billable — derived', `${ended.status} ${ended.dailyMiles} ${ended.billableMiles} ${ended.nonBillableMiles}`, 'closed 80 40 40');
  chk('   day card says the day is closed with the miles, not "not started"', await d.page.evaluate(() => { const t = document.getElementById('day-card').innerText.replace(/\s+/g, ' '); return /Day closed · Truck #2/.test(t) && /80 miles today \(40 on freight\)/.test(t) && !/has not started/.test(t); }), true);
  chk('   Loaded modal closed, card lists all three tickets and the running total', await d.page.evaluate(() => { const t = document.getElementById('sec-driver').innerText.replace(/\s+/g, ' '); return document.getElementById('loaded-modal').style.display === 'none' && /#37432799 supplier 23\.19 t/.test(t) && /#37432862 supplier 24\.45 t/.test(t) && /Confirmed so far 70\.84 t/.test(t); }), true);
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
