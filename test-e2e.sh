#!/usr/bin/env bash
# Valley Best end-to-end dispatch test.
# Realistic scenario: one PO, 3 loads, driver rotates yards VBT -> Vulcan -> VBT.
# Verifies pickup yard, truck, per-trip storage, analytics trip counts,
# approval, Ready to Bill, and duplicate-billing protection.
set -u
export PORT=${PORT:-4600}
B=http://localhost:$PORT
M=$(mktemp); D=$(mktemp)
PASS=0; FAIL=0; SKIPPED=0
chk() { # chk "name" actual expected
  if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; PASS=$((PASS+1));
  else echo "  FAIL  $1 — got '$2' want '$3'"; FAIL=$((FAIL+1)); fi
}

cd "$(dirname "$0")"
rm -f data.json
(VBT_TEST_HOOKS=1 node server.js > /tmp/vbt-test.log 2>&1 &)
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

PNG="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
echo "── 0b. Fleet live status: derived from the workflow, never invented ──"
LD=$(mktemp); curl -s -c $LD -X POST -d "username=leonardo&password=leo123" $B/login -o /dev/null
fl() { curl -s -b $M $B/api/fleet/live | python3 -c "
import json,sys;d=json.load(sys.stdin);r=[x for x in d['trucks'] if x['driverId']=='leonardo'][0]
print($1)"; }
chk "drivers cannot call the fleet endpoint" "$(curl -s -b $LD -o /dev/null -w '%{http_code}' $B/api/fleet/live)" "403"
chk "anonymous is refused"                   "$(curl -s -o /dev/null -w '%{http_code}' $B/api/fleet/live)" "403"
chk "one row per active driver"              "$(curl -s -b $M $B/api/fleet/live | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['count'], len(d['trucks']), d['staleAfterSeconds'])")" "5 5 300"
chk "no work + no GPS: workflow Available, shown Offline, gps null" "$(fl "r['workflowKey'], r['statusKey'], r['live'], r['gps'], r['load']")" "available offline False None None"
curl -s -b $LD -H 'Content-Type: application/json' -X POST $B/api/driver-location -d '{"lat":36.7468,"lng":-119.7726,"accuracy":8}' -o /dev/null
chk "1. no current work + fresh GPS → Available" "$(fl "r['status'], r['live'], r['gps']['lat'], r['gps']['stale']")" "Available True 36.7468 False"
chk "   usual truck shown, flagged as not assigned" "$(fl "r['truckNum'], r['truckIsAssigned']")" "Truck #12 False"
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/pos -d '{
 "po":{"poNumber":"10482","customer":"ABC Materials","deliveryDate":"'"$(date +%F)"'","address":"500 Main St","city":"Merced","plannedVendorId":"vulcan"},
 "splits":[{"truckId":"leonardo","truckUnitId":"truck-4","material":"3/4 Rock","loadsAssigned":2,"vendorId":"vulcan"}]}' -o /dev/null
FL=$(curl -s -b $M $B/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);po=[p for p in d['pos'] if p['poNumber']=='10482'][0];print([l['id'] for l in d['loads'] if l['poId']==po['id']][0])")
chk "2. assigned, no trip → Assigned"   "$(fl "r['status'], r['since'], r['load']['tripNumber'], r['load']['loadNumber']")" "Assigned None 1 1"
chk "11. driver/truck/PO/load relationship" "$(fl "r['truckNum'], r['truckIsAssigned'], r['load']['poNumber'], r['load']['customer'], r['load']['city'], r['load']['material'], r['load']['pickup']['name'], r['load']['loadsAssigned']")" "Truck #4 True 10482 ABC Materials Merced 3/4 Rock Vulcan 2"
ta() { curl -s -b $LD -H 'Content-Type: application/json' -X POST $B/api/loads/$FL/trip-action -d "$1" -o /dev/null; }
ta '{"action":"start-trip","gps":{"lat":36.74,"lng":-119.77}}'
chk "3. started → Going to Yard, since = start stamp" "$(fl "r['status'], r['since'] is not None and r['since']==r['load']['tripStartedAt']")" "Going to Yard True"
ta '{"action":"arrived-pickup","yardId":"cemex"}'
chk "4. arrived pickup → At Yard, pickup follows the trip" "$(fl "r['status'], r['load']['pickup']['name']")" "At Yard CEMEX"
ta '{"action":"loaded"}'
chk "5. loaded → Loaded / En Route"      "$(fl "r['status']")" "Loaded / En Route"
ta '{"action":"arrived-jobsite"}'
chk "6. arrived jobsite → At Jobsite"    "$(fl "r['status']")" "At Jobsite"
ta '{"action":"trip-complete"}'
chk "7. trip done, one load left → Returning, load 2 of 2" "$(fl "r['status'], r['load']['loadsDelivered'], r['load']['loadNumber'], r['load']['tripNumber']")" "Returning 1 2 2"
ta '{"action":"start-trip"}'; ta '{"action":"arrived-pickup","yardId":"vulcan"}'; ta '{"action":"loaded"}'; ta '{"action":"arrived-jobsite"}'; ta '{"action":"trip-complete"}'
curl -s -b $LD -H 'Content-Type: application/json' -X PUT $B/api/loads/$FL -d "{\"ticketImage\":\"$PNG\",\"pod\":{\"signedBy\":\"x\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null
ta '{"action":"delivered"}'
chk "8. all work done (submitted) → Completed, finished load still named" "$(fl "r['status'], r['load']['approvalStatus'], r['load']['loadsDelivered']")" "Completed submitted 2"
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/$FL/approve -d '{}' -o /dev/null
chk "   still Completed after approval, load cleared" "$(fl "r['status'], r['load']")" "Completed None"
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/_test/backdate-location -d '{"driverId":"leonardo","seconds":301}' -o /dev/null
chk "9. GPS older than 5 min → Offline, real point + real age kept" "$(fl "r['status'], r['live'], r['gps']['stale'], r['gps']['ageSeconds']>=301, r['gps']['lat'], r['workflowStatus']")" "Offline False True True 36.7468 Completed"
chk "12. no fake coordinates for drivers who never reported" "$(curl -s -b $M $B/api/fleet/live | python3 -c "import json,sys;d=json.load(sys.stdin);print(all(x['gps'] is None and x['statusKey']=='offline' for x in d['trucks'] if x['driverId']!='leonardo'))")" "True"
chk "   version changes with state" "$(V1=$(curl -s -b $M $B/api/fleet/live | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])"); curl -s -b $LD -H 'Content-Type: application/json' -X POST $B/api/driver-location -d '{"lat":36.75,"lng":-119.78}' -o /dev/null; V2=$(curl -s -b $M $B/api/fleet/live | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])"); [ "$V1" != "$V2" ] && echo changed)" "changed"
chk "   fresh GPS again → live Completed" "$(fl "r['status'], r['live']")" "Completed True"
# Void the fixture load so the money/count assertions further down are unaffected.
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/$FL/void -d '{"reason":"fleet status fixture"}' -o /dev/null
chk "   voided fixture drops out: Available again" "$(fl "r['workflowStatus']")" "Available"

echo "── 1. PO with 3 loads, driver beryle, truck #12 (NOT his usual truck) ──"
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/pos -d '{
 "po":{"customer":"ABC Construction","deliveryDate":"'"$(date +%F)"'","address":"123 Main St","city":"Fresno","notes":"Gate 4455"},
 "splits":[{"truckId":"beryle","truckUnitId":"truck-12","material":"3/4 Rock","loadsAssigned":3,"vendorId":"vbt"}]}' -o /dev/null

LOAD=$(curl -s -b $M $B/api/data | python3 -c "import json,sys;print([l for l in json.load(sys.stdin)['loads'] if l['truckId']=='beryle'][0]['id'])")
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
l=[x for x in json.load(sys.stdin)['loads'] if x['id']=='$LOAD'][0]
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
chk "submitted for approval" "$(curl -s -b $M $B/api/data | python3 -c "import json,sys;print([x for x in json.load(sys.stdin)['loads'] if x['id']=='$LOAD'][0]['approvalStatus'])")" "submitted"
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/$LOAD/approve -d '{}' -o /dev/null
chk "approved" "$(curl -s -b $M $B/api/data | python3 -c "import json,sys;print([x for x in json.load(sys.stdin)['loads'] if x['id']=='$LOAD'][0]['approvalStatus'])")" "approved"
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
import json,sys;print([l['id'] for l in json.load(sys.stdin)['loads'] if l['poId']=='$NPO'][0])")
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

echo "── 16b. Voiding an approved load (the correction path) ──"
# load.voided was read in ~29 places and set by nothing, so "void it instead"
# was advice with no way to follow it. $LOAD is approved and in a batch.
chk "void needs a reason"            "$(curl -s -o /dev/null -w '%{http_code}' -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/$LOAD/void -d '{}')" "400"
chk "load on a batch refuses void"   "$(curl -s -o /dev/null -w '%{http_code}' -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/$LOAD/void -d '{"reason":"wrong site"}')" "409"
# A fresh approved load NOT on a batch can be voided
VPO=$(curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/pos -d '{
 "po":{"poNumber":"VOID-CHK","customer":"void check","deliveryDate":"'"$(date +%F)"'"},
 "splits":[{"truckId":"carlos","truckUnitId":"truck-2b","material":"Fill Sand","loadsAssigned":1,"vendorId":"vbt"}]}' \
 | python3 -c "import json,sys;print(json.load(sys.stdin)['po']['id'])")
VL=$(curl -s -b $M $B/api/data | python3 -c "
import json,sys;d=json.load(sys.stdin)
print([l['id'] for l in d['loads'] if l['poId']=='$VPO'][0])")
V=$(mktemp); curl -s -c $V -X POST -d "username=carlos&password=carlos123" $B/login -o /dev/null
for A in start-trip arrived-pickup loaded arrived-jobsite trip-complete; do
  curl -s -b $V -H 'Content-Type: application/json' -X POST $B/api/loads/$VL/trip-action -d "{\"action\":\"$A\",\"yardId\":\"vbt\"}" -o /dev/null; done
curl -s -b $V -H 'Content-Type: application/json' -X PUT $B/api/loads/$VL \
  -d "{\"ticketImage\":\"$PNG\",\"pod\":{\"signedBy\":\"F\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null
curl -s -b $V -H 'Content-Type: application/json' -X POST $B/api/loads/$VL/trip-action -d '{"action":"delivered"}' -o /dev/null
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/$VL/approve -d '{}' -o /dev/null
chk "PO with approved load blocks delete" "$(curl -s -o /dev/null -w '%{http_code}' -b $M -X DELETE $B/api/pos/$VPO)" "403"
chk "approved load voids"                "$(curl -s -o /dev/null -w '%{http_code}' -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/$VL/void -d '{"reason":"delivered to the wrong site"}')" "200"
VS=$(curl -s -b $M $B/api/data | python3 -c "
import json,sys;d=json.load(sys.stdin)
l=[x for x in d['loads'] if x['id']=='$VL'][0]
print(l.get('voided')); print(l.get('voidReason')); print(l.get('approvalStatus')); print('yes' if l.get('ticketImage') else 'no')")
chk "  marked voided"        "$(echo "$VS"|sed -n 1p)" "True"
chk "  reason recorded"      "$(echo "$VS"|sed -n 2p)" "delivered to the wrong site"
chk "  approval kept as history" "$(echo "$VS"|sed -n 3p)" "approved"
chk "  ticket PROOF retained"    "$(echo "$VS"|sed -n 4p)" "yes"
chk "  drops out of Ready to Bill" "$(curl -s -b $M $B/api/ready-to-bill | python3 -c "
import json,sys;print(len([i for i in json.load(sys.stdin)['items'] if i['id']=='$VL']))")" "0"
# Voided ≠ deleted: the PO keeps its approved (voided) load as history.
chk "PO with voided approved load stays on record (403)" "$(curl -s -o /dev/null -w '%{http_code}' -b $M -X DELETE $B/api/pos/$VPO)" "403"

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

echo "── 19. Secrets: no committed credential, no silent defaults ──"
chk "service-account.json is not tracked by git" "$(git ls-files -- service-account.json | wc -l | tr -d ' ')" "0"
chk "no literal session secret in source"        "$(grep -c "vbt-2025-secret" server.js)" "0"
chk "no literal QB key in source"                "$(grep -c "vbt-2025-qb-default-key" qb.js)" "0"
chk "Sheets never reads a key file from disk"    "$(grep -c "keyFile:" server.js)" "0"
# Production must refuse to boot when any required secret is missing.
PB=$( (NODE_ENV=production DATABASE_URL=postgres://unused PORT=4698 node server.js >/dev/null 2>&1; echo $?) )
chk "prod boot refuses without SESSION_SECRET/QB_ENCRYPTION_KEY" "$PB" "1"
PB=$( (NODE_ENV=production SESSION_SECRET=x QB_ENCRYPTION_KEY=y PORT=4698 node server.js >/dev/null 2>&1; echo $?) )
chk "prod boot refuses without DATABASE_URL" "$PB" "1"

echo "── 22. Approval state machine: locked means locked ──"
# LOAD was approved in section 6 and batched in section 7.
chk "manager cannot reassign an approved load"  "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X PUT $B/api/loads/$LOAD -d '{"truckId":"rigo"}')" "403"
# A fresh, pending load: the state fields must not be client-controlled.
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/pos -d '{
 "po":{"poNumber":"SM-CHK","customer":"State Machine","deliveryDate":"'"$(date +%F)"'"},
 "splits":[{"truckId":"beryle","truckUnitId":"truck-2","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' -o /dev/null
SM=$(curl -s -b $M $B/api/data | python3 -c "
import json,sys;d=json.load(sys.stdin)
po=[p for p in d['pos'] if p['poNumber']=='SM-CHK'][0]
print([x for x in d['loads'] if x['poId']==po['id']][0]['id']); print(po['id'])")
SML=$(echo "$SM"|sed -n 1p); SMP=$(echo "$SM"|sed -n 2p)
for F in approvalStatus billStatus voided locked billingBatchId trips qbInvoiceId; do
  case $F in trips) V='[]';; voided|locked) V='true';; *) V='"approved"';; esac
  chk "PUT $F rejected (400)" "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X PUT $B/api/loads/$SML -d "{\"$F\":$V}")" "400"
done
chk "  ...and the load is still pending/unlocked" "$(curl -s -b $M $B/api/data | python3 -c "
import json,sys;l=[x for x in json.load(sys.stdin)['loads'] if x['id']=='$SML'][0]
print(l['approvalStatus'], l['locked'], l['billStatus'], l['voided'])")" "pending False not-ready False"
chk "an honest field still updates (notes)" "$(curl -s -b $M -H 'Content-Type: application/json' -X PUT $B/api/loads/$SML -d '{"notes":"ok"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['load']['notes'])")" "ok"
# Deliver, approve, void — then the PO must NOT be deletable and the load must survive.
curl -s -b $D -H 'Content-Type: application/json' -X POST $B/api/loads/$SML/trip-action -d '{"action":"start-trip"}' -o /dev/null
curl -s -b $D -H 'Content-Type: application/json' -X POST $B/api/loads/$SML/trip-action -d '{"action":"arrived-pickup","yardId":"vbt"}' -o /dev/null
for A in loaded arrived-jobsite trip-complete; do
  curl -s -b $D -H 'Content-Type: application/json' -X POST $B/api/loads/$SML/trip-action -d "{\"action\":\"$A\"}" -o /dev/null
done
curl -s -b $D -H 'Content-Type: application/json' -X PUT $B/api/loads/$SML -d "{\"ticketImage\":\"$PNG\",\"pod\":{\"signedBy\":\"Foreman\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null
curl -s -b $D -H 'Content-Type: application/json' -X POST $B/api/loads/$SML/trip-action -d '{"action":"delivered"}' -o /dev/null
chk "submitted load is locked" "$(curl -s -b $M $B/api/data | python3 -c "import json,sys;print([x for x in json.load(sys.stdin)['loads'] if x['id']=='$SML'][0]['locked'])")" "True"
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/$SML/approve -d '{}' -o /dev/null
chk "voided with a reason" "$(curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/$SML/void -d '{"reason":"customer refused"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['load']['voided'])")" "True"
chk "PO with a voided approved load cannot be deleted" "$(curl -s -b $M -o /dev/null -w '%{http_code}' -X DELETE $B/api/pos/$SMP)" "403"
chk "  ...the voided load is still on record" "$(curl -s -b $M $B/api/data | python3 -c "import json,sys;print(len([x for x in json.load(sys.stdin)['loads'] if x['id']=='$SML']))")" "1"
chk "  ...and cannot be deleted directly either" "$(curl -s -b $M -o /dev/null -w '%{http_code}' -X DELETE $B/api/loads/$SML)" "403"
chk "PO grouping fields frozen once approved" "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X PUT $B/api/pos/$SMP -d '{"customer":"Someone Else"}')" "403"
chk "archive with nothing billed → 400 (nothing moved)" "$(curl -s -b $M -o /dev/null -w '%{http_code}' -X POST $B/api/history/archive)" "400"

echo "── 24. QuickBooks batches: no duplicate invoices, ever ──"
# Fake QuickBooks (test hook) so the state machine can be driven end to end.
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/_test/qb-fake -d '{"mode":"slow","delayMs":1500}' -o /dev/null
BATCH=$(curl -s -b $M $B/api/billing-batches | python3 -c "import json,sys;print(json.load(sys.stdin)['items'][0]['id'])")
# Two simultaneous sends of the same batch: exactly one may create an invoice.
R1=$(mktemp); R2=$(mktemp)
curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B/api/billing-batches/$BATCH/send -d '{}' > $R1 &
sleep 0.2
curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B/api/billing-batches/$BATCH/send -d '{}' > $R2 &
wait
chk "simultaneous sends: one 200, one 409" "$(cat $R1 $R2 | tr -d '\n' | fold -w3 | sort | tr '\n' ' ')" "200 409 "
chk "  ...exactly one invoice created"  "$(curl -s -b $M $B/api/_test/qb-fake | python3 -c "import json,sys;print(json.load(sys.stdin)['invoicesCreated'])")" "1"
chk "  ...batch is sent_to_quickbooks"  "$(curl -s -b $M $B/api/billing-batches | python3 -c "import json,sys;b=[x for x in json.load(sys.stdin)['items'] if x['id']=='$BATCH'][0];print(b['syncStatus'], b['qbInvoiceId'])")" "sent_to_quickbooks INV-1"
chk "  ...load marked billed with the invoice" "$(curl -s -b $M $B/api/data | python3 -c "import json,sys;l=[x for x in json.load(sys.stdin)['loads'] if x['id']=='$LOAD'][0];print(l['billStatus'], l['qbInvoiceId'])")" "billed INV-1"
chk "sending a sent batch again is refused" "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B/api/billing-batches/$BATCH/send -d '{}')" "400"
chk "retry on a sent batch is refused"      "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B/api/billing-batches/$BATCH/retry -d '{}')" "400"
chk "already-batched load cannot join a new batch" "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B/api/billing-batches -d "{\"loadIds\":[\"$LOAD\"]}")" "400"
# Void with QuickBooks disconnected: the invoice is live, so the loads stay billed.
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/_test/qb-fake -d '{"mode":"ok","connected":false}' -o /dev/null
chk "void with live invoice + QB disconnected refused (409)" "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B/api/billing-batches/$BATCH/void -d '{"reason":"wrong price"}')" "409"
chk "  ...load still billed"  "$(curl -s -b $M $B/api/data | python3 -c "import json,sys;l=[x for x in json.load(sys.stdin)['loads'] if x['id']=='$LOAD'][0];print(l['billStatus'], l['billingBatchId']=='$BATCH')")" "billed True"
# Void fails on the QuickBooks side: nothing changes locally.
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/_test/qb-fake -d '{"mode":"fail"}' -o /dev/null
chk "QB void failure leaves batch and loads unchanged (502)" "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B/api/billing-batches/$BATCH/void -d '{"reason":"wrong price"}')" "502"
chk "  ...batch still sent" "$(curl -s -b $M $B/api/billing-batches | python3 -c "import json,sys;print([x for x in json.load(sys.stdin)['items'] if x['id']=='$BATCH'][0]['syncStatus'])")" "sent_to_quickbooks"
# Void with QuickBooks connected: invoice voided, loads released.
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/_test/qb-fake -d '{"mode":"ok"}' -o /dev/null
chk "void with QB connected succeeds" "$(curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/billing-batches/$BATCH/void -d '{"reason":"wrong price"}' | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('success'), d.get('qbVoided'))")" "True True"
chk "  ...QB invoice voided" "$(curl -s -b $M $B/api/_test/qb-fake | python3 -c "import json,sys;print(json.load(sys.stdin)['invoicesVoided'])")" "1"
chk "  ...load back in Ready to Bill" "$(curl -s -b $M $B/api/ready-to-bill | python3 -c "import json,sys;print(len([x for x in json.load(sys.stdin)['items'] if x['id']=='$LOAD']))")" "1"
# Failed QuickBooks request → failed batch, nothing billed → retry → success, one more invoice.
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/_test/qb-fake -d '{"mode":"fail"}' -o /dev/null
B2=$(curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/billing-batches -d "{\"loadIds\":[\"$LOAD\"]}" | python3 -c "import json,sys;print(json.load(sys.stdin)['batches'][0]['id'])")
chk "QB failure → 500" "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B/api/billing-batches/$B2/send -d '{}')" "500"
chk "  ...batch failed, no invoice id" "$(curl -s -b $M $B/api/billing-batches | python3 -c "import json,sys;b=[x for x in json.load(sys.stdin)['items'] if x['id']=='$B2'][0];print(b['syncStatus'], repr(b['qbInvoiceId']))")" "failed ''"
chk "  ...load NOT marked billed" "$(curl -s -b $M $B/api/data | python3 -c "import json,sys;l=[x for x in json.load(sys.stdin)['loads'] if x['id']=='$LOAD'][0];print(l['billStatus'])")" "ready"
chk "  ...send on a failed batch says use retry" "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B/api/billing-batches/$B2/send -d '{}')" "400"
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/_test/qb-fake -d '{"mode":"ok"}' -o /dev/null
chk "retry resets a failed batch" "$(curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/billing-batches/$B2/retry -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['batch']['syncStatus'])")" "ready_to_bill"
chk "send after retry succeeds"   "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B/api/billing-batches/$B2/send -d '{}')" "200"
chk "  ...total invoices created is 2 (never a duplicate)" "$(curl -s -b $M $B/api/_test/qb-fake | python3 -c "import json,sys;print(json.load(sys.stdin)['invoicesCreated'])")" "2"
# A batch voided by hand in QuickBooks can be released with an explicit statement.
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/_test/qb-fake -d '{"connected":false}' -o /dev/null
chk "manual-QB-void release works and is logged" "$(curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/billing-batches/$B2/void -d '{"reason":"voided by accountant","alreadyVoidedInQuickBooks":true}' | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('success'), d.get('qbVoided'))")" "True False"
chk "  ...sync log records the manual void" "$(curl -s -b $M "$B/api/qb-sync-log" | python3 -c "import json,sys;d=json.load(sys.stdin);items=d.get('items') or d.get('log') or d;print(any('manually' in (e.get('requestSummary') or '') for e in items))")" "True"

echo "── 25. One costing engine: preview, invoices, and measured units ──"
PV=$(curl -s -b $M "$B/api/pricing-preview?customer=Cost%20Check&material=3%2F4%20Rock&vendorId=vulcan" | python3 -c "
import json,sys;d=json.load(sys.stdin)
print(d['vendor']['perLoad']); print(d['calculable']); print(d['tonsPerLoad']); print(d['vendor']['qtyPerLoad'])")
chk "PO preview cost per load = 38 x 25 (engine, not price*25)" "$(echo "$PV"|sed -n 1p)" "950"
chk "  ...calculable"        "$(echo "$PV"|sed -n 2p)" "True"
chk "  ...tons from qtyPerLoad" "$(echo "$PV"|sed -n 3p)-$(echo "$PV"|sed -n 4p)" "25-25"
chk "no price*25 formula left in the preview" "$(grep -c "cust.price \* tons" server.js)" "0"
chk "no hour:1 / mile:1 defaults in the engine" "$(grep -cE "^\s+(hour|mile):\s+1," server.js)" "0"
# A per-mile vendor rate with no miles recorded must NOT become rate x 1.
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/vendors/keith/prices -d '{"material":"Haul Test","unit":"mile","price":4}' -o /dev/null
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/customer-prices -d '{"customer":"Mile Customer","material":"Haul Test","unit":"mile","price":9}' -o /dev/null
MP=$(curl -s -b $M "$B/api/pricing-preview?customer=Mile%20Customer&material=Haul%20Test&vendorId=keith" | python3 -c "
import json,sys;d=json.load(sys.stdin)
print(d['calculable']); print(d['vendor']['perLoad']); print('miles' in d['vendor']['reason'])")
chk "per-mile preview is not calculable" "$(echo "$MP"|sed -n 1p)" "False"
chk "  ...perLoad is null, not 4"         "$(echo "$MP"|sed -n 2p)" "None"
chk "  ...reason names the missing miles" "$(echo "$MP"|sed -n 3p)" "True"
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/pos -d '{
 "po":{"poNumber":"MILE-1","customer":"Mile Customer","deliveryDate":"'"$(date +%F)"'"},
 "splits":[{"truckId":"matthew","truckUnitId":"truck-4","material":"Haul Test","loadsAssigned":1,"vendorId":"keith"}]}' -o /dev/null
ML=$(curl -s -b $M $B/api/data | python3 -c "import json,sys;print([l['id'] for l in json.load(sys.stdin)['loads'] if l['material']=='Haul Test'][0])")
MD=$(mktemp); curl -s -c $MD -X POST -d "username=matthew&password=matthew123" $B/login -o /dev/null
curl -s -b $MD -H 'Content-Type: application/json' -X POST $B/api/loads/$ML/trip-action -d '{"action":"start-trip"}' -o /dev/null
curl -s -b $MD -H 'Content-Type: application/json' -X POST $B/api/loads/$ML/trip-action -d '{"action":"arrived-pickup","yardId":"keith"}' -o /dev/null
for A in loaded arrived-jobsite trip-complete; do
  curl -s -b $MD -H 'Content-Type: application/json' -X POST $B/api/loads/$ML/trip-action -d "{\"action\":\"$A\"}" -o /dev/null
done
PR=$(curl -s -b $M $B/api/profitability | python3 -c "
import json,sys;g=json.load(sys.stdin)['grand']
print(g['costIncomplete']); print('mile' in g['unpricedUnits']); print(g['unpricedRevenueLoads'])")
chk "profitability flags the mile load as incomplete" "$(echo "$PR"|sed -n 1p)" "True"
chk "  ...names the unit"                             "$(echo "$PR"|sed -n 2p)" "True"
chk "  ...and the revenue side too"                   "$(echo "$PR"|sed -n 3p)" "1"
chk "material-costs flags keith as unconfigured" "$(curl -s -b $M $B/api/material-costs | python3 -c "import json,sys;print(json.load(sys.stdin)['vendors']['keith']['unconfigured'])")" "True"
# Approve it and try to bill: the engine cannot price it, so no batch, no $0 invoice.
curl -s -b $MD -H 'Content-Type: application/json' -X PUT $B/api/loads/$ML -d "{\"ticketImage\":\"$PNG\",\"pod\":{\"signedBy\":\"x\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null
curl -s -b $MD -H 'Content-Type: application/json' -X POST $B/api/loads/$ML/trip-action -d '{"action":"delivered"}' -o /dev/null
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/$ML/approve -d '{}' -o /dev/null
chk "billing preview marks the group not priceable" "$(curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/billing-batches/preview -d "{\"loadIds\":[\"$ML\"]}" | python3 -c "import json,sys;print(json.load(sys.stdin)['groups'][0]['unconfigured'])")" "True"
chk "batch creation refused (no \$0 invoice)" "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B/api/billing-batches -d "{\"loadIds\":[\"$ML\"]}")" "400"
chk "  ...load not attached to any batch" "$(curl -s -b $M $B/api/data | python3 -c "import json,sys;print(repr([l for l in json.load(sys.stdin)['loads'] if l['id']=='$ML'][0].get('billingBatchId','')))")" "''"

echo "── 26. One driver roster: a driver added in Drivers & Trucks is dispatchable ──"
AD=$(curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/drivers -d '{"username":"antonio","password":"antonio1","displayName":"Antonio","defaultTruckId":"truck-12"}')
chk "driver created (roster)" "$(echo "$AD" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('ok'), any(r['id']=='antonio' for r in d.get('roster',[])))")" "True True"
chk "  ...in the PO-form driver dropdown immediately" "$(curl -s -b $M $B/api/data | python3 -c "import json,sys;print(any(t['id']=='antonio' and t['label']=='Antonio' for t in json.load(sys.stdin)['trucks']))")" "True"
chk "  ...in Quick Assign's driver list"             "$(curl -s -b $M $B/api/today | python3 -c "import json,sys;print(any(d['id']=='antonio' for d in json.load(sys.stdin)['drivers']))")" "True"
chk "  ...usual truck recorded on the roster"        "$(curl -s -b $M $B/api/fleet | python3 -c "import json,sys;print([d for d in json.load(sys.stdin)['drivers'] if d['id']=='antonio'][0]['defaultTruckId'])")" "truck-12"
# Quick Assign must accept the new driver (it used to validate against a hardcoded list).
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/pos -d '{
 "po":{"poNumber":"NEWDRV","customer":"New Driver Co","deliveryDate":"'"$(date +%F)"'"},
 "splits":[{"truckId":"","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' -o /dev/null
NL=$(curl -s -b $M $B/api/data | python3 -c "
import json,sys;d=json.load(sys.stdin);po=[p for p in d['pos'] if p['poNumber']=='NEWDRV'][0]
print([l['id'] for l in d['loads'] if l['poId']==po['id']][0])")
AS=$(curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/$NL/assign -d '{"driverId":"antonio","truckUnitId":"truck-12"}')
chk "Quick Assign accepts the new driver" "$(echo "$AS" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('success'), d['load']['driverName'], d['truck']['truckNum'])")" "True Antonio Truck #12"
# Status and deactivation are honoured by assignment.
curl -s -b $M -H 'Content-Type: application/json' -X PUT $B/api/drivers/antonio -d '{"status":"off"}' -o /dev/null
chk "driver marked off cannot be assigned" "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B/api/loads/$NL/assign -d '{"driverId":"antonio"}')" "400"
curl -s -b $M -H 'Content-Type: application/json' -X PUT $B/api/drivers/antonio -d '{"status":"available"}' -o /dev/null
curl -s -b $M -H 'Content-Type: application/json' -X PUT $B/api/fleet/trucks/truck-2b -d '{"status":"maintenance"}' -o /dev/null
chk "truck in maintenance cannot be assigned" "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B/api/loads/$NL/assign -d '{"truckUnitId":"truck-2b"}')" "400"
curl -s -b $M -H 'Content-Type: application/json' -X PUT $B/api/fleet/trucks/truck-2b -d '{"status":"available"}' -o /dev/null
chk "disabled driver leaves the dropdown" "$(curl -s -b $M -X DELETE $B/api/drivers/antonio -o /dev/null; curl -s -b $M $B/api/data | python3 -c "import json,sys;print(any(t['id']=='antonio' for t in json.load(sys.stdin)['trucks']))")" "False"
chk "  ...and cannot be assigned"          "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B/api/loads/$NL/assign -d '{"driverId":"antonio"}')" "400"
chk "  ...but the load keeps their name as history" "$(curl -s -b $M $B/api/data | python3 -c "import json,sys;print([l for l in json.load(sys.stdin)['loads'] if l['id']=='$NL'][0]['driverName'])")" "Antonio"
# Trucks: one vehicle API. The legacy label-based one is gone.
chk "legacy /api/trucks is gone (404)" "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B/api/trucks -d '{"id":"x","label":"y","truckNum":"z"}')" "404"
NT=$(curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/fleet/trucks -d '{"truckNum":"Truck #7","type":"End Dump"}' | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['truck']['id'])")
chk "new truck is a vehicle record" "$(curl -s -b $M $B/api/fleet | python3 -c "import json,sys;t=[t for t in json.load(sys.stdin)['trucks'] if t['id']=='$NT'][0];print(t['truckNum'], t['status'], 'label' in t)")" "Truck #7 available False"
chk "  ...offered by Quick Assign"  "$(curl -s -b $M $B/api/today | python3 -c "import json,sys;print(any(t['id']=='$NT' for t in json.load(sys.stdin)['trucks']))")" "True"

echo "── 27. Driver sees only today's own work; the day is Pacific, not UTC ──"
TZ1=$(curl -s "$B/api/_test/today?at=2026-09-16T00:30:00Z" | python3 -c "import json,sys;print(json.load(sys.stdin)['today'])")
chk "5:30pm PT on Sep 15 is still Sep 15 (UTC says 16)" "$TZ1" "2026-09-15"
chk "11:59pm PT is still the same day"     "$(curl -s "$B/api/_test/today?at=2026-09-16T06:59:00Z" | python3 -c "import json,sys;print(json.load(sys.stdin)['today'])")" "2026-09-15"
chk "12:01am PT rolls to the next day"     "$(curl -s "$B/api/_test/today?at=2026-09-16T07:01:00Z" | python3 -c "import json,sys;print(json.load(sys.stdin)['today'])")" "2026-09-16"
chk "operating timezone is Pacific"        "$(curl -s "$B/api/_test/today" | python3 -c "import json,sys;print(json.load(sys.stdin)['tz'])")" "America/Los_Angeles"
# Tomorrow's load for beryle must not reach him today; yesterday's open one must.
TOM=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=1)).isoformat())")
YES=$(python3 -c "import datetime;print((datetime.date.today()-datetime.timedelta(days=1)).isoformat())")
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/pos -d '{"po":{"poNumber":"FUTURE","customer":"Future Co","deliveryDate":"'"$TOM"'"},"splits":[{"truckId":"beryle","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' -o /dev/null
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/pos -d '{"po":{"poNumber":"YESTERDAY","customer":"Late Co","deliveryDate":"'"$YES"'"},"splits":[{"truckId":"beryle","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' -o /dev/null
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/pos -d '{"po":{"poNumber":"OTHERS","customer":"Not Mine","deliveryDate":"'"$(date +%F)"'"},"splits":[{"truckId":"rigo","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' -o /dev/null
DD=$(curl -s -b $D $B/api/data | python3 -c "
import json,sys;d=json.load(sys.stdin)
nums=sorted(p['poNumber'] for p in d['pos'])
print('FUTURE' in nums, 'YESTERDAY' in nums, 'OTHERS' in nums)
print(any(k in l for l in d['loads'] for k in ('customerRate','vendorRate','pricePerUnit','billStatus','billingBatchId')))
print(any('notifications' in p for p in d['pos']))")
chk "/api/data (driver): no future, yes yesterday-open, no other drivers" "$(echo "$DD"|sed -n 1p)" "False True False"
chk "  ...no rates or billing fields in the driver payload" "$(echo "$DD"|sed -n 2p)" "False"
chk "  ...no notification config in the driver payload"     "$(echo "$DD"|sed -n 3p)" "False"
MDV=$(curl -s -b $D $B/api/my-dispatch | python3 -c "import json,sys;n=sorted(l['poNumber'] for l in json.load(sys.stdin)['loads']);print('FUTURE' in n, 'YESTERDAY' in n, 'OTHERS' in n)")
chk "/api/my-dispatch agrees" "$MDV" "False True False"
chk "driver cannot read another driver's load" "$(curl -s -b $D -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B/api/loads/$NL/trip-action -d '{"action":"start-trip"}')" "403"

echo "── 28. Driver GPS: the endpoint exists, is authenticated and validated ──"
chk "driver location accepted"    "$(curl -s -b $D -H 'Content-Type: application/json' -X POST $B/api/driver-location -d '{"lat":36.7378,"lng":-119.7871,"accuracy":12}' | python3 -c "import json,sys;print(json.load(sys.stdin)['accepted'])")" "True"
chk "rapid repeat is throttled (202)" "$(curl -s -b $D -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B/api/driver-location -d '{"lat":36.7379,"lng":-119.7872}')" "202"
chk "out-of-range lat rejected"   "$(curl -s -b $D -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B/api/driver-location -d '{"lat":99,"lng":0}')" "400"
chk "manager cannot post a location" "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B/api/driver-location -d '{"lat":1,"lng":1}')" "403"
chk "anonymous is redirected"     "$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B/api/driver-location -d '{"lat":1,"lng":1}')" "302"
chk "office sees the last position" "$(curl -s -b $M $B/api/driver-locations | python3 -c "import json,sys;r=[x for x in json.load(sys.stdin)['locations'] if x['driverId']=='beryle'][0];print(r['lat'], r['driverName'])")" "36.7378 Beryle"
chk "  ...and Quick Assign carries lastSeen" "$(curl -s -b $M $B/api/today | python3 -c "import json,sys;d=[x for x in json.load(sys.stdin)['drivers'] if x['id']=='beryle'][0];print(d['lastSeen']['lng'])")" "-119.7871"
chk "  ...drivers cannot read it"  "$(curl -s -b $D -o /dev/null -w '%{http_code}' $B/api/driver-locations)" "403"
chk "driver app calls the endpoint in driver mode" "$(grep -c "startGPSTracking();" public/index.html)" "1"

echo "── 29. One pickup-yard source for every office screen ──"
# A load whose stored vendorName is stale must still show the resolved yard.
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/pos -d '{"po":{"poNumber":"YARD-1","customer":"Yard Co","deliveryDate":"'"$(date +%F)"'","plannedVendorId":"vbt"},"splits":[{"truckId":"rigo","material":"Base Rock","loadsAssigned":1,"vendorId":"vulcan"}]}' -o /dev/null
YL=$(curl -s -b $M $B/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);po=[p for p in d['pos'] if p['poNumber']=='YARD-1'][0];print([l['id'] for l in d['loads'] if l['poId']==po['id']][0])")
chk "office load carries resolved pickup (vendor wins over PO plan)" "$(curl -s -b $M $B/api/data | python3 -c "import json,sys;l=[x for x in json.load(sys.stdin)['loads'] if x['id']=='$YL'][0];print(l['pickup']['id'], l['pickup']['name'])")" "vulcan Vulcan"
curl -s -b $M -H 'Content-Type: application/json' -X PUT $B/api/loads/$YL -d '{"vendorId":"cemex"}' -o /dev/null
YP=$(curl -s -b $M $B/api/data | python3 -c "import json,sys;l=[x for x in json.load(sys.stdin)['loads'] if x['id']=='$YL'][0];print(l['pickup']['name'], l['vendorName'], l.get('actualYardId'), l['vendorRateIsDefault'])")
chk "generic PUT of vendorId re-resolves, clears mirror, re-prices" "$YP" "CEMEX CEMEX None False"
chk "profitability uses the same resolver" "$(curl -s -b $M $B/api/profitability | python3 -c "import json,sys;d=json.load(sys.stdin);print(any('CEMEX' in (v.get('name') or '') for v in d['byVendor']))")" "True"
chk "no independent yard label left in the UI" "$(grep -cE "l\.vendorName \|\| po\.pickup|l\.actualYardName \|\| \(l\.vendorName\)|l\.actualYardName \|\| l\.pickup" public/index.html)" "0"
chk "no hand-rolled yard chain left on the server" "$(grep -cE "l\.actualYardId \|\| l\.vendorId|l\.vendorId \|\| l\.yardId" server.js)" "0"

echo "── 30. Nothing assigns before Confirm — drag/drop, reassign modal, Quick Assign ──"
chk "drag/drop does not PUT on drop"        "$(grep -c "api('PUT', '/api/loads/' + dragId" public/index.html)" "0"
chk "  ...it opens the Quick Assign sheet"   "$(sed -n '/^async function onDrop/,/^}/p' public/index.html | grep -c 'qaOpen(id)')" "1"
chk "  ...and the sheet only writes on Confirm" "$(sed -n '/^function qaPaintSheet/,/^}/p' public/index.html | grep -c "api('POST'\|api('PUT'")" "0"
chk "reassign modal goes through /assign"    "$(sed -n '/^async function confirmReassign/,/^}/p' public/index.html | grep -c '/assign')" "1"
chk "  ...not the generic load update"       "$(sed -n '/^async function confirmReassign/,/^}/p' public/index.html | grep -c "api('PUT'")" "0"

echo "── 31. Login is rate limited ──"
curl -s -X POST $B/api/_test/reset-login-limits -o /dev/null
for i in 1 2 3 4 5 6 7 8; do curl -s -o /dev/null -X POST -d 'username=oscar&password=wrong' $B/login; done
chk "9th attempt is locked out"               "$(curl -s -o /dev/null -w '%{redirect_url}' -X POST -d 'username=oscar&password=wrong' $B/login | sed 's|http://[^/]*||')" "/login?error=locked"
chk "  ...even with the right password"      "$(curl -s -o /dev/null -w '%{redirect_url}' -X POST -d 'username=oscar&password=oscar123' $B/login | sed 's|http://[^/]*||')" "/login?error=locked"
chk "  ...other users unaffected"            "$(curl -s -o /dev/null -w '%{redirect_url}' -X POST -d 'username=perla&password=perla123' $B/login | sed 's|http://[^/]*||')" "/app/"
curl -s -X POST $B/api/_test/reset-login-limits -o /dev/null
chk "cleared window logs in again"           "$(curl -s -o /dev/null -w '%{redirect_url}' -X POST -d 'username=oscar&password=oscar123' $B/login | sed 's|http://[^/]*||')" "/app/"
chk "session cookie is httpOnly + named"     "$(curl -s -i -X POST -d 'username=perla&password=perla123' $B/login | grep -i '^set-cookie' | grep -c 'vbt.sid=.*HttpOnly')" "1"

echo "── 32. Fleet Map screen: access, data, and no second status system ──"
chk "manager loads fleet data (5 drivers)"   "$(curl -s -b $M $B/api/fleet/live | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['count'], len(d['trucks']))")" "5 5"
chk "driver gets 403"                        "$(curl -s -b $D -o /dev/null -w '%{http_code}' $B/api/fleet/live)" "403"
chk "anonymous gets 403"                     "$(curl -s -o /dev/null -w '%{http_code}' $B/api/fleet/live)" "403"
chk "driver cannot read a trail"             "$(curl -s -b $D -o /dev/null -w '%{http_code}' $B/api/loads/$LOAD/track)" "403"
chk "no all-day driver trail route exists"   "$(grep -cE "app\.get\('/api/(drivers/:[a-z]+/(track|trail|history)|driver-locations/history)" server.js)" "0"
chk "Fleet Map tab hidden until an office role is confirmed" "$(grep -c 'id="nav-map" style="display:none"' public/index.html)" "1"
chk "  ...unhidden only for admin/manager"   "$(sed -n "/if (role === 'admin' || role === 'manager') {/,/}/p" public/index.html | grep -c "nav-map")" "1"
chk "Leaflet 1.9.4 vendored and served locally" "$(grep -c "'/app/vendor/leaflet/leaflet.js'" public/index.html)|$(curl -s -b $M -o /dev/null -w '%{http_code}' $B/app/vendor/leaflet/leaflet.js)|$(head -c 60 public/vendor/leaflet/leaflet.js | grep -c 'Leaflet 1.9.4')" "1|200|1"
chk "tile provider is one swappable object"  "$(grep -c "^const FM_TILES = {" public/index.html)" "1"
chk "map colours keyed by the server's statusKey only" "$(python3 -c "
import re;s=open('public/index.html').read()
keys=set(re.findall(r'(\w+):\s*\'#', s[s.index('const FM_COLORS'):s.index('};', s.index('const FM_COLORS'))]))
srv=set(re.findall(r'^\s+(\w+):\s+\'', open('server.js').read()[open('server.js').read().index('const FLEET_STATUS = {'):][:600], re.M))
print(keys==srv)")" "True"
chk "no fallback coordinates for trucks (home view is not a truck)" "$(grep -c "FM_HOME.lat, FM_HOME.lng" public/index.html)" "1"
chk "  ...markers only from t.gps"           "$(sed -n '/^function fmPaintMarkers/,/^}/p' public/index.html | grep -c "if (!t.gps) return;")" "1"

echo "── 33. Saved locations: yards, vendors, jobsites — real coordinates only ──"
GC() { curl -s -b $M $B/api/_test/geocode-calls | python3 -c "import json,sys;print(json.load(sys.stdin)['calls'])"; }
chk "map refresh with zero coordinates: no pickup/jobsite geo, no geocoding" "$(curl -s -b $M $B/api/fleet/live | python3 -c "import json,sys;d=json.load(sys.stdin);print(all((not t['load']) or (t['load']['pickup']['geo'] is None and t['load']['destination']['geo'] is None) for t in d['trucks']))")|$(GC)" "True|0"
chk "1. VBT yard can store coordinates (manual)" "$(curl -s -b $M -H 'Content-Type: application/json' -X PUT $B/api/vendors/vbt/location -d '{"lat":36.7000,"lng":-119.7000}' | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['action'], d['geo']['source'], d['geo']['confirmed'])")" "set manual True"
chk "2. vendor yard can store coordinates"      "$(curl -s -b $M -H 'Content-Type: application/json' -X PUT $B/api/vendors/vulcan/location -d '{"lat":36.8000,"lng":-119.8000}' | python3 -c "import json,sys;print(json.load(sys.stdin)['geo']['lat'])")" "36.8"
chk "   ...visible on the vendor record"        "$(curl -s -b $M $B/api/data | python3 -c "import json,sys;v=[v for v in json.load(sys.stdin)['vendors'] if v['id']=='vulcan'][0];print(v['geo']['lat'], v['geo']['lng'], v['geo']['source'])")" "36.8 -119.8 manual"
# 4. a PO without coordinates still works
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/pos -d '{"po":{"poNumber":"GEO-1","customer":"Geo Co","deliveryDate":"'"$(date +%F)"'","address":"500 Main St","city":"Merced","plannedVendorId":"vulcan"},"splits":[{"truckId":"carlos","truckUnitId":"truck-2b","material":"3/4 Rock","loadsAssigned":2,"vendorId":"vulcan"}]}' -o /dev/null
GP=$(curl -s -b $M $B/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);po=[p for p in d['pos'] if p['poNumber']=='GEO-1'][0];print(po['id']); print([l['id'] for l in d['loads'] if l['poId']==po['id']][0]); print('geo' in po)")
GPO=$(echo "$GP"|sed -n 1p); GL=$(echo "$GP"|sed -n 2p)
LD2=$(mktemp); curl -s -c $LD2 -X POST -d "username=carlos&password=carlos123" $B/login -o /dev/null
tg() { curl -s -b $LD2 -H 'Content-Type: application/json' -X POST $B/api/loads/$GL/trip-action -d "$1" -o /dev/null; }
tg '{"action":"start-trip"}'   # makes GEO-1 the driver's current load
chk "4. PO created without coordinates works, has no geo" "$(echo "$GP"|sed -n 3p)" "False"
chk "   fleet row: pickup geo from the yard, destination geo null" "$(curl -s -b $M $B/api/fleet/live | python3 -c "import json,sys;r=[x for x in json.load(sys.stdin)['trucks'] if x['driverId']=='carlos'][0];l=r['load'];print(l['pickup']['geo']['lat'], l['destination']['geo'], l['destination']['city'])")" "36.8 None Merced"
chk "3. PO/jobsite can store coordinates"       "$(curl -s -b $M -H 'Content-Type: application/json' -X PUT $B/api/pos/$GPO/location -d '{"lat":37.3022,"lng":-120.4830}' | python3 -c "import json,sys;print(json.load(sys.stdin)['geo']['lng'])")" "-120.483"
chk "   fleet row now carries the jobsite point" "$(curl -s -b $M $B/api/fleet/live | python3 -c "import json,sys;r=[x for x in json.load(sys.stdin)['trucks'] if x['driverId']=='carlos'][0];print(r['load']['destination']['geo']['lat'])")" "37.3022"
chk "invalid latitude rejected"                 "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X PUT $B/api/vendors/cemex/location -d '{"lat":91,"lng":0}')" "400"
chk "invalid longitude rejected"                "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X PUT $B/api/vendors/cemex/location -d '{"lat":36,"lng":-181}')" "400"
chk "0,0 rejected (null island is never a yard)" "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X PUT $B/api/vendors/cemex/location -d '{"lat":0,"lng":0}')" "400"
chk "12. driver cannot set a yard location"     "$(curl -s -b $D -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X PUT $B/api/vendors/cemex/location -d '{"lat":36,"lng":-119}')" "403"
chk "    driver cannot set a jobsite location"  "$(curl -s -b $D -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X PUT $B/api/pos/$GPO/location -d '{"lat":36,"lng":-119}')" "403"
chk "    generic PO update cannot smuggle geo"  "$(curl -s -b $M -H 'Content-Type: application/json' -X PUT $B/api/pos/$GPO -d '{"geo":{"lat":1,"lng":1},"notes":"x"}' -o /dev/null; curl -s -b $M $B/api/data | python3 -c "import json,sys;print([p for p in json.load(sys.stdin)['pos'] if p['id']=='$GPO'][0]['geo']['lat'])")" "37.3022"
# geocoding: explicit only, never over a confirmed location
chk "geocode is an explicit action (1 call, stored unconfirmed)" "$(curl -s -b $M -H 'Content-Type: application/json' -X PUT $B/api/vendors/cemex/location -d '{"geocode":true}' | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['action'], d['geo']['source'], d['geo']['confirmed'], d['match']['precision'])")|$(GC)" "geocoded geocoded False city|1"
chk "confirm locks the geocoded result"         "$(curl -s -b $M -H 'Content-Type: application/json' -X PUT $B/api/vendors/cemex/location -d '{"confirm":true}' | python3 -c "import json,sys;print(json.load(sys.stdin)['geo']['confirmed'])")" "True"
chk "6. geocode over a confirmed location is refused (409), value unchanged" "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X PUT $B/api/vendors/vulcan/location -d '{"geocode":true}')|$(curl -s -b $M $B/api/data | python3 -c "import json,sys;print([v for v in json.load(sys.stdin)['vendors'] if v['id']=='vulcan'][0]['geo']['lat'])")|$(GC)" "409|36.8|1"
chk "   ...explicit overwrite is honoured"      "$(curl -s -b $M -H 'Content-Type: application/json' -X PUT $B/api/vendors/vulcan/location -d '{"geocode":true,"overwrite":true}' | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['geo']['lat'], d['geo']['confirmed'])")|$(GC)" "36.6 False|2"
curl -s -b $M -H 'Content-Type: application/json' -X PUT $B/api/vendors/vulcan/location -d '{"lat":36.8000,"lng":-119.8000}' -o /dev/null
chk "geocoder miss → 404, nothing stored"       "$(curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/_test/geocode-mode -d '{"mode":"none"}' -o /dev/null; curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X PUT $B/api/vendors/keith/location -d '{"geocode":true}')|$(curl -s -b $M $B/api/data | python3 -c "import json,sys;print('geo' in [v for v in json.load(sys.stdin)['vendors'] if v['id']=='keith'][0])")" "404|False"
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/_test/geocode-mode -d '{"mode":"ok"}' -o /dev/null
# 7. fleet refresh never geocodes
C0=$(GC); for i in 1 2 3; do curl -s -b $M $B/api/fleet/live -o /dev/null; curl -s -b $M $B/api/data -o /dev/null; done
chk "7. fleet refresh / data loads never call the geocoder" "$(( $(GC) - C0 ))" "0"
# 9/11. selected trip uses the actual resolved pickup yard; different trips, different yards
tg '{"action":"arrived-pickup","yardId":"cemex"}'
chk "9. trip at CEMEX → pickup is CEMEX with CEMEX's point (not the PO's Vulcan plan)" "$(curl -s -b $M $B/api/fleet/live | python3 -c "import json,sys;r=[x for x in json.load(sys.stdin)['trucks'] if x['driverId']=='carlos'][0];p=r['load']['pickup'];print(p['id'], p['isActual'], p['geo']['lat'])")" "cemex True 36.6"
tg '{"action":"loaded"}'; tg '{"action":"arrived-jobsite"}'; tg '{"action":"trip-complete"}'
tg '{"action":"start-trip"}'; tg '{"action":"arrived-pickup","yardId":"vulcan"}'
chk "11. next trip at Vulcan → pickup follows the trip" "$(curl -s -b $M $B/api/fleet/live | python3 -c "import json,sys;r=[x for x in json.load(sys.stdin)['trucks'] if x['driverId']=='carlos'][0];p=r['load']['pickup'];print(p['id'], p['geo']['lat'], r['load']['tripNumber'])")" "vulcan 36.8 2"
chk "10. destination is the PO's jobsite point"  "$(curl -s -b $M $B/api/fleet/live | python3 -c "import json,sys;r=[x for x in json.load(sys.stdin)['trucks'] if x['driverId']=='carlos'][0];d=r['load']['destination'];print(d['address'], d['geo']['lat'], d['geo']['lng'])")" "500 Main St 37.3022 -120.483"
chk "clear removes coordinates"                 "$(curl -s -b $M -H 'Content-Type: application/json' -X PUT $B/api/vendors/cemex/location -d '{"clear":true}' | python3 -c "import json,sys;print(json.load(sys.stdin)['geo'])")" "None"
chk "no geocoder call inside the map or refresh code" "$(sed -n '/^const FM_TILES/,/^\/\/ ── START/p' public/index.html | grep -c 'geocode')" "0"
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/$GL/void -d '{"reason":"geo fixture"}' -o /dev/null

echo "── 34. Archive is Postgres-only: no Google Sheets anywhere ──"
chk "/api/sync is gone"                      "$(curl -s -b $M -o /dev/null -w '%{http_code}' -X POST $B/api/sync)" "404"
chk "googleapis is not a dependency"         "$(grep -c '"googleapis"' package.json)" "0"
chk "server never requires googleapis"       "$(grep -c "require('googleapis')" server.js)" "0"
chk "no SHEET_ID / Sheets client in server"  "$(grep -c "SHEET_ID\|spreadsheets\.\|writeSheet" server.js)" "0"
chk "no Sheets wording in the UI"            "$(grep -ci "google sheets\|synced to sheets\|syncSheets\|archiveToSheets" public/index.html)" "0"
chk "key-file guard kept"                    "$(grep -c "service-account.json is present on disk" server.js)|$(grep -c 'service-account.json' .gitignore)" "1|1"
# Real archive: LOAD is approved and back in Ready to Bill after section 24. Mark it billed and archive.
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/bill -d "{\"loadIds\":[\"$LOAD\"]}" -o /dev/null
AR=$(curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/history/archive -d '{}')
chk "archive billed loads → 200, batch created" "$(echo "$AR" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['success'], d['archived']['loads']>=1, 'syncedToSheet' in d['archived'])")" "True True False"
AB=$(echo "$AR" | python3 -c "import json,sys;print(json.load(sys.stdin)['archived']['batchId'])")
HB=$(curl -s -b $M $B/api/history | python3 -c "
import json,sys;d=json.load(sys.stdin);b=[x for x in d['archive'] if x['batchId']=='$AB'][0]
print(any(l['id']=='$LOAD' for l in b['loads'])); print(len(b['pos'])>=1); print('syncedToSheet' in b); print(b['loads'][0]['ticketImage'])")
chk "  ...archived load kept in full in the database" "$(echo "$HB"|sed -n 1p)" "True"
chk "  ...its PO archived with it"                    "$(echo "$HB"|sed -n 2p)" "True"
chk "  ...no Sheets flag on the batch"                "$(echo "$HB"|sed -n 3p)" "False"
chk "  ...photo payload kept (shown as stored)"       "$(echo "$HB"|sed -n 4p)" "[stored]"
chk "  ...load left the active board"                 "$(curl -s -b $M $B/api/data | python3 -c "import json,sys;print(any(l['id']=='$LOAD' for l in json.load(sys.stdin)['loads']))")" "False"
chk "  ...still counted by Reports (profitability)"   "$(curl -s -b $M $B/api/profitability | python3 -c "import json,sys;d=json.load(sys.stdin);print(any(l['id']=='$LOAD' for l in d.get('topLoads',[])+d.get('bottomLoads',[])) or d['grand']['loadCount']>0)")" "True"
chk "  ...audit entry recorded"                       "$(curl -s -b $M "$B/api/audit-log" | python3 -c "import json,sys;d=json.load(sys.stdin);print(any(e.get('action')=='archived-batch' and e.get('target')=='$AB' for e in d['entries']))")" "True"

echo "── 20. Async route errors answer, they never hang ──"
# Express 4 drops a rejected promise on the floor: the request hangs forever.
# The central wrapper in server.js turns it into a 500. If someone removes
# that block again, these curls time out (000) instead of returning 500.
for R in async-throw async-reject sync-throw; do
  chk "/api/_test/$R returns 500 within 5s" "$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' $B/api/_test/$R)" "500"
done
chk "server still alive after the throws" "$(curl -s -o /dev/null -w '%{http_code}' $B/healthz)" "200"

pkill -f "^node server.js" >/dev/null 2>&1
rm -f data.json

echo "── 21. Postgres: a failed store read must NEVER cause a write ──"
if [ -z "${TEST_DATABASE_URL:-}" ]; then
  echo "  SKIP  TEST_DATABASE_URL not set — run ./test-pg-local.sh to exercise this against a throwaway Postgres"
  SKIPPED=$((SKIPPED+1))
else
  PSQL="psql $TEST_DATABASE_URL -tA -q"
  P2=$((PORT+1)); B2=http://localhost:$P2
  $PSQL -c "DROP TABLE IF EXISTS dispatch_data, users, companies, user_sessions" >/dev/null
  (VBT_TEST_HOOKS=1 DATABASE_URL="$TEST_DATABASE_URL" PORT=$P2 node server.js > /tmp/vbt-test-pg.log 2>&1 &)
  for i in $(seq 1 20); do sleep 1; curl -sf $B2/healthz >/dev/null 2>&1 && break; done
  chk "fresh DB boots loaded" "$(curl -s $B2/healthz | python3 -c "import json,sys;print(json.load(sys.stdin)['loaded'])")" "True"
  PM=$(mktemp); curl -s -c $PM -X POST -d "username=joshua&password=joshua123" $B2/login -o /dev/null
  curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/pos -d '{
   "po":{"poNumber":"PG-REAL","customer":"Real Customer","deliveryDate":"'"$(date +%F)"'"},
   "splits":[{"truckId":"beryle","truckUnitId":"truck-2","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' -o /dev/null
  chk "real PO persisted to the store row" "$($PSQL -c "select count(*) from dispatch_data where key='store' and value like '%PG-REAL%'")" "1"
  # A second save so store_prev exists (it snapshots the value before each save).
  curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/pos -d '{
   "po":{"poNumber":"PG-SECOND","customer":"Second Customer","deliveryDate":"'"$(date +%F)"'"},
   "splits":[{"truckId":"rigo","truckUnitId":"truck-4","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' -o /dev/null
  chk "store_prev holds the state before the last save" "$($PSQL -c "select count(*) from dispatch_data where key='store_prev' and value like '%PG-REAL%' and value not like '%PG-SECOND%'")" "1"
  # Legacy seed password must stop working once the users table says otherwise.
  $PSQL -c "update users set password='changed-in-db' where username='joshua'" >/dev/null
  chk "old seed password rejected after DB change" "$(curl -s -o /dev/null -w '%{redirect_url}' -X POST -d 'username=joshua&password=joshua123' $B2/login | sed 's|.*//[^/]*||')" "/login?error=1"
  chk "new DB password accepted"                   "$(curl -s -o /dev/null -w '%{redirect_url}' -X POST -d 'username=joshua&password=changed-in-db' $B2/login | sed 's|.*//[^/]*||')" "/app/"
  # Passwords: seeded rows are hashed, a plaintext row migrates on first login.
  chk "no plaintext password rows remain after migration" "$($PSQL -c "select count(*) from users where password not like 'scrypt\$%'")" "0"
  chk "plaintext row migrated to scrypt on login"      "$($PSQL -c "select count(*) from users where username='joshua' and password like 'scrypt\$%'")" "1"
  chk "  ...and the migrated hash still verifies"      "$(curl -s -o /dev/null -w '%{redirect_url}' -X POST -d 'username=joshua&password=changed-in-db' $B2/login | sed 's|.*//[^/]*||')" "/app/"
  chk "  ...wrong password still rejected"             "$(curl -s -o /dev/null -w '%{redirect_url}' -X POST -d 'username=joshua&password=changed-in-dc' $B2/login | sed 's|.*//[^/]*||')" "/login?error=1"
  curl -s -b $PM -H 'Content-Type: application/json' -X PUT $B2/api/drivers/beryle -d '{"password":"beryle-new"}' -o /dev/null
  chk "password set from Drivers & Trucks is hashed" "$($PSQL -c "select count(*) from users where username='beryle' and password like 'scrypt\$%'")" "1"
  chk "  ...and works"  "$(curl -s -o /dev/null -w '%{redirect_url}' -X POST -d 'username=beryle&password=beryle-new' $B2/login | sed 's|.*//[^/]*||')" "/app/"
  $PSQL -c "update users set password='joshua123' where username='joshua'" >/dev/null
  # A driver created in Drivers & Trucks gets a login AND is dispatchable.
  curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/drivers -d '{"username":"nadia","password":"nadia123","displayName":"Nadia","defaultTruckId":"truck-4"}' -o /dev/null
  chk "new driver login row exists" "$($PSQL -c "select count(*) from users where username='nadia' and role='driver' and truck_id='nadia'")" "1"
  chk "  ...stored hashed" "$($PSQL -c "select count(*) from users where username='nadia' and password like 'scrypt\$%'")" "1"
  ND=$(mktemp)
  chk "new driver can log in" "$(curl -s -c $ND -o /dev/null -w '%{redirect_url}' -X POST -d 'username=nadia&password=nadia123' $B2/login | sed 's|.*//[^/]*||')" "/app/"
  curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/pos -d '{
   "po":{"poNumber":"PG-NADIA","customer":"Nadia Co","deliveryDate":"'"$(date +%F)"'"},
   "splits":[{"truckId":"nadia","truckUnitId":"truck-4","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' -o /dev/null
  chk "  ...and sees her own load, nobody else's" "$(curl -s -b $ND $B2/api/my-dispatch | python3 -c "import json,sys;ls=json.load(sys.stdin)['loads'];print(len(ls), ls[0]['poNumber'] if ls else '')")" "1 PG-NADIA"
  # ── Location history (driver_locations) ──
  chk "history table + indexes exist" "$($PSQL -c "select count(*) from pg_indexes where tablename='driver_locations' and indexname in ('driver_locations_driver_at','driver_locations_load_trip_at','driver_locations_at')")" "3"
  NLD=$(curl -s -b $PM $B2/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);po=[p for p in d['pos'] if p['poNumber']=='PG-NADIA'][0];print([l['id'] for l in d['loads'] if l['poId']==po['id']][0])")
  curl -s -b $ND -H 'Content-Type: application/json' -X POST $B2/api/driver-location -d '{"lat":36.7000,"lng":-119.7000,"accuracy":5}' -o /dev/null
  chk "4. GPS before any trip: last-known kept, NO history row" "$($PSQL -c "select count(*) from driver_locations where driver_id='nadia'")|$(curl -s -b $PM $B2/api/driver-locations | python3 -c "import json,sys;print([x['lat'] for x in json.load(sys.stdin)['locations'] if x['driverId']=='nadia'][0])")" "0|36.7"
  curl -s -b $ND -H 'Content-Type: application/json' -X POST $B2/api/loads/$NLD/trip-action -d '{"action":"start-trip"}' -o /dev/null
  curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/_test/backdate-location -d '{"driverId":"nadia","seconds":25}' -o /dev/null
  R1=$(curl -s -b $ND -H 'Content-Type: application/json' -X POST $B2/api/driver-location -d '{"lat":36.7101,"lng":-119.7202,"accuracy":7.4,"driverId":"joshua","loadId":"FAKE","tripNumber":9}' | python3 -c "import json,sys;print(json.load(sys.stdin)['accepted'])"); sleep 0.5
  chk "1. GPS during an open trip → history row"   "$R1|$($PSQL -c "select count(*) from driver_locations where driver_id='nadia'")" "True|1"
  chk "2/3. driver id, load and trip come from the session, not the body" "$($PSQL -c "select driver_id, load_id, trip_number from driver_locations order by id desc limit 1")" "nadia|$NLD|1"
  chk "6. lat/lng/accuracy/timestamp stored as sent"  "$($PSQL -c "select lat, lng, accuracy, (at > now() - interval '1 minute') from driver_locations order by id desc limit 1")" "36.7101|-119.7202|7|t"
  chk "8. throttled repeat: 202 and no extra row"   "$(curl -s -b $ND -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B2/api/driver-location -d '{"lat":36.7102,"lng":-119.7203}')|$($PSQL -c "select count(*) from driver_locations where driver_id='nadia'")" "202|1"
  curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/_test/backdate-location -d '{"driverId":"nadia","seconds":25}' -o /dev/null
  curl -s -b $ND -H 'Content-Type: application/json' -X POST $B2/api/driver-location -d '{"lat":36.7300,"lng":-119.7400,"accuracy":6}' -o /dev/null; sleep 0.5
  chk "5. points retained chronologically for the trip" "$($PSQL -c "select string_agg(lat::text, ',' order by at) from driver_locations where load_id='$NLD' and trip_number=1")" "36.7101,36.73"
  chk "7. last-known position is the newest point"     "$(curl -s -b $PM $B2/api/driver-locations | python3 -c "import json,sys;print([x['lat'] for x in json.load(sys.stdin)['locations'] if x['driverId']=='nadia'][0])")" "36.73"
  chk "   manager can read the load's trail"           "$(curl -s -b $PM $B2/api/loads/$NLD/track | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d['points']), d['points'][0]['tripNumber'])")" "2 1"
  chk "10. driver cannot read a trail"                 "$(curl -s -b $ND -o /dev/null -w '%{http_code}' $B2/api/loads/$NLD/track)" "403"
  chk "10. manager still cannot post a location"       "$(curl -s -b $PM -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B2/api/driver-location -d '{"lat":1,"lng":1}')" "403"
  # Between trips (returning) the return leg is attributed to the trip just delivered.
  for A in arrived-pickup loaded arrived-jobsite trip-complete; do curl -s -b $ND -H 'Content-Type: application/json' -X POST $B2/api/loads/$NLD/trip-action -d "{\"action\":\"$A\",\"yardId\":\"vbt\"}" -o /dev/null; done
  curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/_test/backdate-location -d '{"driverId":"nadia","seconds":25}' -o /dev/null
  curl -s -b $ND -H 'Content-Type: application/json' -X POST $B2/api/driver-location -d '{"lat":36.7500,"lng":-119.7600}' -o /dev/null; sleep 0.5
  chk "   all trips done on the load → no further history" "$($PSQL -c "select count(*) from driver_locations where driver_id='nadia'")" "2"
  # 9. Postgres failure on the history table must not hang or break the driver.
  $PSQL -c "drop table driver_locations" >/dev/null
  curl -s -b $ND -H 'Content-Type: application/json' -X POST $B2/api/loads/$NLD/trip-action -d '{"action":"start-trip"}' -o /dev/null   # rejected (all delivered) — fine; use a fresh load instead
  curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/pos -d '{"po":{"poNumber":"PG-NADIA2","customer":"Nadia Co","deliveryDate":"'"$(date +%F)"'"},"splits":[{"truckId":"nadia","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' -o /dev/null
  NLD2=$(curl -s -b $PM $B2/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);po=[p for p in d['pos'] if p['poNumber']=='PG-NADIA2'][0];print([l['id'] for l in d['loads'] if l['poId']==po['id']][0])")
  curl -s -b $ND -H 'Content-Type: application/json' -X POST $B2/api/loads/$NLD2/trip-action -d '{"action":"start-trip"}' -o /dev/null
  curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/_test/backdate-location -d '{"driverId":"nadia","seconds":25}' -o /dev/null
  chk "9. history table gone: driver post still answers 200 in <5s" "$(curl -s --max-time 5 -b $ND -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B2/api/driver-location -d '{"lat":36.76,"lng":-119.77}')" "200"
  chk "   ...last-known still updated, server alive"   "$(curl -s -b $PM $B2/api/driver-locations | python3 -c "import json,sys;print([x['lat'] for x in json.load(sys.stdin)['locations'] if x['driverId']=='nadia'][0])")|$(curl -s -o /dev/null -w '%{http_code}' $B2/healthz)" "36.76|200"
  chk "   ...trail read reports the failure, not a hang" "$(curl -s --max-time 5 -b $PM -o /dev/null -w '%{http_code}' $B2/api/loads/$NLD2/track)" "500"
  # users.truck_id holding a vehicle id (old screen) must not blind the driver.
  $PSQL -c "update users set truck_id='truck-4' where username='nadia'" >/dev/null
  curl -s -c $ND -o /dev/null -X POST -d 'username=nadia&password=nadia123' $B2/login
  chk "session truckId self-heals to the roster id" "$(curl -s -b $ND $B2/api/me | python3 -c "import json,sys;print(json.load(sys.stdin)['truckId'])")" "nadia"
  chk "  ...so her loads are still visible" "$(curl -s -b $ND $B2/api/my-dispatch | python3 -c "import json,sys;print(len(json.load(sys.stdin)['loads']))")" "2"
  pkill -f "^node server.js" >/dev/null 2>&1; sleep 1
  # Restart so store_boot exists, then damage the store row and boot again.
  (VBT_TEST_HOOKS=1 DATABASE_URL="$TEST_DATABASE_URL" PORT=$P2 node server.js > /tmp/vbt-test-pg.log 2>&1 &)
  for i in $(seq 1 20); do sleep 1; curl -sf $B2/healthz >/dev/null 2>&1 && break; done
  chk "store_boot snapshot written on boot" "$($PSQL -c "select count(*) from dispatch_data where key='store_boot' and value like '%PG-REAL%'")" "1"
  pkill -f "^node server.js" >/dev/null 2>&1; sleep 1
  $PSQL -c "update dispatch_data set value='{not json' where key='store'" >/dev/null
  (VBT_TEST_HOOKS=1 DATABASE_URL="$TEST_DATABASE_URL" PORT=$P2 node server.js > /tmp/vbt-test-pg.log 2>&1 &)
  for i in $(seq 1 20); do sleep 1; curl -sf $B2/healthz >/dev/null 2>&1 && break; done
  chk "boot with unreadable store: loaded=false"   "$(curl -s $B2/healthz | python3 -c "import json,sys;print(json.load(sys.stdin)['loaded'])")" "False"
  chk "  ...and healthz no longer claims durable"  "$(curl -s $B2/healthz | python3 -c "import json,sys;print(json.load(sys.stdin)['persistence']['durable'])")" "False"
  curl -s -c $PM -X POST -d "username=joshua&password=joshua123" $B2/login -o /dev/null
  chk "write attempt while locked is refused (503)" "$(curl -s -b $PM -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B2/api/pos -d '{"po":{"customer":"Overwriter","deliveryDate":"2026-01-01"},"splits":[]}')" "503"
  chk "read while locked is refused, not an empty board" "$(curl -s -b $PM -o /dev/null -w '%{http_code}' $B2/api/data)" "503"
  chk "store row was NOT overwritten"     "$($PSQL -c "select value from dispatch_data where key='store'")" "{not json"
  chk "store_prev was NOT rotated away"   "$($PSQL -c "select count(*) from dispatch_data where key='store_prev' and value like '%PG-REAL%'")" "1"
  chk "backups endpoint reachable while locked" "$(curl -s -b $PM -o /dev/null -w '%{http_code}' $B2/api/admin/backups)" "200"
  chk "restore demands confirm" "$(curl -s -b $PM -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B2/api/admin/restore -d '{"from":"store_boot"}')" "400"
  RS=$(curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/admin/restore -d '{"from":"store_boot","confirm":"RESTORE"}')
  chk "restore from store_boot succeeds" "$(echo "$RS" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('success'), d.get('loaded'))")" "True True"
  chk "damaged row kept as store_before_restore" "$($PSQL -c "select value from dispatch_data where key='store_before_restore'")" "{not json"
  chk "real PO is back after restore" "$(curl -s -b $PM $B2/api/data | python3 -c "import json,sys;print(len([p for p in json.load(sys.stdin)['pos'] if p['poNumber']=='PG-REAL']))")" "1"
  chk "writes work again after restore" "$(curl -s -b $PM -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B2/api/pos -d '{"po":{"poNumber":"PG-AFTER","customer":"After Restore","deliveryDate":"'"$(date +%F)"'"},"splits":[{"truckId":"rigo","truckUnitId":"truck-4","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}')" "200"
  # A missing store row next to existing backups is a lost row, not a new company.
  pkill -f "^node server.js" >/dev/null 2>&1; sleep 1
  $PSQL -c "delete from dispatch_data where key='store'" >/dev/null
  (VBT_TEST_HOOKS=1 DATABASE_URL="$TEST_DATABASE_URL" PORT=$P2 node server.js > /tmp/vbt-test-pg.log 2>&1 &)
  for i in $(seq 1 20); do sleep 1; curl -sf $B2/healthz >/dev/null 2>&1 && break; done
  chk "missing store row + backups present: refuses to seed" "$(curl -s $B2/healthz | python3 -c "import json,sys;print(json.load(sys.stdin)['loaded'])")" "False"
  chk "  ...no store row was created" "$($PSQL -c "select count(*) from dispatch_data where key='store'")" "0"
  pkill -f "^node server.js" >/dev/null 2>&1
fi
echo
echo "── 23. Old data: approved-but-unlocked load becomes locked on load ──"
cat > data.json <<'JSON'
{"pos":[{"id":"PO-OLD","poNumber":"OLD-1","customer":"Legacy Co","deliveryDate":"2026-01-05","status":"completed"}],
 "loads":[{"id":"L-OLD","poId":"PO-OLD","truckId":"beryle","material":"Dirt","loadsAssigned":1,"loadsDelivered":1,
           "deliveryDate":"2026-01-05","status":"completed","approvalStatus":"approved","locked":false,"billingBatchId":"BB-STUCK"}],
 "billingBatches":[{"id":"BB-STUCK","loadIds":["L-OLD"],"syncStatus":"syncing","qbInvoiceId":"","customer":"Legacy Co","totalAmount":0,"lineItems":[]}],
 "unitConfig":{"byUnit":{"ton":25,"load":1,"hour":1,"mile":1},"byMaterial":{}}}
JSON
(VBT_TEST_HOOKS=1 node server.js > /tmp/vbt-test-old.log 2>&1 &)
for i in $(seq 1 20); do sleep 1; curl -sf $B/healthz >/dev/null 2>&1 && break; done
curl -s -c $M -X POST -d "username=joshua&password=joshua123" $B/login -o /dev/null
chk "legacy approved load is locked after normalize" "$(curl -s -b $M $B/api/data | python3 -c "import json,sys;print([x for x in json.load(sys.stdin)['loads'] if x['id']=='L-OLD'][0]['locked'])")" "True"
chk "  ...and the generic update is refused" "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X PUT $B/api/loads/L-OLD -d '{"material":"Sand"}')" "403"
chk "fabricated hour:1 / mile:1 seeds are removed on load" "$(curl -s -b $M $B/api/costing/settings | python3 -c "import json,sys;u=json.load(sys.stdin)['unitConfig']['byUnit'];print('hour' in u, 'mile' in u, u['ton'])")" "False False 25"
chk "batch stuck in 'syncing' at restart becomes failed" "$(curl -s -b $M $B/api/billing-batches | python3 -c "import json,sys;b=[x for x in json.load(sys.stdin)['items'] if x['id']=='BB-STUCK'][0];print(b['syncStatus'], 'restart' in b['errorMessage'])")" "failed True"
pkill -f "^node server.js" >/dev/null 2>&1
rm -f data.json

[ "$SKIPPED" -gt 0 ] && SK=", $SKIPPED section(s) skipped" || SK=""
echo "════ $PASS passed, $FAIL failed$SK ════"
[ "$FAIL" -eq 0 ]
