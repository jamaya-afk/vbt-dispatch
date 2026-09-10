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

echo "── 0. The app actually opens in a browser ──"
# The whole suite once passed 73/73 while the site answered "Cannot GET /",
# because every check hit /api/* and none ever loaded a page. These do.
A=$(mktemp)   # anonymous, no session
chk "logged out, / redirects"      "$(curl -s -o /dev/null -w '%{http_code}' -c $A $B/)" "302"
chk "  ...to the login page"       "$(curl -s -o /dev/null -w '%{redirect_url}' -c $A $B/ | sed 's|.*//[^/]*||')" "/login"
chk "login page renders"           "$(curl -s -o /dev/null -w '%{http_code}' $B/login)" "200"
chk "logged out, /app/ is blocked" "$(curl -s -o /dev/null -w '%{http_code}' $B/app/)" "302"
# now with a real session
chk "logged in, / redirects to app" "$(curl -s -o /dev/null -w '%{redirect_url}' -b $M $B/ | sed 's|.*//[^/]*||')" "/app/"
chk "/app/ serves the app shell"    "$(curl -s -o /dev/null -w '%{http_code}' -b $M $B/app/)" "200"
chk "  ...and it is the real page"  "$(curl -s -b $M $B/app/ | grep -c 'id=\"sec-board\"')" "1"
chk "static assets serve"           "$(curl -s -o /dev/null -w '%{http_code}' -b $M $B/app/index.html)" "200"
chk "/api/me identifies the user"   "$(curl -s -b $M $B/api/me | python3 -c "import json,sys;print(json.load(sys.stdin)['username'])")" "joshua"

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

echo "── 8. Costing: confirmed 25 tons/load, no CY warning ──"
C=$(curl -s -b $M $B/api/costing/settings | python3 -c "
import json,sys;d=json.load(sys.stdin)
print(d['tonsPerLoadRule'])
print(len(d['needsAttention']))
print('cy' in [u['unit'] for u in d['unitsInUse']])
print(','.join(d['supportedUnits']))")
chk "tons per load rule"        "$(echo "$C"|sed -n 1p)" "25"
chk "nothing needs attention"   "$(echo "$C"|sed -n 2p)" "0"
chk "no CY unit in use"         "$(echo "$C"|sed -n 3p)" "False"
chk "supported units"           "$(echo "$C"|sed -n 4p)" "ton,load,hour,mile"

# $38/ton x 25 tons x 2 loads = $1900, and both screens must agree
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/pos -d '{
 "po":{"customer":"Cost Check","deliveryDate":"'"$(date +%F)"'"},
 "splits":[{"truckId":"matthew","material":"3/4 Rock","loadsAssigned":2,"vendorId":"vulcan"}]}' -o /dev/null
CL=$(curl -s -b $M $B/api/data | python3 -c "
import json,sys
print([l['id'] for l in json.load(sys.stdin)['loads'] if l['material']=='3/4 Rock' and l['truckId']=='matthew'][0])")
curl -s -b $M -H 'Content-Type: application/json' -X PUT $B/api/loads/$CL -d '{"loadsDelivered":2}' -o /dev/null
chk "profitability cost = 38x25x2" "$(curl -s -b $M $B/api/profitability | python3 -c "import json,sys;print(int(json.load(sys.stdin)['grand']['cost']))")" "1900"
chk "material-costs agrees"        "$(curl -s -b $M $B/api/material-costs | python3 -c "import json,sys;print(int(json.load(sys.stdin)['grandTotal']))")" "1900"
chk "cost not flagged incomplete"  "$(curl -s -b $M $B/api/profitability | python3 -c "import json,sys;print(json.load(sys.stdin)['grand']['costIncomplete'])")" "False"

echo "── 9. Quick Assign: today board + driver/truck/yard in one call ──"
T=$(curl -s -b $M $B/api/today | python3 -c "
import json,sys;d=json.load(sys.stdin)
print(len(d['loads'])); print(len(d['drivers'])); print(len(d['trucks'])); print(d['summary']['unassigned'])")
chk "today lists loads"    "$(echo "$T"|sed -n 1p)" "2"
chk "today lists drivers"  "$(echo "$T"|sed -n 2p)" "5"
chk "today lists trucks"   "$(echo "$T"|sed -n 3p)" "5"

# Truck must NOT be auto-assigned from the driver's historical truck
chk "no auto truck on new load" "$(curl -s -b $M $B/api/today | python3 -c "
import json,sys;print([l['truckNum'] for l in json.load(sys.stdin)['loads'] if l['id']=='$CL'][0] or 'NONE')")" "NONE"

# One call sets driver + truck + yard
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/$CL/assign \
  -d '{"driverId":"carlos","truckUnitId":"truck-2b","yardId":"cemex"}' -o /dev/null
Q=$(curl -s -b $M $B/api/today | python3 -c "
import json,sys
l=[x for x in json.load(sys.stdin)['loads'] if x['id']=='$CL'][0]
print(l['driverName']); print(l['truckNum']); print(l['yardName']); print(l['bucket'])")
chk "quick assign driver" "$(echo "$Q"|sed -n 1p)" "Carlos"
chk "quick assign truck"  "$(echo "$Q"|sed -n 2p)" "Truck #2B"
chk "quick assign yard"   "$(echo "$Q"|sed -n 3p)" "CEMEX"
# This load already has deliveries recorded above, so it correctly reads as
# in-progress rather than assigned — the bucket follows real trip state.
chk "bucket reflects trip state" "$(echo "$Q"|sed -n 4p)" "in-progress"

echo "── 10. Live refresh: version changes only when dispatch changes ──"
V1=$(curl -s -b $M $B/api/dispatch-version | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])")
V2=$(curl -s -b $M $B/api/dispatch-version | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])")
chk "version stable when nothing changes" "$([ "$V1" = "$V2" ] && echo same || echo differs)" "same"
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/$CL/assign -d '{"driverId":"rigo"}' -o /dev/null
V3=$(curl -s -b $M $B/api/dispatch-version | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])")
chk "version changes after reassign" "$([ "$V1" != "$V3" ] && echo changed || echo same)" "changed"

echo "── 11. Driver sees only their own current workday ──"
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/pos -d '{
 "po":{"customer":"Future Job","deliveryDate":"2099-01-01"},
 "splits":[{"truckId":"rigo","material":"Gravel","loadsAssigned":1,"vendorId":"vbt"}]}' -o /dev/null
R=$(mktemp); curl -s -c $R -X POST -d "username=rigo&password=rigo123" $B/login -o /dev/null
RD=$(curl -s -b $R $B/api/my-dispatch | python3 -c "
import json,sys;ls=json.load(sys.stdin)['loads']
print(len(ls)); print(','.join(sorted(set(l['jobName'] for l in ls))))")
chk "future-dated load hidden from driver" "$(echo "$RD"|sed -n 2p)" "Cost Check"
chk "driver sees only today's work"        "$(echo "$RD"|sed -n 1p)" "1"

echo "── 12. Persistence is reported honestly ──"
P=$(curl -s $B/healthz | python3 -c "
import json,sys;d=json.load(sys.stdin)
print(d['persistence']['mode']); print(d['persistence']['durable'])")
chk "persistence mode reported" "$(echo "$P"|sed -n 1p)" "file"
chk "file mode flagged NOT durable" "$(echo "$P"|sed -n 2p)" "False"
chk "dispatcher gets a warning" "$(curl -s -b $M $B/api/persistence | python3 -c "
import json,sys;print('yes' if json.load(sys.stdin)['warning'] else 'no')")" "yes"

echo "── 13. Bad requests return errors, never crash the server ──"
curl -s -o /dev/null -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/NOPE/assign -d '{"driverId":"carlos"}'
chk "unknown load -> 404" "$(curl -s -o /dev/null -w '%{http_code}' -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/NOPE/assign -d '{"driverId":"carlos"}')" "404"
chk "unknown driver -> 400" "$(curl -s -o /dev/null -w '%{http_code}' -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/$CL/assign -d '{"driverId":"ghost"}')" "400"
chk "unknown truck -> 400" "$(curl -s -o /dev/null -w '%{http_code}' -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/$CL/assign -d '{"truckUnitId":"ghost"}')" "400"
chk "garbage JSON does not crash" "$(curl -s -o /dev/null -w '%{http_code}' -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/$CL/assign -d 'not json')" "400"
chk "server still alive after bad requests" "$(curl -s -o /dev/null -w '%{http_code}' $B/healthz)" "200"

echo "── 14. Customer notifications: silent by default, never blocking ──"
N=$(curl -s -b $M $B/api/notifications/status | python3 -c "
import json,sys;d=json.load(sys.stdin)
print(d['mailer']['configured']); print(d['mailer']['dryRun']); print(d['posEnabled'])")
chk "gmail unconfigured in test env" "$(echo "$N"|sed -n 1p)" "False"
chk "dry run is the default"         "$(echo "$N"|sed -n 2p)" "True"
chk "no PO has updates on"           "$(echo "$N"|sed -n 3p)" "0"

# Regression: a PO created after boot had no notification settings, and the
# resulting async throw left the request HANGING instead of erroring.
chk "settings on a PO created after boot" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -b $M $B/api/pos/$(curl -s -b $M $B/api/data | python3 -c "
import json,sys;print([p['id'] for p in json.load(sys.stdin)['pos'] if p['customer']=='Cost Check'][0])")/notifications)" "200"
chk "unknown PO answers, does not hang" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -b $M $B/api/pos/NOPE/notifications)" "404"

PO1=$(curl -s -b $M $B/api/data | python3 -c "
import json,sys;print([p['id'] for p in json.load(sys.stdin)['pos'] if p['customer']=='ABC Construction'][0])")
# Arming with no contact must be refused — otherwise the dispatcher believes
# the customer is informed and nothing is going anywhere.
chk "cannot arm with no contact -> 400" "$(curl -s -o /dev/null -w '%{http_code}' -b $M -H 'Content-Type: application/json' -X PUT $B/api/pos/$PO1/notifications -d '{"enabled":true}')" "400"
chk "invalid email rejected -> 400"     "$(curl -s -o /dev/null -w '%{http_code}' -b $M -H 'Content-Type: application/json' -X PUT $B/api/pos/$PO1/notifications -d '{"contacts":[{"email":"nope"}]}')" "400"
curl -s -b $M -H 'Content-Type: application/json' -X PUT $B/api/pos/$PO1/notifications \
  -d '{"contacts":[{"name":"John","email":"john@abcconstruction.com"}],"events":{"delivered":true,"loaded":true},"enabled":true}' -o /dev/null
chk "updates now on for that PO" "$(curl -s -b $M $B/api/notifications/status | python3 -c "import json,sys;print(json.load(sys.stdin)['posEnabled'])")" "1"

# A driver step must still succeed with mail unconfigured, and be logged
NPO=$(curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/pos -d '{
 "po":{"customer":"ABC Construction","deliveryDate":"'"$(date +%F)"'","city":"Fresno"},
 "splits":[{"truckId":"leonardo","material":"Gravel","loadsAssigned":1,"vendorId":"vbt"}]}' | python3 -c "import json,sys;print(json.load(sys.stdin)['po']['id'])")
curl -s -b $M -H 'Content-Type: application/json' -X PUT $B/api/pos/$NPO/notifications \
  -d '{"contacts":[{"email":"john@abcconstruction.com"}],"events":{"loaded":true,"delivered":true},"enabled":true}' -o /dev/null
NL=$(curl -s -b $M $B/api/data | python3 -c "
import json,sys;print([l['id'] for l in json.load(sys.stdin)['loads'] if l['truckId']=='leonardo'][0])")
L=$(mktemp); curl -s -c $L -X POST -d "username=leonardo&password=leo123" $B/login -o /dev/null
curl -s -b $L -H 'Content-Type: application/json' -X POST $B/api/loads/$NL/trip-action -d '{"action":"start-trip"}' -o /dev/null
curl -s -b $L -H 'Content-Type: application/json' -X POST $B/api/loads/$NL/trip-action -d '{"action":"arrived-pickup","yardId":"vbt"}' -o /dev/null
chk "driver step succeeds with mail unconfigured" "$(curl -s -o /dev/null -w '%{http_code}' -b $L -H 'Content-Type: application/json' -X POST $B/api/loads/$NL/trip-action -d '{"action":"loaded"}')" "200"
sleep 1
# Two milestones passed: arrivedPickup (not selected -> skipped) and
# loaded (selected, but Gmail unconfigured -> failed). Nothing may report 'sent'.
NLOG=$(curl -s -b $M "$B/api/notifications/log?loadId=$NL" | python3 -c "
import json,sys;d=json.load(sys.stdin)['items']
st={e['event']:e['status'] for e in d}
print(len(d)); print(st.get('loaded')); print(st.get('arrivedPickup'))
print('yes' if any(e['status']=='sent' for e in d) else 'no')")
chk "both milestones recorded"          "$(echo "$NLOG"|sed -n 1p)" "2"
chk "selected event tried and failed"   "$(echo "$NLOG"|sed -n 2p)" "failed"
chk "unselected event skipped"          "$(echo "$NLOG"|sed -n 3p)" "skipped"
chk "nothing falsely reported as sent"  "$(echo "$NLOG"|sed -n 4p)" "no"
chk "server alive after notify"   "$(curl -s -o /dev/null -w '%{http_code}' $B/healthz)" "200"

echo "── 15. Single company: no SaaS surface ──"
chk "no /signup"                "$(curl -s -o /dev/null -w '%{http_code}' $B/signup)" "404"
chk "no stripe checkout"        "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/stripe/checkout)" "404"
chk "no stripe portal"          "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/stripe/portal)" "404"
chk "no stripe webhook"         "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/stripe/webhook)" "404"
chk "no subscription status"    "$(curl -s -o /dev/null -w '%{http_code}' -b $M $B/api/subscription-status)" "404"

echo "── 16. Deleting a PO (clearing test data) ──"
TPO=$(curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/pos -d '{
 "po":{"poNumber":"ZZ-TESTING","customer":"scratch","deliveryDate":"'"$(date +%F)"'"},
 "splits":[{"truckId":"carlos","material":"Fill Sand","loadsAssigned":2,"vendorId":"vbt"}]}' \
 | python3 -c "import json,sys;print(json.load(sys.stdin)['po']['id'])")
BEFORE=$(curl -s -b $M $B/api/data | python3 -c "import json,sys;print(len(json.load(sys.stdin)['pos']))")
chk "test PO deleted"      "$(curl -s -o /dev/null -w '%{http_code}' -b $M -X DELETE $B/api/pos/$TPO)" "200"
AFTER=$(curl -s -b $M $B/api/data | python3 -c "import json,sys;print(len(json.load(sys.stdin)['pos']))")
chk "PO count dropped by 1" "$((BEFORE-AFTER))" "1"
chk "its loads went too"    "$(curl -s -b $M $B/api/data | python3 -c "
import json,sys;print(len([l for l in json.load(sys.stdin)['loads'] if l['poId']=='$TPO']))")" "0"
# The PO holding the approved load from step 6 must be protected
APO=$(curl -s -b $M $B/api/data | python3 -c "
import json,sys;d=json.load(sys.stdin)
print([l['poId'] for l in d['loads'] if l.get('approvalStatus')=='approved'][0])")
chk "PO with approved load refuses delete" "$(curl -s -o /dev/null -w '%{http_code}' -b $M -X DELETE $B/api/pos/$APO)" "403"
chk "that PO is still there" "$(curl -s -b $M $B/api/data | python3 -c "
import json,sys;print(len([p for p in json.load(sys.stdin)['pos'] if p['id']=='$APO']))")" "1"

echo "── 17. Drivers and vehicles are not the same list ──"
# A branch merge left both the driver roster and the vehicle fleet writing into
# store.trucks, so the PO form's Driver dropdown listed truck ids and every new
# load came out with a blank driver name. These keep them apart.
DT=$(curl -s -b $M $B/api/data | python3 -c "
import json,sys;d=json.load(sys.stdin)
print(','.join(sorted(t['id'] for t in d['trucks'])))
print(','.join(sorted(t['id'] for t in d.get('fleet',[]))))
print('yes' if any(str(t['id']).startswith('truck-') for t in d['trucks']) else 'no')")
chk "driver dropdown holds people"  "$(echo "$DT"|sed -n 1p)" "beryle,carlos,leonardo,matthew,rigo"
chk "fleet holds vehicles"          "$(echo "$DT"|sed -n 2p)" "truck-12,truck-14,truck-2,truck-2b,truck-4"
chk "no vehicle in driver dropdown" "$(echo "$DT"|sed -n 3p)" "no"
# A PO created with a driver + a truck must record BOTH
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/pos -d '{
 "po":{"poNumber":"DRV-CHK","customer":"driver check","deliveryDate":"'"$(date +%F)"'"},
 "splits":[{"truckId":"carlos","truckUnitId":"truck-14","material":"Fill Sand","loadsAssigned":1,"vendorId":"vbt"}]}' -o /dev/null
DC=$(curl -s -b $M $B/api/data | python3 -c "
import json,sys;d=json.load(sys.stdin)
po=[p for p in d['pos'] if p['poNumber']=='DRV-CHK'][0]
l=[x for x in d['loads'] if x['poId']==po['id']][0]
print(l.get('driverName') or 'BLANK'); print(l.get('truckUnitId') or 'NONE')")
chk "new load records the driver name" "$(echo "$DC"|sed -n 1p)" "Carlos"
chk "new load records the truck"       "$(echo "$DC"|sed -n 2p)" "truck-14"

echo "── 18. Fleet is independent of drivers ──"
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
