#!/usr/bin/env node
// Generate a realistic Valley Best work week of dispatch data.
//
//   node seed-week.js                          # against localhost:3000
//   node seed-week.js --url https://... --yes  # against a live server
//
// Every PO it creates is tagged [SAMPLE] in the notes so it can be found and
// removed later (Purchase Orders tab, or `node seed-week.js --clean`).
// It only ever CREATES — it never deletes or modifies existing records, and it
// refuses to touch a non-localhost server without an explicit --yes.

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : (args[i + 1] || d); };
const has  = (n) => args.includes(n);

const BASE  = (flag('--url', 'http://localhost:3000')).replace(/\/$/, '');
const USER  = flag('--user', 'joshua');
const PASS  = flag('--pass', process.env.JOSHUA_PASS || 'joshua123');
const MONDAY = flag('--monday', null);   // YYYY-MM-DD; defaults to next Monday
const TAG = '[SAMPLE]';

const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE);
if (!isLocal && !has('--yes')) {
  console.error(`\nRefusing to write sample data to ${BASE} without --yes.`);
  console.error('This creates real POs and loads. Re-run with --yes if that is what you want.\n');
  process.exit(1);
}

// ── The week ────────────────────────────────────────────────────────────────
function nextMonday() {
  const d = new Date();
  // 1 = Monday. Always lands on the Monday AFTER today, never today.
  const delta = ((8 - d.getDay()) % 7) || 7;
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const MON = MONDAY || nextMonday();
const DAY = [0, 1, 2, 3, 4].map(i => addDays(MON, i));   // Mon..Fri

// Drivers are truckId (legacy field name); trucks are separate now, so the
// same driver deliberately runs different trucks across the week.
const D = { beryle: 'beryle', matthew: 'matthew', rigo: 'rigo', leonardo: 'leonardo', carlos: 'carlos' };
const T = { t2: 'truck-2', t4: 'truck-4', t14: 'truck-14', t12: 'truck-12', t2b: 'truck-2b' };

// Materials are chosen to match each yard's seeded price list so costing
// resolves to a real rate instead of falling back to the default.
//   vulcan  3/4 Rock, Base Rock, Sand      cemex   Cold Mix, Base Rock
//   teichert Fill Sand, Gravel             keith   Fill Sand, Recycle Base
//   granite 3/4 Rock, Rock                 hanson  Rock
//   vbt     internal — always $0 material
const WEEK = [
  // ── MONDAY ──
  { day: 0, poNumber: '4471', customer: 'Sierra Vista Builders', jobCode: 'SVB-PHASE2',
    address: '1450 Shaw Ave', city: 'Clovis', yard: 'vulcan',
    notes: 'Phase 2 pad prep. Gate code 2204. Foreman on site from 6am.',
    splits: [
      { driver: D.beryle,  truck: T.t2,  material: '3/4 Rock', loads: 4 },
      { driver: D.matthew, truck: T.t4,  material: '3/4 Rock', loads: 3 },
    ] },
  { day: 0, poNumber: '4472', customer: 'Madera Ag Supply', jobCode: 'MAS-YARD',
    address: '830 Airport Dr', city: 'Madera', yard: 'keith',
    notes: 'Dump inside the north gate, not the street side.',
    splits: [ { driver: D.rigo, truck: T.t14, material: 'Fill Sand', loads: 5 } ] },

  // ── TUESDAY — 4471 drawn against a second time ──
  { day: 1, poNumber: '4471', customer: 'Sierra Vista Builders', jobCode: 'SVB-PHASE2',
    address: '1450 Shaw Ave', city: 'Clovis', yard: 'vulcan',
    notes: 'Second draw on the same customer PO. Base under the slab this time.',
    splits: [ { driver: D.leonardo, truck: T.t12, material: 'Base Rock', loads: 4 } ] },
  { day: 1, poNumber: '4473', customer: 'Kerman Concrete', jobCode: 'KC-LOT9',
    address: '15 S Madera Ave', city: 'Kerman', yard: 'cemex',
    notes: 'Cold mix — call ahead, they want it same-day.',
    splits: [ { driver: D.carlos, truck: T.t2b, material: 'Cold Mix', loads: 2 } ] },

  // ── WEDNESDAY — two drivers on one PO, plus a third draw on 4471 ──
  { day: 2, poNumber: '4474', customer: 'Reedley School District', jobCode: 'RSD-LOT',
    address: '1100 Duff Ave', city: 'Reedley', yard: 'keith',
    notes: 'Parking lot rebuild. No deliveries between 7:40 and 8:10 (drop-off).',
    splits: [
      { driver: D.beryle, truck: T.t2,  material: 'Recycle Base', loads: 3 },
      { driver: D.rigo,   truck: T.t14, material: 'Recycle Base', loads: 3 },
    ] },
  { day: 2, poNumber: '4471', customer: 'Sierra Vista Builders', jobCode: 'SVB-PHASE2',
    address: '1450 Shaw Ave', city: 'Clovis', yard: 'vulcan',
    notes: 'Third draw on 4471 — topping off the pad.',
    splits: [ { driver: D.matthew, truck: T.t4, material: '3/4 Rock', loads: 2 } ] },

  // ── THURSDAY — internal yard (no material cost) + a two-driver job ──
  { day: 3, poNumber: '4475', customer: 'Selma Grading Co', jobCode: 'SGC-FILL',
    address: '2900 Floral Ave', city: 'Selma', yard: 'vbt',
    notes: 'Our own yard — fill dirt only, no ticket from the plant.',
    splits: [ { driver: D.leonardo, truck: T.t12, material: 'Dirt', loads: 6 } ] },
  { day: 3, poNumber: '4476', customer: 'Fowler Ranch Roads', jobCode: 'FRR-EAST',
    address: '7712 E Manning Ave', city: 'Fowler', yard: 'teichert',
    notes: 'Ranch road resurface. Watch the low bridge on Manning.',
    splits: [
      { driver: D.carlos, truck: T.t2b, material: 'Gravel', loads: 4 },
      // Beryle on Truck #4, not his usual #2 — drivers and trucks are
      // independent. #4 is free today because Matthew is not working.
      { driver: D.beryle, truck: T.t4,  material: 'Gravel', loads: 2 },
    ] },

  // ── FRIDAY — biggest day, plus a second draw on 4476 from another yard ──
  { day: 4, poNumber: '4477', customer: 'Kingsburg Industrial Park', jobCode: 'KIP-B4',
    address: '1201 Marion St', city: 'Kingsburg', yard: 'hanson',
    notes: 'Building 4 pad. Scale ticket required for every load.',
    splits: [
      { driver: D.rigo,    truck: T.t14, material: 'Rock', loads: 4 },
      { driver: D.matthew, truck: T.t4,  material: 'Rock', loads: 3 },
    ] },
  { day: 4, poNumber: '4476', customer: 'Fowler Ranch Roads', jobCode: 'FRR-EAST',
    address: '7712 E Manning Ave', city: 'Fowler', yard: 'cemex',
    notes: 'Same PO as Thursday, different yard — Teichert was out of base.',
    splits: [ { driver: D.leonardo, truck: T.t12, material: 'Base Rock', loads: 3 } ] },
];

// ── HTTP ────────────────────────────────────────────────────────────────────
let cookie = '';
async function req(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  return { status: r.status, data, text };
}

async function login() {
  const r = await fetch(BASE + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: USER, password: PASS }).toString(),
    redirect: 'manual',
  });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const dest = r.headers.get('location') || '';
  if (!dest.includes('/app')) throw new Error(`Login failed for "${USER}" (redirected to ${dest || r.status})`);
}

// ── CLEAN ───────────────────────────────────────────────────────────────────
async function clean() {
  const { data } = await req('GET', '/api/data');
  const sample = (data.pos || []).filter(p => String(p.notes || '').includes(TAG));
  if (!sample.length) { console.log(`\nNo ${TAG} POs found — nothing to clean.\n`); return; }
  console.log(`\nRemoving ${sample.length} ${TAG} PO(s)…`);
  let gone = 0, kept = 0;
  for (const p of sample) {
    const r = await req('DELETE', '/api/pos/' + p.id);
    if (r.status === 200) { gone++; console.log(`  removed  ${p.poNumber}  ${p.customer}  ${p.deliveryDate}`); }
    else { kept++; console.log(`  KEPT     ${p.poNumber}  ${p.customer}  — ${r.data?.error || r.status}`); }
  }
  console.log(`\n${gone} removed, ${kept} kept (a PO with approved loads is never deleted).\n`);
}

// ── SEED ────────────────────────────────────────────────────────────────────
async function seed() {
  const dayName = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  console.log(`\nSeeding the week of ${MON} into ${BASE}\n`);
  let pos = 0, loadRows = 0, trips = 0, lastDay = -1;

  for (const j of WEEK) {
    if (j.day !== lastDay) { console.log(`\n  ${dayName[j.day]}  ${DAY[j.day]}`); lastDay = j.day; }
    const body = {
      po: {
        poNumber: j.poNumber,
        customer: j.customer,
        jobCode: j.jobCode,
        deliveryDate: DAY[j.day],
        address: j.address,
        city: j.city,
        plannedVendorId: j.yard,
        notes: `${TAG} ${j.notes}`,
      },
      splits: j.splits.map(s => ({
        truckId: s.driver, truckUnitId: s.truck,
        material: s.material, loadsAssigned: s.loads, vendorId: j.yard,
      })),
    };
    const r = await req('POST', '/api/pos', body);
    if (r.status !== 200 || !r.data?.success) {
      console.log(`    FAILED  PO ${j.poNumber} ${j.customer} — ${r.data?.error || r.status}`);
      continue;
    }
    pos++;
    const who = j.splits.map(s => `${s.driver} ${s.loads}x`).join(', ');
    console.log(`    PO ${j.poNumber}  ${j.customer.padEnd(26)} ${j.city.padEnd(10)} ${j.splits[0].material.padEnd(13)} ${who}`);
    loadRows += j.splits.length;
    trips += j.splits.reduce((s, x) => s + x.loads, 0);
  }

  const reused = {};
  WEEK.forEach(j => { reused[j.poNumber] = (reused[j.poNumber] || 0) + 1; });
  const multi = Object.entries(reused).filter(([, n]) => n > 1);

  console.log(`\n  ${pos} POs · ${loadRows} load assignments · ${trips} truck loads`);
  if (multi.length) {
    console.log('  PO numbers drawn against on more than one day:');
    multi.forEach(([n, c]) => console.log(`    ${n} — ${c} separate deliveries`));
  }
  console.log(`\n  All tagged ${TAG} in the notes. Remove with:  node seed-week.js --clean${isLocal ? '' : ` --url ${BASE} --yes`}\n`);
}

(async () => {
  try {
    await login();
    if (has('--clean')) await clean();
    else await seed();
  } catch (e) {
    console.error('\n' + e.message + '\n');
    process.exit(1);
  }
})();
