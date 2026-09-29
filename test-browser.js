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
let expectConflict = false;   // a test that deliberately provokes a 409 conflict sets this
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
    // The app must never fall back to the browser's own confirm(); count any call.
    await page.addInitScript(() => { window.__confirmCalls = 0; const orig = window.confirm.bind(window); window.confirm = (...a) => { window.__confirmCalls++; return orig(...a); }; window.__promptCalls = 0; const op = window.prompt.bind(window); window.prompt = (...a) => { window.__promptCalls++; return op(...a); }; });
    const requests = [];
    page.on('pageerror', e => problems.push(`[${user}] pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !/ERR_CERT_AUTHORITY_INVALID|net::ERR_/.test(m.text()) && !(expectConflict && /409/.test(m.text()))) problems.push(`[${user}] console.error: ${m.text().slice(0, 160)}`); });
    page.on('request', r => { if (r.url().startsWith(B)) requests.push(`${r.method()} ${r.url().replace(B, '')}`); else if (/googleapis\.com\/(?!css)|sheets\.google/.test(r.url())) problems.push(`[${user}] Google Sheets request: ${r.url()}`); });
    page.on('response', r => { const u = r.url(); if (u.includes('/api/') && r.status() >= 400 && r.status() !== 202 && !(expectConflict && r.status() === 409)) problems.push(`[${user}] ${r.request().method()} ${u.replace(B, '')} -> ${r.status()}`); });
    await page.goto(B + '/login');
    await page.fill('input[name=username]', user);
    await page.fill('input[name=password]', pass);
    await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
    await page.waitForTimeout(1200);
    return { ctx, page, requests };
  }

  console.log('── Office: every tab renders ──');
  const { ctx, page, requests } = await session('joshua', 'joshua123', false);
  for (const t of ['today', 'approvals', 'pos', 'billing', 'quickbooks', 'reports', 'fleet', 'history', 'vendors']) {
    await page.evaluate(tab => goTab(tab), t);
    await page.waitForTimeout(500);
    const visible = await page.evaluate(tab => { const el = document.getElementById('sec-' + tab); return el ? getComputedStyle(el).display !== 'none' : null; }, t);
    chk(`tab ${t} visible`, visible, true);
  }

  await page.evaluate(() => goTab('fleet')); await page.waitForTimeout(600);
  chk('Drivers & Trucks lists trailers as their own table with 3B', await page.evaluate(() => { const el = document.getElementById('fleet-trailers'); return !!el && /Trailers/.test(el.innerText) && (el.querySelector('[data-trailer-id][data-field="number"]') || {}).value === '3B'; }), true);
  chk('no /api/sync call and no Google Sheets request from the app', requests.some(r => /\/api\/sync\b/.test(r)) || problems.some(p => /Google Sheets request/.test(p)), false);
  chk('History tab has no Sheets wording', await page.evaluate(() => { goTab('history'); return new Promise(r => setTimeout(() => r(/Sheets/i.test(document.getElementById('sec-history').innerText)), 600)); }), false);
  chk('Dispatch topbar has no Sync button', await page.evaluate(() => { goTab('today'); return /Sync/.test(document.getElementById('topbar-actions').innerText); }), false);

  console.log('── New PO form: two steps, unique PO number, truck per load ──');
  await page.evaluate(() => goTab('today')); await page.waitForTimeout(300);
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
  await page.evaluate(() => goTab('today')); await page.waitForTimeout(400);
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

  console.log('── Office: a conflict is decided in the app, never in a browser confirm ──');
  // Beryle is mid-haul on PO 10482; putting Rigo's load (PO 10483) on Beryle collides.
  expectConflict = true;
  const assignsBefore = requests.filter(r => /\/assign$/.test(r)).length;
  await page.evaluate(id => qaOpen(id), nl.id); await page.waitForTimeout(500);
  const dlg = await page.evaluate(async () => {
    qaSet('driverId', 'beryle');
    qaConfirm();                                   // resolves only once the dialog is answered
    await new Promise(r => setTimeout(r, 800));
    const m = document.getElementById('conflict-modal'); if (!m) return null;
    return { title: m.querySelector('h2').textContent.trim(), items: Array.from(m.querySelectorAll('li')).map(e => e.textContent).join(' | '),
             buttons: Array.from(m.querySelectorAll('.modal-foot button')).map(b => b.textContent.trim()).join('|'), focus: document.activeElement && document.activeElement.id, nativeConfirmUsed: window.__confirmCalls || 0 };
  });
  chk('1. a 409 opens the in-app dialog, titled for what collides', dlg ? dlg.title : 'no dialog', 'Driver Already Assigned');
  chk('   …naming exactly what collides', !!dlg && /Beryle is already mid-haul on .*PO 10482/.test(dlg.items), true);
  chk('   …with Cancel and Reassign, Cancel focused', dlg ? `${dlg.buttons} ${dlg.focus}` : 'no dialog', 'Cancel|Reassign conflict-cancel');
  await page.click('#conflict-cancel'); await page.waitForTimeout(500);
  let cfAfter = (await call(mgr, 'GET', '/api/data')).data.loads.find(l => l.id === nl.id);
  chk('2. Cancel: dialog gone, sheet still open, no error toast, one request only, load untouched',
    await page.evaluate(() => `${!document.getElementById('conflict-modal')} ${!!document.getElementById('qa-sheet-bg')} ${document.querySelectorAll('.toast.error').length}`) + ` ${requests.filter(r => /\/assign$/.test(r)).length - assignsBefore} ${cfAfter.truckId}`, 'true true 0 1 rigo');
  await page.evaluate(() => { qaConfirm(); }); await page.waitForTimeout(600);
  await page.fill('#conflict-reason', 'Rigo went home sick');
  await page.click('#conflict-go'); await page.waitForTimeout(1000);
  cfAfter = (await call(mgr, 'GET', '/api/data')).data.loads.find(l => l.id === nl.id);
  const cfAudit = ((await call(mgr, 'GET', '/api/audit-log?action=quick-assigned-load')).data.entries || []).find(e => e.target === nl.id && e.details && e.details.conflictsOverridden);
  chk('3. Reassign with a reason: the load moves, sheet and dialog close, the override is audited with the reason',
    `${cfAfter.truckId} ${await page.evaluate(() => !document.getElementById('qa-sheet-bg') && !document.getElementById('conflict-modal'))} ${cfAudit ? cfAudit.details.conflictsOverridden.types + ' / ' + cfAudit.details.conflictsOverridden.reason : 'no-cfAudit'}`, 'beryle true driver-busy / Rigo went home sick');
  chk('   the browser\'s own confirm() was never called', await page.evaluate(() => window.__confirmCalls || 0), 0);
  expectConflict = false;
  await call(mgr, 'POST', `/api/loads/${nl.id}/assign`, { driverId: 'rigo' });   // back to Rigo for the rest of the run
  await page.waitForTimeout(300);

  console.log('── Office: the dispatch board is the command center ──');
  await page.evaluate(() => goTab('today')); await page.waitForTimeout(700);
  const board = await page.evaluate(() => {
    const tiles = Array.from(document.querySelectorAll('#db-tiles .db-tile .l')).map(e => e.textContent.trim());
    const row = id => (document.querySelector(`.db-drv[data-driverid="${id}"]`) || {}).innerText || '';
    const cards = Array.from(document.querySelectorAll('#db-loads .qa-card'));
    const abc = cards.find(c => /PO 10482/.test(c.innerText));
    return {
      landed: document.getElementById('sec-today').classList.contains('active') && document.getElementById('page-title').textContent,
      noBoardTab: !document.querySelector('[data-tab="board"]'),
      tiles,
      beryle: row('beryle').replace(/\s+/g, ' '),
      rigo: row('rigo').replace(/\s+/g, ' '),
      leonardo: row('leonardo').replace(/\s+/g, ' '),
      abc: abc ? abc.innerText.replace(/\s+/g, ' ') : 'missing',
      abcButtons: abc ? Array.from(abc.querySelectorAll('button')).map(b => b.textContent.trim()) : [],
      truck12: Array.from(document.querySelectorAll('.db-truck')).map(e => e.innerText.replace(/\s+/g, ' ')).find(t => /#12/.test(t)) || '',
    };
  });
  chk('1. the office lands on Dispatch, and there is no second Board tab', `${board.landed} ${board.noBoardTab}`, 'Dispatch true');
  chk('2. the attention row names what needs a person', board.tiles.join('|'), 'Unassigned|In Progress|Awaiting Approval|Ready to Bill|Missing Info|Trucks Free|Drivers Free');
  chk('3. Beryle\'s row: in progress on Truck #12, ABC Materials, loaded en route, Vulcan → 500 Main St', /Beryle In progress Truck #12.*ABC Materials · PO 10482 · Loaded \/ en route · 0\/3.*Vulcan → 500 Main St, Merced/i.test(board.beryle), true);
  chk('4. Rigo\'s row: assigned on Truck #14 from the New PO form', /Rigo Assigned Truck #14.*ABC Materials · PO 10483 · Assigned · 0\/1.*VBT Yard → 500 Main St, Merced/i.test(board.rigo), true);
  chk('5. Leonardo\'s row: available, usual truck, invitation to assign', /Leonardo Available Truck #12 \(usual\).*No load today/i.test(board.leonardo), true);
  chk('6. the load card shows driver, truck, pickup → destination, progress and stage', /ABC Materials PO 10482.*Vulcan → 500 Main St, Merced Driver Beryle Truck #12 3\/4 Rock · 0\/3 loads Loaded \/ en route/.test(board.abc), true);
  chk('   …with Reassign and Details, nothing else', board.abcButtons.join('|'), 'Reassign|Details');
  chk('7. the truck strip says who has Truck #12', board.truck12, 'Truck #12 · Beryle');
  const filt = await page.evaluate(async () => {
    dbTile('in-progress'); await new Promise(r => setTimeout(r, 100));
    const shown = Array.from(document.querySelectorAll('#db-loads .qa-card .qa-chip')).map(e => e.textContent.trim());
    dbSetFilter('all');
    dbTile('awaiting-approval'); await new Promise(r => setTimeout(r, 300));
    const tab = (document.querySelector('.section.active') || {}).id;
    goTab('today'); await new Promise(r => setTimeout(r, 500));
    return { shown: [...new Set(shown)].join('|'), tab };
  });
  chk('8. the In Progress tile filters the board to in-progress loads', filt.shown, 'In Progress');
  chk('9. the Awaiting Approval tile opens Approvals', filt.tab, 'sec-approvals');

  console.log('── Office: approval confirms the record in the app ──');
  // Matthew (Truck #4) and Carlos (Truck #2B) each finish one load from the VBT yard and submit.
  const mat = await login('matthew', 'matthew123'); const car = await login('carlos', 'carlos123');
  await call(mgr, 'POST', '/api/pos', { po: { poNumber: '10484', customer: 'Gate Rd Builders', deliveryDate: today, address: '9 Gate Rd', city: 'Fresno', plannedVendorId: 'vbt' },
    splits: [{ truckId: 'matthew', truckUnitId: 'truck-4', material: 'Dirt', loadsAssigned: 1, vendorId: 'vbt' }, { truckId: 'carlos', truckUnitId: 'truck-2b', material: 'Dirt', loadsAssigned: 1, vendorId: 'vbt' }] });
  const d84 = (await call(mgr, 'GET', '/api/data')).data; const p84 = d84.pos.find(p => p.poNumber === '10484');
  const lMat = d84.loads.find(l => l.poId === p84.id && l.truckId === 'matthew'); const lCar = d84.loads.find(l => l.poId === p84.id && l.truckId === 'carlos');
  for (const [ck, l, n] of [[mat, lMat, '5001'], [car, lCar, '5002']]) {
    await call(ck, 'POST', `/api/loads/${l.id}/trip-action`, { action: 'start-trip' });
    await call(ck, 'POST', `/api/loads/${l.id}/trip-action`, { action: 'arrived-pickup', yardId: 'vbt' });
    await call(ck, 'POST', `/api/loads/${l.id}/trip-action`, { action: 'loaded', ticket: { source: 'vbt', number: n, netTons: 24.5, photo: PNG } });
    await call(ck, 'POST', `/api/loads/${l.id}/trip-action`, { action: 'arrived-jobsite' });
    await call(ck, 'POST', `/api/loads/${l.id}/trip-action`, { action: 'trip-complete' });
    await call(ck, 'PUT', `/api/loads/${l.id}`, { pod: { signedBy: 'Site Foreman', signature: PNG, signedAt: new Date().toISOString() } });
    await call(ck, 'POST', `/api/loads/${l.id}/trip-action`, { action: 'delivered' });
  }
  await page.evaluate(async () => { await loadAll(); goTab('approvals'); }); await page.waitForTimeout(600);
  const card = await page.evaluate(() => {
    const c = Array.from(document.querySelectorAll('.approve-mini')).find(x => /Matthew/.test(x.innerText)); if (!c) return null;
    return { chips: Array.from(c.querySelectorAll('.am-check .chk')).map(e => e.innerText.replace(/\s+/g, ' ').trim()).join(' | '), warn: c.querySelectorAll('.am-check .chk.warn').length, cards: document.querySelectorAll('.approve-mini').length };
  });
  chk('1. the approval card shows the checklist: Driver, Truck, Pickup yard, Ticket, Delivery — all ✓', card ? card.chips : 'no card', '✓ Driver Matthew | ✓ Truck Truck #4 | ✓ Pickup yard VBT Yard | ✓ Ticket 1 ticket · 24.5 t | ✓ Delivery 1/1 load · signed by Site Foreman');
  chk('   two loads wait, nothing flagged', card ? `${card.cards} ${card.warn}` : 'no card', '2 0');
  const dlg2 = await page.evaluate(async () => {
    const c = Array.from(document.querySelectorAll('.approve-mini')).find(x => /Matthew/.test(x.innerText));
    c.querySelector('button.btn.success').click();
    await new Promise(r => setTimeout(r, 400));
    const m = document.getElementById('ask-modal'); if (!m) return null;
    return { title: m.querySelector('h2').textContent.trim(), rows: m.querySelectorAll('.ask-check .chk').length, ok: m.querySelectorAll('.ask-check .chk.ok').length,
             hint: m.querySelector('.conflict-hint').innerText.replace(/\s+/g, ' '), buttons: Array.from(m.querySelectorAll('.modal-foot button')).map(b => b.textContent.trim()).join('|'), focus: document.activeElement && document.activeElement.id };
  });
  chk('2. Approve opens the confirmation with the five items and what approving does', dlg2 ? `${dlg2.title} ${dlg2.rows} ${dlg2.ok} ${dlg2.buttons} ${dlg2.focus}` : 'no dialog', 'Approve this load? 5 5 Cancel|Approve ask-cancel');
  chk('   …in plain words', !!dlg2 && /Everything is on record\. Approving locks the load and moves it to Ready to Bill\./.test(dlg2.hint), true);
  await page.click('#ask-cancel'); await page.waitForTimeout(400);
  let lm = (await call(mgr, 'GET', '/api/data')).data.loads.find(l => l.id === lMat.id);
  chk('3. Cancel: nothing approved', `${await page.evaluate(() => !document.getElementById('ask-modal'))} ${lm.approvalStatus}`, 'true submitted');
  await page.evaluate(() => Array.from(document.querySelectorAll('.approve-mini')).find(x => /Matthew/.test(x.innerText)).querySelector('button.btn.success').click()); await page.waitForTimeout(400);
  await page.click('#ask-go'); await page.waitForTimeout(900);
  lm = (await call(mgr, 'GET', '/api/data')).data.loads.find(l => l.id === lMat.id);
  chk('4. Approve: approved, locked, Ready to Bill; the card is gone', `${lm.approvalStatus} ${lm.locked} ${lm.billStatus} ${await page.evaluate(() => document.querySelectorAll('.approve-mini').length)}`, 'approved true ready 1');
  const rej = await page.evaluate(async () => {
    const c = Array.from(document.querySelectorAll('.approve-mini')).find(x => /Carlos/.test(x.innerText));
    c.querySelector('button.btn.danger').click();
    await new Promise(r => setTimeout(r, 400));
    const m = document.getElementById('ask-modal'); if (!m) return null;
    return { title: m.querySelector('h2').textContent.trim(), goDisabled: m.querySelector('#ask-go').disabled, focus: document.activeElement && document.activeElement.id };
  });
  chk('5. Reject asks for a reason in the app, and cannot proceed without one', rej ? `${rej.title} ${rej.goDisabled} ${rej.focus}` : 'no dialog', 'Reject this load? true ask-reason');
  await page.fill('#ask-reason', 'Ticket photo is unreadable'); await page.click('#ask-go'); await page.waitForTimeout(800);
  const lc = (await call(mgr, 'GET', '/api/data')).data.loads.find(l => l.id === lCar.id);
  chk('   …the load goes back to the driver with the reason', `${lc.approvalStatus} ${lc.locked} ${lc.rejectReason}`, 'rejected false Ticket photo is unreadable');
  chk('   no browser confirm() or prompt() anywhere in this', await page.evaluate(() => `${window.__confirmCalls || 0} ${window.__promptCalls || 0}`), '0 0');
  await page.evaluate(() => goTab('today')); await page.waitForTimeout(500);

  console.log('── Office: Edit PO — the order changes, the work follows where it can ──');
  // A fresh order for Leonardo (Truck #2, nothing hauled), edited from the PO card.
  await call(mgr, 'POST', '/api/pos', { po: { poNumber: '10485', customer: 'Gate Rd Builders', deliveryDate: today, address: '9 Gate Rd', city: 'Fresno', plannedVendorId: 'vbt' },
    splits: [{ truckId: 'leonardo', truckUnitId: 'truck-2', material: 'Dirt', loadsAssigned: 1, vendorId: 'vbt' }] });
  const d85 = (await call(mgr, 'GET', '/api/data')).data; const p85 = d85.pos.find(p => p.poNumber === '10485'); const l85 = d85.loads.find(l => l.poId === p85.id);
  await page.evaluate(async () => { await loadAll(); goTab('pos'); }); await page.waitForTimeout(500);
  const pe = await page.evaluate(async () => {
    const card = Array.from(document.querySelectorAll('#pos-content .qa-card')).find(c => /10485/.test(c.innerText));
    const btn = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === 'Edit PO');
    if (!btn) return null; btn.click(); await new Promise(r => setTimeout(r, 300));
    const m = document.getElementById('poedit-modal'); if (!m) return null;
    return { title: m.querySelector('h2').textContent.trim(), frozen: !!m.querySelector('.pe-frozen'), follow: m.querySelector('.pe-follow').innerText.replace(/\s+/g, ' '),
             number: document.getElementById('pe-number').value, disabled: document.getElementById('pe-number').disabled, yard: document.getElementById('pe-yard').value };
  });
  chk('1. Edit PO opens from the PO card with the order\'s fields, nothing frozen', pe ? `${pe.title} ${pe.frozen} ${pe.number} ${pe.disabled} ${pe.yard}` : 'no modal', 'Edit PO 10485 · Gate Rd Builders false 10485 false vbt');
  chk('   …and says what will follow', !!pe && /1 load on this PO\. 1 can still follow a date, customer-price or yard change/.test(pe.follow), true);
  const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  await page.fill('#pe-date', tomorrow); await page.fill('#pe-notes', 'Gate code 4471'); await page.fill('#pe-reason', 'customer pushed the pour a day');
  await page.click('#pe-save'); await page.waitForTimeout(900);
  const d85b = (await call(mgr, 'GET', '/api/data')).data; const p85b = d85b.pos.find(p => p.id === p85.id); const l85b = d85b.loads.find(l => l.id === l85.id);
  chk('2. Save: the PO and its operational load move to tomorrow with the reason; notes saved; modal closed',
    `${p85b.deliveryDate === tomorrow} ${l85b.deliveryDate === tomorrow} ${(l85b.moveHistory || [{}])[0].reason} ${p85b.notes} ${await page.evaluate(() => !document.getElementById('poedit-modal'))}`, 'true true customer pushed the pour a day Gate code 4471 true');
  chk('   the confirmation says what followed', /PO 10485 saved · 1 load moved to /.test(await page.evaluate(() => Array.from(document.querySelectorAll('.toast')).map(t => t.textContent).join(' | '))), true);
  await page.evaluate(id => openEditPO(id), p85.id); await page.waitForTimeout(300);
  await page.click('#poedit-modal .pe-add summary'); await page.waitForTimeout(200);
  await page.selectOption('#pe-al-driver', 'matthew'); await page.waitForTimeout(150);
  chk('3. Add load: choosing the driver pre-fills their usual truck', await page.evaluate(() => document.getElementById('pe-al-truck').value), 'truck-4');
  await page.selectOption('#pe-al-material', 'Dirt'); await page.fill('#pe-al-loads', '2');
  await page.click('#pe-al-go'); await page.waitForTimeout(900);
  const d85c = (await call(mgr, 'GET', '/api/data')).data; const added = d85c.loads.filter(l => l.poId === p85.id && l.id !== l85.id);
  chk('   …the load is on the same order, on its current date, with the form\'s driver, truck and count', added.length === 1 ? `${added[0].truckId} ${added[0].truckUnitId} ${added[0].loadsAssigned} ${added[0].deliveryDate === tomorrow} ${added[0].vendorId}` : `added ${added.length}`, 'matthew truck-4 2 true vbt');
  chk('   the modal reopened with the new count', await page.evaluate(() => ((document.querySelector('#poedit-modal .pe-follow') || {}).innerText || '').replace(/\s+/g, ' ').startsWith('2 loads on this PO.')), true);
  await page.evaluate(() => closeEditPO()); await page.evaluate(() => goTab('today')); await page.waitForTimeout(500);

  console.log('── Office: billing shows the money and the state machine; manual billing is guarded ──');
  // Matthew's approved load (PO 10484) is the one load in Ready to Bill: 1 load × 25 t × $25.
  await page.evaluate(async () => { await loadAll(); goTab('billing'); }); await page.waitForTimeout(900);
  const bvis = await page.evaluate(() => {
    const steps = Array.from(document.querySelectorAll('#bill-filters .bill-flow .bf-step')).map(s => `${s.querySelector('.bf-l').textContent}${s.classList.contains('active') ? '*' : ''}:${s.querySelector('.bf-n').textContent}`);
    const row = document.querySelector('#bill-list tbody tr');
    return { steps: steps.join(' → '), amount: row ? row.querySelector('.bill-amt').innerText.replace(/\s+/g, ' ').trim() : 'no row', total: (document.getElementById('bill-shown-total') || {}).innerText, sel: document.getElementById('bill-sel-total').innerText };
  });
  chk('1. the strip reads Submitted → Approved → Ready to Bill → Billed → Archived, with live counts, Ready active', bvis.steps, 'Submitted:0 → Approved:1 → Ready to Bill*:1 → Billed:0 → Archived:⌁');
  chk('2. the Ready to Bill table prices each load and totals the page', `${bvis.amount} | ${bvis.total} | ${bvis.sel}`, '$625.00 $25/ton | $625.00 | ');
  await page.click('#bill-list tbody tr input[type=checkbox]'); await page.waitForTimeout(200);
  chk('   selecting shows the selected total next to the actions', await page.evaluate(() => document.getElementById('bill-sel-total').innerText.replace(/\s+/g, ' ')), 'Selected: 1 · $625.00');
  await page.click('#mark-billed-btn'); await page.waitForTimeout(400);
  const mb = await page.evaluate(() => { const m = document.getElementById('ask-modal'); return m ? `${m.querySelector('h2').textContent.trim()} | ${m.querySelector('#ask-go').disabled} | ${m.querySelector('.ask-sub').innerText.replace(/\s+/g, ' ')}` : 'no dialog'; });
  chk('3. Mark Billed (manual) asks for the invoice reference in the app and cannot proceed without it', mb, 'Mark billed outside QuickBooks? | true | 1 load · $625.00');
  await page.fill('#ask-reason', 'INV-7 (paper)'); await page.click('#ask-go'); await page.waitForTimeout(900);
  let lm2 = (await call(mgr, 'GET', '/api/data')).data.loads.find(l => l.id === lMat.id);
  chk('   …the load is billed with the reference on record', `${lm2.billStatus} ${lm2.manualBillRef} ${lm2.billedBy}`, 'billed INV-7 (paper) joshua');
  await page.evaluate(() => goTab('history')); await page.waitForTimeout(900);
  const hs = await page.evaluate(() => {
    const row = document.querySelector('#history-content tr[data-billed-load]');
    return row ? `${row.querySelector('td:nth-child(9)').innerText.replace(/\s+/g, ' ').trim()} | ${Array.from(row.querySelectorAll('button')).map(b => b.textContent.trim()).join(',')} | ${document.querySelectorAll('#history-content .bf-step.active .bf-l').length ? document.querySelector('#history-content .bf-step.active .bf-l').textContent : ''}` : 'no row';
  });
  chk('4. History names how each load was billed and offers Unbill only for manual billing; the strip marks Billed', hs, 'Manual · INV-7 (paper) by joshua | Unbill… | Billed');
  await page.click('#history-content tr[data-billed-load] button'); await page.waitForTimeout(400);
  chk('5. Unbill asks for a reason in the app', await page.evaluate(() => { const m = document.getElementById('ask-modal'); return m ? `${m.querySelector('h2').textContent.trim()} ${m.querySelector('#ask-go').disabled}` : 'no dialog'; }), 'Unbill this load? true');
  await page.fill('#ask-reason', 'paper invoice cancelled'); await page.click('#ask-go'); await page.waitForTimeout(900);
  lm2 = (await call(mgr, 'GET', '/api/data')).data.loads.find(l => l.id === lMat.id);
  chk('   …back to Ready to Bill, the reversal on the record', `${lm2.billStatus} ${lm2.manualBillRef || ''}|${(lm2.billHistory || []).map(h => h.action + ':' + h.reason + ':' + h.reference).join(',')}`, 'ready |unbilled:paper invoice cancelled:INV-7 (paper)');
  await call(mgr, 'POST', '/api/loads/bill', { loadIds: [lMat.id], reference: 'INV-8' });
  await page.evaluate(() => renderHistory()); await page.waitForTimeout(700);
  await page.click('#history-content .history-head button.btn.success'); await page.waitForTimeout(400);
  chk('6. Archive asks in the app', await page.evaluate(() => { const m = document.getElementById('ask-modal'); return m ? m.querySelector('h2').textContent.trim() : 'no dialog'; }), 'Archive billed loads?');
  await page.click('#ask-go'); await page.waitForTimeout(900);
  const arch = await page.evaluate(() => Array.from(document.querySelectorAll('#history-content .archive-batch')).map(b => Array.from(b.querySelectorAll('button')).map(x => x.textContent.trim()).join(',')).join('|'));
  chk('   …the batch is in the archive log with Unarchive', arch, 'Unarchive…');
  await page.click('#history-content .archive-batch button'); await page.waitForTimeout(400);
  chk('7. Unarchive asks for a reason', await page.evaluate(() => { const m = document.getElementById('ask-modal'); return m ? `${m.querySelector('h2').textContent.trim()} ${m.querySelector('#ask-go').disabled}` : 'no dialog'; }), 'Unarchive this batch? true');
  await page.fill('#ask-reason', 'need to correct the invoice'); await page.click('#ask-go'); await page.waitForTimeout(900);
  lm2 = (await call(mgr, 'GET', '/api/data')).data.loads.find(l => l.id === lMat.id);
  chk('   …the load is back on the active lists, still billed, and the archive log is empty', `${lm2 ? lm2.billStatus : 'missing'} ${await page.evaluate(() => document.querySelectorAll('#history-content .archive-batch').length)}`, 'billed 0');
  chk('   no browser confirm() or prompt() in any of this', await page.evaluate(() => `${window.__confirmCalls || 0} ${window.__promptCalls || 0}`), '0 0');
  await page.evaluate(() => goTab('today')); await page.waitForTimeout(500);

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
  console.log('── Office: Linxup telemetry beside VBT (L1) ──');
  // Truck #12 is Beryle's (in progress). Its tracker reports Jesus Guzman, mapped to Rigo → a flag, never a reassignment.
  const lxPost = (type, body) => fetch(B + '/api/linxup/' + type, { method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.status);
  const lxPos = (trackerId, extra) => ({ date: Date.now() - 20000, latitude: 36.7450, longitude: -119.7600, speed: 8, heading: 'S', direction: 180, odometer: 55959, engineOn: true,
    address: { street: '7238 Landing Cove St', city: 'Bakersfield', stateCode: 'CA', postalCode: '93313' },
    tracker: { trackerId, name: 'VBT #' + trackerId, deviceNumber: 'IMEI-' + trackerId, deviceSerialNumber: 'SN-' + trackerId },
    company: { companyId: 1, name: 'Valley Best' }, fleet: { fleetId: 3, name: 'No Group' }, asset: { vin: 'VIN' + trackerId, make: 'Peterbilt', model: '567', year: 2026 }, ...extra });
  chk('1. the webhook takes a Position for an unknown tracker (200) and refuses a bad token (401)',
    `${await lxPost('position', lxPos(602, { person: { personId: 91, name: 'Jesus Guzman' } }))} ${await fetch(B + '/api/linxup/position', { method: 'POST', headers: { Authorization: 'Bearer nope', 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.status)}`, '200 401');
  await call(mgr, 'PUT', '/api/fleet/trucks/truck-12/linxup', { trackerId: 602 });
  await call(mgr, 'PUT', '/api/drivers/rigo', { linxupPersonId: 91 });
  await lxPost('position', lxPos(601, { speed: 0, engineOn: true, date: Date.now() - 5000 }));   // a spare tracker, not linked to any truck
  await page.evaluate(async () => { await loadAll(); goTab('today'); }); await page.waitForTimeout(900);
  const lxb = await page.evaluate(() => {
    const row = document.querySelector('.db-drv[data-driverid="beryle"]');
    const tel = row && row.querySelector('.db-tel');
    return { tel: tel ? tel.innerText.replace(/\s+/g, ' ').trim() : 'no line', flag: row ? Array.from(row.querySelectorAll('.db-flag')).map(f => f.innerText).join('|') : '',
      stage: row ? row.querySelector('.db-drv-load').innerText.replace(/\s+/g, ' ') : '',
      tiles: Array.from(document.querySelectorAll('#db-tiles .db-tile .l')).map(e => e.textContent.trim()).join('|'),
      chip: ((Array.from(document.querySelectorAll('.db-truck')).find(e => /#12/.test(e.innerText)) || {}).innerText || '').replace(/\s+/g, ' ') };
  });
  chk('2. Beryle\'s row keeps VBT\'s stage and adds Linxup beside it: Moving · 8 mph S · engine on · odometer · GPS age · address · Linxup driver', `${/Loaded \/ en route/.test(lxb.stage)} ${/^Moving · 8 mph S · engine on · odo 55,959 · Linxup GPS \d+ s ago 7238 Landing Cove St, Bakersfield, CA 93313 Linxup driver: Jesus Guzman \(Rigo\)/.test(lxb.tel)}`, 'true true');
  chk('   …the disagreement is a flag and a tile, not a reassignment', `${lxb.flag} | ${lxb.tiles.includes('Telemetry')}`, 'Linxup reports Jesus Guzman in Truck #12; VBT has Beryle assigned. | true');
  chk('   the truck chip carries the Linxup state', /Truck #12 · Beryle MOVING/.test(lxb.chip), true);
  const lxAssign = (await call(mgr, 'GET', '/api/data')).data.loads.find(l => l.id === load.id);
  chk('   VBT\'s load still belongs to Beryle on Truck #12', `${lxAssign.truckId} ${lxAssign.truckUnitId}`, 'beryle truck-12');
  await page.evaluate(() => goTab('fleet')); await page.waitForTimeout(700);
  const lxf = await page.evaluate(() => ({ sel: (document.querySelector('[data-truck-id="truck-12"][data-field="linxupTrackerId"]') || {}).value,
    opts: Array.from(document.querySelectorAll('[data-truck-id="truck-12"][data-field="linxupTrackerId"] option')).map(o => o.textContent.trim()).join('|'),
    person: (document.querySelector('[data-driver="rigo"][data-field="linxupPersonId"]') || {}).value }));
  chk('3. Drivers & Trucks: Truck #12 is linked to tracker 602 by id; the picker names trackers by name · VIN · IMEI; Rigo is mapped to the Linxup person', `${lxf.sel} | ${lxf.person} | ${lxf.opts}`, '602 | 91 | — not linked —|VBT #601 · VIN VIN601 · IMEI IMEI-601|VBT #602 · VIN VIN602 · IMEI IMEI-602');
  await page.evaluate(() => goTab('map')); await page.waitForTimeout(1200);
  const lxm = await page.evaluate(async () => { fmSelect('beryle', true); await new Promise(r => setTimeout(r, 400));
    return { card: document.getElementById('fm-card').innerText.replace(/\s+/g, ' '), rows: Array.from(document.querySelectorAll('#fm-list .fm-row')).map(r => r.innerText.replace(/\s+/g, ' ').trim()).join(' || ') }; });
  chk('4. Fleet Map: Beryle\'s marker is Linxup\'s, named as such, with the truck\'s own facts', `${/GPS source Linxup \(truck tracker\)/.test(lxm.card)} ${/Linxup Moving · 8 mph · engine on · odometer 55,959/.test(lxm.card)} ${/Beryle — Truck #12 · Linxup/.test(lxm.rows)}`, 'true true true');
  chk('   no browser confirm() or prompt()', await page.evaluate(() => `${window.__confirmCalls || 0} ${window.__promptCalls || 0}`), '0 0');

  console.log('── Office: Linxup evidence beside the VBT load (L2) ──');
  // Tracker 602 (Truck #12, Beryle's trip 1 from Vulcan): a visit to a fence named exactly "Vulcan", a stop and a vehicle trip.
  const lxNow = Date.now(), co = { company: { companyId: 1 } }, tr602 = { tracker: { trackerId: 602, name: 'VBT #602' } };
  await lxPost('geofence-event', { eventType: 'FENCE_ENTER', enterDateTime: lxNow - 900e3, geofence: { geofenceId: 21, name: 'Vulcan', fenceGroup: 'Yards' }, ...tr602, ...co });
  await lxPost('geofence-event', { eventType: 'FENCE_EXIT', enterDateTime: lxNow - 900e3, exitDateTime: lxNow - 600e3, durationMinutes: 5, geofence: { geofenceId: 21, name: 'Vulcan', fenceGroup: 'Yards' }, ...tr602, ...co });
  await lxPost('stop', { stopType: 'Idling', startDateTime: lxNow - 500e3, endDateTime: lxNow - 320e3, durationMinutes: 3, latitude: 36.7450, longitude: -119.7600, address: { street: '7238 Landing Cove St', city: 'Bakersfield', stateCode: 'CA' }, ...tr602, ...co });
  await lxPost('trip', { startDateTime: lxNow - 600e3, endDateTime: lxNow - 500e3, distanceMiles: 2.1, authorizedMiles: 2.1, unauthorizedMiles: 0, durationMinutes: 2, authorized: true, startGeofence: { geofenceId: 21, name: 'Vulcan' }, endAddress: { street: '7238 Landing Cove St', city: 'Bakersfield', stateCode: 'CA' }, ...tr602, ...co });
  await page.evaluate(async () => { await loadAll(); goTab('today'); }); await page.waitForTimeout(900);
  const l2b = await page.evaluate(() => { const row = document.querySelector('.db-drv[data-driverid="beryle"]'); const tel = row && row.querySelector('.db-tel'); return tel ? tel.innerText.replace(/\s+/g, ' ').trim() : 'no line'; });
  chk('1. the board row adds one line: Last geofence: Vulcan — entered h:mm, left h:mm (5 min)', /Last geofence: Vulcan — entered \d{1,2}:\d\d [AP]M, left \d{1,2}:\d\d [AP]M \(5 min\)/.test(l2b), true);
  await page.evaluate(id => openLoadDetail(id), load.id); await page.waitForTimeout(900);
  const l2d = await page.evaluate(() => { const el = document.getElementById('ld-telemetry'); if (!el) return null;
    const txt = el.innerText.replace(/\s+/g, ' ').trim();
    return { txt, head: el.querySelector('.ld-tel-head').innerText.replace(/\s+/g, ' ').trim(), blocks: el.querySelectorAll('.ld-tel-block').length, timeline: Array.from(el.querySelectorAll('.ld-tl')).map(r => Array.from(r.children).map(c => c.textContent.trim()).join(' ')), sources: Array.from(el.querySelectorAll('.ld-tl-src')).map(e => e.textContent) }; });
  chk('2. Load Details carries a LINXUP TELEMETRY section beside VBT\'s record: Current, then Trip 1 with Pickup, Jobsite and Vehicle activity', l2d ? `${/^LINXUP TELEMETRY the truck's tracker · evidence, not the driver's record$/.test(l2d.head)} ${l2d.blocks} ${/Moving · 8 mph · engine on · Linxup GPS \d+ s ago · 7238 Landing Cove St/.test(l2d.txt)}` : 'no section', 'true 2 true');
  chk('   pickup evidence: the fence visit, entered/exited/minutes, and that the fence was matched by NAME (nobody mapped it yet)', /Pickup — Vulcan · entered \d{1,2}:\d\d [AP]M · exited \d{1,2}:\d\d [AP]M · 5 min inside Linxup geofence \(matched by name\)/.test(l2d.txt), true);
  chk('   jobsite: the PO has a pin (set earlier in this suite) and the tracker was never inside it — said plainly, never "confirmed"', `${/Jobsite · no Linxup activity within the jobsite pin during this trip Linxup GPS/.test(l2d.txt)} ${/confirmed/i.test(l2d.txt)}`, 'true false');
  chk('   vehicle activity: the Linxup vehicle trip is called an ignition cycle, with its miles, and the stop', /Vehicle activity: 1 Linxup vehicle trip \(ignition cycles\) · 2\.1 mi · 1 stop Linxup/.test(l2d.txt), true);
  chk('3. the telemetry timeline is chronological and every line names its source, with the driver\'s taps between Linxup\'s entries', `${l2d.timeline.length >= 7} ${[...new Set(l2d.sources)].sort().join('|')} ${l2d.timeline.some(t => /Driver tapped Arrived at pickup VBT driver app$/.test(t))} ${l2d.timeline.some(t => /Entered Vulcan geofence Linxup geofence$/.test(t))}`, 'true Linxup geofence|Linxup stop|Linxup vehicle trip|VBT driver app true true');
  const l2load = (await call(mgr, 'GET', '/api/data')).data.loads.find(l => l.id === load.id);
  chk('   reading the evidence changed nothing on the load: still Beryle, Truck #12, trip 1 loaded and not arrived', `${l2load.truckId} ${l2load.truckUnitId} ${!!l2load.trips[0].timestamps.loadedAt} ${l2load.trips[0].timestamps.arrivedJobsite || 'none'}`, 'beryle truck-12 true none');
  await page.evaluate(() => document.querySelector('.modal-bg') && document.querySelector('.modal-bg').remove());
  const l2a = await page.evaluate(async id => (await approvalTelemetryHtml(id)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), load.id);
  chk('4. the approval dialog gets a one-line Linxup evidence summary per trip', /^Linxup evidence Trip 1: Vulcan \d{1,2}:\d\d [AP]M–\d{1,2}:\d\d [AP]M \(geofence\) · no activity near the jobsite$/.test(l2a), true);
  chk('   …and it is part of the approval confirmation', await page.evaluate(() => /const tel = await approvalTelemetryHtml\(l\.id\);/.test(confirmApproval.toString())), true);
  await page.evaluate(() => { goTab('vendors'); switchVendorTab('vulcan'); }); await page.waitForTimeout(900);
  const l2v = await page.evaluate(() => { const el = document.getElementById('v-fence'); const sel = document.getElementById('v-fence-sel'); return el ? { txt: el.innerText.replace(/\s+/g, ' ').trim(), value: sel && sel.value, opts: sel ? Array.from(sel.options).map(o => o.textContent.trim()).join('|') : '' } : null; });
  chk('5. Vendors: the yard panel offers the learned Linxup geofences and only SUGGESTS the name match', l2v ? `${l2v.value === ''} ${l2v.opts} ${/Suggested by name: Vulcan — pick it and Save to confirm\./.test(l2v.txt)}` : 'no panel', 'true — not mapped —|Vulcan · Yards true');
  await page.evaluate(() => { document.getElementById('v-fence-sel').value = '21'; return saveVendorFence('vulcan'); }); await page.waitForTimeout(900);
  const l2m = await call(mgr, 'GET', '/api/linxup/geofences');
  chk('   Save maps it (a manager\'s decision, audited); the panel now says visits count as pickup evidence', `${l2m.data.geofences.find(g => g.geofenceId === 21).mappedVendorId} ${await page.evaluate(() => /Geofence visits count as pickup evidence for this yard\./.test(document.getElementById('v-fence').innerText))}`, 'vulcan true');
  chk('   no browser confirm() or prompt()', await page.evaluate(() => `${window.__confirmCalls || 0} ${window.__promptCalls || 0}`), '0 0');

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
  console.log('── Driver: the Start Load button names the actual current load ──');
  // A 3-load PO with no day open (legacy path, no odometer prompts): the
  // button must say 1 of 3, then 2 of 3, then 3 of 3, then disappear, and
  // must always agree with the current-load indicator.
  await call(mgr, 'POST', '/api/pos', { po: { poNumber: 'BTN-3', customer: 'Button Co', deliveryDate: today, address: '1 Btn St', city: 'Fresno', plannedVendorId: 'vbt' }, splits: [{ truckId: 'beryle', truckUnitId: 'truck-12', material: 'Dirt', loadsAssigned: 3, vendorId: 'vbt' }] });
  const btnData = (await call(mgr, 'GET', '/api/data')).data;
  const bl = btnData.loads.find(l => l.poId === btnData.pos.find(p => p.poNumber === 'BTN-3').id);
  const cardState = async () => d.page.evaluate((id) => {
    const cards = Array.from(document.querySelectorAll('.trip-card'));
    const card = cards.find(c => /BTN-3/.test(c.innerText)); if (!card) return 'no-card';
    const btn = Array.from(card.querySelectorAll('.trip-action')).map(b => b.innerText.replace(/\s+/g, ' ').trim()).find(t => /Start Load|Start Trip/.test(t)) || 'no-start-button';
    const ind = (card.innerText.replace(/\s+/g, ' ').match(/CURRENT LOAD · (\d+) OF (\d+) · (\d+) DELIVERED/i) || []).slice(1).join('/') || 'no-indicator';
    return `${btn} | ${ind}`;
  }, bl.id);
  const runTrip = async (n) => {
    await call(drv, 'POST', `/api/loads/${bl.id}/trip-action`, { action: 'start-trip' });
    await call(drv, 'POST', `/api/loads/${bl.id}/trip-action`, { action: 'arrived-pickup', yardId: 'vbt' });
    await call(drv, 'POST', `/api/loads/${bl.id}/trip-action`, { action: 'loaded', ticket: { source: 'vbt', number: `BTN-${n}`, netTons: 10 } });
    await call(drv, 'POST', `/api/loads/${bl.id}/trip-action`, { action: 'arrived-jobsite' });
    await call(drv, 'POST', `/api/loads/${bl.id}/trip-action`, { action: 'trip-complete' });
    await d.page.evaluate(() => renderDriver()); await d.page.waitForTimeout(1200);
  };
  // Day open again (Beryle ended the first one), so an odometer prompt WOULD
  // appear if VBT were treated as a freight start. It must not.
  await call(drv, 'POST', '/api/shifts/start', { truckId: 'truck-2', odometer: 41080, inspection: { satisfactory: true }, signature: PNG });
  await d.page.evaluate(() => renderDriver()); await d.page.waitForTimeout(1200);
  chk('1. before anything: Start Load 1 of 3, indicator 1 of 3, 0 delivered', await cardState(), 'Start Load 1 of 3 | 1/3/0');
  console.log('── Driver: VBT pickup — one tap, no yard picker, no odometer, no freight ──');
  await call(drv, 'POST', `/api/loads/${bl.id}/trip-action`, { action: 'start-trip' });
  await d.page.evaluate(() => renderDriver()); await d.page.waitForTimeout(1200);
  const vbtBtn = await d.page.evaluate(() => { const card = Array.from(document.querySelectorAll('.trip-card')).find(c => /BTN-3/.test(c.innerText)); const b = Array.from(card.querySelectorAll('.trip-action')).find(x => /Arrived/.test(x.innerText)); return b ? b.innerText.replace(/\s+/g, ' ').trim() : 'none'; });
  chk('the load says VBT Yard, so the button is "Arrived at VBT Yard"', vbtBtn, 'Arrived at VBT Yard');
  await d.page.evaluate(async () => { const card = Array.from(document.querySelectorAll('.trip-card')).find(c => /BTN-3/.test(c.innerText)); const b = Array.from(card.querySelectorAll('.trip-action')).find(x => /Arrived/.test(x.innerText)); await arrivedAtOwnYard(b.getAttribute('onclick').match(/'([^']+)'/)[1]); });
  await d.page.waitForTimeout(1500);
  const vbtState = await d.page.evaluate(() => ({ yardModal: document.getElementById('yard-modal').style.display, freightModal: document.getElementById('freightstart-modal').style.display, next: (Array.from(document.querySelectorAll('.trip-card')).find(c => /BTN-3/.test(c.innerText)).querySelector('.trip-action') || {}).innerText }));
  const vbtLoad = (await call(mgr, 'GET', '/api/data')).data.loads.find(l => l.id === bl.id);
  chk('   no yard picker, no odometer prompt; trip stamped at VBT Yard; next step is Loaded', `${vbtState.yardModal !== 'flex'} ${vbtState.freightModal !== 'flex'} ${vbtLoad.trips[0].actualYardName} ${/Loaded/.test(vbtState.next || '')}`, 'true true VBT Yard true');
  chk('   no freight segment was opened at our own yard', (await call(mgr, 'GET', '/api/freight-segments')).data.segments.filter(s => s.status === 'open').length, 0);
  await call(drv, 'POST', `/api/loads/${bl.id}/trip-action`, { action: 'loaded', ticket: { source: 'vbt', number: 'BTN-1', netTons: 10 } });
  await call(drv, 'POST', `/api/loads/${bl.id}/trip-action`, { action: 'arrived-jobsite' });
  await call(drv, 'POST', `/api/loads/${bl.id}/trip-action`, { action: 'trip-complete' });
  await d.page.evaluate(() => renderDriver()); await d.page.waitForTimeout(1200);
  chk('2. load 1 delivered: Start Load 2 of 3, indicator 2 of 3, 1 delivered', await cardState(), 'Start Load 2 of 3 | 2/3/1');
  await runTrip(2);
  chk('3. load 2 delivered: Start Load 3 of 3, indicator 3 of 3, 2 delivered', await cardState(), 'Start Load 3 of 3 | 3/3/2');
  // Tapping the button starts trip 3 and leaves trips 1 and 2 untouched.
  const tripsBefore = (await call(mgr, 'GET', '/api/data')).data.loads.find(l => l.id === bl.id).trips.map(t => JSON.stringify(t));
  await d.page.evaluate((id) => { const card = Array.from(document.querySelectorAll('.trip-card')).find(c => /BTN-3/.test(c.innerText)); Array.from(card.querySelectorAll('.trip-action')).find(b => /Start Load/.test(b.innerText)).click(); }, bl.id);
  let tripsAfter = [];
  for (let i = 0; i < 40; i++) { await d.page.waitForTimeout(500); tripsAfter = (await call(mgr, 'GET', '/api/data')).data.loads.find(l => l.id === bl.id).trips; if (tripsAfter.length === 3) break; }
  await d.page.waitForTimeout(800);
  chk('   tapping it starts trip 3; trips 1 and 2 are unchanged', `${tripsAfter.length} ${tripsAfter[2] && tripsAfter[2].tripNum} ${!!(tripsAfter[2] && tripsAfter[2].timestamps.start)} ${JSON.stringify(tripsAfter[0]) === tripsBefore[0] && JSON.stringify(tripsAfter[1]) === tripsBefore[1]}`, '3 3 true true');
  await call(drv, 'POST', `/api/loads/${bl.id}/trip-action`, { action: 'arrived-pickup', yardId: 'vbt' });
  await call(drv, 'POST', `/api/loads/${bl.id}/trip-action`, { action: 'loaded', ticket: { source: 'vbt', number: 'BTN-3', netTons: 10 } });
  await call(drv, 'POST', `/api/loads/${bl.id}/trip-action`, { action: 'arrived-jobsite' });
  await call(drv, 'POST', `/api/loads/${bl.id}/trip-action`, { action: 'trip-complete' });
  await d.page.evaluate(() => renderDriver()); await d.page.waitForTimeout(1200);
  chk('4. load 3 delivered: no Start Load button; indicator 3 of 3, 3 delivered', await cardState(), 'no-start-button | 3/3/3');
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
