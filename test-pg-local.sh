#!/usr/bin/env bash
# Run the full suite INCLUDING the Postgres data-safety section against a
# throwaway local cluster. Needs Postgres 16 binaries (apt: postgresql-16).
# Nothing here touches any real database: it initdb's into a temp dir.
set -u
PGB=${PGB:-/usr/lib/postgresql/16/bin}
[ -x "$PGB/initdb" ] || { echo "Postgres binaries not found at $PGB (set PGB=...)"; exit 2; }
D=$(mktemp -d /tmp/vbt-pg.XXXXXX); PGPORT=${PGPORT:-5499}
RUNAS=""; if [ "$(id -u)" = "0" ]; then id pgtest >/dev/null 2>&1 || useradd -m pgtest; chown pgtest "$D"; RUNAS="su pgtest -c"; fi
run() { if [ -n "$RUNAS" ]; then $RUNAS "$*"; else eval "$*"; fi; }
run "$PGB/initdb -D $D -U vbt --auth=trust -E UTF8" >/dev/null 2>&1 || { echo initdb failed; exit 2; }
run "$PGB/pg_ctl -D $D -o '-p $PGPORT -k /tmp' -l $D/log.txt start" >/dev/null || { echo pg start failed; exit 2; }
sleep 2
run "$PGB/createdb -h /tmp -p $PGPORT -U vbt vbt_test" >/dev/null 2>&1
export PATH="$PGB:$PATH"
export TEST_DATABASE_URL="postgres://vbt@localhost:$PGPORT/vbt_test?sslmode=disable"
bash "$(dirname "$0")/test-e2e.sh"; RC=$?
run "$PGB/pg_ctl -D $D stop -m fast" >/dev/null 2>&1
rm -rf "$D"
exit $RC
