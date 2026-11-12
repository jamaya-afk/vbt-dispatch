#!/usr/bin/env bash
# Sample documents from a realistic day: the Cornelio packet of 14 Sep 2026
# (Truck #3, trailer 3B; VBT → Vulcan Madera → North Fork, four loads of 3/4"
# Class 2 Base for Dave Christian Construction; a pea-gravel pre-load on PO
# 3298; 75 gal of fuel; 85,558 → 85,868). Every record is entered through the
# same API the phone and the office use; the documents are then rendered from
# those records and saved as PDF + PNG for a person to inspect.
#
#   bash sample-documents.sh [output-dir]      (default: ./sample-documents)
#   TICKET_DIR=dir-with-ticket-1.jpg..4.jpg     optional real scale-ticket photos
#
# File mode, port 4670, test hooks on (used only to set the day's clock times,
# which a real day gets from the taps). Stops any running server; resets
# data.json. Needs Playwright (NODE_PATH) and Chromium to save the pages.
set -u
export PORT=${PORT:-4670}
B=http://localhost:$PORT
OUT=${1:-sample-documents}
cd "$(dirname "$0")"; mkdir -p "$OUT"
J='Content-Type: application/json'
jq() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)" 2>/dev/null; }
pkill -f '^node server.js' >/dev/null 2>&1; sleep 1; rm -f data.json data-ids.json telemetry.json
(VBT_TEST_HOOKS=1 node server.js > /tmp/vbt-sample.log 2>&1 &)
for i in $(seq 1 20); do sleep 1; curl -sf $B/healthz >/dev/null 2>&1 && break; done
M=$(mktemp); CD=$(mktemp)
curl -s -c $M -X POST -d "username=joshua&password=joshua123" $B/login -o /dev/null
mg() { curl -s -b $M -H "$J" -X "$1" "$B$2" -d "${3:-{\}}"; }
dr() { curl -s -b $CD -H "$J" -X "$1" "$B$2" -d "${3:-{\}}"; }
TODAY=$(TZ=America/Los_Angeles date +%F); OFF=$(TZ=America/Los_Angeles date +%:z)
at() { echo "${TODAY}T$1:00$OFF"; }                       # yard-local clock time today
utc() { date -u -d "$(at $1)" +%FT%T.000Z; }
# Images: a drawn signature, and the scale-ticket photos (real scans when given).
sig() { python3 - "$1" <<'PY'
import base64,sys
name=sys.argv[1]
svg=f'<svg xmlns="http://www.w3.org/2000/svg" width="420" height="130"><rect width="420" height="130" fill="#fff"/><path d="M20 90 C 60 20, 90 120, 130 60 S 190 30, 220 80 S 300 110, 390 40" stroke="#123" stroke-width="3" fill="none"/><text x="20" y="122" font-family="sans-serif" font-size="12" fill="#666">{name}</text></svg>'
print('data:image/svg+xml;base64,'+base64.b64encode(svg.encode()).decode())
PY
}
tphoto() { # $1 = n, $2 = ticket number, $3 = tons
  if [ -n "${TICKET_DIR:-}" ] && [ -f "$TICKET_DIR/ticket-$1.jpg" ]; then echo "data:image/jpeg;base64,$(base64 -w0 "$TICKET_DIR/ticket-$1.jpg")"; return; fi
  python3 - "$2" "$3" <<'PY'
import base64,sys
n,t=sys.argv[1],sys.argv[2]
svg=f'<svg xmlns="http://www.w3.org/2000/svg" width="520" height="300"><rect width="520" height="300" fill="#fff" stroke="#333"/><text x="20" y="40" font-family="sans-serif" font-size="22" font-weight="bold">Vulcan Materials — Austin Quarry</text><text x="20" y="80" font-family="monospace" font-size="18">Ticket No {n}</text><text x="20" y="110" font-family="monospace" font-size="16">3/4IN CL 2 BASE   NET TONS {t}</text><text x="20" y="140" font-family="monospace" font-size="14">CHRISTIAN CONSTRUCTION / DAVE   PO 25031</text><text x="20" y="280" font-family="sans-serif" font-size="11" fill="#888">(sample image standing in for the scale-ticket photo)</text></svg>'
print('data:image/svg+xml;base64,'+base64.b64encode(svg.encode()).decode())
PY
}
body() { python3 -c "import json,sys;print(json.dumps(json.loads(sys.argv[1]) | {k: v for k, v in zip(sys.argv[2::2], sys.argv[3::2])}))" "$@"; }

# ── Masters ──
mg POST /api/drivers '{"username":"cornelio","password":"cornelio-sample-1","displayName":"Cornelio"}' >/dev/null
T3=$(mg POST /api/fleet/trucks '{"truckNum":"Truck #3","type":"End Dump"}' | jq "d['truck']['id']")
TR=$(mg POST /api/fleet/trailers "{\"number\":\"3B\",\"type\":\"Transfer\",\"defaultTruckId\":\"$T3\"}" | jq "d['trailer']['id']")
VM=$(mg POST /api/vendors '{"name":"Vulcan Madera","location":"40450 East Highway 145, Madera, CA","force":true}' | jq "d['vendor']['id']")
mg POST /api/customers '{"name":"Dave Christian Construction","city":"North Fork"}' >/dev/null
mg POST /api/customer-prices '{"customer":"Dave Christian Construction","material":"3/4 Class 2 Base","unit":"ton","price":30}' >/dev/null
mg POST /api/customers '{"name":"Valley Best (yard stock)","city":"Fowler"}' >/dev/null
# ── Dispatch: entered once, by the office ──
mg POST /api/pos "{\"po\":{\"poNumber\":\"25031\",\"customer\":\"Dave Christian Construction\",\"job\":\"CCC Campus Development\",\"deliveryDate\":\"$TODAY\",\"address\":\"CCC Campus\",\"city\":\"North Fork\",\"plannedVendorId\":\"$VM\"},\"splits\":[{\"truckId\":\"cornelio\",\"truckUnitId\":\"$T3\",\"trailerId\":\"$TR\",\"material\":\"3/4 Class 2 Base\",\"loadsAssigned\":4,\"vendorId\":\"$VM\"}]}" >/dev/null
mg POST /api/pos "{\"po\":{\"poNumber\":\"3298\",\"customer\":\"Valley Best (yard stock)\",\"job\":\"Pre-load\",\"deliveryDate\":\"$TODAY\",\"address\":\"7929 E Manning Ave\",\"city\":\"Fowler\",\"plannedVendorId\":\"vbt\"},\"splits\":[{\"truckId\":\"cornelio\",\"truckUnitId\":\"$T3\",\"trailerId\":\"$TR\",\"material\":\"Pea Gravel\",\"loadsAssigned\":1,\"vendorId\":\"vbt\"}]}" >/dev/null
lid() { mg GET /api/data | jq "[l['id'] for l in d['loads'] if l['poId']==[p['id'] for p in d['pos'] if p['poNumber']=='$1'][0]][0]"; }
CL=$(lid 25031); PL=$(lid 3298)
# ── The driver's day, tap by tap ──
curl -s -c $CD -X POST -d "username=cornelio&password=cornelio-sample-1" $B/login -o /dev/null
ITEMS=$(curl -s -b $CD $B/api/shifts/current | python3 -c "import json,sys;print(json.dumps({i:'ok' for i in json.load(sys.stdin)['inspectionItems']}))")
SH=$(dr POST /api/shifts/start "{\"truckId\":\"$T3\",\"trailerId\":\"$TR\",\"odometer\":85558,\"inspection\":{\"answers\":$ITEMS},\"signature\":\"$(sig Cornelio)\"}" | jq "d['shift']['id']")
ca() { dr POST /api/loads/$CL/trip-action "$1"; }
ca '{"action":"start-trip"}' >/dev/null
FS=$(ca "{\"action\":\"arrived-pickup\",\"yardId\":\"$VM\",\"odometer\":85591}" | jq "d['load']['freightSegmentId']")
n=0; for tk in "37432733 23.20" "37432798 23.19" "37432862 24.45" "37432920 23.80"; do set -- $tk; n=$((n+1))
  [ $n -gt 1 ] && { ca '{"action":"start-trip"}' >/dev/null; ca "{\"action\":\"arrived-pickup\",\"yardId\":\"$VM\"}" >/dev/null; }
  ca "{\"action\":\"loaded\",\"ticket\":{\"source\":\"supplier\",\"number\":\"$1\",\"netTons\":$2,\"photo\":\"$(tphoto $n $1 $2)\"}}" >/dev/null
  ca '{"action":"arrived-jobsite"}' >/dev/null; ca '{"action":"trip-complete"}' >/dev/null
done
dr PUT /api/loads/$CL "{\"pod\":{\"signedBy\":\"D. Christian (foreman)\",\"signature\":\"$(sig 'D. Christian')\"}}" >/dev/null
ca '{"action":"delivered"}' >/dev/null
dr POST /api/freight-segments/$FS/close '{"odometer":85808}' >/dev/null
dr POST /api/shifts/$SH/fuel '{"gallons":75,"yardId":"vbt"}' >/dev/null
# The pre-load: loaded at the VBT yard for tomorrow — a ticket, no delivery today.
dr POST /api/loads/$PL/trip-action '{"action":"start-trip"}' >/dev/null
dr POST /api/loads/$PL/trip-action '{"action":"arrived-pickup","yardId":"vbt"}' >/dev/null
dr POST /api/loads/$PL/trip-action '{"action":"loaded","ticket":{"source":"vbt","number":"4721"}}' >/dev/null
END=$(dr POST /api/shifts/$SH/end '{"odometer":85868}')
echo "end day: $(echo "$END" | jq "d.get('success'), d.get('error'), d.get('code')")"
# The clock: a real day gets these from the taps. Here the whole day ran in
# seconds, so the times of the paper are set (test hook for the shift; the
# office's audited correction for the freight, as it would do from a paper log).
mg POST /api/_test/set-shift "{\"id\":\"$SH\",\"patch\":{\"startAt\":\"$(utc 05:30)\",\"endAt\":\"$(utc 17:00)\",\"breaks\":[{\"startAt\":\"$(utc 12:00)\",\"endAt\":\"$(utc 12:30)\"}]}}" >/dev/null
mg PUT /api/freight-segments/$FS "{\"timeStart\":\"$(at 06:30)\",\"timeEnd\":\"$(at 15:00)\",\"reason\":\"times from the driver's paper log\"}" >/dev/null
SIGN=$(dr POST /api/daily-log/sign "{\"date\":\"$TODAY\",\"signature\":\"$(sig Cornelio)\"}")
echo "daily log signed: $(echo "$SIGN" | jq "d['log']['status']") $(echo "$SIGN" | jq "d.get('error')")"
# ── The office: approve, batch ──
AP=$(mg POST /api/loads/$CL/approve '{}'); echo "approve: $(echo "$AP" | jq "d.get('success'), d.get('error')")"
BID=$(mg POST /api/billing-batches "{\"loadIds\":[\"$CL\"]}" | jq "d['batches'][0]['id']")
echo "ids: shift=$SH freight=$FS load=$CL preload=$PL batch=$BID"
cat > "$OUT/ids.txt" <<EOF
shift=$SH
freight=$FS
load=$CL
preload=$PL
batch=$BID
date=$TODAY
EOF
# ── Render ──
cat > "$OUT/.render.js" <<'JS'
const { chromium } = require('playwright');
(async () => {
  const [B, out, date, fs, cl, pl, bid] = process.argv.slice(2);
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1000, height: 1300 } }); const p = await ctx.newPage();
  await p.goto(B + '/login'); await p.fill('input[name=username]', 'joshua'); await p.fill('input[name=password]', 'joshua123'); await p.click('button'); await p.waitForURL('**/app/');
  const docs = { 'daily-log': `/api/daily-log/print?driverId=cornelio&date=${date}`, 'freight-bill': `/api/freight-segments/${fs}/freight-bill`, 'delivery-ticket': `/api/loads/${cl}/delivery-ticket`,
    'delivery-ticket-preload': `/api/loads/${pl}/delivery-ticket`, 'freight-packet': `/api/freight-segments/${fs}/packet`, 'billing-packet': `/api/billing-batches/${bid}/packet` };
  for (const [name, url] of Object.entries(docs)) {
    const r = await p.goto(B + url); await p.waitForTimeout(400);
    await p.screenshot({ path: `${out}/${name}.png`, fullPage: true });
    await p.pdf({ path: `${out}/${name}.pdf`, format: 'Letter', printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '8mm', right: '8mm' } });
    console.log(`  ${name}: HTTP ${r.status()} → ${name}.pdf, ${name}.png`);
  }
  await b.close();
})();
JS
NODE_PATH=${NODE_PATH:-/opt/node-tools/node_modules} node "$OUT/.render.js" "$B" "$OUT" "$TODAY" "$FS" "$CL" "$PL" "$BID"
rm -f "$OUT/.render.js" $M $CD
[ -n "${KEEP:-}" ] && { echo "KEEP: server left running on $PORT"; exit 0; }
pkill -f '^node server.js' >/dev/null 2>&1; rm -f data.json data-ids.json telemetry.json
echo "documents in $OUT/"
