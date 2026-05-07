#!/usr/bin/env node
// One-time app reset. Wipes ALL dispatch data, drivers, customers, vendors,
// trucks, billing, audit log, sessions, and every file in the Supabase bucket
// — but keeps your admin logins so you can sign in afterwards.
//
// Run from Railway's shell on the vbt-dispatch service:
//
//   node scripts/reset-app.js --confirm
//
// Without --confirm the script refuses to touch anything. Required env vars
// are the same ones the app already uses on Railway:
//
//   DATABASE_URL          (required)
//   SUPABASE_URL          (optional — without it, photo wipe is skipped)
//   SUPABASE_SERVICE_KEY  (optional)
//   SUPABASE_BUCKET       (optional, defaults to vbt-photos)
//   RESET_KEEP_ROLES      (optional, comma list, defaults to "admin")
//
// What it does, in order:
//   1. DELETE all rows from `users` where role NOT IN (kept roles).
//   2. TRUNCATE `dispatch_data` so the JSON store is empty.
//   3. TRUNCATE `user_sessions` so everyone is logged out.
//   4. Delete every object in the Supabase bucket (paginated).
//
// What it DOES NOT do:
//   - Drop or alter any tables. Schema stays exactly the same.
//   - Touch the `companies` table. Your VBT company stays.
//   - Touch admin users. You can still log in as joshua/oscar/perla.
//   - Talk to QuickBooks. If you had a QB connection token, it lived inside
//     the dispatch_data blob and is gone — reconnect from the QB tab after.

'use strict';

if (!process.argv.includes('--confirm')) {
  console.error('Refusing to run without --confirm.');
  console.error('Usage: node scripts/reset-app.js --confirm');
  process.exit(2);
}

const KEEP_ROLES = (process.env.RESET_KEEP_ROLES || 'admin')
  .split(',').map(s => s.trim()).filter(Boolean);

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set in this shell.');
  process.exit(1);
}

(async () => {
  const { Pool } = require('pg');
  const pg = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

  try {
    console.log('▶ Connecting to Postgres…');
    await pg.query('SELECT 1');
    console.log('  connected.');

    // 1. Drivers + non-admin users
    const placeholders = KEEP_ROLES.map((_, i) => `$${i + 1}`).join(', ');
    const beforeCount = await pg.query('SELECT COUNT(*)::int AS c FROM users');
    const delUsers = await pg.query(
      `DELETE FROM users WHERE role NOT IN (${placeholders}) RETURNING username, role`,
      KEEP_ROLES
    );
    const afterCount  = await pg.query('SELECT COUNT(*)::int AS c FROM users');
    console.log(`▶ users: deleted ${delUsers.rowCount} (kept roles: ${KEEP_ROLES.join(', ')}). ${beforeCount.rows[0].c} → ${afterCount.rows[0].c}`);
    if (delUsers.rowCount) {
      console.log('  removed: ' + delUsers.rows.map(r => `${r.username}(${r.role})`).join(', '));
    }

    // 2. The dispatch JSON blob — wholesale truncate so first read on next
    //    boot starts from the empty `let store = { ... }` literal.
    const dataBefore = await pg.query('SELECT COUNT(*)::int AS c FROM dispatch_data');
    await pg.query('TRUNCATE dispatch_data');
    console.log(`▶ dispatch_data: truncated (${dataBefore.rows[0].c} rows removed).`);

    // 3. Sessions — log everyone out so a stale browser tab can't keep
    //    operating against the new empty store.
    try {
      const sessBefore = await pg.query('SELECT COUNT(*)::int AS c FROM user_sessions');
      await pg.query('TRUNCATE user_sessions');
      console.log(`▶ user_sessions: truncated (${sessBefore.rows[0].c} rows removed).`);
    } catch (e) {
      // user_sessions only exists when DATABASE_URL is set on the running
      // server (express-session creates it on demand). Safe to ignore.
      console.log(`▶ user_sessions: skipped (${e.message}).`);
    }

    console.log('✓ Postgres wipe complete.');
  } finally {
    await pg.end().catch(() => {});
  }

  // 4. Supabase Storage — delete every file in the bucket.
  const SUPABASE_URL    = process.env.SUPABASE_URL || '';
  const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY || '';
  const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'vbt-photos';

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log('▶ Supabase: SUPABASE_URL or SUPABASE_SERVICE_KEY missing — skipping photo wipe.');
    console.log('  (Run again with both vars set if you want photos cleared too.)');
    console.log('\nDone. Redeploy or hit the app and log in as an admin to verify.');
    return;
  }

  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`▶ Supabase: walking bucket "${SUPABASE_BUCKET}" and deleting every file…`);

  // The Supabase JS SDK doesn't expose a recursive list; you have to walk
  // each "folder" yourself. Photos in this app live under `tickets/YYYY/MM/`
  // and `signatures/YYYY/MM/`, so a 3-level walk catches them.
  async function listAll(prefix) {
    const out = [];
    let offset = 0;
    while (true) {
      const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).list(prefix, {
        limit: 1000,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      });
      if (error) throw error;
      if (!data || !data.length) break;
      for (const item of data) {
        const path = prefix ? `${prefix}/${item.name}` : item.name;
        // Folders show up as entries with id === null (Supabase quirk).
        if (item.id === null) {
          const nested = await listAll(path);
          out.push(...nested);
        } else {
          out.push(path);
        }
      }
      if (data.length < 1000) break;
      offset += data.length;
    }
    return out;
  }

  let paths = [];
  try {
    paths = await listAll('');
  } catch (e) {
    console.error('  list failed:', e.message);
    console.error('  Bucket may not exist or service key may lack access. Aborting Supabase wipe.');
    process.exit(1);
  }
  console.log(`  found ${paths.length} file(s).`);

  if (paths.length) {
    // remove() takes up to 1000 paths per call.
    const CHUNK = 500;
    let deleted = 0;
    for (let i = 0; i < paths.length; i += CHUNK) {
      const chunk = paths.slice(i, i + CHUNK);
      const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).remove(chunk);
      if (error) {
        console.error(`  delete batch ${i / CHUNK + 1} failed:`, error.message);
        process.exit(1);
      }
      deleted += (data || chunk).length;
      console.log(`  deleted ${deleted}/${paths.length}`);
    }
  }

  console.log('✓ Supabase wipe complete.');
  console.log('\nDone. Redeploy or hit the app and log in as an admin to verify.');
})().catch(e => {
  console.error('Reset failed:', e);
  process.exit(1);
});
