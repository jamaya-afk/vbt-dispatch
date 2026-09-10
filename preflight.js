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

// 1. Declared engine vs actual
const declared = pkg.engines && pkg.engines.node;
console.log(`package.json engines.node: ${declared || '(none)'}`);
if (declared && /^\d+\.x$/.test(declared)) {
  const want = major(declared);
  if (want !== runningMajor) {
    console.log(`  ! engines pins Node ${want}.x but this is Node ${runningMajor}. Railway follows engines,`);
    console.log(`    which is how an incompatible dependency slipped in. Prefer ">=18".`);
    warnings++;
  }
}

// 2. Every dependency: installed at all, and does it accept this Node?
console.log('\nDependencies:');
for (const name of Object.keys(pkg.dependencies || {})) {
  const declaredRange = pkg.dependencies[name];
  let dep;
  try {
    dep = require(path.join(name, 'package.json'));
  } catch (e) {
    console.log(`  MISSING  ${name.padEnd(24)} (declared ${declaredRange}) — require() will throw at boot`);
    problems++;
    continue;
  }
  const needs = dep.engines && dep.engines.node;
  const needMajor = needs ? major(needs) : null;
  if (needMajor && needMajor > runningMajor) {
    console.log(`  BREAKS   ${name.padEnd(24)} ${String(dep.version).padEnd(10)} needs Node ${needs} — this is Node ${runningMajor}`);
    problems++;
  } else if (/^\^/.test(declaredRange) && needMajor) {
    console.log(`  ok       ${name.padEnd(24)} ${String(dep.version).padEnd(10)} needs ${needs} (caret range — may float to a newer Node requirement)`);
    warnings++;
  } else {
    console.log(`  ok       ${name.padEnd(24)} ${String(dep.version).padEnd(10)} needs ${needs || 'any'}`);
  }
}

// 3. Modules the app requires directly must actually load
console.log('\nLocal modules:');
for (const f of ['qb.js', 'mailer.js']) {
  if (!fs.existsSync(path.join(__dirname, f))) { console.log(`  MISSING  ${f}`); problems++; continue; }
  try { require('./' + f); console.log(`  ok       ${f}`); }
  catch (e) { console.log(`  BREAKS   ${f} — ${e.message.split('\n')[0]}`); problems++; }
}

// 4. Durability + integration configuration (informational, not fatal)
console.log('\nConfiguration:');
const cfg = [
  ['DATABASE_URL',       !!process.env.DATABASE_URL, 'REQUIRED — without it data dies on redeploy'],
  ['SESSION_SECRET',     !!process.env.SESSION_SECRET, 'recommended — otherwise a known default is used'],
  ['SUPABASE_URL',       !!process.env.SUPABASE_URL, 'ticket/signature photos fall back to base64 without it'],
  ['QB_CLIENT_ID',       !!process.env.QB_CLIENT_ID, 'QuickBooks stays disconnected without it'],
  ['GMAIL_USER',         !!process.env.GMAIL_USER, 'customer email disabled without it'],
];
for (const [k, present, note] of cfg) {
  console.log(`  ${present ? 'set    ' : 'unset  '} ${k.padEnd(20)} ${present ? '' : '— ' + note}`);
}
if (!process.env.DATABASE_URL) {
  console.log('\n  ! DATABASE_URL is not set. In production the server now refuses to start');
  console.log('    rather than silently writing to a file Railway deletes on redeploy.');
}

console.log(`\n${problems ? `FAIL — ${problems} problem(s)` : 'PASS'}${warnings ? `, ${warnings} warning(s)` : ''}\n`);
process.exit(problems ? 1 : 0);
