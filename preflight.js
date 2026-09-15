#!/usr/bin/env node
// Deploy preflight for Valley Best.
//
// Catches the failure that crash-looped production: a dependency whose
// required Node version is newer than the one Railway actually runs, so npm
// skips it and the app dies on require(). Run this before deploying.
//
//   node preflight.js
//
// Exits non-zero if anything would break, so it can gate a deploy.

const fs = require('fs');
const path = require('path');

const pkg = require('./package.json');
const running = process.versions.node;
const runningMajor = Number(running.split('.')[0]);

let problems = 0;
let warnings = 0;

function major(range) {
  // Pull the smallest major version a range like ">=20.0.0" demands
  const m = String(range).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

console.log(`\nValley Best preflight — running Node ${running}\n`);

// 1. engines.node must be a CONCRETE version the host can resolve.
//
// Railway provisions Node from this field. A range like ">=18" gave it nothing
// to pin, so the container came up with no node binary at all —
// "node: command not found" on every start. Only a concrete form is safe.
const declared = pkg.engines && pkg.engines.node;
console.log(`package.json engines.node: ${declared || '(none)'}`);
if (!declared) {
  console.log('  BREAKS   no engines.node — the host has nothing to pin a Node version to');
  problems++;
} else if (!/^\d+(\.\d+)*(\.x)?$/.test(declared)) {
  console.log(`  BREAKS   "${declared}" is a RANGE, not a concrete version.`);
  console.log('           Railway could not resolve it and installed no Node at all.');
  console.log('           Use a concrete form such as "18.x" or "20.x".');
  problems++;
} else {
  const want = major(declared);
  if (want !== runningMajor) {
    console.log(`  note     pins Node ${want}.x; this machine is Node ${runningMajor} — deps are checked against ${want} below`);
  }
}

// nixpacks.toml declaring a different Node than engines is how the runtime and
// the dependency checks drift apart.
try {
  const nix = fs.readFileSync(path.join(__dirname, 'nixpacks.toml'), 'utf8');
  const m = nix.match(/nodejs[_-](\d+)/);
  if (m && declared && major(declared) !== Number(m[1])) {
    console.log(`  ! nixpacks.toml asks for nodejs_${m[1]} but engines says ${declared}.`);
    console.log(`    Railway follows engines; the observed runtime has been Node ${major(declared)}.`);
    warnings++;
  }
} catch (e) { /* no nixpacks.toml is fine */ }

// 2. Every dependency: installed at all, and does it accept the Node version
// PRODUCTION will run — not the one this machine happens to have. Checking
// against the local Node is how a package needing Node 20 passed on a dev box
// running Node 22 and then crash-looped on Railway's Node 18.
const targetMajor = declared && major(declared) ? major(declared) : runningMajor;
console.log(`\nDependencies (checked against deploy target Node ${targetMajor}):`);
for (const name of Object.keys(pkg.dependencies || {})) {
  const declaredRange = pkg.dependencies[name];
  // Read the manifest off disk rather than require()-ing it. Packages with a
  // restrictive "exports" map (stripe, for one) refuse
  // require('pkg/package.json') even when perfectly installed.
  let dep;
  const manifest = path.join(__dirname, 'node_modules', name, 'package.json');
  try {
    dep = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  } catch (e) {
    console.log(`  MISSING  ${name.padEnd(24)} (declared ${declaredRange}) — not installed; require() would throw at boot`);
    problems++;
    continue;
  }
  const needs = dep.engines && dep.engines.node;
  const needMajor = needs ? major(needs) : null;
  if (needMajor && needMajor > targetMajor) {
    console.log(`  BREAKS   ${name.padEnd(24)} ${String(dep.version).padEnd(10)} needs Node ${needs} — production runs Node ${targetMajor}`);
    problems++;
  } else if (/^[\^~]/.test(declaredRange)) {
    // A floating range is a live hazard with no committed lockfile: npm
    // re-resolves on every Railway build. It is worse when the package
    // declares no engines at all, because then nothing above can catch a
    // version that quietly starts requiring a newer Node.
    const blind = needs ? '' : ' and it declares NO engines, so this check cannot protect it';
    console.log(`  warn     ${name.padEnd(24)} ${String(dep.version).padEnd(10)} range "${declaredRange}" floats${blind}`);
    warnings++;
  } else {
    console.log(`  ok       ${name.padEnd(24)} ${String(dep.version).padEnd(10)} needs ${needs || 'any'}`);
  }
}

// 3. Modules the app requires directly must actually load
console.log('\nLocal modules:');
// qb.js refuses to load without an encryption key (there is no fallback in
// source); give the require a throwaway one so the check tests loadability.
if (!process.env.QB_ENCRYPTION_KEY) process.env.QB_ENCRYPTION_KEY = 'preflight-only-' + Date.now();
for (const f of ['qb.js', 'mailer.js']) {
  if (!fs.existsSync(path.join(__dirname, f))) { console.log(`  MISSING  ${f}`); problems++; continue; }
  try { require('./' + f); console.log(`  ok       ${f}`); }
  catch (e) { console.log(`  BREAKS   ${f} — ${e.message.split('\n')[0]}`); problems++; }
}

// 4. Durability + integration configuration (informational, not fatal)
console.log('\nConfiguration:');
const cfg = [
  ['DATABASE_URL',       !!process.env.DATABASE_URL, 'REQUIRED in production — without it data dies on redeploy'],
  ['SESSION_SECRET',     !!process.env.SESSION_SECRET, 'REQUIRED in production — signs login cookies'],
  ['QB_ENCRYPTION_KEY',  !!process.env.QB_ENCRYPTION_KEY && !process.env.QB_ENCRYPTION_KEY.startsWith('preflight-only-'), 'REQUIRED in production — encrypts QuickBooks tokens'],
  ['GOOGLE_SERVICE_ACCOUNT_JSON', !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON, 'Google Sheets archive/sync disabled without it'],
  ['SUPABASE_URL',       !!process.env.SUPABASE_URL, 'ticket/signature photos fall back to base64 without it'],
  ['QB_CLIENT_ID',       !!process.env.QB_CLIENT_ID, 'QuickBooks stays disconnected without it'],
  ['GMAIL_USER',         !!process.env.GMAIL_USER, 'customer email disabled without it'],
];
for (const [k, present, note] of cfg) {
  console.log(`  ${present ? 'set    ' : 'unset  '} ${k.padEnd(20)} ${present ? '' : '— ' + note}`);
}
const missingProd = ['DATABASE_URL', 'SESSION_SECRET', 'QB_ENCRYPTION_KEY'].filter(k => !cfg.find(c => c[0] === k)[1]);
if (missingProd.length) {
  console.log(`\n  ! Not set: ${missingProd.join(', ')}. In production the server refuses to start without them`);
  console.log('    (no fallback values exist in the source any more).');
}
// 5. A committed credential file must never come back
if (fs.existsSync(path.join(__dirname, 'service-account.json'))) {
  console.log('\n  SECURITY  service-account.json exists on disk. The app ignores it; delete it and use GOOGLE_SERVICE_ACCOUNT_JSON.');
  warnings++;
}
try {
  const tracked = require('child_process').execSync('git ls-files -- service-account.json', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  if (tracked) { console.log('\n  FAIL      service-account.json is tracked by git. Remove it: git rm --cached service-account.json'); problems++; }
} catch {}

console.log(`\n${problems ? `FAIL — ${problems} problem(s)` : 'PASS'}${warnings ? `, ${warnings} warning(s)` : ''}\n`);
process.exit(problems ? 1 : 0);
