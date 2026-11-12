#!/usr/bin/env bash
# Sign-in safety: account provisioning (no login can be claimed by whoever
# signs in first), temporary passwords, session revocation, signed-out API
# answers, admin vs manager, response headers and the public /healthz.
# Runs in file mode always, and against a throwaway local Postgres when the
# Postgres 16 binaries are installed (the session rows and the production
# checks need a database). Stops any running server; uses port 4640.
set -u
export PORT=${PORT:-4640}
B=http://localhost:$PORT
PASS=0; FAIL=0
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; PASS=$((PASS+1)); else echo "  FAIL  $1 — got '$2' want '$3'"; FAIL=$((FAIL+1)); fi; }
loc() { sed 's|http://[^/]*||'; }
jq() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)" 2>/dev/null; }
login() { curl -s -c "$1" -o /dev/null -w '%{redirect_url}' -X POST --data-urlencode "username=$2" --data-urlencode "password=$3" $B/login | loc; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
change() { curl -s -b "$1" -c "$1" -o /dev/null -w '%{redirect_url}' -X POST --data-urlencode "current=$2" --data-urlencode "next=$3" --data-urlencode "confirm=${4:-$3}" $B/api/account/password | loc | sed 's|&msg=.*||'; }
post() { local c=$1 u=$2 b=${3:-}; curl -s -b $c -H 'Content-Type: application/json' -X POST "$B$u" -d "${b:-{\}}"; }
audit() { curl -s -b "$1" $B/api/audit-log | python3 -c "import json,sys;d=json.load(sys.stdin);r=d if isinstance(d,list) else d.get('entries',d.get('log',[]));print(sum(1 for e in r if e.get('action')=='$2'), any('$3' in json.dumps(e) for e in r) if '$3' else '')" 2>/dev/null; }
stop() { pkill -f '^node server.js' >/dev/null 2>&1; sleep 1; }
start() { ( env "$@" node server.js > /tmp/vbt-auth.log 2>&1 & ); for i in $(seq 1 20); do sleep 1; curl -s -o /dev/null $B/healthz 2>/dev/null && break; done; }
PNG="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

cd "$(dirname "$0")"

# The server under test was started with OSCAR_PASS=Setup-Oscar-01 (the owner's
# set-up value for oscar) and nothing for anyone else.
suite() { # $1 = label
  echo "── $1"
  A=$(mktemp); A2=$(mktemp); N=$(mktemp); N2=$(mktemp); X=$(mktemp); JS=$(mktemp)
  H=$(curl -s -D - -o /dev/null $B/login)
  chk "responses forbid framing by other sites, forbid content sniffing and do not name the framework" \
    "$(echo "$H" | grep -ci '^x-frame-options: SAMEORIGIN'),$(echo "$H" | grep -ci '^x-content-type-options: nosniff'),$(echo "$H" | grep -ci '^x-powered-by')" "1,1,0"
  chk "a signed-out API call answers JSON 401 session_expired" "$(code $B/api/data) $(curl -s $B/api/data | jq "d['error']")" "401 session_expired"
  chk "a signed-out page still goes to the login form" "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' $B/app/ | loc)" "302 /login"

  echo "   · a login that is not set up cannot be claimed"
  chk "joshua has no set-up password: the published default opens NOTHING — no session, no change-password page, only 'not set up'" \
    "$(login $X joshua joshua123) $(code -b $X $B/api/me) $(curl -s -b $X -o /dev/null -w '%{redirect_url}' $B/change-password | loc) $(curl -s "$B/login?error=setup" | grep -c 'has not been set up yet')" "/login?error=setup 401 /login 1"
  chk "  nobody can set its password with the default either: the change route needs a session it cannot get" \
    "$(curl -s -b $X -H 'Content-Type: application/json' -X POST $B/api/account/password -d '{"current":"joshua123","next":"Attacker-Chosen-1"}' | jq "d['error']") $(login $X joshua Attacker-Chosen-1)" "session_expired /login?error=1"
  chk "  the same for every other login on a default — drivers too, and the old 'manager' password" \
    "$(login $X beryle beryle123) $(login $X perla perla123) $(login $X leonardo leo123) $(login $X joshua 'vbt2025!')" "/login?error=setup /login?error=setup /login?error=setup /login?error=1"

  echo "   · the owner's set-up password is temporary"
  chk "oscar was given OSCAR_PASS: his published default is dead; the set-up value signs in but lands on the change-password page" \
    "$(login $A oscar oscar123) $(login $A oscar Setup-Oscar-01)" "/login?error=1 /change-password"
  chk "  the held session cannot read dispatch data (403 password_change_required)" "$(code -b $A $B/api/data) $(curl -s -b $A $B/api/data | jq "d['error']")" "403 password_change_required"
  chk "  …cannot write either" "$(code -b $A -H 'Content-Type: application/json' -X POST $B/api/pos -d '{}')" "403"
  chk "  …and the app shell sends it back to the form" "$(curl -s -b $A -o /dev/null -w '%{redirect_url}' $B/app/ | loc)" "/change-password"
  chk "  a wrong current password is refused" "$(change $A nope 'Gravel-Haul-77')" "/change-password?error=current"
  chk "  a short new password is refused" "$(change $A Setup-Oscar-01 short1)" "/change-password?error=new"
  chk "  a published default is refused as the new password" "$(change $A Setup-Oscar-01 matthew123)" "/change-password?error=new"
  chk "  a mismatched confirmation is refused" "$(change $A Setup-Oscar-01 'Gravel-Haul-77' 'Gravel-Haul-78')" "/change-password?error=new"
  chk "  after all those refusals the set-up password still works and is still temporary (nothing half-applied)" "$(login $A2 oscar Setup-Oscar-01)" "/change-password"
  chk "  he chooses his own: accepted, and the app opens" "$(change $A Setup-Oscar-01 'Gravel-Haul-77')" "/app/"
  chk "  the session that changed it is now a normal office session" "$(code -b $A $B/api/data) $(curl -s -b $A $B/api/me | jq "d['role']")" "200 admin"
  chk "  the OTHER session that had signed in with the set-up password is dead" "$(code -b $A2 $B/api/me)" "401"
  chk "  the set-up password no longer signs in; his own does, with no hold" "$(login $A2 oscar Setup-Oscar-01) $(login $A2 oscar 'Gravel-Haul-77')" "/login?error=1 /app/"
  chk "  the change is in the audit log" "$(audit $A changed-own-password '' | cut -d' ' -f1)" "1"
  chk "changing a password again signs out the other device, keeps this one" \
    "$(change $A 'Gravel-Haul-77' 'Gravel-Haul-99') $(code -b $A $B/api/me) $(code -b $A2 $B/api/me)" "/app/ 200 401"

  echo "   · an admin issues every other login"
  chk "the admin's list shows how each login stands, never a password: oscar set, the other seven not set up" \
    "$(curl -s -b $A $B/api/admin/logins | jq "[l['state'] for l in d['logins'] if l['username']=='oscar'], sorted(d['notSetUp']), any('password' in k.lower() for l in d['logins'] for k in l)")" "['set'] ['beryle', 'carlos', 'joshua', 'leonardo', 'matthew', 'perla', 'rigo'] False"
  RJ=$(post $A /api/admin/logins/joshua/reset)
  TJ=$(echo "$RJ" | jq "d['temporaryPassword']")
  chk "the admin resets joshua: a random temporary password is returned once (12+ characters, not a published one); the audit log has the reset and not the password" \
    "$(echo "$RJ" | jq "d['success'], len(d['temporaryPassword']) >= 12") $(audit $A reset-login "$TJ")" "True True 1 False"
  chk "  joshua's published default is dead; the temporary password signs in and must be replaced" "$(login $JS joshua joshua123) $(login $JS joshua "$TJ") $(code -b $JS $B/api/data)" "/login?error=1 /change-password 403"
  chk "  he chooses his own and works; the temporary one is dead; the list says set" "$(change $JS "$TJ" 'Quarry-Road-41') $(code -b $JS $B/api/data) $(login $X joshua "$TJ") $(curl -s -b $A $B/api/admin/logins | jq "[l['state'] for l in d['logins'] if l['username']=='joshua']")" "/app/ 200 /login?error=1 ['set']"
  chk "  a reset ends the person's sessions at once (joshua reset again: his open session is refused)" "$(post $A /api/admin/logins/joshua/reset | jq "d['success']") $(code -b $JS $B/api/me)" "True 401"
  chk "  a driver cannot list or reset logins; an unknown username is a 404" "$(RB=$(post $A /api/admin/logins/beryle/reset | jq "d['temporaryPassword']"); BD=$(mktemp); login $BD beryle "$RB" >/dev/null; change $BD "$RB" 'Quarry-Road-42' >/dev/null; echo "$(code -b $BD $B/api/admin/logins) $(code -b $BD -X POST $B/api/admin/logins/oscar/reset)"; rm -f $BD) $(code -b $A -X POST $B/api/admin/logins/nobody/reset)" "403 403 404"

  echo "   · office-set driver passwords are temporary too"
  chk "the office adds a driver with a password it chose" "$(post $A /api/drivers '{"username":"nadia","password":"nadia-long-pass","displayName":"Nadia"}' | jq "d['ok']")" "True"
  chk "  her first sign-in is held until she chooses her own" "$(login $N nadia nadia-long-pass) $(code -b $N $B/api/me | sed 's/403/held/') $(change $N nadia-long-pass 'Quarry-Road-43') $(code -b $N $B/api/me)" "/change-password held /app/ 200"
  chk "  she signs in on a second phone with her own password, no hold" "$(login $N2 nadia 'Quarry-Road-43') $(code -b $N2 $B/api/me)" "/app/ 200"
  chk "  the office sets a new password for her: both phones are signed out at once, and the new one is temporary" \
    "$(curl -s -b $A -H 'Content-Type: application/json' -X PUT $B/api/drivers/nadia -d '{"password":"nadia-second-pass"}' | jq "d['ok']") $(code -b $N $B/api/me) $(code -b $N2 $B/api/me) $(login $N nadia nadia-second-pass)" "True 401 401 /change-password"
  change $N nadia-second-pass 'Quarry-Road-44' >/dev/null
  chk "  the office disables her: the phone's next request is refused, not in seven days" \
    "$(curl -s -b $A -X DELETE $B/api/drivers/nadia | jq "d['ok']") $(code -b $N $B/api/me) $(code -b $N -H 'Content-Type: application/json' -X POST $B/api/driver-location -d '{"lat":1,"lng":1}') $(login $N nadia 'Quarry-Road-44')" "True 401 401 /login?error=1"
  chk "  the office's own session is untouched by all of it" "$(code -b $A $B/api/data)" "200"
  chk "  /healthz (office) names the logins still not set up" \
    "$(curl -s -b $A $B/healthz | jq "'oscar' in d['security']['accountsOnDefaultPassword'], 'perla' in d['security']['accountsOnDefaultPassword']")" "False True"
  rm -f $A $A2 $N $N2 $X $JS
}

stop; rm -f data.json data-ids.json telemetry.json
start VBT_FORCE_PASSWORD_CHANGE=1 OSCAR_PASS=Setup-Oscar-01
suite "file mode"
chk "outside production with the switch off, a default password signs straight in (tests and local work are not held)" \
  "$(stop; rm -f data.json data-ids.json; start X=1; T=$(mktemp); login $T joshua joshua123; rm -f $T)" "/app/"
stop; rm -f data.json data-ids.json telemetry.json

PGB=${PGB:-/usr/lib/postgresql/16/bin}
if [ -x "$PGB/initdb" ]; then
  D=$(mktemp -d /tmp/vbt-pg.XXXXXX); PGPORT=${PGPORT:-5498}
  RUNAS=""; if [ "$(id -u)" = "0" ]; then id pgtest >/dev/null 2>&1 || useradd -m pgtest; chown pgtest "$D"; RUNAS="su pgtest -c"; fi
  run() { if [ -n "$RUNAS" ]; then $RUNAS "$*"; else eval "$*"; fi; }
  run "$PGB/initdb -D $D -U vbt --auth=trust -E UTF8" >/dev/null 2>&1
  run "$PGB/pg_ctl -D $D -o '-p $PGPORT -k /tmp' -l $D/log.txt start" >/dev/null; sleep 2
  run "$PGB/createdb -h /tmp -p $PGPORT -U vbt vbt_auth" >/dev/null 2>&1
  DBURL="postgres://vbt@localhost:$PGPORT/vbt_auth?sslmode=disable"
  PGENV="VBT_FORCE_PASSWORD_CHANGE=1 DATABASE_URL=$DBURL SESSION_SECRET=test-session-secret"
  # First start without the switch seeds the eight logins on their published
  # defaults — the state of an existing deployment before this change.
  start DATABASE_URL=$DBURL SESSION_SECRET=test-session-secret; stop
  start $PGENV OSCAR_PASS=Setup-Oscar-01
  chk "Postgres boot: the log names the logins that are not set up and how to set them up; oscar was moved to his set-up password" \
    "$(grep -c 'are NOT SET UP and cannot sign in' /tmp/vbt-auth.log) $(grep -c '"oscar" was not set up' /tmp/vbt-auth.log) $(grep -c 'NO ADMIN CAN SIGN IN' /tmp/vbt-auth.log)" "1 1 0"
  suite "Postgres"
  S=$(mktemp); login $S oscar 'Gravel-Haul-99' >/dev/null
  chk "Postgres: a revoked session stays revoked across a restart (its row is deleted, not only forgotten in memory)" \
    "$(post $S /api/account/password '{"current":"Gravel-Haul-99","next":"Gravel-Haul-11"}' | jq "d['ok']") $(T=$(mktemp); login $T oscar 'Gravel-Haul-11' >/dev/null; post $T /api/account/password '{"current":"Gravel-Haul-11","next":"Gravel-Haul-22"}' >/dev/null; stop; start $PGENV; echo "$(code -b $S $B/api/me) $(code -b $T $B/api/me)"; rm -f $T)" "True 401 200"
  chk "  a temporary password survives a restart as temporary (the flag is in the database, not in memory)" \
    "$(O0=$(mktemp); login $O0 oscar Gravel-Haul-22 >/dev/null; TP=$(post $O0 /api/admin/logins/carlos/reset | jq "d['temporaryPassword']"); stop; start $PGENV; CC=$(mktemp); echo "$(login $CC carlos "$TP") $(login $CC carlos carlos123)"; rm -f $O0 $CC)" "/change-password /login?error=1"
  stop; start $PGENV X=1
  chk "  with every admin on a published default and no set-up value, the boot log says nobody can administer — it does not open a door" \
    "$(psql -q -h /tmp -p $PGPORT -U vbt vbt_auth -Atc "SELECT count(*) FROM users WHERE role='admin'") $(grep -c 'NO ADMIN CAN SIGN IN' /tmp/vbt-auth.log)" "3 0"

  # Admin vs manager, and set-up by environment for a login still on a default.
  psql -q -h /tmp -p $PGPORT -U vbt vbt_auth -c "UPDATE users SET role='manager' WHERE username='perla'" >/dev/null
  stop; start $PGENV PERLA_PASS=Perla-Setup-55 OSCAR_PASS=Should-Not-Apply-1
  P=$(mktemp); O=$(mktemp)
  chk "PERLA_PASS set in the environment: the login still on its default moves to it at boot as a TEMPORARY password — the default is dead, the set-up value must be replaced" \
    "$(login $P perla perla123) $(login $P perla Perla-Setup-55) $(change $P Perla-Setup-55 'Quarry-Road-45') $(code -b $P $B/api/me)" "/login?error=1 /change-password /app/ 200"
  chk "  …and the boot log says so" "$(grep -c '"perla" was not set up' /tmp/vbt-auth.log)" "1"
  chk "  a password someone chose is never replaced from the environment (OSCAR_PASS is ignored for oscar)" \
    "$(login $O oscar Should-Not-Apply-1) $(login $O oscar Gravel-Haul-22)" "/login?error=1 /app/"
  chk "a manager runs the day: the board and the PO list answer" "$(code -b $P $B/api/today) $(code -b $P $B/api/data)" "200 200"
  chk "  …but cannot list or restore backups, set default rates, connect / disconnect QuickBooks, or list / reset logins (403 each)" \
    "$(code -b $P $B/api/admin/backups) $(code -b $P -H 'Content-Type: application/json' -X POST $B/api/admin/restore -d '{"source":"store_prev"}') $(code -b $P -H 'Content-Type: application/json' -X PUT $B/api/default-rates -d '{"side":"customer","material":"Dirt","rate":1}') $(code -b $P $B/api/quickbooks/connect) $(code -b $P -X POST $B/api/quickbooks/disconnect) $(code -b $P $B/api/admin/logins) $(code -b $P -X POST $B/api/admin/logins/oscar/reset)" "403 403 403 403 403 403 403"
  chk "  an admin still can (backups list answers)" "$(code -b $O $B/api/admin/backups)" "200"
  # A vehicle hold is cleared by an admin, not by a manager.
  post $O /api/drivers '{"username":"dvir1","password":"dvir-private-1","displayName":"Dvir One"}' >/dev/null
  DV=$(mktemp); login $DV dvir1 dvir-private-1 >/dev/null; change $DV dvir-private-1 'Quarry-Road-46' >/dev/null
  TK=$(curl -s -b $DV $B/api/shifts/current | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['trucks'][0]['id'])")
  ANS=$(curl -s -b $DV $B/api/shifts/current | python3 -c "import json,sys;d=json.load(sys.stdin);print(json.dumps({i:('defect' if i=='Brakes' else 'ok') for i in d['inspectionItems']}))")
  RID=$(post $DV /api/shifts/start "{\"truckId\":\"$TK\",\"odometer\":10,\"inspection\":{\"answers\":$ANS,\"remarks\":\"no pedal\"},\"signature\":\"$PNG\"}" | jq "d['report']['id']")
  chk "a truck held for a blocking defect: a manager sees the report but cannot record the clearance (403 clearance_admin_only), a driver cannot either; an admin can" \
    "$(curl -s -b $P $B/api/defect-reports | jq "d['held']") $(post $P /api/defect-reports/$RID/resolve '{"decision":"corrected","by":"Hector","note":"new brake line"}' | jq "d['code']") $(code -b $DV -H 'Content-Type: application/json' -X POST $B/api/defect-reports/$RID/resolve -d '{"decision":"corrected","by":"Hector","note":"new brake line"}') $(post $O /api/defect-reports/$RID/resolve '{"decision":"corrected","by":"Hector","note":"new brake line"}' | jq "d['report']['status'], d['report']['resolution']['recordedByRole']")" "1 clearance_admin_only 403 cleared admin"
  rm -f $DV
  chk "the browser's favicon request is answered (it was the one 404 on every first visit)" "$(code $B/favicon.ico)" "200"
  rm -f $P $O
  stop
  # A first production start on an empty database never plants a published default.
  run "$PGB/createdb -h /tmp -p $PGPORT -U vbt vbt_fresh" >/dev/null 2>&1
  FRESH="NODE_ENV=production DATABASE_URL=postgres://vbt@localhost:$PGPORT/vbt_fresh?sslmode=disable SESSION_SECRET=test-session-secret QB_ENCRYPTION_KEY=test-qb-key"
  start $FRESH MATTHEW_PASS=Matthew-Setup-9
  OT=$(grep -E '^    joshua: ' /tmp/vbt-auth.log | sed 's/^    joshua: //')
  plogin() { curl -s -o /dev/null -w '%{redirect_url}' -H 'X-Forwarded-Proto: https' -X POST --data-urlencode "username=$1" --data-urlencode "password=$2" $B/login | loc; }
  chk "production, first start, empty database: the published default opens nothing; the one-time set-up password from the boot log and a <NAME>_PASS value both sign in as temporary (change required)" \
    "$(plogin joshua joshua123) $(plogin joshua "$OT") $(plogin matthew Matthew-Setup-9) $(grep -cE '^    matthew: ' /tmp/vbt-auth.log)" "/login?error=1 /change-password /change-password 0"
  stop; start $FRESH
  chk "  the set-up passwords are printed once: a second start prints none and reports no login as not set up" "$(grep -cE '^    joshua: |NOT SET UP|published default' /tmp/vbt-auth.log)" "0"
  stop
  # An existing production database whose logins are still on the published defaults.
  run "$PGB/createdb -h /tmp -p $PGPORT -U vbt vbt_legacy" >/dev/null 2>&1
  LEG="DATABASE_URL=postgres://vbt@localhost:$PGPORT/vbt_legacy?sslmode=disable SESSION_SECRET=test-session-secret QB_ENCRYPTION_KEY=test-qb-key"
  start $LEG; LS=$(mktemp); login $LS joshua joshua123 >/dev/null; stop   # yesterday: a session opened with the default
  start NODE_ENV=production $LEG
  chk "production, existing database on defaults, nothing provisioned: every default is refused, the session opened before the deploy is dead, and the log says no admin can sign in and which variables to set" \
    "$(plogin joshua joshua123) $(plogin beryle beryle123) $(code -b $LS -H 'X-Forwarded-Proto: https' $B/api/me) $(grep -c 'NO ADMIN CAN SIGN IN' /tmp/vbt-auth.log) $(grep -c 'JOSHUA_PASS' /tmp/vbt-auth.log | sed 's/[1-9][0-9]*/named/')" "/login?error=setup /login?error=setup 401 1 named"
  stop; start NODE_ENV=production $LEG JOSHUA_PASS=Joshua-Setup-01
  chk "  the owner sets JOSHUA_PASS and redeploys: joshua signs in once with it and must choose his own; the others stay locked until he resets them" \
    "$(plogin joshua Joshua-Setup-01) $(plogin oscar oscar123) $(grep -c 'NO ADMIN CAN SIGN IN' /tmp/vbt-auth.log)" "/change-password /login?error=setup 0"
  stop; rm -f $LS
  start NODE_ENV=production DATABASE_URL=$DBURL SESSION_SECRET=test-session-secret QB_ENCRYPTION_KEY=test-qb-key HEALTH_TOKEN=monitor-token
  chk "production: the public /healthz is the verdict only — no error list, no store size, no integration detail" \
    "$(curl -s $B/healthz | jq "d['ok'], sorted(k for k in d if k in ('recentErrors','storeSummary','linxup','linxupApi','persistence','security','node'))")" "True []"
  chk "  a monitor presenting HEALTH_TOKEN gets the full report; a wrong token does not" \
    "$(curl -s -H 'X-Health-Token: monitor-token' $B/healthz | jq "'recentErrors' in d") $(curl -s -H 'X-Health-Token: monitor-tokem' $B/healthz | jq "'recentErrors' in d")" "True False"
  chk "  production asks for https only" "$(curl -s -D - -o /dev/null $B/login | grep -ci '^strict-transport-security')" "1"
  stop; rm -f $S
  run "$PGB/pg_ctl -D $D stop -m fast" >/dev/null 2>&1; rm -rf "$D"
else
  echo "  SKIP  Postgres section (binaries not found at $PGB)"
fi

echo; echo "auth: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
