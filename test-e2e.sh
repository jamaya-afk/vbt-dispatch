#!/usr/bin/env bash
# Valley Best end-to-end dispatch test.
# Realistic scenario: one PO, 3 loads, driver rotates yards VBT -> Vulcan -> VBT.
# Verifies pickup yard, truck, per-trip storage, analytics trip counts,
# approval, Ready to Bill, and duplicate-billing protection.
set -u
export PORT=${PORT:-4600}
B=http://localhost:$PORT
M=$(mktemp); D=$(mktemp)
PASS=0; FAIL=0
chk() { # chk "name" actual expected
  if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; PASS=$((PASS+1));
  else echo "  FAIL  $1 — got '$2' want '$3'"; FAIL=$((FAIL+1)); fi
}

cd "$(dirname "$0")"
rm -f data.json
(node server.js > /tmp/vbt-test.log 2>&1 &)
for i in $(seq 1 20); do sleep 1; curl -sf $B/healthz >/dev/null 2>&1 && break; done

curl -s -c $M -X POST -d "username=joshua&password=joshua123" $B/login -o /dev/null

echo "── 1. PO with 3 loads, driver beryle, truck #12 (NOT his usual truck) ──"
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/pos -d '{
 "po":{"customer":"ABC Construction","deliveryDate":"'"$(date +%F)"'","address":"123 Main St","city":"Fresno","notes":"Gate 4455"},
 "splits":[{"truckId":"beryle","truckUnitId":"truck-12","material":"3/4 Rock","loadsAssigned":3,"vendorId":"vbt"}]}' -o /dev/null

LOAD=$(curl -s -b $M $B/api/data | python3 -c "import json,sys;print(json.load(sys.stdin)['loads'][0]['id'])")
echo "  load = $LOAD"

echo "── 2. Driver view: correct yard / truck / job ──"
curl -s -c $D -X POST -d "username=beryle&password=beryle123" $B/login -o /dev/null
DV=$(curl -s -b $D $B/api/my-dispatch)
chk "pickup yard is VBT Yard" "$(echo "$DV" | python3 -c "import json,sys;print(json.load(sys.stdin)['loads'][0]['pickupLocation'])")" "VBT Yard"
chk "truck is #12 not driver's usual #2" "$(echo "$DV" | python3 -c "import json,sys;print(json.load(sys.stdin)['loads'][0]['truckLabel'])")" "Truck #12"
chk "job name" "$(echo "$DV" | python3 -c "import json,sys;print(json.load(sys.stdin)['loads'][0]['jobName'])")" "ABC Construction"

echo "── 3. Run 3 trips: VBT -> Vulcan -> VBT ──"
run_trip() { # run_trip <yardId>
  curl -s -b $D -H 'Content-Type: application/json' -X POST $B/api/loads/$LOAD/trip-action -d '{"action":"start-trip","gps":{"lat":36.70,"lng":-119.70}}' -o /dev/null
  curl -s -b $D -H 'Content-Type: application/json' -X POST $B/api/loads/$LOAD/trip-action -d "{\"action\":\"arrived-pickup\",\"yardId\":\"$1\",\"gps\":{\"lat\":36.71,\"lng\":-119.71}}" -o /dev/null
  for A in loaded arrived-jobsite trip-complete; do
    curl -s -b $D -H 'Content-Type: application/json' -X POST $B/api/loads/$LOAD/trip-action -d "{\"action\":\"$A\",\"gps\":{\"lat\":36.72,\"lng\":-119.72}}" -o /dev/null
  done
}
run_trip vbt; run_trip vulcan; run_trip vbt

S=$(curl -s -b $M $B/api/data | python3 -c "
import json,sys
l=json.load(sys.stdin)['loads'][0]
t=l.get('trips',[])
print(len(t))
print(','.join(str(x.get('actualYardId')) for x in t))
print(l['loadsDelivered'])
print(all(len(x.get('gps',{}))>=5 for x in t))
print(all(len(x.get('timestamps',{}))==5 for x in t))")
chk "3 trips stored separately" "$(echo "$S"|sed -n 1p)" "3"
chk "per-trip yards preserved"  "$(echo "$S"|sed -n 2p)" "vbt,vulcan,vbt"
chk "loadsDelivered"            "$(echo "$S"|sed -n 3p)" "3"
chk "GPS attached to every trip" "$(echo "$S"|sed -n 4p)" "True"
chk "5 timestamps on every trip" "$(echo "$S"|sed -n 5p)" "True"

echo "── 4. Analytics count ALL 3 trips (the P1 fix) ──"
A=$(curl -s -b $M "$B/api/duration-analytics" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d['overall'].get('matchedTrips'))
print(d['overall']['startToYard']['count'])
print(len(d['byYard']))
print(sum(g['trips'] for g in d['byYard']))
print(','.join(sorted(g['label']+':'+str(g['trips']) for g in d['byYard'])))")
chk "overall matchedTrips"          "$(echo "$A"|sed -n 1p)" "3"
chk "startToYard sample count"      "$(echo "$A"|sed -n 2p)" "3"
chk "two distinct yards in byYard"  "$(echo "$A"|sed -n 3p)" "2"
chk "byYard trips sum"              "$(echo "$A"|sed -n 4p)" "3"
echo "        yard split: $(echo "$A"|sed -n 5p)"

echo "── 5. Reassign yard mid-job (dispatcher on phone) ──"
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/$LOAD/assign -d '{"yardId":"cemex"}' -o /dev/null
chk "driver now sees CEMEX" "$(curl -s -b $D $B/api/my-dispatch | python3 -c "
import json,sys
ls=json.load(sys.stdin)['loads']
print(ls[0]['pickupLocation'] if ls else 'GONE')")" "CEMEX"
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/$LOAD/assign -d '{"yardId":"vbt"}' -o /dev/null

echo "── 6. Ticket, signature, submit, approve ──"
PNG="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
curl -s -b $D -H 'Content-Type: application/json' -X PUT $B/api/loads/$LOAD \
  -d "{\"ticketImage\":\"$PNG\",\"pod\":{\"signedBy\":\"Foreman\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null
curl -s -b $D -H 'Content-Type: application/json' -X POST $B/api/loads/$LOAD/trip-action -d '{"action":"delivered"}' -o /dev/null
chk "submitted for approval" "$(curl -s -b $M $B/api/data | python3 -c "import json,sys;print(json.load(sys.stdin)['loads'][0]['approvalStatus'])")" "submitted"
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/$LOAD/approve -d '{}' -o /dev/null
chk "approved" "$(curl -s -b $M $B/api/data | python3 -c "import json,sys;print(json.load(sys.stdin)['loads'][0]['approvalStatus'])")" "approved"
chk "in Ready to Bill" "$(curl -s -b $M $B/api/ready-to-bill | python3 -c "import json,sys;print(len(json.load(sys.stdin)['items']))")" "1"

echo "── 7. QuickBooks batch + duplicate-billing protection ──"
chk "batch created" "$(curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/billing-batches -d "{\"loadIds\":[\"$LOAD\"]}" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('batches',[])))")" "1"
chk "server survived batch call" "$(curl -s -o /dev/null -w '%{http_code}' $B/healthz)" "200"
chk "double-bill blocked (409)" "$(curl -s -o /dev/null -w '%{http_code}' -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/bill -d "{\"loadIds\":[\"$LOAD\"]}")" "409"
chk "QuickBooks status endpoint alive" "$(curl -s -o /dev/null -w '%{http_code}' -b $M $B/api/quickbooks/status)" "200"

echo "── 8. Fleet is independent of drivers ──"
F=$(curl -s -b $M $B/api/fleet | python3 -c "
import json,sys;d=json.load(sys.stdin)
print(len(d['trucks'])); print(len(d['drivers']))")
chk "5 trucks seeded" "$(echo "$F"|sed -n 1p)" "5"
chk "5 drivers seeded" "$(echo "$F"|sed -n 2p)" "5"

pkill -f "node server.js" >/dev/null 2>&1
rm -f data.json
echo
echo "════ $PASS passed, $FAIL failed ════"
[ "$FAIL" -eq 0 ]
