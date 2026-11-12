#!/usr/bin/env bash
# Sign-in safety: published default passwords, session revocation, signed-out
# API answers, response headers and the public /healthz.
# Runs in file mode always, and against a throwaway local Postgres when the
# Postgres 16 binaries are installed (the session rows and the production
# /healthz need a database). Stops any running server; uses port 4640.
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
stop() { pkill -f '^node server.js' >/dev/null 2>&1; sleep 1; }
start() { ( env "$@" node server.js > /tmp/vbt-auth.log 2>&1 & ); for i in $(seq 1 20); do sleep 1; curl -s -o /dev/null $B/healthz 2>/dev/null && break; done; }

cd "$(dirname "$0")"

suite() { # $1 = label
  echo "── $1"
  A=$(mktemp); A2=$(mktemp); N=$(mktemp); N2=$(mktemp)
  H=$(curl -s -D - -o /dev/null $B/login)
  chk "responses forbid framing by other sites, forbid content sniffing and do not name the framework" \
    "$(echo "$H" | grep -ci '^x-frame-options: SAMEORIGIN'),$(echo "$H" | grep -ci '^x-content-type-options: nosniff'),$(echo "$H" | grep -ci '^x-powered-by')" "1,1,0"
  chk "a signed-out API call answers JSON 401 session_expired" "$(code $B/api/data) $(curl -s $B/api/data | jq "d['error']")" "401 session_expired"
  chk "a signed-out page still goes to the login form" "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' $B/app/ | loc)" "302 /login"

  chk "signing in with a published default password lands on the change-password page" "$(login $A oscar oscar123)" "/change-password"
  chk "  the held session cannot read dispatch data (403 password_change_required)" "$(code -b $A $B/api/data) $(curl -s -b $A $B/api/data | jq "d['error']")" "403 password_change_required"
  chk "  …cannot write either" "$(code -b $A -H 'Content-Type: application/json' -X POST $B/api/pos -d '{}')" "403"
  chk "  …and the app shell sends it back to the form" "$(curl -s -b $A -o /dev/null -w '%{redirect_url}' $B/app/ | loc)" "/change-password"
  chk "  the form renders for it" "$(curl -s -b $A $B/change-password | grep -c 'Choose a new password')" "1"
  chk "  a wrong current password is refused" "$(change $A nope 'Gravel-Haul-77')" "/change-password?error=current"
  chk "  a short new password is refused" "$(change $A oscar123 short1)" "/change-password?error=new"
  chk "  another published default is refused as the new password" "$(change $A oscar123 matthew123)" "/change-password?error=new"
  chk "  a mismatched confirmation is refused" "$(change $A oscar123 'Gravel-Haul-77' 'Gravel-Haul-78')" "/change-password?error=new"
  chk "  after all those refusals the default still signs in (nothing half-applied)" "$(login $A2 oscar oscar123)" "/change-password"
  chk "  a good new password is accepted and opens the app" "$(change $A oscar123 'Gravel-Haul-77')" "/app/"
  chk "  the session that changed it is now a normal office session" "$(code -b $A $B/api/data) $(curl -s -b $A $B/api/me | jq "d['role']")" "200 admin"
  chk "  the OTHER session that had signed in with the default is dead" "$(code -b $A2 $B/api/me)" "401"
  chk "  the default password no longer signs in" "$(login $A2 oscar oscar123)" "/login?error=1"
  chk "  the new one does, with no hold" "$(login $A2 oscar 'Gravel-Haul-77')" "/app/"
  chk "  the change is in the audit log" "$(curl -s -b $A $B/api/audit-log 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);r=d if isinstance(d,list) else d.get('entries',d.get('log',[]));print(sum(1 for e in r if e.get('action')=='changed-own-password'))" 2>/dev/null)" "1"

  chk "changing a password again signs out the other device, keeps this one" \
    "$(change $A 'Gravel-Haul-77' 'Gravel-Haul-99') $(code -b $A $B/api/me) $(code -b $A2 $B/api/me)" "/app/ 200 401"

  chk "the office adds a driver with a private password" "$(curl -s -b $A -H 'Content-Type: application/json' -X POST $B/api/drivers -d '{"username":"nadia","password":"nadia-long-pass","displayName":"Nadia"}' | jq "d['ok']")" "True"
  chk "  she signs in on two phones with no hold" "$(login $N nadia nadia-long-pass) $(login $N2 nadia nadia-long-pass) $(code -b $N $B/api/me)" "/app/ /app/ 200"
  chk "  the office sets a new password for her: both phones are signed out at once" \
    "$(curl -s -b $A -H 'Content-Type: application/json' -X PUT $B/api/drivers/nadia -d '{"password":"nadia-second-pass"}' | jq "d['ok']") $(code -b $N $B/api/me) $(code -b $N2 $B/api/me)" "True 401 401"
  chk "  she signs in with the new one" "$(login $N nadia nadia-second-pass) $(code -b $N $B/api/me)" "/app/ 200"
  chk "  the office disables her: the phone's next request is refused, not in seven days" \
    "$(curl -s -b $A -X DELETE $B/api/drivers/nadia | jq "d['ok']") $(code -b $N $B/api/me) $(code -b $N -H 'Content-Type: application/json' -X POST $B/api/driver-location -d '{"lat":1,"lng":1}')" "True 401 401"
  chk "  the office's own session is untouched by all of it" "$(code -b $A $B/api/data)" "200"
  chk "  the office is told which logins still use a published default (oscar is no longer one)" \
    "$(curl -s -b $A $B/healthz | jq "'oscar' in d['security']['accountsOnDefaultPassword'], 'joshua' in d['security']['accountsOnDefaultPassword']")" "False True"
  rm -f $A $A2 $N $N2
}

stop; rm -f data.json data-ids.json telemetry.json
start VBT_FORCE_PASSWORD_CHANGE=1
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
  start VBT_FORCE_PASSWORD_CHANGE=1 DATABASE_URL=$DBURL SESSION_SECRET=test-session-secret
  suite "Postgres"
  S=$(mktemp); login $S oscar 'Gravel-Haul-99' >/dev/null
  chk "Postgres: a revoked session stays revoked across a restart (its row is deleted, not only forgotten in memory)" \
    "$(curl -s -b $S -H 'Content-Type: application/json' -X POST $B/api/account/password -d '{"current":"Gravel-Haul-99","next":"Gravel-Haul-11"}' | jq "d['ok']") $(T=$(mktemp); login $T oscar 'Gravel-Haul-11' >/dev/null; curl -s -b $T -H 'Content-Type: application/json' -X POST $B/api/account/password -d '{"current":"Gravel-Haul-11","next":"Gravel-Haul-22"}' -o /dev/null; stop; start VBT_FORCE_PASSWORD_CHANGE=1 DATABASE_URL=$DBURL SESSION_SECRET=test-session-secret; echo "$(code -b $S $B/api/me) $(code -b $T $B/api/me)"; rm -f $T)" "True 401 200"
  # Admin vs manager, and the owner's remote fix for a login still on a default.
  psql -q -h /tmp -p $PGPORT -U vbt vbt_auth -c "UPDATE users SET role='manager' WHERE username='perla'" >/dev/null
  stop; start VBT_FORCE_PASSWORD_CHANGE=1 DATABASE_URL=$DBURL SESSION_SECRET=test-session-secret PERLA_PASS=Perla-Private-55 OSCAR_PASS=Should-Not-Apply-1
  P=$(mktemp); O=$(mktemp)
  chk "PERLA_PASS set in the environment: a login still on its published default moves to it at boot — the default is dead, the new one signs in with no hold" \
    "$(login $P perla perla123) $(login $P perla Perla-Private-55)" "/login?error=1 /app/"
  chk "  …and the boot log says so" "$(grep -c '"perla" was still on a published default password' /tmp/vbt-auth.log)" "1"
  chk "  a password someone chose is never replaced from the environment (OSCAR_PASS is ignored for oscar)" \
    "$(login $O oscar Should-Not-Apply-1) $(login $O oscar Gravel-Haul-22)" "/login?error=1 /app/"
  chk "a manager runs the day: the board and the PO list answer" "$(code -b $P $B/api/today) $(code -b $P $B/api/data)" "200 200"
  chk "  …but cannot list or restore backups, set default rates, or connect / disconnect QuickBooks (403 each)" \
    "$(code -b $P $B/api/admin/backups) $(code -b $P -H 'Content-Type: application/json' -X POST $B/api/admin/restore -d '{"source":"store_prev"}') $(code -b $P -H 'Content-Type: application/json' -X PUT $B/api/default-rates -d '{"side":"customer","material":"Dirt","rate":1}') $(code -b $P $B/api/quickbooks/connect) $(code -b $P -X POST $B/api/quickbooks/disconnect)" "403 403 403 403 403"
  chk "  an admin still can (backups list answers)" "$(code -b $O $B/api/admin/backups)" "200"
  # A vehicle hold is cleared by an admin, not by a manager.
  curl -s -b $O -H 'Content-Type: application/json' -X POST $B/api/drivers -d '{"username":"dvir1","password":"dvir-private-1","displayName":"Dvir One"}' -o /dev/null
  DV=$(mktemp); login $DV dvir1 dvir-private-1 >/dev/null
  TK=$(curl -s -b $DV $B/api/shifts/current | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['trucks'][0]['id'])")
  ANS=$(curl -s -b $DV $B/api/shifts/current | python3 -c "import json,sys;d=json.load(sys.stdin);print(json.dumps({i:('defect' if i=='Brakes' else 'ok') for i in d['inspectionItems']}))")
  RID=$(curl -s -b $DV -H 'Content-Type: application/json' -X POST $B/api/shifts/start -d "{\"truckId\":\"$TK\",\"odometer\":10,\"inspection\":{\"answers\":$ANS,\"remarks\":\"no pedal\"},\"signature\":\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==\"}" | jq "d['report']['id']")
  chk "a truck held for a blocking defect: a manager sees the report but cannot record the clearance (403 clearance_admin_only); an admin can" \
    "$(curl -s -b $P $B/api/defect-reports | jq "d['held']") $(curl -s -b $P -H 'Content-Type: application/json' -X POST $B/api/defect-reports/$RID/resolve -d '{"decision":"corrected","by":"Hector","note":"new brake line"}' | jq "d['code']") $(curl -s -b $O -H 'Content-Type: application/json' -X POST $B/api/defect-reports/$RID/resolve -d '{"decision":"corrected","by":"Hector","note":"new brake line"}' | jq "d['report']['status'], d['report']['resolution']['recordedByRole']")" "1 clearance_admin_only cleared admin"
  rm -f $DV
  chk "the browser's favicon request is answered (it was the one 404 on every first visit)" "$(code $B/favicon.ico)" "200"
  rm -f $P $O
  stop
  # A first production start on an empty database never plants a published default.
  run "$PGB/createdb -h /tmp -p $PGPORT -U vbt vbt_fresh" >/dev/null 2>&1
  start NODE_ENV=production DATABASE_URL="postgres://vbt@localhost:$PGPORT/vbt_fresh?sslmode=disable" SESSION_SECRET=test-session-secret QB_ENCRYPTION_KEY=test-qb-key MATTHEW_PASS=Matthew-Private-9
  OT=$(grep -E '^    joshua: ' /tmp/vbt-auth.log | sed 's/^    joshua: //')
  chk "production, first start, empty database: the published default does not sign in; the one-time set-up password from the boot log does; a login with <NAME>_PASS uses that" \
    "$(curl -s -o /dev/null -w '%{redirect_url}' -H 'X-Forwarded-Proto: https' -X POST -d 'username=joshua&password=joshua123' $B/login | loc) $(curl -s -o /dev/null -w '%{redirect_url}' -H 'X-Forwarded-Proto: https' -X POST --data-urlencode "username=joshua" --data-urlencode "password=$OT" $B/login | loc) $(curl -s -o /dev/null -w '%{redirect_url}' -H 'X-Forwarded-Proto: https' -X POST -d 'username=matthew&password=Matthew-Private-9' $B/login | loc) $(grep -cE '^    matthew: ' /tmp/vbt-auth.log)" "/login?error=1 /app/ /app/ 0"
  stop
  start NODE_ENV=production DATABASE_URL="postgres://vbt@localhost:$PGPORT/vbt_fresh?sslmode=disable" SESSION_SECRET=test-session-secret QB_ENCRYPTION_KEY=test-qb-key
  chk "  the set-up passwords are printed once: a second start prints none and reports no login on a default" "$(grep -cE '^    joshua: |still open with a published default' /tmp/vbt-auth.log)" "0"
  stop
  start NODE_ENV=production DATABASE_URL=$DBURL SESSION_SECRET=test-session-secret QB_ENCRYPTION_KEY=test-qb-key HEALTH_TOKEN=monitor-token
  chk "production: the public /healthz is the verdict only — no error list, no store size, no integration detail" \
    "$(curl -s $B/healthz | jq "d['ok'], sorted(k for k in d if k in ('recentErrors','storeSummary','linxup','linxupApi','persistence','security','node'))")" "True []"
  chk "  a monitor presenting HEALTH_TOKEN gets the full report; a wrong token does not" \
    "$(curl -s -H 'X-Health-Token: monitor-token' $B/healthz | jq "'recentErrors' in d") $(curl -s -H 'X-Health-Token: monitor-tokem' $B/healthz | jq "'recentErrors' in d")" "True False"
  chk "  production holds a default-password sign-in without any switch, and asks for https only" \
    "$(curl -s -o /dev/null -w '%{redirect_url}' -H 'X-Forwarded-Proto: https' -X POST -d 'username=joshua&password=joshua123' $B/login | loc) $(curl -s -D - -o /dev/null $B/login | grep -ci '^strict-transport-security')" "/change-password 1"
  stop; rm -f $S
  run "$PGB/pg_ctl -D $D stop -m fast" >/dev/null 2>&1; rm -rf "$D"
else
  echo "  SKIP  Postgres section (binaries not found at $PGB)"
fi

echo; echo "auth: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
