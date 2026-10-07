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
rm -f data.json data-ids.json telemetry.json
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
chk "  ...and it is the real page"  "$(curl -s -b $M $B/app/ | grep -c 'id=\"sec-today\"')" "1"
chk "static assets serve"           "$(curl -s -o /dev/null -w '%{http_code}' -b $M $B/app/index.html)" "200"
chk "/api/me identifies the user"   "$(curl -s -b $M $B/api/me | python3 -c "import json,sys;print(json.load(sys.stdin)['username'])")" "joshua"

PNG="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
# Every "loaded" tap now carries the trip's ticket (Phase 1a). Unique number each call.
TKN=0; tkt() { TKN=$((TKN+1)); echo "{\"source\":\"supplier\",\"number\":\"T$RANDOM$RANDOM\",\"netTons\":24.5,\"photo\":\"$PNG\"}"; }
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
ta '{"action":"loaded","ticket":'"$(tkt)"'}'
chk "5. loaded → Loaded / En Route"      "$(fl "r['status']")" "Loaded / En Route"
ta '{"action":"arrived-jobsite"}'
chk "6. arrived jobsite → At Jobsite"    "$(fl "r['status']")" "At Jobsite"
ta '{"action":"trip-complete"}'
chk "7. trip done, one load left → Returning, load 2 of 2" "$(fl "r['status'], r['load']['loadsDelivered'], r['load']['loadNumber'], r['load']['tripNumber']")" "Returning 1 2 2"
ta '{"action":"start-trip"}'; ta '{"action":"arrived-pickup","yardId":"vulcan"}'; ta '{"action":"loaded","ticket":'"$(tkt)"'}'; ta '{"action":"arrived-jobsite"}'; ta '{"action":"trip-complete"}'
curl -s -b $LD -H 'Content-Type: application/json' -X PUT $B/api/loads/$FL -d "{\"pod\":{\"signedBy\":\"x\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null
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
  curl -s -b $D -H 'Content-Type: application/json' -X POST $B/api/loads/$LOAD/trip-action -d "{\"action\":\"loaded\",\"ticket\":$(tkt),\"gps\":{\"lat\":36.72,\"lng\":-119.72}}" -o /dev/null
  for A in arrived-jobsite trip-complete; do
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

# $38/ton x 25 tons x 2 loads = $1900 for this load. Cost follows the ACTUAL
# yard trip by trip, so the section-3 load (planned VBT, but its middle trip
# was loaded at Vulcan) also owes Vulcan one load of 3/4 Rock: $950. Grand
# total $2850, and both screens must agree.
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/pos -d '{
 "po":{"customer":"Cost Check","deliveryDate":"'"$(date +%F)"'"},
 "splits":[{"truckId":"matthew","material":"3/4 Rock","loadsAssigned":2,"vendorId":"vulcan"}]}' -o /dev/null
CL=$(curl -s -b $M $B/api/data | python3 -c "
import json,sys
print([l['id'] for l in json.load(sys.stdin)['loads'] if l['material']=='3/4 Rock' and l['truckId']=='matthew'][0])")
# Two delivered loads on record (planted with the test hook: the office update no longer
# accepts loadsDelivered — CRITICAL 2 — and this fixture is older, trip-less data).
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/_test/set-load -d "{\"id\":\"$CL\",\"fields\":{\"loadsDelivered\":2}}" -o /dev/null
chk "profitability cost = 38x25x2 + one Vulcan trip on the VBT-planned load" "$(curl -s -b $M $B/api/profitability | python3 -c "import json,sys;print(int(json.load(sys.stdin)['grand']['cost']))")" "2850"
chk "material-costs agrees"        "$(curl -s -b $M $B/api/material-costs | python3 -c "import json,sys;print(int(json.load(sys.stdin)['grandTotal']))")" "2850"
chk "  ...the Vulcan trip on the VBT-planned load is costed to Vulcan" "$(curl -s -b $M $B/api/material-costs | python3 -c "import json,sys;v=json.load(sys.stdin)['vendors']['vulcan'];print(v['totalLoads'], int(v['totalCost']))")" "3 2850"
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
chk "driver step succeeds with mail unconfigured" "$(curl -s -o /dev/null -w '%{http_code}' -b $L -H 'Content-Type: application/json' -X POST $B/api/loads/$NL/trip-action -d '{"action":"loaded","ticket":'"$(tkt)"'}')" "200"
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
  curl -s -b $V -H 'Content-Type: application/json' -X POST $B/api/loads/$VL/trip-action -d "{\"action\":\"$A\",\"yardId\":\"vbt\",\"ticket\":$(tkt)}" -o /dev/null; done
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
for F in approvalStatus billStatus voided locked billingBatchId trips qbInvoiceId truckId truckUnitId deliveryDate loadsDelivered customerRate manualBillRef; do
  case $F in trips) V='[]';; voided|locked) V='true';; loadsDelivered|customerRate) V='1';; *) V='"approved"';; esac
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
  curl -s -b $D -H 'Content-Type: application/json' -X POST $B/api/loads/$SML/trip-action -d "{\"action\":\"$A\",\"ticket\":$(tkt)}" -o /dev/null
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
curl -s -b $MD -H 'Content-Type: application/json' -X POST $B/api/loads/$ML/trip-action -d "{\"action\":\"loaded\",\"ticket\":$(tkt)}" -o /dev/null
for A in arrived-jobsite trip-complete; do
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
# Tomorrow's load for beryle must not reach him today; yesterday's unfinished one is named, not served as today's work.
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
chk "/api/data (driver): no future, no yesterday-open (not today's work), no other drivers" "$(echo "$DD"|sed -n 1p)" "False False False"
chk "  ...no rates or billing fields in the driver payload" "$(echo "$DD"|sed -n 2p)" "False"
chk "  ...no notification config in the driver payload"     "$(echo "$DD"|sed -n 3p)" "False"
MDV=$(curl -s -b $D $B/api/my-dispatch | python3 -c "import json,sys;d=json.load(sys.stdin);n=sorted(l['poNumber'] for l in d['loads']);print('FUTURE' in n, 'YESTERDAY' in n, 'OTHERS' in n, [x['poNumber'] for x in d['earlierOpen']])")
chk "/api/my-dispatch agrees; yesterday's unfinished load is named separately, not served as today's" "$MDV" "False False False ['YESTERDAY']"
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
# The yard changes through Quick Assign (the generic load update refuses vendorId — CRITICAL 2).
curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/loads/$YL/assign -d '{"yardId":"cemex"}' -o /dev/null
YP=$(curl -s -b $M $B/api/data | python3 -c "import json,sys;l=[x for x in json.load(sys.stdin)['loads'] if x['id']=='$YL'][0];print(l['pickup']['name'], l['vendorName'], l.get('actualYardId'), l['vendorRateIsDefault'])")
chk "yard change through Quick Assign re-resolves, clears mirror, re-prices" "$YP" "CEMEX CEMEX None False"
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
tg '{"action":"loaded","ticket":'"$(tkt)"'}'; tg '{"action":"arrived-jobsite"}'; tg '{"action":"trip-complete"}'
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

echo "── 35. PO numbers are unique per order; customers are reusable ──"
mk() { curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/pos -d "$1" -o /tmp/po.json -w '%{http_code}'; }
# Truck #14 is still on Carlos's DRV-CHK load today (section 17), so putting
# Rigo on it is a double-booking the dispatcher has to confirm: "force" is that
# confirmation. The PO-number rules below are checked before the conflict rule.
BODY1='{"po":{"poNumber":"45021","customer":"Repeat Customer","deliveryDate":"'"$(date +%F)"'","address":"900 Elm St","city":"Clovis","plannedVendorId":"vulcan"},"splits":[{"truckId":"rigo","truckUnitId":"truck-14","material":"3/4 Rock","loadsAssigned":2,"vendorId":"vulcan"}],"force":true,"reason":"test: deliberate double-booking of Truck #14"}'
chk "first PO #45021 created"                       "$(mk "$BODY1")" "200"
chk "duplicate PO #45021 refused with the exact message" "$(mk "$BODY1")|$(python3 -c "import json;d=json.load(open('/tmp/po.json'));print(d['error'], d.get('duplicate'))")" "409|PO #45021 already exists. Please enter a different PO number. True"
chk "  ...case/whitespace variant is the same number" "$(mk "$(echo "$BODY1" | sed 's/"45021"/" 45021 "/')")" "409"
chk "  ...still exactly one PO #45021"               "$(curl -s -b $M $B/api/data | python3 -c "import json,sys;print(len([p for p in json.load(sys.stdin)['pos'] if p['poNumber']=='45021']))")" "1"
chk "same customer, same jobsite, same date, new number → OK" "$(mk "$(echo "$BODY1" | sed 's/"45021"/"45022"/')")" "200"
chk "same customer, third PO → OK"                   "$(mk "$(echo "$BODY1" | sed 's/"45021"/"45023"/; s/900 Elm St/12 Oak Ave/; s/Clovis/Sanger/')")" "200"
chk "  ...three POs, one customer record"            "$(curl -s -b $M $B/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);print(len([p for p in d['pos'] if p['customer']=='Repeat Customer']), len([c for c in d['customers'] if c['name']=='Repeat Customer']))")" "3 1"
chk "blank number auto-assigns a free one"           "$(mk "$(echo "$BODY1" | sed 's/"45021"/""/')")|$(python3 -c "import json;d=json.load(open('/tmp/po.json'));print(d['po']['poNumber'].startswith('PO-'))")" "200|True"
P1=$(curl -s -b $M $B/api/data | python3 -c "import json,sys;print([p['id'] for p in json.load(sys.stdin)['pos'] if p['poNumber']=='45021'][0])")
P2=$(curl -s -b $M $B/api/data | python3 -c "import json,sys;print([p['id'] for p in json.load(sys.stdin)['pos'] if p['poNumber']=='45022'][0])")
chk "renaming a PO to an existing number → 409"      "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X PUT $B/api/pos/$P2 -d '{"poNumber":"45021"}')" "409"
chk "renaming to a free number → 200"                "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X PUT $B/api/pos/$P2 -d '{"poNumber":"45022-B"}')" "200"
chk "live check: taken"                              "$(curl -s -b $M "$B/api/pos/check-number?poNumber=45021" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['exists'], d['customer'])")" "True Repeat Customer"
chk "live check: free"                               "$(curl -s -b $M "$B/api/pos/check-number?poNumber=99999" | python3 -c "import json,sys;print(json.load(sys.stdin)['exists'])")" "False"
chk "driver cannot use the check"                    "$(curl -s -b $D -o /dev/null -w '%{http_code}' "$B/api/pos/check-number?poNumber=45021")" "403"
chk "form split records the chosen truck"            "$(curl -s -b $M $B/api/data | python3 -c "import json,sys;l=[x for x in json.load(sys.stdin)['loads'] if x['poId']=='$P1'][0];print(l['truckUnitId'], l['driverName'])")" "truck-14 Rigo"
chk "unknown truck on a split → 400"                 "$(mk "$(echo "$BODY1" | sed 's/"45021"/"45030"/; s/truck-14/truck-99/')")" "400"
chk "inactive/unknown driver on a split → 400"       "$(mk "$(echo "$BODY1" | sed 's/"45021"/"45031"/; s/"rigo"/"nobody"/')")" "400"
# Jobsites: previous addresses for the customer; coordinates inherited on request only.
curl -s -b $M -H 'Content-Type: application/json' -X PUT $B/api/pos/$P1/location -d '{"lat":36.8252,"lng":-119.7029}' -o /dev/null
JS=$(curl -s -b $M "$B/api/jobsites?customer=Repeat%20Customer" | python3 -c "
import json,sys;j=json.load(sys.stdin)['jobsites']
elm=[x for x in j if x['address']=='900 Elm St'][0]
print(len(j)); print(elm['count'], elm['geo']['lat'] if elm['geo'] else None, elm['geoPoId']=='$P1')")
chk "jobsites: two distinct sites for the customer"  "$(echo "$JS"|sed -n 1p)" "2"
chk "  ...Elm St used by 3 POs, carries the saved point" "$(echo "$JS"|sed -n 2p)" "3 36.8252 True"
chk "new PO for the same site inherits the point when asked" "$(mk "$(echo "$BODY1" | sed 's/"45021"/"45040"/; s/"plannedVendorId":"vulcan"/"plannedVendorId":"vulcan","jobsiteFromPoId":"'"$P1"'"/')")|$(python3 -c "import json;d=json.load(open('/tmp/po.json'));print(d['po']['geo']['lat'], d['po']['geo']['inheritedFromPoId']=='$P1')")" "200|36.8252 True"
chk "  ...and, since OA5, also when the same address is typed again without asking — marked as inherited from the earlier PO" "$(mk "$(echo "$BODY1" | sed 's/"45021"/"45041"/')")|$(python3 -c "import json;d=json.load(open('/tmp/po.json'));print('geo' in d['po'], d['po'].get('geo',{}).get('inheritedBy'))")" "200|True same-address"

echo "── 36. Phase 1a — the Cornelio 9/14/2026 packet: trailer 3B, four tickets, 94.64 actual tons ──"
# Assets exactly as on the paper: driver Cornelio, Truck #3, trailer 3B, Vulcan Madera → North Fork,
# customer Dave Christian Construction, PO 25031, four supplier tickets.
J='Content-Type: application/json'
jq() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
curl -s -b $M -H "$J" -X POST $B/api/drivers -d '{"username":"cornelio","password":"cornelio1","displayName":"Cornelio"}' -o /dev/null
T3=$(curl -s -b $M -H "$J" -X POST $B/api/fleet/trucks -d '{"truckNum":"Truck #3","type":"End Dump"}' | jq "d['truck']['id']")
TR=$(curl -s -b $M -H "$J" -X POST $B/api/fleet/trailers -d "{\"number\":\"3B\",\"type\":\"Transfer\",\"defaultTruckId\":\"$T3\"}" | jq "d['trailer']['id']")
chk "1. trailer 3B is its own asset (not a truck field)" "$(curl -s -b $M $B/api/fleet | jq "[t['number'] for t in d['trailers']], any(t['id']=='$TR' for t in d['trailers']), [t for t in d['trucks'] if t['id']=='$T3'][0].get('trailerId')")" "['3B'] True None"
chk "   duplicate trailer number refused"   "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H "$J" -X POST $B/api/fleet/trailers -d '{"number":"3b"}')" "400"
chk "   trailer visible to Quick Assign"    "$(curl -s -b $M $B/api/today | jq "[t['number'] for t in d['trailers']]")" "['3B']"
chk "   existing trucks untouched (no trailer key added)" "$(curl -s -b $M $B/api/fleet | jq "sum(1 for t in d['trucks'] if 'trailerId' in t)")" "0"
VM=$(curl -s -b $M -H "$J" -X POST $B/api/vendors -d '{"name":"Vulcan Madera","location":"Madera, CA","force":true}' | jq "d['vendor']['id']")
CID=$(curl -s -b $M -H "$J" -X POST $B/api/customers -d '{"name":"Dave Christian Construction","city":"North Fork"}' | jq "d['customer']['id']")
chk "2. new customer bills on planned tons by default" "$(curl -s -b $M $B/api/customers | jq "[c['billingBasis'] for c in d['customers'] if c['id']=='$CID'][0]")" "planned"
curl -s -b $M -H "$J" -X POST $B/api/customer-prices -d '{"customer":"Dave Christian Construction","material":"3/4 Class 2 Base","unit":"ton","price":30}' -o /dev/null
curl -s -b $M -H "$J" -X POST $B/api/pos -d '{
 "po":{"poNumber":"25031","customer":"Dave Christian Construction","deliveryDate":"'"$(date +%F)"'","address":"North Fork","city":"North Fork","plannedVendorId":"'"$VM"'"},
 "splits":[{"truckId":"cornelio","truckUnitId":"'"$T3"'","trailerId":"'"$TR"'","material":"3/4 Class 2 Base","loadsAssigned":4,"vendorId":"'"$VM"'"}]}' -o /dev/null
CL=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']==[p for p in d['pos'] if p['poNumber']=='25031'][0]['id']][0]")
cl() { curl -s -b $M $B/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);l=[x for x in d['loads'] if x['id']=='$CL'][0];print($1)"; }
chk "3. load: Cornelio, Truck #3, trailer 3B, Vulcan Madera, 4 loads, nothing delivered" "$(cl "l['driverName'], l['truckUnitId']=='$T3', l['trailer']['number'], l['pickup']['name'], l['loadsAssigned'], l['tons']['plannedTons'], l['tons']['actualTons'], l['tons']['tonsSource']")" "Cornelio True 3B Vulcan Madera 4 0 0 planned"
CD=$(mktemp); curl -s -c $CD -X POST -d "username=cornelio&password=cornelio1" $B/login -o /dev/null
ca() { curl -s -b $CD -H "$J" -X POST $B/api/loads/$CL/trip-action -d "$1" "${@:2}"; }
chk "4. driver sees truck and trailer on the card" "$(curl -s -b $CD $B/api/my-dispatch | jq "[ (l['truckLabel'], l['trailerLabel']) for l in d['loads'] if l['loadId']=='$CL'][0]")" "('Truck #3', '3B')"
# Trip 1 — 37432733, 23.20 t
ca '{"action":"start-trip","gps":{"lat":36.74,"lng":-119.77}}' -o /dev/null
ca "{\"action\":\"arrived-pickup\",\"yardId\":\"$VM\"}" -o /dev/null
chk "5. Loaded without a ticket is refused"          "$(ca '{"action":"loaded"}' | jq "d['error']")" "Ticket source must be \"supplier\" (scale ticket) or \"vbt\" (internal ticket)"
chk "   supplier ticket without net tons refused"    "$(ca '{"action":"loaded","ticket":{"source":"supplier","number":"37432733","photo":"'"$PNG"'"}}' | jq "d['error']")" "Net tons from the scale ticket are required for a supplier ticket"
chk "   supplier ticket without a photo refused"     "$(ca '{"action":"loaded","ticket":{"source":"supplier","number":"37432733","netTons":23.2}}' | jq "d['error']")" "A photo of the scale ticket is required"
chk "   ...nothing was stamped by the refusals"      "$(cl "l['trips'][0]['timestamps'].get('loadedAt'), l['trips'][0].get('ticket')")" "None None"
chk "   ticket check: 37432733 not on file yet"      "$(curl -s -b $CD "$B/api/tickets/check?number=37432733" | jq "d['available']")" "True"
R=$(ca '{"action":"loaded","ticket":{"source":"supplier","number":"37432733","netTons":23.20,"photo":"'"$PNG"'"}}')
chk "6. trip 1 Loaded with ticket 37432733 / 23.20 t" "$(echo "$R" | jq "d.get('success'), d['load']['trips'][0]['ticket']['number'], d['load']['trips'][0]['ticket']['netTons'], d['load']['trips'][0]['ticket']['source'], d['load']['trips'][0]['ticket']['confirmedBy'], d['load']['trips'][0]['ticket']['entry']")" "True 37432733 23.2 supplier cornelio typed"
chk "   ticket photo satisfies the load-level photo (no second upload later)" "$(cl "bool(l['ticketImage'] or l['ticketImageUrl'])")" "True"
chk "   Loaded twice is refused"                     "$(ca '{"action":"loaded","ticket":{"source":"supplier","number":"X1","netTons":1,"photo":"'"$PNG"'"}}' | jq "d['error']")" "This load is already marked loaded"
ca '{"action":"arrived-jobsite"}' -o /dev/null; ca '{"action":"trip-complete"}' -o /dev/null
# Trip 2 — reuse of 37432733 must be refused and name the owner
ca '{"action":"start-trip"}' -o /dev/null; ca "{\"action\":\"arrived-pickup\",\"yardId\":\"$VM\"}" -o /dev/null
DUP=$(ca '{"action":"loaded","ticket":{"source":"supplier","number":"37432733","netTons":23.19,"photo":"'"$PNG"'"}}')
chk "7. duplicate ticket refused (409) and names the load that owns it" "$(echo "$DUP" | jq "d['ownerLoadId']=='$CL', d['ownerTripNum'], d['error']")" "True 1 Ticket #37432733 is already recorded on $CL (PO 25031, Dave Christian Construction, load 1 of 4, Cornelio). Please check the ticket number."
chk "   ...spacing/case do not evade the check"      "$(ca '{"action":"loaded","ticket":{"source":"supplier","number":" 3743 2733 ","netTons":23.19,"photo":"'"$PNG"'"}}' | jq "d['ownerTripNum']")" "1"
chk "   live check agrees"                           "$(curl -s -b $CD "$B/api/tickets/check?number=37432733" | jq "d['available'], d['ownerTripNum']")" "False 1"
chk "   trip 2 still not loaded after the refusal"   "$(cl "l['trips'][1]['timestamps'].get('loadedAt'), l['trips'][1].get('ticket')")" "None None"
ca '{"action":"loaded","ticket":{"source":"supplier","number":"37432799","netTons":23.19,"photo":"'"$PNG"'"}}' -o /dev/null
ca '{"action":"arrived-jobsite"}' -o /dev/null; ca '{"action":"trip-complete"}' -o /dev/null
# Trip 3 — 37432862, 24.45 t ; Trip 4 — 37432920, 23.80 t
ca '{"action":"start-trip"}' -o /dev/null; ca "{\"action\":\"arrived-pickup\",\"yardId\":\"$VM\"}" -o /dev/null
ca '{"action":"loaded","ticket":{"source":"supplier","number":"37432862","netTons":24.45,"photo":"'"$PNG"'"}}' -o /dev/null
ca '{"action":"arrived-jobsite"}' -o /dev/null; ca '{"action":"trip-complete"}' -o /dev/null
ca '{"action":"start-trip"}' -o /dev/null; ca "{\"action\":\"arrived-pickup\",\"yardId\":\"$VM\"}" -o /dev/null
ca '{"action":"loaded","ticket":{"source":"supplier","number":"37432920","netTons":23.80,"photo":"'"$PNG"'"}}' -o /dev/null
curl -s -b $CD -H "$J" -X POST $B/api/driver-location -d '{"lat":37.05,"lng":-119.95,"accuracy":9}' -o /dev/null
chk "8. Fleet Map row: trailer 3B, current ticket, running actual tons" "$(curl -s -b $M $B/api/fleet/live | jq "[(r['trailerNum'], r['truckNum'], r['load']['currentTicket']['number'], r['load']['currentTicket']['netTons'], r['load']['actualTons'], r['load']['tickets'], r['status']) for r in d['trucks'] if r['driverId']=='cornelio'][0]")" "('3B', 'Truck #3', '37432920', 23.8, 70.84, 3, 'Loaded / En Route')"
ca '{"action":"arrived-jobsite"}' -o /dev/null; ca '{"action":"trip-complete"}' -o /dev/null
chk "9. four tickets: 23.20 + 23.19 + 24.45 + 23.80 = 94.64 actual; planned stays 4 × 25 = 100" "$(cl "l['tons']['ticketNumbers'], l['tons']['actualTons'], l['tons']['plannedTons'], l['tons']['tonsSource'], l['tons']['actualComplete'], l['tons']['missingTickets']")" "['37432733', '37432799', '37432862', '37432920'] 94.64 100 supplier True []"
chk "   Today board carries trailer and tons"        "$(curl -s -b $M $B/api/today | jq "[(l['trailerNum'], l['tons']['actualTons'], l['tons']['plannedTons']) for l in d['loads'] if l['id']=='$CL'][0]")" "('3B', 94.64, 100)"
chk "   driver payload shows each trip's ticket"     "$(curl -s -b $CD $B/api/my-dispatch | jq "[[(t['tripNum'], t['ticket']['number'], t['ticket']['netTons']) for t in l['trips']] for l in d['loads'] if l['loadId']=='$CL'][0]")" "[(1, '37432733', 23.2), (2, '37432799', 23.19), (3, '37432862', 24.45), (4, '37432920', 23.8)]"
# Corrections before approval: own trip keeps its number; another trip's number is refused.
chk "10. driver may correct a ticket before submitting" "$(curl -s -b $CD -H "$J" -X PUT $B/api/loads/$CL/trips/3/ticket -d '{"source":"supplier","number":"37432862","netTons":24.45}' | jq "d.get('success'), d['ticket']['netTons'], d['tons']['actualTons']")" "True 24.45 94.64"
chk "   correction to a number used by trip 2 is refused" "$(curl -s -b $CD -o /dev/null -w '%{http_code}' -H "$J" -X PUT $B/api/loads/$CL/trips/3/ticket -d '{"source":"supplier","number":"37432799","netTons":24.45}')" "409"
chk "   another driver cannot touch it"                "$(curl -s -b $LD -o /dev/null -w '%{http_code}' -H "$J" -X PUT $B/api/loads/$CL/trips/3/ticket -d '{"source":"supplier","number":"37432862","netTons":1}')" "403"
# Signature, submit, approve — the existing gate, unchanged.
curl -s -b $CD -H "$J" -X PUT $B/api/loads/$CL -d "{\"pod\":{\"signedBy\":\"DCC Foreman\",\"signature\":\"$PNG\",\"signedAt\":\"2026-09-14T22:00:00Z\"}}" -o /dev/null
ca '{"action":"delivered"}' -o /dev/null
chk "11. submitted with 4 of 4, not partial"         "$(cl "l['approvalStatus'], l['loadsDelivered'], l['isPartial']")" "submitted 4 False"
chk "   approval screen data: tickets + planned vs actual on the load" "$(cl "len([t for t in l['trips'] if t['ticket']]), l['tons']['plannedTons'], l['tons']['actualTons']")" "4 100 94.64"
curl -s -b $M -H "$J" -X POST $B/api/loads/$CL/approve -d '{}' -o /dev/null
chk "12. approved and locked"                        "$(cl "l['approvalStatus'], l['locked']")" "approved True"
chk "   approval audit records trailer, planned 100, actual 94.64, the four tickets" "$(curl -s -b $M "$B/api/audit-log?action=approved-load" | jq "[(e['details']['trailer'], e['details']['plannedTons'], e['details']['actualTons'], e['details']['tickets']) for e in d['entries'] if e['target']=='$CL'][0]")" "('3B', 100, 94.64, ['37432733', '37432799', '37432862', '37432920'])"
chk "   ticket correction after approval refused (manager too)" "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H "$J" -X PUT $B/api/loads/$CL/trips/1/ticket -d '{"source":"supplier","number":"37432733","netTons":50}')" "403"
chk "   trailer cannot change on the locked load"    "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H "$J" -X POST $B/api/loads/$CL/assign -d '{"trailerId":null}')" "403"
# Billing: planned basis is the default and unchanged — 100 t at $30.
PV=$(curl -s -b $M -H "$J" -X POST $B/api/billing-batches/preview -d "{\"loadIds\":[\"$CL\"]}")
chk "13. planned basis: 100.00 t × \$30 = \$3000, description says planned tons" "$(echo "$PV" | jq "d['groups'][0]['lineItems'][0]['basis'], d['groups'][0]['lineItems'][0]['tons'], d['groups'][0]['totalAmount'], d['groups'][0]['lineItems'][0]['description']")" "planned 100 3000 3/4 Class 2 Base — 4 loads (100.00 ton @ \$30/ton)"
chk "   invalid basis refused"                       "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H "$J" -X PUT $B/api/customers/$CID -d '{"billingBasis":"whatever"}')" "400"
curl -s -b $M -H "$J" -X PUT $B/api/customers/$CID -d '{"billingBasis":"actual"}' -o /dev/null
PV=$(curl -s -b $M -H "$J" -X POST $B/api/billing-batches/preview -d "{\"loadIds\":[\"$CL\"]}")
chk "14. actual basis: 94.64 t × \$30 = \$2839.20 from 4 tickets" "$(echo "$PV" | jq "d['groups'][0]['lineItems'][0]['basis'], d['groups'][0]['lineItems'][0]['tons'], d['groups'][0]['totalAmount'], d['groups'][0]['lineItems'][0]['description'], d['groups'][0]['ticketNumbers']")" "actual 94.64 2839.2 3/4 Class 2 Base — 4 loads (94.64 ton actual from 4 tickets @ \$30/ton) ['37432733', '37432799', '37432862', '37432920']"
chk "   basis change is audited"                     "$(curl -s -b $M "$B/api/audit-log?action=changed-billing-basis" | jq "[(e['details']['from'], e['details']['to']) for e in d['entries'] if e['target']=='$CID'][0]")" "('planned', 'actual')"
# The invoice QuickBooks would receive carries the actual quantity and the ticket numbers.
curl -s -b $M -H "$J" -X POST $B/api/_test/qb-fake -d '{"mode":"ok"}' -o /dev/null
CB=$(curl -s -b $M -H "$J" -X POST $B/api/billing-batches -d "{\"loadIds\":[\"$CL\"]}" | jq "d['batches'][0]['id']")
chk "15. batch stores 94.64 t and the ticket numbers" "$(curl -s -b $M $B/api/billing-batches | jq "[(b['totalTons'], b['ticketNumbers']) for b in d['items'] if b['id']=='$CB'][0]")" "(94.64, ['37432733', '37432799', '37432862', '37432920'])"
curl -s -b $M -H "$J" -X POST $B/api/billing-batches/$CB/send -d '{}' -o /dev/null
chk "   invoice line quantity = 94.64, tickets in the note" "$(curl -s -b $M $B/api/_test/qb-fake | jq "d['invoices'][-1]['lines'][0]['quantity'], d['invoices'][-1]['lines'][0]['amount'], '37432920' in d['invoices'][-1]['PrivateNote']")" "94.64 2839.2 True"
# Actual basis with a delivered trip that has no tons: not priceable until corrected. VBT ticket, no tons.
curl -s -b $M -H "$J" -X POST $B/api/pos -d '{
 "po":{"poNumber":"25032","customer":"Dave Christian Construction","deliveryDate":"'"$(date +%F)"'","address":"North Fork","city":"North Fork","plannedVendorId":"vbt"},
 "splits":[{"truckId":"cornelio","truckUnitId":"'"$T3"'","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' -o /dev/null
C2=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']==[p for p in d['pos'] if p['poNumber']=='25032'][0]['id']][0]")
c2() { curl -s -b $CD -H "$J" -X POST $B/api/loads/$C2/trip-action -d "$1" "${@:2}"; }
c2 '{"action":"start-trip"}' -o /dev/null; c2 '{"action":"arrived-pickup","yardId":"vbt"}' -o /dev/null
chk "16. VBT internal ticket: number only, no tons, no photo required" "$(c2 '{"action":"loaded","ticket":{"source":"vbt","number":"VBT-3298"}}' | jq "d.get('success'), d['load']['trips'][0]['ticket']['source'], d['load']['trips'][0]['ticket']['netTons']")" "True vbt None"
c2 '{"action":"arrived-jobsite"}' -o /dev/null; c2 '{"action":"trip-complete"}' -o /dev/null
chk "   load-level photo still required for a photo-less VBT ticket" "$(c2 '{"action":"delivered"}' | jq "d['error']")" "Ticket photo required"
curl -s -b $CD -H "$J" -X PUT $B/api/loads/$C2 -d "{\"ticketImage\":\"$PNG\",\"pod\":{\"signedBy\":\"x\",\"signature\":\"$PNG\",\"signedAt\":\"2026-09-14T22:00:00Z\"}}" -o /dev/null
c2 '{"action":"delivered"}' -o /dev/null
chk "   the approval checklist flags it: actual-basis customer, ticket with no tons → approve is refused until acknowledged" "$(curl -s -b $M -H "$J" -X POST $B/api/loads/$C2/approve -d '{}' | jq "d['code'], d['checklist']['warnings']")" "approval_incomplete ['Ticket: Dave Christian Construction is billed on actual tons and 1 ticket(s) have no tons']"
curl -s -b $M -H "$J" -X POST $B/api/loads/$C2/approve -d '{"acknowledge":true}' -o /dev/null   # the manager approves knowing the tons are missing; billing still refuses to price it
PV=$(curl -s -b $M -H "$J" -X POST $B/api/billing-batches/preview -d "{\"loadIds\":[\"$C2\"]}")
chk "17. actual-basis load with no ticket tons is NOT priceable (never billed on 25 t silently)" "$(echo "$PV" | jq "d['groups'][0]['unconfigured'], d['groups'][0]['unconfiguredReasons'][0]")" "True Dave Christian Construction is billed on actual ticket tons, but 1 of 1 delivered load on $C2 has no confirmed ticket tons"
chk "   ...and batch creation refuses it"            "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H "$J" -X POST $B/api/billing-batches -d "{\"loadIds\":[\"$C2\"]}")" "400"
chk "   planned-basis customers are untouched by all this (section 8 math holds)" "$(curl -s -b $M -H "$J" -X POST $B/api/billing-batches/preview -d "{\"loadIds\":[\"$C2\"]}" -o /dev/null; curl -s -b $M $B/api/customers | jq "sorted(set(c.get('billingBasis','planned') for c in d['customers'] if c['id']!='$CID'))")" "['planned']"
# Trailer history rule: a trailer on a load is deactivated, never deleted.
chk "18. trailer with history is deactivated, not deleted" "$(curl -s -b $M -X DELETE $B/api/fleet/trailers/$TR | jq "d['deactivated']")|$(curl -s -b $M $B/api/fleet | jq "[t['active'] for t in d['trailers'] if t['id']=='$TR'][0]")" "True|False"
chk "   deactivated trailer cannot be assigned"      "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H "$J" -X POST $B/api/loads/$NL/assign -d "{\"trailerId\":\"$TR\"}")" "400"
chk "   approved load keeps trailer 3B as history"   "$(cl "l['trailer']['number']")" "3B"
# Daily movement vs billable freight: nothing in Phase 1a stores odometer or segment data.
chk "19. no shift/segment/odometer fields were introduced on the load" "$(cl "[k for k in l.keys() if k in ('freight','freightSegmentId','odStart','odEnd','shiftId')]")" "[]"

echo "── 37. Shift foundation: the driver's day — odometer legs, breaks, truck change, Daily Log ──"
# Generic checks run on Leonardo (Truck #12) and Beryle so Truck #3's readings stay untouched for the packet in section 38.
curl -s -b $M -H "$J" -X PUT $B/api/fleet/trailers/$TR -d '{"active":true}' -o /dev/null
BD=$(mktemp); curl -s -c $BD -X POST -d "username=beryle&password=beryle123" $B/login -o /dev/null
sc() { curl -s -b $LD $B/api/shifts/current | jq "$1"; }
chk "1. no open day: current is null, 11 inspection items, usual truck prefilled" "$(sc "d['shift'], len(d['inspectionItems']), d['defaults']['truckId'], [t['lastOdometer'] for t in d['trucks'] if t['id']=='truck-12'][0]")" "None 11 truck-12 None"
chk "   Today panel has no days yet"                  "$(curl -s -b $M $B/api/today | jq "len(d['shifts'])")" "0"
ss() { curl -s -b $LD -H "$J" -X POST $B/api/shifts/start -d "$1" "${@:2}"; }
chk "2. start without a signature refused"           "$(ss '{"truckId":"truck-12","odometer":41000,"inspection":{"satisfactory":true}}' | jq "d['error']")" "Sign the inspection to start your day"
chk "   defects unlisted refused"                    "$(ss '{"truckId":"truck-12","odometer":41000,"inspection":{"satisfactory":false},"signature":"'"$PNG"'"}' | jq "d['error']")" "List the defect(s) found, or mark the inspection satisfactory"
chk "   no odometer refused"                         "$(ss '{"truckId":"truck-12","inspection":{"satisfactory":true},"signature":"'"$PNG"'"}' | jq "d['error']")" "Enter the starting odometer as a whole number"
chk "   manager cannot start a driver's day"         "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H "$J" -X POST $B/api/shifts/start -d '{"truckId":"truck-12","odometer":1,"inspection":{"satisfactory":true},"signature":"'"$PNG"'"}')" "403"
SH=$(ss '{"truckId":"truck-12","trailerId":"'"$TR"'","odometer":41000,"inspection":{"satisfactory":false,"defects":["Mirrors"],"remarks":"left mirror cracked"},"signature":"'"$PNG"'"}' | jq "d['shift']['id']")
chk "3. day opened: Leonardo, Truck #12, 3B, OD 41,000, defect recorded, signed" "$(sc "d['shift']['status'], d['shift']['driverName'], d['shift']['truckNum'], d['shift']['trailerNum'], d['shift']['startOdometer'], d['shift']['inspection']['satisfactory'], d['shift']['inspection']['defects'], d['shift']['inspection']['hasSignature'], d['shift']['dailyMiles']")" "open Leonardo Truck #12 3B 41000 False ['Mirrors'] True None"
chk "   truck's last reading updated"                "$(curl -s -b $M $B/api/fleet | jq "[t['mileage'] for t in d['trucks'] if t['id']=='truck-12'][0]")" "41000"
chk "   second Start day refused (shift_open)"       "$(ss '{"truckId":"truck-14","odometer":1,"inspection":{"satisfactory":true},"signature":"'"$PNG"'"}' | jq "d['code']")" "shift_open"
chk "   another driver cannot start on Truck #12"    "$(curl -s -b $BD -H "$J" -X POST $B/api/shifts/start -d '{"truckId":"truck-12","odometer":41000,"inspection":{"satisfactory":true},"signature":"'"$PNG"'"}' | jq "d['code']")" "truck_in_use"
chk "4. fleet live row carries the open day"         "$(curl -s -b $M $B/api/fleet/live | jq "[(r['shift']['truckNum'], r['shift']['startOdometer'], r['shift']['segment']) for r in d['trucks'] if r['driverId']=='leonardo'][0]")" "('Truck #12', 41000, None)"
chk "   Today panel lists the open day"              "$(curl -s -b $M $B/api/today | jq "[(s['driverName'], s['status']) for s in d['shifts']]")" "[('Leonardo', 'open')]"
curl -s -b $LD -H "$J" -X POST $B/api/shifts/$SH/break -d '{"action":"start"}' -o /dev/null; sleep 1
chk "5. break running shows on the day"              "$(sc "d['shift']['openBreak'], len(d['shift']['breaks'])")" "True 1"
chk "   ending a break twice refused"                "$(curl -s -b $LD -H "$J" -X POST $B/api/shifts/$SH/break -d '{"action":"end"}' -o /dev/null; curl -s -b $LD -H "$J" -X POST $B/api/shifts/$SH/break -d '{"action":"end"}' | jq "d['error']")" "No break is running"
chk "   break recorded with an end time"             "$(sc "d['shift']['openBreak'], bool(d['shift']['breaks'][0]['endAt'])")" "False True"
# Truck change: old truck's final reading, new truck's first reading, never mixed.
chk "5b. trailer 3B is on Leonardo's open day → Beryle cannot start with it" "$(curl -s -b $BD -H "$J" -X POST $B/api/shifts/start -d '{"truckId":"truck-2","trailerId":"'"$TR"'","odometer":9000,"inspection":{"satisfactory":true},"signature":"'"$PNG"'"}' | jq "d['code'], d['error']")" "trailer_in_use Trailer 3B is already on Leonardo's open day (Truck #12)"
curl -s -b $BD -H "$J" -X POST $B/api/shifts/start -d '{"truckId":"truck-2","odometer":9000,"inspection":{"satisfactory":true},"signature":"'"$PNG"'"}' -o /dev/null
chk "6. change to a truck on another open day refused" "$(curl -s -b $LD -H "$J" -X POST $B/api/shifts/$SH/truck-change -d '{"fromOdometer":41050,"toTruckId":"truck-2","toOdometer":9001}' | jq "d['code']")" "truck_in_use"
chk "   final reading below the leg start refused"   "$(curl -s -b $LD -H "$J" -X POST $B/api/shifts/$SH/truck-change -d '{"fromOdometer":40990,"toTruckId":"truck-4","toOdometer":62000}' | jq "d['error']")" "Truck #12's final reading cannot be below its starting reading 41,000"
chk "   truck change recorded: Truck #12 @41,050 → Truck #4 @62,000" "$(curl -s -b $LD -H "$J" -X POST $B/api/shifts/$SH/truck-change -d '{"fromOdometer":41050,"toTruckId":"truck-4","toOdometer":62000}' | jq "d['shift']['truckNum'], d['shift']['events'][-1]['type'], d['shift']['events'][-1]['fromOdometer'], d['shift']['events'][-1]['toOdometer'], len(d['shift']['legs'])")" "Truck #4 truck-change 41050 62000 2"
chk "   old truck's last reading is its final one"   "$(curl -s -b $M $B/api/fleet | jq "[(t['id'], t['mileage']) for t in d['trucks'] if t['id'] in ('truck-12','truck-4')]")" "[('truck-4', 62000), ('truck-12', 41050)]"
chk "7. end day below the current leg start refused" "$(curl -s -b $LD -H "$J" -X POST $B/api/shifts/$SH/end -d '{"odometer":61000}' | jq "d['error']")" "The ending odometer cannot be below Truck #4's starting reading 62,000"
chk "   end day at 62,070 → closed; daily miles = (41,050−41,000) + (62,070−62,000) = 120, none billable" "$(curl -s -b $LD -H "$J" -X POST $B/api/shifts/$SH/end -d '{"odometer":62070}' | jq "d['shift']['status'], d['shift']['dailyMiles'], d['shift']['billableMiles'], d['shift']['nonBillableMiles'], d['shift']['closedBy'], d['shift']['workMinutes'] is not None")" "closed 120 0 120 leonardo True"
chk "   ending twice refused"                        "$(curl -s -b $LD -o /dev/null -w '%{http_code}' -H "$J" -X POST $B/api/shifts/$SH/end -d '{"odometer":62080}')" "400"
chk "   a new day can start after closing"           "$(sc "d['shift'], d['lastShift']['truckId'], [t['lastOdometer'] for t in d['trucks'] if t['id']=='truck-4'][0]")" "None truck-4 62070"
DL=$(curl -s -b $LD $B/api/shifts/$SH/daily-log)
chk "8. Daily Log page: driver, trucks, trailer, 120 miles, defect, both legs, final (no DRAFT)" "$(echo "$DL" | python3 -c "
import sys,re;h=sys.stdin.read()
print('Daily Log — Leonardo' in h, 'Truck #12' in h and 'Truck #4' in h, '3B' in h, '>120<' in h, 'Defects: Mirrors' in h, h.count('<div class=\"draft\">'), 'Truck change Truck #12 (41,050)' in h)")" "True True True True True 0 True"
chk "   another driver cannot open it"               "$(curl -s -b $BD -o /dev/null -w '%{http_code}' $B/api/shifts/$SH/daily-log)" "403"
chk "   the office can"                              "$(curl -s -b $M -o /dev/null -w '%{http_code}' $B/api/shifts/$SH/daily-log)" "200"
# Lower-than-last reading: refused, then accepted only when confirmed, and recorded.
chk "9. start below the truck's last reading refused" "$(curl -s -b $M -H "$J" -X PUT $B/api/fleet/trucks/truck-14 -d '{"mileage":500}' -o /dev/null; ss '{"truckId":"truck-14","odometer":100,"inspection":{"satisfactory":true},"signature":"'"$PNG"'"}' | jq "d['code'], d['lastOdometer']")" "odometer_below_last 500"
chk "   ...accepted when confirmed, and noted as an event" "$(ss '{"truckId":"truck-14","odometer":100,"acceptLowerOdometer":true,"inspection":{"satisfactory":true},"signature":"'"$PNG"'"}' | jq "d['shift']['status'], d['shift']['events'][0]['type'], d['shift']['events'][0]['lastOdometer']")" "open odometer-below-last 500"
SH2=$(sc "d['shift']['id']"); curl -s -b $LD -H "$J" -X POST $B/api/shifts/$SH2/end -d '{"odometer":130}' -o /dev/null
# Manager closes a driver's day with a reason (Beryle forgot to end).
BS=$(curl -s -b $M $B/api/today | jq "[s['id'] for s in d['shifts'] if s['driverId']=='beryle'][0]")
chk "10. manager close needs a reason"               "$(curl -s -b $M -H "$J" -X POST $B/api/shifts/$BS/close -d '{"odometer":9040}' | jq "d['error']")" "A reason is required to close a driver's day for them"
chk "   manager closes Beryle's day with a reason"   "$(curl -s -b $M -H "$J" -X POST $B/api/shifts/$BS/close -d '{"odometer":9040,"reason":"driver forgot End day"}' | jq "d['shift']['status'], d['shift']['dailyMiles'], d['shift']['closedBy'], d['shift']['closeReason']")" "closed 40 joshua driver forgot End day"
chk "   audit trail: started, changed truck, ended, closed for driver" "$(curl -s -b $M "$B/api/audit-log" | jq "sorted(set(e['action'] for e in d['entries'] if e['action'] in ('started-shift','changed-truck','ended-shift','closed-shift-for-driver')))")" "['changed-truck', 'closed-shift-for-driver', 'ended-shift', 'started-shift']"
chk "   trips ran all day long without a shift in every earlier section (legacy path intact)" "$(curl -s -b $M $B/api/data | jq "sum(1 for l in d['loads'] if l.get('freightSegmentId'))")" "0"

echo "── 38. Freight Segment — the Cornelio 9/14/2026 packet, reproduced from the records ──"
# Fresh server: the packet's ticket numbers are unique company-wide, so this day is built from nothing.
pkill -f "^node server.js" >/dev/null 2>&1; sleep 1; rm -f data.json data-ids.json telemetry.json
(VBT_TEST_HOOKS=1 node server.js > /tmp/vbt-test-seg.log 2>&1 &)
for i in $(seq 1 20); do sleep 1; curl -sf $B/healthz >/dev/null 2>&1 && break; done
curl -s -c $M -X POST -d "username=joshua&password=joshua123" $B/login -o /dev/null
J='Content-Type: application/json'; TODAY=$(date +%F)
jq() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
curl -s -b $M -H "$J" -X POST $B/api/drivers -d '{"username":"cornelio","password":"cornelio1","displayName":"Cornelio"}' -o /dev/null
T3=$(curl -s -b $M -H "$J" -X POST $B/api/fleet/trucks -d '{"truckNum":"Truck #3","type":"End Dump"}' | jq "d['truck']['id']")
TR=$(curl -s -b $M -H "$J" -X POST $B/api/fleet/trailers -d "{\"number\":\"3B\",\"type\":\"Transfer\",\"defaultTruckId\":\"$T3\"}" | jq "d['trailer']['id']")
VM=$(curl -s -b $M -H "$J" -X POST $B/api/vendors -d '{"name":"Vulcan Madera","location":"Madera, CA","force":true}' | jq "d['vendor']['id']")
CID=$(curl -s -b $M -H "$J" -X POST $B/api/customers -d '{"name":"Dave Christian Construction","city":"North Fork"}' | jq "d['customer']['id']")
curl -s -b $M -H "$J" -X POST $B/api/customer-prices -d '{"customer":"Dave Christian Construction","material":"3/4 Class 2 Base","unit":"ton","price":30}' -o /dev/null
curl -s -b $M -H "$J" -X POST $B/api/pos -d '{"po":{"poNumber":"25031","customer":"Dave Christian Construction","deliveryDate":"'"$TODAY"'","address":"North Fork","city":"North Fork","plannedVendorId":"'"$VM"'"},
 "splits":[{"truckId":"cornelio","truckUnitId":"'"$T3"'","trailerId":"'"$TR"'","material":"3/4 Class 2 Base","loadsAssigned":4,"vendorId":"'"$VM"'"}]}' -o /dev/null
CL=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']==[p for p in d['pos'] if p['poNumber']=='25031'][0]['id']][0]")
CD=$(mktemp); curl -s -c $CD -X POST -d "username=cornelio&password=cornelio1" $B/login -o /dev/null
ca() { curl -s -b $CD -H "$J" -X POST $B/api/loads/$CL/trip-action -d "$1" "${@:2}"; }
cl() { curl -s -b $M $B/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);l=[x for x in d['loads'] if x['id']=='$CL'][0];print($1)"; }
sc() { curl -s -b $CD $B/api/shifts/current | jq "$1"; }
# Legacy path: with no day open, a trip creates no segment (as every earlier section did).
LG=$(mktemp); curl -s -c $LG -X POST -d "username=leonardo&password=leo123" $B/login -o /dev/null
curl -s -b $M -H "$J" -X POST $B/api/pos -d '{"po":{"poNumber":"LEG-1","customer":"Legacy Co","deliveryDate":"'"$TODAY"'","address":"1 Old Rd","city":"Fresno"},"splits":[{"truckId":"leonardo","truckUnitId":"truck-12","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' -o /dev/null
LL=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']==[p for p in d['pos'] if p['poNumber']=='LEG-1'][0]['id']][0]")
curl -s -b $LG -H "$J" -X POST $B/api/loads/$LL/trip-action -d '{"action":"start-trip"}' -o /dev/null
chk "0. no day open → arrived-pickup works as before and opens no segment" "$(curl -s -b $LG -H "$J" -X POST $B/api/loads/$LL/trip-action -d '{"action":"arrived-pickup","yardId":"vbt"}' | jq "d.get('success'), d['load'].get('freightSegmentId')")|$(curl -s -b $M $B/api/freight-segments | jq "len(d['segments'])")" "True None|0"
# ── The day: Truck #3, trailer 3B, OD 85,558 at VBT ──
SH=$(curl -s -b $CD -H "$J" -X POST $B/api/shifts/start -d '{"truckId":"'"$T3"'","trailerId":"'"$TR"'","odometer":85558,"inspection":{"satisfactory":true},"signature":"'"$PNG"'"}' | jq "d['shift']['id']")
chk "1. day open on Truck #3 + 3B at 85,558"        "$(sc "d['shift']['truckNum'], d['shift']['trailerNum'], d['shift']['startOdometer'], d['shift']['openSegment']")" "Truck #3 3B 85558 None"
ca '{"action":"start-trip","gps":{"lat":36.74,"lng":-119.77}}' -o /dev/null
R=$(ca "{\"action\":\"arrived-pickup\",\"yardId\":\"$VM\"}")
chk "2. first arrival at Vulcan Madera: odometer required, nothing stamped, preview names the freight" "$(echo "$R" | jq "d['success'], d['code'], d['preview']['customer'], d['preview']['originName'], d['preview']['destinationLabel'], d['preview']['floor']")|$(cl "l['trips'][0]['timestamps'].get('arrivedPickup')")" "False odometer_required Dave Christian Construction Vulcan Madera North Fork, North Fork 85558|None"
chk "   a reading below the day's start is refused" "$(ca "{\"action\":\"arrived-pickup\",\"yardId\":\"$VM\",\"odometer\":85000}" | jq "d['code'], d['error']")" "odometer_invalid Odometer 85,000 is below Truck #3's reading at the start of this leg (85,558)"
R=$(ca "{\"action\":\"arrived-pickup\",\"yardId\":\"$VM\",\"odometer\":85591}")
FS=$(echo "$R" | jq "d['load']['freightSegmentId']")
chk "3. freight segment opened at 85,591: Vulcan Madera → North Fork, 1 load, open, no end" "$(curl -s -b $M $B/api/freight-segments/$FS | jq "d['segment']['customer'], d['segment']['originName'], d['segment']['destinationLabel'], d['segment']['odStart'], d['segment']['odEnd'], d['segment']['status'], d['segment']['loadIds']==['$CL'], d['segment']['truckNum'], d['segment']['trailerNum'], d['segment']['tripCount']")" "Dave Christian Construction Vulcan Madera North Fork, North Fork 85591 None open True Truck #3 3B 1"
chk "   VBT → Vulcan (85,558 → 85,591) is outside the segment" "$(curl -s -b $M $B/api/freight-segments/$FS | jq "d['segment']['odStart'] - 85558")" "33"
chk "   trip and load point at the segment"         "$(cl "l['freightSegmentId']=='$FS', l['trips'][0]['freightSegmentId']=='$FS', l['trips'][0]['timestamps']['arrivedPickup'] is not None")" "True True True"
ca '{"action":"loaded","ticket":{"source":"supplier","number":"37432733","netTons":23.20,"photo":"'"$PNG"'"}}' -o /dev/null; ca '{"action":"arrived-jobsite"}' -o /dev/null; ca '{"action":"trip-complete"}' -o /dev/null
chk "4. a delivered trip does NOT close the segment" "$(curl -s -b $M $B/api/freight-segments/$FS | jq "d['segment']['status'], d['segment']['tripsDelivered']")" "open 1"
# Returning for more loads: no new segment, no odometer asked.
ca '{"action":"start-trip"}' -o /dev/null
chk "5. returning to Vulcan joins the same segment without an odometer" "$(ca "{\"action\":\"arrived-pickup\",\"yardId\":\"$VM\"}" | jq "d.get('success'), d['load']['trips'][1]['freightSegmentId']=='$FS'")|$(curl -s -b $M $B/api/freight-segments | jq "len(d['segments'])")" "True True|1"
ca '{"action":"loaded","ticket":{"source":"supplier","number":"37432799","netTons":23.19,"photo":"'"$PNG"'"}}' -o /dev/null; ca '{"action":"arrived-jobsite"}' -o /dev/null; ca '{"action":"trip-complete"}' -o /dev/null
ca '{"action":"start-trip"}' -o /dev/null; ca "{\"action\":\"arrived-pickup\",\"yardId\":\"$VM\"}" -o /dev/null
ca '{"action":"loaded","ticket":{"source":"supplier","number":"37432862","netTons":24.45,"photo":"'"$PNG"'"}}' -o /dev/null; ca '{"action":"arrived-jobsite"}' -o /dev/null; ca '{"action":"trip-complete"}' -o /dev/null
ca '{"action":"start-trip"}' -o /dev/null; ca "{\"action\":\"arrived-pickup\",\"yardId\":\"$VM\"}" -o /dev/null
ca '{"action":"loaded","ticket":{"source":"supplier","number":"37432920","netTons":23.80,"photo":"'"$PNG"'"}}' -o /dev/null
chk "6. driver cannot finish freight with load 4 still en route" "$(curl -s -b $CD -H "$J" -X POST $B/api/freight-segments/$FS/close -d '{"odometer":85808}' | jq "d['code']")" "trip_en_route"
ca '{"action":"arrived-jobsite"}' -o /dev/null; ca '{"action":"trip-complete"}' -o /dev/null
chk "7. four trips, 94.64 t actual on the segment, still open after the last delivery" "$(curl -s -b $M $B/api/freight-segments/$FS | jq "d['segment']['tripCount'], d['segment']['tripsDelivered'], d['segment']['actualTons'], d['segment']['plannedTons'], d['segment']['ticketNumbers'], d['segment']['status']")" "4 4 94.64 100 ['37432733', '37432799', '37432862', '37432920'] open"
curl -s -b $CD -H "$J" -X PUT $B/api/loads/$CL -d "{\"pod\":{\"signedBy\":\"DCC Foreman\",\"signature\":\"$PNG\",\"signedAt\":\"2026-09-14T22:00:00Z\"}}" -o /dev/null
ca '{"action":"delivered"}' -o /dev/null
chk "   submitting the load does not close it either" "$(cl "l['approvalStatus']")|$(curl -s -b $M $B/api/freight-segments/$FS | jq "d['segment']['status']")" "submitted|open"
chk "   Fleet Map row shows the open freight"       "$(curl -s -b $M $B/api/fleet/live | jq "[(r['shift']['segment']['customer'], r['shift']['segment']['odStart']) for r in d['trucks'] if r['driverId']=='cornelio'][0]")" "('Dave Christian Construction', 85591)"
# Dispatch adds a fifth load for the same customer and jobsite: joins the open segment, from a different yard.
curl -s -b $M -H "$J" -X POST $B/api/pos -d '{"po":{"poNumber":"25034","customer":"Dave Christian Construction","deliveryDate":"'"$TODAY"'","address":"North Fork","city":"North Fork","plannedVendorId":"vbt"},"splits":[{"truckId":"cornelio","truckUnitId":"'"$T3"'","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' -o /dev/null
C5=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']==[p for p in d['pos'] if p['poNumber']=='25034'][0]['id']][0]")
c5() { curl -s -b $CD -H "$J" -X POST $B/api/loads/$C5/trip-action -d "$1" "${@:2}"; }
c5 '{"action":"start-trip"}' -o /dev/null
chk "8. a fifth load (same customer + jobsite, VBT yard) joins the open segment; its yard is kept" "$(c5 '{"action":"arrived-pickup","yardId":"vbt"}' | jq "d.get('success'), d['load']['freightSegmentId']=='$FS', d['load']['trips'][0]['actualYardName']")|$(curl -s -b $M $B/api/freight-segments/$FS | jq "len(d['segment']['loadIds']), [y['name'] for y in d['segment']['originYards']], d['segment']['originName']")" "True True VBT Yard|2 ['Vulcan Madera', 'VBT Yard'] Vulcan Madera"
c5 '{"action":"loaded","ticket":{"source":"vbt","number":"VBT-3298","netTons":12.5}}' -o /dev/null; c5 '{"action":"arrived-jobsite"}' -o /dev/null; c5 '{"action":"trip-complete"}' -o /dev/null
# A different customer while the freight is open: refused, nothing stamped.
curl -s -b $M -H "$J" -X POST $B/api/pos -d '{"po":{"poNumber":"25035","customer":"ABC Materials","deliveryDate":"'"$TODAY"'","address":"500 Main St","city":"Merced","plannedVendorId":"cemex"},"splits":[{"truckId":"cornelio","truckUnitId":"'"$T3"'","material":"3/4 Rock","loadsAssigned":1,"vendorId":"cemex"}]}' -o /dev/null
CA=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']==[p for p in d['pos'] if p['poNumber']=='25035'][0]['id']][0]")
curl -s -b $CD -H "$J" -X POST $B/api/loads/$CA/trip-action -d '{"action":"start-trip"}' -o /dev/null
chk "9. another customer's pickup is refused while the freight is open (segment_open), nothing stamped" "$(curl -s -b $CD -H "$J" -X POST $B/api/loads/$CA/trip-action -d '{"action":"arrived-pickup","yardId":"cemex","odometer":85810}' | jq "d['code'], d['segment']['customer'], d['error']")" "segment_open Dave Christian Construction Finish the Dave Christian Construction freight (Vulcan Madera → North Fork, North Fork) before starting ABC Materials's"
chk "10. End day with the freight open is refused (segment_open), day stays open" "$(curl -s -b $CD -H "$J" -X POST $B/api/shifts/$SH/end -d '{"odometer":85868}' | jq "d['code'], d['segment']['id']=='$FS'")|$(sc "d['shift']['status']")" "segment_open True|open"
chk "11. finish freight below its start is refused" "$(curl -s -b $CD -H "$J" -X POST $B/api/freight-segments/$FS/close -d '{"odometer":85500}' | jq "d['error']")" "The ending odometer (85,500) cannot be below the starting odometer (85,591)"
chk "   Finish freight at 85,808 → closed by the driver, 217 billable miles" "$(curl -s -b $CD -H "$J" -X POST $B/api/freight-segments/$FS/close -d '{"odometer":85808}' | jq "d['segment']['status'], d['segment']['billableMiles'], d['segment']['closedBy'], d['segment']['closeReason'], d['segment']['odEnd'] - d['segment']['odStart']")" "closed 217 cornelio driver 217"
chk "   closing twice refused"                      "$(curl -s -b $CD -o /dev/null -w '%{http_code}' -H "$J" -X POST $B/api/freight-segments/$FS/close -d '{"odometer":85808}')" "400"
# The paper's freight window is 6:30 → 3:00. The test ran in seconds, so the office sets the real times with a reason.
chk "12. office correction without a reason refused" "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H "$J" -X PUT $B/api/freight-segments/$FS -d '{"timeStart":"'"$TODAY"'T06:30:00-07:00"}')" "400"
chk "   office sets 6:30 → 3:00 with a reason: 8.50 billable hours, 217 miles unchanged" "$(curl -s -b $M -H "$J" -X PUT $B/api/freight-segments/$FS -d '{"timeStart":"'"$TODAY"'T06:30:00-07:00","timeEnd":"'"$TODAY"'T15:00:00-07:00","reason":"times from the paper log"}' | jq "d['segment']['billableHours'], d['segment']['billableMinutes'], d['segment']['billableMiles'], len(d['segment']['edits'])")" "8.5 510 217 1"
chk "   an end odometer beyond the day is refused later, at End day it is checked"  "$(curl -s -b $M -H "$J" -X PUT $B/api/freight-segments/$FS -d '{"odEnd":85500,"reason":"typo"}' | jq "d['error']")" "The ending odometer (85,500) cannot be below the starting odometer (85,591)"
# The ABC load: leave it unstarted for the packet numbers (void it), so the day has exactly one segment.
curl -s -b $M -X DELETE $B/api/loads/$CA -o /dev/null
chk "12b. End day below the freight's end (85,700 < 85,808) is refused" "$(curl -s -b $CD -H "$J" -X POST $B/api/shifts/$SH/end -d '{"odometer":85700}' | jq "d['error']")|$(sc "d['shift']['status']")" "The Dave Christian Construction freight ended at 85,808 — the day's ending odometer cannot be lower|open"
chk "13. End day at 85,868: daily 310, billable 217, non-billable 93 — all derived" "$(curl -s -b $CD -H "$J" -X POST $B/api/shifts/$SH/end -d '{"odometer":85868}' | jq "d['shift']['status'], d['shift']['dailyMiles'], d['shift']['billableMiles'], d['shift']['nonBillableMiles'], d['shift']['billableMinutes']")" "closed 310 217 93 510"
chk "   the driver's screen now says the day is closed, not 'not started'" "$(sc "d['shift'], d['lastShift']['date']==d['today'], d['lastShift']['dailyMiles'], d['lastShift']['billableMiles'], d['lastShift']['truckNum']")" "None True 310 217 Truck #3"
chk "   nothing stores the 93"                      "$(curl -s -b $M $B/api/shifts/$SH | python3 -c "import json,sys;s=json.load(sys.stdin)['shift'];print('nonBillableMiles' in s, [k for k in s if 'nonbill' in k.lower()])")|$(python3 -c "import json;s=json.load(open('data.json'));sh=[x for x in s['shifts'] if x['id']=='$SH'][0];print([k for k in sh if 'nonbill' in k.lower() or 'daily' in k.lower()])")" "True ['nonBillableMiles']|[]"
# Approval → lock; corrections after lock go through void, not a second system.
curl -s -b $M -H "$J" -X POST $B/api/loads/$CL/approve -d '{}' -o /dev/null
chk "14. one of two loads approved → segment not yet locked" "$(curl -s -b $M $B/api/freight-segments/$FS | jq "d['segment']['locked'], d['segment']['approvedLoads']")" "False 1"
curl -s -b $CD -H "$J" -X PUT $B/api/loads/$C5 -d "{\"ticketImage\":\"$PNG\",\"pod\":{\"signedBy\":\"x\",\"signature\":\"$PNG\",\"signedAt\":\"2026-09-14T22:00:00Z\"}}" -o /dev/null
c5 '{"action":"delivered"}' -o /dev/null; curl -s -b $M -H "$J" -X POST $B/api/loads/$C5/approve -d '{}' -o /dev/null
chk "   both approved → locked; edits, reopen and close all refused (403)" "$(curl -s -b $M $B/api/freight-segments/$FS | jq "d['segment']['locked']")|$(curl -s -b $M -o /dev/null -w '%{http_code}' -H "$J" -X PUT $B/api/freight-segments/$FS -d '{"odEnd":85900,"reason":"x"}')|$(curl -s -b $M -o /dev/null -w '%{http_code}' -H "$J" -X POST $B/api/freight-segments/$FS/reopen -d '{"reason":"x"}')" "True|403|403"
chk "   voiding a load unlocks the segment (existing correction path)" "$(curl -s -b $M -H "$J" -X POST $B/api/loads/$C5/void -d '{"reason":"wrong material"}' -o /dev/null; curl -s -b $M $B/api/freight-segments/$FS | jq "d['segment']['locked']")|$(curl -s -b $M -H "$J" -X POST $B/api/loads/$C5/unvoid -d '{}' -o /dev/null; curl -s -b $M $B/api/freight-segments/$FS | jq "d['segment']['locked']")" "False|True"
# Billing: ton lines never see the segment. 4 loads share 217 mi / 8.5 h ONCE for hour/mile customers.
PV=$(curl -s -b $M -H "$J" -X POST $B/api/billing-batches/preview -d "{\"loadIds\":[\"$CL\"]}")
chk "15. ton line (planned): 100 t × \$30, no miles or hours in it" "$(echo "$PV" | jq "d['groups'][0]['lineItems'][0]['tons'], d['groups'][0]['totalAmount'], 'mile' in d['groups'][0]['lineItems'][0]['description'] or 'hour' in d['groups'][0]['lineItems'][0]['description']")" "100 3000 False"
curl -s -b $M -H "$J" -X PUT $B/api/customers/$CID -d '{"billingBasis":"actual"}' -o /dev/null
chk "   ton line (actual): 94.64 t from 4 tickets — segment miles untouched" "$(curl -s -b $M -H "$J" -X POST $B/api/billing-batches/preview -d "{\"loadIds\":[\"$CL\"]}" | jq "d['groups'][0]['lineItems'][0]['tons'], d['groups'][0]['totalAmount']")" "94.64 2839.2"
# Hourly customer on Leonardo's day: two loads, one segment, hours counted once.
curl -s -b $M -H "$J" -X POST $B/api/customers -d '{"name":"Hourly Co","city":"Clovis"}' -o /dev/null
curl -s -b $M -H "$J" -X POST $B/api/customer-prices -d '{"customer":"Hourly Co","material":"Rock","unit":"hour","price":95}' -o /dev/null
curl -s -b $M -H "$J" -X POST $B/api/customer-prices -d '{"customer":"Hourly Co","material":"Gravel","unit":"hour","price":95}' -o /dev/null
curl -s -b $M -H "$J" -X POST $B/api/pos -d '{"po":{"poNumber":"H-1","customer":"Hourly Co","deliveryDate":"'"$TODAY"'","address":"9 Hour Ln","city":"Clovis","plannedVendorId":"cemex"},
 "splits":[{"truckId":"leonardo","truckUnitId":"truck-12","material":"Rock","loadsAssigned":1,"vendorId":"cemex"},{"truckId":"leonardo","truckUnitId":"truck-12","material":"Gravel","loadsAssigned":1,"vendorId":"cemex"}]}' -o /dev/null
H1=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']==[p for p in d['pos'] if p['poNumber']=='H-1'][0]['id'] and l['material']=='Rock'][0]")
H2=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']==[p for p in d['pos'] if p['poNumber']=='H-1'][0]['id'] and l['material']=='Gravel'][0]")
LS=$(curl -s -b $LG -H "$J" -X POST $B/api/shifts/start -d '{"truckId":"truck-12","odometer":41000,"inspection":{"satisfactory":true},"signature":"'"$PNG"'"}' | jq "d['shift']['id']")
run() { # run <loadId> <yard> [odometer]
  curl -s -b $LG -H "$J" -X POST $B/api/loads/$1/trip-action -d '{"action":"start-trip"}' -o /dev/null
  curl -s -b $LG -H "$J" -X POST $B/api/loads/$1/trip-action -d "{\"action\":\"arrived-pickup\",\"yardId\":\"$2\"${3:+,\"odometer\":$3}}" -o /dev/null
  curl -s -b $LG -H "$J" -X POST $B/api/loads/$1/trip-action -d "{\"action\":\"loaded\",\"ticket\":$(tkt)}" -o /dev/null
  curl -s -b $LG -H "$J" -X POST $B/api/loads/$1/trip-action -d '{"action":"arrived-jobsite"}' -o /dev/null
  curl -s -b $LG -H "$J" -X POST $B/api/loads/$1/trip-action -d '{"action":"trip-complete"}' -o /dev/null
  curl -s -b $LG -H "$J" -X PUT $B/api/loads/$1 -d "{\"pod\":{\"signedBy\":\"x\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null
  curl -s -b $LG -H "$J" -X POST $B/api/loads/$1/trip-action -d '{"action":"delivered"}' -o /dev/null
  curl -s -b $M -H "$J" -X POST $B/api/loads/$1/approve -d '{}' -o /dev/null
}
run $H1 cemex 41020; run $H2 cemex
HS=$(curl -s -b $M $B/api/freight-segments | jq "[s['id'] for s in d['segments'] if s['customer']=='Hourly Co'][0]")
chk "16. two hourly loads share one open segment → not priceable until it is finished" "$(curl -s -b $M -H "$J" -X POST $B/api/billing-batches/preview -d "{\"loadIds\":[\"$H1\",\"$H2\"]}" | jq "d['groups'][0]['unconfigured'], 'still open' in d['groups'][0]['unconfiguredReasons'][0]")" "True True"
curl -s -b $LG -H "$J" -X POST $B/api/freight-segments/$HS/close -d '{"odometer":41080}' -o /dev/null
chk "   both loads were already approved → the close locks it at once; time edit refused" "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H "$J" -X PUT $B/api/freight-segments/$HS -d '{"timeStart":"'"$TODAY"'T07:00:00-07:00","timeEnd":"'"$TODAY"'T09:00:00-07:00","reason":"paper log"}')" "403"
# Correction goes through the existing void path: void one load, fix the window, restore the load.
curl -s -b $M -H "$J" -X POST $B/api/loads/$H2/void -d '{"reason":"fix freight times"}' -o /dev/null
chk "   voided → unlocked → office sets 7:00 → 9:00 with a reason" "$(curl -s -b $M -H "$J" -X PUT $B/api/freight-segments/$HS -d '{"timeStart":"'"$TODAY"'T07:00:00-07:00","timeEnd":"'"$TODAY"'T09:00:00-07:00","reason":"paper log"}' | jq "d.get('success'), d['segment']['billableHours'], d['segment']['locked']")" "True 2 False"
curl -s -b $M -H "$J" -X POST $B/api/loads/$H2/unvoid -d '{}' -o /dev/null
chk "   restored → locked again with the corrected window" "$(curl -s -b $M $B/api/freight-segments/$HS | jq "d['segment']['locked'], d['segment']['billableHours']")" "True 2"
PV=$(curl -s -b $M -H "$J" -X POST $B/api/billing-batches/preview -d "{\"loadIds\":[\"$H1\",\"$H2\"]}")
chk "   closed: 2.00 hours × \$95 = \$190 for BOTH loads together, not 4 hours" "$(echo "$PV" | jq "d['groups'][0]['totalAmount'], [ (ln['measure'], ln['loads'], ln['amount']) for ln in d['groups'][0]['lineItems'] ]")" "190 [(2, 1, 190), (0, 1, 0)]"
chk "   the second load says where its hours were billed" "$(curl -s -b $M $B/api/profitability | python3 -c "import json,sys;print('ok')" >/dev/null; curl -s -b $M $B/api/data | jq "[l['segments'][0]['billableHours'] for l in d['loads'] if l['id']=='$H2'][0]")|$(echo "$PV" | jq "'from freight $HS' in d['groups'][0]['lineItems'][0]['description']")" "2|True"
curl -s -b $M -H "$J" -X POST $B/api/_test/qb-fake -d '{"mode":"ok"}' -o /dev/null
HB=$(curl -s -b $M -H "$J" -X POST $B/api/billing-batches -d "{\"loadIds\":[\"$H1\",\"$H2\"]}" | jq "d['batches'][0]['id']")
curl -s -b $M -H "$J" -X POST $B/api/billing-batches/$HB/send -d '{}' -o /dev/null
chk "   QuickBooks lines: 2 hours / \$190, and the second load 0 / \$0 saying where its hours went" "$(curl -s -b $M $B/api/_test/qb-fake | jq "[(ln['quantity'], ln['amount'], 'hours billed with' in ln['description']) for ln in d['invoices'][-1]['lines']]")" "[(2, 190, False), (0, 0, True)]"
# Second segment on the same day (mileage customer), windows must not overlap.
curl -s -b $M -H "$J" -X POST $B/api/customers -d '{"name":"Mileage Co","city":"Sanger"}' -o /dev/null
curl -s -b $M -H "$J" -X POST $B/api/customer-prices -d '{"customer":"Mileage Co","material":"Dirt","unit":"mile","price":4}' -o /dev/null
SPLIT='{"truckId":"leonardo","truckUnitId":"truck-12","material":"Dirt","loadsAssigned":1,"vendorId":"cemex"}'
curl -s -b $M -H "$J" -X POST $B/api/pos -d '{"po":{"poNumber":"M-1","customer":"Mileage Co","deliveryDate":"'"$TODAY"'","address":"2 Mile Rd","city":"Sanger","plannedVendorId":"cemex"},"splits":['"$SPLIT,$SPLIT,$SPLIT,$SPLIT"']}' -o /dev/null
MLS=$(curl -s -b $M $B/api/data | jq "' '.join(l['id'] for l in d['loads'] if l['poId']==[p for p in d['pos'] if p['poNumber']=='M-1'][0]['id'])")
M1=${MLS%% *}
curl -s -b $LG -H "$J" -X POST $B/api/loads/$M1/trip-action -d '{"action":"start-trip"}' -o /dev/null
chk "17. a second segment cannot start inside the first one's odometer window" "$(curl -s -b $LG -H "$J" -X POST $B/api/loads/$M1/trip-action -d '{"action":"arrived-pickup","yardId":"cemex","odometer":41050}' | jq "d['error']")" "Overlaps the Hourly Co freight (41,020 → 41,080)"
k=0; for L in $MLS; do k=$((k+1)); if [ $k -eq 1 ]; then run $L cemex 41090; else run $L cemex; fi; done
MS=$(curl -s -b $M $B/api/freight-segments | jq "[s['id'] for s in d['segments'] if s['customer']=='Mileage Co'][0]")
chk "   four mileage loads share ONE segment"       "$(curl -s -b $M $B/api/freight-segments/$MS | jq "len(d['segment']['loadIds']), d['segment']['tripCount']")" "4 4"
curl -s -b $LG -H "$J" -X POST $B/api/freight-segments/$MS/close -d '{"odometer":41120}' -o /dev/null
MIDS=$(python3 -c "import json;print(json.dumps('$MLS'.split()))")
chk "   mileage line: 4 loads, 30 mi × \$4 = \$120 ONCE (not 120 mi / \$480)" "$(curl -s -b $M -H "$J" -X POST $B/api/billing-batches/preview -d "{\"loadIds\":$MIDS}" | jq "len(d['groups'][0]['lineItems']), d['groups'][0]['lineItems'][0]['loads'], d['groups'][0]['lineItems'][0]['measure'], d['groups'][0]['totalAmount'], d['groups'][0]['lineItems'][0]['description']")" "1 4 30 120 Dirt — 4 loads (30.00 miles from freight $MS @ \$4/mile)"
MB=$(curl -s -b $M -H "$J" -X POST $B/api/billing-batches -d "{\"loadIds\":$MIDS}" | jq "d['batches'][0]['id']"); curl -s -b $M -H "$J" -X POST $B/api/billing-batches/$MB/send -d '{}' -o /dev/null
chk "   QuickBooks receives quantity 30 miles, \$120" "$(curl -s -b $M $B/api/_test/qb-fake | jq "[(ln['quantity'], ln['amount']) for ln in d['invoices'][-1]['lines']]")" "[(30, 120)]"
chk "   Leonardo's day: two segments, 60 + 30 = 90 billable of 130 daily, 40 non-billable" "$(curl -s -b $LG -H "$J" -X POST $B/api/shifts/$LS/end -d '{"odometer":41130}' | jq "d['shift']['dailyMiles'], d['shift']['billableMiles'], d['shift']['nonBillableMiles'], len(d['shift']['segments'])")" "130 90 40 2"
# The outputs, rendered from the records.
FB=$(curl -s -b $M $B/api/freight-segments/$FS/freight-bill)
chk "18. Freight Bill: customer, route, driver, truck, trailer, 6:30 AM → 3:00 PM, 85,591 → 85,808, 217, 8.50, five trips with their own yards and tickets, 94.64 + 12.50" "$(echo "$FB" | python3 -c "
import sys,re;h=sys.stdin.read()
print('Dave Christian Construction' in h, 'Vulcan Madera' in h, 'North Fork' in h, 'Cornelio' in h, 'Truck #3' in h, '>3B<' in h, '6:30 AM' in h, '3:00 PM' in h, '85,591' in h, '85,808' in h, '>217<' in h, '>8.50<' in h, h.count('<td>Vulcan Madera</td>'), h.count('<td>VBT Yard</td>'), all(t in h for t in ['37432733','37432799','37432862','37432920','VBT-3298']), '>107.14<' in h, h.count('<div class=\"draft\">'), 'FINAL' in h)")" "True True True True True True True True True True True True 4 1 True True 0 True"
chk "   Daily Log: 310 daily, 217 billable, 93 non-billable, the segment block" "$(curl -s -b $M $B/api/shifts/$SH/daily-log | python3 -c "
import sys;h=sys.stdin.read();print('>310<' in h, '>217<' in h, '>93<' in h, 'Dave Christian Construction' in h, 'Vulcan Madera → North Fork' in h, h.count('<div class=\"draft\">'))")" "True True True True True 0"
chk "   a driver cannot open another driver's Freight Bill" "$(curl -s -b $LG -o /dev/null -w '%{http_code}' $B/api/freight-segments/$FS/freight-bill)" "403"
chk "19. audit: opened, closed, edited freight; nothing on the loads changed meaning" "$(curl -s -b $M "$B/api/audit-log" | jq "sorted(set(e['action'] for e in d['entries'] if 'freight' in e['action']))")" "['closed-freight-segment', 'edited-freight-segment', 'opened-freight-segment']"

echo "── 39. Workday = open shift: active until 20 h, then stale → office close. Midnight, abandoned, boundary, API ──"
pkill -f "^node server.js" >/dev/null 2>&1; sleep 1
TODAY=$(TZ=America/Los_Angeles date +%F); YES=$(TZ=America/Los_Angeles date -d yesterday +%F); OLD=2026-09-15
python3 - "$TODAY" "$YES" "$OLD" <<'PY'
import json,sys,datetime
today,yes,old=sys.argv[1:4]
now=datetime.datetime.now(datetime.timezone.utc)
iso=lambda h: (now-datetime.timedelta(hours=h)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
sig="data:image/png;base64,iVBORw0KGgo="
insp=lambda at:{"items":[],"satisfactory":True,"defects":[],"remarks":"","signatureUrl":"","signature":sig,"at":at}
def shift(id,date,drv,name,truck,num,odo,hours):
    return {"id":id,"date":date,"driverId":drv,"driverName":name,"truckId":truck,"truckNum":num,"startTruckId":truck,"startTruckNum":num,"trailerId":None,"trailerNum":"",
            "startAt":iso(hours),"startOdometer":odo,"endAt":"","endOdometer":None,"status":"open","breaks":[],"events":[],"inspection":insp(iso(hours)),"notes":"","closedBy":"","closedAt":"","closeReason":""}
d={"pos":[
  {"id":"PO-N","poNumber":"NIGHT-1","customer":"Night Co","deliveryDate":yes,"address":"7 Night Rd","city":"Madera","status":"active","plannedVendorId":"vulcan"},
  {"id":"PO-D","poNumber":"DAY-22","customer":"Morning Co","deliveryDate":today,"address":"8 Day Rd","city":"Fresno","status":"active","plannedVendorId":"vbt"},
  {"id":"PO-S15A","poNumber":"S15-DONE","customer":"Old Co","deliveryDate":old,"address":"1 Old St","city":"Fresno","status":"completed","plannedVendorId":"vbt"},
  {"id":"PO-S15B","poNumber":"S15-OPEN","customer":"Old Co","deliveryDate":old,"address":"1 Old St","city":"Fresno","status":"active","plannedVendorId":"vbt"},
  {"id":"PO-A","poNumber":"ABAND-1","customer":"Left Co","deliveryDate":yes,"address":"2 Left St","city":"Clovis","status":"active","plannedVendorId":"vbt"},
  {"id":"PO-L","poNumber":"LEO-TODAY","customer":"Leo Co","deliveryDate":today,"address":"3 Leo St","city":"Clovis","status":"active","plannedVendorId":"vbt"}],
 "loads":[
  # Beryle: 11 PM start yesterday, freight open at Vulcan, load 1 delivered 12:05 AM, load 2 started 12:08 AM (age 70 min)
  {"id":"L-N","poId":"PO-N","truckId":"beryle","truckUnitId":"truck-2","material":"3/4 Rock","vendorId":"vulcan","loadsAssigned":3,"loadsDelivered":1,"deliveryDate":yes,"status":"active","approvalStatus":"pending","billStatus":"not-ready","freightSegmentId":"FS-N",
   "trips":[{"tripNum":1,"timestamps":{"start":"11:05 PM","arrivedPickup":"11:33 PM","loadedAt":"11:40 PM","arrivedJobsite":"11:58 PM","completed":"12:05 AM"},"isoStamps":{"start":iso(1.08),"arrivedPickup":iso(0.62),"completed":iso(0.08)},"gps":{},"actualYardId":"vulcan","actualYardName":"Vulcan","freightSegmentId":"FS-N",
             "ticket":{"source":"supplier","number":"N-1","netTons":24.1,"photoUrl":"","photo":sig,"ocr":None,"entry":"typed","confirmedBy":"beryle","confirmedAt":iso(0.5)}},
            {"tripNum":2,"timestamps":{"start":"12:08 AM"},"isoStamps":{"start":iso(0.03)},"gps":{}}]},
  {"id":"L-D","poId":"PO-D","truckId":"beryle","truckUnitId":"truck-2","material":"Dirt","vendorId":"vbt","loadsAssigned":1,"loadsDelivered":0,"deliveryDate":today,"status":"active","approvalStatus":"pending","billStatus":"not-ready","trips":[]},
  {"id":"L-S15A","poId":"PO-S15A","truckId":"beryle","truckUnitId":"truck-2","material":"Dirt","vendorId":"vbt","loadsAssigned":1,"loadsDelivered":1,"deliveryDate":old,"status":"completed","approvalStatus":"approved","billStatus":"ready","trips":[{"tripNum":1,"timestamps":{"start":"07:00 AM","completed":"08:10 AM"},"isoStamps":{},"gps":{}}]},
  {"id":"L-S15B","poId":"PO-S15B","truckId":"beryle","truckUnitId":"truck-2","material":"Dirt","vendorId":"vbt","loadsAssigned":2,"loadsDelivered":1,"deliveryDate":old,"status":"active","approvalStatus":"pending","billStatus":"not-ready","trips":[{"tripNum":1,"timestamps":{"start":"09:00 AM","completed":"10:10 AM"},"isoStamps":{},"gps":{}},{"tripNum":2,"timestamps":{"start":"10:30 AM"},"isoStamps":{},"gps":{}}]},
  # Carlos: abandoned yesterday 3 PM (age 20h 05m); a load mid-trip on it
  {"id":"L-A","poId":"PO-A","truckId":"carlos","truckUnitId":"truck-2b","material":"Dirt","vendorId":"vbt","loadsAssigned":2,"loadsDelivered":1,"deliveryDate":yes,"status":"active","approvalStatus":"pending","billStatus":"not-ready","freightSegmentId":"FS-A",
   "trips":[{"tripNum":1,"timestamps":{"start":"03:10 PM","arrivedPickup":"03:30 PM","loadedAt":"03:40 PM","arrivedJobsite":"04:10 PM","completed":"04:20 PM"},"isoStamps":{},"gps":{},"actualYardId":"cemex","actualYardName":"CEMEX","freightSegmentId":"FS-A"}]},
  {"id":"L-L","poId":"PO-L","truckId":"leonardo","truckUnitId":"truck-12","material":"Dirt","vendorId":"vbt","loadsAssigned":1,"loadsDelivered":0,"deliveryDate":today,"status":"active","approvalStatus":"pending","billStatus":"not-ready","trips":[]}],
 "shifts":[shift("SH-N",yes,"beryle","Beryle","truck-2","Truck #2",9000,1.17),
           shift("SH-A",yes,"carlos","Carlos","truck-2b","Truck #2B",5000,20.08),
           shift("SH-B1",yes,"rigo","Rigo","truck-14","Truck #14",7000,19.92),
           shift("SH-B2",yes,"leonardo","Leonardo","truck-12","Truck #12",8000,20.02)],
 "freightSegments":[
  {"id":"FS-N","shiftId":"SH-N","date":yes,"driverId":"beryle","driverName":"Beryle","truckId":"truck-2","truckNum":"Truck #2","trailerId":None,"trailerNum":"","customer":"Night Co","key":"night co#7 night rd|madera",
   "destination":{"poId":"PO-N","address":"7 Night Rd","city":"Madera","label":"7 Night Rd, Madera","geo":None},"originYardId":"vulcan","originName":"Vulcan","originYards":[{"id":"vulcan","name":"Vulcan"}],
   "timeStart":iso(0.62),"odStart":9030,"timeEnd":"","odEnd":None,"loadIds":["L-N"],"status":"open","openedBy":"beryle","closedBy":"","closedAt":"","closeReason":"","edits":[],"truckMismatch":None},
  {"id":"FS-A","shiftId":"SH-A","date":yes,"driverId":"carlos","driverName":"Carlos","truckId":"truck-2b","truckNum":"Truck #2B","trailerId":None,"trailerNum":"","customer":"Left Co","key":"left co#2 left st|clovis",
   "destination":{"poId":"PO-A","address":"2 Left St","city":"Clovis","label":"2 Left St, Clovis","geo":None},"originYardId":"cemex","originName":"CEMEX","originYards":[{"id":"cemex","name":"CEMEX"}],
   "timeStart":iso(19.7),"odStart":5020,"timeEnd":"","odEnd":None,"loadIds":["L-A"],"status":"open","openedBy":"carlos","closedBy":"","closedAt":"","closeReason":"","edits":[],"truckMismatch":None}],
 "unitConfig":{"byUnit":{"ton":25,"load":1},"byMaterial":{}}}
json.dump(d,open('data.json','w'))
PY
(VBT_TEST_HOOKS=1 node server.js > /tmp/vbt-test-shiftday.log 2>&1 &)
for i in $(seq 1 20); do sleep 1; curl -sf $B/healthz >/dev/null 2>&1 && break; done
curl -s -c $M -X POST -d "username=joshua&password=joshua123" $B/login -o /dev/null
BD=$(mktemp); curl -s -c $BD -X POST -d "username=beryle&password=beryle123" $B/login -o /dev/null
CA=$(mktemp); curl -s -c $CA -X POST -d "username=carlos&password=carlos123" $B/login -o /dev/null
RG=$(mktemp); curl -s -c $RG -X POST -d "username=rigo&password=rigo123" $B/login -o /dev/null
LG=$(mktemp); curl -s -c $LG -X POST -d "username=leonardo&password=leo123" $B/login -o /dev/null
J='Content-Type: application/json'
jq() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
bt() { curl -s -b $BD -H "$J" -X POST $B/api/loads/$1/trip-action -d "$2" "${@:3}"; }
# ── Midnight: Beryle started at 11 PM yesterday, it is 12:10 AM ──
chk "1. 11 PM start is still the driver's active day after midnight (not stale, ~1.2 h old, no duplicate)" "$(curl -s -b $BD $B/api/shifts/current | jq "d['shift']['id'], d['shift']['date']==sys.argv[0] or d['shift']['date'], d['shift']['stale'], 1.0 < d['shift']['ageHours'] < 1.5, d['shift']['staleAfterHours'], d['staleShift'], d['shift']['openSegment']['customer']")" "SH-N $YES False True 20 None Night Co"
chk "   the night load (dated yesterday) is on the phone with today's load; Sept 15 leftovers are not" "$(curl -s -b $BD $B/api/my-dispatch | jq "sorted(l['poNumber'] for l in d['loads']), [x['poNumber'] for x in d['earlierOpen']]")" "['DAY-22', 'NIGHT-1'] ['S15-OPEN']"
chk "   Start day is refused as 'already open', not as stale"  "$(curl -s -b $BD -H "$J" -X POST $B/api/shifts/start -d '{"truckId":"truck-4","odometer":1,"inspection":{"satisfactory":true},"signature":"'"$PNG"'"}' | jq "d['code']")" "shift_open"
chk "2. load 2 arrives at Vulcan after midnight: joins the SAME freight, no odometer asked" "$(bt L-N '{"action":"arrived-pickup","yardId":"vulcan"}' | jq "d.get('success'), d.get('code'), d['load']['trips'][1]['freightSegmentId'], d['load']['trips'][1]['timestamps']['arrivedPickup'] is not None")" "True None FS-N True"
bt L-N '{"action":"loaded","ticket":{"source":"supplier","number":"N-2","netTons":23.7,"photo":"'"$PNG"'"}}' -o /dev/null; bt L-N '{"action":"arrived-jobsite"}' -o /dev/null; bt L-N '{"action":"trip-complete"}' -o /dev/null
chk "   freight still open on SH-N with 2 trips, no second shift or segment anywhere" "$(curl -s -b $M "$B/api/freight-segments?all=1" | jq "[(s['id'], s['shiftId'], s['status'], s['tripCount']) for s in d['segments'] if s['driverId']=='beryle']")|$(curl -s -b $M "$B/api/shifts?all=1" | jq "[s['id'] for s in d['shifts'] if s['driverId']=='beryle']")" "[('FS-N', 'SH-N', 'open', 2)]|['SH-N']"
chk "   today's other-customer load is refused while the night freight is open (existing rule, no mixing)" "$(bt L-D '{"action":"start-trip"}' -o /dev/null; bt L-D '{"action":"arrived-pickup"}' | jq "d['code'], d['segment']['id']")" "segment_open FS-N"
chk "3. Finish freight works after midnight: 9,060 → 30 billable miles" "$(curl -s -b $BD -H "$J" -X POST $B/api/freight-segments/FS-N/close -d '{"odometer":9060}' | jq "d['segment']['status'], d['segment']['billableMiles'], d['segment']['closedBy']")" "closed 30 beryle"
chk "   then today's VBT load runs on the same day with no freight (our own yard)" "$(bt L-D '{"action":"arrived-pickup"}' | jq "d.get('success'), d['load']['trips'][0]['actualYardName'], d['load'].get('freightSegmentId')")|$(curl -s -b $M "$B/api/freight-segments?all=1" | jq "len([s for s in d['segments'] if s['driverId']=='beryle'])")" "True VBT Yard None|1"
chk "4. End day works: 9,070 → 70 daily, 30 freight, 40 non-billable; the day keeps its start date" "$(curl -s -b $BD -H "$J" -X POST $B/api/shifts/SH-N/end -d '{"odometer":9070}' | jq "d['shift']['status'], d['shift']['date']==sys.argv[0] or d['shift']['date'], d['shift']['dailyMiles'], d['shift']['billableMiles'], d['shift']['nonBillableMiles']")" "closed $YES 70 30 40"
chk "   Daily Log and Freight Bill carry the shift's start date and both trips" "$(curl -s -b $M $B/api/shifts/SH-N/daily-log | python3 -c "import sys,re;h=sys.stdin.read();print(re.search(r'<title>(.*?)</title>',h).group(1))")|$(curl -s -b $M $B/api/freight-segments/FS-N/freight-bill | python3 -c "import sys,re;h=sys.stdin.read();print(re.search(r'<title>(.*?)</title>',h).group(1), h.count('<tr><td>'))")" "Daily Log $YES Beryle|Freight Bill $YES Night Co 2"
chk "   after ending, a new day can start (no stale left)"    "$(curl -s -b $BD $B/api/shifts/current | jq "d['shift'], d['staleShift'], d['lastShift']['id']")" "None None SH-N"
# ── Boundary: 19 h 55 m is active, 20 h 01 m is stale ──
chk "5. boundary: Rigo's day at 19.9 h is still active"        "$(curl -s -b $RG $B/api/shifts/current | jq "d['shift'] and d['shift']['id'], d['staleShift'], d['shift'] and d['shift']['stale']")" "SH-B1 None False"
chk "   boundary: Leonardo's day at 20.0 h is stale"           "$(curl -s -b $LG $B/api/shifts/current | jq "d['shift'], d['staleShift']['id'], d['staleShift']['stale'], d['staleShift']['ageHours'] >= 20")" "None SH-B2 True True"
chk "   Leonardo cannot run today's load either while his stale day is open" "$(curl -s -b $LG -H "$J" -X POST $B/api/loads/L-L/trip-action -d '{"action":"start-trip"}' | jq "d['code']")" "stale_shift_open"
# ── Abandoned: Carlos started 3 PM yesterday, never ended, 20 h 05 m ago, freight still open ──
chk "6. abandoned day is stale on the phone, with the hours open"  "$(curl -s -b $CA $B/api/shifts/current | jq "d['shift'], d['staleShift']['id'], d['staleShift']['openSegment']['customer']")" "None SH-A Left Co"
chk "   API: Start day / End day / Break / Truck change / Finish freight / trip action all refused (stale_shift_open)" "$(for c in "POST $B/api/shifts/start {\"truckId\":\"truck-4\",\"odometer\":1,\"inspection\":{\"satisfactory\":true},\"signature\":\"$PNG\"}" "POST $B/api/shifts/SH-A/end {\"odometer\":5090}" "POST $B/api/shifts/SH-A/break {\"action\":\"start\"}" "POST $B/api/shifts/SH-A/truck-change {\"fromOdometer\":5090,\"toTruckId\":\"truck-4\",\"toOdometer\":1}" "POST $B/api/freight-segments/FS-A/close {\"odometer\":5090}" "POST $B/api/loads/L-A/trip-action {\"action\":\"start-trip\"}"; do set -- $c; curl -s -b $CA -H "$J" -X $1 $2 -d "$3" | jq "d.get('code')"; done | sort -u | tr '\n' ' ')" "stale_shift_open "
chk "   ...and nothing changed: freight still open, load untouched" "$(curl -s -b $M $B/api/freight-segments/FS-A | jq "d['segment']['status'], d['segment']['odEnd'], d['segment']['tripCount']")|$(curl -s -b $M $B/api/data | jq "[(l['loadsDelivered'], len(l['trips'])) for l in d['loads'] if l['id']=='L-A'][0]")" "open None 1|(1, 1)"
chk "   office sees it as stale with the age"                 "$(curl -s -b $M $B/api/today | jq "[(s['id'], s['stale'], s['ageHours'] >= 20, s['openSegment']['customer']) for s in d['shifts'] if s['id']=='SH-A'][0]")" "('SH-A', True, True, 'Left Co')"
chk "7. office closes it with a reason: freight closed at the day's end reading, history intact" "$(curl -s -b $M -H "$J" -X POST $B/api/shifts/SH-A/close -d '{"odometer":5090,"reason":"abandoned overnight"}' | jq "d['shift']['status'], d['shift']['dailyMiles'], d['shift']['billableMiles'], d['shift']['segments'][0]['status'], d['shift']['segments'][0]['closeReason']")|$(curl -s -b $M -o /dev/null -w '%{http_code}' $B/api/shifts/SH-A/daily-log)|$(curl -s -b $M -o /dev/null -w '%{http_code}' $B/api/freight-segments/FS-A/freight-bill)" "closed 90 70 closed end-of-day-manager|200|200"
chk "   Carlos can now start a new day"                       "$(curl -s -b $CA -H "$J" -X POST $B/api/shifts/start -d '{"truckId":"truck-2b","odometer":5090,"inspection":{"satisfactory":true},"signature":"'"$PNG"'"}' | jq "d.get('success'), d['shift']['date']==sys.argv[0] or d['shift']['date'], d['shift']['id']!='SH-A'")" "True $TODAY True"
chk "   Sept 15 history untouched throughout"                 "$(curl -s -b $M $B/api/data | jq "sorted((l['id'], l['approvalStatus'], len(l['trips'])) for l in d['loads'] if l['deliveryDate']=='2026-09-15')")" "[('L-S15A', 'approved', 1), ('L-S15B', 'pending', 2)]"

echo
echo "── 40. Phase 0 integrity: billing, attribution, deletion, archive, QuickBooks, vendor bills ──"
# A fresh process and an empty store, so every fixture below is fully known.
pkill -f "^node server.js" >/dev/null 2>&1; sleep 1; rm -f data.json data-ids.json telemetry.json
(VBT_TEST_HOOKS=1 node server.js > /tmp/vbt-test-p0.log 2>&1 &)
for i in $(seq 1 20); do sleep 1; curl -sf $B/healthz >/dev/null 2>&1 && break; done
J='Content-Type: application/json'; TODAY=$(date +%F)
jq() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
curl -s -c $M -X POST -d "username=joshua&password=joshua123" $B/login -o /dev/null
BE=$(mktemp); curl -s -c $BE -X POST -d "username=beryle&password=beryle123" $B/login -o /dev/null
RG=$(mktemp); curl -s -c $RG -X POST -d "username=rigo&password=rigo123" $B/login -o /dev/null
CA=$(mktemp); curl -s -c $CA -X POST -d "username=carlos&password=carlos123" $B/login -o /dev/null
mg()  { curl -s -b $M  -H "$J" -X "$1" "$B$2" -d "${3:-"{}"}" "${@:4}"; }             # manager, body, extra curl args
mgc() { curl -s -b $M  -H "$J" -X "$1" "$B$2" -d "${3:-"{}"}" -o /dev/null -w '%{http_code}'; }
dr()  { curl -s -b "$1" -H "$J" -X POST $B/api/loads/$2/trip-action -d "$3"; }        # driver trip action
data() { curl -s -b $M $B/api/data | jq "$1"; }
load() { curl -s -b $M $B/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);l=[x for x in d['loads'] if x['id']=='$1'][0];print($2)"; }
newpo() { mg POST /api/pos "$1" | jq "d.get('po',{}).get('id','') + ' ' + str(d.get('status') or '')"; }
loadof() { curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$1'][${2:-0}]"; }
mg POST /api/_test/qb-fake '{"mode":"ok"}' -o /dev/null

# ── C3. A PO is on record only once it is saved ──
mg POST /api/_test/save-mode '{"mode":"fail"}' >/dev/null
chk "C3 create PO answers 503 when the database write fails (never success)" "$(mgc POST /api/pos '{"po":{"poNumber":"P0-LOST","customer":"Lost Co","deliveryDate":"'"$TODAY"'"},"splits":[{"truckId":"beryle","truckUnitId":"truck-2","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}')" "503"
chk "   ...and the PO is not in memory either (rolled back)" "$(data "len([p for p in d['pos'] if p['poNumber']=='P0-LOST']), len([c for c in d['customers'] if c['name']=='Lost Co'])")" "0 0"
mg POST /api/_test/save-mode '{"mode":"ok"}' >/dev/null
chk "   ...same request succeeds once the database is back" "$(mgc POST /api/pos '{"po":{"poNumber":"P0-LOST","customer":"Lost Co","deliveryDate":"'"$TODAY"'"},"splits":[{"truckId":"beryle","truckUnitId":"truck-2","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}')" "200"
LP=$(data "[p['id'] for p in d['pos'] if p['poNumber']=='P0-LOST'][0]"); mgc DELETE /api/pos/$LP >/dev/null

# ── Fixture: Beryle on Truck #2, planned Vulcan, 2 loads of 3/4 Rock ──
P1=$(newpo '{"po":{"poNumber":"P0-1","customer":"Phase Zero Co","deliveryDate":"'"$TODAY"'","address":"1 Test Rd","city":"Fresno","plannedVendorId":"vulcan"},"splits":[{"truckId":"beryle","truckUnitId":"truck-2","material":"3/4 Rock","loadsAssigned":2,"vendorId":"vulcan"}]}'); P1=${P1%% *}
L1=$(loadof $P1)

# ── C4. Drivers record progress only through the trip steps ──
chk "C4 driver cannot write loadsDelivered directly (400)" "$(curl -s -b $BE -H "$J" -X PUT $B/api/loads/$L1 -d '{"loadsDelivered":2}' -o /dev/null -w '%{http_code}')" "400"
chk "   ...nor timestamps / gps"                          "$(curl -s -b $BE -H "$J" -X PUT $B/api/loads/$L1 -d '{"timestamps":{"completed":"07:00"},"gps":{"start":{"lat":1,"lng":1}}}' | jq "d['protectedFields']")" "['timestamps', 'gps']"
chk "   ...the load is untouched"                         "$(load $L1 "l['loadsDelivered'], l['timestamps']")" "0 {}"
chk "   the signature still goes through (200)"          "$(curl -s -b $BE -H "$J" -X PUT $B/api/loads/$L1 -d "{\"pod\":{\"signedBy\":\"Foreman\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null -w '%{http_code}')" "200"

# ── C12 + C7. Double taps do not move evidence; each trip is stamped with who ran it ──
chk "C12 start-trip → 200"                                   "$(dr $BE $L1 '{"action":"start-trip","gps":{"lat":36.7,"lng":-119.7}}' | jq "d['success']")" "True"
chk "   a second tap on Start is refused, the first stamp stays" "$(dr $BE $L1 '{"action":"start-trip"}' | jq "d['error']")" "Trip 1 is already started"
chk "C7 the trip records the driver and the truck that ran it" "$(load $L1 "l['trips'][0]['driverId'], l['trips'][0]['truckUnitId'], l['trips'][0]['truckNum']")" "beryle truck-2 Truck #2"
dr $BE $L1 '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null
dr $BE $L1 "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null
chk "   arrived-jobsite → 200"                               "$(dr $BE $L1 '{"action":"arrived-jobsite"}' | jq "d['success']")" "True"
chk "   a second tap on Arrived at Job Site is refused"      "$(dr $BE $L1 '{"action":"arrived-jobsite"}' | jq "d['error']")" "Already marked arrived at the job site"
dr $BE $L1 '{"action":"trip-complete"}' >/dev/null
chk "C5 the trip carries the vendor rate fixed at the scale (Vulcan 3/4 Rock \$38)" "$(load $L1 "l['trips'][0]['actualYardId'], l['trips'][0]['vendorRate'], l['trips'][0]['vendorRateIsDefault']")" "vulcan 38 False"

# ── C7. Assignment conflicts: told, not blocked; overrides audited ──
dr $BE $L1 '{"action":"start-trip"}' >/dev/null                                  # Beryle is now mid-haul on trip 2
P2=$(newpo '{"po":{"poNumber":"P0-2","customer":"Phase Zero Co","deliveryDate":"'"$TODAY"'","address":"1 Test Rd","city":"Fresno","plannedVendorId":"vbt"},"splits":[{"truckId":"rigo","truckUnitId":"truck-4","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}'); P2=${P2%% *}
L2=$(loadof $P2)
R=$(mg POST /api/loads/$L2/assign '{"driverId":"beryle"}')
chk "C7 moving a load onto a driver who is mid-haul → 409 with the conflict named" "$(echo "$R" | jq "d['code'], d['conflicts'][0]['type'], d['conflicts'][0]['message']")" "assignment_conflict driver-busy Beryle is already mid-haul on $L1 (PO P0-1, Phase Zero Co)."
chk "   ...nothing changed"                                                   "$(load $L2 "l['truckId'], l['truckUnitId']")" "rigo truck-4"
chk "   putting Truck #2 (on Beryle's open load) under Rigo → 409 truck-busy" "$(mg POST /api/loads/$L2/assign '{"truckUnitId":"truck-2"}' | jq "d['conflicts'][0]['type'], d['conflicts'][0]['message']")" "truck-busy Truck #2 is on Beryle's load $L1 (PO P0-1, Phase Zero Co) the same day."
chk "   the dispatcher's go-ahead (force) is accepted and recorded"           "$(mg POST /api/loads/$L2/assign '{"driverId":"beryle","force":true,"reason":"Rigo is out sick"}' | jq "d['success'], d['load']['truckId'], d['conflictsOverridden']")" "True beryle ['driver-busy']"
chk "   ...in the audit log, with the reason"                                 "$(curl -s -b $M "$B/api/audit-log?limit=5" | python3 -c "import json,sys;d=json.load(sys.stdin);e=[x for x in d['entries'] if x['action']=='quick-assigned-load' and x['target']=='$L2' and 'conflictsOverridden' in x['details']][0];print(e['details']['conflictsOverridden'])")" "{'types': ['driver-busy'], 'reason': 'Rigo is out sick'}"
mg POST /api/loads/$L2/assign '{"driverId":"rigo"}' >/dev/null                  # back to Rigo (idle → no conflict)
chk "   a load mid-haul cannot be moved to another driver silently → 409 load-in-progress" "$(mg POST /api/loads/$L1/assign '{"driverId":"carlos"}' | jq "d['conflicts'][0]['type']")" "load-in-progress"
chk "   with force the handover is written down, trip 1 stays on Beryle's record" "$(mg POST /api/loads/$L1/assign '{"driverId":"carlos","force":true,"reason":"Beryle called off at the yard"}' -o /dev/null; load $L1 "l['truckId'], l['trips'][0]['driverId'], l['reassignHistory'][0]['from'], l['reassignHistory'][0]['to'], l['reassignHistory'][0]['atTrip'], l['reassignHistory'][0]['tripsDone'], l['reassignHistory'][0]['reason']")" "carlos beryle beryle carlos 2 1 Beryle called off at the yard"
chk "   PO form: a truck already on another driver's open load today → 409" "$(mgc POST /api/pos '{"po":{"poNumber":"P0-X","customer":"Phase Zero Co","deliveryDate":"'"$TODAY"'"},"splits":[{"truckId":"leonardo","truckUnitId":"truck-4","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}')" "409"
chk "   PO form: the same truck under two drivers in one PO → 409"           "$(mgc POST /api/pos '{"po":{"poNumber":"P0-X","customer":"Phase Zero Co","deliveryDate":"'"$TODAY"'"},"splits":[{"truckId":"leonardo","truckUnitId":"truck-12","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"},{"truckId":"matthew","truckUnitId":"truck-12","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}')" "409"
chk "   PO form: queuing the next job for a driver who is out hauling is normal (200)" "$(mgc POST /api/pos '{"po":{"poNumber":"P0-Q","customer":"Phase Zero Co","deliveryDate":"'"$TODAY"'"},"splits":[{"truckId":"carlos","truckUnitId":"truck-2b","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}')" "200"
PQ=$(data "[p['id'] for p in d['pos'] if p['poNumber']=='P0-Q'][0]")
mg PUT /api/drivers/leonardo '{"status":"off"}' >/dev/null
chk "   PO form refuses an off-duty driver like Quick Assign does (400)"      "$(mgc POST /api/pos '{"po":{"poNumber":"P0-X","customer":"Phase Zero Co","deliveryDate":"'"$TODAY"'"},"splits":[{"truckId":"leonardo","truckUnitId":"truck-12","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}')" "400"
mg PUT /api/drivers/leonardo '{"status":"available"}' >/dev/null
chk "   the Board card and the load detail both open the same Driver → Truck → Yard sheet" "$(grep -c "qaOpenFor('\${l.id}')" public/index.html)|$(sed -n '/^function loadCard/,/^}/p' public/index.html | grep -c "openReassignModal('single'")" "2|0"
chk "   every assignment path goes through one conflict-aware call (sheet, PO form, reassign modal, date move)" "$(grep -c 'postAssignment(' public/index.html)|$(grep -c "openReassignModal('single'" public/index.html)" "7|0"

# ── C8. Field evidence is never deleted ──
chk "C8 a load with a delivered trip cannot be deleted (403)"                "$(mgc DELETE /api/loads/$L1)" "403"
chk "   ...nor its PO"                                                      "$(mg DELETE /api/pos/$P1 | jq "d['blockingLoadIds']")" "['$L1']"
LQ=$(loadof $PQ); dr $CA $LQ '{"action":"start-trip"}' >/dev/null
chk "   a trip started by mistake with nothing recorded may still be deleted (200)" "$(mgc DELETE /api/pos/$PQ)" "200"
# Rigo runs L2 at our yard and submits it
for A in start-trip arrived-pickup arrived-jobsite trip-complete; do dr $RG $L2 "{\"action\":\"$A\",\"yardId\":\"vbt\"}" >/dev/null; [ $A = arrived-pickup ] && dr $RG $L2 '{"action":"loaded","ticket":{"source":"vbt","number":"VBT-P0-1"}}' >/dev/null; done
curl -s -b $RG -H "$J" -X PUT $B/api/loads/$L2 -d "{\"ticketImage\":\"$PNG\",\"pod\":{\"signedBy\":\"x\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null
dr $RG $L2 '{"action":"delivered"}' >/dev/null
chk "   submitted work (awaiting approval) cannot be deleted (403)"          "$(mgc DELETE /api/loads/$L2)|$(mgc DELETE /api/pos/$P2)" "403|403"

# ── C1. Void / unvoid never turn a billed load back into billable work ──
mg POST /api/loads/$L2/approve >/dev/null
chk "C1 approved load is Ready to Bill"                                      "$(load $L2 "l['billStatus']")" "ready"
chk "   marked billed by hand"                                               "$(mg POST /api/loads/bill "{\"loadIds\":[\"$L2\"]}" | jq "d['billed']")|$(load $L2 "l['billStatus']")" "1|billed"
chk "   voided: out of every count, previous billing state remembered"       "$(mg POST /api/loads/$L2/void '{"reason":"wrong quantity"}' -o /dev/null; load $L2 "l['voided'], l['billStatus'], l['billStatusBeforeVoid']")" "True voided billed"
chk "   unvoided: back to BILLED, not to Ready to Bill"                      "$(mg POST /api/loads/$L2/unvoid >/dev/null; load $L2 "l['voided'], l['billStatus'], 'billStatusBeforeVoid' in l")" "False billed False"
chk "   ...not listed in Ready to Bill, cannot join a batch (no second invoice)" "$(curl -s -b $M $B/api/ready-to-bill | jq "len([x for x in d['items'] if x['id']=='$L2'])")|$(mgc POST /api/billing-batches "{\"loadIds\":[\"$L2\"]}")" "0|400"
# Carlos finishes L1 (trip 2 at CEMEX, where 3/4 Rock has no price → default rate), submits; approve.
dr $CA $L1 '{"action":"arrived-pickup","yardId":"cemex"}' >/dev/null
dr $CA $L1 "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null
dr $CA $L1 '{"action":"arrived-jobsite"}' >/dev/null; dr $CA $L1 '{"action":"trip-complete"}' >/dev/null
dr $CA $L1 '{"action":"delivered"}' >/dev/null
mg POST /api/loads/$L1/approve >/dev/null
chk "   an approved, unbilled load voided and restored returns to Ready to Bill" "$(mg POST /api/loads/$L1/void '{"reason":"check"}' -o /dev/null; mg POST /api/loads/$L1/unvoid >/dev/null; load $L1 "l['approvalStatus'], l['billStatus']")" "approved ready"

# ── C5. Vendor cost follows the yard the driver actually used, trip by trip ──
chk "C5 planned Vulcan, trip 1 at Vulcan (\$38), trip 2 at CEMEX (no price on file → \$22 default): two cost lines, CEMEX not billable" "$(mg POST /api/vendor-bills/preview "{\"loadIds\":[\"$L1\"]}" | jq "sorted((g['vendorName'], g['totalAmount'], g['lineItems'][0]['loads'], g['lineItems'][0]['isDefault'], g['unconfigured']) for g in d['groups'])")" "[('CEMEX', 550, 1, True, True), ('Vulcan', 950, 1, False, False)]"
chk "   a default rate is an estimate, not a price: named as such, refused as a bill" "$(mg POST /api/vendor-bills/preview "{\"loadIds\":[\"$L1\"]}" | jq "[g['lineItems'][0]['description'] for g in d['groups'] if g['vendorName']=='CEMEX'][0]")|$(mgc POST /api/vendor-bills "{\"loadIds\":[\"$L1\"]}")" "3/4 Rock — 1 load (25.00 ton @ \$22/ton) [default rate — no CEMEX price on file for 3/4 Rock] [NOT PRICEABLE]|400"
chk "   Material Costs shows the estimate meanwhile, per yard"               "$(curl -s -b $M $B/api/material-costs | jq "d['vendors']['vulcan']['totalLoads'], int(d['vendors']['vulcan']['totalCost']), d['vendors']['cemex']['totalLoads'], int(d['vendors']['cemex']['totalCost'])")" "1 950 1 550"
chk "   Profitability splits the same load the same way (Vulcan 1 / CEMEX 1)" "$(curl -s -b $M $B/api/profitability | jq "(lambda v: (v['vulcan']['loads'], int(v['vulcan']['cost']), v['cemex']['loads'], int(v['cemex']['cost'])))({x['key']: x for x in d['byVendor']})")" "(1, 950, 1, 550)"
mg POST /api/vendors/cemex/prices '{"material":"3/4 Rock","unit":"ton","price":20}' >/dev/null
chk "   once CEMEX's price is on file the trip is costed at it (\$20 × 25) and billable" "$(mg POST /api/vendor-bills/preview "{\"loadIds\":[\"$L1\"]}" | jq "[(g['vendorName'], g['totalAmount'], g['unconfigured']) for g in d['groups'] if g['vendorName']=='CEMEX']")" "[('CEMEX', 500, False)]"
VB=$(mg POST /api/vendor-bills "{\"loadIds\":[\"$L1\"]}"); VBV=$(echo "$VB" | jq "[b['id'] for b in d['bills'] if b['vendorId']=='vulcan'][0]"); VBC=$(echo "$VB" | jq "[b['id'] for b in d['bills'] if b['vendorId']=='cemex'][0]")
chk "   two bills created; each trip claimed by its own vendor's bill"       "$(echo "$VB" | jq "len(d['bills'])")|$(load $L1 "l['trips'][0]['vendorBillId']=='$VBV', l['trips'][1]['vendorBillId']=='$VBC'")" "2|True True"
chk "   the same hauls cannot be billed to a vendor twice"                   "$(mgc POST /api/vendor-bills/preview "{\"loadIds\":[\"$L1\"]}")" "400"
chk "   voiding the CEMEX bill releases only its trip"                       "$(mg POST /api/vendor-bills/$VBC/void '{"reason":"wrong yard"}' | jq "d['success']")|$(mg POST /api/vendor-bills/preview "{\"loadIds\":[\"$L1\"]}" | jq "[(g['vendorName'], g['lineItems'][0]['loads']) for g in d['groups']]")" "True|[('CEMEX', 1)]"
# An external yard with NO price is not priceable — never a $0 bill; adding the price afterwards fixes it.
KP=$(mg POST /api/vendors/keith/prices '{"material":"Dirt","unit":"ton","price":0}' | jq "d['price']['id']")
P5=$(newpo '{"po":{"poNumber":"P0-5","customer":"Phase Zero Co","deliveryDate":"'"$TODAY"'","plannedVendorId":"vbt"},"splits":[{"truckId":"rigo","truckUnitId":"truck-4","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}'); P5=${P5%% *}; L5=$(loadof $P5)
dr $RG $L5 '{"action":"start-trip"}' >/dev/null; dr $RG $L5 '{"action":"arrived-pickup","yardId":"keith"}' >/dev/null
dr $RG $L5 "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null; dr $RG $L5 '{"action":"arrived-jobsite"}' >/dev/null; dr $RG $L5 '{"action":"trip-complete"}' >/dev/null
curl -s -b $RG -H "$J" -X PUT $B/api/loads/$L5 -d "{\"pod\":{\"signedBy\":\"x\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null
dr $RG $L5 '{"action":"delivered"}' >/dev/null; mg POST /api/loads/$L5/approve >/dev/null
chk "   planned VBT (\$0) but loaded at Keith Farms with no Dirt price → NOT priceable, no \$0 bill" "$(mg POST /api/vendor-bills/preview "{\"loadIds\":[\"$L5\"]}" | jq "d['groups'][0]['unconfigured'], d['groups'][0]['unconfiguredReasons']")|$(mgc POST /api/vendor-bills "{\"loadIds\":[\"$L5\"]}")" "True ['no price on file for Dirt at Keith Farms']|400"
chk "   Profitability flags the same load instead of counting \$0"          "$(curl -s -b $M $B/api/profitability | jq "d['grand']['costIncomplete']")" "True"
mg PUT /api/vendors/keith/prices/$KP '{"price":15}' >/dev/null
chk "   once Keith's Dirt price is on file the haul is costed at it (\$15 x 25)" "$(mg POST /api/vendor-bills/preview "{\"loadIds\":[\"$L5\"]}" | jq "d['groups'][0]['unconfigured'], d['groups'][0]['vendorName'], d['groups'][0]['totalAmount']")" "False Keith Farms 375"
# Vendor bill send: guards and lost-response recovery
chk "   send the Vulcan bill → sent; sending it again is refused; retry on a sent bill is refused" "$(mg POST /api/vendor-bills/$VBV/send | jq "d['bill']['syncStatus'], d['bill']['qbBillId']")|$(mgc POST /api/vendor-bills/$VBV/send)|$(mgc POST /api/vendor-bills/$VBV/retry)" "sent BILL-1|400|400"
VB2=$(mg POST /api/vendor-bills "{\"loadIds\":[\"$L5\"]}" | jq "d['bills'][0]['id']")
mg POST /api/_test/qb-fake '{"billMode":"lost"}' >/dev/null
chk "   QuickBooks creates the bill but the answer is lost → external result UNKNOWN (502), flagged 'may exist'" "$(mgc POST /api/vendor-bills/$VB2/send)|$(curl -s -b $M $B/api/vendor-bills | jq "[(b['syncStatus'], b['mayExistInQuickBooks']) for b in d['items'] if b['id']=='$VB2'][0]")|$(curl -s -b $M $B/api/_test/qb-fake | jq "d['billsCreated']")" "502|('unknown', True)|2"
mg POST /api/_test/qb-fake '{"billMode":"ok"}' >/dev/null
chk "   Retry finds it in QuickBooks and adopts it — no second bill"        "$(mg POST /api/vendor-bills/$VB2/retry | jq "d['recovered'], d['bill']['syncStatus'], d['bill']['qbBillId']")|$(curl -s -b $M $B/api/_test/qb-fake | jq "d['billsCreated']")" "True sent BILL-2|2"
chk "   voiding a sent bill removes it in QuickBooks first, then releases the trip" "$(mg POST /api/vendor-bills/$VB2/void '{"reason":"wrong price"}' | jq "d['success'], d['qbDeleted']")|$(curl -s -b $M $B/api/_test/qb-fake | jq "d['billsDeleted']")|$(load $L5 "l['trips'][0].get('vendorBillId',''), l['qbBillId']")" "True True|1| "

# ── C6. Invoices: QuickBooks answers, times out, or accepts and loses the answer ──
B1=$(mg POST /api/billing-batches "{\"loadIds\":[\"$L1\"]}" | jq "d['batches'][0]['id']")
mg POST /api/_test/qb-fake '{"mode":"lost"}' >/dev/null
chk "C6 VBT loses QuickBooks' answer after the invoice was created → external result UNKNOWN (502) + 'may exist', load not billed yet" "$(mgc POST /api/billing-batches/$B1/send)|$(curl -s -b $M $B/api/billing-batches/$B1 | jq "d['batch']['syncStatus'], d['batch']['mayExistInQuickBooks'], d['batch']['qbInvoiceId']")|$(load $L1 "l['billStatus']")|$(curl -s -b $M $B/api/_test/qb-fake | jq "d['invoicesCreated']")" "502|unknown True |ready|1"
chk "   send on that batch is refused: external result unknown, reconcile first (409)" "$(mgc POST /api/billing-batches/$B1/send)" "409"
mg POST /api/_test/qb-fake '{"mode":"ok","connected":false}' >/dev/null
chk "   Retry with QuickBooks disconnected refuses (cannot check, 409) — nothing sent, still unknown" "$(mgc POST /api/billing-batches/$B1/retry)|$(curl -s -b $M $B/api/_test/qb-fake | jq "d['invoicesCreated']")|$(curl -s -b $M $B/api/billing-batches/$B1 | jq "d['batch']['syncStatus']")" "409|1|unknown"
mg POST /api/_test/qb-fake '{"mode":"ok"}' >/dev/null
chk "   Retry finds the invoice in QuickBooks and adopts it: batch sent, load billed, still ONE invoice" "$(mg POST /api/billing-batches/$B1/retry | jq "d['recovered'], d['batch']['syncStatus'], d['batch']['qbInvoiceId']")|$(load $L1 "l['billStatus'], l['qbInvoiceId']")|$(curl -s -b $M $B/api/_test/qb-fake | jq "d['invoicesCreated']")" "True sent_to_quickbooks INV-1|billed INV-1|1"
chk "   ...recorded in the sync log"                                        "$(curl -s -b $M "$B/api/qb-sync-log?batchId=$B1" | jq "sorted(set(e['actionType'] for e in d['items']))")" "['create_invoice', 'find_customer', 'recover_invoice']"
mg POST /api/billing-batches/$B1/void '{"reason":"test the timeout path next"}' >/dev/null
B2=$(mg POST /api/billing-batches "{\"loadIds\":[\"$L1\"]}" | jq "d['batches'][0]['id']")
mg POST /api/_test/qb-fake '{"mode":"timeout"}' >/dev/null
chk "   QuickBooks times out before anything is created → external result UNKNOWN too (VBT cannot tell the two apart)" "$(mgc POST /api/billing-batches/$B2/send)|$(curl -s -b $M $B/api/billing-batches/$B2 | jq "d['batch']['syncStatus'], d['batch']['mayExistInQuickBooks']")" "502|unknown True"
mg POST /api/_test/qb-fake '{"mode":"ok"}' >/dev/null
chk "   Retry finds nothing, resets the batch; send creates the one invoice" "$(mg POST /api/billing-batches/$B2/retry | jq "d.get('recovered'), d['batch']['syncStatus']")|$(mg POST /api/billing-batches/$B2/send | jq "d['batch']['qbInvoiceId']")|$(curl -s -b $M $B/api/_test/qb-fake | jq "d['invoicesCreated']")" "None ready_to_bill|INV-2|2"
mg POST /api/billing-batches/$B2/void '{"reason":"refresh test"}' >/dev/null
B3=$(mg POST /api/billing-batches "{\"loadIds\":[\"$L1\"]}" | jq "d['batches'][0]['id']")
mg POST /api/_test/qb-fake '{"mode":"slow","delayMs":1500}' >/dev/null
curl -s -b $M -H "$J" -X POST $B/api/billing-batches/$B3/send -d '{}' -o /dev/null &
sleep 0.3
chk "   the user refreshes mid-send: the batch reads 'syncing', a void meanwhile is refused" "$(curl -s -b $M $B/api/billing-batches/$B3 | jq "d['batch']['syncStatus']")|$(mgc POST /api/billing-batches/$B3/void '{"reason":"impatient"}')" "syncing|409"
wait
chk "   ...and finishes exactly once"                                       "$(curl -s -b $M $B/api/billing-batches/$B3 | jq "d['batch']['syncStatus'], d['batch']['qbInvoiceId']")|$(curl -s -b $M $B/api/_test/qb-fake | jq "d['invoicesCreated']")" "sent_to_quickbooks INV-3|3"
chk "   a billed load cannot be voided on its own (409, points at the batch)" "$(mg POST /api/loads/$L1/void '{"reason":"x"}' | jq "d['billingBatchId']=='$B3'")" "True"

# ── C2. Archiving moves loads off the board, not out of the records ──
BEFORE_COST=$(curl -s -b $M $B/api/material-costs | jq "int(d['grandTotal'])")
chk "C2 archive: the two billed loads (one QuickBooks, one manual) leave the board" "$(mg POST /api/history/archive | jq "d['archived']['loads'], d['heldBack']")|$(data "len([l for l in d['loads'] if l['id'] in ('$L1','$L2')])")" "2 0|0"
chk "   the batch still shows its (archived) loads"                          "$(curl -s -b $M $B/api/billing-batches/$B3 | jq "[l['id'] for l in d['loads']]")" "['$L1']"
chk "   Material Costs and Reports still count them"                        "$(curl -s -b $M $B/api/material-costs | jq "int(d['grandTotal'])==$BEFORE_COST")|$(curl -s -b $M $B/api/reports | jq "d['totals']['billedThisMonth']")" "True|2"
chk "   voiding the batch after archive releases the archived load too (no phantom 'billed')" "$(mg POST /api/billing-batches/$B3/void '{"reason":"customer dispute"}' | jq "d['success']")|$(curl -s -b $M $B/api/history | python3 -c "import json,sys;d=json.load(sys.stdin);l=[x for b in d['archive'] for x in b['loads'] if x['id']=='$L1'][0];print(l['billStatus'], repr(l['qbInvoiceId']), repr(l['billingBatchId']))")" "True|ready '' ''"
chk "   an archived load is still owed to its vendor: the released CEMEX trip can be billed" "$(mg POST /api/vendor-bills/preview "{\"loadIds\":[\"$L1\"]}" | jq "[(g['vendorName'], g['lineItems'][0]['loads']) for g in d['groups']]")" "[('CEMEX', 1)]"

# ── C9 + C11. Shifts: odometers are per truck; an office close waits for review ──
chk "C9 Rigo starts his day on Truck #4 at 100,000"                          "$(curl -s -b $RG -H "$J" -X POST $B/api/shifts/start -d '{"truckId":"truck-4","odometer":100000,"inspection":{"satisfactory":true},"signature":"'"$PNG"'"}' | jq "d['shift']['truckNum'], d['shift']['startOdometer']")" "Truck #4 100000"
SH=$(curl -s -b $RG $B/api/shifts/current | jq "d['shift']['id']")
mg POST /api/customers '{"name":"Segment Co","city":"Madera"}' >/dev/null
mg POST /api/customer-prices '{"customer":"Segment Co","material":"3/4 Rock","unit":"hour","price":95}' >/dev/null   # an hourly customer: billed from the freight window
P6=$(newpo '{"po":{"poNumber":"P0-6","customer":"Segment Co","deliveryDate":"'"$TODAY"'","address":"9 Seg Rd","city":"Madera","plannedVendorId":"vulcan"},"splits":[{"truckId":"rigo","truckUnitId":"truck-4","material":"3/4 Rock","loadsAssigned":2,"vendorId":"vulcan"}]}'); P6=${P6%% *}; L6=$(loadof $P6)
dr $RG $L6 '{"action":"start-trip"}' >/dev/null
FS1=$(dr $RG $L6 '{"action":"arrived-pickup","yardId":"vulcan","odometer":100010}' | jq "d['load']['freightSegmentId']")
dr $RG $L6 "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null; dr $RG $L6 '{"action":"arrived-jobsite"}' >/dev/null; dr $RG $L6 '{"action":"trip-complete"}' >/dev/null
chk "   freight finished on Truck #4 at 100,050"                            "$(curl -s -b $RG -H "$J" -X POST $B/api/freight-segments/$FS1/close -d '{"odometer":100050}' | jq "d['segment']['status'], d['segment']['billableMiles']")" "closed 40"
chk "   truck change to Truck #14 (odometer 50,000)"                        "$(curl -s -b $RG -H "$J" -X POST $B/api/shifts/$SH/truck-change -d '{"toTruckId":"truck-14","fromOdometer":100060,"toOdometer":50000}' | jq "d['shift']['truckNum']")" "Truck #14"
dr $RG $L6 '{"action":"start-trip"}' >/dev/null
R=$(dr $RG $L6 '{"action":"arrived-pickup","yardId":"vulcan","odometer":50010}')
chk "   next pickup at 50,010 on the new truck is accepted (was refused as 'inside' the old truck's freight)" "$(echo "$R" | jq "d['success'], d.get('code'), bool(d['load']['freightSegmentId'])")" "True None True"
FS2=$(echo "$R" | jq "d['load']['freightSegmentId']")
dr $RG $L6 "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null; dr $RG $L6 '{"action":"arrived-jobsite"}' >/dev/null; dr $RG $L6 '{"action":"trip-complete"}' >/dev/null
curl -s -b $RG -H "$J" -X PUT $B/api/loads/$L6 -d "{\"pod\":{\"signedBy\":\"x\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null
dr $RG $L6 '{"action":"delivered"}' >/dev/null; mg POST /api/loads/$L6/approve >/dev/null
chk "   the finished Truck #4 freight is locked (all its loads approved)"   "$(curl -s -b $M $B/api/freight-segments/$FS1 | jq "d['segment']['locked']")" "True"
chk "C11 Rigo forgot End day; the office closes it: freight closed but NOT locked — it waits for review" "$(mg POST /api/shifts/$SH/close '{"odometer":50100,"reason":"driver forgot to end the day"}' | jq "d['shift']['status']")|$(curl -s -b $M $B/api/freight-segments/$FS2 | jq "d['segment']['status'], d['segment']['locked'], bool(d['segment']['needsReview'])")" "closed|closed False True"
chk "   the Freight Bill stays DRAFT meanwhile"                             "$(curl -s -b $M $B/api/freight-segments/$FS2/freight-bill | python3 -c "import sys;h=sys.stdin.read();print('DRAFT' in h, 'FINAL' in h, 'awaiting review' in h)")" "True False True"
chk "   …and the hourly invoice will not bill the office-typed window until it is reviewed" "$(mg POST /api/billing-batches/preview "{\"loadIds\":[\"$L6\"]}" | jq "d['groups'][0]['unconfigured'], 'closed by the office' in d['groups'][0]['unconfiguredReasons'][0]")" "True True"
chk "   the office sees the review link on the day panel"                  "$(grep -c "confirmSegmentEnding(" public/index.html)" "2"
sleep 1
chk "   a manager reviews the window with a reason → locked, FINAL"         "$(mg PUT /api/freight-segments/$FS2 "{\"odEnd\":50040,\"timeEnd\":\"$(date -u +%FT%TZ)\",\"reason\":\"driver confirmed 50,040 at the last drop\"}" | jq "d['segment']['odEnd'], d['segment']['locked'], d['segment']['needsReview']")|$(curl -s -b $M $B/api/freight-segments/$FS2/freight-bill | python3 -c "import sys;h=sys.stdin.read();print('DRAFT' in h, 'FINAL' in h)")" "50040 True None|False True"
chk "   …now the hourly invoice prices from the two freight windows"         "$(mg POST /api/billing-batches/preview "{\"loadIds\":[\"$L6\"]}" | jq "d['groups'][0]['unconfigured'], d['groups'][0]['lineItems'][0]['basis'], d['groups'][0]['lineItems'][0]['unit']")" "False segment hour"

# ── Review findings: a hand-counted remainder is claimed too; a date move checks conflicts;
#    a batch that failed AFTER its invoice existed recovers instead of sticking ──
P10=$(newpo '{"po":{"poNumber":"P0-10","customer":"Phase Zero Co","deliveryDate":"'"$TODAY"'","plannedVendorId":"vulcan"},"splits":[{"truckId":"matthew","truckUnitId":"truck-4","material":"Base Rock","loadsAssigned":3,"vendorId":"vulcan"}]}'); P10=${P10%% *}; L10=$(loadof $P10)
MA=$(mktemp); curl -s -c $MA -X POST -d "username=matthew&password=matthew123" $B/login -o /dev/null
dr $MA $L10 '{"action":"start-trip"}' >/dev/null; dr $MA $L10 '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null; dr $MA $L10 "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null; dr $MA $L10 '{"action":"arrived-jobsite"}' >/dev/null; dr $MA $L10 '{"action":"trip-complete"}' >/dev/null
curl -s -b $MA -H "$J" -X PUT $B/api/loads/$L10 -d "{\"pod\":{\"signedBy\":\"x\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null
# (Rule changed by the architecture checkpoint, CRITICAL 1: a hand-counted remainder is no longer
#  accepted — the delivered count is the completed trips, so this load bills once as ONE load.)
chk "R1 a hand-counted remainder is refused (400 delivered_mismatch); Stop early submits the one completed trip" "$(dr $MA $L10 '{"action":"incomplete","delivered":2}' | jq "d['code'], d['completedTrips']")|$(dr $MA $L10 '{"action":"incomplete","delivered":1}' | jq "d['success']")|$(load $L10 "l['loadsDelivered'], l['isPartial'], l['approvalStatus']")" "delivered_mismatch 1|True|1 True submitted"
mg POST /api/loads/$L10/approve '{"acknowledge":true}' >/dev/null
chk "R1 one recorded trip bills once as 1 load; nothing left to bill; void releases it" "$(mg POST /api/vendor-bills/preview "{\"loadIds\":[\"$L10\"]}" | jq "d['groups'][0]['lineItems'][0]['loads'], d['groups'][0]['totalAmount']")|$(VBX=$(mg POST /api/vendor-bills "{\"loadIds\":[\"$L10\"]}" | jq "d['bills'][0]['id']"); mgc POST /api/vendor-bills/preview "{\"loadIds\":[\"$L10\"]}"; echo -n '|'; mg POST /api/vendor-bills/$VBX/void '{"reason":"check"}' >/dev/null; mg POST /api/vendor-bills/preview "{\"loadIds\":[\"$L10\"]}" | jq "d['groups'][0]['lineItems'][0]['loads']")" "1 550|400|1"
TOMORROW=$(date -d '+1 day' +%F)
P11=$(newpo '{"po":{"poNumber":"P0-11","customer":"Phase Zero Co","deliveryDate":"'"$TODAY"'","plannedVendorId":"vbt"},"splits":[{"truckId":"carlos","truckUnitId":"truck-2b","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}'); P11=${P11%% *}; L11=$(loadof $P11)
mg POST /api/pos '{"po":{"poNumber":"P0-12","customer":"Phase Zero Co","deliveryDate":"'"$TOMORROW"'","plannedVendorId":"vbt"},"splits":[{"truckId":"rigo","truckUnitId":"truck-2b","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' >/dev/null
dr $CA $L11 '{"action":"start-trip"}' >/dev/null
R=$(mg POST /api/loads/move "{\"scope\":\"single\",\"loadId\":\"$L11\",\"newDate\":\"$TOMORROW\",\"reason\":\"customer pushed a day\"}")
chk "R2 a date move checks conflicts: mid-haul load, and Truck #2B is Rigo's tomorrow → 409" "$(echo "$R" | jq "d['code'], sorted(c['type'] for c in d['conflicts'])")|$(load $L11 "l['deliveryDate']=='$TODAY'")" "assignment_conflict ['load-in-progress', 'truck-busy']|True"
chk "   with the dispatcher's go-ahead it moves, and the override is audited"  "$(mg POST /api/loads/move "{\"scope\":\"single\",\"loadId\":\"$L11\",\"newDate\":\"$TOMORROW\",\"reason\":\"customer pushed a day\",\"force\":true}" | jq "d['success'], d['moved']")|$(load $L11 "l['deliveryDate']=='$TOMORROW'")|$(curl -s -b $M "$B/api/audit-log?action=moved-loads" | jq "d['entries'][0]['details']['conflictsOverridden']")" "True 1|True|['load-in-progress', 'truck-busy']"
B4=$(mg POST /api/billing-batches "{\"loadIds\":[\"$L5\"]}" | jq "d['batches'][0]['id']")
INV_BEFORE=$(curl -s -b $M $B/api/_test/qb-fake | jq "d['invoicesCreated']")
mg POST /api/_test/save-mode '{"mode":"fail","after":1}' >/dev/null       # the 'syncing' save passes; the save after the invoice fails
chk "R3 the invoice is created but the save after it fails → 503, batch failed WITH its invoice id" "$(mgc POST /api/billing-batches/$B4/send)|$(curl -s -b $M $B/api/billing-batches/$B4 | jq "d['batch']['syncStatus'], d['batch']['qbInvoiceId']!=''")" "503|failed True"
mg POST /api/_test/save-mode '{"mode":"ok"}' >/dev/null
chk "   Retry confirms the invoice in QuickBooks and marks the batch sent — no second invoice, nothing stuck" "$(mg POST /api/billing-batches/$B4/retry | jq "d['recovered'], d['batch']['syncStatus']")|$(load $L5 "l['billStatus']")|$(curl -s -b $M $B/api/_test/qb-fake | jq "d['invoicesCreated'] - $INV_BEFORE")" "True sent_to_quickbooks|billed|1"

# ── C10. Concurrent writes: all answered, memory and disk agree ──
P7=$(newpo '{"po":{"poNumber":"P0-7","customer":"Phase Zero Co","deliveryDate":"'"$TODAY"'","plannedVendorId":"vbt"},"splits":[{"truckId":"leonardo","truckUnitId":"truck-12","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}'); P7=${P7%% *}; L7=$(loadof $P7)
rm -f /tmp/vbt-p0-codes.txt
for i in 1 2 3 4 5 6 7 8; do mgc PUT /api/loads/$L7 "{\"notes\":\"note $i\"}" >> /tmp/vbt-p0-codes.txt & done; wait
chk "C10 eight overlapping saves all succeed"                               "$(tr -d '\n' < /tmp/vbt-p0-codes.txt | fold -w3 | sort -u | tr -d '\n')" "200"
rm -f /tmp/vbt-p0-codes.txt
chk "   what the API shows is what is on disk"                              "$(python3 -c "
import json;d=json.load(open('data.json'));print([l['notes'] for l in d['loads'] if l['id']=='$L7'][0])")|$(load $L7 "l['notes']")" "$(load $L7 "l['notes']")|$(load $L7 "l['notes']")"

echo
echo "── 41. One dispatch board: every status from the server, one rule for who is busy ──"
pkill -f "^node server.js" >/dev/null 2>&1; sleep 1; rm -f data.json data-ids.json telemetry.json
(VBT_TEST_HOOKS=1 node server.js > /tmp/vbt-test-board.log 2>&1 &)
for i in $(seq 1 20); do sleep 1; curl -sf $B/healthz >/dev/null 2>&1 && break; done
J='Content-Type: application/json'; TODAY=$(date +%F); YESTERDAY=$(date -d '-1 day' +%F); TOMORROW=$(date -d '+1 day' +%F)
jq() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
curl -s -c $M -X POST -d "username=joshua&password=joshua123" $B/login -o /dev/null
BE=$(mktemp); curl -s -c $BE -X POST -d "username=beryle&password=beryle123" $B/login -o /dev/null
RG=$(mktemp); curl -s -c $RG -X POST -d "username=rigo&password=rigo123" $B/login -o /dev/null
mg()  { curl -s -b $M -H "$J" -X "$1" "$B$2" -d "${3:-"{}"}" "${@:4}"; }
dr()  { curl -s -b "$1" -H "$J" -X POST $B/api/loads/$2/trip-action -d "$3"; }
tod() { curl -s -b $M "$B/api/today${2:-}" | jq "$1"; }
loadof() { curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$1' and (l['truckId'] or '')=='${2:-}'][0]"; }
# Static: one board, one status source.
chk "41 the page has one dispatch board and no second Board tab or status math" "$(grep -c 'data-tab="board"' public/index.html)|$(grep -c 'function computeBoardStats\|function renderDayBoard\|function renderMonthBoard' public/index.html)|$(grep -c 'function paintToday' public/index.html)|$(grep -c 'id="sec-today"' public/index.html)" "0|0|1|1"
chk "   the board renders buckets, states and flags it is given, never recomputes them" "$(sed -n '/^function paintToday/,/^function dbLoadCard/p' public/index.html | grep -c "approvalStatus ===\|loadsDelivered >\|timestamps\.")" "0"
# Fixture: Board Co today — Beryle 2 loads from Vulcan, Matthew 1 from our yard, one load with nobody yet; Carlos is off; Rigo has yesterday's unfinished load.
P=$(mg POST /api/pos '{"po":{"poNumber":"B41-1","customer":"Board Co","deliveryDate":"'"$TODAY"'","address":"7 Board Ave","city":"Fresno","plannedVendorId":"vulcan"},"splits":[{"truckId":"beryle","truckUnitId":"truck-2","material":"3/4 Rock","loadsAssigned":2,"vendorId":"vulcan"},{"truckId":"matthew","truckUnitId":"truck-4","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"},{"truckId":null,"truckUnitId":null,"material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' | jq "d['po']['id']")
LB=$(loadof $P beryle); LM=$(loadof $P matthew); LU=$(loadof $P "")
PY=$(mg POST /api/pos '{"po":{"poNumber":"B41-Y","customer":"Board Co","deliveryDate":"'"$YESTERDAY"'","plannedVendorId":"vbt"},"splits":[{"truckId":"rigo","truckUnitId":"truck-14","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' | jq "d['po']['id']"); LY=$(loadof $PY rigo)
mg PUT /api/drivers/carlos '{"status":"off"}' >/dev/null
mg PUT /api/fleet/trucks/truck-2b '{"status":"maintenance"}' >/dev/null
chk "   loads: 2 assigned, 1 unassigned; the unassigned one is missing a driver" "$(tod "sorted((l['bucket'], l['missing']) for l in d['loads'])")" "[('assigned', []), ('assigned', []), ('unassigned', ['driver'])]"
chk "   drivers: Beryle and Matthew assigned, Leonardo and Rigo available, Carlos off" "$(tod "sorted((x['id'], x['state'], x['available']) for x in d['drivers'])")" "[('beryle', 'assigned', False), ('carlos', 'off', False), ('leonardo', 'available', True), ('matthew', 'assigned', False), ('rigo', 'available', True)]"
chk "   trucks: #2 and #4 assigned (with their drivers), #12 and #14 free, #2B in shop" "$(tod "sorted((t['truckNum'], t['state'], t['driverName']) for t in d['trucks'])")" "[('Truck #12', 'available', ''), ('Truck #14', 'available', ''), ('Truck #2', 'assigned', 'Beryle'), ('Truck #2B', 'unavailable', ''), ('Truck #4', 'assigned', 'Matthew')]"
chk "   attention row: 1 unassigned, 1 missing info, 1 carried over (Rigo's yesterday), 2 drivers free, 2 trucks free" "$(tod "tuple(d['attention'][k] for k in ['unassigned','inProgress','awaitingApproval','readyToBill','missingInfo','conflicts','carriedOver','availableDrivers','availableTrucks'])")" "(1, 0, 0, 0, 1, 0, 1, 2, 2)"
chk "   the carried-over list names yesterday's load with its date" "$(tod "[(l['id']==\"$LY\", l['deliveryDate']==\"$YESTERDAY\", l['bucket']) for l in d['carriedOver']]")" "[(True, True, 'assigned')]"
chk "   a driver row carries the load facts: truck, customer, PO, pickup → destination, progress" "$(tod "[(x['truckNum'], x['customer'], x['poNumber'], x['pickup'], x['destination'], x['progress'], x['stage']) for x in d['drivers'] if x['id']=='beryle'][0]")" "('Truck #2', 'Board Co', 'B41-1', 'Vulcan', '7 Board Ave, Fresno', '0/2', 'Assigned')"
# Beryle rolls
dr $BE $LB '{"action":"start-trip"}' >/dev/null
chk "   Beryle starts: load in progress 'Going to yard', driver and Truck #2 in progress" "$(tod "[(l['bucket'], l['stage']) for l in d['loads'] if l['id']=='$LB'][0], [x['state'] for x in d['drivers'] if x['id']=='beryle'][0], [t['state'] for t in d['trucks'] if t['id']=='truck-2'][0], d['attention']['inProgress'], d['summary']['drivers']['inProgress'], d['summary']['trucks']['inProgress']")" "('in-progress', 'Going to yard') in-progress in-progress 1 1 1"
dr $BE $LB '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null
chk "   …at the yard the stage follows" "$(tod "[l['stage'] for l in d['loads'] if l['id']=='$LB'][0]")" "At yard"
# Missing information: Matthew's load loses its truck
mg POST /api/loads/$LM/assign '{"truckUnitId":null}' >/dev/null
chk "   a load with a driver but no truck is flagged 'missing: truck'" "$(tod "[l['missing'] for l in d['loads'] if l['id']=='$LM'][0], d['attention']['missingInfo']")" "['truck'] 2"
# Conflicts: the office forces Truck #2 (on Beryle's open load) onto Matthew's load
mg POST /api/loads/$LM/assign '{"truckUnitId":"truck-2","force":true,"reason":"test"}' >/dev/null
chk "   a forced double-booking shows as a conflict on BOTH loads and in the attention row" "$(tod "sorted(len(l['conflicts']) for l in d['loads']), d['attention']['conflicts'], [l['conflicts'][0] for l in d['loads'] if l['id']=='$LM'][0]")" "[0, 1, 1] 2 Truck #2 is also on Beryle's load $LB"
mg POST /api/loads/$LM/assign '{"truckUnitId":"truck-4"}' >/dev/null
chk "   …and clears when the truck is put back" "$(tod "d['attention']['conflicts'], d['attention']['missingInfo']")" "0 1"
# Live refresh: the office version is the board's version and moves when a day starts
V1=$(tod "d['version']"); DV=$(curl -s -b $M $B/api/dispatch-version | jq "d['version']")
chk "   /api/dispatch-version for the office IS the board's version" "$([ "$V1" = "$DV" ] && echo same || echo differs)" "same"
curl -s -b $RG -H "$J" -X POST $B/api/shifts/start -d '{"truckId":"truck-14","odometer":70000,"inspection":{"satisfactory":true},"signature":"'"$PNG"'"}' -o /dev/null
chk "   a driver starting the day changes the version (the board shows 'day started')" "$([ "$V1" != "$(tod "d['version']")" ] && echo changed || echo same)|$(tod "[x['dayStartedAt'] is not None for x in d['drivers'] if x['id']=='rigo'][0], [x['truckNum'] for x in d['drivers'] if x['id']=='rigo'][0]")" "changed|True Truck #14"
# Beryle finishes and submits; then approval, then billing — buckets and states follow
dr $BE $LB "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null; dr $BE $LB '{"action":"arrived-jobsite"}' >/dev/null; dr $BE $LB '{"action":"trip-complete"}' >/dev/null
dr $BE $LB '{"action":"start-trip"}' >/dev/null; dr $BE $LB '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null; dr $BE $LB "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null; dr $BE $LB '{"action":"arrived-jobsite"}' >/dev/null; dr $BE $LB '{"action":"trip-complete"}' >/dev/null
curl -s -b $BE -H "$J" -X PUT $B/api/loads/$LB -d "{\"pod\":{\"signedBy\":\"x\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null
dr $BE $LB '{"action":"delivered"}' >/dev/null
chk "   submitted: awaiting approval, nothing missing, Beryle done and free again, Truck #2 free" "$(tod "[(l['bucket'], l['missing']) for l in d['loads'] if l['id']=='$LB'][0], [(x['state'], x['available']) for x in d['drivers'] if x['id']=='beryle'][0], [t['state'] for t in d['trucks'] if t['id']=='truck-2'][0], d['attention']['awaitingApproval']")" "('awaiting-approval', []) ('completed', True) available 1"
mg POST /api/loads/$LB/approve >/dev/null
chk "   approved: Ready to Bill, with the amount (2 loads × 25 t × \$25)" "$(tod "[l['bucket'] for l in d['loads'] if l['id']=='$LB'][0], d['summary']['readyToBill'], d['attention']['readyToBill'], d['attention']['readyToBillAmount'], d['attention']['awaitingApproval']")" "ready-to-bill 1 1 1250 0"
mg POST /api/loads/bill "{\"loadIds\":[\"$LB\"]}" >/dev/null
chk "   billed: Completed" "$(tod "[l['bucket'] for l in d['loads'] if l['id']=='$LB'][0], d['summary']['completed'], d['attention']['readyToBill']")" "completed 1 0"
chk "   planning another day: its own loads, the same attention row" "$(tod "len(d['loads']), d['isToday'], d['attention']['awaitingApproval']==0 and d['attention']['carriedOver']==1" "?date=$TOMORROW")|$(tod "[l['id'] for l in d['loads']]==['$LY'], d['isToday']" "?date=$YESTERDAY")" "0 False True|True False"
mg PUT /api/drivers/carlos '{"status":"available"}' >/dev/null; mg PUT /api/fleet/trucks/truck-2b '{"status":"available"}' >/dev/null

echo
echo "── 42. Conflicts are decided in the app: one dialog, Cancel or go ahead, never a browser confirm ──"
CF=$(sed -n '/^function confirmConflicts/,/^async function postAssignment/p' public/index.html)
chk "42 the conflict dialog is in the page (a Promise the caller awaits), not a native confirm()" "$(echo "$CF" | grep -c '[^a-zA-Z]confirm(')|$(echo "$CF" | grep -c 'return new Promise(resolve')|$(echo "$CF" | grep -c "id = 'conflict-modal'")" "0|1|1"
chk "   it is titled for what collides and offers Cancel and the verb (Assign / Reassign / Move)" "$(grep -c "'driver-busy': 'Driver Already Assigned', 'truck-busy': 'Truck Already Assigned'" public/index.html)|$(echo "$CF" | grep -c 'id="conflict-cancel">Cancel<')|$(echo "$CF" | grep -c 'id="conflict-go">\${escapeHtml(verb)}<')" "1|1|1"
chk "   Cancel is the default: focused, Escape, the × and the backdrop all cancel" "$(echo "$CF" | grep -c "conflict-cancel').focus()")|$(echo "$CF" | grep -c "e.key === 'Escape'")|$(echo "$CF" | grep -c "conflict-x').onclick = () => done(false)")|$(echo "$CF" | grep -c "e.target === el) done(false)")" "1|1|1|1"
chk "   a go-ahead is resent with force and the typed reason; a Cancel is reported as cancelled" "$(grep -c "force: true, reason: c.reason || reason ||" public/index.html)|$(grep -c "d = { ...d, cancelled: true }" public/index.html)" "1|1"
chk "   every assignment path (sheet, reassign modal, PO form, date move) stays quiet on Cancel" "$(grep -c '\.cancelled)' public/index.html)|$(grep -c 'postAssignment(' public/index.html)" "6|7"

echo
echo "── 43. Approval confirms the record: Driver · Truck · Pickup yard · Ticket · Delivery ──"
pkill -f "^node server.js" >/dev/null 2>&1; sleep 1; rm -f data.json data-ids.json telemetry.json
(VBT_TEST_HOOKS=1 node server.js > /tmp/vbt-test-approve.log 2>&1 &)
for i in $(seq 1 20); do sleep 1; curl -sf $B/healthz >/dev/null 2>&1 && break; done
J='Content-Type: application/json'; TODAY=$(date +%F)
jq() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
curl -s -c $M -X POST -d "username=joshua&password=joshua123" $B/login -o /dev/null
BE=$(mktemp); curl -s -c $BE -X POST -d "username=beryle&password=beryle123" $B/login -o /dev/null
MA=$(mktemp); curl -s -c $MA -X POST -d "username=matthew&password=matthew123" $B/login -o /dev/null
mg()  { curl -s -b $M -H "$J" -X "$1" "$B$2" -d "${3:-"{}"}" "${@:4}"; }
dr()  { curl -s -b "$1" -H "$J" -X POST $B/api/loads/$2/trip-action -d "$3"; }
tod() { curl -s -b $M "$B/api/today${2:-}" | jq "$1"; }
load() { curl -s -b $M $B/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);l=[x for x in d['loads'] if x['id']=='$1'][0];print($2)"; }
appr() { curl -s -b $M $B/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);l=[x for x in d['loads'] if x['id']=='$1'][0];a=l.get('approval');print($2)"; }
loadof() { curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$1' and (l['truckId'] or '')=='${2:-}'][0]"; }
haul() { # driver-cookie load yard : one full trip with a ticket
  dr $1 $2 '{"action":"start-trip"}' >/dev/null; dr $1 $2 "{\"action\":\"arrived-pickup\",\"yardId\":\"$3\"}" >/dev/null
  dr $1 $2 "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null; dr $1 $2 '{"action":"arrived-jobsite"}' >/dev/null; dr $1 $2 '{"action":"trip-complete"}' >/dev/null; }
submit() { curl -s -b $1 -H "$J" -X PUT $B/api/loads/$2 -d "{\"pod\":{\"signedBy\":\"Site Foreman\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null; dr $1 $2 '{"action":"delivered"}' >/dev/null; }
# Fixture: Beryle's load is complete in every respect; Matthew's was created with no truck.
P=$(mg POST /api/pos '{"po":{"poNumber":"A43-1","customer":"Approve Co","deliveryDate":"'"$TODAY"'","address":"9 Gate Rd","city":"Fresno","plannedVendorId":"vulcan"},"splits":[{"truckId":"beryle","truckUnitId":"truck-2","material":"3/4 Rock","loadsAssigned":2,"vendorId":"vulcan"},{"truckId":"matthew","truckUnitId":null,"material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' | jq "d['po']['id']")
LB=$(loadof $P beryle); LM=$(loadof $P matthew)
chk "43 a load that is not submitted carries no checklist" "$(appr $LB "a")" "None"
haul $BE $LB vulcan; haul $BE $LB vulcan; submit $BE $LB
haul $MA $LM vbt; submit $MA $LM
chk "   a complete load: every item ✓ with the fact behind it, ready to approve" "$(appr $LB "a['ready'], [(i['key'], i['ok'], i['value']) for i in a['items']]")" "True [('driver', True, 'Beryle'), ('truck', True, 'Truck #2'), ('pickup', True, 'Vulcan'), ('ticket', True, '2 tickets · 49 t'), ('delivery', True, '2/2 loads · signed by Site Foreman'), ('billing', True, '\$1250.00 · 50.00 t @ \$25/ton'), ('cost', True, '\$1900.00')]"   # OA3: the checklist carries the money
chk "   the pickup yard is the one confirmed at the scale; planned and actual tons sit side by side" "$(appr $LB "[i['note'] for i in a['items']]")" "['', '', 'confirmed at the scale', 'planned 50 t, actual 49 t', '', 'default rate — no customer price on file', '']"   # OA3: Board Co has no price on file — the checklist says so
chk "   Matthew's load: ⚠ Truck (none recorded), everything else ✓" "$(appr $LM "a['ready'], a['warnings'], [i['key'] for i in a['items'] if not i['ok']]")" "False ['Truck: no truck recorded on this load'] ['truck']"
chk "   the dispatch board says the same thing about it (one rule)" "$(tod "[l['missing'] for l in d['loads'] if l['id']=='$LM'][0], d['attention']['missingInfo']")" "['Truck: no truck recorded on this load'] 1"
chk "   a plain approve of the incomplete load is refused (409 approval_incomplete) with the checklist; it stays submitted" "$(mg POST /api/loads/$LM/approve '{}' -w ' %{http_code}' | python3 -c "import sys,json;raw=sys.stdin.read().rstrip();body,code=raw.rsplit(' ',1);d=json.loads(body);print(code, d['code'], d['checklist']['ready'], d['error'])")|$(load $LM "l['approvalStatus'], l['locked']")" "409 approval_incomplete False This load is not complete — Truck: no truck recorded on this load.|submitted True"
chk "   the complete load approves without ceremony" "$(mg POST /api/loads/$LB/approve '{}' | jq "d['success'], d['approvedWithWarnings']")|$(load $LB "l['approvalStatus'], l['billStatus'], l.get('approvalWarnings')")" "True []|approved ready None"
chk "   with the manager's acknowledgement the incomplete one approves, and the gap stays on the record" "$(mg POST /api/loads/$LM/approve '{"acknowledge":true}' | jq "d['success'], d['approvedWithWarnings']")|$(load $LM "l['approvalStatus'], l['locked'], l['billStatus'], l.get('approvalWarnings')")" "True ['Truck: no truck recorded on this load']|approved True ready ['Truck: no truck recorded on this load']"
chk "   …and in the audit log" "$(curl -s -b $M "$B/api/audit-log?action=approved-load" | jq "[e['details'].get('approvedWithWarnings') for e in d['entries'] if e['target']=='$LM'][0], [e['details'].get('approvedWithWarnings') for e in d['entries'] if e['target']=='$LB'][0]")" "['Truck: no truck recorded on this load'] None"
chk "   an approved load carries no checklist any more (it is locked)" "$(appr $LM "a")" "None"
AP=$(sed -n '/^async function approveLoad/,/^\/\/ ── BILLING/p' public/index.html)
chk "   approve and reject are decided in the app: no prompt(), no confirm(); a stale page re-asks with the server's checklist (and a blocked load shows it too)" "$(echo "$AP" | grep -c 'prompt(\|[^a-zA-Z]confirm(')|$(echo "$AP" | grep -c 'confirmApproval(l, d.checklist)')|$(grep -c 'approvalChecklistHtml(l.approval, true)' public/index.html)|$(grep -c 'acknowledge: !!(check && !check.ready)' public/index.html)" "0|2|1|1"

echo
echo "── 44. Editing a PO: the order changes, the work follows only where it is still operational (PO-EDITING.md) ──"
pkill -f "^node server.js" >/dev/null 2>&1; sleep 1; rm -f data.json data-ids.json telemetry.json
(VBT_TEST_HOOKS=1 node server.js > /tmp/vbt-test-poedit.log 2>&1 &)
for i in $(seq 1 20); do sleep 1; curl -sf $B/healthz >/dev/null 2>&1 && break; done
J='Content-Type: application/json'; TODAY=$(date +%F); TOMORROW=$(date -d '+1 day' +%F)
jq() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
curl -s -c $M -X POST -d "username=joshua&password=joshua123" $B/login -o /dev/null
BE=$(mktemp); curl -s -c $BE -X POST -d "username=beryle&password=beryle123" $B/login -o /dev/null
LE=$(mktemp); curl -s -c $LE -X POST -d "username=leonardo&password=leo123" $B/login -o /dev/null
mg()  { curl -s -b $M -H "$J" -X "$1" "$B$2" -d "${3:-"{}"}" "${@:4}"; }
dr()  { curl -s -b "$1" -H "$J" -X POST $B/api/loads/$2/trip-action -d "$3"; }
load() { curl -s -b $M $B/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);l=[x for x in d['loads'] if x['id']=='$1'][0];print($2)"; }
po()   { curl -s -b $M $B/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);p=[x for x in d['pos'] if x['id']=='$1'][0];print($2)"; }
loadof() { curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$1' and (l['truckId'] or '')=='${2:-}'][0]"; }
code() { python3 -c "import sys,json;raw=sys.stdin.read().rstrip();b,c=raw.rsplit(' ',1);d=json.loads(b);print(c, $1)"; }
haul() { dr $1 $2 '{"action":"start-trip"}' >/dev/null; dr $1 $2 "{\"action\":\"arrived-pickup\",\"yardId\":\"$3\"}" >/dev/null
  dr $1 $2 "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null; dr $1 $2 '{"action":"arrived-jobsite"}' >/dev/null; dr $1 $2 '{"action":"trip-complete"}' >/dev/null; }
submit() { curl -s -b $1 -H "$J" -X PUT $B/api/loads/$2 -d "{\"pod\":{\"signedBy\":\"Site Foreman\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null; dr $1 $2 '{"action":"delivered"}' >/dev/null; }
mg POST /api/customer-prices '{"customer":"Priced Co","material":"3/4 Rock","unit":"ton","price":30}' >/dev/null
# Fixture: four loads on one order — Beryle rolling (work in progress), Matthew following the planned yard,
# Rigo on an explicit yard with a hand-set price, one load still unassigned. The jobsite has a saved pin.
P=$(mg POST /api/pos '{"po":{"poNumber":"E44-1","customer":"Edit Co","deliveryDate":"'"$TODAY"'","address":"1 Old Rd","city":"Fresno","plannedVendorId":"vulcan"},"splits":[{"truckId":"beryle","truckUnitId":"truck-2","material":"3/4 Rock","loadsAssigned":2,"vendorId":"vulcan"},{"truckId":"matthew","truckUnitId":"truck-4","material":"Dirt","loadsAssigned":1,"vendorId":"vulcan"},{"truckId":"rigo","truckUnitId":"truck-14","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"},{"truckId":null,"truckUnitId":null,"material":"3/4 Rock","loadsAssigned":1,"vendorId":"vulcan"}]}' | jq "d['po']['id']")
LB=$(loadof $P beryle); LM=$(loadof $P matthew); LR=$(loadof $P rigo); LU=$(loadof $P "")
mg PUT /api/pos/$P/location '{"lat":36.7,"lng":-119.7}' >/dev/null
dr $BE $LB '{"action":"start-trip"}' >/dev/null
# A hand-set price is planted with the test hook: no office operation sets a per-load customer rate
# (prices come from Vendors & Prices at creation; the generic load update refuses customerRate — CRITICAL 2).
mg POST /api/_test/set-load "{\"id\":\"$LR\",\"fields\":{\"customerRate\":40}}" >/dev/null
PC=$(mg POST /api/pos '{"po":{"poNumber":"E44-C","customer":"Other Co","deliveryDate":"'"$TOMORROW"'","plannedVendorId":"vbt"},"splits":[{"truckId":"carlos","truckUnitId":"truck-4","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' | jq "d['po']['id']")
chk "44 only the order's own fields go through a PO update; status, materials and the pin are derived or have their own action" "$(mg PUT /api/pos/$P '{"status":"completed","notes":"x"}' -w ' %{http_code}' | code "d['rejectedFields']")|$(po $P "p['status'], repr(p['notes'])")" "400 ['status']|active ''"
R=$(mg PUT /api/pos/$P "{\"deliveryDate\":\"$TOMORROW\",\"reason\":\"pour moved\"}")
chk "   a date change that would put Truck #4 on two drivers tomorrow is a conflict: 409, nothing changed" "$(echo "$R" | jq "d['code'], d['conflicts'][0]['type']")|$(po $P "p['deliveryDate']=='$TODAY'")|$(load $LM "l['deliveryDate']=='$TODAY'")" "assignment_conflict truck-busy|True|True"
R=$(mg PUT /api/pos/$P "{\"deliveryDate\":\"$TOMORROW\",\"reason\":\"pour moved\",\"force\":true}")
chk "   with the go-ahead: operational loads follow; Beryle's load in progress keeps today; the override is recorded" "$(echo "$R" | jq "sorted(d['propagation']['dateMoved']), d['propagation']['dateKept'], d['propagation']['conflictsOverridden']")" "['$LM', '$LR', '$LU'] ['$LB'] {'types': ['truck-busy'], 'reason': 'pour moved'}"
chk "   …each moved load carries the reason in its move history; the PO is rescheduled" "$(load $LM "l['deliveryDate']=='$TOMORROW', l['moveHistory'][-1]['reason'], l['moveHistory'][-1]['scope'], l['originalScheduledDate']=='$TODAY'")|$(load $LB "l['deliveryDate']=='$TODAY', l.get('moveHistory')")|$(po $P "p['deliveryDate']=='$TOMORROW', p['status'], p['poMoveHistory'][-1]['reason']")" "True pour moved po-edit True|True None|True scheduled pour moved"
R=$(mg PUT /api/pos/$P '{"customer":"Priced Co"}')
chk "   customer change: loads still on the old list price are re-priced (3/4 Rock is \$30 for Priced Co); a hand-set price stays; work in progress keeps its snapshot" "$(echo "$R" | jq "sorted(d['propagation']['repriced']), d['propagation']['keptPrice'], d['po']['customer'], d['po']['job']")|$(load $LU "l['customerRate']")|$(load $LM "l['customerRate']")|$(load $LR "l['customerRate']")|$(load $LB "l['customerRate']")" "['$LM', '$LU'] ['$LR'] Priced Co Priced Co|30|25|40|25"
R=$(mg PUT /api/pos/$P '{"address":"2 New Rd"}')
chk "   a new address clears the saved jobsite pin (it described the old address)" "$(echo "$R" | jq "d['propagation']['geoCleared'], 'geo' in d['po']")|$(po $P "p['address'], p.get('geo')")" "True False|2 New Rd None"
R=$(mg PUT /api/pos/$P '{"plannedVendorId":"teichert"}')
chk "   planned-yard change: loads that followed the plan follow it and are re-priced for that vendor; an explicit yard stays; a load in progress is untouched" "$(echo "$R" | jq "sorted(d['propagation']['yardChanged']), d['po']['pickup']")|$(load $LM "l['vendorId'], l['vendorName'], l['vendorIsInternal']")|$(load $LR "l['vendorId']")|$(load $LB "l['vendorId']")" "['$LM', '$LU'] Teichert|teichert Teichert False|vbt|vulcan"
chk "   the audit entry has each changed field, old and new, and what followed" "$(curl -s -b $M "$B/api/audit-log?action=updated-po" | jq "e=d['entries'][0]['details'];(e['changes'], e['fields']['plannedVendorId'], sorted(e['propagation']['yardChanged']))" 2>/dev/null || curl -s -b $M "$B/api/audit-log?action=updated-po" | python3 -c "import json,sys;d=json.load(sys.stdin);e=d['entries'][0]['details'];print((e['changes'], e['fields']['plannedVendorId'], sorted(e['propagation']['yardChanged'])))")" "(['plannedVendorId'], {'from': 'vulcan', 'to': 'teichert'}, ['$LM', '$LU'])"
# Frozen once approved
PF=$(mg POST /api/pos '{"po":{"poNumber":"E44-F","customer":"Frozen Co","deliveryDate":"'"$TODAY"'","plannedVendorId":"vbt"},"splits":[{"truckId":"leonardo","truckUnitId":"truck-12","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' | jq "d['po']['id']"); LF=$(loadof $PF leonardo)
haul $LE $LF vbt; submit $LE $LF; mg POST /api/loads/$LF/approve >/dev/null
chk "   once a load is approved the invoice fields are frozen; date, yard and notes still edit, and the approved load keeps its date" "$(mg PUT /api/pos/$PF '{"customer":"Someone Else","poNumber":"E44-X"}' -w ' %{http_code}' | code "sorted(d['frozenFields'])")|$(mg PUT /api/pos/$PF "{\"deliveryDate\":\"$TOMORROW\",\"notes\":\"bill by Friday\"}" | jq "d['success'], d['propagation']['dateMoved'], d['propagation']['dateKept'], d['po']['status']")|$(load $LF "l['deliveryDate']=='$TODAY'")" "403 ['customer', 'job', 'poNumber']|True [] ['$LF'] completed|True"
# Add work to an order
R=$(mg POST /api/pos/$P/loads '{"truckId":"leonardo","truckUnitId":"truck-12","material":"Dirt","loadsAssigned":2,"vendorId":"vbt"}')
LN=$(echo "$R" | jq "d['load']['id']")
chk "   add a load to the order: same PO, the PO's current date, prices snapshotted now (Priced Co, VBT yard), materials recounted" "$(echo "$R" | jq "d['success'], d['load']['poId']=='$P', d['load']['deliveryDate']=='$TOMORROW', d['load']['driverName'], d['load']['truckUnitId'], d['load']['customerRate'], d['load']['vendorIsInternal'], d['load']['vendorRate'], sorted((m['material'], m['totalLoads']) for m in d['po']['materials'])")" "True True True Leonardo truck-12 25 True 0 [('3/4 Rock', 3), ('Dirt', 4)]"
chk "   …and it is on the board for that day, audited as added" "$(curl -s -b $M "$B/api/today?date=$TOMORROW" | jq "[(l['bucket'], l['driverName'], l['truckNum']) for l in d['loads'] if l['id']=='$LN'][0]")|$(curl -s -b $M "$B/api/audit-log?action=added-load" | jq "d['entries'][0]['target']=='$LN', d['entries'][0]['details']['poNumber']")" "('assigned', 'Leonardo', 'Truck #12')|True E44-1"
chk "   the same guards as the New PO form: a truck on another driver's open load is a conflict; an unknown driver or a missing material is refused" "$(mg POST /api/pos/$P/loads '{"truckId":"carlos","truckUnitId":"truck-12","material":"Dirt","loadsAssigned":1}' | jq "d['code'], d['conflicts'][0]['type']")|$(mg POST /api/pos/$P/loads '{"truckId":"nobody","material":"Dirt","loadsAssigned":1}' -o /dev/null -w '%{http_code}')|$(mg POST /api/pos/$P/loads '{"truckId":"carlos","loadsAssigned":1}' -o /dev/null -w '%{http_code}')" "assignment_conflict truck-busy|400|400"
chk "   a completed order that gets new work is open again" "$(mg POST /api/pos/$PF/loads '{"truckId":"carlos","truckUnitId":"truck-2b","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}' | jq "d['success'], d['po']['status']")" "True scheduled"
mg POST /api/_test/save-mode '{"mode":"fail"}' >/dev/null
N0=$(curl -s -b $M $B/api/data | jq "len(d['loads'])")
chk "   when the database refuses the write, nothing is added and the dispatcher is told so" "$(mg POST /api/pos/$P/loads '{"truckId":"matthew","truckUnitId":"truck-2","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}' -w ' %{http_code}' | code "d['error'].startswith('Unable to save'), 'Nothing was added' in d['error']")|$(curl -s -b $M $B/api/data | jq "len(d['loads'])==$N0")" "503 True True|True"
mg POST /api/_test/save-mode '{"mode":"ok"}' >/dev/null
chk "   the screen: Edit PO from the PO card and the load detail; a date change goes through the same conflict dialog; the rules are written down" "$(grep -cF "onclick=\"openEditPO('\${p.id}')\"" public/index.html)|$(grep -cF "openEditPO('\${l.poId}')" public/index.html)|$(grep -cF "postAssignment(\`/api/pos/\${p.id}\`, body, 'Move', reason, 'PUT')" public/index.html)|$(test -s PO-EDITING.md && grep -c '^| Delivery date' PO-EDITING.md)" "1|1|1|1"

echo
echo "── 45. Billing visibility: amounts, the state machine, guarded manual billing, unbill, unarchive ──"
pkill -f "^node server.js" >/dev/null 2>&1; sleep 1; rm -f data.json data-ids.json telemetry.json
(VBT_TEST_HOOKS=1 node server.js > /tmp/vbt-test-billing.log 2>&1 &)
for i in $(seq 1 20); do sleep 1; curl -sf $B/healthz >/dev/null 2>&1 && break; done
J='Content-Type: application/json'; TODAY=$(date +%F)
jq() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
curl -s -c $M -X POST -d "username=joshua&password=joshua123" $B/login -o /dev/null
BE=$(mktemp); curl -s -c $BE -X POST -d "username=beryle&password=beryle123" $B/login -o /dev/null
MA=$(mktemp); curl -s -c $MA -X POST -d "username=matthew&password=matthew123" $B/login -o /dev/null
RG=$(mktemp); curl -s -c $RG -X POST -d "username=rigo&password=rigo123" $B/login -o /dev/null
mg()  { curl -s -b $M -H "$J" -X "$1" "$B$2" -d "${3:-"{}"}" "${@:4}"; }
mgc() { curl -s -b $M -H "$J" -X "$1" "$B$2" -d "${3:-"{}"}" -o /dev/null -w '%{http_code}'; }
dr()  { curl -s -b "$1" -H "$J" -X POST $B/api/loads/$2/trip-action -d "$3"; }
load() { curl -s -b $M $B/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);l=[x for x in d['loads'] if x['id']=='$1'][0];print($2)"; }
loadof() { curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$1' and (l['truckId'] or '')=='${2:-}'][0]"; }
rtb() { curl -s -b $M "$B/api/ready-to-bill" | jq "$1"; }
haul() { dr $1 $2 '{"action":"start-trip"}' >/dev/null; dr $1 $2 "{\"action\":\"arrived-pickup\",\"yardId\":\"$3\"}" >/dev/null
  dr $1 $2 "{\"action\":\"loaded\",\"ticket\":${4:-$(tkt)}}" >/dev/null; dr $1 $2 '{"action":"arrived-jobsite"}' >/dev/null; dr $1 $2 '{"action":"trip-complete"}' >/dev/null; }
submit() { curl -s -b $1 -H "$J" -X PUT $B/api/loads/$2 -d "{\"ticketImage\":\"$PNG\",\"pod\":{\"signedBy\":\"Site Foreman\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null; dr $1 $2 '{"action":"delivered"}' >/dev/null; }
mg POST /api/_test/qb-fake '{"mode":"ok"}' -o /dev/null
mg POST /api/customers '{"name":"Actual Co","billingBasis":"actual"}' >/dev/null
# Beryle: 3/4 Rock for Rate Co (planned basis → 25 t × $25). Matthew: Dirt for Actual Co with a VBT ticket that has no tons (not priceable).
# Rigo: Dirt for Rate Co, later billed through a QuickBooks batch.
P1=$(mg POST /api/pos '{"po":{"poNumber":"R45-1","customer":"Rate Co","deliveryDate":"'"$TODAY"'","plannedVendorId":"vulcan"},"splits":[{"truckId":"beryle","truckUnitId":"truck-2","material":"3/4 Rock","loadsAssigned":1,"vendorId":"vulcan"},{"truckId":"rigo","truckUnitId":"truck-14","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' | jq "d['po']['id']")
P2=$(mg POST /api/pos '{"po":{"poNumber":"R45-2","customer":"Actual Co","deliveryDate":"'"$TODAY"'","plannedVendorId":"vbt"},"splits":[{"truckId":"matthew","truckUnitId":"truck-4","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' | jq "d['po']['id']")
LB=$(loadof $P1 beryle); LR=$(loadof $P1 rigo); LM=$(loadof $P2 matthew)
haul $BE $LB vulcan; submit $BE $LB; mg POST /api/loads/$LB/approve >/dev/null
haul $RG $LR vbt;    submit $RG $LR; mg POST /api/loads/$LR/approve >/dev/null
haul $MA $LM vbt '{"source":"vbt","number":"V-45"}'; submit $MA $LM; mg POST /api/loads/$LM/approve '{"acknowledge":true}' >/dev/null
chk "45 Ready to Bill prices every load with the invoice engine, says why one cannot be priced, and totals the rest" "$(rtb "sorted((x['id'], x['priceable'], x['amount'], x['rateLabel'], x['basis']) for x in d['items']), d['totals']")" "[('$LB', True, 625, '\$25/ton', 'planned'), ('$LR', True, 625, '\$25/ton', 'planned'), ('$LM', False, None, '\$25/ton', 'actual')] {'count': 3, 'amount': 1250, 'priced': 2, 'unpriced': 1}"
chk "   …the reason is the one billing would give, and the approval gap rides along" "$(rtb "[(x['priceReason'].startswith('Actual Co is billed on actual ticket tons'), x.get('approvalWarnings')) for x in d['items'] if x['id']=='$LM'][0]")" "(True, ['Ticket: Actual Co is billed on actual tons and 1 ticket(s) have no tons'])"
# Manual billing records who and which outside invoice; unbill reverses it with a reason
chk "   Mark Billed (manual) records the outside invoice reference and who did it" "$(mg POST /api/loads/bill "{\"loadIds\":[\"$LB\"],\"reference\":\"INV-2041\"}" | jq "d['billed']")|$(load $LB "l['billStatus'], l['manualBillRef'], l['billedBy']")|$(curl -s -b $M "$B/api/audit-log?action=marked-billed" | jq "d['entries'][0]['details']['reference']")" "1|billed INV-2041 joshua|INV-2041"
chk "   unbill needs a reason; a load that is not billed cannot be unbilled" "$(mgc POST /api/loads/$LB/unbill '{}')|$(mgc POST /api/loads/$LR/unbill '{"reason":"x"}')" "400|400"
chk "   unbill puts a manually billed load back in Ready to Bill, with the reversal on the record and in the audit log" "$(mg POST /api/loads/$LB/unbill '{"reason":"paper invoice cancelled"}' | jq "d['success'], d['load']['billStatus'], d['load']['manualBillRef']")|$(load $LB "[(h['action'], h['reason'], h['reference']) for h in l['billHistory']]")|$(curl -s -b $M "$B/api/audit-log?action=unbilled-load" | jq "d['entries'][0]['target']=='$LB', d['entries'][0]['details']['reference']")|$(rtb "'$LB' in [x['id'] for x in d['items']]")" "True ready |[('unbilled', 'paper invoice cancelled', 'INV-2041')]|True INV-2041|True"
# A load billed through QuickBooks is released only by voiding the batch
BQ=$(mg POST /api/billing-batches "{\"loadIds\":[\"$LR\"]}" | jq "d['batches'][0]['id']")
mg POST /api/billing-batches/$BQ/send >/dev/null
chk "   a load billed through a QuickBooks batch cannot be unbilled (409 points at the batch) — the invoice and the load never disagree" "$(load $LR "l['billStatus'], l['qbInvoiceId']")|$(mg POST /api/loads/$LR/unbill '{"reason":"x"}' -w ' %{http_code}' | python3 -c "import sys,json;raw=sys.stdin.read().rstrip();b,c=raw.rsplit(' ',1);d=json.loads(b);print(c, d['code'], d['billingBatchId']=='$BQ')")|$(load $LR "l['billStatus']")" "billed INV-1|409 billed_by_batch True|billed"
# Archive, then bring it back
mg POST /api/loads/bill "{\"loadIds\":[\"$LB\"],\"reference\":\"INV-2041-B\"}" >/dev/null
AR=$(mg POST /api/history/archive | jq "d['archived']['batchId']")
chk "   archived: both billed loads and their fully billed PO leave the active lists" "$(curl -s -b $M $B/api/data | jq "sorted(l['id'] for l in d['loads']), [p['poNumber'] for p in d['pos']]")" "['$LM'] ['R45-2']"
chk "   unarchive needs a reason; an unknown batch is 404" "$(mgc POST /api/history/$AR/unarchive '{}')|$(mgc POST /api/history/BATCH-nope/unarchive '{"reason":"x"}')" "400|404"
mg POST /api/billing-batches/$BQ/void '{"reason":"customer dispute"}' >/dev/null      # releases Rigo's archived load while it sits in the archive
chk "   unarchive brings the batch back exactly as it was: the PO, the manual-billed load still billed, the released load in Ready to Bill again" "$(mg POST /api/history/$AR/unarchive '{"reason":"re-bill after the voided batch"}' | jq "d['success'], d['restored']")|$(curl -s -b $M $B/api/data | jq "sorted(l['id'] for l in d['loads']), sorted(p['poNumber'] for p in d['pos'])")|$(load $LR "l['billStatus'], repr(l['billingBatchId'])")|$(rtb "sorted(x['id'] for x in d['items'])")|$(curl -s -b $M $B/api/history | jq "len(d['archive'])")" "True {'pos': 1, 'loads': 2}|['$LB', '$LR', '$LM'] ['R45-1', 'R45-2']|ready ''|['$LR', '$LM']|0"
chk "   …audited with the reason; the released load can be billed again, once" "$(curl -s -b $M "$B/api/audit-log?action=unarchived-batch" | jq "d['entries'][0]['target']=='$AR', d['entries'][0]['details']['reason'], d['entries'][0]['details']['loadCount']")|$(mg POST /api/loads/bill "{\"loadIds\":[\"$LR\"],\"reference\":\"INV-9\"}" | jq "d['billed']")|$(mgc POST /api/loads/bill "{\"loadIds\":[\"$LR\"]}")|$(mg POST /api/loads/bill "{\"loadIds\":[\"$LR\"]}" | jq "d['billed']")" "True re-bill after the voided batch 2|1|200|0"
chk "   the screen: the state machine strip on Billing and History; manual billing, unbill, unarchive and archive all ask in the app, never with confirm()" "$(grep -c 'billingFlowHtml(' public/index.html)|$(sed -n '/^async function markBilled/,/^\/\/ ── PREVIEW + SEND TO QB/p' public/index.html | grep -c '[^a-zA-Z]confirm(')|$(sed -n '/^async function archiveBilledLoads/,/^\/\/ ── DRIVERS & TRUCKS/p' public/index.html | grep -c '[^a-zA-Z]confirm(\|prompt(')|$(sed -n '/^async function archiveBilledLoads/,/^\/\/ ── DRIVERS & TRUCKS/p' public/index.html | grep -c "required: true")" "3|0|0|2"

echo
echo "── 46. A failed save leaves nothing behind: the store rolls back to what is on disk, one write at a time ──"
pkill -f "^node server.js" >/dev/null 2>&1; sleep 1; rm -f data.json data-ids.json telemetry.json
(VBT_TEST_HOOKS=1 node server.js > /tmp/vbt-test-rollback.log 2>&1 &)
for i in $(seq 1 20); do sleep 1; curl -sf $B/healthz >/dev/null 2>&1 && break; done
J='Content-Type: application/json'; TODAY=$(date +%F); TOMORROW=$(date -d '+1 day' +%F)
jq() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
curl -s -c $M -X POST -d "username=joshua&password=joshua123" $B/login -o /dev/null
BE=$(mktemp); curl -s -c $BE -X POST -d "username=beryle&password=beryle123" $B/login -o /dev/null
MA=$(mktemp); curl -s -c $MA -X POST -d "username=matthew&password=matthew123" $B/login -o /dev/null
mg()  { curl -s -b $M -H "$J" -X "$1" "$B$2" -d "${3:-"{}"}" "${@:4}"; }
mgc() { curl -s -b $M -H "$J" -X "$1" "$B$2" -d "${3:-"{}"}" -o /dev/null -w '%{http_code}'; }
dr()  { curl -s -b "$1" -H "$J" -X POST $B/api/loads/$2/trip-action -d "$3"; }
drc() { curl -s -b "$1" -H "$J" -X POST $B/api/loads/$2/trip-action -d "$3" -o /dev/null -w '%{http_code}'; }
tod() { curl -s -b $M "$B/api/today${2:-}" | jq "$1"; }
load() { curl -s -b $M $B/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);l=[x for x in d['loads'] if x['id']=='$1'][0];print($2)"; }
po()   { curl -s -b $M $B/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);p=[x for x in d['pos'] if x['id']=='$1'][0];print($2)"; }
loadof() { curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$1' and (l['truckId'] or '')=='${2:-}'][0]"; }
haul() { dr $1 $2 '{"action":"start-trip"}' >/dev/null; dr $1 $2 "{\"action\":\"arrived-pickup\",\"yardId\":\"$3\"}" >/dev/null
  dr $1 $2 "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null; dr $1 $2 '{"action":"arrived-jobsite"}' >/dev/null; dr $1 $2 '{"action":"trip-complete"}' >/dev/null; }
submit() { curl -s -b $1 -H "$J" -X PUT $B/api/loads/$2 -d "{\"pod\":{\"signedBy\":\"Site Foreman\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null; dr $1 $2 '{"action":"delivered"}' >/dev/null; }
P=$(mg POST /api/pos '{"po":{"poNumber":"RB-1","customer":"Rollback Co","deliveryDate":"'"$TODAY"'","plannedVendorId":"vbt"},"splits":[{"truckId":"beryle","truckUnitId":"truck-2","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"},{"truckId":"matthew","truckUnitId":"truck-4","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' | jq "d['po']['id']")
LB=$(loadof $P beryle); LM=$(loadof $P matthew)
haul $MA $LM vbt; submit $MA $LM
R0=$(curl -s $B/healthz | jq "d['persistence']['rollbacks']")
mg POST /api/_test/save-mode '{"mode":"fail"}' >/dev/null
chk "46 a driver tap that cannot be saved is refused (503) and leaves no trace: no trip in memory, the board still says assigned" "$(drc $BE $LB '{"action":"start-trip"}')|$(load $LB "len(l['trips']), l['status']")|$(tod "[x['state'] for x in d['drivers'] if x['id']=='beryle'][0], [l['bucket'] for l in d['loads'] if l['id']=='$LB'][0]")" "503|0 active|assigned assigned"
chk "   …and the phone is told plainly" "$(dr $BE $LB '{"action":"start-trip"}' | jq "d['error'].startswith('Unable to save'), 'was not applied' in d['error'], d['reason']")" "True True database_unreachable"
chk "   an assignment that cannot be saved changes nothing" "$(mgc POST /api/loads/$LB/assign '{"driverId":"leonardo","truckUnitId":"truck-12"}')|$(load $LB "l['truckId'], l['truckUnitId'], l['driverName']")" "503|beryle truck-2 Beryle"
chk "   an approval that cannot be saved leaves the load submitted" "$(mgc POST /api/loads/$LM/approve)|$(load $LM "l['approvalStatus'], l['billStatus']")|$(tod "d['attention']['awaitingApproval']")" "503|submitted not-ready|1"
chk "   a PO edit that cannot be saved changes nothing, on the PO or its loads" "$(mgc PUT /api/pos/$P "{\"deliveryDate\":\"$TOMORROW\",\"notes\":\"x\"}")|$(po $P "p['deliveryDate']=='$TODAY', repr(p['notes'])")|$(load $LB "l['deliveryDate']=='$TODAY', l.get('moveHistory')")" "503|True ''|True None"
chk "   a driver's day that cannot be saved is not open" "$(curl -s -b $BE -H "$J" -X POST $B/api/shifts/start -d '{"truckId":"truck-2","odometer":70000,"inspection":{"satisfactory":true},"signature":"'"$PNG"'"}' -o /dev/null -w '%{http_code}')|$(tod "[x['dayStartedAt'] for x in d['drivers'] if x['id']=='beryle'][0], len(d['shifts'])")" "503|None 0"
chk "   /healthz counts every rollback and says the last save failed" "$(curl -s $B/healthz | jq "d['persistence']['rollbacks'] - $R0, d['persistence']['lastSaveOk'], d['persistence']['lastRollbackAt'] != ''")" "6 False True"
mg POST /api/_test/save-mode '{"mode":"ok"}' >/dev/null
chk "   the same tap goes through once the database is back, and is on disk" "$(drc $BE $LB '{"action":"start-trip"}')|$(load $LB "len(l['trips'])")|$(python3 -c "import json;d=json.load(open('data.json'));print(len([l for l in d['loads'] if l['id']=='$LB'][0]['trips']))")" "200|1|1"
# One write at a time: a failed write cannot sweep a concurrent good write away
mg POST /api/_test/save-mode '{"mode":"fail","count":1}' >/dev/null
rm -f /tmp/vbt-46-a /tmp/vbt-46-b
mgc PUT /api/loads/$LB '{"notes":"note A"}' > /tmp/vbt-46-a & mgc PUT /api/loads/$LB '{"notes":"note B"}' > /tmp/vbt-46-b & wait
chk "   two writes at once while one save fails: exactly one is refused; the other is what memory AND disk hold" "$(python3 - "$(cat /tmp/vbt-46-a)" "$(cat /tmp/vbt-46-b)" "$(load $LB "l['notes']")" "$LB" <<'PY'
import sys,json
a,b,mem,lid=sys.argv[1:5]
disk=[l['notes'] for l in json.load(open('data.json'))['loads'] if l['id']==lid][0]
winner='note A' if a=='200' else 'note B'
print(sorted([a,b]), mem==winner, disk==mem)
PY
)" "['200', '503'] True True"
chk "   the hook reset itself after one failure: the next save is fine" "$(mgc PUT /api/loads/$LB '{"notes":"note C"}')|$(load $LB "l['notes']")" "200|note C"
# Persistence #1 (I26) — the lock protects the save, not the socket. A phone that drops the connection
# mid-save must not let the next write interleave with a save that then fails and rolls the store back.
# Before the fix: the dropped request released the lock on 'close', the next write entered, the
# first save failed, the rollback swept the second change away — and the second request said 200.
mg POST /api/_test/save-mode '{"mode":"fail","count":1,"delayMs":1500}' >/dev/null     # every save waits 1.5 s; the next one fails
DROPPED=$(curl -s -b $M -H "$J" -X PUT $B/api/loads/$LB -d '{"notes":"dropped mid-save"}' --max-time 0.5 -o /dev/null -w '%{http_code}')
NEXT=$(curl -s -b $M -H "$J" -X PUT $B/api/loads/$LB -d '{"notes":"note D"}' -w ' %{http_code} %{time_total}')
mg POST /api/_test/save-mode '{"mode":"ok"}' >/dev/null
chk "   a client that drops mid-save (curl gave up: 000) does not release the lock: the next write waits for that save to settle and roll back, then lands in memory AND on disk, and its own answer carries it" "$DROPPED|$(python3 - "$NEXT" "$(load $LB "l['notes']")" "$LB" <<'PY'
import sys,json
raw=sys.argv[1]; mem=sys.argv[2]; lid=sys.argv[3]
body,code,secs=raw.rsplit(' ',2); d=json.loads(body)
disk=[l['notes'] for l in json.load(open('data.json'))['loads'] if l['id']==lid][0]
print(code, float(secs) >= 1.0, d.get('success'), d['load']['notes'], mem, disk)
PY
)" "000|200 True True note D note D note D"
chk "   …exactly one rollback (the dropped write's); the lock is released by the handler ending its response, never by the socket closing" "$(curl -s $B/healthz | jq "d['persistence']['rollbacks'] - $R0")|$(grep -c "res.once('close', () => { clearTimeout(timer); release(); })" server.js)|$(grep -c "res.end = function (...args) { const r = end.apply(this, args); done(); return r; };" server.js)" "8|0|1"
chk "   mutating requests run one at a time; QuickBooks send/retry/void, GPS pings and test hooks are exempt and keep their in-flight state (their recovery record)" "$(grep -c "^const WRITE_LOCK_EXEMPT = /^\\\\/api\\\\/(billing-batches" server.js)|$(grep -c "requestCtx.run({ keepOnFailure: true }, next)" server.js)|$(grep -c "requestCtx.run({ keepOnFailure: false }, next)" server.js)|$(grep -c "rollbackStore(e);" server.js)" "1|1|1|3"

echo
echo "── 47. Linxup telemetry (L1): positions in by webhook, trucks linked by id, VBT stays the operational truth ──"
chk "47 without LINXUP_WEBHOOK_TOKEN the webhook path does not exist (404)" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/linxup/position -H "$J" -d '{}')" "404"
pkill -f "^node server.js" >/dev/null 2>&1; sleep 1; rm -f data.json data-ids.json telemetry.json
(VBT_TEST_HOOKS=1 LINXUP_WEBHOOK_TOKEN=test-token LINXUP_COMPANY_ID=1 node server.js > /tmp/vbt-test-linxup.log 2>&1 &)
for i in $(seq 1 20); do sleep 1; curl -sf $B/healthz >/dev/null 2>&1 && break; done
J='Content-Type: application/json'; TODAY=$(date +%F)
jq() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
curl -s -c $M -X POST -d "username=joshua&password=joshua123" $B/login -o /dev/null
RG=$(mktemp); curl -s -c $RG -X POST -d "username=rigo&password=rigo123" $B/login -o /dev/null
mg()  { curl -s -b $M -H "$J" -X "$1" "$B$2" -d "${3:-"{}"}" "${@:4}"; }
mgc() { curl -s -b $M -H "$J" -X "$1" "$B$2" -d "${3:-"{}"}" -o /dev/null -w '%{http_code}'; }
lx()  { curl -s -H "Authorization: Bearer test-token" -H "$J" -X POST "$B/api/linxup/$1" -d "$2" "${@:3}"; }
lxc() { curl -s -H "Authorization: Bearer test-token" -H "$J" -X POST "$B/api/linxup/$1" -d "$2" -o /dev/null -w '%{http_code}'; }
tod() { curl -s -b $M "$B/api/today" | jq "$1"; }
tel() { curl -s -b $M "$B/api/today" | python3 -c "import json,sys;d=json.load(sys.stdin);t=[x for x in d['trucks'] if x['id']=='$1'][0];x=t['telematics'];print($2)"; }
trk() { curl -s -b $M "$B/api/linxup/trackers" | python3 -c "import json,sys;d=json.load(sys.stdin);t=[x for x in d['trackers'] if x['trackerId']==$1];t=t[0] if t else None;print($2)"; }
load() { curl -s -b $M $B/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);l=[x for x in d['loads'] if x['id']=='$1'][0];print($2)"; }
loadof() { curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$1' and (l['truckId'] or '')=='${2:-}'][0]"; }
ms() { echo $(( $(date +%s) * 1000 - ${1:-0} * 1000 )); }   # now minus N seconds, in epoch ms
pos() { # trackerId date lat lng [extra json fields]
  echo "{\"date\":$2,\"latitude\":$3,\"longitude\":$4,\"tracker\":{\"trackerId\":$1,\"name\":\"VBT #$1\",\"deviceNumber\":\"IMEI-$1\",\"deviceSerialNumber\":\"SN-$1\"},\"company\":{\"companyId\":1,\"name\":\"Valley Best\"},\"fleet\":{\"fleetId\":3,\"name\":\"No Group\"},\"asset\":{\"vin\":\"VIN$1\",\"make\":\"Peterbilt\",\"model\":\"567\",\"year\":2026}${5:+,$5}}"; }
FULL='"altitude":91.5,"speed":8,"heading":"S","direction":180,"odometer":55959,"battery":"13.70","fuelLevel":"62%","accuracy":"good","signal":"strong","estimatedSpeedLimit":45,"speeding":false,"behaviourCode":"NORMAL","editDate":1790700000000,"engineOn":true,"batchedPositions":"1790699940000,36.70,-119.70,0.0","sensorData":[],"address":{"street":"7238 Landing Cove St","city":"Bakersfield","stateCode":"CA","postalCode":"93313","countryCode":"US"},"person":{"personId":77,"name":"Jesus Guzman"}'
T0=$(ms 5)
# ── The gate ──
chk "   no token → 401; wrong token → 401; nothing is counted as received" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/linxup/position -H "$J" -d "$(pos 501 $T0 36.7 -119.7)")|$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/linxup/position -H "Authorization: Bearer nope" -H "$J" -d "$(pos 501 $T0 36.7 -119.7)")|$(curl -s -b $M $B/api/linxup/health | jq "d['counters']['received'], d['counters']['unauthorized']")" "401|401|0 2"
chk "   the token is accepted from Authorization or Authentication, with or without 'Bearer'" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/linxup/position -H "Authentication: Bearer test-token" -H "$J" -d "$(pos 509 $T0 36.7 -119.7)")|$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/linxup/position -H "Authorization: test-token" -H "$J" -d "$(pos 509 $(ms 4) 36.7 -119.7)")" "200|200"
chk "   another company's message is refused (403) and stored nowhere" "$(lx position "{\"date\":$T0,\"latitude\":36.7,\"longitude\":-119.7,\"tracker\":{\"trackerId\":599},\"company\":{\"companyId\":9}}" -w ' %{http_code}' | python3 -c "import sys,json;raw=sys.stdin.read().rstrip();b,c=raw.rsplit(' ',1);print(c, json.loads(b)['error'])")|$(trk 599 "t")" "403 Message is not for this account|None"
chk "   malformed payloads are 400, never stored: empty array, bad date, latitude out of range, no tracker" "$(lxc position '[]')|$(lxc position "{\"date\":\"yesterday\",\"latitude\":36.7,\"longitude\":-119.7,\"tracker\":{\"trackerId\":598},\"company\":{\"companyId\":1}}")|$(lxc position "{\"date\":$T0,\"latitude\":999,\"longitude\":-119.7,\"tracker\":{\"trackerId\":598},\"company\":{\"companyId\":1}}")|$(lxc position "{\"date\":$T0,\"latitude\":36.7,\"longitude\":-119.7,\"company\":{\"companyId\":1}}")|$(trk 598 "t")" "400|400|400|400|None"
# ── Positions in ──
R=$(lx position "$(pos 501 $T0 36.7 -119.7 "$FULL")")
chk "   a Position is stored with every field the message carries (nothing useful thrown away)" "$(echo "$R" | jq "d['stored'], d['duplicates']")|$(trk 501 "t['name'], t['deviceNumber'], t['deviceSerialNumber'], t['vin'], t['make'], t['year'], t['fleetId'], t['personId'], t['personName'], t['active']")|$(trk 501 "(lambda p: (p['speed'], p['heading'], p['direction'], p['odometer'], p['battery'], p['fuelLevel'], p['accuracy'], p['signal'], p['estSpeedLimit'], p['speeding'], p['behaviorCode'], p['engineOn'], p['altitude'], p['addressLine'], p['address']['countryCode'], p['batched'][:13], p['editAt'][:4]))(t['latest'])")" "1 0|VBT #501 IMEI-501 SN-501 VIN501 Peterbilt 2026 3 77 Jesus Guzman True|(8, 'S', 180, 55959, '13.70', '62%', 'good', 'strong', 45, False, 'NORMAL', True, 91.5, '7238 Landing Cove St, Bakersfield, CA 93313', 'US', '1790699940000', '2026')"
chk "   the same message again is a duplicate: answered 200, stored once" "$(lx position "$(pos 501 $T0 36.7 -119.7 "$FULL")" | jq "d['stored'], d['duplicates']")|$(curl -s -b $M $B/api/linxup/health | jq "d['counters']['stored'], d['counters']['duplicates']")" "0 1|3 1"
chk "   an older fix arriving late is kept as history but never moves the truck backwards" "$(lx position "$(pos 501 $(ms 120) 36.0 -119.0 '"speed":40')" | jq "d['stored']")|$(trk 501 "t['latest']['lat'], t['latest']['speed']")" "1|36.7 8"
chk "   two positions in one payload are two positions" "$(lx position "[$(pos 502 $(ms 3) 36.8 -119.8 '"speed":0,"engineOn":true'), $(pos 502 $(ms 2) 36.81 -119.81 '"speed":0,"engineOn":true')]" | jq "d['received'], d['stored']")" "2 2"
chk "   an unknown tracker is mirrored and listed as unlinked; no VBT truck shows it" "$(trk 502 "t['linkedTruckId'], t['latestAt'] is not None")|$(tod "sorted(set(t['telematics']['state'] for t in d['trucks'])), d['linxup']['linkedTrucks']")" "None True|['not-linked'] 0"
# ── Linking, by id ──
chk "   link Truck #2 → tracker 501: the tracker's IMEI and VIN are remembered for later verification" "$(mg PUT /api/fleet/trucks/truck-2/linxup '{"trackerId":501}' | jq "d['success'], d['truck']['linxup']['trackerId'], d['truck']['linxup']['deviceNumber'], d['truck']['linxup']['vin'], d['truck']['linxup']['seen']")|$(curl -s -b $M "$B/api/audit-log?action=linked-tracker" | jq "d['entries'][0]['target']")" "True 501 IMEI-501 VIN501 True|truck-2"
chk "   one tracker links to one truck (409); a non-numeric id is refused (400); the picker shows who has it" "$(mgc PUT /api/fleet/trucks/truck-4/linxup '{"trackerId":501}')|$(mgc PUT /api/fleet/trucks/truck-4/linxup '{"trackerId":"abc"}')|$(trk 501 "t['linkedTruckId'], t['linkedTruckNum']")" "409|400|truck-2 Truck #2"
# ── On the board, beside VBT's own state ──
P=$(mg POST /api/pos '{"po":{"poNumber":"LX-1","customer":"Linx Co","deliveryDate":"'"$TODAY"'","address":"9 Gate Rd","city":"Fresno","plannedVendorId":"vulcan"},"splits":[{"truckId":"beryle","truckUnitId":"truck-2","material":"Dirt","loadsAssigned":1,"vendorId":"vulcan"}]}' | jq "d['po']['id']"); LB=$(loadof $P beryle)
chk "   Truck #2 on the board: VBT says assigned, Linxup says Moving 8 mph S, engine on, odometer, address, seconds ago" "$(tel truck-2 "t['state'], x['state'], x['label'], x['speed'], x['heading'], x['engineOn'], x['odometer'], x['address'], x['ageSeconds'] < 120, x['source'], x['trackerName']")" "assigned moving Moving 8 S True 55959 7238 Landing Cove St, Bakersfield, CA 93313 True linxup VBT #501"
chk "   …the driver row and the load card carry the same line; VBT's bucket is untouched" "$(tod "[(x['telematics']['label'], x['truckNum']) for x in d['drivers'] if x['id']=='beryle'][0], [(l['bucket'], l['telematics']['state']) for l in d['loads'] if l['id']=='$LB'][0]")" "('Moving', 'Truck #2') ('assigned', 'moving')"
chk "   Linxup's driver is shown as information (unmapped → no flag)" "$(tel truck-2 "x['linxupDriver']['name'], x['linxupDriver']['vbtDriverId'], x['driverMismatch']")|$(tod "d['attention']['telemetry']")" "Jesus Guzman None False|0"
mg PUT /api/drivers/rigo '{"linxupPersonId":77}' >/dev/null
chk "   once that person is mapped to Rigo, the disagreement is an attention item — and VBT's assignment is NOT changed" "$(tel truck-2 "x['linxupDriver']['vbtDriverName'], x['driverMismatch']")|$(tod "d['attention']['telemetry'], d['telemetryIssues'][0]['kind'], d['telemetryIssues'][0]['text']")|$(load $LB "l['truckId'], l['driverName']")" "Rigo True|1 driver-mismatch Linxup reports Jesus Guzman in Truck #2, but VBT has Beryle assigned.|beryle Beryle"
# ── The telemetry states, one rule ──
mg PUT /api/fleet/trucks/truck-4/linxup '{"trackerId":503}' >/dev/null
lx position "$(pos 503 $(ms 60) 36.90 -119.90 '"speed":0,"engineOn":true')" >/dev/null
chk "   engine on, not moving → Idling" "$(tel truck-4 "x['state'], x['label']")" "idling Idling"
lx position "$(pos 503 $(ms 50) 36.90 -119.90 '"speed":0,"engineOn":false')" >/dev/null
chk "   engine off → Stopped" "$(tel truck-4 "x['state']")" "stopped"
lx position "$(pos 503 $(ms 40) 36.90 -119.90 '"speed":0,"engineOn":true,"geofence":{"geofenceId":9,"name":"Fowler Yard","fenceGroup":"Yards"}')" >/dev/null
chk "   inside a Linxup geofence → At <fence>" "$(tel truck-4 "x['state'], x['label'], x['placeSource']")" "at-place At Fowler Yard linxup"
mg PUT /api/vendors/vulcan/location '{"lat":36.95,"lng":-119.95}' >/dev/null
lx position "$(pos 503 $(ms 30) 36.9505 -119.9505 '"speed":2,"engineOn":true')" >/dev/null
chk "   within a VBT yard pin (no Linxup fence) → At <vendor>, from VBT's own coordinates" "$(tel truck-4 "x['state'], x['label'], x['placeSource'], x['placeKind']")" "at-place At Vulcan vbt vendor"
mg PUT /api/pos/$P/location '{"lat":36.97,"lng":-119.97}' >/dev/null
lx position "$(pos 503 $(ms 20) 36.9702 -119.9702 '"speed":0,"engineOn":true')" >/dev/null
chk "   within a jobsite pin of a load on the board → At <customer · city>" "$(tel truck-4 "x['state'], x['label'], x['placeKind']")" "at-place At Linx Co · Fresno jobsite"
lx position "$(pos 503 $(ms 10) 36.99 -119.99 '"speed":38,"engineOn":true')" >/dev/null
chk "   moving again → Moving (speed wins over a nearby place)" "$(tel truck-4 "x['state']")" "moving"
mg PUT /api/fleet/trucks/truck-14/linxup '{"trackerId":504}' >/dev/null; lx position "$(pos 504 $(ms 900) 36.5 -119.5 '"speed":30,"engineOn":true')" >/dev/null
chk "   engine on and quiet for 15 min → Stale" "$(tel truck-14 "x['state'], x['ageSeconds'] >= 900")" "stale True"
mg PUT /api/fleet/trucks/truck-12/linxup '{"trackerId":505}' >/dev/null; lx position "$(pos 505 $(ms 108000) 36.5 -119.5 '"speed":0,"engineOn":true')" >/dev/null
chk "   silent for 30 h → Offline" "$(tel truck-12 "x['state'], x['label']")" "offline Offline"
mg PUT /api/fleet/trucks/truck-2b/linxup '{"trackerId":506}' >/dev/null; lx position "$(pos 506 $(ms 900) 36.5 -119.5 '"speed":0,"engineOn":false')" >/dev/null
chk "   engine off and quiet for 15 min → Stopped, not stale (a parked truck may not report)" "$(tel truck-2b "x['state']")" "stopped"
chk "   a stale or offline truck that is on a load is an attention item; a parked free truck is not" "$(tod "sorted(i['kind'] for i in d['telemetryIssues'])")" "['driver-mismatch']"
# ── Device Update / Device Status: nothing breaks, nothing is trusted blindly ──
lx device-update '{"tracker":{"trackerId":501,"name":"VBT #2 (renamed)","deviceNumber":"IMEI-501","deviceSerialNumber":"SN-501"},"company":{"companyId":1},"fleet":{"fleetId":4,"name":"Dump"},"asset":{"vin":"VIN501","make":"Peterbilt","model":"567","year":2026}}' >/dev/null
chk "   a rename changes the label only; the link and the driver flag stand (a Device Update without a person clears Linxup's driver)" "$(trk 501 "t['name'], t['fleetName'], t['personId']")|$(tel truck-2 "x['trackerName'], x['trackerMismatch'], x['linxupDriver'], x['driverMismatch']")" "VBT #2 (renamed) Dump None|VBT #2 (renamed) None None False"
lx device-update '{"tracker":{"trackerId":501,"name":"VBT #2 (renamed)","deviceNumber":"IMEI-501","deviceSerialNumber":"SN-501"},"company":{"companyId":1},"person":{"personId":77,"name":"Jesus Guzman"},"asset":{"vin":"VIN-OTHER","make":"Peterbilt","model":"567","year":2026}}' >/dev/null
chk "   the tracker now reports another VIN: flagged for the manager, the VBT truck is NOT changed" "$(tel truck-2 "x['trackerMismatch']")|$(tod "sorted(i['kind'] for i in d['telemetryIssues'] if i['truckId']=='truck-2')")|$(curl -s -b $M $B/api/data | jq "[t['linxup']['vin'] for t in d['fleet'] if t['id']=='truck-2'][0]")" "VIN now VIN-OTHER (linked as VIN501)|['driver-mismatch', 'tracker-mismatch']|VIN501"
lx device-update '{"tracker":{"trackerId":501,"name":"VBT #2","deviceNumber":"IMEI-501","deviceSerialNumber":"SN-501"},"company":{"companyId":1},"person":{"personId":77,"name":"Jesus Guzman"},"asset":{"vin":"VIN501","make":"Peterbilt","model":"567","year":2026}}' >/dev/null
lx device-status '{"statusChangeType":"INACTIVATE","tracker":{"trackerId":501,"name":"VBT #2"},"company":{"companyId":1}}' >/dev/null
chk "   a deactivated tracker: Offline / tracker inactive, since when; activation restores it" "$(tel truck-2 "x['state'], x['label'], x['inactiveSince'] is not None, x['trackerMismatch']")|$(lx device-status '{"statusChangeType":"ACTIVATE","tracker":{"trackerId":501,"name":"VBT #2"},"company":{"companyId":1}}' >/dev/null; tel truck-2 "x['state']")" "offline Tracker inactive True None|moving"
# ── Persistence failure: 503, nothing moved ──
mg POST /api/_test/save-mode '{"mode":"fail"}' >/dev/null
chk "   the telemetry store refuses the write → 503 with retry:true, and the truck did not move" "$(lx position "$(pos 501 $(ms 1) 35.0 -118.0 '"speed":50')" -w ' %{http_code}' | python3 -c "import sys,json;raw=sys.stdin.read().rstrip();b,c=raw.rsplit(' ',1);print(c, json.loads(b)['retry'])")|$(tel truck-2 "x['lat'], x['speed']")|$(curl -s -b $M $B/api/linxup/health | jq "d['counters']['failed']")" "503 True|36.7 8|1"
mg POST /api/_test/save-mode '{"mode":"ok"}' >/dev/null
chk "   …and the same delivery succeeds once the store is back" "$(lx position "$(pos 501 $(ms 1) 35.0 -118.0 '"speed":50')" | jq "d['stored']")|$(tel truck-2 "x['lat'], x['speed']")" "1|35 50"
# ── The map: source named, never merged ──
curl -s -b $RG -H "$J" -X POST $B/api/driver-location -d '{"lat":36.60,"lng":-119.60,"accuracy":9}' -o /dev/null
chk "   Fleet Map: Beryle's position comes from Linxup (Truck #2), Rigo's from his phone, and a linked truck with no driver is its own row" "$(curl -s -b $M $B/api/fleet/live | python3 -c "
import json,sys;d=json.load(sys.stdin);r={x['driverId']:x for x in d['trucks']}
print(r['beryle']['gps']['source'], r['beryle']['gps']['speed'], r['beryle']['telematics']['label'], '|', r['rigo']['gps']['source'], r['rigo']['gps']['accuracy'], '|', r['truck:truck-4']['truckNum'], r['truck:truck-4']['gps']['source'], r['truck:truck-4']['status'], r['truck:truck-4']['live'])")" "linxup 50 Moving | phone 9 | Truck #4 linxup Moving True"
# ── Other message types: kept or dropped, never guessed ──
chk "   a vehicle trip is stored (L2); alerts are accepted and kept raw for L3 (deferred); item tracking is dropped; an unknown type is 404" "$(lx trip '{"startDateTime":1790700000000,"endDateTime":1790703600000,"distanceMiles":13,"tracker":{"trackerId":501},"company":{"companyId":1}}' | jq "d['stored'], d['deferred']")|$(lx alert '{"alertType":"SPEEDING","date":1790700000000,"tracker":{"trackerId":501},"company":{"companyId":1}}' | jq "d['deferred']")|$(lx item-location '{"timestamp":1,"latitude":1,"longitude":1,"trackedItem":{"itemId":1},"company":{"id":1}}' | jq "d['dropped']")|$(lxc whatever '{}')|$(curl -s -b $M $B/api/linxup/health | jq "sorted(k for k in d['lastMessageAt'])")" "1 0|1|1|404|['alert', 'device-status', 'device-update', 'item-location', 'position', 'trip']"
chk "   the single-URL fallback classifies by shape (a stop is a stop); an unrecognizable body is 400" "$(lx event '{"stopType":"Idling","startDateTime":1790700000000,"endDateTime":1790700600000,"durationMinutes":10,"latitude":36.7,"longitude":-119.7,"tracker":{"trackerId":501},"company":{"companyId":1}}' | jq "d['type'], d['stored']")|$(lxc event '{"hello":"world","company":{"companyId":1}}')" "event 1|400"
# ── Retention ──
D40=$(( ( $(ms 3456000) / 300000 ) * 300000 + 10000 )); D400=$(ms 34560000)   # 10 s into a 5-minute bucket, so the three points share it
lx position "[$(pos 507 $D40 36.1 -119.1), $(pos 507 $((D40+60000)) 36.1 -119.1), $(pos 507 $((D40+120000)) 36.1 -119.1), $(pos 507 $D400 36.1 -119.1)]" >/dev/null
chk "   retention: raw for 30 days, one point per 5 minutes to a year, gone after" "$(mg POST /api/_test/linxup-prune | jq "d['dropped'], d['thinned']")" "1 2"
# ── Isolation ──
chk "   the receiver runs outside sessions and the write lock; linxup.js never touches the dispatch store" "$(grep -c "app.post('/api/linxup/:type', async (req, res)" server.js)|$(grep -cF 'linxup\/|quickbooks' server.js)|$(grep -v '^\s*//' linxup.js | grep -c 'store\.')|$(grep -c "telemetry.json" .gitignore)" "1|1|0|1"

echo
echo "── 48. Linxup telemetry (L2): geofence visits, stops, vehicle trips and usage hours as evidence beside VBT loads ──"
# One scenario, run here against the file-mode server and again in §21 against Postgres:
#   l2_suite <base-url> <tag> <restart-command>
l2_suite() {
  local B=$1 TAG=$2 RESTART=$3
  local J='Content-Type: application/json' TODAY=$(date +%F) NOW=$(date +%s)
  local M=$(mktemp) BE=$(mktemp)
  curl -s -c $M -X POST -d "username=joshua&password=joshua123" $B/login -o /dev/null
  curl -s -c $BE -X POST -d "username=beryle&password=beryle123" $B/login -o /dev/null
  jq()  { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
  mg()  { curl -s -b $M -H "$J" -X "$1" "$B$2" -d "${3:-"{}"}" "${@:4}"; }
  mgc() { curl -s -b $M -H "$J" -X "$1" "$B$2" -d "${3:-"{}"}" -o /dev/null -w '%{http_code}'; }
  lx()  { curl -s -H "Authorization: Bearer test-token" -H "$J" -X POST "$B/api/linxup/$1" -d "$2" "${@:3}"; }
  lxc() { curl -s -H "Authorization: Bearer test-token" -H "$J" -X POST "$B/api/linxup/$1" -d "$2" -o /dev/null -w '%{http_code}'; }
  dr()  { curl -s -b "$1" -H "$J" -X POST $B/api/loads/$2/trip-action -d "$3"; }
  tod() { curl -s -b $M "$B/api/today" | jq "$1"; }
  tel() { curl -s -b $M "$B/api/today" | python3 -c "import json,sys;d=json.load(sys.stdin);t=[x for x in d['trucks'] if x['id']=='$1'][0];x=t['telematics'];print($2)"; }
  trk() { curl -s -b $M "$B/api/linxup/trackers" | python3 -c "import json,sys;d=json.load(sys.stdin);t=[x for x in d['trackers'] if x['trackerId']==$1];t=t[0] if t else None;print($2)"; }
  load() { curl -s -b $M $B/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);l=[x for x in d['loads'] if x['id']=='$1'][0];print($2)"; }
  ev()  { curl -s -b $M "$B/api/loads/$1/telemetry" | python3 -c "import json,sys;d=json.load(sys.stdin);T=d['trips'];t=T[0] if T else None;t2=T[1] if len(T)>1 else None;print($2)"; }
  evc() { curl -s -b $M -o /dev/null -w '%{http_code}' "$B/api/loads/$1/telemetry"; }
  gf()  { curl -s -b $M "$B/api/linxup/geofences" | jq "$1"; }
  hl()  { curl -s -b $M "$B/api/linxup/health" | jq "$1"; }
  ms()  { echo $(( NOW * 1000 - ${1:-0} * 1000 )); }   # a fixed "now", so the same event is the same key however many seconds the suite takes
  fence() { # ENTER|EXIT trackerId fenceId "name" enterSecAgo [exitSecAgo] [extra json]
    local x="" nm=""; [ "$1" = EXIT ] && x=",\"exitDateTime\":$(ms $6),\"durationMinutes\":$(( ($5 - $6) / 60 ))"
    [ -n "$4" ] && nm=",\"name\":\"$4\",\"fenceGroup\":\"Yards\""
    echo "{\"eventType\":\"FENCE_$1\",\"enterDateTime\":$(ms $5)$x,\"tracker\":{\"trackerId\":$2,\"name\":\"VBT #$2\"},\"geofence\":{\"geofenceId\":$3$nm},\"company\":{\"companyId\":1}${7:+,$7}}"; }
  pos() { echo "{\"date\":$(ms $2),\"latitude\":$3,\"longitude\":$4,\"speed\":${5:-0},\"engineOn\":true,\"tracker\":{\"trackerId\":$1,\"name\":\"VBT #$1\"},\"asset\":{\"vin\":\"VIN$1\"},\"company\":{\"companyId\":1}${6:+,$6}}"; }
  STOP="{\"stopType\":\"Idling\",\"startDateTime\":$(ms 500),\"endDateTime\":$(ms 320),\"durationMinutes\":3,\"latitude\":36.9701,\"longitude\":-119.9701,\"tracker\":{\"trackerId\":701},\"company\":{\"companyId\":1},\"address\":{\"street\":\"9 Gate Rd\",\"city\":\"Fresno\",\"stateCode\":\"CA\"}}"
  VTRIP="{\"startDateTime\":$(ms 600),\"endDateTime\":$(ms 500),\"startLatitude\":36.95,\"startLongitude\":-119.95,\"endLatitude\":36.97,\"endLongitude\":-119.97,\"distanceMiles\":2.1,\"authorizedMiles\":2.1,\"unauthorizedMiles\":0,\"durationMinutes\":2,\"authorized\":true,\"startGeofence\":{\"geofenceId\":9,\"name\":\"Vulcan Materials Fresno\"},\"startAddress\":{\"street\":\"1 Quarry Rd\",\"city\":\"Fresno\",\"stateCode\":\"CA\"},\"endAddress\":{\"street\":\"9 Gate Rd\",\"city\":\"Fresno\",\"stateCode\":\"CA\"},\"tracker\":{\"trackerId\":701},\"company\":{\"companyId\":1}}"
  USAGE="{\"startDate\":$(ms 1000),\"endDate\":$(ms 220),\"engineOn\":true,\"durationMinutes\":13,\"startLatitude\":36.95,\"startLongitude\":-119.95,\"tracker\":{\"trackerId\":701},\"company\":{\"companyId\":1}}"
  # ── Fixture: Truck #2 ↔ tracker 701; Vulcan and CEMEX pinned; one PO for Linx Co with a pinned jobsite; Beryle on Truck #2, 2 loads from Vulcan ──
  mg PUT /api/fleet/trucks/truck-2/linxup '{"trackerId":701}' >/dev/null
  mg PUT /api/vendors/vulcan/location '{"lat":36.95,"lng":-119.95}' >/dev/null; mg PUT /api/vendors/cemex/location '{"lat":36.60,"lng":-119.60}' >/dev/null
  local P=$(mg POST /api/pos '{"po":{"poNumber":"LX-2","customer":"Linx Co","deliveryDate":"'"$TODAY"'","address":"9 Gate Rd","city":"Fresno","plannedVendorId":"vulcan"},"splits":[{"truckId":"beryle","truckUnitId":"truck-2","material":"Dirt","loadsAssigned":2,"vendorId":"vulcan"}]}' | jq "d['po']['id']")
  mg PUT /api/pos/$P/location '{"lat":36.97,"lng":-119.97}' >/dev/null
  local LB=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$P'][0]")
  chk "$TAG before any VBT trip: the load's telemetry says there is nothing to correlate yet (and says why)" "$(ev $LB "d['enabled'], d['linked'], d['truckNum'], len(T), d['note']")" "True True Truck #2 0 No VBT trip has started on this load yet; there is nothing to correlate."
  # ── Geofence events: enter, exit, duration; the fence is learned; the board shows the last visit ──
  chk "$TAG FENCE_ENTER is stored; the geofence is learned from the event and listed as unmapped (its name matches no VBT yard, so nothing is guessed)" "$(lx geofence-event "$(fence ENTER 701 9 'Vulcan Materials Fresno' 900 '' '"person":{"personId":88,"name":"Jesus Guzman"},"asset":{"vin":"VIN701"},"fleet":{"fleetId":3,"name":"No Group"}')" | jq "d['stored'], d['duplicates']")|$(gf "[(g['geofenceId'], g['name'], g['fenceGroup'], g['mappedVendorId'], g['suggestedVendorId']) for g in d['geofences']]")|$(tel truck-2 "x['lastFence']['name'], x['lastFence']['leftAt'], x['lastFence']['source']")" "1 0|[(9, 'Vulcan Materials Fresno', 'Yards', None, None)]|Vulcan Materials Fresno None Linxup geofence"
  chk "$TAG FENCE_EXIT completes the same visit (keyed by tracker · fence · enter time): left, 5 min inside" "$(lx geofence-event "$(fence EXIT 701 9 'Vulcan Materials Fresno' 900 600)" | jq "d['stored']")|$(tel truck-2 "x['lastFence']['leftAt'] is not None, x['lastFence']['minutes']")|$(hl "d['geofences']")" "1|True 5|1"
  chk "$TAG the same ENTER and the same EXIT again are duplicates: answered 200, nothing stored twice" "$(lx geofence-event "$(fence ENTER 701 9 'Vulcan Materials Fresno' 900)" | jq "d['stored'], d['duplicates']")|$(lx geofence-event "$(fence EXIT 701 9 'Vulcan Materials Fresno' 900 600)" | jq "d['stored'], d['duplicates']")" "0 1|0 1"
  chk "$TAG out of order: an EXIT that arrives before its ENTER is stored by event time; the late ENTER adds nothing and erases nothing" "$(lx geofence-event "$(fence EXIT 701 9 'Vulcan Materials Fresno' 420 300)" | jq "d['stored']")|$(lx geofence-event "$(fence ENTER 701 9 'Vulcan Materials Fresno' 420)" | jq "d['stored'], d['duplicates']")|$(tel truck-2 "x['lastFence']['leftAt'] is not None, x['lastFence']['minutes']")" "1|0 1|True 2"
  # ── Stops, vehicle trips, usage hours ──
  chk "$TAG a Stop is stored once (idle, 3 min, where, address); the same stop again is a duplicate" "$(lx stop "$STOP" | jq "d['stored']")|$(lx stop "$STOP" | jq "d['stored'], d['duplicates']")" "1|0 1"
  chk "$TAG a Linxup vehicle trip (ignition cycle — not a VBT trip) is stored with distance, authorized miles, start fence and end address" "$(lx trip "$VTRIP" | jq "d['stored']")|$(lx trip "$VTRIP" | jq "d['duplicates']")" "1|1"
  chk "$TAG a Usage Hours period is stored (engine on, 13 min); duplicate detected" "$(lx usage-hours "$USAGE" | jq "d['stored']")|$(lx usage-hours "$USAGE" | jq "d['duplicates']")" "1|1"
  chk "$TAG malformed: a fence event without enterDateTime, a stop without coordinates, a trip without a tracker — 400, nothing stored" "$(lxc geofence-event '{"eventType":"FENCE_ENTER","tracker":{"trackerId":701},"geofence":{"geofenceId":9},"company":{"companyId":1}}')|$(lxc stop "{\"stopType\":\"Idling\",\"startDateTime\":$(ms 100),\"tracker\":{\"trackerId\":701},\"company\":{\"companyId\":1}}")|$(lxc trip "{\"startDateTime\":$(ms 100),\"company\":{\"companyId\":1}}")" "400|400|400"
  # ── Unknown tracker, unknown geofence, unmapped VBT location ──
  chk "$TAG an unknown tracker's fence event is kept and the tracker mirrored as unlinked; no VBT truck shows it" "$(lx geofence-event "$(fence ENTER 799 9 'Vulcan Materials Fresno' 100)" | jq "d['stored']")|$(trk 799 "t['linkedTruckId'], t['name']")|$(tod "sorted(t['truckNum'] for t in d['trucks'] if t['telematics'] and t['telematics'].get('lastFence'))")" "1|None VBT #799|['Truck #2']"
  chk "$TAG an unknown geofence (id only, no name) is learned as such and mapped to nothing" "$(lx geofence-event "$(fence ENTER 701 55 '' 30)" | jq "d['stored']")|$(gf "[(g['geofenceId'], g['name'], g['mappedVendorId']) for g in d['geofences'] if g['geofenceId']==55]")" "1|[(55, None, None)]"
  lx geofence-event "$(fence ENTER 702 10 'VBT Yard' 3600)" >/dev/null; lx geofence-event "$(fence EXIT 702 10 'VBT Yard' 3600 3300)" >/dev/null
  chk "$TAG a fence whose name equals a VBT yard is only SUGGESTED for it — the mapping is the manager's to confirm" "$(gf "[(g['geofenceId'], g['mappedVendorId'], g['suggestedVendorId'], g['suggestedVendorName']) for g in d['geofences'] if g['geofenceId']==10]")" "[(10, None, 'vbt', 'VBT Yard')]"
  chk "$TAG mapping Vulcan → fence 9 is saved on the vendor and audited; an unknown fence is 400; a fence already mapped elsewhere is 409; Edit Vendor keeps the mapping" "$(mg PUT /api/vendors/vulcan/linxup-geofence '{"geofenceId":9}' | jq "d['success'], d['vendor']['linxupGeofenceId'], d['geofence']['name']")|$(mgc PUT /api/vendors/cemex/linxup-geofence '{"geofenceId":999}')|$(mgc PUT /api/vendors/cemex/linxup-geofence '{"geofenceId":9}')|$(curl -s -b $M "$B/api/audit-log?action=mapped-geofence" | jq "d['entries'][0]['target'], d['entries'][0]['details']['to']")|$(mg PUT /api/vendors/vulcan '{"location":"Fresno, CA"}' >/dev/null; gf "[(g['mappedVendorId'], g['mappedVendorName']) for g in d['geofences'] if g['geofenceId']==9]")" "True 9 Vulcan Materials Fresno|400|409|vulcan 9|[('vulcan', 'Vulcan')]"
  # ── The load: VBT's trip beside Linxup's record ──
  dr $BE $LB '{"action":"start-trip","gps":{"lat":36.74,"lng":-119.77}}' >/dev/null
  lx position "$(pos 701 400 36.9702 -119.9702 0)" >/dev/null   # one fix inside the jobsite pin
  local SNAP=$(load $LB "json.dumps(l, sort_keys=True)")
  chk "$TAG trip 1 — pickup evidence from the mapped geofence: two visits to Vulcan Materials Fresno, each with entered/left/minutes and its source" "$(ev $LB "t['tripNum'], t['truckNum'], t['linked'], t['pickup']['name'], t['pickup']['fence'], t['pickup']['evidence'], [(v['minutes'], v['leftAt'] is not None, v['source']) for v in t['pickup']['visits']]")" "1 Truck #2 True Vulcan {'geofenceId': 9, 'name': 'Vulcan Materials Fresno', 'confidence': 'mapped'} geofence [(5, True, 'Linxup geofence'), (2, True, 'Linxup geofence')]"
  chk "$TAG trip 1 — jobsite evidence is 'near jobsite based on GPS' from VBT's own pin, plus the idle stop there; VBT's Arrived-at-jobsite stamp stays empty" "$(ev $LB "t['jobsite']['evidence'], t['jobsite']['gps']['count'], t['jobsite']['gps']['source'], [(s['type'], s['minutes'], s['address'], s['source']) for s in t['jobsite']['stops']], t['vbt']['arrivedJobsite'], t['vbt']['source']")" "gps 1 Linxup GPS [('idle', 3, '9 Gate Rd, Fresno, CA', 'Linxup stop')] None VBT driver app"
  chk "$TAG trip 1 — vehicle activity: 1 Linxup vehicle trip (2.1 mi, from the fence to the address), 1 stop, 1 usage period (13 min, engine on); the id-only fence 55 visit shows as another visit" "$(ev $LB "[(v['miles'], v['authorizedMiles'], v['from'], v['to'], v['source']) for v in t['vehicleTrips']], len(t['stops']), [(u['minutes'], u['engineOn'], u['source']) for u in t['usage']], [v['name'] for v in t['otherVisits']]")" "[(2.1, 2.1, 'Vulcan Materials Fresno', '9 Gate Rd, Fresno, CA', 'Linxup vehicle trip')] 1 [(13, True, 'Linxup usage')] [None]"
  chk "$TAG the telemetry timeline is chronological, every entry names its source, and VBT's taps sit beside Linxup's record" "$(ev $LB "[e['at'] for e in d['timeline']]==sorted(e['at'] for e in d['timeline']), sorted(set(e['source'] for e in d['timeline'])), [e['text'] for e in d['timeline'] if e['kind']=='vbt']")" "True ['Linxup GPS', 'Linxup geofence', 'Linxup stop', 'Linxup usage', 'Linxup vehicle trip', 'VBT driver app'] ['Driver tapped Start trip']"
  chk "$TAG nothing in the VBT load moved: the record is byte-for-byte what it was before the evidence was read; no flags while VBT and Linxup agree" "$([ "$SNAP" = "$(load $LB "json.dumps(l, sort_keys=True)")" ] && echo same)|$(ev $LB "t['flags'], d['flags']")|$(tod "d['attention']['telemetry']")" "same|[] []|0"
  # ── Discrepancies: attention items, never verdicts ──
  mg PUT /api/drivers/rigo '{"linxupPersonId":88}' >/dev/null
  chk "$TAG driver mismatch: Linxup's person (mapped to Rigo) vs VBT's Beryle — flagged on the board and in the load's Current block; the assignment is untouched" "$(tod "[i['kind'] for i in d['telemetryIssues']]")|$(ev $LB "d['current']['linxupDriver']['name'], d['current']['linxupDriver']['vbtDriverName'], d['current']['driverMismatch']")|$(load $LB "l['truckId'], l['driverName']")" "['driver-mismatch']|Jesus Guzman Rigo True|beryle Beryle"
  dr $BE $LB '{"action":"arrived-pickup","yardId":"cemex"}' >/dev/null
  chk "$TAG pickup telemetry mismatch: the driver taps Arrived at CEMEX, Linxup never had Truck #2 near CEMEX in this trip — a flag on the load and the board; VBT's yard choice stands" "$(ev $LB "t['pickup']['name'], t['pickup']['evidence'], [(f['kind'], f['text'].startswith('Pickup telemetry mismatch — trip 1: the driver tapped Arrived at CEMEX')) for f in t['flags']]")|$(tod "sorted(i['kind'] for i in d['telemetryIssues'])")|$(load $LB "l['vendorId'], l['trips'][0].get('actualYardId')")" "CEMEX none [('pickup-mismatch', True)]|['driver-mismatch', 'pickup-mismatch']|vulcan cemex"
  lx position "$(pos 701 30 37.60 -120.60 55)" >/dev/null
  chk "$TAG location attention: a fresh fix 50+ mi from both the yard and the jobsite while the trip is open" "$(ev $LB "[(f['kind'], f['text']) for f in t['flags'] if f['kind']=='location-attention']")|$(tod "sorted(i['kind'] for i in d['telemetryIssues'])")" "[('location-attention', 'Location attention — Truck #2 is 56 mi from both CEMEX and the jobsite while trip 1 is open.')]|['driver-mismatch', 'location-attention', 'pickup-mismatch']"
  dr $BE $LB "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null; dr $BE $LB '{"action":"arrived-jobsite"}' >/dev/null; dr $BE $LB '{"action":"trip-complete"}' >/dev/null
  chk "$TAG trip 1 completed by the DRIVER (never by telemetry): the open-trip flags leave the board, the pickup mismatch stays on the record, GPS near the jobsite agrees with the tap" "$(load $LB "l['loadsDelivered'], sorted(l['trips'][0]['isoStamps'])")|$(tod "sorted(i['kind'] for i in d['telemetryIssues'])")|$(ev $LB "[f['kind'] for f in t['flags']], t['jobsite']['evidence'], t['vbt']['arrivedJobsite'] is not None")" "1 ['arrivedJobsite', 'arrivedPickup', 'completed', 'loadedAt', 'start']|['driver-mismatch']|['pickup-mismatch'] gps True"
  # ── Truck mismatch: evidence follows the truck each trip actually ran on ──
  mg POST /api/loads/$LB/assign '{"truckUnitId":"truck-4"}' >/dev/null
  dr $BE $LB '{"action":"start-trip"}' >/dev/null
  chk "$TAG trip 2 runs on Truck #4, which has no tracker: trip 2 says so; trip 1's evidence stays with Truck #2 (its Vulcan visits, now 'also in' since the driver named CEMEX)" "$(ev $LB "t2['tripNum'], t2['truckNum'], t2['linked'], t2['note'], t['truckNum'], len(t['otherVisits'])")" "2 Truck #4 False The truck this trip ran on is not linked to a Linxup tracker. Truck #2 3"
  lx position "$(pos 702 60 36.95 -119.95 0)" >/dev/null
  mg PUT /api/fleet/trucks/truck-4/linxup '{"trackerId":702}' >/dev/null
  lx geofence-event "$(fence ENTER 702 10 'VBT Yard' 60)" >/dev/null
  dr $BE $LB '{"action":"arrived-pickup","yardId":"vbt"}' >/dev/null
  chk "$TAG once Truck #4 is linked, trip 2 shows ITS tracker's visit to VBT Yard — matched by name only, and labelled so" "$(ev $LB "t2['linked'], t2['pickup']['name'], t2['pickup']['fence']['confidence'], t2['pickup']['evidence'], len(t2['pickup']['visits']), t2['pickup']['visits'][0]['leftAt']")" "True VBT Yard name geofence 1 None"
  lx device-update '{"tracker":{"trackerId":702,"name":"VBT #702"},"company":{"companyId":1},"asset":{"vin":"VIN-OTHER"}}' >/dev/null
  chk "$TAG tracker mismatch: tracker 702 now reports another VIN — flagged in the load's Current block and on the board; the VBT truck is not changed" "$(ev $LB "d['current']['trackerMismatch']")|$(tod "sorted(i['kind'] for i in d['telemetryIssues'] if i['truckId']=='truck-4')")|$(load $LB "l['truckUnitId']")" "VIN now VIN-OTHER (linked as VIN702)|['tracker-mismatch']|truck-4"
  # ── Telemetry that matches no load ──
  lx geofence-event "$(fence ENTER 701 9 'Vulcan Materials Fresno' 10800)" >/dev/null; lx geofence-event "$(fence EXIT 701 9 'Vulcan Materials Fresno' 10800 10200)" >/dev/null
  mg PUT /api/fleet/trucks/truck-14/linxup '{"trackerId":703}' >/dev/null; lx geofence-event "$(fence ENTER 703 9 'Vulcan Materials Fresno' 120)" >/dev/null
  chk "$TAG a visit three hours before the trip, and a visit by a truck with no load, are kept but attached to no load: trip 1 still has its three, the free truck shows its last fence only" "$(ev $LB "len(t['otherVisits'])")|$(tel truck-14 "t['state'], x['lastFence']['name']")|$(tod "sorted(i['kind'] for i in d['telemetryIssues'] if i['truckId']=='truck-14')")" "3|available Vulcan Materials Fresno|[]"
  # ── Back-to-back trips on ONE truck: each trip keeps its own record ──
  local RG=$(mktemp); curl -s -c $RG -X POST -d "username=rigo&password=rigo123" $B/login -o /dev/null
  mg PUT /api/fleet/trucks/truck-12/linxup '{"trackerId":704}' >/dev/null   # a truck with no telemetry yet, so the count is exact
  local P3=$(mg POST /api/pos '{"po":{"poNumber":"LX-3","customer":"Linx Co","deliveryDate":"'"$TODAY"'","address":"9 Gate Rd","city":"Fresno","plannedVendorId":"vulcan"},"splits":[{"truckId":"rigo","truckUnitId":"truck-12","material":"Sand","loadsAssigned":2,"vendorId":"vulcan"}]}' | jq "d['po']['id']")
  local LR=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$P3'][0]")
  dr $RG $LR '{"action":"start-trip"}' >/dev/null; dr $RG $LR '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null; dr $RG $LR "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null; dr $RG $LR '{"action":"arrived-jobsite"}' >/dev/null; dr $RG $LR '{"action":"trip-complete"}' >/dev/null
  dr $RG $LR '{"action":"start-trip"}' >/dev/null
  local T2=$(date +%s%3N)   # a fence visit right after trip 2 started, well inside trip 1's 30-minute tail
  lx geofence-event "{\"eventType\":\"FENCE_ENTER\",\"enterDateTime\":$T2,\"tracker\":{\"trackerId\":704},\"geofence\":{\"geofenceId\":9,\"name\":\"Vulcan Materials Fresno\"},\"company\":{\"companyId\":1}}" >/dev/null
  chk "$TAG back-to-back trips on Truck #12: a visit after trip 2 began belongs to trip 2 only — trip 1's window stops where trip 2 starts, so nothing is counted twice" "$(ev $LR "len(t['pickup']['visits']), len(t['otherVisits']), len(t2['pickup']['visits']), [e['tripNum'] for e in d['timeline'] if e['kind']=='fence-enter']")" "0 0 1 [2]"
  rm -f $RG
  # ── Completed, approved, archived: the evidence is still readable, the load never moves ──
  dr $BE $LB "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null; dr $BE $LB '{"action":"arrived-jobsite"}' >/dev/null; dr $BE $LB '{"action":"trip-complete"}' >/dev/null
  curl -s -b $BE -H "$J" -X PUT $B/api/loads/$LB -d "{\"ticketImage\":\"$PNG\",\"pod\":{\"signedBy\":\"Site Foreman\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null; dr $BE $LB '{"action":"delivered"}' >/dev/null
  mg POST /api/loads/$LB/approve '{"acknowledge":true}' >/dev/null
  chk "$TAG approved and locked by a person; telemetry arriving afterwards is stored and changes nothing on the load" "$(load $LB "l['approvalStatus'], l['locked'], l['loadsDelivered']")|$(lx geofence-event "$(fence ENTER 703 9 'Vulcan Materials Fresno' 5)" | jq "d['stored']")|$(load $LB "l['approvalStatus'], l['locked'], l['status']")|$(ev $LB "len(T), d['current']['state'], d['current']['label']")" "approved True 2|1|approved True completed|2 at-place At Vulcan"
  mg POST /api/loads/bill "{\"loadIds\":[\"$LB\"],\"reference\":\"INV-L2\"}" >/dev/null
  local AR=$(mg POST /api/history/archive | jq "d['archived']['loads']")
  chk "$TAG archived: the load leaves the active lists, its telemetry is still served, VBT's stamps and Linxup's visits side by side" "$AR|$(curl -s -b $M $B/api/data | jq "'$LB' in [l['id'] for l in d['loads']]")|$(evc $LB)|$(ev $LB "d['loadId']=='$LB', len(T), sorted(t['vbt'].keys()), len(t['otherVisits']), len(t2['pickup']['visits'])")|$(evc LOAD-nope)" "1|False|200|True 2 ['arrivedJobsite', 'arrivedPickup', 'completed', 'loadedAt', 'source', 'start'] 3 1|404"
  # ── Persistence failure: 503 for every L2 type, nothing stored, retry succeeds ──
  local F0=$(hl "d['counters']['failed']")
  mg POST /api/_test/save-mode '{"mode":"fail"}' >/dev/null
  chk "$TAG the telemetry store refuses writes → 503 with retry:true for a fence event, a stop, a vehicle trip and usage hours" "$(lxc geofence-event "$(fence ENTER 703 9 'Vulcan Materials Fresno' 2)")|$(lxc stop "{\"stopType\":\"Idling\",\"startDateTime\":$(ms 50),\"latitude\":36.9,\"longitude\":-119.9,\"tracker\":{\"trackerId\":701},\"company\":{\"companyId\":1}}")|$(lxc trip "{\"startDateTime\":$(ms 50),\"tracker\":{\"trackerId\":701},\"company\":{\"companyId\":1}}")|$(lxc usage-hours "{\"startDate\":$(ms 50),\"engineOn\":true,\"tracker\":{\"trackerId\":701},\"company\":{\"companyId\":1}}")|$(hl "d['counters']['failed'] - $F0")" "503|503|503|503|4"
  mg POST /api/_test/save-mode '{"mode":"ok"}' >/dev/null
  chk "$TAG …and the same fence event is stored (not a duplicate) once the store is back: nothing had been kept during the failure" "$(lx geofence-event "$(fence ENTER 703 9 'Vulcan Materials Fresno' 2)" | jq "d['stored'], d['duplicates']")" "1 0"
  # ── Restart: everything comes back from the telemetry tables, not from the dispatch store ──
  eval "$RESTART"
  curl -s -c $M -X POST -d "username=joshua&password=joshua123" $B/login -o /dev/null
  chk "$TAG after a restart: the geofence mirror and mapping, the last visit per truck, and the archived load's evidence are all still there" "$(gf "sorted((g['geofenceId'], g['mappedVendorId'], g['suggestedVendorId']) for g in d['geofences'])")|$(tel truck-14 "x['lastFence']['name']")|$(tel truck-2 "x['lastFence']['name'], x['lastFence']['leftAt']")|$(ev $LB "len(T), len(t['otherVisits']), len(t['stops']), len(t['vehicleTrips']), len(t['usage']), t['jobsite']['gps']['count'], len(t2['pickup']['visits']), [f['kind'] for f in t['flags']]")|$(hl "d['geofences'], d['mode']")" "[(9, 'vulcan', None), (10, None, 'vbt'), (55, None, None)]|Vulcan Materials Fresno|geofence 55 None|2 3 1 1 1 1 1 ['pickup-mismatch']|3 $([ "$TAG" = 48 ] && echo file || echo postgres)"
  rm -f $M $BE
}
pkill -f "^node server.js" >/dev/null 2>&1; sleep 1; rm -f data.json data-ids.json telemetry.json
(VBT_TEST_HOOKS=1 LINXUP_WEBHOOK_TOKEN=test-token LINXUP_COMPANY_ID=1 node server.js > /tmp/vbt-test-linxup2.log 2>&1 &)
for i in $(seq 1 20); do sleep 1; curl -sf $B/healthz >/dev/null 2>&1 && break; done
l2_suite $B 48 "pkill -f '^node server.js' >/dev/null 2>&1; sleep 1; (VBT_TEST_HOOKS=1 LINXUP_WEBHOOK_TOKEN=test-token LINXUP_COMPANY_ID=1 node server.js > /tmp/vbt-test-linxup2.log 2>&1 &); for i in \$(seq 1 20); do sleep 1; curl -sf $B/healthz >/dev/null 2>&1 && break; done"
chk "48 L2 never writes: the evidence engine saves nothing and touches no status; the load telemetry route is read-only; Linxup's driver never becomes VBT's" "$(sed -n '/^async function loadTelemetryEvidence/,/^}/p' server.js | grep -c 'saveData\|logAction\|approvalStatus\|\.locked\|\.status = \|truckId = \|driverName = ')|$(grep -c "app.get('/api/loads/:id/telemetry'" server.js)|$(grep -c "app.\(post\|put\|delete\)('/api/loads/:id/telemetry'" server.js)|$(grep -c "vehicle trip" public/index.html)" "0|1|0|1"
chk "   the screen wording never declares an arrival from GPS" "$(cat public/index.html server.js | grep -ci 'arrival confirmed\|confirmed by gps\|GPS confirms')|$(grep -c 'near jobsite based on GPS' public/index.html)" "0|1"

echo
echo "── 49. Calendar: scheduled work by date, from the same loads the board reads ──"
# Same server as §48 (Linxup on, the LX loads of today still there). Scheduling lives
# ten days out so nothing earlier in the suite is on these dates.
jq() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
curl -s -c $M -X POST -d "username=joshua&password=joshua123" $B/login -o /dev/null
BE=$(mktemp); curl -s -c $BE -X POST -d "username=beryle&password=beryle123" $B/login -o /dev/null
mg()  { curl -s -b $M -H "$J" -X "$1" "$B$2" -d "${3:-"{}"}" "${@:4}"; }
cal() { curl -s -b $M "$B/api/calendar?from=$1&to=$2" | jq "$3"; }
calc() { curl -s -b $M -o /dev/null -w '%{http_code}' "$B/api/calendar?$1"; }
day() { date -d "+$1 day" +%F; }
D10=$(day 10); D11=$(day 11); D12=$(day 12); TODAY=$(date +%F)
P1=$(mg POST /api/pos '{"po":{"poNumber":"CAL-1","customer":"Cal Co","job":"North pad","deliveryDate":"'"$D10"'","address":"1 North Rd","city":"Fresno","plannedVendorId":"vulcan"},"splits":[{"truckId":"beryle","truckUnitId":"truck-2","material":"3/4 Rock","loadsAssigned":3,"vendorId":"vulcan"},{"truckId":"matthew","truckUnitId":"truck-4","material":"Sand","loadsAssigned":2,"vendorId":"cemex"},{"material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' | jq "d['po']['id']")
P2=$(mg POST /api/pos '{"po":{"poNumber":"CAL-2","customer":"Other Co","jobCode":"J-9","deliveryDate":"'"$D11"'","address":"9 Canal Rd","city":"Sanger","plannedVendorId":"cemex"},"splits":[{"truckId":"rigo","truckUnitId":"truck-14","material":"Base Rock","loadsAssigned":4,"vendorId":"cemex"}]}' | jq "d['po']['id']")
P3=$(mg POST /api/pos '{"po":{"poNumber":"CAL-3","customer":"Cal Three","deliveryDate":"'"$D12"'","address":"Lot 14","city":"Clovis","plannedVendorId":"vulcan"},"splits":[{"truckId":"leonardo","truckUnitId":"truck-12","material":"3/4 Rock","loadsAssigned":2,"vendorId":"vulcan"}]}' | jq "d['po']['id']")
LC1=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$P1' and l['truckId']=='beryle'][0]")
chk "49 scheduled POs appear on their dates, nowhere else; the day's totals count loads, trips and the unassigned" "$(cal $D10 $D12 "sorted(d['days']), [sorted(r['poNumber'] for r in d['days'][k]) for k in sorted(d['days'])], d['totals']['$D10']")" "['$D10', '$D11', '$D12'] [['CAL-1', 'CAL-1', 'CAL-1'], ['CAL-2'], ['CAL-3']] {'loads': 3, 'loadsAssigned': 6, 'loadsDelivered': 0, 'unassigned': 1, 'byBucket': {'assigned': 2, 'unassigned': 1}}"
chk "   every row is the board's row: customer, job, PO, pickup yard, jobsite, driver, truck, load count, status — the same fields and the same status rule" "$(cal $D10 $D10 "[(r['customer'], r['jobName'], r['poNumber'], r['yardName'], r['destination'], r['driverName'] or '—', r['truckNum'] or '—', r['loadsDelivered'], r['loadsAssigned'], r['bucket'], r['archived']) for r in d['days']['$D10']]")" "[('Cal Co', 'North pad', 'CAL-1', 'Vulcan', '1 North Rd, Fresno', 'Beryle', 'Truck #2', 0, 3, 'assigned', False), ('Cal Co', 'North pad', 'CAL-1', 'CEMEX', '1 North Rd, Fresno', 'Matthew', 'Truck #4', 0, 2, 'assigned', False), ('Cal Co', 'North pad', 'CAL-1', 'VBT Yard', '1 North Rd, Fresno', '—', '—', 0, 1, 'unassigned', False)]"
chk "   …and it is the board's row builder, not a second status rule (the calendar reads deliveryDate; no telemetry is read)" "$(sed -n '/^function calendarRows/,/^app.get(.\/api\/calendar/p' server.js | grep -c 'boardLoadRow')|$(sed -n '/^function calendarRows/,/^});/p' server.js | grep -c 'linxup\.')|$(sed -n '/^let calView/,/^let todayData/p' public/index.html | grep -ci 'telematics\|linxup')|$(grep -c "calendarDate\|scheduledDate\b" server.js)" "2|0|0|0"
V0=$(curl -s -b $M $B/api/dispatch-version | jq "d['version']")
chk "   Edit PO moves the date: the item leaves $D11 and lands on $D12 at once (no second schedule to update), and the office version moves so the screen repaints" "$(mg PUT /api/pos/$P2 '{"deliveryDate":"'"$D12"'","reason":"customer pushed the pour"}' | jq "d['success']")|$(cal $D10 $D12 "sorted(d['days']), sorted((r['poNumber'], r['driverName']) for r in d['days']['$D12'])")|$([ "$V0" != "$(curl -s -b $M $B/api/dispatch-version | jq "d['version']")" ] && echo moved || echo same)" "True|['$D10', '$D12'] [('CAL-2', 'Rigo'), ('CAL-3', 'Leonardo')]|moved"
chk "   several loads on one day stay separate and ordered: drivers by name, Unassigned last; customers and jobs are told apart by name, job and code" "$(cal $D12 $D12 "[(r['customer'], r['jobName'], r['jobCode'], r['driverName']) for r in d['days']['$D12']]")|$(cal $D10 $D10 "[r['driverName'] or 'Unassigned' for r in d['days']['$D10']]")" "[('Cal Three', 'Cal Three', '', 'Leonardo'), ('Other Co', 'Other Co', 'J-9', 'Rigo')]|['Beryle', 'Matthew', 'Unassigned']"
chk "   today: the archived (approved, billed) load of §48 is still on its date, once, flagged archived; the live load beside it keeps its stage" "$(cal $TODAY $TODAY "[(r['poNumber'], r['approvalStatus'], r['billStatus'], r['archived'], r['bucket']) for r in d['days']['$TODAY'] if r['poNumber']=='LX-2'], [r['id'] for r in d['days']['$TODAY']].count('$LB'), [(r['poNumber'], r['bucket']) for r in d['days']['$TODAY'] if r['poNumber']=='LX-3']")" "[('LX-2', 'approved', 'billed', True, 'completed')] 1 [('LX-3', 'in-progress')]"
chk "   no load appears twice across the whole range; a voided load is not work" "$(cal $TODAY $D12 "(lambda ids: len(ids)==len(set(ids)))([r['id'] for k in d['days'] for r in d['days'][k]])")|$(mg POST /api/pos/$P3/loads '{"splits":[{"truckId":"carlos","truckUnitId":"truck-2b","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' >/dev/null; LV=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$P3' and l['truckId']=='carlos'][0]"); mg POST /api/loads/$LV/void '{"reason":"booked twice"}' >/dev/null; cal $D12 $D12 "sorted(r['driverName'] for r in d['days']['$D12'])")" "True|['Leonardo', 'Rigo']"
# Linxup has no say: a fence visit and a fresh position on Beryle's truck change nothing on the schedule
NOWMS=$(date +%s%3N)
curl -s -H "Authorization: Bearer test-token" -H "$J" -X POST $B/api/linxup/geofence-event -d "{\"eventType\":\"FENCE_ENTER\",\"enterDateTime\":$NOWMS,\"tracker\":{\"trackerId\":701},\"geofence\":{\"geofenceId\":9,\"name\":\"Vulcan Materials Fresno\"},\"company\":{\"companyId\":1}}" -o /dev/null
curl -s -H "Authorization: Bearer test-token" -H "$J" -X POST $B/api/linxup/position -d "{\"date\":$NOWMS,\"latitude\":36.95,\"longitude\":-119.95,\"speed\":0,\"engineOn\":true,\"tracker\":{\"trackerId\":701},\"company\":{\"companyId\":1}}" -o /dev/null
chk "   telemetry never moves a load to another date or changes its row: Beryle's CAL-1 is exactly where it was after a fence visit and a position" "$(cal $D10 $D12 "[(k, r['poNumber'], r['bucket']) for k in sorted(d['days']) for r in d['days'][k] if r['id']=='$LC1']")|$(curl -s -b $M $B/api/data | jq "[l['deliveryDate'] for l in d['loads'] if l['id']=='$LC1'][0]=='$D10'")" "[('$D10', 'CAL-1', 'assigned')]|True"
chk "   the range is validated: a bad date, to before from, or more than 93 days is 400; a driver cannot read the office calendar" "$(calc "from=2026-13-01")|$(calc "from=$D12&to=$D10")|$(calc "from=2026-01-01&to=2026-06-01")|$(curl -s -b $BE -o /dev/null -w '%{http_code}' "$B/api/calendar?from=$TODAY&to=$TODAY")" "400|400|400|403"
SNAP=$(cal $TODAY $D12 "[(k, r['id'], r['poNumber'], r['driverName'], r['bucket'], r['archived']) for k in sorted(d['days']) for r in d['days'][k]]")
pkill -f "^node server.js" >/dev/null 2>&1; sleep 1
(VBT_TEST_HOOKS=1 LINXUP_WEBHOOK_TOKEN=test-token LINXUP_COMPANY_ID=1 node server.js > /tmp/vbt-test-linxup2.log 2>&1 &)
for i in $(seq 1 20); do sleep 1; curl -sf $B/healthz >/dev/null 2>&1 && break; done
curl -s -c $M -X POST -d "username=joshua&password=joshua123" $B/login -o /dev/null
chk "   a restart changes nothing: the calendar is the loads, and the loads were saved" "$([ "$SNAP" = "$(cal $TODAY $D12 "[(k, r['id'], r['poNumber'], r['driverName'], r['bucket'], r['archived']) for k in sorted(d['days']) for r in d['days'][k]]")" ] && echo same || echo differs)" "same"
chk "   the screen: Calendar is in the sidebar beside Dispatch with Day / Week / Month, a date picker and the board's own Load Details; the old Board tab is still gone" "$(grep -c 'data-tab="calendar"' public/index.html)|$(grep -c 'id="sec-calendar"' public/index.html)|$(grep -c "data-cal-view=" public/index.html)|$(grep -c 'id="cal-pick"' public/index.html)|$(sed -n '/^let calView/,/^let todayData/p' public/index.html | grep -o "openLoadDetail(\|openEditPO(" | wc -l)|$(grep -c 'data-tab="board"' public/index.html)|$(grep -o "=== 'calendar'" public/index.html | wc -l)" "1|1|1|1|3|0|3"
rm -f $BE

echo
echo "── 50. CRITICAL 1 — the delivered count is the completed trips, never a number from a dialog ──"
jq() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
mg()  { curl -s -b $M -H "$J" -X "$1" "$B$2" -d "${3:-"{}"}" "${@:4}"; }
mgc() { curl -s -b $M -H "$J" -X "$1" "$B$2" -d "${3:-"{}"}" -o /dev/null -w '%{http_code}'; }
dr()  { curl -s -b "$1" -H "$J" -X POST $B/api/loads/$2/trip-action -d "$3" "${@:4}"; }
load() { curl -s -b $M $B/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);l=[x for x in d['loads'] if x['id']=='$1'][0];print($2)"; }
rtb() { curl -s -b $M "$B/api/ready-to-bill" | jq "$1"; }
MA=$(mktemp); curl -s -c $MA -X POST -d "username=matthew&password=matthew123" $B/login -o /dev/null
RG=$(mktemp); curl -s -c $RG -X POST -d "username=rigo&password=rigo123" $B/login -o /dev/null
# The exact probe that became four delivered loads: 5 assigned, 1 completed, Stop early with the dialog's old default (4).
P=$(mg POST /api/pos '{"po":{"poNumber":"C1-1","customer":"Rate Co","deliveryDate":"'"$TODAY"'","plannedVendorId":"vulcan"},"splits":[{"truckId":"matthew","truckUnitId":"truck-4","material":"3/4 Rock","loadsAssigned":5,"vendorId":"vulcan"}]}' | jq "d['po']['id']")
L=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$P'][0]")
dr $MA $L '{"action":"start-trip"}' >/dev/null; dr $MA $L '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null; dr $MA $L "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null; dr $MA $L '{"action":"arrived-jobsite"}' >/dev/null; dr $MA $L '{"action":"trip-complete"}' >/dev/null
curl -s -b $MA -H "$J" -X PUT $B/api/loads/$L -d "{\"ticketImage\":\"$PNG\",\"pod\":{\"signedBy\":\"Site Foreman\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null
chk "50 the driver's phone is told the completed trips (1), and the card no longer offers a count to adjust" "$(curl -s -b $MA $B/api/my-dispatch | jq "[(l['tripsCompleted'], l['loadsDelivered']) for l in d['loads'] if l['loadId']=='$L'][0]")|$(grep -c 'function adjustIncomplete\|inc-stepper"' public/index.html)|$(grep -c "openIncompleteDialog('\${l.loadId}', \${totalTrips}, \${Number(l.tripsCompleted) || 0})" public/index.html)" "(1, 1)|0|1"
chk "   Stop early with 4 (the old dialog default) is refused: 400 delivered_mismatch naming the 1 completed trip; the load is untouched" "$(dr $MA $L '{"action":"incomplete","delivered":4}' -w ' %{http_code}' | python3 -c "import sys,json;raw=sys.stdin.read().rstrip();b,c=raw.rsplit(' ',1);d=json.loads(b);print(c, d['code'], d['completedTrips'])")|$(load $L "l['loadsDelivered'], l['approvalStatus'], l['locked']")" "400 delivered_mismatch 1|1 pending False"
chk "   Stop early with no count, or with the true count, submits exactly the completed trips: 1 of 5, partial" "$(dr $MA $L '{"action":"incomplete","delivered":1}' | jq "d['success']")|$(load $L "l['loadsDelivered'], l['loadsAssigned'], l['isPartial'], l['approvalStatus'], len(l['trips'])")" "True|1 5 True submitted 1"
chk "   the checklist says 1/5 (partial), approval goes through, and Ready to Bill prices ONE load (25 t × \$25), the vendor bill ONE load" "$(load $L "[i['value'] for i in l['approval']['items'] if i['key']=='delivery'][0], l['approval']['blocking']")|$(mg POST /api/loads/$L/approve '{}' | jq "d['success']")|$(rtb "[(x['amount'], x['basis']) for x in d['items'] if x['id']=='$L']")|$(mg POST /api/vendor-bills/preview "{\"loadIds\":[\"$L\"]}" | jq "[(li['loads'], li['amount']) for g in d['groups'] for li in g['lineItems']]")" "1/5 loads (partial) · signed by Site Foreman []|True|[(625, 'planned')]|[(1, 950)]"
# A trip the driver is standing at the jobsite with is completed by the submission; a trip merely loaded is not.
P2=$(mg POST /api/pos '{"po":{"poNumber":"C1-2","customer":"Rate Co","deliveryDate":"'"$TODAY"'","plannedVendorId":"vulcan"},"splits":[{"truckId":"rigo","truckUnitId":"truck-14","material":"Sand","loadsAssigned":4,"vendorId":"vulcan"}]}' | jq "d['po']['id']")
L2=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$P2'][0]")
dr $RG $L2 '{"action":"start-trip"}' >/dev/null; dr $RG $L2 '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null; dr $RG $L2 "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null; dr $RG $L2 '{"action":"arrived-jobsite"}' >/dev/null; dr $RG $L2 '{"action":"trip-complete"}' >/dev/null
dr $RG $L2 '{"action":"start-trip"}' >/dev/null; dr $RG $L2 '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null; dr $RG $L2 "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null
curl -s -b $RG -H "$J" -X PUT $B/api/loads/$L2 -d "{\"ticketImage\":\"$PNG\",\"pod\":{\"signedBy\":\"S\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null
chk "   trip 2 loaded but never at the jobsite: Stop early submits 1, the loaded trip stays open on the record (not a delivery)" "$(dr $RG $L2 '{"action":"incomplete"}' | jq "d['success']")|$(load $L2 "l['loadsDelivered'], l['isPartial'], [bool(t['timestamps'].get('completed')) for t in l['trips']]")" "True|1 True [True, False]"
P3=$(mg POST /api/pos '{"po":{"poNumber":"C1-3","customer":"Rate Co","deliveryDate":"'"$TODAY"'","plannedVendorId":"vulcan"},"splits":[{"truckId":"matthew","truckUnitId":"truck-4","material":"Sand","loadsAssigned":3,"vendorId":"vulcan"}]}' | jq "d['po']['id']")
L3=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$P3'][0]")
dr $MA $L3 '{"action":"start-trip"}' >/dev/null; dr $MA $L3 '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null; dr $MA $L3 "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null; dr $MA $L3 '{"action":"arrived-jobsite"}' >/dev/null
curl -s -b $MA -H "$J" -X PUT $B/api/loads/$L3 -d "{\"ticketImage\":\"$PNG\",\"pod\":{\"signedBy\":\"S\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null
chk "   at the jobsite with trip 1 not yet confirmed: Stop early is the drop confirmation — trip 1 completes, 1 of 3 submitted" "$(dr $MA $L3 '{"action":"incomplete"}' | jq "d['success']")|$(load $L3 "l['loadsDelivered'], [bool(t['timestamps'].get('completed')) for t in l['trips']]")" "True|1 [True]"
P4=$(mg POST /api/pos '{"po":{"poNumber":"C1-4","customer":"Rate Co","deliveryDate":"'"$TODAY"'","plannedVendorId":"vulcan"},"splits":[{"truckId":"rigo","truckUnitId":"truck-14","material":"Sand","loadsAssigned":2,"vendorId":"vulcan"}]}' | jq "d['po']['id']")
L4=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$P4'][0]")
dr $RG $L4 '{"action":"start-trip"}' >/dev/null; dr $RG $L4 '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null; dr $RG $L4 "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null
curl -s -b $RG -H "$J" -X PUT $B/api/loads/$L4 -d "{\"ticketImage\":\"$PNG\",\"pod\":{\"signedBy\":\"S\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null
chk "   nothing completed yet: neither Stop early nor Submit can file a delivery (400 nothing_delivered)" "$(dr $RG $L4 '{"action":"incomplete","delivered":1}' | jq "d['code']")|$(dr $RG $L4 '{"action":"delivered"}' | jq "d['code']")|$(load $L4 "l['approvalStatus'], l['loadsDelivered']")" "nothing_delivered|nothing_delivered|pending 0"
# Older data that already disagrees (planted with the test hook): approval is refused outright, Ready to Bill will not price it, costing pays only the trips.
mg POST /api/_test/set-load "{\"id\":\"$L2\",\"fields\":{\"loadsDelivered\":3}}" >/dev/null
chk "   a submitted load whose count disagrees with its trips cannot be approved, even acknowledged (409 approval_blocked, red item)" "$(mg POST /api/loads/$L2/approve '{"acknowledge":true}' -w ' %{http_code}' | python3 -c "import sys,json;raw=sys.stdin.read().rstrip();b,c=raw.rsplit(' ',1);d=json.loads(b);print(c, d['code'], [(i['key'], i['block'], i['value']) for i in d['checklist']['items'] if i.get('block')])")|$(load $L2 "l['approvalStatus']")" "409 approval_blocked [('count', True, '3 submitted · 1 completed trip on record')]|submitted"
mg POST /api/_test/set-load "{\"id\":\"$L\",\"fields\":{\"loadsDelivered\":4}}" >/dev/null
chk "   an approved load whose count was inflated is not priceable (the reason names the trips), costing pays 1 trip, and it cannot be batched" "$(rtb "[(x['priceable'], x['priceReason']) for x in d['items'] if x['id']=='$L']")|$(mg POST /api/vendor-bills/preview "{\"loadIds\":[\"$L\"]}" | jq "[li['loads'] for g in d['groups'] for li in g['lineItems']]")|$(mgc POST /api/billing-batches "{\"loadIds\":[\"$L\"]}")" "[(False, 'the delivered count (4) on $L does not match its completed trips (1) — reject or void the load before billing')]|[1]|400"
chk "   the increment is gone: every delivered count on the server is derived from the completed trips" "$(grep -c "loadsDelivered = (l.loadsDelivered || 0) + 1" server.js)|$(grep -c "l.loadsDelivered = completed" server.js)|$(grep -c "^function completedTripCount\|^function deliveredRecord" server.js)" "0|2|2"
rm -f $MA $RG

echo "── 51. CRITICAL 2 — the office load update is an allowlist; every operation keeps its own route ──"
# Before this fix the office branch spread the request body into the load: one curl with an office
# session set the driver, truck, delivered count, date, prices, bookkeeping and history with no
# conflict check and a bare audit entry. Now notes, the planned count (while operational), the ticket
# photo and the signature go through; everything else is refused naming the operation that owns it,
# and a request with one refused field writes nothing.
pc() { python3 -c "import sys,json;raw=sys.stdin.read().rstrip();b,c=raw.rsplit(' ',1);d=json.loads(b);print(c, $1)"; }
BE=$(mktemp); curl -s -c $BE -X POST -d "username=beryle&password=beryle123" $B/login -o /dev/null
CA=$(mktemp); curl -s -c $CA -X POST -d "username=carlos&password=carlos123" $B/login -o /dev/null
P=$(mg POST /api/pos '{"po":{"poNumber":"C2-1","customer":"Allow Co","deliveryDate":"'"$TODAY"'","plannedVendorId":"vbt"},"splits":[{"truckId":"beryle","truckUnitId":"truck-2","material":"Dirt","loadsAssigned":3,"vendorId":"vbt"},{"truckId":"","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' | jq "d['po']['id']")
L1=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$P' and l['truckId']=='beryle'][0]")
L2=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$P' and not l['truckId']][0]")
deny() { chk "   $1" "$(mg PUT /api/loads/$L1 "$2" -w ' %{http_code}' | pc "d['protectedFields'], d['routes'][d['protectedFields'][0]]")|$(load $L1 "$3")" "$4"; }
chk "51 fixture: Beryle on Truck #2, 3 loads, today, pending, unpriced" "$(load $L1 "l['truckId'], l['truckUnitId'], l['loadsAssigned'], l['loadsDelivered'], l['deliveryDate']=='$TODAY', l['approvalStatus'], l['billStatus']")" "beryle truck-2 3 0 True pending not-ready"
deny "1. driver → refused, Quick Assign named, load unchanged"              '{"truckId":"rigo"}'                                        "l['truckId'], l['driverName']"                                         "400 ['truckId'] Quick Assign (POST /api/loads/:id/assign)|beryle Beryle"
deny "2. truck → refused, Quick Assign named"                               '{"truckUnitId":"truck-4"}'                                 "l['truckUnitId']"                                                      "400 ['truckUnitId'] Quick Assign (POST /api/loads/:id/assign)|truck-2"
deny "   trailer and yard → refused, Quick Assign named (it owns the conflict check and the re-price)" '{"trailerId":"trailer-1","vendorId":"cemex"}' "l.get('trailerId'), l['vendorId'], l['vendorName']"      "400 ['trailerId', 'vendorId'] Quick Assign (POST /api/loads/:id/assign)|None vbt VBT Yard"
deny "3. delivered count → refused, routed to the driver's trip steps"      '{"loadsDelivered":3}'                                      "l['loadsDelivered']"                                                   "400 ['loadsDelivered'] the driver's trip steps (POST /api/loads/:id/trip-action)|0"
deny "4. delivery date → refused, routed to Move Date / Edit PO"            "{\"deliveryDate\":\"$TOMORROW\"}"                          "l['deliveryDate']=='$TODAY', l.get('moveHistory')"                     "400 ['deliveryDate'] Move Date (POST /api/loads/move) or Edit PO|True None"
deny "5. approval state → refused, routed to approve / reject"              '{"approvalStatus":"approved","locked":true,"approvedBy":"me"}' "l['approvalStatus'], l['locked'], l.get('approvedBy') or None"      "400 ['approvalStatus', 'locked', 'approvedBy'] approve / reject|pending False None"
deny "6. billing fields → refused, routed to billing"                       '{"billStatus":"billed","manualBillRef":"INV-1","billingBatchId":"BB-1","qbInvoiceId":"9"}' "l['billStatus'], l.get('manualBillRef'), l.get('billingBatchId'), l.get('qbInvoiceId')" "400 ['billStatus', 'manualBillRef', 'billingBatchId', 'qbInvoiceId'] Mark Billed / unbill / billing batches|not-ready None None None"
deny "7. trip ownership and history → refused (trips, stamps, move and reassign history)" '{"trips":[{"n":1,"timestamps":{"completed":"x"}}],"timestamps":{"completed":"x"},"moveHistory":[{"x":1}],"reassignHistory":[{"x":1}]}' "len(l.get('trips') or []), l.get('timestamps'), l.get('moveHistory'), l.get('reassignHistory')" "400 ['trips', 'timestamps', 'moveHistory', 'reassignHistory'] the driver's trip steps|0 {} None None"
deny "8. pricing and costing snapshot → refused (set at creation / Vendors & Prices)" '{"customerRate":1,"vendorRate":1,"tonsPerLoad":1,"pricePerUnit":1}' "l['customerRate'], l['vendorRate'], l['tonsPerLoad']"                "400 ['customerRate', 'vendorRate', 'tonsPerLoad', 'pricePerUnit'] Vendors & Prices (set at creation or by Edit PO)|25 0 25"
deny "   vendor-bill and void bookkeeping → refused"                        '{"vendorBillId":"VB-1","billHistory":[{"x":1}],"billStatusBeforeVoid":"ready","qbBillId":"7","voided":true}' "l.get('vendorBillId'), l.get('billHistory'), l['voided']"       "400 ['vendorBillId', 'billHistory', 'billStatusBeforeVoid', 'qbBillId', 'voided'] vendor bills|None None False"
deny "   status, driver name and derived progress → refused"                '{"status":"completed","driverName":"Nobody","isPartial":true,"allTripsDone":true,"actualYardId":"cemex"}' "l['status'], l['driverName'], l.get('isPartial'), l.get('actualYardId')" "400 ['status', 'driverName', 'isPartial', 'allTripsDone', 'actualYardId'] derived from the trips and the approval|active Beryle None None"
deny "   identity → refused (id, poId, createdAt are never editable)"       '{"id":"X","poId":"Y","createdAt":"z"}'                     "l['id']=='$L1', l['poId']=='$P'"                                       "400 ['id', 'poId', 'createdAt'] never|True True"
deny "   one refused field in a mixed body: only truckId is reported, and nothing is written — not even the (allowed) notes" '{"notes":"smuggled","truckId":"rigo"}' "repr(l.get('notes') or ''), l['truckId']" "400 ['truckId'] Quick Assign (POST /api/loads/:id/assign)|'' beryle"
chk "   legitimate: notes → 200, stored"                                    "$(mgc PUT /api/loads/$L1 '{"notes":"gate code 4321"}')|$(load $L1 "l['notes']")" "200|gate code 4321"
chk "   legitimate: planned count while operational → 200, audited old → new" "$(mgc PUT /api/loads/$L1 '{"loadsAssigned":4}')|$(load $L1 "l['loadsAssigned']")|$(curl -s -b $M "$B/api/audit-log?action=updated-load" | jq "[e['details'] for e in d['entries'] if e['target']=='$L1'][0]")" "200|4|{'changes': ['loadsAssigned'], 'loadsAssigned': {'from': 3, 'to': 4}}"
chk "   planned count must be a whole number ≥ 1 (0 and 'abc' → 400)"       "$(mgc PUT /api/loads/$L1 '{"loadsAssigned":0}') $(mgc PUT /api/loads/$L1 '{"loadsAssigned":"abc"}')|$(load $L1 "l['loadsAssigned']")" "400 400|4"
chk "   legitimate: office may attach the signature and ticket photo (merged, stamped)" "$(mgc PUT /api/loads/$L1 "{\"ticketImage\":\"$PNG\",\"pod\":{\"signedBy\":\"Office on behalf\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}")|$(load $L1 "l['pod']['signedBy'], bool(l['ticketImage']), bool(l.get('ticketImageAt'))")" "200|Office on behalf True True"
# The same changes still work through the operations that own them.
chk "   routed: yard through Quick Assign → 200, re-resolved and re-priced (Dirt has no CEMEX price, so the default is flagged)" "$(mgc POST /api/loads/$L1/assign '{"yardId":"cemex"}')|$(load $L1 "l['vendorId'], l['vendorName'], l['vendorRateIsDefault']")" "200|cemex CEMEX True"
chk "   routed: date through Move Date (reason required) → 200, history kept" "$(mgc POST /api/loads/move "{\"scope\":\"single\",\"loadId\":\"$L1\",\"newDate\":\"$TOMORROW\",\"reason\":\"pour moved\"}") $(mgc POST /api/loads/move "{\"scope\":\"single\",\"loadId\":\"$L1\",\"newDate\":\"$TODAY\",\"reason\":\"pour back\"}")|$(load $L1 "l['deliveryDate']=='$TODAY', len(l['moveHistory']), l['moveHistory'][0]['reason']")" "200 200|True 2 pour moved"
chk "   routed: driver and truck through Quick Assign → 200, reassign history written" "$(mgc POST /api/loads/$L1/assign '{"driverId":"carlos","truckUnitId":"truck-2b","force":true,"reason":"regression fixture"}')|$(load $L1 "l['truckId'], l['truckUnitId'], l['driverName']")" "200|carlos truck-2b Carlos"
# Once a trip has started the planned count belongs to Edit PO's add/delete rule; notes are still fine.
dr $CA $L1 '{"action":"start-trip"}' >/dev/null
chk "   not operational (trip started): planned count → 409 not_operational, unchanged; notes still 200" "$(mg PUT /api/loads/$L1 '{"loadsAssigned":5}' -w ' %{http_code}' | pc "d['code']")|$(load $L1 "l['loadsAssigned']")|$(mgc PUT /api/loads/$L1 '{"notes":"still fine"}')" "409 not_operational|4|200"
chk "   the driver branch is unchanged: progress → 400, signature → 200"    "$(curl -s -b $CA -H "$J" -X PUT $B/api/loads/$L1 -d '{"loadsDelivered":2}' -o /dev/null -w '%{http_code}') $(curl -s -b $CA -H "$J" -X PUT $B/api/loads/$L1 -d "{\"pod\":{\"signedBy\":\"Foreman\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null -w '%{http_code}')" "400 200"
mg POST /api/loads/$L2/void '{"reason":"never happened"}' >/dev/null
chk "   a voided load refuses even notes (403); a locked load still does (§22)" "$(mgc PUT /api/loads/$L2 '{"notes":"x"}')" "403"
chk "   static: no request body is spread into a load anywhere on the server; the allowlist is exactly five fields; only the driver phone calls the route" "$(grep -c '{ \.\.\.l, \.\.\.req\.body' server.js)|$(grep -c "OFFICE_LOAD_FIELDS = new Set(\['notes', 'loadsAssigned', 'pod', 'ticketImage', 'ticketImageUrl'\])" server.js)|$(grep -c "api('PUT', '/api/loads/' + currentLoadId" public/index.html)" "0|1|2"
rm -f $BE $CA

echo "── 52. CRITICAL 3 — delivered actual tons are the completed trips' tickets; a loaded, undelivered ticket counts nowhere ──"
# One completed trip (24.50 t) and one trip started, at the yard, loaded and ticketed (26.00 t) but
# never delivered, for a customer billed on actual tons. Before this fix every consumer said 50.5 t
# and the invoice carried both tickets; the vendor side costed one trip.
MA=$(mktemp); curl -s -c $MA -X POST -d "username=matthew&password=matthew123" $B/login -o /dev/null
RG=$(mktemp); curl -s -c $RG -X POST -d "username=rigo&password=rigo123" $B/login -o /dev/null
BE=$(mktemp); curl -s -c $BE -X POST -d "username=beryle&password=beryle123" $B/login -o /dev/null
tk() { echo "{\"source\":\"supplier\",\"number\":\"$1\",\"netTons\":$2,\"photo\":\"$PNG\"}"; }
mg POST /api/customers '{"name":"Scale Co","billingBasis":"actual"}' >/dev/null
P=$(mg POST /api/pos '{"po":{"poNumber":"C3-1","customer":"Scale Co","deliveryDate":"'"$TODAY"'","plannedVendorId":"vulcan"},"splits":[{"truckId":"matthew","truckUnitId":"truck-4","material":"3/4 Rock","loadsAssigned":3,"vendorId":"vulcan"}]}' | jq "d['po']['id']")
L=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$P'][0]")
curl -s -b $MA -H "$J" -X POST $B/api/shifts/start -d '{"truckId":"truck-4","odometer":950000,"inspection":{"satisfactory":true},"signature":"'"$PNG"'"}' -o /dev/null   # a day, so a freight segment opens at the first pickup
dr $MA $L '{"action":"start-trip"}' >/dev/null; dr $MA $L '{"action":"arrived-pickup","yardId":"vulcan","odometer":950010}' >/dev/null; dr $MA $L "{\"action\":\"loaded\",\"ticket\":$(tk C3-1001 24.5)}" >/dev/null; dr $MA $L '{"action":"arrived-jobsite"}' >/dev/null; dr $MA $L '{"action":"trip-complete"}' >/dev/null
dr $MA $L '{"action":"start-trip"}' >/dev/null; dr $MA $L '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null; dr $MA $L "{\"action\":\"loaded\",\"ticket\":$(tk C3-1002 26.0)}" >/dev/null
chk "52 fixture: trip 1 completed with 24.5 t, trip 2 loaded and ticketed with 26 t, not completed" "$(load $L "[(t['tripNum'], bool(t['timestamps'].get('completed')), t['ticket']['number'], t['ticket']['netTons']) for t in l['trips']]")" "[(1, True, 'C3-1001', 24.5), (2, False, 'C3-1002', 26)]"
chk "   the one calculation: actual 24.5 t from 1 ticket; the open ticket is listed, not counted" "$(load $L "l['tons']['actualTons'], l['tons']['tickets'], l['tons']['ticketsWithTons'], l['tons']['ticketNumbers'], l['tons']['tonsSource'], l['tons']['actualComplete'], [(o['tripNum'], o['number'], o['netTons']) for o in l['tons']['openTickets']], l['tons']['openTons']")" "24.5 1 1 ['C3-1001'] supplier True [(2, 'C3-1002', 26)] 26"
chk "   Fleet Map row: delivered tons 24.5 from 1 ticket, the en-route ticket shown beside them" "$(curl -s -b $M $B/api/fleet/live | jq "[(r['load']['actualTons'], r['load']['tickets'], r['load']['currentTicket']['number'], r['load']['currentTicket']['netTons']) for r in d['trucks'] if r['driverId']=='matthew'][0]")" "(24.5, 1, 'C3-1002', 26)"
chk "   driver phone and Dispatch board agree" "$(curl -s -b $MA $B/api/my-dispatch | jq "[(l['tons']['actualTons'], l['tons']['tickets']) for l in d['loads'] if l['loadId']=='$L'][0]")|$(curl -s -b $M $B/api/today | jq "[(l['tons']['actualTons'], l['tons']['tickets']) for l in d['loads'] if l['id']=='$L'][0]")" "(24.5, 1)|(24.5, 1)"
FS=$(load $L "l.get('freightSegmentId')")
chk "   freight segment: 2 trips, 1 delivered, 24.5 t actual (both tickets stay on the log's rows)" "$(curl -s -b $M $B/api/freight-segments/$FS | jq "d['segment']['tripCount'], d['segment']['tripsDelivered'], d['segment']['actualTons'], d['segment']['loadActualTons'], d['segment']['plannedTons'], d['segment']['ticketNumbers']")" "2 1 24.5 24.5 25 ['C3-1001', 'C3-1002']"
# The truck breaks down: Stop early files the one completed trip (CRITICAL 1), the office approves.
curl -s -b $MA -H "$J" -X PUT $B/api/loads/$L -d "{\"ticketImage\":\"$PNG\",\"pod\":{\"signedBy\":\"Site Foreman\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null
chk "   Stop early: 1 of 3 delivered, submitted; the open trip stays on the record" "$(dr $MA $L '{"action":"incomplete","delivered":1}' | jq "d['success']")|$(load $L "l['loadsDelivered'], l['isPartial'], l['approvalStatus'], len(l['trips'])")" "True|1 True submitted 2"
chk "   approval ticket row: 1 ticket · 24.5 t, and the approver is told about the undelivered ticket" "$(load $L "[(i['ok'], i['value'], i['note']) for i in l['approval']['items'] if i['key']=='ticket'][0]")" "(True, '1 ticket · 24.5 t', 'planned 25 t, actual 24.5 t; ticket #C3-1002 on trip 2 was loaded but never delivered (26 t, not counted)')"
chk "   approved; the audit freezes 24.5 t, the delivered ticket, and names the open one" "$(mg POST /api/loads/$L/approve '{}' | jq "d['success']")|$(curl -s -b $M "$B/api/audit-log?action=approved-load" | jq "[(e['details']['actualTons'], e['details']['tickets'], e['details']['openTickets']) for e in d['entries'] if e['target']=='$L'][0]")" "True|(24.5, ['C3-1001'], ['C3-1002'])"
chk "   Ready to Bill prices 24.5 t × \$25 = \$612.50 on the actual basis (was \$1,262.50)" "$(rtb "[(x['priceable'], x['amount'], x['basis']) for x in d['items'] if x['id']=='$L'][0]")" "(True, 612.5, 'actual')"
chk "   invoice preview: 24.5 t, 1 ticket, \$612.50; only the delivered ticket number is behind the invoice" "$(mg POST /api/billing-batches/preview "{\"loadIds\":[\"$L\"]}" | jq "[(li['tons'], li['tickets'], li['amount']) for li in d['groups'][0]['lineItems']], d['groups'][0]['ticketNumbers']")" "[(24.5, 1, 612.5)] ['C3-1001']"
chk "   vendor side unchanged: the completed trip at Vulcan, planned tons (1 load, \$950); the undelivered trip is not costed" "$(mg POST /api/vendor-bills/preview "{\"loadIds\":[\"$L\"]}" | jq "d['groups'][0]['lineItems'][0]['loads'], d['groups'][0]['totalAmount']")" "1 950"
# All trips completed → every ticket counts.
P2=$(mg POST /api/pos '{"po":{"poNumber":"C3-2","customer":"Scale Co","deliveryDate":"'"$TODAY"'","plannedVendorId":"vulcan"},"splits":[{"truckId":"rigo","truckUnitId":"truck-14","material":"3/4 Rock","loadsAssigned":2,"vendorId":"vulcan"}]}' | jq "d['po']['id']")
L2=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$P2'][0]")
for T in "C3-2001 20.0" "C3-2002 21.5"; do set -- $T; dr $RG $L2 '{"action":"start-trip"}' >/dev/null; dr $RG $L2 '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null; dr $RG $L2 "{\"action\":\"loaded\",\"ticket\":$(tk $1 $2)}" >/dev/null; dr $RG $L2 '{"action":"arrived-jobsite"}' >/dev/null; dr $RG $L2 '{"action":"trip-complete"}' >/dev/null; done
chk "   all trips completed: 20 + 21.5 = 41.5 t from 2 tickets, nothing open" "$(load $L2 "l['tons']['actualTons'], l['tons']['tickets'], l['tons']['ticketNumbers'], l['tons']['openTickets'], l['tons']['actualComplete']")" "41.5 2 ['C3-2001', 'C3-2002'] [] True"
# No completed trip: loaded and ticketed is still zero delivered tons, and nothing can be filed.
P3=$(mg POST /api/pos '{"po":{"poNumber":"C3-3","customer":"Scale Co","deliveryDate":"'"$TODAY"'","plannedVendorId":"vulcan"},"splits":[{"truckId":"beryle","truckUnitId":"truck-2","material":"3/4 Rock","loadsAssigned":1,"vendorId":"vulcan"}]}' | jq "d['po']['id']")
L3=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$P3'][0]")
dr $BE $L3 '{"action":"start-trip"}' >/dev/null; dr $BE $L3 '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null; dr $BE $L3 "{\"action\":\"loaded\",\"ticket\":$(tk C3-3001 22.0)}" >/dev/null
curl -s -b $BE -H "$J" -X PUT $B/api/loads/$L3 -d "{\"pod\":{\"signedBy\":\"x\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null
chk "   loaded + ticketed, nothing completed: 0 t, 0 tickets, source planned, the ticket open; Stop early is refused (nothing_delivered)" "$(load $L3 "l['tons']['actualTons'], l['tons']['tickets'], l['tons']['tonsSource'], l['tons']['plannedTons'], [o['number'] for o in l['tons']['openTickets']]")|$(dr $BE $L3 '{"action":"incomplete","delivered":1}' | jq "d['code']")" "0 0 planned 0 ['C3-3001']|nothing_delivered"
# Pre-trip-tracking record (no trips at all): unchanged compatibility — no tickets, planned tons from the count, never priced on actual.
P4=$(mg POST /api/pos '{"po":{"poNumber":"C3-4","customer":"Scale Co","deliveryDate":"'"$TODAY"'","plannedVendorId":"vulcan"},"splits":[{"truckId":"","material":"3/4 Rock","loadsAssigned":2,"vendorId":"vulcan"}]}' | jq "d['po']['id']")
L4=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$P4'][0]")
mg POST /api/_test/set-load "{\"id\":\"$L4\",\"fields\":{\"loadsDelivered\":2,\"approvalStatus\":\"approved\",\"locked\":true,\"status\":\"completed\",\"billStatus\":\"ready\"}}" >/dev/null
chk "   legacy load, no trips: 0 actual, planned 50 from the count, no open tickets; Ready to Bill still refuses to price it on actual tons" "$(load $L4 "len(l['trips']), l['tons']['actualTons'], l['tons']['tickets'], l['tons']['plannedTons'], l['tons']['openTickets'], l['tons']['tonsSource']")|$(rtb "[(x['priceable'], x['priceReason'].startswith('Scale Co is billed on actual ticket tons, but 2 of 2 delivered loads')) for x in d['items'] if x['id']=='$L4'][0]")" "0 0 0 50 [] planned|(False, True)"
chk "   static: one completion predicate — no inline copy left in the tons, cost or segment paths" "$(grep -c "function tripIsCompleted" server.js)|$(grep -cE "filter\(t => t\.timestamps && t\.timestamps\.completed\)" server.js)" "1|0"
rm -f $MA $RG $BE

echo "── 53. CRITICAL 4 — a QuickBooks answer VBT cannot read is an UNKNOWN result, never 'nothing was created' ──"
# Three outcomes of a create: confirmed success, confirmed failure (retryable), and UNKNOWN — the
# request may have reached QuickBooks. An unknown batch or bill is parked: Send is refused, Retry
# is a lookup, Void looks up first, the load stays claimed, no id is invented. The fake QuickBooks
# models each case, including "document created, answer lost", and counts create REQUESTS received
# separately from documents that exist — the two must never drift apart because of VBT.
RG=$(mktemp); curl -s -c $RG -X POST -d "username=rigo&password=rigo123" $B/login -o /dev/null
mkl() { # mkl PONUM MATERIAL YARD → one approved, ready-to-bill load for Ambig Co (planned basis)
  local P L; P=$(mg POST /api/pos '{"po":{"poNumber":"'"$1"'","customer":"Ambig Co","deliveryDate":"'"$TODAY"'","plannedVendorId":"'"$3"'"},"splits":[{"truckId":"rigo","truckUnitId":"truck-14","material":"'"$2"'","loadsAssigned":1,"vendorId":"'"$3"'"}]}' | jq "d['po']['id']")
  L=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$P'][0]")
  dr $RG $L '{"action":"start-trip"}' >/dev/null; dr $RG $L "{\"action\":\"arrived-pickup\",\"yardId\":\"$3\"}" >/dev/null; dr $RG $L "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null; dr $RG $L '{"action":"arrived-jobsite"}' >/dev/null; dr $RG $L '{"action":"trip-complete"}' >/dev/null
  curl -s -b $RG -H "$J" -X PUT $B/api/loads/$L -d "{\"ticketImage\":\"$PNG\",\"pod\":{\"signedBy\":\"x\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null
  dr $RG $L '{"action":"delivered"}' >/dev/null; mg POST /api/loads/$L/approve >/dev/null; echo $L; }
nb() { mg POST /api/billing-batches "{\"loadIds\":[\"$1\"]}" | jq "(d.get('batches') or [{}])[0].get('id') or d.get('error')"; }
nv() { mg POST /api/vendor-bills "{\"loadIds\":[\"$1\"]}" | jq "(d.get('bills') or [{}])[0].get('id') or d.get('error')"; }
fk() { curl -s -b $M $B/api/_test/qb-fake | jq "$1"; }
bt() { curl -s -b $M $B/api/billing-batches/$1 | jq "$2"; }
vb() { curl -s -b $M $B/api/vendor-bills | jq "[$2 for b in d['items'] if b['id']=='$1'][0]"; }
qbm() { mg POST /api/_test/qb-fake "{\"mode\":\"$1\"${2:+,$2}}" >/dev/null; }
mg POST /api/customers '{"name":"Ambig Co"}' >/dev/null
qbm ok; IC0=$(fk "d['invoicesCreated']"); CC0=$(fk "d['invoiceCreateCalls']")
inv() { fk "(d['invoicesCreated']-$IC0, d['invoiceCreateCalls']-$CC0)"; }   # (documents that exist, create requests received) since the section began
# 1. Confirmed success, and the second-send refusals that already existed.
L1=$(mkl C4-1 Dirt vbt); B1=$(nb $L1)
chk "53 1. confirmed success: sent, invoice id recorded, load billed, requestid = batch id" "$(mgc POST /api/billing-batches/$B1/send)|$(bt $B1 "d['batch']['syncStatus'], d['batch']['qbInvoiceId']!='', d['batch']['mayExistInQuickBooks']")|$(load $L1 "l['billStatus']")|$(fk "d['invoiceRequestIds'][-1]=='$B1'")|$(inv)" "200|sent_to_quickbooks True False|billed|True|(1, 1)"
chk "   11. second send, retry and re-batch of a sent load are refused (400 400 400); one invoice" "$(mgc POST /api/billing-batches/$B1/send) $(mgc POST /api/billing-batches/$B1/retry) $(mgc POST /api/billing-batches "{\"loadIds\":[\"$L1\"]}")|$(inv)" "400 400 400|(1, 1)"
# 2. Confirmed failure (QuickBooks said 400): retryable, nothing invented.
L2=$(mkl C4-2 Dirt vbt); B2=$(nb $L2); qbm fail
chk "   2. confirmed failure (400): 500, failed, not 'may exist', no id, load still claimed by the batch" "$(mgc POST /api/billing-batches/$B2/send)|$(bt $B2 "d['batch']['syncStatus'], d['batch']['mayExistInQuickBooks'], repr(d['batch']['qbInvoiceId'])")|$(load $L2 "l['billStatus'], l['billingBatchId']=='$B2'")|$(inv)" "500|failed False ''|ready True|(1, 2)"
qbm ok
chk "   …a known failure stays retryable: Retry resets, Send creates the one invoice" "$(mg POST /api/billing-batches/$B2/retry | jq "d['success'], d.get('reconciled'), d['batch']['syncStatus']")|$(mgc POST /api/billing-batches/$B2/send)|$(inv)" "True None ready_to_bill|200|(2, 3)"
# 3. Thrown before the request left: a failure, retryable.
L3=$(mkl C4-3 Dirt vbt); B3=$(nb $L3); qbm thrown
chk "   3. thrown before the request was sent: failed, retryable" "$(mgc POST /api/billing-batches/$B3/send)|$(bt $B3 "d['batch']['syncStatus'], d['batch']['mayExistInQuickBooks']")|$(qbm ok; mg POST /api/billing-batches/$B3/retry | jq "d['batch']['syncStatus']")|$(mgc POST /api/billing-batches/$B3/send)|$(inv)" "500|failed False|ready_to_bill|200|(3, 5)"
# 4. Timeout: nothing was created, but VBT cannot know that → UNKNOWN; reconcile says 'not found'; the re-send carries the same requestid.
L4=$(mkl C4-4 Dirt vbt); B4=$(nb $L4); qbm timeout
chk "   4. timeout → 502 external_unknown; batch 'unknown', may exist, no id invented; load claimed, not billed" "$(mg POST /api/billing-batches/$B4/send '{}' -w ' %{http_code}' | pc "d['code'], d['batch']['syncStatus'], d['batch']['mayExistInQuickBooks'], repr(d['batch']['qbInvoiceId']), d['batch']['reconcile']['kind'], d['batch']['reconcile']['requestId']=='$B4'")|$(load $L4 "l['billStatus'], l['billingBatchId']=='$B4'")|$(inv)" "502 external_unknown unknown True '' timeout True|ready True|(3, 6)"
# (Persistence 5 changed the rule: a load on a batch — unknown, failed or unsent — belongs to that batch and is off the Ready to Bill list; before, the list showed it "as batched".)
chk "   …Send is refused (409 external_unknown), the load cannot join another batch (400), and it is off the Ready to Bill list — it belongs to the batch, which still lists it" "$(mg POST /api/billing-batches/$B4/send '{}' -w ' %{http_code}' | pc "d['code']")|$(mgc POST /api/billing-batches "{\"loadIds\":[\"$L4\"]}")|$(rtb "[x['id'] for x in d['items'] if x['id']=='$L4']")|$(bt $B4 "'$L4' in [l['id'] for l in d['loads']]")|$(inv)" "409 external_unknown|400|[]|True|(3, 6)"
qbm ok '"connected":false'
chk "   …Retry with QuickBooks disconnected: 409, still unknown, no create request" "$(mgc POST /api/billing-batches/$B4/retry)|$(bt $B4 "d['batch']['syncStatus'], d['batch']['reconcile']['attempts']")|$(inv)" "409|unknown 1|(3, 6)"
qbm ok
chk "   …Retry = reconcile: QuickBooks has no invoice → 'not_found', back to ready; Send creates it with the SAME requestid" "$(mg POST /api/billing-batches/$B4/retry | jq "d['reconciled'], d['batch']['syncStatus'], d['batch']['reconcile']['result']")|$(mgc POST /api/billing-batches/$B4/send)|$(fk "d['invoiceRequestIds'][-1]==d['invoiceRequestIds'][-2]=='$B4'")|$(inv)" "not_found ready_to_bill not_found|200|True|(4, 7)"
# 5. Connection lost AFTER QuickBooks created the invoice: the case the state exists for.
L5=$(mkl C4-5 Dirt vbt); B5=$(nb $L5); qbm lost
chk "   5. invoice created, answer lost → unknown; QuickBooks holds 1 more invoice than VBT knows about; no false id, load not billed" "$(mgc POST /api/billing-batches/$B5/send)|$(bt $B5 "d['batch']['syncStatus'], repr(d['batch']['qbInvoiceId'])")|$(load $L5 "l['billStatus'], l['billingBatchId']=='$B5'")|$(inv)" "502|unknown ''|ready True|(5, 8)"
qbm ok '"connected":false'
chk "   …8. Void while unknown with QuickBooks unreachable: 409, nothing released, nothing sent" "$(mg POST /api/billing-batches/$B5/void '{"reason":"bill again"}' -w ' %{http_code}' | pc "d['code']")|$(bt $B5 "d['batch']['syncStatus']")|$(load $L5 "l['billStatus'], l['billingBatchId']=='$B5'")|$(inv)" "409 external_unknown|unknown|ready True|(5, 8)"
chk "   …9. re-bill attempt while unknown is refused; Send still refused" "$(mgc POST /api/billing-batches "{\"loadIds\":[\"$L5\"]}") $(mgc POST /api/billing-batches/$B5/send)|$(inv)" "400 409|(5, 8)"
qbm ok
chk "   …7. Retry = reconcile: the invoice is found and adopted — batch sent, load billed, NO second create request" "$(mg POST /api/billing-batches/$B5/retry | jq "d['recovered'], d['reconciled'], d['batch']['syncStatus'], d['batch']['qbInvoiceId']!=''")|$(load $L5 "l['billStatus'], l['qbInvoiceId']!=''")|$(inv)" "True found sent_to_quickbooks True|billed True|(5, 8)"
chk "   …the sync log says what happened: create error 'External result unknown', then recover_invoice" "$(curl -s -b $M "$B/api/qb-sync-log?batchId=$B5" | jq "[(e['actionType'], e['responseStatus'], 'External result unknown' in (e.get('errorMessage') or '')) for e in d['items'] if e['actionType'] in ('create_invoice','recover_invoice')]")" "[('recover_invoice', 'success', False), ('create_invoice', 'error', True)]"
# 6. QuickBooks answered 500 after creating the invoice; Void reconciles, voids THERE, then releases — one live invoice at the end.
L6=$(mkl C4-6 Dirt vbt); B6=$(nb $L6); qbm http500; VO0=$(fk "d['invoicesVoided']")
chk "   6. 5xx after the invoice was created → unknown (kind http_500), may exist" "$(mgc POST /api/billing-batches/$B6/send)|$(bt $B6 "d['batch']['syncStatus'], d['batch']['reconcile']['kind'], d['batch']['reconcile']['statusCode']")|$(inv)" "502|unknown http_500 500|(6, 9)"
qbm ok
chk "   …8. Void while unknown with QuickBooks connected: looks up first, finds the invoice, voids it in QuickBooks, then releases the load" "$(mg POST /api/billing-batches/$B6/void '{"reason":"wrong price"}' | jq "d['success'], d['qbVoided'], d['batch']['syncStatus'], d['batch']['qbInvoiceId']!='', d['batch']['reconcile']['result']")|$(fk "d['invoicesVoided']-$VO0")|$(load $L6 "l['billStatus'], repr(l['billingBatchId'])")|$(inv)" "True True voided True found|1|ready ''|(6, 9)"
B6b=$(nb $L6)
chk "   …re-billed after the void: one more invoice, and exactly ONE live invoice for the load (2 created, 1 voided)" "$(mgc POST /api/billing-batches/$B6b/send)|$(inv)|$(fk "d['invoicesVoided']-$VO0")" "200|(7, 10)|1"
# 7. 2xx with no body: QuickBooks accepted it, VBT has no id → unknown, reconciled by lookup.
L7=$(mkl C4-7 Dirt vbt); B7=$(nb $L7); qbm nobody
chk "   7. 2xx with no readable invoice in the body → unknown (no_entity_in_response), nothing assumed; reconcile adopts it, no second create" "$(mgc POST /api/billing-batches/$B7/send)|$(bt $B7 "d['batch']['syncStatus'], d['batch']['reconcile']['kind']")|$(qbm ok; mg POST /api/billing-batches/$B7/retry | jq "d['recovered'], d['batch']['syncStatus']")|$(inv)" "502|unknown no_entity_in_response|True sent_to_quickbooks|(8, 11)"
# 8. 503 with nothing created: still unknown to VBT; the lookup settles it.
L8=$(mkl C4-8 Dirt vbt); B8=$(nb $L8); qbm http503
chk "   5xx with nothing created → unknown (http_503); reconcile 'not_found'; the send that follows reuses the requestid" "$(mgc POST /api/billing-batches/$B8/send)|$(bt $B8 "d['batch']['syncStatus'], d['batch']['reconcile']['kind']")|$(qbm ok; mg POST /api/billing-batches/$B8/retry | jq "d['reconciled']")|$(mgc POST /api/billing-batches/$B8/send)|$(fk "d['invoiceRequestIds'][-1]==d['invoiceRequestIds'][-2]=='$B8'")|$(inv)" "502|unknown http_503|not_found|200|True|(9, 13)"
# 9. Operator reconciliation: QuickBooks cannot be reached; the operator checked by hand and found no invoice. On the record.
L9=$(mkl C4-9 Dirt vbt); B9=$(nb $L9); qbm timeout; mgc POST /api/billing-batches/$B9/send >/dev/null; qbm ok '"connected":false'
chk "   operator statement 'no invoice in QuickBooks' releases an unknown batch, and is written to the sync log" "$(mg POST /api/billing-batches/$B9/void '{"reason":"outage; checked QuickBooks by hand","confirmedNoInvoiceInQuickBooks":true}' | jq "d['success'], d['batch']['syncStatus'], d['batch']['reconcile']['result']")|$(load $L9 "l['billStatus'], repr(l['billingBatchId'])")|$(curl -s -b $M "$B/api/qb-sync-log?batchId=$B9" | jq "any('checked by hand' in e['requestSummary'] for e in d['items'])")" "True voided operator_confirmed_absent|ready ''|True"
qbm ok
# 10. Simultaneous sends of one batch: one 200, one 409, one invoice (the pre-existing guard).
L10=$(mkl C4-10 Dirt vbt); B10=$(nb $L10); qbm slow '"delayMs":1200'
R1=$(mktemp); R2=$(mktemp); mgc POST /api/billing-batches/$B10/send > $R1 & sleep 0.2; mgc POST /api/billing-batches/$B10/send > $R2 & wait
chk "   10. simultaneous sends: one 200, one 409, one create request" "$(cat $R1 $R2 | tr -d '\n' | fold -w3 | sort | tr '\n' ' ')|$(inv)" "200 409 |(10, 15)"
qbm ok
# ── Vendor bills: the same three outcomes ──
BC0=$(fk "d['billsCreated']"); BK0=$(fk "d['billCreateCalls']"); BD0=$(fk "d['billsDeleted']")
bills() { fk "(d['billsCreated']-$BC0, d['billCreateCalls']-$BK0)"; }
qbb() { mg POST /api/_test/qb-fake "{\"billMode\":\"$1\"${2:+,$2}}" >/dev/null; }
V1=$(mkl C4-V1 "3/4 Rock" vulcan); VB1=$(nv $V1)
chk "   bills 1. confirmed success; second send and retry refused; requestid = bill id" "$(mgc POST /api/vendor-bills/$VB1/send)|$(vb $VB1 "(b['syncStatus'], b['qbBillId']!='')")|$(mgc POST /api/vendor-bills/$VB1/send) $(mgc POST /api/vendor-bills/$VB1/retry)|$(fk "d['billRequestIds'][-1]=='$VB1'")|$(bills)" "200|('sent', True)|400 400|True|(1, 1)"
V2=$(mkl C4-V2 "3/4 Rock" vulcan); VB2=$(nv $V2); qbb fail
chk "   bills 2. confirmed failure: failed, retryable; 3. thrown: failed, retryable" "$(mgc POST /api/vendor-bills/$VB2/send)|$(vb $VB2 "(b['syncStatus'], b['mayExistInQuickBooks'])")|$(qbb ok; mg POST /api/vendor-bills/$VB2/retry | jq "d['bill']['syncStatus']")|$(qbb thrown; mgc POST /api/vendor-bills/$VB2/send)|$(vb $VB2 "b['syncStatus']")|$(qbb ok; mg POST /api/vendor-bills/$VB2/retry | jq "d['bill']['syncStatus']")|$(mgc POST /api/vendor-bills/$VB2/send)|$(bills)" "500|('failed', False)|ready|500|failed|ready|200|(2, 4)"
V4=$(mkl C4-V4 "3/4 Rock" vulcan); VB4=$(nv $V4); qbb timeout
chk "   bills 4. timeout → unknown; Send 409; Retry disconnected 409; reconcile not_found → ready; Send reuses the requestid" "$(mgc POST /api/vendor-bills/$VB4/send)|$(vb $VB4 "(b['syncStatus'], b['mayExistInQuickBooks'], b['reconcile']['kind'])")|$(mgc POST /api/vendor-bills/$VB4/send)|$(qbb ok '"connected":false'; mgc POST /api/vendor-bills/$VB4/retry)|$(qbb ok; mg POST /api/vendor-bills/$VB4/retry | jq "d['reconciled'], d['bill']['syncStatus']")|$(mgc POST /api/vendor-bills/$VB4/send)|$(fk "d['billRequestIds'][-1]==d['billRequestIds'][-2]=='$VB4'")|$(bills)" "502|('unknown', True, 'timeout')|409|409|not_found ready|200|True|(3, 6)"
V5=$(mkl C4-V5 "3/4 Rock" vulcan); VB5=$(nv $V5); qbb lost
chk "   bills 5. bill created, answer lost → unknown; the trip stays claimed; Void disconnected 409; re-bill refused" "$(mgc POST /api/vendor-bills/$VB5/send)|$(vb $VB5 "(b['syncStatus'], b['qbBillId']=='')")|$(load $V5 "l['trips'][0]['vendorBillId']=='$VB5'")|$(qbb ok '"connected":false'; mg POST /api/vendor-bills/$VB5/void '{"reason":"again"}' -w ' %{http_code}' | pc "d['code']")|$(mgc POST /api/vendor-bills "{\"loadIds\":[\"$V5\"]}")|$(bills)" "502|('unknown', True)|True|409 external_unknown|400|(4, 7)"
qbb ok
chk "   …bills 7. Retry = reconcile by our document number: found, adopted, no second create" "$(mg POST /api/vendor-bills/$VB5/retry | jq "d['recovered'], d['reconciled'], d['bill']['syncStatus'], d['bill']['qbBillId']!=''")|$(load $V5 "l['qbBillId']!=''")|$(bills)" "True found sent True|True|(4, 7)"
V6=$(mkl C4-V6 "3/4 Rock" vulcan); VB6=$(nv $V6); qbb http500
chk "   bills 6. 5xx after creation → unknown; 8. Void connected: found → removed in QuickBooks → released; one live bill after re-billing" "$(mgc POST /api/vendor-bills/$VB6/send)|$(vb $VB6 "b['reconcile']['kind']")|$(qbb ok; mg POST /api/vendor-bills/$VB6/void '{"reason":"wrong price"}' | jq "d['success'], d['qbDeleted'], d['bill']['syncStatus'], d['bill']['reconcile']['result']")|$(fk "d['billsDeleted']-$BD0")|$(load $V6 "l['trips'][0].get('vendorBillId',''), l['qbBillId']")|$(VB6b=$(nv $V6); mgc POST /api/vendor-bills/$VB6b/send)|$(bills)" "502|http_500|True True voided found|1| |200|(6, 9)"
V7=$(mkl C4-V7 "3/4 Rock" vulcan); VB7=$(nv $V7); qbb nobody
chk "   bills 7. 2xx with no bill in the body → unknown (no_entity_in_response); reconcile adopts it, no second create" "$(mgc POST /api/vendor-bills/$VB7/send)|$(vb $VB7 "b['reconcile']['kind']")|$(qbb ok; mg POST /api/vendor-bills/$VB7/retry | jq "d['recovered'], d['bill']['syncStatus']")|$(bills)" "502|no_entity_in_response|True sent|(7, 10)"
V8=$(mkl C4-V8 "3/4 Rock" vulcan); VB8=$(nv $V8); qbb http503
chk "   bills: 503 with nothing created → unknown (http_503); reconcile not_found → ready; Send creates it with the same requestid" "$(mgc POST /api/vendor-bills/$VB8/send)|$(vb $VB8 "(b['syncStatus'], b['reconcile']['kind'])")|$(qbb ok; mg POST /api/vendor-bills/$VB8/retry | jq "d['reconciled'], d['bill']['syncStatus']")|$(mgc POST /api/vendor-bills/$VB8/send)|$(fk "d['billRequestIds'][-1]==d['billRequestIds'][-2]=='$VB8'")|$(bills)" "502|('unknown', 'http_503')|not_found ready|200|True|(8, 12)"
V9=$(mkl C4-V9 "3/4 Rock" vulcan); VB9=$(nv $V9); qbb timeout; mgc POST /api/vendor-bills/$VB9/send >/dev/null; qbb ok '"connected":false'
chk "   bills: operator statement 'no bill in QuickBooks' releases an unknown bill, on the record" "$(mg POST /api/vendor-bills/$VB9/void '{"reason":"outage; checked by hand","confirmedNoBillInQuickBooks":true}' | jq "d['success'], d['bill']['syncStatus'], d['bill']['reconcile']['result']")|$(load $V9 "l['trips'][0].get('vendorBillId','')")|$(curl -s -b $M "$B/api/qb-sync-log?batchId=$VB9" | jq "any('checked by hand' in e['requestSummary'] for e in d['items'])")" "True voided operator_confirmed_absent||True"
qbb ok
V10=$(mkl C4-V10 "3/4 Rock" vulcan); VB10=$(nv $V10); qbb slow '"delayMs":1200'
R1=$(mktemp); R2=$(mktemp); mgc POST /api/vendor-bills/$VB10/send > $R1 & sleep 0.2; mgc POST /api/vendor-bills/$VB10/send > $R2 & wait
chk "   bills 10. simultaneous sends: one 200, one 409, one create request" "$(cat $R1 $R2 | tr -d '\n' | fold -w3 | sort | tr '\n' ' ')|$(bills)" "200 409 |(9, 14)"
qbb ok
chk "   static: the client sends Intuit's requestid on every create; the server never writes 'failed' for an uncertain error" "$(grep -c "requestid=" qb.js)|$(grep -c "requestId: b.id" server.js)|$(grep -c "markExternalUnknown(b, " server.js)" "1|4|7"
rm -f $RG

echo "── 54. Persistence 3 — an id is never handed out twice: not after a failed save, not under concurrency, not after a restart ──"
# LOAD-<n> and the auto PO number PO-<n> come from counters kept in the store AND as high-water marks outside it
# (in memory, never rolled back; beside the store on disk — data-ids.json here, the id_high_water row on Postgres).
maxload() { curl -s -b $M $B/api/data | jq "max((int(l['id'].split('-')[1]) for l in d['loads'] if l['id'].startswith('LOAD-')), default=0)"; }
maxpo()   { curl -s -b $M $B/api/data | jq "max((int(p['poNumber'][3:]) for p in d['pos'] if p['poNumber'].startswith('PO-') and p['poNumber'][3:].isdigit()), default=1000)"; }
po54()    { mg POST /api/pos '{"po":{"customer":"Id Co","deliveryDate":"'"$TODAY"'"},"splits":[{"truckId":"","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' -w ' %{http_code}' | pc "d.get('po',{}).get('poNumber') or d.get('error','')[:14]"; }
L0=$(maxload); P0=$(maxpo)
chk "54 sequential creation: the next load id and the next auto PO number are one past the highest on record" "$(po54)|$(maxload) $(maxpo)" "200 PO-$((P0+1))|$((L0+1)) $((P0+1))"
mg POST /api/_test/save-mode '{"mode":"fail","count":1}' >/dev/null
chk "   failed save: the ids the failed creation took are consumed, never handed out again — the next creation skips them (load id and PO number); the marks on disk are past them" "$(po54)|$(po54)|$(maxload) $(maxpo)|$(python3 -c "import json;d=json.load(open('data-ids.json'));print(d['load'] >= $((L0+4)), d['po'] >= $((P0+4)))")" "503 Unable to save|200 PO-$((P0+3))|$((L0+3)) $((P0+3))|True True"
rm -f /tmp/vbt-54-codes.txt; for i in $(seq 1 10); do mg POST /api/pos '{"po":{"customer":"Id Co","deliveryDate":"'"$TODAY"'"},"splits":[{"truckId":"","material":"Dirt","loadsAssigned":2,"vendorId":"vbt"}]}' -o /dev/null -w '%{http_code}\n' >> /tmp/vbt-54-codes.txt & done; wait
chk "   concurrent creation: ten POs (two loads each) at once → ten 200s; every PO id, PO number and load id on record is distinct" "$(sort /tmp/vbt-54-codes.txt | uniq -c | tr -s ' \n' ' ')|$(curl -s -b $M $B/api/data | jq "len(set(p['id'] for p in d['pos']))==len(d['pos']), len(set(p['poNumber'] for p in d['pos']))==len(d['pos']), len(set(l['id'] for l in d['loads']))==len(d['loads']), len([p for p in d['pos'] if p['customer']=='Id Co'])")" " 10 200 |True True True 12"
chk "   static: one load-id generator, one auto-PO-number generator, no timestamp-plus-random id left, the marks persist with every save in both modes, and are reconciled at boot, after a restore and before every id" "$(grep -c 'store.nextLoadId++' server.js)|$(grep -c 'store.nextPoNum++' server.js)|$(grep -c "Date.now() + '-' + Math.floor" server.js)|$(grep -c "'PO-' + Date.now()" server.js)|$(grep -c 'fs.writeFileSync(ID_HIGH_WATER_FILE' server.js)|$(grep -c "VALUES('id_high_water'" server.js)|$(grep -c 'reconcileIdCounters();' server.js)" "1|1|0|0|1|1|4"

echo "── 55. Persistence 4 — a read describes committed state only, a read never saves, the client copy only moves forward ──"
P=$(mg POST /api/pos '{"po":{"poNumber":"P4-1","customer":"Read Co","deliveryDate":"'"$TODAY"'"},"splits":[{"truckId":"","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"},{"truckId":"","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' | jq "d['po']['id']")
LA=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$P'][0]"); LB=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$P'][1]")
disk55() { python3 -c "import json;print([l['notes'] for l in json.load(open('data.json'))['loads'] if l['id']=='$1'][0])"; }
R0=$(curl -s $B/healthz | jq "d['persistence']['rollbacks']")
chk "55 save → GET: what a 200 answered is what the next read returns, in memory and on disk" "$(mgc PUT /api/loads/$LA '{"notes":"saved once"}')|$(load $LA "l['notes']")|$(disk55 $LA)" "200|saved once|saved once"
# A read arriving while a write is in flight waits for that write to settle; it never shows a value that is still being saved and may roll back.
mg POST /api/_test/save-mode '{"mode":"fail","count":1,"delayMs":1500}' >/dev/null
rm -f /tmp/vbt-55-w; (mgc PUT /api/loads/$LA '{"notes":"never committed"}' > /tmp/vbt-55-w) & sleep 0.3
T0=$(date +%s%N); SEEN=$(load $LA "l['notes']"); T1=$(date +%s%N); wait
mg POST /api/_test/save-mode '{"mode":"ok"}' >/dev/null
chk "   GET during a write whose save then fails: the read waited (≥ 1 s) and returned the committed value, never the one being saved; the write answered 503; memory, disk and the rollback count agree" "$SEEN|$(( (T1-T0)/1000000 >= 1000 ))|$(cat /tmp/vbt-55-w)|$(load $LA "l['notes']")|$(disk55 $LA)|$(curl -s $B/healthz | jq "d['persistence']['rollbacks'] - $R0")" "saved once|1|503|saved once|saved once|1"
mg POST /api/_test/save-mode '{"mode":"ok","delayMs":1200}' >/dev/null
(mgc PUT /api/loads/$LA '{"notes":"slow commit"}' > /tmp/vbt-55-w) & sleep 0.2
rm -f /tmp/vbt-55-g /tmp/vbt-55-g.?; for i in 1 2 3 4 5; do (load $LA "l['notes']" > /tmp/vbt-55-g.$i) & done; wait; cat /tmp/vbt-55-g.1 /tmp/vbt-55-g.2 /tmp/vbt-55-g.3 /tmp/vbt-55-g.4 /tmp/vbt-55-g.5 > /tmp/vbt-55-g   # one file per reader: five appends to one file can interleave
mg POST /api/_test/save-mode '{"mode":"ok"}' >/dev/null
chk "   five concurrent GETs during a slow successful write: every one waited and returned the committed new value — none the pre-save value, none a mix" "$(cat /tmp/vbt-55-w)|$(sort /tmp/vbt-55-g | uniq -c | tr -s ' \n' ' ')" "200| 5 slow commit "
chk "   write A → write B → GET: the read is B, and so is disk" "$(mgc PUT /api/loads/$LA '{"notes":"A"}') $(mgc PUT /api/loads/$LA '{"notes":"B"}')|$(load $LA "l['notes']")|$(disk55 $LA)" "200 200|B|B"
rm -f /tmp/vbt-55-a /tmp/vbt-55-b; (mgc PUT /api/loads/$LA '{"notes":"queued A"}' > /tmp/vbt-55-a) & (mgc PUT /api/loads/$LA '{"notes":"queued B"}' > /tmp/vbt-55-b) & wait
chk "   two writes queued at once → GET: both 200, the read is the one that ran last, and disk agrees with memory" "$(cat /tmp/vbt-55-a) $(cat /tmp/vbt-55-b)|$(python3 - "$(load $LA "l['notes']")" "$(disk55 $LA)" <<'PY'
import sys; mem,disk=sys.argv[1:3]; print(mem in ('queued A','queued B'), disk==mem)
PY
)" "200 200|True True"
# A client that drops its connection mid-write, then a read: the read is the committed state (the write landed; the lock outlived the socket — Persistence 1).
mg POST /api/_test/save-mode '{"mode":"ok","delayMs":1000}' >/dev/null
curl -s -b $M -H "$J" -X PUT $B/api/loads/$LA -d '{"notes":"dropped but saved"}' --max-time 0.3 -o /dev/null
chk "   client disconnect during a write → GET: the read waits for that write and returns what it committed; disk agrees" "$(load $LA "l['notes']")|$(disk55 $LA)" "dropped but saved|dropped but saved"
mg POST /api/_test/save-mode '{"mode":"ok"}' >/dev/null
# I21 — a read never saves. Plant a stale PO status (both loads done, the PO still says active), refuse every database write, and read.
mg POST /api/_test/set-load "{\"id\":\"$LA\",\"fields\":{\"status\":\"completed\",\"approvalStatus\":\"approved\",\"locked\":true}}" >/dev/null
mg POST /api/_test/set-load "{\"id\":\"$LB\",\"fields\":{\"status\":\"completed\",\"approvalStatus\":\"approved\",\"locked\":true}}" >/dev/null
R1=$(curl -s $B/healthz | jq "d['persistence']['rollbacks']"); S1=$(curl -s $B/healthz | jq "d['persistence']['lastSaveAt']")
mg POST /api/_test/save-mode '{"mode":"fail"}' >/dev/null
chk "   I21 — a read never saves: with the database refusing every write, GET /api/data answers 200, corrects the stale PO status in memory, and attempts no save (no rollback, lastSaveAt unchanged) — so a read can never sweep a concurrent write away" "$(curl -s -b $M -o /dev/null -w '%{http_code}' $B/api/data)|$(curl -s -b $M $B/api/data | jq "[p['status'] for p in d['pos'] if p['id']=='$P'][0]")|$(curl -s $B/healthz | jq "d['persistence']['rollbacks'] - $R1, d['persistence']['lastSaveAt'] == '$S1'")" "200|completed|0 True"
mg POST /api/_test/save-mode '{"mode":"ok"}' >/dev/null
chk "   …the correction reaches disk with the next real save (any write carries the whole store)" "$(mgc POST /api/customers '{"name":"Persist Co"}')|$(python3 -c "import json;print([p['status'] for p in json.load(open('data.json'))['pos'] if p['id']=='$P'][0])")" "200|completed"
chk "   static: no GET handler saves (the two PO-status reconciles are memory-only; the QuickBooks OAuth callback is the one documented exception); reads wait for writes in flight; a save with no owning request never rolls the store back" "$(python3 - <<'PY'
import re; src=open('server.js').read().split('\n'); bad=0
for i,l in enumerate(src):
    m=re.match(r"^(\s*)app\.get\(", l)
    if not m or 'quickbooks/callback' in l: continue
    ind=m.group(1); j=i+1
    while j<len(src) and not (src[j].startswith(ind+'});') and len(src[j])-len(src[j].lstrip())==len(ind)):
        if 'await saveData(' in src[j]: bad+=1
        j+=1
print(bad)
PY
)|$(grep -c "const inFlight = writeLockTail;" server.js)|$(grep -c "if (!ctx || ctx.keepOnFailure || !lastGoodJson) return false;" server.js)|$(grep -c "if (seq !== loadAllSeq)" public/index.html)|$(grep -c "if (seq !== todaySeq) return;" public/index.html)|$(grep -c "if (seq !== calSeq) return;" public/index.html)" "0|1|1|1|1|1"

echo "── 56. Persistence 5 — one authoritative state: Dispatch and Calendar read one row rule, one Ready-to-Bill rule, a stale copy changes only what it touched, the server decides ──"
# Everything here lives three weeks out, a day no other section touches, so no same-day conflict is accidental.
P5D=$(date -d '+21 day' +%F); P5D2=$(date -d '+22 day' +%F)
P5O=$(mktemp); curl -s -c $P5O -X POST -d "username=oscar&password=oscar123" $B/login -o /dev/null      # "the other tab": a second dispatcher
P5C=$(mktemp); curl -s -c $P5C -X POST -d "username=carlos&password=carlos123" $B/login -o /dev/null
og()  { curl -s -b $P5O -H "$J" -X "$1" "$B$2" -d "${3:-"{}"}"; }
ogc() { curl -s -b $P5O -H "$J" -X "$1" "$B$2" -d "${3:-"{}"}" -o /dev/null -w '%{http_code}'; }
p5po() { mg POST /api/pos "{\"po\":{\"poNumber\":\"$1\",\"customer\":\"Two Tab Co\",\"deliveryDate\":\"$P5D\",\"address\":\"1 Tab St\",\"city\":\"Fresno\",\"plannedVendorId\":\"vbt\"},\"splits\":[$2]}" | jq "d.get('po',{}).get('id') or d.get('error')"; }
p5loads() { curl -s -b $M $B/api/data | jq "','.join(l['id'] for l in d['loads'] if l['poId']=='$1')"; }
# The Dispatch row and the Calendar row for one load, compared field by field: the bucket when they agree, DIFF otherwise.
row56() { curl -s -b $M "$B/api/today?date=$2" > /tmp/vbt-56-t; curl -s -b $M "$B/api/calendar?from=$2&to=$2" > /tmp/vbt-56-c; python3 - "$1" <<'PY'
import sys,json
lid=sys.argv[1]; t=json.load(open('/tmp/vbt-56-t')); c=json.load(open('/tmp/vbt-56-c'))
keys=['bucket','driverId','truckUnitId','yardId','trailerId','loadsAssigned','loadsDelivered','approvalStatus','billStatus','deliveryDate','locked','poNumber','customer']
a=[r for r in t['loads'] if r['id']==lid]; b=[r for rows in c['days'].values() for r in rows if r['id']==lid]
if len(a)!=1 or len(b)!=1: print('dispatch:%d calendar:%d%s'%(len(a),len(b),' archived' if b and b[0].get('archived') else '')); sys.exit()
diff=[k for k in keys if a[0].get(k)!=b[0].get(k)]
print(a[0]['bucket'] if not diff else 'DIFF '+','.join(diff))
PY
}
# ── I10: a rejected load is its own bucket, on both screens ──
PR=$(p5po P5-R '{"truckId":"rigo","truckUnitId":"truck-14","material":"Sand","loadsAssigned":1,"vendorId":"vbt"}'); LR=$(p5loads $PR)
mg POST /api/_test/set-load "{\"id\":\"$LR\",\"fields\":{\"approvalStatus\":\"rejected\",\"rejectReason\":\"ticket unreadable\"}}" >/dev/null
chk "56 I10 — a rejected load is its own bucket on Dispatch and on the Calendar (never Assigned or In Progress), and the day's summary counts it" "$(row56 $LR $P5D)|$(curl -s -b $M "$B/api/today?date=$P5D" | jq "d['summary']['rejected']")|$(curl -s -b $M "$B/api/calendar?from=$P5D&to=$P5D" | jq "d['totals']['$P5D']['byBucket'].get('rejected')")" "rejected|1|1"
chk "   …a rejected load with no driver is Unassigned on both (the work needs a driver before anything else)" "$(mgc POST /api/loads/$LR/assign '{"driverId":null}')|$(row56 $LR $P5D)" "200|unassigned"
# ── I11: one Ready-to-Bill rule ──
PB=$(p5po P5-B '{"truckId":"","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"},{"truckId":"","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"},{"truckId":"","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"},{"truckId":"","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}')
IFS=, read LB1 LB2 LB3 LB4 <<< "$(p5loads $PB)"
rtb56() { echo "$(curl -s -b $M $B/api/ready-to-bill | jq "d['totals']['count']") $(curl -s -b $M "$B/api/today?date=$P5D" | jq "d['attention']['readyToBill']") $(curl -s -b $M $B/api/reports | jq "d['totals']['readyToBill']")"; }
read R0 A0 P0 <<< "$(rtb56)"
for x in $LB1 $LB2 $LB3; do mg POST /api/_test/set-load "{\"id\":\"$x\",\"fields\":{\"approvalStatus\":\"approved\",\"billStatus\":\"ready\",\"locked\":true}}" >/dev/null; done
BB2=$(mg POST /api/billing-batches "{\"loadIds\":[\"$LB2\"]}" | jq "d['batches'][0]['id']")                        # on a batch, not yet sent
mg POST /api/_test/set-load "{\"id\":\"$LB3\",\"fields\":{\"voided\":true,\"voidedAt\":\"2026-01-01T00:00:00Z\"}}" >/dev/null   # approved, then voided
mg POST /api/_test/set-load "{\"id\":\"$LB4\",\"fields\":{\"approvalStatus\":\"approved\",\"billStatus\":\"billed\",\"locked\":true,\"billedAt\":\"2026-01-01T00:00:00Z\",\"manualBillRef\":\"P5 fixture\"}}" >/dev/null
read R1 A1 P1 <<< "$(rtb56)"
chk "   I11 — one Ready-to-Bill rule: of four approved loads (plain, on an unsent batch, voided, billed) exactly one is Ready to Bill, and the strip, the Dispatch tile and the reports each moved by that same one" "${BB2:0:3}|$((R1-R0)) $((A1-A0)) $((P1-P0))|$(curl -s -b $M $B/api/ready-to-bill | jq "[x['id'] for x in d['items'] if x['poId']=='$PB']")" "BB-|1 1 1|['$LB1']"
chk "   …the tile's amount is the strip's total, and the batched load still reads Approved on the board (not Ready to Bill, not Billed)" "$(python3 -c "print($(curl -s -b $M "$B/api/today?date=$P5D" | jq "d['attention']['readyToBillAmount']") == $(curl -s -b $M $B/api/ready-to-bill | jq "d['totals']['amount']"))")|$(row56 $LB2 $P5D)" "True|ready-to-bill"
# ── Dispatch and Calendar agree through a load's whole life; two tabs approve and bill the same load at once ──
PC=$(p5po P5-C '{"truckId":"carlos","truckUnitId":"truck-2b","material":"Base Rock","loadsAssigned":1,"vendorId":"vbt"}'); LC=$(p5loads $PC)
S1=$(row56 $LC $P5D)
dc() { curl -s -b $P5C -H "$J" -X POST $B/api/loads/$LC/trip-action -d "$1" -o /dev/null -w '%{http_code} '; }
F1=$(dc '{"action":"start-trip"}'); S2=$(row56 $LC $P5D)
F2=$(dc '{"action":"arrived-pickup","yardId":"vbt"}'; dc "{\"action\":\"loaded\",\"ticket\":$(tkt)}"; dc '{"action":"arrived-jobsite"}'; dc '{"action":"trip-complete"}'); S3=$(row56 $LC $P5D)
F3=$(curl -s -b $P5C -H "$J" -X PUT $B/api/loads/$LC -d "{\"ticketImage\":\"$PNG\",\"pod\":{\"signedBy\":\"x\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null -w '%{http_code} '; dc '{"action":"delivered"}'); S4=$(row56 $LC $P5D)
chk "   Dispatch and Calendar agree at every step — created, started, delivered 1/1, submitted — field by field from one row rule" "$F1$F2$F3|$S1 → $S2 → $S3 → $S4" "200 200 200 200 200 200 200 |assigned → in-progress → in-progress → awaiting-approval"
rm -f /tmp/vbt-56-a1 /tmp/vbt-56-a2; (mgc POST /api/loads/$LC/approve > /tmp/vbt-56-a1) & (ogc POST /api/loads/$LC/approve > /tmp/vbt-56-a2) & wait
chk "   two tabs approve the same load at once: one 200, one 400 (no longer submitted); approved once, locked, by one of them; both screens say Ready to Bill" "$(for f in /tmp/vbt-56-a1 /tmp/vbt-56-a2; do cat $f; echo; done | sort | tr '\n' ' ')|$(load $LC "l['approvalStatus']+' '+str(l['locked'])+' '+str(l['approvedBy'] in ('Joshua','Oscar'))")|$(row56 $LC $P5D)" "200 400 |approved True True|ready-to-bill"
rm -f /tmp/vbt-56-b1 /tmp/vbt-56-b2; (mg POST /api/billing-batches "{\"loadIds\":[\"$LC\"]}" > /tmp/vbt-56-b1) & (og POST /api/billing-batches "{\"loadIds\":[\"$LC\"]}" > /tmp/vbt-56-b2) & wait
BC=$(python3 -c "
import json; r=[json.load(open('/tmp/vbt-56-b1')),json.load(open('/tmp/vbt-56-b2'))]; ok=[x for x in r if x.get('batches')]
print(len(ok), len([x for x in r if x.get('error')]), ok[0]['batches'][0]['id'] if ok else '')")
read BOK BERR BBC <<< "$BC"
chk "   two tabs bill the same load at once: one batch created, one refused (nothing eligible); the load belongs to exactly one batch" "$BOK $BERR|$(load $LC "l['billingBatchId']=='$BBC'")|$(curl -s -b $M $B/api/billing-batches | jq "sum(1 for b in d['items'] if '$LC' in b.get('loadIds',[]) and b['syncStatus']!='voided')")" "1 1|True|1"
chk "   …voiding that batch releases the load to Ready to Bill on both screens" "$(mgc POST /api/billing-batches/$BBC/void '{"reason":"bill it by hand"}')|$(row56 $LC $P5D)|$(load $LC "l['billStatus']+' '+str(bool(l.get('billingBatchId')))")" "200|ready-to-bill|ready False"
rm -f /tmp/vbt-56-m1 /tmp/vbt-56-m2; (mg POST /api/loads/bill "{\"loadIds\":[\"$LC\"],\"reference\":\"INV-P5\"}" | jq "d['billed']" > /tmp/vbt-56-m1) & (og POST /api/loads/bill "{\"loadIds\":[\"$LC\"],\"reference\":\"INV-P5-AGAIN\"}" | jq "d['billed']" > /tmp/vbt-56-m2) & wait
chk "   two tabs mark the same load billed by hand at once: billed once (1 then 0), one reference, one billedAt; both screens say Completed" "$(cat /tmp/vbt-56-m1 /tmp/vbt-56-m2 | sort | tr '\n' ' ')|$(load $LC "l['billStatus']+' '+str(l['manualBillRef'] in ('INV-P5','INV-P5-AGAIN'))+' '+str(bool(l.get('billedAt')))")|$(row56 $LC $P5D)" "0 1 |billed True True|completed"
# ── Two tabs put the same truck on two loads at once; a date change moves both screens together ──
PA=$(p5po P5-A '{"truckId":"","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"},{"truckId":"","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}'); IFS=, read LA1 LA2 <<< "$(p5loads $PA)"
rm -f /tmp/vbt-56-t1 /tmp/vbt-56-t2; (mgc POST /api/loads/$LA1/assign '{"driverId":"leonardo","truckUnitId":"truck-12"}' > /tmp/vbt-56-t1) & (ogc POST /api/loads/$LA2/assign '{"driverId":"beryle","truckUnitId":"truck-12"}' > /tmp/vbt-56-t2) & wait
WON=$(curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$PA' and l['truckUnitId']=='truck-12'][0]")
chk "   two tabs put Truck #12 on two loads the same day at once: one 200, one 409 (truck on the other driver's load); exactly one load holds the truck, the other is still Unassigned on both screens" "$(for f in /tmp/vbt-56-t1 /tmp/vbt-56-t2; do cat $f; echo; done | sort | tr '\n' ' ')|$(curl -s -b $M $B/api/data | jq "sum(1 for l in d['loads'] if l['poId']=='$PA' and l['truckUnitId']=='truck-12')")|$(row56 $WON $P5D) $(row56 $([ "$WON" = "$LA1" ] && echo $LA2 || echo $LA1) $P5D)" "200 409 |1|assigned unassigned"
chk "   a PO date change: both loads leave the old day and arrive on the new one, on Dispatch and on the Calendar alike" "$(mgc PUT /api/pos/$PA "{\"deliveryDate\":\"$P5D2\"}")|$(row56 $LA1 $P5D) $(row56 $LA2 $P5D)|$(row56 $WON $P5D2)" "200|dispatch:0 calendar:0 dispatch:0 calendar:0|assigned"
# ── A stale copy changes only what it touched; the server applies exactly the fields it is given ──
chk "   stale sheet: tab B moves the load to Matthew on Truck #4; tab A, opened earlier, changes only the pickup yard and sends only that — the load keeps tab B's driver and truck and takes tab A's yard" "$(ogc POST /api/loads/$WON/assign '{"driverId":"matthew","truckUnitId":"truck-4"}') $(mgc POST /api/loads/$WON/assign '{"yardId":"vulcan"}')|$(load $WON "l['truckId']+' '+l['truckUnitId']+' '+l['vendorId']")" "200 200|matthew truck-4 vulcan"
chk "   …and a stale copy cannot bypass the server: on an approved, locked load an edit, an assignment and a second approval are refused; the PO's invoice fields are frozen" "$(mgc PUT /api/loads/$LB1 '{"notes":"from a stale tab"}') $(mgc POST /api/loads/$LB1/assign '{"driverId":"carlos"}') $(mgc POST /api/loads/$LB1/approve) $(mgc PUT /api/pos/$PB '{"customer":"Someone Else"}')" "403 403 400 403"
# ── Archive vs a stale tab; a deleted PO vs a stale tab ──
mg POST /api/history/archive >/dev/null     # the manually billed load (and the billed fixture) leave the live lists
chk "   archive vs a stale tab: the archived load is off Dispatch and stays on the Calendar as history; the stale tab's update, assign, approve and void are refused (404); a stale manual bill bills nothing" "$(row56 $LC $P5D)|$(mgc PUT /api/loads/$LC '{"notes":"x"}') $(mgc POST /api/loads/$LC/assign '{"driverId":"carlos"}') $(mgc POST /api/loads/$LC/approve) $(mgc POST /api/loads/$LC/void '{"reason":"x"}')|$(mg POST /api/loads/bill "{\"loadIds\":[\"$LC\"],\"reference\":\"again\"}" | jq "d['billed']")" "dispatch:0 calendar:1 archived|404 404 404 404|0"
PD=$(p5po P5-D '{"truckId":"","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}'); LD=$(p5loads $PD)
chk "   deleted PO vs a stale tab: the other tab deletes the PO (200); the stale tab's assign and edit are refused (404); neither screen shows the load" "$(ogc DELETE /api/pos/$PD)|$(mgc POST /api/loads/$LD/assign '{"driverId":"carlos"}') $(mgc PUT /api/loads/$LD '{"notes":"x"}')|$(row56 $LD $P5D)" "200|404 404|dispatch:0 calendar:0"
chk "   static: the sheet, the customer form and the fleet rows send only what changed; one Ready-to-Bill rule in the strip, the tile, the reports and the fingerprint; the rejected bucket; the poll repaints History too; both screens label Rejected" "$(grep -c "const body = qaChanges();" public/index.html)|$(grep -c "qaBase = { ...qaPick };" public/index.html)|$(grep -c "cmBase = isEdit ? { ...c } : null;" public/index.html)|$(grep -c "changedFields(" public/index.html)|$(grep -c "isReadyToBill" server.js)|$(grep -c "if (l.approvalStatus === 'rejected' && l.truckId && l.truckId !== 'unassigned') return 'rejected';" server.js)|$(grep -c "else if (currentTab === 'history') renderHistory();" public/index.html)|$(grep -c "rejected: 'Rejected'" public/index.html)" "1|1|1|5|6|1|1|3"   # OA1: the board row carries the one rule too (readyToBill); Load Details labels Rejected; OA6 closure: the yard edit is the fourth form on changedFields

echo "── 57. Persistence 6 — a rollback never reaches a QuickBooks record in flight; a background save never rolls back; a refused request changes nothing; history keeps its PO ──"
P6D=$(date -d '+30 day' +%F)
P6U='{"truckId":"","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}'
p6po() { mg POST /api/pos "{\"po\":{\"poNumber\":\"$1\",\"customer\":\"$2\",\"deliveryDate\":\"$P6D\",\"plannedVendorId\":\"vbt\"},\"splits\":[$3]}" | jq "d.get('po',{}).get('id') or d.get('error')"; }
p6loads() { curl -s -b $M $B/api/data | jq "','.join(l['id'] for l in d['loads'] if l['poId']=='$1')"; }
p6ok() { for x in "$@"; do mg POST /api/_test/set-load "{\"id\":\"$x\",\"fields\":{\"approvalStatus\":\"approved\",\"billStatus\":\"ready\",\"locked\":true}}" >/dev/null; done; }
p6bt() { curl -s -b $M $B/api/billing-batches/$1 | jq "$2"; }
p6disk() { python3 -c "import json;d=json.load(open('data.json'));$1"; }
# The send's own answer: code, success, status, and whether the invoice id it reports is the one on record.
p6ans() { python3 -c "import json,sys;t=open(sys.argv[1]).read();code=t.rsplit(' ',1)[1];d=json.loads(t.rsplit(' ',1)[0]);b=d.get('batch',{});print(code, d.get('success'), b.get('syncStatus'), bool(b.get('qbInvoiceId')) and b.get('qbInvoiceId')==sys.argv[2])" "$1" "$2"; }
R57=$(curl -s $B/healthz | jq "d['persistence']['rollbacks']")
# ── A QuickBooks send runs outside the write lock; a locked request's failed save meanwhile rolls the store back ──
PA=$(p6po P6-A "Sixth Co" "$P6U"); LA=$(p6loads $PA); PX=$(p6po P6-X "Sixth Co" "$P6U"); LX=$(p6loads $PX); p6ok $LA
mg POST /api/_test/qb-fake '{"mode":"ok"}' >/dev/null
BA=$(mg POST /api/billing-batches "{\"loadIds\":[\"$LA\"]}" | jq "d['batches'][0]['id']")
mg POST /api/_test/qb-fake '{"mode":"slow","delayMs":2000}' >/dev/null
(mg POST /api/billing-batches/$BA/send '{}' -w ' %{http_code}' > /tmp/vbt-57-a) & sleep 0.6
mg POST /api/_test/save-mode '{"mode":"fail","count":1}' >/dev/null
XA=$(mgc PUT /api/loads/$LX '{"notes":"other tab"}'); wait
mg POST /api/_test/qb-fake '{"mode":"ok"}' >/dev/null
chk "57 a QuickBooks send in flight while ANOTHER request's save is refused and rolled back (503, one rollback): the send still lands on the record — batch sent with its invoice, load billed, disk agrees; it is a sent batch (a second send 400) and can be voided" "$XA|$(p6ans /tmp/vbt-57-a "$(p6bt $BA "d['batch']['qbInvoiceId']")")|$(p6bt $BA "d['batch']['syncStatus']")|$(load $LA "l['billStatus']+' '+str(bool(l['qbInvoiceId']))")|$(p6disk "b=[x for x in d['billingBatches'] if x['id']=='$BA'][0];l=[x for x in d['loads'] if x['id']=='$LA'][0];print(b['syncStatus'], l['billStatus'])")|$(mgc POST /api/billing-batches/$BA/send) $(mgc POST /api/billing-batches/$BA/void '{"reason":"test"}')|$(curl -s $B/healthz | jq "d['persistence']['rollbacks'] - $R57")" "503|200 True sent_to_quickbooks True|sent_to_quickbooks|billed True|sent_to_quickbooks billed|400 200|1"
PB=$(p6po P6-B "Sixth Co" "$P6U"); LB=$(p6loads $PB); p6ok $LB
BB=$(mg POST /api/billing-batches "{\"loadIds\":[\"$LB\"]}" | jq "d['batches'][0]['id']")
mg POST /api/_test/qb-fake '{"mode":"slow","delayMs":1000}' >/dev/null
(mg POST /api/billing-batches/$BB/send '{}' -w ' %{http_code}' > /tmp/vbt-57-b) & sleep 0.3
mg POST /api/_test/save-mode '{"mode":"fail","count":1,"delayMs":1500}' >/dev/null
XB=$(mgc PUT /api/loads/$LX '{"notes":"other tab 2"}'); wait
mg POST /api/_test/save-mode '{"mode":"ok"}' >/dev/null; mg POST /api/_test/qb-fake '{"mode":"ok"}' >/dev/null
chk "   …the rollback lands BETWEEN QuickBooks' answer and the send's own save (the other request's save was in flight the whole time): batch sent, load billed, memory = disk" "$XB|$(p6ans /tmp/vbt-57-b "$(p6bt $BB "d['batch']['qbInvoiceId']")")|$(load $LB "l['billStatus']+' '+str(bool(l['qbInvoiceId']))")|$(p6disk "b=[x for x in d['billingBatches'] if x['id']=='$BB'][0];l=[x for x in d['loads'] if x['id']=='$LB'][0];print(b['syncStatus'], l['billStatus'])")" "503|200 True sent_to_quickbooks True|billed True|sent_to_quickbooks billed"
PC=$(p6po P6-C "Sixth Co" "$P6U"); LC=$(p6loads $PC); p6ok $LC
BC=$(mg POST /api/billing-batches "{\"loadIds\":[\"$LC\"]}" | jq "d['batches'][0]['id']")
I0=$(curl -s -b $M $B/api/_test/qb-fake | jq "d['invoicesCreated']")
mg POST /api/_test/save-mode '{"mode":"fail","count":1}' >/dev/null
C1=$(mgc POST /api/billing-batches/$BC/send); mg POST /api/_test/save-mode '{"mode":"ok"}' >/dev/null
chk "   the database refuses the save that marks a batch 'syncing': 503, nothing sent, and the batch is NOT left 'syncing' (send, void and restore would refuse it until a restart) — it is sendable again, and then sends exactly once" "$C1|$(p6bt $BC "d['batch']['syncStatus']")|$(mgc POST /api/billing-batches/$BC/send)|$(p6bt $BC "d['batch']['syncStatus']")|$(curl -s -b $M $B/api/_test/qb-fake | jq "d['invoicesCreated'] - $I0")" "503|ready_to_bill|200|sent_to_quickbooks|1"
# ── A background save (the notification log, after the mail went out) runs with no request context ──
PN=$(p6po P6-N "Sixth Co" "$P6U"); LN=$(p6loads $PN)
mg PUT /api/pos/$PN/notifications '{"contacts":[{"name":"Pat","email":"pat@example.com"}],"events":{"driverAssigned":true},"enabled":true}' >/dev/null
R1=$(curl -s $B/healthz | jq "d['persistence']['rollbacks']")
mg POST /api/_test/save-mode '{"mode":"fail","after":1,"count":1,"delayMs":1200}' >/dev/null
N1=$(mgc POST /api/loads/$LN/assign '{"driverId":"matthew","truckUnitId":"truck-4"}')      # its own save: fine; the mail callback's save, queued behind it: refused
N2=$(mgc PUT /api/loads/$LX '{"notes":"survives the background failure"}')                  # arrives while that background save is in flight
sleep 1.6; mg POST /api/_test/save-mode '{"mode":"ok"}' >/dev/null
chk "   a background save that the database refuses never rolls the store back: the request that arrived meanwhile (200) keeps its change in memory and on disk; no rollback counted; the notification log recorded the mail" "$N1 $N2|$(load $LX "l['notes']")|$(p6disk "print([l['notes'] for l in d['loads'] if l['id']=='$LX'][0])")|$(curl -s $B/healthz | jq "d['persistence']['rollbacks'] - $R1")|$(curl -s -b $M "$B/api/notifications/log?limit=2000" | jq "sum(1 for n in d.get('items',[]) if n.get('loadId')=='$LN' and n.get('to')=='pat@example.com') >= 1")" "200 200|survives the background failure|survives the background failure|0|True"
# ── A refused request changes nothing ──
PM6=$(p6po P6-M "Sixth Co" "$P6U,$P6U"); IFS=, read LM1 LM2 <<< "$(p6loads $PM6)"; p6ok $LM1 $LM2
BM=$(mg POST /api/billing-batches "{\"loadIds\":[\"$LM2\"]}" | jq "d['batches'][0]['id']")
A0=$(p6disk "print(len([a for a in d['auditLog'] if a.get('action')=='marked-billed']))")
chk "   manual bill refused (one of the loads is on a batch, 409): the other load is NOT marked billed — not in memory, not on disk after the next save, no audit entry; billed on its own it is billed once, with its reference" "$(mgc POST /api/loads/bill "{\"loadIds\":[\"$LM1\",\"$LM2\"],\"reference\":\"INV-M\"}")|$(load $LM1 "l['billStatus']+' '+str(l.get('manualBillRef'))")|$(mgc POST /api/customers '{"name":"Sixth Save Co"}')|$(p6disk "print([l['billStatus'] for l in d['loads'] if l['id']=='$LM1'][0], len([a for a in d['auditLog'] if a.get('action')=='marked-billed']) - $A0)")|$(mg POST /api/loads/bill "{\"loadIds\":[\"$LM1\"],\"reference\":\"INV-M\"}" | jq "d['billed']")|$(load $LM1 "l['billStatus']+' '+l['manualBillRef']")" "409|ready None|200|ready 0|1|billed INV-M"
CI=$(curl -s -b $M $B/api/data | jq "[c['id'] for c in d['customers'] if c['name']=='Sixth Co'][0]")
chk "   customer update refused (bad billing basis, 400): the master is NOT renamed and its POs keep their customer; the valid update renames both" "$(mgc PUT /api/customers/$CI '{"name":"Sixth Renamed","billingBasis":"bogus"}')|$(curl -s -b $M $B/api/data | jq "[c['name'] for c in d['customers'] if c['id']=='$CI'][0]+' / '+[p['customer'] for p in d['pos'] if p['id']=='$PN'][0]")|$(mgc PUT /api/customers/$CI '{"name":"Sixth Renamed","billingBasis":"actual"}')|$(curl -s -b $M $B/api/data | jq "[c['name'] for c in d['customers'] if c['id']=='$CI'][0]+' / '+[p['customer'] for p in d['pos'] if p['id']=='$PN'][0]")" "400|Sixth Co / Sixth Co|200|Sixth Renamed / Sixth Renamed"
# ── History keeps its PO ──
PH=$(p6po P6-H "Archive Co" "$P6U,$P6U"); IFS=, read LH1 LH2 <<< "$(p6loads $PH)"
mg POST /api/_test/set-load "{\"id\":\"$LH1\",\"fields\":{\"approvalStatus\":\"approved\",\"billStatus\":\"billed\",\"locked\":true,\"billedAt\":\"2026-01-01T00:00:00Z\",\"manualBillRef\":\"INV-H\"}}" >/dev/null
AR=$(mg POST /api/history/archive | jq "d['archived']['batchId']")
chk "   a PO whose billed load is archived (the PO stays live for its unbilled load): invoice fields frozen (403), delete refused (403), a note still saves (200); the archived load keeps its PO on the Calendar; unarchive works" "$(curl -s -b $M $B/api/data | jq "any(p['id']=='$PH' for p in d['pos'])")|$(mgc PUT /api/pos/$PH '{"customer":"Someone Else"}') $(mgc DELETE /api/pos/$PH) $(mgc PUT /api/pos/$PH '{"notes":"still editable"}')|$(curl -s -b $M "$B/api/calendar?from=$P6D&to=$P6D" | jq "[(r['poNumber'], r['archived']) for day in d['days'].values() for r in day if r['id']=='$LH1']")|$(mgc POST /api/history/$AR/unarchive '{"reason":"test"}')" "True|403 403 200|[('P6-H', True)]|200"
PV=$(p6po P6-V "Void Co" "$P6U,$P6U"); IFS=, read LV1 LV2 <<< "$(p6loads $PV)"
mg POST /api/_test/set-load "{\"id\":\"$LV1\",\"fields\":{\"approvalStatus\":\"approved\",\"billStatus\":\"billed\",\"locked\":true,\"billedAt\":\"2026-01-01T00:00:00Z\",\"manualBillRef\":\"INV-V\"}}" >/dev/null
p6ok $LV2; mg POST /api/loads/$LV2/void '{"reason":"duplicate"}' >/dev/null
AV=$(mg POST /api/history/archive | jq "d['archived']['batchId']")
chk "   a voided load whose PO went to the archive (every unvoided load on it billed): unvoid is refused (409 po_archived) — it would sit in Ready to Bill with no PO; after unarchiving, unvoid works and the load is Ready to Bill under its PO" "$(curl -s -b $M $B/api/data | jq "str(any(p['id']=='$PV' for p in d['pos']))+' '+str(any(l['id']=='$LV2' for l in d['loads']))")|$(mg POST /api/loads/$LV2/unvoid | jq "d.get('code')")|$(mgc POST /api/history/$AV/unarchive '{"reason":"test"}')|$(mgc POST /api/loads/$LV2/unvoid)|$(curl -s -b $M $B/api/ready-to-bill | jq "[x['poNumber'] for x in d['items'] if x['id']=='$LV2']")" "False True|po_archived|200|200|['P6-V']"
# ── Reconciliation names the batch exactly; the generators and guards are in place ──
chk "   the QuickBooks invoice lookup names the batch exactly: 'batch BB-1-1' is no match for a note about BB-1-12, a match for its own note, never a voided invoice's note" "$(QB_ENCRYPTION_KEY=test-only-key node -e "const q=require('./qb.js');console.log(q.invoiceNoteNamesBatch('VBT Dispatch billing batch BB-1-12. PO 7. Loads: LOAD-1','BB-1-1'), q.invoiceNoteNamesBatch('VBT Dispatch billing batch BB-1-1. PO 7. Loads: LOAD-1','BB-1-1'), q.invoiceNoteNamesBatch('Voided: VBT Dispatch billing batch BB-1-1. PO 7','BB-1-1'))")" "false true false"
chk "   static: ids keep a per-millisecond sequence (a vendor bill id is its 21-char QuickBooks DocNumber); the notification mail runs outside the request context; QuickBooks records are pinned across a rollback; a refused 'syncing' save is undone (two routes); manual bill decides before it marks; the customer update refuses before it changes; PO edit and delete see archived loads; unvoid needs a live PO; the test fake uses the real matcher" "$(grep -c "if (now !== idSeqMs) { idSeqMs = now; idSeq = 0; }" server.js)|$(grep -c "requestCtx.exit(() => {" server.js)|$(grep -c "const unpin = pinExemptRecords(urlPath);" server.js)|$(grep -c "const pins = \[...pinnedRecords\];" server.js)|$(grep -c "const wasStatus = b.syncStatus;" server.js)|$(grep -c "const skipped = eligible.filter(l => l.billingBatchId || l.qbInvoiceId).map(l => l.id);" server.js)|$(grep -c "if (req.body.billingBasis !== undefined && !BILLING_BASES.includes(req.body.billingBasis)) return res.status(400)" server.js)|$(grep -c "allLoadsWithArchive().some(l => l.poId === old.id\|allLoadsWithArchive().filter(l => l.poId === req.params.id)" server.js)|$(grep -c "code: 'po_archived'" server.js)|$(grep -c "qb.invoiceNoteNamesBatch(i.PrivateNote, batchId)" server.js)" "1|1|1|1|2|1|1|3|1|1"

echo "── 58. Persistence 7 — the final gate: a refused request changes nothing, two dispatchers at once, a vendor bill through a rollback, the fleet is the office's ──"
P7D=$(date -d '+35 day' +%F)
P7U='{"truckId":"","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}'
p7po() { mg POST /api/pos "{\"po\":{\"poNumber\":\"$1\",\"customer\":\"$2\",\"deliveryDate\":\"$P7D\",\"plannedVendorId\":\"vbt\"},\"splits\":[$3]}" | jq "d.get('po',{}).get('id') or d.get('error')"; }
p7loads() { curl -s -b $M $B/api/data | jq "','.join(l['id'] for l in d['loads'] if l['poId']=='$1')"; }
p7disk() { python3 -c "import json;d=json.load(open('data.json'));$1"; }
p7fleet() { curl -s -b $M $B/api/fleet | jq "$1"; }
p7cost() { curl -s -b $M $B/api/costing/settings | jq "$1"; }
# ── A refused request changes nothing (the remaining mutate-then-refuse routes) ──
TR7=$(mg POST /api/fleet/trailers '{"number":"P7-TR","type":"Transfer"}' | jq "d['trailer']['id']")
TN7=$(p7fleet "[t['truckNum'] for t in d['trucks'] if t['id']=='truck-4'][0]")
chk "58 fleet forms refuse before they change: a truck update with a bad status (400) leaves the number as it was; a trailer update with a bad status (400) leaves its number as it was; a valid change still lands" "$(mgc PUT /api/fleet/trucks/truck-4 '{"truckNum":"Truck #Z","status":"bogus"}') $(python3 -c "print($(p7fleet "repr([t['truckNum'] for t in d['trucks'] if t['id']=='truck-4'][0])") == '$TN7')")|$(mgc PUT /api/fleet/trailers/$TR7 '{"number":"P7-TR-2","status":"bogus"}') $(p7fleet "[t['number'] for t in d['trailers'] if t['id']=='$TR7'][0]")|$(mgc PUT /api/fleet/trailers/$TR7 '{"status":"maintenance"}') $(p7fleet "[t['status'] for t in d['trailers'] if t['id']=='$TR7'][0]")" "400 True|400 P7-TR|200 maintenance"
PN7=$(p7po P7-N "Seventh Co" "$P7U")
mg PUT /api/pos/$PN7/notifications '{"contacts":[{"name":"Pat","email":"pat@example.com"}],"events":{"delivered":true},"enabled":true}' >/dev/null
chk "   notification settings refuse before they change: turning updates on with an empty contact list (400) keeps the contact and the events that were there" "$(mgc PUT /api/pos/$PN7/notifications '{"contacts":[],"events":{"loaded":true},"enabled":true}')|$(curl -s -b $M $B/api/pos/$PN7/notifications | jq "str(len(d['notifications']['contacts']))+' '+str(d['notifications']['events'].get('loaded', False))+' '+str(d['notifications']['enabled'])")" "400|1 False True"
U0=$(p7cost "repr(d.get('unitConfig',{}).get('byUnit',{}).get('ton'))"); W0=$(p7cost "repr(d.get('costRates',{}).get('driverWagePerHour'))")
chk "   costing refuses before it changes: a bad material quantity (400) leaves the unit table as it was; a bad later rate (400) leaves the earlier rate as it was" "$(mgc PUT /api/costing/units '{"byUnit":{"ton":26},"byMaterial":{"Dirt":{"ton":-1}}}') $(python3 -c "print($(p7cost "repr(d.get('unitConfig',{}).get('byUnit',{}).get('ton'))") == $U0)")|$(mgc PUT /api/costing/rates '{"driverWagePerHour":31,"fuelPricePerGallon":-1}') $(python3 -c "print($(p7cost "repr(d.get('costRates',{}).get('driverWagePerHour'))") == $W0)")" "400 True|400 True"
chk "   a PO refused for a duplicate number (409) adds no customer to the master" "$(mgc POST /api/pos "{\"po\":{\"poNumber\":\"P7-N\",\"customer\":\"Stray Seventh Co\",\"deliveryDate\":\"$P7D\"},\"splits\":[$P7U]}")|$(curl -s -b $M $B/api/data | jq "any(c['name']=='Stray Seventh Co' for c in d['customers'])")" "409|False"
# ── Two dispatchers at once ──
PA7=$(p7po P7-A "Seventh Co" "$P7U,$P7U"); IFS=, read LA7 LB7 <<< "$(p7loads $PA7)"
P7O=$(mktemp); curl -s -c $P7O -X POST -d "username=oscar&password=oscar123" $B/login -o /dev/null
oc() { curl -s -b $P7O -H "$J" -X "$1" "$B$2" -d "${3:-"{}"}" -o /dev/null -w '%{http_code}'; }
rm -f /tmp/vbt-58-1 /tmp/vbt-58-2; (mgc POST /api/loads/$LA7/assign '{"driverId":"matthew","truckUnitId":"truck-4"}' > /tmp/vbt-58-1) & (oc POST /api/loads/$LB7/assign '{"driverId":"matthew","truckUnitId":"truck-4"}' > /tmp/vbt-58-2) & wait
chk "   two dispatchers queue two loads for the same idle driver on his truck at once: both 200 (a driver's next job is queued, not refused), both loads on Matthew / Truck #4, on disk too" "$(for f in /tmp/vbt-58-1 /tmp/vbt-58-2; do cat $f; echo; done | sort | tr '\n' ' ')|$(curl -s -b $M $B/api/data | jq "sorted((l['truckId'], l['truckUnitId']) for l in d['loads'] if l['poId']=='$PA7')")|$(p7disk "print(sorted((l['truckId'], l['truckUnitId']) for l in d['loads'] if l['poId']=='$PA7'))")" "200 200 |[('matthew', 'truck-4'), ('matthew', 'truck-4')]|[('matthew', 'truck-4'), ('matthew', 'truck-4')]"
rm -f /tmp/vbt-58-3 /tmp/vbt-58-4; (mgc PUT /api/loads/$LA7 '{"notes":"from Joshua"}' > /tmp/vbt-58-3) & (oc PUT /api/loads/$LA7 '{"loadsAssigned":3}' > /tmp/vbt-58-4) & wait
chk "   two dispatchers edit the same load at once, different fields: both 200, both changes on the record and on disk — neither write lost the other's" "$(for f in /tmp/vbt-58-3 /tmp/vbt-58-4; do cat $f; echo; done | sort | tr '\n' ' ')|$(load $LA7 "l['notes']+' '+str(l['loadsAssigned'])")|$(p7disk "l=[x for x in d['loads'] if x['id']=='$LA7'][0];print(l['notes'], l['loadsAssigned'])")" "200 200 |from Joshua 3|from Joshua 3"
# ── A driver's refused submission stamps nothing; then a vendor bill through a rollback ──
PT7=$(p7po P7-T "Seventh Co" '{"truckId":"carlos","truckUnitId":"truck-2b","material":"3/4 Rock","loadsAssigned":2,"vendorId":"vulcan"}'); LT7=$(p7loads $PT7)
P7C=$(mktemp); curl -s -c $P7C -X POST -d "username=carlos&password=carlos123" $B/login -o /dev/null
d7() { curl -s -b $P7C -H "$J" -X POST $B/api/loads/$LT7/trip-action -d "$1" -o /dev/null -w '%{http_code} '; }
T1=$(d7 '{"action":"start-trip"}'; d7 '{"action":"arrived-pickup","yardId":"vulcan"}'; d7 "{\"action\":\"loaded\",\"ticket\":$(tkt)}"; d7 '{"action":"arrived-jobsite"}'; curl -s -b $P7C -H "$J" -X PUT $B/api/loads/$LT7 -d "{\"ticketImage\":\"$PNG\",\"pod\":{\"signedBy\":\"x\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null -w '%{http_code} ')
chk "   a driver's Stop-early submission with a count that disagrees (400) stamps nothing: the trip at the jobsite is not completed by a refused request; the right count (1) completes it and submits" "$T1|$(d7 '{"action":"incomplete","delivered":5}')$(load $LT7 "str(bool(l['trips'][0]['timestamps'].get('completed')))+' '+str(l['loadsDelivered'])")|$(d7 '{"action":"incomplete","delivered":1}')$(load $LT7 "str(bool(l['trips'][0]['timestamps'].get('completed')))+' '+str(l['loadsDelivered'])+' '+l['approvalStatus']")" "200 200 200 200 200 |400 False 0|200 True 1 submitted"
A7=$(mgc POST /api/loads/$LT7/approve)
VB7=$(mg POST /api/vendor-bills "{\"loadIds\":[\"$LT7\"]}" | jq "(d.get('bills') or [{}])[0].get('id') or d.get('error')")
mg POST /api/_test/qb-fake '{"mode":"ok","billMode":"slow","delayMs":2000}' >/dev/null
(mg POST /api/vendor-bills/$VB7/send '{}' -w ' %{http_code}' > /tmp/vbt-58-vb) & sleep 0.6
mg POST /api/_test/save-mode '{"mode":"fail","count":1}' >/dev/null
XV=$(mgc PUT /api/loads/$LB7 '{"notes":"other tab"}'); wait
mg POST /api/_test/qb-fake '{"mode":"ok","billMode":"ok"}' >/dev/null
chk "   a vendor bill send in flight while another request's save is refused and rolled back (503): the bill is sent with its QuickBooks id, the load keeps the bill's claim and its QuickBooks bill id, memory = disk" "$A7 ${VB7:0:3}|$XV|$(python3 -c "import json;t=open('/tmp/vbt-58-vb').read();code=t.rsplit(' ',1)[1];d=json.loads(t.rsplit(' ',1)[0]);b=d.get('bill',{});print(code, d.get('success'), b.get('syncStatus'), bool(b.get('qbBillId')))")|$(curl -s -b $M $B/api/vendor-bills | jq "[b['syncStatus']+' '+str(bool(b['qbBillId'])) for b in d['items'] if b['id']=='$VB7'][0]")|$(load $LT7 "str(bool(l.get('qbBillId')))+' '+str('$VB7' in (l.get('vendorBillIds') or []))")|$(p7disk "b=[x for x in d['vendorBills'] if x['id']=='$VB7'][0];l=[x for x in d['loads'] if x['id']=='$LT7'][0];print(b['syncStatus'], bool(b['qbBillId']), bool(l.get('qbBillId')), '$VB7' in (l.get('vendorBillIds') or []))")" "200 VB-|503|200 True sent True|sent True|True True|sent True True True"
# ── The fleet and the roster are the office's: a refused change never half-applies, and nothing is re-seeded ──
chk "   static: seed trucks, drivers and logins are planted once (never re-added onto a store that has a fleet or a roster, never re-inserted into a users table with logins); the fleet, notification, costing, PO-create and submission routes refuse before they change; the login row goes first on a driver update and is removed after a failed save on a driver create; a QuickBooks refusal still saves refreshed tokens" "$(grep -c "if (!store.trucks.some(t => t && !isLegacyDriverRow(t))) {" server.js)|$(grep -c "if (store.drivers.length === 0) TRUCKS.forEach(d => {" server.js)|$(grep -c "seed logins not re-inserted" server.js)|$(grep -c "if (b.status !== undefined && !TRUCK_STATUSES.includes(b.status)) return res.status(400)" server.js)|$(grep -c "const num = b.number !== undefined && String(b.number).trim() ? String(b.number).trim() : null;" server.js)|$(grep -c "if (clean !== null) po.notifications.contacts = clean;" server.js)|$(grep -c "let unitOut = null; const matOut = {};" server.js)|$(grep -c "Object.assign(store.costRates, next);" server.js)|$(grep -c "// Every check passed. If a customerId was supplied" server.js)|$(grep -c "if (willComplete) stampBoth('completed');" server.js)|$(python3 -c "
import re;s=open('server.js').read();a=s.index(\"upsertRosterDriver({ id: uname, name: b.displayName\");b=s.index(\"UPDATE users SET \${sets.join\");print(a>b)")|$(grep -c "could not remove the login after a failed save" server.js)|$(grep -c "await saveConnectionQuietly();" server.js)" "1|1|1|1|1|1|1|1|1|1|True|1|6"

echo
echo "── 59. Operational audit 1 — unfinished work holds its driver and truck on today's board; the board row, the reports and Material Costs say what the office needs ──"
O1Y=$(TZ=America/Los_Angeles date -d yesterday +%F); O1T=$(TZ=America/Los_Angeles date -d tomorrow +%F)
mg POST /api/drivers '{"username":"dana","password":"dana1234","displayName":"Dana"}' >/dev/null
T59=$(mg POST /api/fleet/trucks '{"truckNum":"Truck #59","type":"End Dump"}' | jq "d['truck']['id']")
DA=$(mktemp); curl -s -c $DA -X POST -d "username=dana&password=dana1234" $B/login -o /dev/null
o1po()  { mg POST /api/pos "{\"po\":{\"poNumber\":\"$1\",\"customer\":\"$2\",\"deliveryDate\":\"$3\",\"plannedVendorId\":\"$4\"},\"splits\":[$5]}" | jq "d.get('po',{}).get('id') or d.get('error')"; }
o1ld()  { curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$1' and l['material']=='$2'][0]"; }
o1tod() { curl -s -b $M "$B/api/today${2:-}" | jq "$1"; }
o1row() { o1tod "[($2) for l in d['loads'] if l['id']=='$1'][0]"; }
o1ph()  { curl -s -b $DA $B/api/my-dispatch | jq "$1"; }
o1asg() { mg POST /api/loads/$1/assign "$2" -w ' %{http_code}' | python3 -c "import sys,json;t=sys.stdin.read().rsplit(' ',1);d=json.loads(t[0]);print(t[1], d.get('code') or '', $3)"; }
o1run() { dr $DA $1 '{"action":"start-trip"}' >/dev/null; dr $DA $1 "{\"action\":\"arrived-pickup\",\"yardId\":\"$2\"}" >/dev/null; dr $DA $1 "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null; dr $DA $1 '{"action":"arrived-jobsite"}' >/dev/null; dr $DA $1 '{"action":"trip-complete"}' >/dev/null; }
# Yesterday (no Start day, no shift): Dana hauled 3/4 Rock from Vulcan for Carried Co — one trip delivered, the second left open at the yard; the PO's Dirt load was never touched.
PY9=$(o1po OA1-Y "Carried Co" "$O1Y" vulcan "{\"truckId\":\"dana\",\"truckUnitId\":\"$T59\",\"material\":\"3/4 Rock\",\"loadsAssigned\":2,\"vendorId\":\"vulcan\"},{\"truckId\":\"dana\",\"truckUnitId\":\"$T59\",\"material\":\"Dirt\",\"loadsAssigned\":1,\"vendorId\":\"vbt\"}")
LY9=$(o1ld $PY9 "3/4 Rock"); LU9=$(o1ld $PY9 Dirt)
o1run $LY9 vulcan; dr $DA $LY9 '{"action":"start-trip"}' >/dev/null; dr $DA $LY9 '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null
chk "59 a trip left open overnight: today's board shows Dana in progress on Truck #59 with that load and the truck taken — not 'available'; both of yesterday's open loads sit in the Carried Over tile" "$(o1tod "[(x['state'], x['available'], x['truckNum'], x['openLoadIds'], x['customer'], x['stage']) for x in d['drivers'] if x['id']=='dana'][0]")|$(o1tod "[(t['state'], t['driverName'], t['available']) for t in d['trucks'] if t['id']=='$T59'][0]")|$(o1tod "sorted(l['id'] for l in d['carriedOver'] if l['id'] in ('$LY9','$LU9'))==sorted(['$LY9','$LU9'])")" "('in-progress', False, 'Truck #59', ['$LY9'], 'Carried Co', 'At yard')|('in-progress', 'Dana', False)|True"
chk "   the phone: the trip under way (started within the workday window) is on Dana's list wherever it is dated — Operational audit 2's rule; the untouched yesterday load is the office's, named in the banner" "$(o1ph "[l['loadId'] for l in d['loads']], [(x['loadId'], x['date'], x['poNumber']) for x in d['earlierOpen']]")" "['$LY9'] [('$LU9', '$O1Y', 'OA1-Y')]"
chk "   Reports 'Active now' counts what the board counts: the open trip (1), not the untouched yesterday load, not every load ever left unapproved" "$(curl -s -b $M $B/api/reports | jq "d['driverStats']['dana']['active']")" "1"
# Quick Assign today against the carried work
PT9=$(o1po OA1-T "Today Co" "$TODAY" granite '{"truckId":"","material":"Dirt","loadsAssigned":1,"vendorId":"granite"}'); LT9=$(o1ld $PT9 Dirt)
chk "   Quick Assign today: Dana onto a new load → 409 driver-busy (mid-haul on yesterday's); Rigo onto Truck #59 → 409 truck-busy, saying since when; the load stays unassigned" "$(o1asg $LT9 "{\"driverId\":\"dana\",\"truckUnitId\":\"$T59\"}" "[c['type'] for c in d['conflicts']]")|$(o1asg $LT9 "{\"driverId\":\"rigo\",\"truckUnitId\":\"$T59\"}" "[c['message'] for c in d['conflicts'] if c['type']=='truck-busy']")|$(load $LT9 "l.get('truckId') or '', l.get('truckUnitId')")" "409 assignment_conflict ['driver-busy']|409 assignment_conflict [\"Truck #59 is on Dana's load $LY9 (PO OA1-Y, Carried Co) unfinished since $O1Y.\"]| None"
PF9=$(o1po OA1-F "Future Co" "$O1T" vbt '{"truckId":"","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}'); LF9=$(o1ld $PF9 Dirt)
chk "   planning tomorrow against today's unfinished work is not a conflict: Dana and Truck #59 on tomorrow's load → 200; 'Active now' is still 1" "$(o1asg $LF9 "{\"driverId\":\"dana\",\"truckUnitId\":\"$T59\"}" "d.get('success')")|$(curl -s -b $M $B/api/reports | jq "d['driverStats']['dana']['active']")" "200  True|1"
mg DELETE /api/pos/$PF9 >/dev/null
# The office's remedy, from the Carried Over tile: move the open load to today
MV1=$(mg POST /api/loads/move "{\"scope\":\"single\",\"loadId\":\"$LY9\",\"newDate\":\"$TODAY\",\"reason\":\"finishing yesterday's haul\"}" | jq "sorted(c['type'] for c in d['conflicts'])")
MV2=$(mg POST /api/loads/move "{\"scope\":\"single\",\"loadId\":\"$LY9\",\"newDate\":\"$TODAY\",\"reason\":\"finishing yesterday's haul\",\"force\":true}" | jq "d.get('success'), d.get('moved')")
chk "   the office moves it to today: the mid-haul warning first (409 load-in-progress), then the go-ahead moves it — on Dana's phone, off the Carried Over tile; the untouched load stays carried; Dana still in progress" "$MV1|$MV2|$(o1ph "[l['loadId'] for l in d['loads']], [x['loadId'] for x in d['earlierOpen']]")|$(o1tod "sorted(l['id'] for l in d['carriedOver'] if l['id'] in ('$LY9','$LU9'))")|$(o1tod "[x['state'] for x in d['drivers'] if x['id']=='dana'][0]")" "['load-in-progress']|True 1|['$LY9'] ['$LU9']|['$LU9']|in-progress"
# The board row carries the billing words and the reject reason
dr $DA $LY9 "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null; dr $DA $LY9 '{"action":"arrived-jobsite"}' >/dev/null; dr $DA $LY9 '{"action":"trip-complete"}' >/dev/null
curl -s -b $DA -H "$J" -X PUT $B/api/loads/$LY9 -d "{\"pod\":{\"signedBy\":\"Site Foreman\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null
S9=$(dr $DA $LY9 '{"action":"delivered"}' -o /dev/null -w '%{http_code}'); R9=$(mgc POST /api/loads/$LY9/reject '{"reason":"Ticket photo is unreadable"}')
chk "   sent back by the office: the board row says Rejected and why" "$S9 $R9|$(o1row $LY9 "l['bucket'], l['rejectReason'], l['readyToBill'], l['billingBatchId']")" "200 200|('rejected', 'Ticket photo is unreadable', False, '')"
S9b=$(dr $DA $LY9 '{"action":"delivered"}' -o /dev/null -w '%{http_code}'); A9=$(mgc POST /api/loads/$LY9/approve)
chk "   resubmitted and approved: the row is Ready to Bill by the one rule, no reason left on it" "$S9b $A9|$(o1row $LY9 "l['bucket'], l['readyToBill'], l['billingBatchId'], l['rejectReason']")" "200 200|('ready-to-bill', True, '', '')"
B9=$(mg POST /api/billing-batches "{\"loadIds\":[\"$LY9\"]}" | jq "(d.get('batches') or [{}])[0].get('id') or d.get('error')")
chk "   on a billing batch: still Approved on the board, but the row says it is not in Ready to Bill and names the batch" "$(o1row $LY9 "l['bucket'], l['readyToBill'], l['billingBatchId']=='$B9'")" "('ready-to-bill', False, True)"
# Material Costs: a vendor with no price for the material is an estimate, said so
mg POST /api/loads/$LT9/assign "{\"driverId\":\"dana\",\"truckUnitId\":\"$T59\"}" >/dev/null; o1run $LT9 granite
chk "   Material Costs: Granite has no Dirt price, so its Dirt line is priced at the default rate and flagged an estimate (vendor and grand total too); Vulcan's 3/4 Rock is the vendor's price, not an estimate" "$(curl -s -b $M $B/api/material-costs | python3 -c "import json,sys;d=json.load(sys.stdin);g=d['vendors']['granite'];m=g['byMaterial']['Dirt'];print(m['estimated'], m['unitPrice'], g['estimated'], g['estimatedCost']==m['cost'], d['estimatedTotal']>=g['estimatedCost'], d['vendors']['vulcan']['byMaterial']['3/4 Rock']['estimated'])")" "True 22 True True True False"
# Reports: customers count no voided loads
PV9=$(o1po OA1-V "OA1 Void Co" "$TODAY" vbt '{"truckId":"","material":"Dirt","loadsAssigned":2,"vendorId":"vbt"},{"truckId":"","material":"Sand","loadsAssigned":3,"vendorId":"vbt"}'); LV9=$(o1ld $PV9 Dirt)
mg POST /api/loads/$LV9/void '{"reason":"customer cancelled this one"}' >/dev/null
chk "   Reports: a voided load counts nowhere in the customer table (3 of the 5 ordered remain)" "$(curl -s -b $M $B/api/reports | python3 -c "import json,sys;d=json.load(sys.stdin);c=d['custStats']['OA1 Void Co'];print(c['pos'], c['loads'], c['delivered'])")" "1 3 0"
# Static: the office and the phone say it in the same words
chk "   static: the Dispatch chips use the Calendar's words (Approved / Billed — the same map on both screens) and the Ready to Bill tile filters by the one rule; a batched load says so; Load Details has a Truck line and a readable status; Edit PO lists voided loads; a ready batch can be voided; Stop early asks for the photo and signature first; a rejected load can redo both; a dropped connection is said; a silent tracker is not 'no activity'; a default rate is called an estimate" "$(grep -c "'ready-to-bill': 'Approved', completed: 'Billed'" public/index.html)|$(grep -c "list.filter(l => l.readyToBill)" public/index.html)|$(grep -c "On billing batch" public/index.html)|$(grep -c ">Truck</dt>" public/index.html)|$(grep -c "const LD_STATUS = " public/index.html)|$(grep -c 'voided load${voidedMine.length' public/index.html)|$(grep -c "b.syncStatus === 'ready_to_bill' || b.syncStatus === 'sent_to_quickbooks'" public/index.html)|$(grep -c "needed to stop early" public/index.html)|$(grep -c "Replace ticket photo" public/index.html)|$(grep -c "No connection — that tap did not get an answer" public/index.html)|$(grep -c "telemetry says nothing either way" public/index.html)|$(grep -c "an estimate, not a vendor's price" public/index.html)|$(grep -c "loadWorkStarted" server.js)" "2|1|2|1|1|1|1|2|1|2|1|1|4"   # OA2: Load Details also says "On billing batch"
echo
echo "── 60. Operational audit 2 — a cancelled load takes no more work; a trip under way is the driver's wherever the calendar put it; two open trips change no count; freight hours never bill at \$0; a default rate is said ──"
O2Y=$(TZ=America/Los_Angeles date -d yesterday +%F); O2T=$(TZ=America/Los_Angeles date -d tomorrow +%F)
o2drv() { mg POST /api/drivers "{\"username\":\"$1\",\"password\":\"${1}1234\",\"displayName\":\"$2\"}" >/dev/null; mg POST /api/fleet/trucks "{\"truckNum\":\"Truck #$3\",\"type\":\"End Dump\"}" | jq "d['truck']['id']"; }
o2ck()  { local c=$(mktemp); curl -s -c $c -X POST -d "username=$1&password=${1}1234" $B/login -o /dev/null; echo $c; }
o2po()  { mg POST /api/pos "{\"po\":{\"poNumber\":\"$1\",\"customer\":\"$2\",\"deliveryDate\":\"$3\",\"address\":\"6 Audit St\",\"city\":\"Fresno\",\"plannedVendorId\":\"${5:-vulcan}\"},\"splits\":[$4]}" | jq "d.get('po',{}).get('id') or d.get('error')"; }
o2ld()  { curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$1' and l['material']=='$2'][0]"; }
o2tod() { curl -s -b $M "$B/api/today${2:-}" | jq "$1"; }
o2code() { python3 -c "import sys,json;t=sys.stdin.read().rsplit(' ',1);d=json.loads(t[0]) if t[0].strip() else {};print(t[1], d.get('code') or '', $1)"; }
o2trip() { dr $1 $2 '{"action":"start-trip"}' >/dev/null; dr $1 $2 "{\"action\":\"arrived-pickup\",\"yardId\":\"${3:-vulcan}\"${4:+,\"odometer\":$4}}" >/dev/null; dr $1 $2 "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null; dr $1 $2 '{"action":"arrived-jobsite"}' >/dev/null; dr $1 $2 '{"action":"trip-complete"}' >/dev/null; }
o2pod() { curl -s -b $1 -H "$J" -X PUT $B/api/loads/$2 -d "{\"pod\":{\"signedBy\":\"Foreman\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null; }
o2split() { echo "{\"truckId\":\"$1\",\"truckUnitId\":\"$2\",\"material\":\"$3\",\"loadsAssigned\":$4,\"vendorId\":\"${5:-vulcan}\"}"; }
# ── A cancelled load takes no more work ──
TV=$(o2drv oa2v Vic 81); CV=$(o2ck oa2v)
PV=$(o2po OA2-V "Cancel Co" "$TODAY" "$(o2split oa2v $TV "3/4 Rock" 2),$(o2split oa2v $TV Sand 1)"); LV=$(o2ld $PV "3/4 Rock"); LV2=$(o2ld $PV Sand)
dr $CV $LV '{"action":"start-trip"}' >/dev/null; dr $CV $LV '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null
mg POST /api/loads/$LV/void '{"reason":"customer cancelled"}' >/dev/null
chk "60 a load the office cancelled takes no more work: the driver's taps on it (loaded, complete, signature, submit) are refused 409 load_voided with the reason; the record is untouched; the phone no longer lists it" "$(dr $CV $LV "{\"action\":\"loaded\",\"ticket\":$(tkt)}" -w ' %{http_code}' | o2code "'customer cancelled' in d.get('error','')")|$(dr $CV $LV '{"action":"trip-complete"}' -o /dev/null -w '%{http_code}') $(curl -s -b $CV -H "$J" -X PUT $B/api/loads/$LV -d "{\"pod\":{\"signedBy\":\"x\",\"signature\":\"$PNG\"}}" -o /dev/null -w '%{http_code}') $(dr $CV $LV '{"action":"delivered"}' -o /dev/null -w '%{http_code}')|$(load $LV "l['voided'], l['approvalStatus'], l['loadsDelivered'], l['locked'], len(l['trips']), sorted(l['trips'][0]['timestamps'].keys())")|$(curl -s -b $CV $B/api/my-dispatch | jq "any(l['loadId']=='$LV' for l in d['loads'])")" "409 load_voided True|409 409 409|True pending 0 False 1 ['arrivedPickup', 'start']|False"
o2trip $CV $LV2; o2pod $CV $LV2; dr $CV $LV2 '{"action":"delivered"}' >/dev/null; mg POST /api/loads/$LV2/void '{"reason":"duplicate order"}' >/dev/null
chk "   a submitted load that was voided is history: Approve and Reject refuse (409 load_voided), Mark Billed bills nothing, the void and its billStatus stand" "$(mg POST /api/loads/$LV2/approve '{}' -w ' %{http_code}' | o2code "''")|$(mg POST /api/loads/$LV2/reject '{"reason":"x"}' -w ' %{http_code}' | o2code "''")|$(mg POST /api/loads/bill "{\"loadIds\":[\"$LV2\"],\"reference\":\"INV-X\"}" | jq "d.get('billed')")|$(load $LV2 "l['voided'], l['approvalStatus'], l['billStatus'], l['locked']")" "409 load_voided |409 load_voided |0|True submitted voided True"
# ── A trip under way is the driver's wherever the calendar put it ──
TN=$(o2drv oa2n Nia 82); CN=$(o2ck oa2n)
PN=$(o2po OA2-N "Night Co" "$O2Y" "$(o2split oa2n $TN "3/4 Rock" 2),$(o2split oa2n $TN Dirt 1 vbt)"); LN=$(o2ld $PN "3/4 Rock"); LU=$(o2ld $PN Dirt)
dr $CN $LN '{"action":"start-trip"}' >/dev/null; dr $CN $LN '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null; dr $CN $LN "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null
chk "   a trip under way since yesterday, no Start day: the load is on Nia's phone (dated its own day, with the server's today for the badge), not only in the banner; the untouched yesterday load stays the office's (banner); the board holds Nia and Truck #82 on it" "$(curl -s -b $CN $B/api/my-dispatch | jq "[(l['loadId'], l['deliveryDate']) for l in d['loads']], [x['loadId'] for x in d['earlierOpen']], d['today']=='$TODAY'")|$(o2tod "[(x['state'], x['currentLoadId']) for x in d['drivers'] if x['id']=='oa2n'][0], [(t['state'], t['inUseOnLoadId']) for t in d['trucks'] if t['id']=='$TN'][0]")" "[('$LN', '$O2Y')] ['$LU'] True|('in-progress', '$LN') ('in-progress', '$LN')"
chk "   …and can finish the haul from the card: the drop lands on yesterday's load (1 of 2), the date is not moved; paused between trips on an earlier day, the load goes back to the office (banner), as §39's leftovers rule says" "$(dr $CN $LN '{"action":"arrived-jobsite"}' -o /dev/null -w '%{http_code}') $(dr $CN $LN '{"action":"trip-complete"}' -o /dev/null -w '%{http_code}')|$(load $LN "l['loadsDelivered'], l['deliveryDate']=='$O2Y'")|$(curl -s -b $CN $B/api/my-dispatch | jq "[l['loadId'] for l in d['loads']], sorted(x['loadId'] for x in d['earlierOpen'])==sorted(['$LN','$LU'])")" "200 200|1 True|[] True"
TF=$(o2drv oa2f Flo 83); CF=$(o2ck oa2f)
PF=$(o2po OA2-F "Forward Co" "$TODAY" "$(o2split oa2f $TF "3/4 Rock" 2)"); LF=$(o2ld $PF "3/4 Rock")
dr $CF $LF '{"action":"start-trip"}' >/dev/null; dr $CF $LF '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null
mg POST /api/loads/move "{\"scope\":\"single\",\"loadId\":\"$LF\",\"newDate\":\"$O2T\",\"reason\":\"customer pushed a day\",\"force\":true}" >/dev/null
PG=$(o2po OA2-G "Gap Co" "$TODAY" '{"truckId":"","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}' vbt); LG0=$(o2ld $PG Dirt)
chk "   a mid-haul load the office moved to tomorrow still holds Flo and Truck #83 on today's board (it was 'available' before); Quick Assign today refuses both — driver-busy, and truck-busy 'under way now (dated tomorrow)'; the phone keeps the card; tomorrow's board shows it too" "$(o2tod "[(x['state'], x['available'], x['currentLoadId']) for x in d['drivers'] if x['id']=='oa2f'][0], [(t['state'], t['available']) for t in d['trucks'] if t['id']=='$TF'][0]")|$(mg POST /api/loads/$LG0/assign "{\"driverId\":\"oa2f\",\"truckUnitId\":\"$TF\"}" -w ' %{http_code}' | o2code "[c['type'] for c in d.get('conflicts',[])]")|$(mg POST /api/loads/$LG0/assign "{\"driverId\":\"rigo\",\"truckUnitId\":\"$TF\"}" | jq "[c['message'].endswith('under way now (dated $O2T).') for c in d['conflicts'] if c['type']=='truck-busy']")|$(curl -s -b $CF $B/api/my-dispatch | jq "[(l['loadId'], l['deliveryDate']) for l in d['loads']]")|$(o2tod "[x['state'] for x in d['drivers'] if x['id']=='oa2f'][0]" "?date=$O2T")" "('in-progress', False, '$LF') ('in-progress', False)|409 assignment_conflict ['driver-busy']|[True]|[('$LF', '$O2T')]|in-progress"
# ── Two open trips change no count ──
TT=$(o2drv oa2t Tao 84); CT=$(o2ck oa2t)
PT=$(o2po OA2-2 "Two Co" "$TODAY" "$(o2split oa2t $TT "3/4 Rock" 2),$(o2split oa2t $TT Sand 1)"); LA=$(o2ld $PT "3/4 Rock"); LB=$(o2ld $PT Sand)
dr $CT $LA '{"action":"start-trip"}' >/dev/null; dr $CT $LA '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null; dr $CT $LA "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null
MC0=$(curl -s -b $M $B/api/material-costs | jq "d['vendors'].get('vulcan',{}).get('byMaterial',{}).get('3/4 Rock',{}).get('loads',0)")
chk "   two open trips: with A loaded and B merely assigned the truck chip reads the trip under way (A); B starts anyway (200); both cards on the phone, both in progress on the board, the driver row names the first" "$(o2tod "[(t['state'], t['inUseOnLoadId']) for t in d['trucks'] if t['id']=='$TT'][0]")|$(dr $CT $LB '{"action":"start-trip"}' -o /dev/null -w '%{http_code}')|$(curl -s -b $CT $B/api/my-dispatch | jq "sorted(l['loadId'] for l in d['loads'])==sorted(['$LA','$LB'])")|$(o2tod "[(x['state'], x['currentLoadId'], sorted(x['openLoadIds'])==sorted(['$LA','$LB'])) for x in d['drivers'] if x['id']=='oa2t'][0], sorted(l['bucket'] for l in d['loads'] if l['id'] in ('$LA','$LB'))")" "('in-progress', '$LA')|200|True|('in-progress', '$LA', True) ['in-progress', 'in-progress']"
dr $CT $LB '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null; dr $CT $LB "{\"action\":\"loaded\",\"ticket\":{\"source\":\"supplier\",\"number\":\"T60B$RANDOM\",\"netTons\":20,\"photo\":\"$PNG\"}}" >/dev/null; dr $CT $LB '{"action":"arrived-jobsite"}' >/dev/null; dr $CT $LB '{"action":"trip-complete"}' >/dev/null; o2pod $CT $LB
chk "   B completes and submits: 1 delivered, 20 t from B's ticket; A's loaded, undelivered trip counts nowhere — 0 delivered, Vulcan's 3/4 Rock cost unchanged; A cannot be stopped early with nothing completed (400)" "$(dr $CT $LB '{"action":"delivered"}' -o /dev/null -w '%{http_code}')|$(load $LB "l['loadsDelivered'], l['approvalStatus'], l['tons']['actualTons']")|$(load $LA "l['loadsDelivered'], l['approvalStatus']")|$(curl -s -b $M $B/api/material-costs | jq "d['vendors']['vulcan']['byMaterial']['3/4 Rock']['loads']==$MC0")|$(dr $CT $LA '{"action":"incomplete"}' -o /dev/null -w '%{http_code}')" "200|1 submitted 20|0 pending|True|400"
chk "   the office hands A (trip under way) to Vic: the mid-haul warning first (409 load-in-progress), the go-ahead moves the load with the handover on record; the open trip's stamps are untouched; Vic's phone has it, Tao's does not" "$(mg POST /api/loads/$LA/assign '{"driverId":"oa2v"}' -w ' %{http_code}' | o2code "[c['type'] for c in d.get('conflicts',[])]")|$(mg POST /api/loads/$LA/assign '{"driverId":"oa2v","force":true,"reason":"Tao went home sick"}' -o /dev/null -w '%{http_code}')|$(load $LA "l['driverName'], [(h['from'], h['to'], h['atTrip'], h['tripsDone'], h['reason']) for h in l['reassignHistory']], sorted(l['trips'][0]['timestamps'].keys())")|$(curl -s -b $CV $B/api/my-dispatch | jq "any(l['loadId']=='$LA' for l in d['loads'])") $(curl -s -b $CT $B/api/my-dispatch | jq "any(l['loadId']=='$LA' for l in d['loads'])")" "409 assignment_conflict ['load-in-progress']|200|Vic [('oa2t', 'oa2v', 1, 0, 'Tao went home sick')] ['arrivedPickup', 'loadedAt', 'start']|True False"
# ── Rejected is counted; a default customer rate is said ──
mg POST /api/loads/$LB/reject '{"reason":"Ticket photo is unreadable"}' >/dev/null
chk "   a rejected load is counted in the attention row (its own tile) and its row says why" "$(o2tod "d['attention']['rejected']>=1, [(l['bucket'], l['rejectReason']) for l in d['loads'] if l['id']=='$LB'][0]")" "True ('rejected', 'Ticket photo is unreadable')"
dr $CT $LB '{"action":"delivered"}' >/dev/null; mg POST /api/loads/$LB/approve '{}' >/dev/null
chk "   Two Co has no price for Sand: the Ready to Bill item and the invoice preview line both carry the default-rate flag (\$25/ton is a guess, not a price); the amount is 25 planned t × \$25" "$(curl -s -b $M $B/api/ready-to-bill | python3 -c "import json,sys;d=json.load(sys.stdin);print([(i['customerRateIsDefault'], i['rateLabel'], i['amount'], i['basis']) for i in d['items'] if i['id']=='$LB'])")|$(mg POST /api/billing-batches/preview "{\"loadIds\":[\"$LB\"]}" | jq "[(ln['rateIsDefault'], ln['amount']) for ln in d['groups'][0]['lineItems']]")" "[(True, '\$25/ton', 625, 'planned')]|[(True, 625)]"
# ── Freight hours never bill at $0 ──
TH=$(o2drv oa2h Hal 85); CH=$(o2ck oa2h)
mg POST /api/customers '{"name":"Hourly Two Co","city":"Clovis"}' >/dev/null
mg POST /api/customer-prices '{"customer":"Hourly Two Co","material":"Sand","unit":"hour","price":80}' >/dev/null; mg POST /api/customer-prices '{"customer":"Hourly Two Co","material":"Rock","unit":"hour","price":80}' >/dev/null
PH=$(o2po OA2-H "Hourly Two Co" "$TODAY" "$(o2split oa2h $TH Sand 1 cemex),$(o2split oa2h $TH Rock 1 cemex)" cemex); H1=$(o2ld $PH Sand); H2=$(o2ld $PH Rock)
curl -s -b $CH -H "$J" -X POST $B/api/shifts/start -d "{\"truckId\":\"$TH\",\"odometer\":50000,\"inspection\":{\"satisfactory\":true},\"signature\":\"$PNG\"}" -o /dev/null
o2trip $CH $H1 cemex 50020; o2pod $CH $H1; dr $CH $H1 '{"action":"delivered"}' >/dev/null
o2trip $CH $H2 cemex; o2pod $CH $H2; dr $CH $H2 '{"action":"delivered"}' >/dev/null
FS2=$(curl -s -b $M $B/api/freight-segments | jq "[s['id'] for s in d['segments'] if s['customer']=='Hourly Two Co'][0]")
curl -s -b $CH -H "$J" -X POST $B/api/freight-segments/$FS2/close -d '{"odometer":50080}' -o /dev/null
mg PUT /api/freight-segments/$FS2 "{\"timeStart\":\"${TODAY}T06:30:00-07:00\",\"timeEnd\":\"${TODAY}T08:30:00-07:00\",\"reason\":\"times from the log\"}" >/dev/null
mg POST /api/loads/$H1/approve '{}' >/dev/null; mg POST /api/loads/$H2/approve '{}' >/dev/null
RTB0=$(curl -s -b $M $B/api/ready-to-bill | python3 -c "import json,sys;d=json.load(sys.stdin);print([(i['id']=='$H1', i['amount']) for i in d['items'] if i['id'] in ('$H1','$H2')])")
mg POST /api/loads/$H1/void '{"reason":"duplicate entry"}' >/dev/null
chk "   hourly freight, two loads, 2 h: the first load carries the \$160, the second \$0 'billed with' it; with the first voided (never billed) the second is NOT priceable — Ready to Bill says why and the batch is refused (400) instead of invoicing \$0; restoring the first makes both priceable again" "$RTB0|$(curl -s -b $M $B/api/ready-to-bill | python3 -c "import json,sys;d=json.load(sys.stdin);print([(i['priceable'], 'which is voided and was never billed' in i['priceReason']) for i in d['items'] if i['id']=='$H2'])")|$(mgc POST /api/billing-batches "{\"loadIds\":[\"$H2\"]}")|$(mg POST /api/loads/$H1/unvoid '{}' -o /dev/null -w '%{http_code}')|$(curl -s -b $M $B/api/ready-to-bill | python3 -c "import json,sys;d=json.load(sys.stdin);print(sorted((i['id']=='$H1', i['amount'], i['priceable']) for i in d['items'] if i['id'] in ('$H1','$H2')))")" "[(True, 160), (False, 0)]|[(False, True)]|400|200|[(False, 0, True), (True, 160, True)]"
# ── Static: the words on the screens ──
chk "   static: the phone offers Stop early on every in-progress step (6 places — the planned-yard tap included) and redo buttons on a rejected partial load; a card from another day says FROM <date> by the server's day; Ready to Bill (and the PO form before it) and the preview say 'default rate'; Load Details says 'On billing batch' and shows handovers, offers Void wherever Delete is refused; a Rejected tile (the summary and the attention row count it); the truck chip names Linxup; the server refuses work, approval, rejection and (OA6) Quick Assign on a voided load (5 guards) and refuses to price stranded freight" "$(grep -c '\${stopEarly}' public/index.html)|$(grep -c 'then Stop early to resubmit, or keep hauling' public/index.html)|$(grep -c 'FROM \${escapeHtml(l.deliveryDate' public/index.html)|$(grep -c "window._serverToday = d.today" public/index.html)|$(grep -c '>default rate</span>' public/index.html)|$(grep -c 'default rate — no customer price on file' public/index.html)|$(grep -c 'Approved · On billing batch' public/index.html)|$(grep -c '>Handed over</dt>' public/index.html)|$(grep -c 'const hasRecord = ' public/index.html)|$(grep -c "tile('rejected'" public/index.html)|$(grep -c 'Linxup · \${escapeHtml(x.label)}' public/index.html)|$(grep -c "load_voided" server.js)|$(grep -c "which is voided and was never billed" server.js)|$(grep -c "rejected: count('rejected')" server.js)" "6|1|1|1|2|2|1|1|1|1|1|5|1|2"   # OA3: Load Details also says "default rate — no customer price on file"; OA6: the assign route is the fifth load_voided guard
echo
echo "── 61. Operational audit 3 — the money trace: one engine from Ready to Bill to QuickBooks; a default rate is a placeholder until the batch; \$0 is said and acknowledged; a vendor bill is never left holding a voided load ──"
mg POST /api/_test/qb-fake '{"mode":"ok","billMode":"ok"}' >/dev/null
o3drv() { mg POST /api/drivers "{\"username\":\"$1\",\"password\":\"${1}1234\",\"displayName\":\"$2\"}" >/dev/null; mg POST /api/fleet/trucks "{\"truckNum\":\"Truck #$3\",\"type\":\"End Dump\"}" | jq "d['truck']['id']"; }
o3ck()  { local c=$(mktemp); curl -s -c $c -X POST -d "username=$1&password=${1}1234" $B/login -o /dev/null; echo $c; }
o3po()  { mg POST /api/pos "{\"po\":{\"poNumber\":\"$1\",\"customer\":\"$2\",\"deliveryDate\":\"$TODAY\",\"address\":\"3 Money St\",\"city\":\"Fresno\",\"plannedVendorId\":\"${4:-vulcan}\"},\"splits\":[$3]}" | jq "d.get('po',{}).get('id') or d.get('error')"; }
o3split() { echo "{\"truckId\":\"$1\",\"truckUnitId\":\"$2\",\"material\":\"$3\",\"loadsAssigned\":$4,\"vendorId\":\"${5:-vulcan}\"}"; }
o3lds() { curl -s -b $M $B/api/data | jq "' '.join(l['id'] for l in d['loads'] if l['poId']=='$1')"; }
o3trip() { dr $1 $2 '{"action":"start-trip"}' >/dev/null; dr $1 $2 "{\"action\":\"arrived-pickup\",\"yardId\":\"${3:-vulcan}\"}" >/dev/null; dr $1 $2 "{\"action\":\"loaded\",\"ticket\":{\"source\":\"supplier\",\"number\":\"T61$RANDOM$RANDOM\",\"netTons\":${4:-24.5},\"photo\":\"$PNG\"}}" >/dev/null; dr $1 $2 '{"action":"arrived-jobsite"}' >/dev/null; dr $1 $2 '{"action":"trip-complete"}' >/dev/null; }
o3sub() { curl -s -b $1 -H "$J" -X PUT $B/api/loads/$2 -d "{\"pod\":{\"signedBy\":\"Foreman\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null; dr $1 $2 '{"action":"delivered"}' >/dev/null; }
o3price() { mg POST /api/customer-prices "{\"customer\":\"$1\",\"material\":\"$2\",\"unit\":\"$3\",\"price\":$4}" -o /dev/null -w '%{http_code}'; }
o3rtb() { curl -s -b $M $B/api/ready-to-bill | python3 -c "import json,sys;d=json.load(sys.stdin);print([(i['amount'], i['rateLabel'], i['customerRateIsDefault'], i['priceable']) for i in d['items'] if i['id']=='$1'])"; }
o3prev() { mg POST /api/billing-batches/preview "{\"loadIds\":[\"$1\"]}" | python3 -c "import json,sys;d=json.load(sys.stdin);g=d['groups'][0];print(g['totalAmount'], [(ln['description'], ln['amount'], ln['rateIsDefault']) for ln in g['lineItems']])"; }
o3inv() { curl -s -b $M $B/api/_test/qb-fake | python3 -c "import json,sys;d=json.load(sys.stdin);i=d['invoices'][-1];print(i['DocNumber'], [(l['description'], l['quantity'], l['amount']) for l in i['lines']])"; }
o3code() { python3 -c "import sys,json;t=sys.stdin.read().rsplit(' ',1);d=json.loads(t[0]) if t[0].strip() else {};print(t[1], d.get('code') or '', $1)"; }
# ── A. one engine, end to end ──
TA=$(o3drv oa3a Ana 91); CA=$(o3ck oa3a); o3price "Trace Three Co" "3/4 Rock" ton 30 >/dev/null
PA=$(o3po M3-A "Trace Three Co" "$(o3split oa3a $TA "3/4 Rock" 2)"); LA=$(o3lds $PA)
o3trip $CA $LA vulcan 24; o3trip $CA $LA vulcan 26; o3sub $CA $LA; mg POST /api/loads/$LA/approve '{}' >/dev/null
RA=$(o3rtb $LA); BA=$(mg POST /api/billing-batches "{\"loadIds\":[\"$LA\"]}" | jq "d['batches'][0]['id']")
chk "61 one engine: the load's snapshot (\$30/ton, 25 t planned), Ready to Bill, the preview, the batch and the QuickBooks invoice all say 2 loads · 50 t · \$1,500; the vendor side says 2 trips · \$38 · \$1,900 on the bill, in Material Costs and in QuickBooks" "$(load $LA "l['customerRate'], l['customerRateIsDefault'], l['tonsPerLoad'], l['tons']['actualTons']")|$RA|$(mg GET /api/billing-batches/$BA | python3 -c "import json,sys;b=json.load(sys.stdin)['batch'];print(b['totalLoads'], b['totalAmount'], b['lineItems'][0]['tons'])")|$(mgc POST /api/billing-batches/$BA/send '{}') $(o3inv)|$(mg POST /api/vendor-bills "{\"loadIds\":[\"$LA\"]}" | python3 -c "import json,sys;b=json.load(sys.stdin)['bills'][0];print(b['totalAmount'], b['lineItems'][0]['description'])")|$(curl -s -b $M $B/api/material-costs | jq "d['vendors']['vulcan']['byMaterial']['3/4 Rock']['cost']-$(curl -s -b $M $B/api/material-costs | jq "d['vendors']['vulcan']['byMaterial']['3/4 Rock']['cost']")+1900")" "30 False 25 50|[(1500, '\$30/ton', False, True)]|2 1500 50|200 M3-A [('3/4 Rock — 2 loads (50.00 ton @ \$30/ton)', 50, 1500)]|1900 3/4 Rock — 2 loads (50.00 ton @ \$38/ton)|1900"
# ── B. a default rate is a placeholder until the batch freezes the line ──
TB=$(o3drv oa3b Ben 92); CB=$(o3ck oa3b)
PB=$(o3po M3-B "Nopr Three Co" "$(o3split oa3b $TB Dirt 1 vbt),$(o3split oa3b $TB Dirt 1 vbt)" vbt); read LB1 LB2 <<< "$(o3lds $PB)"
o3trip $CB $LB1 vbt; o3sub $CB $LB1; mg POST /api/loads/$LB1/approve '{}' >/dev/null
R0=$(o3rtb $LB1); o3price "Nopr Three Co" Dirt ton 50 >/dev/null
chk "   a PO made before the customer's price existed bills at the default (\$25, flagged); the moment the price (\$50) is on file the approved load, Ready to Bill, the preview and Load Details bill at \$50 with no default flag — the snapshot was a placeholder, as vendor cost already treats it" "$R0|$(o3rtb $LB1)|$(o3prev $LB1)|$(load $LB1 "l['billing']['amount'], l['billing']['rate'], l['billing']['rateIsDefault'], l['customerRate'], l['customerRateIsDefault']")" "[(625, '\$25/ton', True, True)]|[(1250, '\$50/ton', False, True)]|1250 [('Dirt — 1 load (25.00 ton @ \$50/ton)', 1250, False)]|1250 50 False 25 True"
BB=$(mg POST /api/billing-batches "{\"loadIds\":[\"$LB1\"]}" | jq "d['batches'][0]['id']"); PIDB=$(curl -s -b $M $B/api/customer-prices | python3 -c "import json,sys;d=json.load(sys.stdin);c=[c for c in d['customers'] if c['key']=='nopr three co'][0];print(c['prices'][0]['id'])")
chk "   the batch freezes the line: a later price change (\$60) does not reach a batch already made — QuickBooks receives \$50 — while a load not yet batched follows the price list" "$(mgc PUT "/api/customer-prices/nopr%20three%20co/$PIDB" '{"price":60}')|$(mgc POST /api/billing-batches/$BB/send '{}') $(o3inv)|$(o3trip $CB $LB2 vbt; o3sub $CB $LB2; mg POST /api/loads/$LB2/approve '{}' >/dev/null; o3rtb $LB2)" "200|200 M3-B [('Dirt — 1 load (25.00 ton @ \$50/ton)', 25, 1250)]|[(1500, '\$60/ton', False, True)]"
# ── C. $0 is said and acknowledged, never silent; a price is a number of 0 or more ──
TC=$(o3drv oa3c Cal 93); CC=$(o3ck oa3c); o3price "Free Three Co" Dirt ton 0 >/dev/null
PC=$(o3po M3-C "Free Three Co" "$(o3split oa3c $TC Dirt 1 vbt)" vbt); LC=$(o3lds $PC); o3trip $CC $LC vbt; o3sub $CC $LC
chk "   an explicit \$0 price: the checklist's Billing item is a ⚠ ('\$0 — nothing would be invoiced'), Vendor cost says our own yard; Approve without acknowledging → 409 approval_incomplete; acknowledged → approved with the \$0 warning on record; the batch is allowed (a legitimate \$0) and its line says \$0" "$(load $LC "[(c['label'], c['ok'], c['value'], c['note']) for c in l['approval']['items'] if c['key'] in ('billing','cost')]")|$(mg POST /api/loads/$LC/approve '{}' -w ' %{http_code}' | o3code "''")|$(mgc POST /api/loads/$LC/approve '{"acknowledge":true}') $(load $LC "l['approvalWarnings']")|$(mg POST /api/billing-batches "{\"loadIds\":[\"$LC\"]}" | python3 -c "import json,sys;d=json.load(sys.stdin);b=d['batches'][0];print(b['totalAmount'], b['lineItems'][0]['amount'])")" "[('Billing', False, '\$0.00 · 25.00 t @ \$0/ton', '\$0 — nothing would be invoiced for this load'), ('Vendor cost', True, 'our own yard — none', '')]|409 approval_incomplete |200 ['Billing: \$0 — nothing would be invoiced for this load']|0 0"
chk "   a price is a number of 0 or more: -5 and 'abc' are refused (400) for a customer price, a vendor price and a default rate; \$0 stays legal" "$(o3price "Free Three Co" Sand ton -5) $(o3price "Free Three Co" Sand ton '"abc"') $(mgc POST /api/vendors/vulcan/prices '{"material":"Dirt","unit":"ton","price":-1}') $(mgc PUT /api/default-rates '{"side":"customer","material":"Dirt","unit":"ton","price":-1}') $(o3price "Free Three Co" Sand ton 0)" "400 400 400 400 200"
# ── D. a vendor bill is never left holding a voided load ──
TD=$(o3drv oa3d Dee 94); CD=$(o3ck oa3d); o3price "Pay Three Co" "3/4 Rock" ton 30 >/dev/null
PD=$(o3po M3-D "Pay Three Co" "$(o3split oa3d $TD "3/4 Rock" 1),$(o3split oa3d $TD "3/4 Rock" 1)"); read LD1 LD2 <<< "$(o3lds $PD)"
o3trip $CD $LD1 vulcan; o3sub $CD $LD1; mg POST /api/loads/$LD1/approve '{}' >/dev/null; o3trip $CD $LD2 vulcan; o3sub $CD $LD2; mg POST /api/loads/$LD2/approve '{}' >/dev/null
VD=$(mg POST /api/vendor-bills "{\"loadIds\":[\"$LD1\",\"$LD2\"]}" | jq "d['bills'][0]['id']")
chk "   a load whose trips are on a vendor bill (unsent, then sent) is not voided around the bill: 409 on_vendor_bill naming the bill; voiding the bill releases the trips and the load voids; the voided load cannot be billed to the vendor again" "$(mg POST /api/loads/$LD1/void '{"reason":"duplicate entry"}' -w ' %{http_code}' | o3code "d.get('vendorBillIds')")|$(mgc POST /api/vendor-bills/$VD/send '{}') $(mg POST /api/loads/$LD1/void '{"reason":"duplicate entry"}' -w ' %{http_code}' | o3code "''")|$(mg POST /api/vendor-bills/$VD/void '{"reason":"one load was a duplicate"}' -o /dev/null -w '%{http_code}') $(mgc POST /api/loads/$LD1/void '{"reason":"duplicate entry"}')|$(mg POST /api/vendor-bills "{\"loadIds\":[\"$LD1\",\"$LD2\"]}" | python3 -c "import json,sys;d=json.load(sys.stdin);print([(b['totalAmount'], b['loadIds']) for b in d['bills']])")" "409 on_vendor_bill ['$VD']|200 409 on_vendor_bill |200 200|[(950, ['$LD2'])]"
# ── E. the vendor bill fixes the price it pays; a yard that hauled is not deleted ──
TE=$(o3drv oa3e Eli 95); CE=$(o3ck oa3e)
PE=$(o3po M3-E "Pay Three Co" "$(o3split oa3e $TE Dirt 1 granite),$(o3split oa3e $TE "Fill Sand" 1 vbt)" granite); read LE1 LE2 <<< "$(o3lds $PE)"
o3trip $CE $LE1 granite; o3sub $CE $LE1; mg POST /api/loads/$LE1/approve '{}' >/dev/null
GP=$(mg POST /api/vendors/granite/prices '{"material":"Dirt","unit":"ton","price":30}' | jq "d['price']['id']")
VE=$(mg POST /api/vendor-bills "{\"loadIds\":[\"$LE1\"]}" | python3 -c "import json,sys;b=json.load(sys.stdin)['bills'][0];print(b['id'], b['totalAmount'])")
mg PUT /api/vendors/granite/prices/$GP '{"price":32}' >/dev/null
chk "   Granite had no Dirt price when the trip loaded (default \$22, an estimate); the office adds \$30 and bills \$750; the bill fixes \$30 onto the trip, so a later list change to \$32 moves nothing — Material Costs, Profitability cost and the bill agree" "${VE##* }|$(load $LE1 "l['trips'][0]['vendorRate'], l['trips'][0]['vendorRateIsDefault'], l['trips'][0]['vendorRateFixedBy']=='${VE%% *}'")|$(load $LE1 "l['billing']['cost']['amount'], l['billing']['cost']['estimated']")" "750|30 False True|750 False"
o3trip $CE $LE2 hanson; o3sub $CE $LE2; mg POST /api/loads/$LE2/approve '{}' >/dev/null
chk "   a yard the driver loaded at (planned VBT, loaded at Hanson) cannot be deleted while a trip names it (400) — its cost stays on every screen" "$(mg DELETE /api/vendors/hanson '{}' -w ' %{http_code}' | o3code "'hauled from this yard' in d.get('error','')")|$(curl -s -b $M $B/api/material-costs | jq "d['vendors']['hanson']['byMaterial']['Fill Sand']['loads']>=1")" "400  True|True"
# ── F. what the screens are told: Profitability names its estimates; the driver's payload carries no money ──
chk "   Profitability counts what is priced at a default rate as estimates (customer side and vendor side) and the office load payload carries the money while the driver's does not" "$(curl -s -b $M $B/api/profitability | python3 -c "import json,sys;g=json.load(sys.stdin)['grand'];print(g['estimatedRevenueLoads']>=1, g['estimatedRevenue']>0, g['estimatedCostLoads']>=0, 'estimatedCost' in g)")|$(load $LA "sorted(l['billing'].keys())[:4], l['billing']['cost']['amount']")|$(curl -s -b $CA $B/api/my-dispatch | jq "any('billing' in l or 'customerRate' in l for l in d['loads'])") $(curl -s -b $CA $B/api/data | jq "any('billing' in l or 'customerRate' in l for l in d['loads'])")" "True True True True|['amount', 'basis', 'cost', 'quantity'] 1900|False False"
chk "   static: one effective-rate rule feeds revenue, the lines and the items; the screens say \$0 and estimates; Load Details has a Billing line; the void guard names the vendor bill; the bill fixes the rate; prices are validated at every entry" "$(grep -c "effectiveCustomerRate" server.js)|$(grep -c "on_vendor_bill" server.js)|$(grep -c "vendorRateFixedBy" server.js)|$(grep -c "priceOk(" server.js)|$(grep -c '\$0 — check the price' public/index.html)|$(grep -c '\$0 — nothing invoiced for this line' public/index.html)|$(grep -c '>Billing</dt>' public/index.html)|$(grep -c 'Estimates inside:' public/index.html)|$(grep -c "key: 'billing', label: 'Billing'" server.js)" "3|1|2|5|1|1|1|1|1"
echo "── 62. Operational audit 4 — the end of day is one list: every load of the day sorted into clean, open, needs attention or blocked, each with its reasons and its next step; the review reads and changes nothing; today's review carries earlier unfinished work; the phone's planned yard is one tap ──"
mg POST /api/_test/qb-fake '{"mode":"ok","billMode":"ok"}' >/dev/null
D4=$(date -d '+45 day' +%F)
o4drv() { mg POST /api/drivers "{\"username\":\"$1\",\"password\":\"${1}1234\",\"displayName\":\"$2\"}" >/dev/null; mg POST /api/fleet/trucks "{\"truckNum\":\"Truck #$3\",\"type\":\"End Dump\",\"defaultDriverId\":\"$1\"}" | jq "d['truck']['id']"; }
o4ck()  { local c=$(mktemp); curl -s -c $c -X POST -d "username=$1&password=${1}1234" $B/login -o /dev/null; echo $c; }
o4po()  { mg POST /api/pos "{\"po\":{\"poNumber\":\"$1\",\"customer\":\"$2\",\"deliveryDate\":\"${5:-$D4}\",\"address\":\"4 Review St\",\"city\":\"Fresno\",\"plannedVendorId\":\"${4:-vulcan}\"},\"splits\":[$3]}" | jq "d.get('po',{}).get('id') or d.get('error')"; }
o4split() { echo "{\"truckId\":\"$1\",\"truckUnitId\":\"$2\",\"material\":\"$3\",\"loadsAssigned\":$4,\"vendorId\":\"${5:-vulcan}\"}"; }
o4lds() { curl -s -b $M $B/api/data | jq "' '.join(l['id'] for l in d['loads'] if l['poId']=='$1')"; }
o4trip() { dr $1 $2 '{"action":"start-trip"}' >/dev/null; dr $1 $2 "{\"action\":\"arrived-pickup\",\"yardId\":\"${3:-vulcan}\"}" >/dev/null; dr $1 $2 "{\"action\":\"loaded\",\"ticket\":{\"source\":\"supplier\",\"number\":\"T62$RANDOM$RANDOM\",\"netTons\":24.5,\"photo\":\"$PNG\"}}" >/dev/null; dr $1 $2 '{"action":"arrived-jobsite"}' >/dev/null; dr $1 $2 '{"action":"trip-complete"}' >/dev/null; }
o4sub() { curl -s -b $1 -H "$J" -X PUT $B/api/loads/$2 -d "{\"pod\":{\"signedBy\":\"Foreman\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null; dr $1 $2 '{"action":"delivered"}' >/dev/null; }
o4rev()  { curl -s -b $M "$B/api/day-review${2:+?date=$2}" | python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
o4item() { o4rev "[(lambda i: ($2))(i) for i in d['items'] if i['id']=='$1'][0]"; }
o4hash() { curl -s -b $M $B/api/data | python3 -c "import json,sys,hashlib;d=json.load(sys.stdin);print(hashlib.md5(json.dumps([l for l in d['loads'] if l.get('deliveryDate')=='$D4'],sort_keys=True).encode()).hexdigest())"; }
mg POST /api/customer-prices '{"customer":"Review Four Co","material":"3/4 Rock","unit":"ton","price":30}' >/dev/null
# ── the day: one load per state ──
# A. Ada: one load billed (clean); one approved on a batch QuickBooks never answered (blocked)
WTA=$(o4drv oa4a Ada 96); WCA=$(o4ck oa4a)
WPA=$(o4po R4-A "Review Four Co" "$(o4split oa4a $WTA "3/4 Rock" 1),$(o4split oa4a $WTA "3/4 Rock" 1)"); read WLA1 WLA2 <<< "$(o4lds $WPA)"
o4trip $WCA $WLA1; o4sub $WCA $WLA1; mg POST /api/loads/$WLA1/approve '{}' >/dev/null; WBA1=$(mg POST /api/billing-batches "{\"loadIds\":[\"$WLA1\"]}" | jq "d['batches'][0]['id']"); mg POST /api/billing-batches/$WBA1/send '{}' >/dev/null
o4trip $WCA $WLA2; o4sub $WCA $WLA2; mg POST /api/loads/$WLA2/approve '{}' >/dev/null; WBA2=$(mg POST /api/billing-batches "{\"loadIds\":[\"$WLA2\"]}" | jq "d['batches'][0]['id']")
mg POST /api/_test/qb-fake '{"mode":"timeout"}' >/dev/null; mg POST /api/billing-batches/$WBA2/send '{}' >/dev/null; mg POST /api/_test/qb-fake '{"mode":"ok"}' >/dev/null
# B. Bo: Dirt from our yard for a customer with no price — one submitted (attention: default rate), one not started (open)
WTB=$(o4drv oa4b Bo 97); WCB=$(o4ck oa4b)
WPB=$(o4po R4-B "Nopr Four Co" "$(o4split oa4b $WTB Dirt 1 vbt),$(o4split oa4b $WTB Dirt 1 vbt)" vbt); read WLB1 WLB2 <<< "$(o4lds $WPB)"
o4trip $WCB $WLB1 vbt; o4sub $WCB $WLB1
# C. Cy: 3 loads, one delivered, trip 2 under way (open)
WTC=$(o4drv oa4c Cy 98); WCC=$(o4ck oa4c)
WPC=$(o4po R4-C "Review Four Co" "$(o4split oa4c $WTC "3/4 Rock" 3)"); WLC=$(o4lds $WPC); o4trip $WCC $WLC; dr $WCC $WLC '{"action":"start-trip"}' >/dev/null
# D. Di: delivered, submitted, sent back (attention)
WTD=$(o4drv oa4d Di 99); WCD=$(o4ck oa4d)
WPD=$(o4po R4-D "Review Four Co" "$(o4split oa4d $WTD "3/4 Rock" 1)"); WLD=$(o4lds $WPD); o4trip $WCD $WLD; o4sub $WCD $WLD; mg POST /api/loads/$WLD/reject '{"reason":"Ticket photo is unreadable"}' >/dev/null
# E. nobody: a load with no driver (attention, one reason)
WPE=$(o4po R4-E "Review Four Co" '{"truckId":"","material":"Sand","loadsAssigned":1,"vendorId":"vulcan"}'); WLE=$(o4lds $WPE)
# F. Fay: an explicit $0 price, delivered and submitted (attention: the checklist's $0 gap, said once)
WTF=$(o4drv oa4f Fay 100); WCF=$(o4ck oa4f); mg POST /api/customer-prices '{"customer":"Free Four Co","material":"Dirt","unit":"ton","price":0}' >/dev/null
WPF=$(o4po R4-F "Free Four Co" "$(o4split oa4f $WTF Dirt 1 vbt)" vbt); WLF=$(o4lds $WPF); o4trip $WCF $WLF vbt; o4sub $WCF $WLF
chk "62 the review of a day: 8 loads — 1 clean, 2 still open, 4 need attention, 1 blocked; the blocked load first; the reconciliation reads as sentences (deliveries against approval and billing, what is not submitted, default rates, batches to reconcile, open work)" "$(o4rev "d['counts'], d['items'][0]['id']=='$WLA2', d['isToday']" $D4)|$(o4rev "' / '.join(d['reconciliation'])" $D4)" "{'total': 8, 'clean': 1, 'open': 2, 'attention': 4, 'blocked': 1} True False|6 deliveries on 6 loads — 2 waiting for approval, 0 ready to bill, 1 on a batch, 1 billed. / 2 loads have deliveries but are not submitted (still open or sent back). / 1 load is priced at a default customer rate. / 1 batch needs QuickBooks reconciliation. / 2 loads are still open."
o4it() { o4rev "[(i['state'], i['reasons'], i['next']${3:+, i['amount']}) for i in d['items'] if i['id']=='$1'][0]" ${2-$D4}; }
chk "   each load says why and what is next: the unknown batch blocks ('reconcile the batch'); a default rate, a rejection, a missing driver (one reason, not two) and a \$0 gap need attention; assigned and under way are open with nothing asked; the billed load is clean; money only where it is due" "$(o4it $WLA2 $D4 amt)|$(o4it $WLA1 $D4 amt)|$(o4it $WLB1 $D4 amt)|$(o4it $WLB2 $D4 amt)|$(o4it $WLC $D4 amt)|$(o4it $WLD)|$(o4it $WLE $D4 amt)|$(o4it $WLF $D4 amt)" "('blocked', ['QuickBooks result unknown on batch $WBA2'], 'reconcile the batch', 750)|('clean', ['billed · invoice R4-A'], '', 750)|('attention', ['completed — waiting for approval', 'default customer rate — no price on file'], 'approve it', 625)|('open', ['assigned, not started yet'], '', None)|('open', ['still under way — Going to yard, 1/3 delivered'], '', None)|('attention', ['sent back to the driver: Ticket photo is unreadable'], 'waiting on the driver to fix and resubmit')|('attention', ['no driver'], 'assign a driver', None)|('attention', ['waiting for approval with gaps — Billing: \$0 — nothing would be invoiced for this load'], 'approve with the gaps acknowledged, or reject', 0)"
WH0=$(o4hash)
chk "   the board carries the same counts for its tile; the review reads and changes nothing (the day's records are byte-identical after two reads); a driver gets 403" "$(curl -s -b $M "$B/api/today?date=$D4" | jq "d['review']")|$(o4rev "0" $D4 >/dev/null; o4rev "0" $D4 >/dev/null; [ "$(o4hash)" = "$WH0" ] && echo same || echo changed)|$(curl -s -b $WCA -o /dev/null -w '%{http_code}' "$B/api/day-review?date=$D4")" "{'total': 8, 'clean': 1, 'open': 2, 'attention': 4, 'blocked': 1}|same|403"
mg POST /api/loads/$WLF/approve '{"acknowledge":true}' >/dev/null
chk "   once the \$0 gap is acknowledged at approval the load is clean on the list — the gap is said in the checklist's words, not raised again — 2 clean, 3 attention" "$(o4it $WLF)|$(o4rev "d['counts']['clean'], d['counts']['attention']" $D4)" "('clean', ['approved, not yet billed', 'gaps acknowledged at approval: Billing: \$0 — nothing would be invoiced for this load'], 'bill it')|2 3"
# G. Gus: a trip left open since yesterday — today's review carries it; another day's does not
WTG=$(o4drv oa4g Gus 101); WCG=$(o4ck oa4g); YD4=$(date -d '-1 day' +%F)
WPG=$(o4po R4-G "Review Four Co" "$(o4split oa4g $WTG "3/4 Rock" 2)" vulcan "$YD4"); WLG=$(o4lds $WPG)
dr $WCG $WLG '{"action":"start-trip"}' >/dev/null; dr $WCG $WLG '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null
chk "   a trip left open since yesterday is on today's review as attention ('unfinished since …') with its next step; another day's review judges only that day's loads" "$(o4it $WLG "")|$(o4rev "len([i for i in d['items'] if i['id']=='$WLG'])" $D4)" "('attention', ['unfinished since $YD4 — At yard, 0/2 delivered'], 'the driver finishes it or stops early')|0"
chk "   the phone's payload names the planned yard by id, so the card's first button is 'Arrived at <yard>' — one tap, the picker one link away; the usual-truck suggestion and the review are wired in the page and the server" "$(curl -s -b $WCC $B/api/my-dispatch | jq "[(l['pickupYardId'], l['pickupLocation'], l['pickupIsInternal']) for l in d['loads'] if l['loadId']=='$WLC'][0]")|$(grep -c "async function arrivedAtPlannedYard" public/index.html) $(grep -c "picked up somewhere else?" public/index.html) $(grep -c "poUsualTruckId(val)" public/index.html) $(grep -c "async function openDayReview" public/index.html) $(grep -c "tile('review'" public/index.html) $(grep -c "^function classifyDay" server.js) $(grep -c "board.review = classifyDay(board).counts" server.js) $(grep -c "app.get('/api/day-review'" server.js)" "('vulcan', 'Vulcan', False)|1 2 1 1 1 1 1 1"
echo "── 63. Operational audit 5 — location, jobsite, vendor and cost integrity: a delivered order keeps its jobsite and customer; a yard is one record (look-alikes said, never merged; a street address; an unknown or inactive yard refused); the same address is the same site and carries its pin; a voided bill or batch gives its rate back; what was paid or invoiced is history, never a price source; evidence trusts confirmed pins; a deleted geofence names its mapping stale ──"
mg POST /api/_test/qb-fake '{"mode":"ok","billMode":"ok"}' >/dev/null
o5drv() { mg POST /api/drivers "{\"username\":\"$1\",\"password\":\"${1}1234\",\"displayName\":\"$2\"}" >/dev/null; mg POST /api/fleet/trucks "{\"truckNum\":\"Truck #$3\",\"type\":\"End Dump\",\"defaultDriverId\":\"$1\"}" | jq "d['truck']['id']"; }
o5ck()  { local c=$(mktemp); curl -s -c $c -X POST -d "username=$1&password=${1}1234" $B/login -o /dev/null; echo $c; }
o5po()  { mg POST /api/pos "{\"po\":{\"poNumber\":\"$1\",\"customer\":\"$2\",\"deliveryDate\":\"$TODAY\",\"address\":\"$3\",\"city\":\"$4\",\"plannedVendorId\":\"${6:-vulcan}\"},\"splits\":[$5]}" | jq "d.get('po',{}).get('id') or (d.get('error') or '')[:90]"; }
o5split() { echo "{\"truckId\":\"$1\",\"truckUnitId\":\"$2\",\"material\":\"$3\",\"loadsAssigned\":$4,\"vendorId\":\"${5:-vulcan}\"}"; }
o5lds() { curl -s -b $M $B/api/data | jq "' '.join(l['id'] for l in d['loads'] if l['poId']=='$1')"; }
o5pof() { curl -s -b $M $B/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);p=[x for x in d['pos'] if x['id']=='$1'][0];print($2)"; }
o5trip() { dr $1 $2 '{"action":"start-trip"}' >/dev/null; dr $1 $2 "{\"action\":\"arrived-pickup\",\"yardId\":\"${3:-vulcan}\"}" >/dev/null; dr $1 $2 "{\"action\":\"loaded\",\"ticket\":{\"source\":\"supplier\",\"number\":\"T63$RANDOM$RANDOM\",\"netTons\":24.5,\"photo\":\"$PNG\"}}" >/dev/null; dr $1 $2 '{"action":"arrived-jobsite"}' >/dev/null; dr $1 $2 '{"action":"trip-complete"}' >/dev/null; }
o5sub() { curl -s -b $1 -H "$J" -X PUT $B/api/loads/$2 -d "{\"pod\":{\"signedBy\":\"Foreman\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null; dr $1 $2 '{"action":"delivered"}' >/dev/null; }
o5code() { python3 -c "import sys,json;t=sys.stdin.read().rsplit(' ',1);d=json.loads(t[0]) if t[0].strip() else {};print(t[1], d.get('code') or '', $1)"; }
o5ms() { echo $(( $(date +%s) * 1000 - ${1:-0} * 1000 )); }
o5fence() { local x="" nm=""; [ "$1" = EXIT ] && x=",\"exitDateTime\":$(o5ms $6),\"durationMinutes\":$(( ($5 - $6) / 60 ))"; [ -n "$4" ] && nm=",\"name\":\"$4\",\"fenceGroup\":\"Yards\""; echo "{\"eventType\":\"FENCE_$1\",\"enterDateTime\":$(o5ms $5)$x,\"tracker\":{\"trackerId\":$2,\"name\":\"VBT #$2\"},\"geofence\":{\"geofenceId\":$3$nm},\"company\":{\"companyId\":1}}"; }
o5pos() { echo "{\"date\":$2,\"latitude\":$3,\"longitude\":$4,\"tracker\":{\"trackerId\":$1,\"name\":\"VBT #$1\"},\"company\":{\"companyId\":1}}"; }
# ── A. a delivered order keeps its jobsite and its customer ──
XTA=$(o5drv oa5a Ada 106); XCA=$(o5ck oa5a)
XPA=$(o5po L5-A "Site Five Co" "400 Ridge Rd" "Clovis" "$(o5split oa5a $XTA "3/4 Rock" 1),$(o5split oa5a $XTA "3/4 Rock" 1)"); read XLA1 XLA2 <<< "$(o5lds $XPA)"
dr $XCA $XLA1 '{"action":"start-trip"}' >/dev/null
R1=$(mg PUT /api/pos/$XPA '{"address":"400 Ridge Road"}' -w ' %{http_code}' | o5code "''")
o5trip $XCA $XLA1
chk "63 a trip started but nothing delivered: the address still follows the order (200); one trip completed: address and customer are frozen (403 po_work_frozen, naming the field) while notes and the PO number still change; the delivered load's destination is unchanged" "$R1|$(mg PUT /api/pos/$XPA '{"address":"1 Elsewhere"}' -w ' %{http_code}' | o5code "d.get('frozenFields')")|$(mg PUT /api/pos/$XPA '{"customer":"Other Co"}' -w ' %{http_code}' | o5code "d.get('frozenFields')")|$(mgc PUT /api/pos/$XPA '{"notes":"gate 4"}') $(mgc PUT /api/pos/$XPA '{"poNumber":"L5-A2"}')|$(curl -s -b $M $B/api/today | jq "[l['destination'] for l in d['loads'] if l['id']=='$XLA1'][0]")" "200  |403 po_work_frozen ['address']|403 po_work_frozen ['customer']|200 200|400 Ridge Road, Clovis"
# ── B. a yard is one record ──
chk "   a new yard that looks like an existing one is a possible duplicate (409 possible_duplicate, candidates named) — one name inside the other, a distinctive word in common, the same street address; a generic word ('Rock') is not; the office creates it anyway with force; a rename onto another yard's name is refused; the street address is carried to the driver's yard list and the office's pickup" "$(mg POST /api/vendors '{"name":"Vulcan Materials","location":"Fresno, CA"}' -w ' %{http_code}' | o5code "[c['name'] for c in d.get('candidates', [])]")|$(mg POST /api/vendors '{"name":"Keith Farms Fowler"}' -w ' %{http_code}' | o5code "[c['name'] for c in d.get('candidates', [])]")|$(mg POST /api/vendors '{"name":"Zeta Rock","location":"Fresno, CA"}' -w ' %{http_code}' | o5code "d.get('vendor',{}).get('id')")|$(mg POST /api/vendors '{"name":"Vulcan Materials","address":"1 Quarry Rd","force":true}' -w ' %{http_code}' | o5code "d.get('vendor',{}).get('address')")|$(mg POST /api/vendors '{"name":"Westside Pit","address":"1 Quarry Rd"}' -w ' %{http_code}' | o5code "[c['name'] for c in d.get('candidates', [])]")|$(mg PUT /api/vendors/hanson '{"name":"Vulcan"}' -w ' %{http_code}' | o5code "''")|$(mg PUT /api/vendors/vulcan '{"address":"2 Mine Rd"}' >/dev/null; curl -s -b $XCA $B/api/data | jq "[y.get('address') for y in d['yards'] if y['id']=='vulcan'][0]") $(curl -s -b $M $B/api/data | jq "[l['pickup']['address'] for l in d['loads'] if l['id']=='$XLA2'][0]")" "409 possible_duplicate ['Vulcan']|409 possible_duplicate ['Keith Farms']|200  zeta-rock|200  1 Quarry Rd|409 possible_duplicate ['Vulcan Materials']|400  |2 Mine Rd 2 Mine Rd"
mg PUT /api/vendors/cemex '{"active":false}' >/dev/null
XPK=$(o5po L5-K "Site Five Co" "7 Plan St" "Fresno" "$(o5split "" "" Sand 1 teichert)" teichert)
chk "   a yard named on an order must exist and be active: an unknown split yard, an unknown planned yard, an inactive yard on a split and on Quick Assign are refused (400, saying why); a yard an unstarted order plans from is not deleted" "$(o5po L5-B1 "Site Five Co" "7 St" "Fresno" "$(o5split oa5a $XTA Sand 1 nope)")|$(o5po L5-B2 "Site Five Co" "7 St" "Fresno" "$(o5split oa5a $XTA Sand 1 vulcan)" nope)|$(o5po L5-B3 "Site Five Co" "7 St" "Fresno" "$(o5split oa5a $XTA Sand 1 cemex)")|$(mg POST /api/loads/$XLA2/assign '{"yardId":"cemex"}' -w ' %{http_code}' | o5code "''")|$(mgc DELETE /api/vendors/teichert)" "Unknown pickup yard \"nope\"|Unknown pickup yard \"nope\"|CEMEX is inactive — mark it active on Vendors or pick another yard|400  |400"
mg PUT /api/vendors/cemex '{"active":true}' >/dev/null
# ── C. the same address is the same site, and carries its pin ──
XPJ1=$(o5po L5-J1 "Site Five Co" "800 Ridge Rd" "Clovis" "$(o5split oa5a $XTA Sand 1)"); mg PUT /api/pos/$XPJ1/location '{"lat":36.82,"lng":-119.70}' >/dev/null
XPJ2=$(o5po L5-J2 "Site Five Co" "800 Ridge Rd." "CLOVIS" "$(o5split oa5a $XTA Sand 1)"); C0=$(o5pof $XPJ2 "(p.get('geo') or {}).get('lat'), (p.get('geo') or {}).get('inheritedFromPoId')=='$XPJ1', (p.get('geo') or {}).get('inheritedBy')"); XPJ3=$(o5po L5-J3 "Site Five Co" "800 Ridge Road" "Clovis" "$(o5split oa5a $XTA Sand 1)")
C1=$(o5pof $XPJ3 "p.get('geo')"); sleep 1; mg PUT /api/pos/$XPJ3/location '{"lat":36.83,"lng":-119.71}' >/dev/null; mg PUT /api/pos/$XPJ2/location '{"lat":36.84,"lng":-119.72}' >/dev/null
XPJ4=$(o5po L5-J4 "Another Five Co" "800 Ridge Rd" "Clovis" "$(o5split oa5a $XTA Sand 1)"); o5po L5-J5 "Site  Five Co" "1 St" "Fresno" "$(o5split oa5a $XTA Sand 1)" >/dev/null
chk "   the same address typed again (a trailing period, capitals) is the same site and inherits its pin, marked inherited; 'Road' is not guessed to be 'Rd'; the site list keys them together and carries the newest confirmed pin; another customer's identical address inherits nothing; a doubled space is the same customer" "$C0|$C1|$(curl -s -b $M "$B/api/jobsites?customer=Site%20Five%20Co" | jq "[(s['address'], s['count'], (s['geo'] or {}).get('lat'), s['geoPoId']=='$XPJ2') for s in d['jobsites'] if '800 ridge' in s['address'].lower()]")|$(o5pof $XPJ4 "p.get('geo')")|$(curl -s -b $M $B/api/data | jq "len([c['name'] for c in d['customers'] if 'site five' in c['name'].lower()]), [p['customer'] for p in d['pos'] if p['poNumber']=='L5-J5'][0]")" "36.82 True same-address|None|[('800 Ridge Rd.', 2, 36.84, True), ('800 Ridge Road', 1, 36.83, False)]|None|1 Site Five Co"
# ── D. a voided vendor bill gives its rate back; what was paid is history ──
XTB=$(o5drv oa5b Bo 107); XCB=$(o5ck oa5b)
XPB=$(o5po L5-D "Site Five Co" "9 Sand St" "Fresno" "$(o5split oa5b $XTB Sand 1 hanson)" hanson); XLB=$(o5lds $XPB); o5trip $XCB $XLB hanson; o5sub $XCB $XLB; mg POST /api/loads/$XLB/approve '{}' >/dev/null
R0=$(mgc POST /api/vendor-bills "{\"loadIds\":[\"$XLB\"]}"); mg POST /api/vendors/hanson/prices '{"material":"Sand","unit":"ton","price":31}' >/dev/null
XVB1=$(mg POST /api/vendor-bills "{\"loadIds\":[\"$XLB\"]}" | jq "d['batches'][0]['id'] if 'batches' in d else d['bills'][0]['id']")
F1=$(load $XLB "l['trips'][0]['vendorRate'], l['trips'][0]['vendorRateIsDefault'], l['trips'][0].get('vendorRateFixedBy')=='$XVB1'")
mg POST /api/vendor-bills/$XVB1/void '{"reason":"wrong price"}' >/dev/null
D1=$(load $XLB "l['trips'][0]['vendorRateIsDefault'], l['trips'][0].get('vendorRateFixedBy'), l['trips'][0].get('vendorRateUnfixedBy')=='$XVB1'")
XHP=$(curl -s -b $M $B/api/vendors | jq "[p['id'] for p in d['vendorPrices']['hanson'] if p['material']=='Sand'][0]"); mg PUT /api/vendors/hanson/prices/$XHP '{"price":33}' >/dev/null
XVB2=$(mg POST /api/vendor-bills "{\"loadIds\":[\"$XLB\"]}" | python3 -c "import json,sys;d=json.load(sys.stdin);b=d['bills'][0];print(b['id'], b['lineItems'][0]['rate'], b['totalAmount'])")
chk "   Hanson had no Sand price (default, bill refused 400); the office adds \$31 and bills — the bill fixes \$31 onto the trip; the bill is voided: the trip is a placeholder again (unfixed by that bill); the price is corrected to \$33 and the new bill charges \$33 · \$825, as Material Costs says" "$R0|$F1|$D1|${XVB2#* }|$(curl -s -b $M $B/api/material-costs | jq "d['vendors']['hanson']['byMaterial']['Sand']['cost']")" "400|31 False True|True  True|33 825|825"
H0=$(curl -s -b $M "$B/api/price-history?side=vendor&vendorId=hanson&material=Sand" | jq "d['count'], d['last']"); mg POST /api/vendor-bills/${XVB2%% *}/send '{}' >/dev/null
chk "   price history is read from SENT documents only: nothing before the send (the voided \$31 bill is not history), the \$33 bill after it (rate, unit, kind, date, document); a material never billed has none; the side's key is required (400); a driver gets 403" "$H0|$(curl -s -b $M "$B/api/price-history?side=vendor&vendorId=hanson&material=Sand" | jq "d['count'], (d['last'] or {}).get('rate'), (d['last'] or {}).get('unit'), (d['last'] or {}).get('kind'), (d['last'] or {}).get('date')=='$TODAY', (d['last'] or {}).get('docId')=='${XVB2%% *}'")|$(curl -s -b $M "$B/api/price-history?side=vendor&vendorId=hanson&material=Gravel" | jq "d['count'], d['last']")|$(curl -s -b $M -o /dev/null -w '%{http_code}' "$B/api/price-history?side=vendor&material=Sand") $(curl -s -b $XCB -o /dev/null -w '%{http_code}' "$B/api/price-history?side=vendor&vendorId=hanson&material=Sand")" "0 None|1 33 ton vendor bill True True|0 None|400 403"
# ── E. the batch fixes a default customer rate; a voided batch gives the placeholder back ──
XPC=$(o5po L5-E "Nopr Five Co" "1 Dirt St" "Fresno" "$(o5split oa5b $XTB Dirt 1 vbt)" vbt); XLC=$(o5lds $XPC); o5trip $XCB $XLC vbt; o5sub $XCB $XLC; mg POST /api/loads/$XLC/approve '{}' >/dev/null
E0=$(load $XLC "l['customerRateIsDefault'], l['billing']['amount']"); mg POST /api/customer-prices '{"customer":"Nopr Five Co","material":"Dirt","unit":"ton","price":50}' >/dev/null
XBA=$(mg POST /api/billing-batches "{\"loadIds\":[\"$XLC\"]}" | jq "d['batches'][0]['id']")
E1=$(load $XLC "l['customerRate'], l['customerRateIsDefault'], l.get('customerRateFixedBy')=='$XBA', l['billing']['amount']")
XCP=$(curl -s -b $M $B/api/customer-prices | python3 -c "import json,sys;d=json.load(sys.stdin);c=[c for c in d['customers'] if c['key']=='nopr five co'][0];print(c['prices'][0]['id'])"); mg PUT /api/customer-prices/nopr%20five%20co/$XCP '{"price":60}' >/dev/null
E2=$(load $XLC "l['billing']['amount'], l['billing']['rate'], l['billing']['rateIsDefault']"); mg POST /api/billing-batches/$XBA/send '{}' >/dev/null
E3=$(curl -s -b $M "$B/api/price-history?side=customer&customer=Nopr%20Five%20Co&material=Dirt" | jq "d['count'], (d['last'] or {}).get('rate'), (d['last'] or {}).get('kind')")
mg POST /api/billing-batches/$XBA/void '{"reason":"redo"}' >/dev/null
chk "   a load approved at the default (\$25 · 625) follows the list once the price (\$50) exists; the batch fixes \$50 onto the load (no longer a default, fixed by that batch) so a later list change (\$60) leaves Load Details at the invoice's \$50; the sent invoice is the customer's price history (\$50); voiding the batch makes the rate a placeholder again (follows the list: \$60 · 1500) and the voided invoice is no longer history" "$E0|$E1|$E2|$E3|$(load $XLC "l['customerRateIsDefault'], l.get('customerRateFixedBy'), l['billing']['amount']")|$(curl -s -b $M "$B/api/price-history?side=customer&customer=Nopr%20Five%20Co&material=Dirt" | jq "d['count']")" "True 625|50 False True 1250|1250 50 False|1 50 invoice|True  1500|0"
# ── F. Material Costs: trips at two fixed rates are a range, never one number ──
XPM=$(o5po L5-F "Site Five Co" "6 Mix St" "Fresno" "$(o5split oa5a $XTA "3/4 Rock" 2)"); XLM=$(o5lds $XPM); o5trip $XCA $XLM
XVP=$(curl -s -b $M $B/api/vendors | jq "[p['id'] for p in d['vendorPrices']['vulcan'] if p['material']=='3/4 Rock'][0]"); XVP0=$(curl -s -b $M $B/api/vendors | jq "[p['price'] for p in d['vendorPrices']['vulcan'] if p['material']=='3/4 Rock'][0]")
mg PUT /api/vendors/vulcan/prices/$XVP "{\"price\":$((XVP0+7))}" >/dev/null; o5trip $XCA $XLM; o5sub $XCA $XLM
chk "   two trips of one material at one yard, the list price changed between them: each trip keeps the rate it loaded at, Material Costs says the unit price is mixed with its range, and the audit log has the price edit" "$(load $XLM "[t['vendorRate'] for t in l['trips']]")|$(curl -s -b $M $B/api/material-costs | jq "(lambda m: (m['mixedRates'], m['unitPriceMin'], m['unitPriceMax']))(d['vendors']['vulcan']['byMaterial']['3/4 Rock'])")|$(curl -s -b $M "$B/api/audit-log?action=edited-price" | jq "any(e['details'].get('before',{}).get('price')==$XVP0 and e['details'].get('after',{}).get('price')==$((XVP0+7)) for e in d['entries'])")" "[$XVP0, $((XVP0+7))]|(True, $XVP0, $((XVP0+7)))|True"
mg PUT /api/vendors/vulcan/prices/$XVP "{\"price\":$XVP0}" >/dev/null
# ── G. evidence trusts a confirmed pin; the review names a yard the telemetry disagrees with; a deleted geofence names its mapping stale ──
XTG=$(o5drv oa5g Gus 108); XCG=$(o5ck oa5g); mg PUT /api/fleet/trucks/$XTG/linxup '{"trackerId":7563}' >/dev/null
mg POST /api/vendors '{"name":"Farpit Yard","location":"Fresno, CA","force":true}' >/dev/null; mg PUT /api/vendors/farpit-yard/location '{"lat":36.90,"lng":-119.90}' >/dev/null; mg POST /api/vendors/farpit-yard/prices '{"material":"Sand","unit":"ton","price":20}' >/dev/null
XPG=$(o5po L5-G "Fence Five Co" "1 Fence St" "Fresno" "$(o5split oa5g $XTG Sand 1 farpit-yard)" farpit-yard); XLG=$(o5lds $XPG)
dr $XCG $XLG '{"action":"start-trip"}' >/dev/null; dr $XCG $XLG '{"action":"arrived-pickup","yardId":"farpit-yard"}' >/dev/null
echo "   (63 diag) position: $(lx position "$(o5pos 7563 $(o5ms 30) 35.37 -119.02)" -w ' %{http_code}' | cut -c1-160) | $(lx position "$(o5pos 7563 $(o5ms 10) 35.37 -119.02)" -w ' %{http_code}' | cut -c1-160) | health: $(curl -s -b $M $B/api/linxup/health | jq "d['counters']")"
dr $XCG $XLG "{\"action\":\"loaded\",\"ticket\":{\"source\":\"supplier\",\"number\":\"T63G\",\"netTons\":24,\"photo\":\"$PNG\"}}" >/dev/null; dr $XCG $XLG '{"action":"arrived-jobsite"}' >/dev/null; dr $XCG $XLG '{"action":"trip-complete"}' >/dev/null; o5sub $XCG $XLG
chk "   the driver tapped Arrived at a yard whose confirmed pin is 100 mi from where the tracker reported: the load's evidence flags a pickup mismatch; once submitted, the board's telemetry issues name the load and the end-of-day review lists the disagreement as attention with what to check" "$(curl -s -b $M $B/api/loads/$XLG/telemetry | jq "d['trips'][0]['pickup']['evidence'], d['trips'][0]['pickup']['pinned'], d['trips'][0]['pickup']['pinUnconfirmed'], [f['kind'] for f in d['flags']]")|$(curl -s -b $M $B/api/today | jq "[(t['kind'], t['loadId']) for t in d['telemetryIssues'] if t.get('loadId')=='$XLG']")|$(curl -s -b $M $B/api/day-review | jq "[(i['state'], any(r.startswith('Pickup telemetry mismatch') and r.endswith('Check the yard and the jobsite before approving.') for r in i['reasons'])) for i in d['items'] if i['id']=='$XLG'][0]")" "none True False ['pickup-mismatch']|[('pickup-mismatch', '$XLG')]|('attention', True)"
echo "   (63 diag) fence: $(lx geofence-event "$(o5fence ENTER 7563 9063 'Farpit Fence' 7200)" -w ' %{http_code}' | cut -c1-200) | $(lx geofence-event "$(o5fence EXIT 7563 9063 'Farpit Fence' 7200 7000)" -w ' %{http_code}' | cut -c1-120)"
G0=$(mgc PUT /api/vendors/farpit-yard/linxup-geofence '{"geofenceId":9063}'); lx geofence-change '{"geofenceId":9063,"action":"DELETE","name":"Farpit Fence","company":{"companyId":1}}' >/dev/null
chk "   the yard is mapped to a geofence (200); Linxup deletes that geofence: the mirror drops it, the mapping is named stale (deleted, by name) while the yard's own record is not rewritten, the board carries an attention item, mapping another yard to it is refused with the date; a Geofence Change UPDATE brings it back under its new name and the staleness ends" "$G0|$(curl -s -b $M $B/api/linxup/geofences | jq "9063 in [g['geofenceId'] for g in d['geofences']], [(s['name'], s['geofenceId'], s['deleted'], s['geofenceName']) for s in d['staleMappings']]")|$(curl -s -b $M $B/api/vendors | jq "[v.get('linxupGeofenceId') for v in d['vendors'] if v['id']=='farpit-yard'][0]")|$(curl -s -b $M $B/api/today | jq "[t['text'].startswith('Farpit Yard is mapped to Linxup geofence \"Farpit Fence\" (9063), which Linxup deleted') for t in d['telemetryIssues'] if t['kind']=='fence-gone']")|$(mg PUT /api/vendors/hanson/linxup-geofence '{"geofenceId":9063}' | jq "d.get('error')")|$(lx geofence-change '{"geofenceId":9063,"action":"UPDATE","name":"Farpit — North Gate","company":{"companyId":1}}' >/dev/null; curl -s -b $M $B/api/linxup/geofences | jq "d['staleMappings'], [g['name'] for g in d['geofences'] if g['geofenceId']==9063]")" "200|False [('Farpit Yard', 9063, True, 'Farpit Fence')]|9063|[True]|Linxup deleted that geofence (\"Farpit Fence\") on $TODAY — pick a current one.|[] ['Farpit — North Gate']"
mg PUT /api/vendors/farpit-yard/linxup-geofence '{"geofenceId":null}' >/dev/null
chk "   static: the work freeze, the look-alike rule, the jobsite key and pin choice, the rate fixes and unfixes, the price-history route, the mirror's deletions, the stale flag; the page's hints, confirm and wording" "$(grep -c "PO_WORK_FIELDS" server.js)|$(grep -c "function vendorLookalikes" server.js)|$(grep -c "^function jobsiteKey" server.js) $(grep -c "^function bestJobsitePin" server.js)|$(grep -c "customerRateFixedBy" server.js) $(grep -c "vendorRateUnfixedBy" server.js)|$(grep -c "app.get('/api/price-history'" server.js)|$(grep -c "async deleteGeofence" linxup.js) $(grep -c "t === 'geofence-change'" linxup.js)|$(grep -c "kind: 'fence-gone'" server.js)|$(grep -c "vendorPin && vendorPin.confirmed" server.js)|$(grep -c "function vendorPriceHint" public/index.html) $(grep -c "function customerPriceHint" public/index.html) $(grep -c "function poUseJobsite" public/index.html) $(grep -c "possible_duplicate" public/index.html) $(grep -c "mixedRates" public/index.html) $(grep -c "pinUnconfirmed" public/index.html)" "2|1|1 1|2 1|1|1 1|1|1|1 1 1 1 1 2"
# ── OA5 closure verification: telemetry is evidence only; a default rate is never price history; the freeze boundary; an unconfirmed pin travels as unconfirmed; master data may change, history may not ──
o5hash() { curl -s -b $M $B/api/data | python3 -c "import json,sys,hashlib;d=json.load(sys.stdin);print(hashlib.md5(json.dumps({k:d.get(k) for k in ('loads','pos','vendors','customers','vendorPrices','customerPrices')},sort_keys=True).encode()).hexdigest())"; }
o5docs() { echo "$(curl -s -b $M $B/api/billing-batches | jq "len(d['items'])") $(curl -s -b $M $B/api/vendor-bills | jq "len(d['items'])")"; }
XH1=$(o5hash); XD1=$(o5docs)
lx position "$(o5pos 7563 $(o5ms 5) 35.40 -119.05)" >/dev/null; lx position "$(o5pos 7563 $(o5ms 2) 35.41 -119.06)" >/dev/null
lx geofence-event "$(o5fence ENTER 7563 9064 'Elsewhere Pit' 40)" >/dev/null
lx geofence-change '{"geofenceId":9064,"action":"UPDATE","name":"Elsewhere Pit — Gate B","company":{"companyId":1}}' >/dev/null
curl -s -b $M $B/api/loads/$XLG/telemetry -o /dev/null; curl -s -b $M $B/api/day-review -o /dev/null; curl -s -b $M $B/api/today -o /dev/null; curl -s -b $M $B/api/fleet/live -o /dev/null
chk "   closure · Linxup is evidence only: positions 100 mi off, a visit to another yard's fence and a fence renamed, then the evidence, the board, the review and the fleet map read — every VBT record (loads, orders, yards, customers, prices) is byte-identical, the load is still submitted, on its driver, truck and yard, no batch or bill appeared, and the disagreement is an attention item, not a change; the mirror never references the dispatch store and the evidence reader never saves" "$([ "$(o5hash)" = "$XH1" ] && echo same || echo CHANGED)|$([ "$(o5docs)" = "$XD1" ] && echo same || echo CHANGED)|$(load $XLG "l['approvalStatus'], l['truckId'], l['truckUnitId']=='$XTG', l['vendorId'], l['loadsDelivered']")|$(curl -s -b $M $B/api/day-review | jq "[i['state'] for i in d['items'] if i['id']=='$XLG'][0]")|$(grep -c "store\." linxup.js) $(awk '/^async function loadTelemetryEvidence/,/^}/' server.js | grep -c "saveData\|\.approvalStatus = \|\.truckId = \|\.vendorId = ")" "same|same|submitted oa5g True farpit-yard 1|attention|1 0"
XPN=$(o5po L5-N "Nopr Five Co" "2 Dirt St" "Fresno" "$(o5split oa5b $XTB "Base Rock" 1 vbt)" vbt); XLN=$(o5lds $XPN); o5trip $XCB $XLN vbt; o5sub $XCB $XLN; mg POST /api/loads/$XLN/approve '{}' >/dev/null
XBN=$(mg POST /api/billing-batches "{\"loadIds\":[\"$XLN\"]}" | jq "d['batches'][0]['id']"); mg POST /api/billing-batches/$XBN/send '{}' >/dev/null
chk "   closure · a default rate is never price history: an invoice sent at the default carries rateIsDefault on its line, the load is fixed at the invoiced number (a placeholder no more, by that batch), and last-invoiced for the material stays empty — a default is identifiable everywhere and a suggestion comes only from a real price on a sent document" "$(curl -s -b $M $B/api/billing-batches | jq "[ln['rateIsDefault'] for b in d['items'] if b['id']=='$XBN' for ln in b['lineItems']]")|$(load $XLN "l['customerRateIsDefault'], l.get('customerRateFixedBy')=='$XBN'")|$(curl -s -b $M "$B/api/price-history?side=customer&customer=Nopr%20Five%20Co&material=Base%20Rock" | jq "d['count'], d['last']")" "[True]|False True|0 None"
XPQ=$(o5po L5-Q "Site Five Co" "5 Edge St" "Fresno" "$(o5split oa5a $XTA Sand 1)"); XLQ=$(o5lds $XPQ)
dr $XCA $XLQ '{"action":"start-trip"}' >/dev/null; dr $XCA $XLQ '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null; dr $XCA $XLQ "{\"action\":\"loaded\",\"ticket\":{\"source\":\"supplier\",\"number\":\"T63Q\",\"netTons\":24,\"photo\":\"$PNG\"}}" >/dev/null
XQ1=$(mgc PUT /api/pos/$XPQ '{"address":"6 Edge St"}'); dr $XCA $XLQ '{"action":"arrived-jobsite"}' >/dev/null; dr $XCA $XLQ '{"action":"trip-complete"}' >/dev/null; o5sub $XCA $XLQ; mg POST /api/loads/$XLQ/reject '{"reason":"photo"}' >/dev/null
XQ2=$(mg PUT /api/pos/$XPQ '{"address":"7 Edge St"}' -w ' %{http_code}' | o5code "''"); o5sub $XCA $XLQ; mg POST /api/loads/$XLQ/approve '{}' >/dev/null; mg POST /api/loads/$XLQ/void '{"reason":"wrong site"}' >/dev/null
chk "   closure · the freeze boundary: loaded but not delivered — the address still follows the order (200); sent back with a delivery on record — frozen (po_work_frozen); approved then voided — still frozen by the approval rule (a voided approved load stays on the record), so a wrong site after delivery is a new PO" "$XQ1|$XQ2|$(mg PUT /api/pos/$XPQ '{"address":"8 Edge St"}' -w ' %{http_code}' | o5code "d.get('frozenFields')")" "200|403 po_work_frozen |403  ['address']"
XPU1=$(o5po L5-U1 "Site Five Co" "950 Ridge Rd" "Clovis" "$(o5split oa5a $XTA Sand 1)"); mg POST /api/_test/set-po "{\"id\":\"$XPU1\",\"patch\":{\"geo\":{\"lat\":36.7,\"lng\":-119.6,\"source\":\"geocoded\",\"confirmed\":false,\"setAt\":\"2026-10-07T00:00:00Z\"}}}" >/dev/null
XPU2=$(o5po L5-U2 "Site Five Co" "950 Ridge Rd" "Clovis" "$(o5split oa5a $XTA Sand 1)"); mg PUT /api/pos/$XPU1/location '{"confirm":true}' >/dev/null
XPU3=$(o5po L5-U3 "Site Five Co" "950 Ridge Rd" "Clovis" "$(o5split oa5a $XTA Sand 1)")
chk "   closure · an unconfirmed (geocoded) pin travels as unconfirmed — evidence will not use it; once confirmed on the first PO, the next PO inherits a confirmed pin while the earlier copy stays its own record" "$(o5pof $XPU2 "(p.get('geo') or {}).get('confirmed'), (p.get('geo') or {}).get('source'), (p.get('geo') or {}).get('inheritedBy')")|$(o5pof $XPU3 "(p.get('geo') or {}).get('confirmed'), (p.get('geo') or {}).get('inheritedBy')")|$(o5pof $XPU2 "(p.get('geo') or {}).get('confirmed')")" "False geocoded same-address|True same-address|False"
mg POST /api/customer-prices '{"customer":"Snap Five Co","material":"3/4 Rock","unit":"ton","price":30}' >/dev/null
XPS=$(o5po L5-S "Snap Five Co" "77 Snap Ave" "Clovis" "$(o5split oa5a $XTA "3/4 Rock" 1)"); XLS=$(o5lds $XPS); o5trip $XCA $XLS; o5sub $XCA $XLS; mg POST /api/loads/$XLS/approve '{}' >/dev/null
XBS=$(mg POST /api/billing-batches "{\"loadIds\":[\"$XLS\"]}" | jq "d['batches'][0]['id']"); mg POST /api/billing-batches/$XBS/send '{}' >/dev/null
XVS=$(mg POST /api/vendor-bills "{\"loadIds\":[\"$XLS\"]}" | jq "d['bills'][0]['id']"); mg POST /api/vendor-bills/$XVS/send '{}' >/dev/null
o5snap() { echo "$(load $XLS "l['vendorName'], l['customerRate'], l['customerRateIsDefault'], l['billing']['amount'], l['billing']['cost']['amount'], l['trips'][0]['actualYardName'], l['trips'][0]['vendorRate']")|$(curl -s -b $M $B/api/billing-batches | jq "[(ln['rate'], ln['amount']) for b in d['items'] if b['id']=='$XBS' for ln in b['lineItems']]")|$(curl -s -b $M $B/api/vendor-bills | jq "[(ln['rate'], ln['amount']) for b in d['items'] if b['id']=='$XVS' for ln in b['lineItems']]")|$(o5pof $XPS "p['customer'], p['address'], p['city']")"; }
XS1=$(o5snap); XDR=$(curl -s -b $M $B/api/default-rates | jq "(d['defaultRates']['customer'].get('3/4 Rock') or {}).get('price'), (d['defaultRates']['vendor'].get('3/4 Rock') or {}).get('price')")
mg PUT /api/vendors/vulcan '{"name":"Vulcan Materials Inc","address":"9 New Quarry Rd","location":"Madera, CA"}' >/dev/null; mg PUT /api/vendors/vulcan/prices/$XVP '{"price":55}' >/dev/null
XCS=$(curl -s -b $M $B/api/customer-prices | python3 -c "import json,sys;d=json.load(sys.stdin);c=[c for c in d['customers'] if c['key']=='snap five co'][0];print(c['prices'][0]['id'])"); mg PUT /api/customer-prices/snap%20five%20co/$XCS '{"price":99}' >/dev/null
mg PUT /api/default-rates '{"side":"customer","material":"3/4 Rock","unit":"ton","price":77}' >/dev/null; mg PUT /api/default-rates '{"side":"vendor","material":"3/4 Rock","unit":"ton","price":66}' >/dev/null
chk "   closure · master data may change, history may not: the yard renamed and moved, its list price, the customer's price and both default rates changed afterwards — the load's snapshot, the trip's stamp, the sent invoice line and the sent bill line are identical; the board's yard label is the live name (a label, not the record) while the trip keeps the name it was stamped with" "$([ "$(o5snap)" = "$XS1" ] && echo same || echo "CHANGED: $(o5snap)")|$(curl -s -b $M $B/api/today | jq "[l['yardName'] for l in d['loads'] if l['id']=='$XLS'][0]")|$(load $XLS "l['trips'][0]['actualYardName']")" "same|Vulcan Materials Inc|Vulcan"
mg PUT /api/vendors/vulcan '{"name":"Vulcan","address":"","location":"Fresno, CA"}' >/dev/null; mg PUT /api/vendors/vulcan/prices/$XVP "{\"price\":$XVP0}" >/dev/null
[ "${XDR%% *}" != "None" ] && mg PUT /api/default-rates "{\"side\":\"customer\",\"material\":\"3/4 Rock\",\"unit\":\"ton\",\"price\":${XDR%% *}}" >/dev/null; [ "${XDR##* }" != "None" ] && mg PUT /api/default-rates "{\"side\":\"vendor\",\"material\":\"3/4 Rock\",\"unit\":\"ton\",\"price\":${XDR##* }}" >/dev/null
echo "── 64. Operational audit 6 — dispatch, calendar and the day: a stale sheet or form never overwrites another operator (409, the sheet reopens on the current state; untouched fields still merge; force is not a bypass); a voided load is not dispatched; a split is a whole number of loads; the review calls the office's own step open work, names every-trip-delivered work and reconciles carried work apart; a load finished after midnight stays on the phone to be signed and submitted; the live-refresh version carries the date; master data changes leave the day's record byte-identical ──"
M6B=$(mktemp); curl -s -c $M6B -X POST -d "username=perla&password=perla123" $B/login -o /dev/null
mg6b() { curl -s -b $M6B -H "$J" -X "$1" "$B$2" -d "${3:-"{}"}" "${@:4}"; }
T6=$(curl -s $B/api/_test/today | jq "d['today']"); Y6=$(date -d "$T6 -1 day" +%F); D6=$(date -d '+46 day' +%F)
o6bd() { curl -s -b $M $B/api/data | python3 -c "
import json,sys;d=json.load(sys.stdin);l=[x for x in d['loads'] if x['id']=='$1'][0];t=l['trips'][$2]
for kv in '$3'.split(','):
    k,v=kv.split('='); t.setdefault('isoStamps',{})[k]=v
print(json.dumps({'id':'$1','fields':{'trips':l['trips']}}))" > /tmp/o6bd.json; curl -s -b $M -H "$J" -X POST $B/api/_test/set-load -d @/tmp/o6bd.json -o /dev/null; }
o6ago() { date -u -d "-$1 hours" +%FT%T.000Z; }
o6rev() { curl -s -b $M "$B/api/day-review${2:+?date=$2}" | python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
o6it() { o6rev "[(i['state'], i['reasons'], i['next']) for i in d['items'] if i['id']=='$1'][0]" "${2:-}"; }
# ── stale Quick Assign: operator A opens the sheet (driver: none); operator B assigns Beryle; A submits her older choice ──
XP6=$(o4po R6-A "Review Four Co" '{"truckId":"","material":"3/4 Rock","loadsAssigned":1,"vendorId":"vulcan"}' vulcan "$D6"); XL6=$(o4lds $XP6)
mg6b POST /api/loads/$XL6/assign '{"driverId":"beryle","base":{"driverId":null}}' >/dev/null
chk "64 two operators, one sheet: A opened the sheet on 'unassigned', B put Beryle on; A's older choice (Matthew) is refused — 409 stale_assignment naming the field and the current driver; B's assignment stands; force does not bypass staleness" "$(mg POST /api/loads/$XL6/assign '{"driverId":"matthew","base":{"driverId":null}}' -w ' %{http_code}' | o5code "d.get('stale'), d.get('current',{}).get('driverId')")|$(load $XL6 "l['truckId']")|$(mg POST /api/loads/$XL6/assign '{"driverId":"matthew","base":{"driverId":null},"force":true,"reason":"x"}' -w ' %{http_code}' | o5code "''")" "409 stale_assignment ['driver'] beryle|beryle|409 stale_assignment "
chk "   a field the stale sheet did not touch still merges (the truck, base as shown: 200, Beryle kept); reopened on the current state (base Beryle) the change goes through; a client that sends no base is not checked (as before)" "$(mg POST /api/loads/$XL6/assign '{"truckUnitId":"truck-14","base":{"truckUnitId":null}}' -w ' %{http_code}' | o5code "d.get('load',{}).get('driverName'), d.get('truck',{}).get('truckNum')")|$(mg POST /api/loads/$XL6/assign '{"driverId":"matthew","base":{"driverId":"beryle"}}' -w ' %{http_code}' | o5code "d.get('load',{}).get('driverName')")|$(mg POST /api/loads/$XL6/assign '{"driverId":"beryle"}' -w ' %{http_code}' | o5code "d.get('load',{}).get('driverName')")" "200  Beryle Truck #14|200  Matthew|200  Beryle"
chk "   the yard too: the sheet shows the resolved pickup — a base that no longer matches is refused (409 stale_assignment ['yard'])" "$(mg POST /api/loads/$XL6/assign '{"yardId":"vbt","base":{"yardId":"vulcan"}}' -w ' %{http_code}' | o5code "d.get('pickup',{}).get('name')")|$(mg POST /api/loads/$XL6/assign '{"yardId":"vulcan","base":{"yardId":"vulcan"}}' -w ' %{http_code}' | o5code "d.get('stale')")" "200  VBT Yard|409 stale_assignment ['yard']"
# ── stale Edit PO ──
mg6b PUT /api/pos/$XP6 '{"notes":"gate code 4411","base":{"notes":""}}' >/dev/null
chk "   two operators, one Edit PO form: B saved notes meanwhile; A's older form saving its own notes is refused (409 stale_po, the current value returned); A's form changing only the date (shown as current) goes through and B's notes stay; a form without base is not checked" "$(mg PUT /api/pos/$XP6 '{"notes":"call first","base":{"notes":""}}' -w ' %{http_code}' | o5code "d.get('stale'), d.get('current')")|$(mg PUT /api/pos/$XP6 "{\"deliveryDate\":\"$(date -d "$D6 +1 day" +%F)\",\"base\":{\"deliveryDate\":\"$D6\"}}" -w ' %{http_code}' | o5code "d.get('po',{}).get('notes')")|$(mg PUT /api/pos/$XP6 '{"notes":"n3"}' -w ' %{http_code}' | o5code "d.get('po',{}).get('notes')")" "409 stale_po ['notes'] {'notes': 'gate code 4411'}|200  gate code 4411|200  n3"
# ── a voided load is not dispatched; a split is a whole number of loads ──
XP6v=$(o4po R6-V "Review Four Co" '{"truckId":"","material":"3/4 Rock","loadsAssigned":1,"vendorId":"vulcan"}' vulcan "$D6"); XL6v=$(o4lds $XP6v); mg POST /api/loads/$XL6v/void '{"reason":"customer cancelled"}' >/dev/null
chk "   Quick Assign on a voided load is refused (409 load_voided — restore it first), as PUT, the phone, approve and reject already did; nothing written" "$(mg POST /api/loads/$XL6v/assign '{"driverId":"beryle"}' -w ' %{http_code}' | o5code "''")|$(load $XL6v "l['truckId']")" "409 load_voided |None"
chk "   a New PO split's count is a whole number of loads, 1 or more (−1 and 0.5 refused with the material named; a numeric string is fine); a 0 row is a blank line, skipped as before" "$(o4po R6-N1 "Review Four Co" '{"truckId":"","material":"3/4 Rock","loadsAssigned":-1,"vendorId":"vulcan"}' vulcan "$D6")|$(o4po R6-N2 "Review Four Co" '{"truckId":"","material":"3/4 Rock","loadsAssigned":0.5,"vendorId":"vulcan"}' vulcan "$D6")|$(XPN=$(o4po R6-N3 "Review Four Co" '{"truckId":"","material":"3/4 Rock","loadsAssigned":"2","vendorId":"vulcan"},{"truckId":"","material":"Sand","loadsAssigned":0,"vendorId":"vulcan"}' vulcan "$D6"); curl -s -b $M $B/api/data | jq "[l['loadsAssigned'] for l in d['loads'] if l['poId']=='$XPN']")" "Loads for 3/4 Rock must be a whole number, 1 or more (got -1)|Loads for 3/4 Rock must be a whole number, 1 or more (got 0.5)|[2]"
# ── the review: the office's own step is open work; every trip delivered is said; approved-not-billed stays clean with its next step ──
XT6=$(o4drv oa6a Ana 126); XC6=$(o4ck oa6a)
XP6r=$(o4po R6-R "Review Four Co" "$(o4split oa6a $XT6 "3/4 Rock" 1)" vulcan "$D6"); XL6r=$(o4lds $XP6r); o4trip $XC6 $XL6r
chk "   the review: every trip delivered but not submitted is open work that names it ('all 1 delivered — waiting for the driver's submission'); submitted with a clean checklist is OPEN with 'approve it' (the office's step, not clean); approved and not billed is clean with 'bill it' (billing is its own cycle)" "$(o6it $XL6r $D6)|$(o4sub $XC6 $XL6r; o6it $XL6r $D6)|$(mg POST /api/loads/$XL6r/approve '{}' >/dev/null; o6it $XL6r $D6)" "('open', [\"all 1 delivered — waiting for the driver's submission\"], '')|('open', ['completed — waiting for approval'], 'approve it')|('clean', ['approved, not yet billed'], 'bill it')"
# ── midnight: yesterday's load, every trip completed after midnight, not yet submitted ──
XT6n=$(o4drv oa6n Nia 127); XC6n=$(o4ck oa6n)
XP6n=$(o4po R6-N "Review Four Co" "$(o4split oa6n $XT6n "3/4 Rock" 1)" vulcan "$Y6"); XL6n=$(o4lds $XP6n); o4trip $XC6n $XL6n
o6bd $XL6n 0 "start=${Y6}T23:30:00.000Z,arrivedPickup=${Y6}T23:45:00.000Z,loadedAt=${Y6}T23:55:00.000Z,arrivedJobsite=$(o6ago 2),completed=$(o6ago 1)"
chk "   a load dated yesterday whose only trip completed after midnight (1 h ago), not yet submitted: it stays on the driver's Today (badged with its day) so he signs and submits without a call to the office — not in the earlier-days banner; the board carries it (Done); today's review says 'all 1 delivered on <yesterday>, not yet submitted' with the next step" "$(curl -s -b $XC6n $B/api/my-dispatch | jq "[(l['deliveryDate'], l['tripsCompleted']) for l in d['loads'] if l['loadId']=='$XL6n'], '$XL6n' in [x.get('id') or x.get('loadId') for x in d.get('earlierOpen',[])]")|$(curl -s -b $M $B/api/today | jq "[(l['bucket'], l['stage']) for l in d['carriedOver'] if l['id']=='$XL6n']")|$(o6it $XL6n)" "[('$Y6', 1)] False|[('in-progress', 'Done')]|('attention', ['all 1 delivered on $Y6, not yet submitted'], 'the driver signs and submits from the phone, or the office moves it to today')"
chk "   today's reconciliation counts the day's own deliveries and names the carried work apart ('N loads carried from earlier days (M deliveries on record there)') — the first sentence's number is the sum over today's rows only" "$(o6rev "(lambda own,car,rc: (sum(i['loadsDelivered'] or 0 for i in own) == (int(rc[0].split(' ')[0]) if rc and rc[0][0].isdigit() else 0), any(__import__('re').match(r'^\d+ loads? carried from earlier days \(\d+ deliver(y|ies) on record there\)\.$', s) for s in rc), sum(i['loadsDelivered'] or 0 for i in car) >= 1))([i for i in d['items'] if i['deliveryDate'] >= d['date']], [i for i in d['items'] if i['deliveryDate'] < d['date']], d['reconciliation'])")" "(True, True, True)"
chk "   he signs and submits from the phone (200, submitted); a load whose trips completed 21 h ago is past the workday window — back to the banner, the office's to move (as before); a half-delivered load from yesterday with nothing under way likewise" "$(o4sub $XC6n $XL6n; load $XL6n "l['approvalStatus'], l['loadsDelivered']")|$(XP6o=$(o4po R6-O "Review Four Co" "$(o4split oa6n $XT6n "3/4 Rock" 1)" vulcan "$Y6"); XL6o=$(o4lds $XP6o); o4trip $XC6n $XL6o; o6bd $XL6o 0 "start=$(o6ago 23),completed=$(o6ago 21)"; curl -s -b $XC6n $B/api/my-dispatch | jq "'$XL6o' in [l['loadId'] for l in d['loads']], '$XL6o' in [x.get('id') or x.get('loadId') for x in d.get('earlierOpen',[])]")|$(XP6h=$(o4po R6-H "Review Four Co" "$(o4split oa6n $XT6n "3/4 Rock" 2)" vulcan "$Y6"); XL6h=$(o4lds $XP6h); o4trip $XC6n $XL6h; o6bd $XL6h 0 "start=$(o6ago 3),completed=$(o6ago 2)"; curl -s -b $XC6n $B/api/my-dispatch | jq "'$XL6h' in [l['loadId'] for l in d['loads']], '$XL6h' in [x.get('id') or x.get('loadId') for x in d.get('earlierOpen',[])]"; o6it $XL6h)" "submitted 1|False True|False True
('attention', ['unfinished since $Y6 — Returning, 1/2 delivered'], 'the driver finishes it or stops early')"
chk "   the live-refresh version carries the operating date: a screen left open across midnight repaints onto the new day (office: 16 hex over the day, the submitted and ready counts, shifts, Linxup, the calendar and the date; driver: his scope and the date)" "$(curl -s -b $M $B/api/dispatch-version | jq "len(d['version'])")|$(curl -s -b $XC6n $B/api/dispatch-version | jq "d['version'].endswith('-' + '$T6'[5:])")" "16|True"
# ── historical integrity: a delivered, approved load's record after the day's master data changes ──
XT6h=$(o4drv oa6h Hal 128); XC6h=$(o4ck oa6h)
XP6s=$(o4po R6-S "Review Four Co" "$(o4split oa6h $XT6h "3/4 Rock" 1)" vulcan "$D6"); XL6s=$(o4lds $XP6s); o4trip $XC6h $XL6s; o4sub $XC6h $XL6s; mg POST /api/loads/$XL6s/approve '{}' >/dev/null
o6snap() { load $XL6s "l['deliveryDate'], l['loadsDelivered'], l['driverName'], l['truckUnitId'], l['vendorName'], l['customerRate'], l['approvalStatus'], l['trips'][0]['driverId'], l['trips'][0]['truckUnitId'], l['trips'][0]['truckNum'], l['trips'][0]['actualYardName'], l['trips'][0]['vendorRate'], l['billing']['amount']"; }
XS6a=$(o6snap)
mg PUT /api/drivers/oa6h '{"status":"off"}' >/dev/null; mg PUT /api/fleet/trucks/$XT6h '{"truckNum":"Truck #128R","status":"maintenance"}' >/dev/null
mg PUT /api/vendors/vulcan '{"name":"Vulcan Materials Inc"}' >/dev/null; mg POST /api/customer-prices '{"customer":"Review Four Co","material":"3/4 Rock","unit":"ton","price":31}' >/dev/null
mg PUT /api/pos/$XP6s "{\"deliveryDate\":\"$(date -d "$D6 +2 day" +%F)\",\"notes\":\"moved\",\"reason\":\"customer asked\"}" >/dev/null; mg PUT /api/pos/$XP6s/location '{"lat":36.7,"lng":-119.7,"source":"manual"}' >/dev/null
chk "   historical integrity: after the day the driver is marked off, his truck renamed and sent to the shop, the yard renamed, the customer's price changed, the PO's date moved and its pin set — the approved load's record (date, count, driver, truck, yard, rate, approval, the trip's driver/truck/yard/rate stamps, the billed amount) is byte-identical; the PO's date moved, the load's did not" "$([ "$XS6a" = "$(o6snap)" ] && echo identical || echo "CHANGED: $XS6a → $(o6snap)")|$(curl -s -b $M $B/api/data | jq "[p['deliveryDate'] for p in d['pos'] if p['id']=='$XP6s'][0] == '$(date -d "$D6 +2 day" +%F)'") $(load $XL6s "l['deliveryDate'] == '$D6'")" "identical|True True"
mg PUT /api/vendors/vulcan '{"name":"Vulcan"}' >/dev/null; mg PUT /api/drivers/oa6h '{"status":"available"}' >/dev/null

# ── closure: two operators on master data — the server writes only the fields a request carries (unrelated fields merge); the same field is last write, audited with its before ──
XV6=$(mg POST /api/vendors '{"name":"Closure Six Yard","location":"Fresno, CA","address":"1 Old Rd","force":true}' | jq "d['vendor']['id']"); XC6c=$(mg POST /api/customers '{"name":"Closure Six Co","address":"10 First St","phone":"555-0100"}' | jq "d['customer']['id']"); XT6c=$(mg POST /api/fleet/trucks '{"truckNum":"Truck #129","type":"End Dump"}' | jq "d['truck']['id']")
mg6b PUT /api/vendors/$XV6 '{"address":"2 New Rd"}' >/dev/null; mg PUT /api/vendors/$XV6 '{"location":"Clovis, CA"}' >/dev/null
mg6b PUT /api/customers/$XC6c '{"address":"20 Second St"}' >/dev/null; mg PUT /api/customers/$XC6c '{"phone":"555-0199"}' >/dev/null
mg6b PUT /api/fleet/trucks/$XT6c '{"status":"maintenance"}' >/dev/null; mg PUT /api/fleet/trucks/$XT6c '{"type":"Transfer"}' >/dev/null
chk "   closure · two operators on master data: B changes a yard's street, a customer's address, a truck's status; A's per-field edits (city, phone, type) land beside them — nothing reverted (the vendor edit now sends only changed fields, as the customer form and the fleet rows do)" "$(curl -s -b $M $B/api/vendors | jq "[(v['address'], v['location']) for v in d['vendors'] if v['id']=='$XV6'][0]")|$(curl -s -b $M $B/api/customers | jq "[(c['address'], c['phone']) for c in d['customers'] if c['id']=='$XC6c'][0]")|$(curl -s -b $M $B/api/fleet | jq "[(t['status'], t['type']) for t in d['trucks'] if t['id']=='$XT6c'][0]")" "('2 New Rd', 'Clovis, CA')|('20 Second St', '555-0199')|('maintenance', 'Transfer')"
mg6b PUT /api/vendors/$XV6 '{"address":"3 B St"}' >/dev/null; mg PUT /api/vendors/$XV6 '{"address":"4 A St"}' >/dev/null
chk "   closure · the same master-data field changed by both: the later write stands (a descriptive field, no record depends on which spelling wins) and the audit log keeps both entries with their before values" "$(curl -s -b $M $B/api/vendors | jq "[v['address'] for v in d['vendors'] if v['id']=='$XV6'][0]")|$(curl -s -b $M "$B/api/audit-log?action=updated-vendor" | jq "[(e['user'], e['details']['before']['address']) for e in d['entries'] if e['target']=='$XV6'][:2]")" "4 A St|[('joshua', '3 B St'), ('perla', '2 New Rd')]"
echo "── 20. Async route errors answer, they never hang ──"
# Express 4 drops a rejected promise on the floor: the request hangs forever.
# The central wrapper in server.js turns it into a 500. If someone removes
# that block again, these curls time out (000) instead of returning 500.
for R in async-throw async-reject sync-throw; do
  chk "/api/_test/$R returns 500 within 5s" "$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' $B/api/_test/$R)" "500"
done
chk "server still alive after the throws" "$(curl -s -o /dev/null -w '%{http_code}' $B/healthz)" "200"
chk "healthz shape: status, db, sessionStore, no secrets" "$(curl -s $B/healthz | python3 -c "import json,sys;d=json.load(sys.stdin);t=json.dumps(d);print(d['status'], d['app'], 'reachable' in d['db'], 'backend' in d['sessionStore'], any(k in t for k in ('DATABASE_URL','postgres://','SESSION_SECRET','QB_ENCRYPTION')))")" "ok running True True False"
chk "healthz reports the failing route and message" "$(curl -s $B/healthz | python3 -c "import json,sys;e=json.load(sys.stdin)['recentErrors'];print(len(e)>=3, e[0]['path'], e[0]['message'], bool(e[0]['ref']), 'server.js' in e[0]['where'])")" "True /api/_test/sync-throw test: sync throw True True"
chk "  ...and the 500 body carries the reference"  "$(curl -s --max-time 5 $B/api/_test/async-throw | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['ref'] in d['error'])")" "True"

pkill -f "^node server.js" >/dev/null 2>&1
rm -f data.json data-ids.json telemetry.json

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
   "splits":[{"truckId":"nadia","truckUnitId":"truck-12","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' -o /dev/null   # truck-4 is on Rigo's PG-SECOND today: the same-day truck conflict rule (Phase 0) would refuse it
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
  for A in arrived-pickup loaded arrived-jobsite trip-complete; do curl -s -b $ND -H 'Content-Type: application/json' -X POST $B2/api/loads/$NLD/trip-action -d "{\"action\":\"$A\",\"yardId\":\"vbt\",\"ticket\":$(tkt)}" -o /dev/null; done
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
  # ── Database outage after a healthy boot ──
  if [ -n "${TEST_PG_STOP:-}" ]; then
    chk "A. healthy: /healthz 200, db reachable with latency" "$(curl -s -o /tmp/hz.json -w '%{http_code}' $B2/healthz)|$(python3 -c "import json;d=json.load(open('/tmp/hz.json'));print(d['status'], d['db']['reachable'], isinstance(d['db']['latencyMs'], int), d['sessionStore']['backend'])")" "200|ok True True postgres"
    POS_BEFORE=$(curl -s -b $PM $B2/api/data | python3 -c "import json,sys;print(len(json.load(sys.stdin)['pos']))")
    eval "$TEST_PG_STOP" >/dev/null 2>&1; sleep 1
    chk "B/D. database down: /healthz 503 with a machine-readable reason" "$(curl -s --max-time 10 -o /tmp/hz.json -w '%{http_code}' $B2/healthz)|$(python3 -c "import json;d=json.load(open('/tmp/hz.json'));print(d['ok'], d['reason'], d['app'], d['db']['reachable'], 'unreachable' in d['sessionStore']['condition'])")" "503|False database_unreachable running False True"
    chk "C. login page still renders (not a 500)"        "$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' $B2/login)" "200"
    chk "   / redirects to login for an anonymous visitor" "$(curl -s --max-time 10 -o /dev/null -w '%{http_code} %{redirect_url}' $B2/ | sed 's|http://[^/]*||')" "302 /login"
    chk "E. protected API with an existing cookie is refused, not served" "$(curl -s --max-time 10 -b $PM -o /dev/null -w '%{http_code}' $B2/api/data)" "302"
    chk "   manager API without session → 403"          "$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' $B2/api/fleet/live)" "403"
    LG=$(curl -s -i --max-time 15 -X POST -d 'username=joshua&password=joshua123' $B2/login)
    chk "F. login attempt while down: redirect to a database message, no session" "$(echo "$LG" | grep -i '^location' | sed 's|.*/login?||; s/&ref=.*//' | tr -d '\r')|$(echo "$LG" | grep -ci '^set-cookie')" "error=db|0"
    chk "   login page explains it and names the reference" "$(curl -s --max-time 10 "$B2/login?error=db&ref=EABC123" | grep -c 'Database unreachable — reference EABC123')" "1"
    chk "   healthz records the database failure"        "$(curl -s --max-time 10 $B2/healthz | python3 -c "import json,sys;d=json.load(sys.stdin);e=[x for x in d['recentErrors'] if x['path']=='/login'];print(e[0]['kind'] if e else 'none', d['db']['failures']>0)")" "database True"
    eval "$TEST_PG_START" >/dev/null 2>&1; sleep 3
    chk "G. recovered: /healthz 200 again"               "$(curl -s -o /dev/null -w '%{http_code}' $B2/healthz)" "200"
    chk "   existing session works again"                "$(curl -s -b $PM -o /dev/null -w '%{http_code}' $B2/api/data)" "200"
    chk "   fresh login works again"                     "$(curl -s -o /dev/null -w '%{redirect_url}' -X POST -d 'username=joshua&password=joshua123' $B2/login | sed 's|.*//[^/]*||')" "/app/"
    chk "   data untouched by the outage"                "$(curl -s -b $PM $B2/api/data | python3 -c "import json,sys;print(len(json.load(sys.stdin)['pos']))")" "$POS_BEFORE"
  else
    echo "  SKIP  database-outage checks (TEST_PG_STOP not set — run ./test-pg-local.sh)"
  fi
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
  # ── Persistence #2 (I27): a restore is atomic, serialized with every other write, and becomes the rollback point ──
  r2hook() { curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/_test/save-mode -d "$1" -o /dev/null; }
  r2po()   { curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/pos -d '{"po":{"poNumber":"'"$1"'","customer":"Restore Co","deliveryDate":"'"$(date +%F)"'"},"splits":[{"truckId":"","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' -o /dev/null -w '%{http_code}'; }
  r2rst()  { curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/admin/restore -d "{\"from\":\"$1\",\"confirm\":\"RESTORE\"}" -w ' %{http_code}'; }
  r2mem()  { curl -s -b $PM $B2/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);print(','.join(sorted(p['poNumber'][3:] for p in d['pos'] if p['poNumber'].startswith('R2-'))))"; }
  r2row()  { $PSQL -c "select value from dispatch_data where key='$1'" | python3 -c "import json,sys;d=json.load(sys.stdin);print(','.join(sorted(p['poNumber'][3:] for p in d['pos'] if p['poNumber'].startswith('R2-'))))" 2>/dev/null || echo "unreadable"; }
  r2md5()  { $PSQL -c "select md5(value) from dispatch_data where key='$1'"; }
  r2code() { python3 -c "import sys,json;raw=sys.stdin.read().rstrip();b,c=raw.rsplit(' ',1);d=json.loads(b);print(c, $1)"; }
  r2po R2-A >/dev/null; r2po R2-B >/dev/null
  chk "P2 fixture: two writes; store_prev holds the state before the last one" "$(r2mem)|$(r2row store)|$(r2row store_prev)" "A,B|A,B|A"
  chk "   5. normal write, then restore (store_prev): 200, audit saved; memory = row = A; the replaced state is kept as store_before_restore, which is restorable" "$(r2rst store_prev | r2code "d['success'], d['restoredFrom'], d['auditSaved']")|$(r2mem)|$(r2row store)|$(r2row store_before_restore)|$(curl -s -b $PM $B2/api/admin/backups | python3 -c "import json,sys;print('store_before_restore' in json.load(sys.stdin)['restorable'])")" "200 True store_prev True|A|A|A,B|True"
  chk "   4. restore, then a normal write: it lands on the restored state, in memory and in the row" "$(r2po R2-C)|$(r2mem)|$(r2row store)" "200|A,C|A,C"
  chk "   7. repeated restore: undo the restore (store_before_restore → A,B), then undo the undo (→ A,C); memory = row every time" "$(r2rst store_before_restore | r2code "d['success']")|$(r2mem)|$(r2row store)|$(r2rst store_before_restore | r2code "d['success']")|$(r2mem)|$(r2row store)|$(r2row store_before_restore)" "200 True|A,B|A,B|200 True|A,C|A,C|A,B"
  ROW0=$(r2md5 store); BR0=$(r2md5 store_before_restore)
  $PSQL -c "update dispatch_data set value='{not json' where key='store_prev'" >/dev/null
  chk "   2. failed restore — a backup that will not parse: 409, restored:false, still loaded; memory, the row and store_before_restore untouched" "$(r2rst store_prev | r2code "d['restored'], d['loaded']")|$(r2mem)|$([ "$(r2md5 store)" = "$ROW0" ] && echo same || echo CHANGED)|$([ "$(r2md5 store_before_restore)" = "$BR0" ] && echo same || echo CHANGED)" "409 False True|A,C|same|same"
  chk "   …an unknown backup name is refused (400); a missing one is 409 no_backup; the row is untouched" "$(curl -s -b $PM -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B2/api/admin/restore -d '{"from":"store","confirm":"RESTORE"}')|$($PSQL -c "delete from dispatch_data where key='store_prev'" >/dev/null; r2rst store_prev | r2code "d['code']")|$([ "$(r2md5 store)" = "$ROW0" ] && echo same || echo CHANGED)" "400|409 no_backup|same"
  r2hook '{"mode":"fail","count":1}'
  chk "   3. the database refuses the restore's write: 409, restored:false; memory and the row untouched; the next normal write works and lands" "$(r2rst store_before_restore | r2code "d['restored']")|$(r2mem)|$([ "$(r2md5 store)" = "$ROW0" ] && echo same || echo CHANGED)|$(r2po R2-D)|$(r2mem)|$(r2row store)" "409 False|A,C|same|200|A,C,D|A,C,D"
  # THE I27 MECHANISM: the restore commits, the save right after it (the audit entry) fails. Before: memory rolled back
  # to the pre-restore data while the row held the restored data, and the next write put the pre-restore data back
  # over the row — the restore undid itself, after answering 409.
  r2hook '{"mode":"fail","after":1,"count":1}'      # the restore's own write goes through; the save after it fails
  chk "   8. restore commits, the audit save fails: 200 with auditSaved:false and a warning (never 'the restore failed'); memory = row = the restored state (A,B), not the replaced one" "$(r2rst store_before_restore | r2code "d['success'], d['auditSaved'], d['warning'].startswith('Restored.')")|$(r2mem)|$(r2row store)|$(r2row store_before_restore)" "200 True False True|A,B|A,B|A,C,D"
  chk "   9. …and the next normal write builds on the RESTORED state — nothing stale overwrites it; the failed audit save was counted as a rollback" "$(r2po R2-E)|$(r2mem)|$(r2row store)|$(curl -s $B2/healthz | python3 -c "import json,sys;print(json.load(sys.stdin)['persistence']['rollbacks'] >= 1)")" "200|A,B,E|A,B,E|True"
  # One queue for every write of the row. A writer in flight finishes first (its change is what the restore sets
  # aside); a writer that arrives during the restore runs on the restored state.
  r2hook '{"mode":"ok","delayMs":1000}'
  rm -f /tmp/vbt-r2-w1 /tmp/vbt-r2-rs /tmp/vbt-r2-w2
  r2po R2-F > /tmp/vbt-r2-w1 & sleep 0.3; r2rst store_before_restore > /tmp/vbt-r2-rs & sleep 0.3; r2po R2-G > /tmp/vbt-r2-w2 & wait
  r2hook '{"mode":"ok"}'
  chk "   6. restore with queued concurrent writes: the write in flight (F) lands first and is what the restore sets aside; the write queued behind the restore (G) lands on the restored state; memory = row" "$(cat /tmp/vbt-r2-w1)|$(cat /tmp/vbt-r2-rs | r2code "d['success']")|$(cat /tmp/vbt-r2-w2)|$(r2mem)|$(r2row store)|$(r2row store_before_restore)" "200|200 True|200|A,C,D,G|A,C,D,G|A,B,E,F"
  # A QuickBooks send in flight holds its batch in memory; a restore would replace it underneath the send.
  # Carlos on Truck #2B: a driver and truck nothing else in this section touches, so no same-day conflict.
  CD2=$(mktemp); curl -s -c $CD2 -X POST -d "username=carlos&password=carlos123" $B2/login -o /dev/null
  F1=$(curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/pos -d '{"po":{"poNumber":"R2-QB","customer":"Restore Co","deliveryDate":"'"$(date +%F)"'","plannedVendorId":"vbt"},"splits":[{"truckId":"carlos","truckUnitId":"truck-2b","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' -o /dev/null -w '%{http_code}')
  QL=$(curl -s -b $PM $B2/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);po=[p for p in d['pos'] if p['poNumber']=='R2-QB'];print([l['id'] for l in d['loads'] if po and l['poId']==po[0]['id']][0] if po else '')")
  d2() { curl -s -b $CD2 -H 'Content-Type: application/json' -X POST $B2/api/loads/$QL/trip-action -d "$1" -o /dev/null -w '%{http_code} '; }
  F2=$(d2 '{"action":"start-trip"}'; d2 '{"action":"arrived-pickup","yardId":"vbt"}'; d2 "{\"action\":\"loaded\",\"ticket\":$(tkt)}"; d2 '{"action":"arrived-jobsite"}'; d2 '{"action":"trip-complete"}')
  F3=$(curl -s -b $CD2 -H 'Content-Type: application/json' -X PUT $B2/api/loads/$QL -d "{\"ticketImage\":\"$PNG\",\"pod\":{\"signedBy\":\"x\",\"signature\":\"$PNG\",\"signedAt\":\"2026-01-01T00:00:00Z\"}}" -o /dev/null -w '%{http_code}')
  F4=$(d2 '{"action":"delivered"}'); F5=$(curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/loads/$QL/approve -d '{}' -o /dev/null -w '%{http_code}')
  BR=$(curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/billing-batches -d "{\"loadIds\":[\"$QL\"]}")
  QB2=$(echo "$BR" | python3 -c "import json,sys;d=json.load(sys.stdin);print((d.get('batches') or [{}])[0].get('id') or d.get('error'))")
  chk "   fixture for the in-flight check: PO, five trip steps, signature, delivered, approve and batch all accepted" "$F1|$F2|$F3|$F4|$F5|${QB2:0:3}" "200|200 200 200 200 200 |200|200 |200|BB-"
  curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/_test/qb-fake -d '{"mode":"slow","delayMs":1500}' -o /dev/null
  curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/billing-batches/$QB2/send -d '{}' -o /dev/null & sleep 0.4
  R2G=$(r2rst store_before_restore | r2code "d.get('code'), '$QB2' in d.get('error','')"); wait
  chk "   a QuickBooks send in flight refuses the restore (409 send_in_flight, naming the batch); nothing changed, and the send finishes once" "$R2G|$(curl -s -b $PM $B2/api/billing-batches/$QB2 | python3 -c "import json,sys;b=json.load(sys.stdin)['batch'];print(b['syncStatus'], b['qbInvoiceId'])")|$(r2mem)" "409 send_in_flight True|sent_to_quickbooks INV-1|A,C,D,G,QB"
  curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/_test/qb-fake -d '{"mode":"ok"}' -o /dev/null
  chk "   static: one write queue for saves and restores; the restore writes both rows in one transaction; the restored state becomes the rollback point; no reload from the database inside a restore" "$(grep -c "^function queueWrite" server.js)|$(grep -c "return queueWrite(async () => {" server.js)|$(grep -c "lastGoodJson = restoredJson;" server.js)|$(grep -c "await loadData()" server.js)" "1|1|1|1"
  # ── Persistence #3 (I31): ids never rewind on Postgres — restore, repeated restore, failed save, restart ──
  r3max() { curl -s -b $PM $B2/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);print(max((int(l['id'].split('-')[1]) for l in d['loads'] if l['id'].startswith('LOAD-')), default=0))"; }
  r3hw()  { $PSQL -c "select value from dispatch_data where key='id_high_water'" | python3 -c "import json,sys;print(json.load(sys.stdin)['load'])"; }
  r3po()  { curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/pos -d '{"po":{"poNumber":"'"$1"'","customer":"Restore Co","deliveryDate":"'"$(date +%F)"'"},"splits":[{"truckId":"","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' -o /dev/null -w '%{http_code}'; }
  r3po R3-A >/dev/null; A3=$(r3max); r3po R3-B >/dev/null; r3po R3-C >/dev/null; C3=$(r3max)
  chk "P3 fixture: three loads in a row climb by one; the id_high_water row (its own row, never rotated or restored) is one past the newest" "$((C3-A3))|$(r3hw)" "2|$((C3+1))"
  chk "   restore an older backup (store_prev = before the last creation): the newest load leaves the record, but the next id is NOT its id — it is past every id ever issued" "$(r2rst store_prev | r2code "d['success']")|$(r3max)|$(r3po R3-D)|$(r3max)" "200 True|$((C3-1))|200|$((C3+1))"
  chk "   repeated restore (undo, create, restore again, create): every new id is unique and the high-water row only ever climbs" "$(r2rst store_before_restore | r2code "d['success']")|$(r3po R3-E)|$(r3max)|$(r2rst store_prev | r2code "d['success']")|$(r3po R3-F)|$(r3max)|$(r3hw)" "200 True|200|$((C3+2))|200 True|200|$((C3+3))|$((C3+4))"
  r2hook '{"mode":"fail","count":1}'
  chk "   failed save on Postgres: the id the failed creation took is consumed; the next creation skips it" "$(r3po R3-G)|$(r3po R3-H)|$(r3max)" "503|200|$((C3+5))"
  pkill -f "^node server.js" >/dev/null 2>&1; sleep 1
  (VBT_TEST_HOOKS=1 DATABASE_URL="$TEST_DATABASE_URL" PORT=$P2 node server.js > /tmp/vbt-test-pg.log 2>&1 &)
  for i in $(seq 1 20); do sleep 1; curl -sf $B2/healthz >/dev/null 2>&1 && break; done
  curl -s -c $PM -X POST -d "username=joshua&password=joshua123" $B2/login -o /dev/null
  chk "   after a restart the ids continue past the high-water row, not from a counter reset; the row follows" "$(r3po R3-I)|$(r3max)|$(r3hw)" "200|$((C3+6))|$((C3+7))"
  # ── Persistence #4: a read after a restore is the restored state ──
  r4mem() { curl -s -b $PM $B2/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);print(','.join(sorted(p['poNumber'][3:] for p in d['pos'] if p['poNumber'].startswith('R4-'))))"; }
  r4row() { $PSQL -c "select value from dispatch_data where key='store'" | python3 -c "import json,sys;d=json.load(sys.stdin);print(','.join(sorted(p['poNumber'][3:] for p in d['pos'] if p['poNumber'].startswith('R4-'))))"; }
  r2po R4-A >/dev/null; r2po R4-B >/dev/null
  chk "P4 restore → GET: the read is the restored state, and so is the row" "$(r2rst store_prev | r2code "d['success']")|$(r4mem)|$(r4row)" "200 True|A|A"
  r2hook '{"mode":"fail","after":1,"count":1}'
  chk "   restore whose audit save fails → GET: the read is still the restored state — the restore itself committed" "$(r2rst store_before_restore | r2code "d['success'], d['auditSaved']")|$(r4mem)|$(r4row)" "200 True False|A,B|A,B"
  chk "   restore → write → GET: the write sits on top of the restored state, in memory and in the row" "$(r2po R4-C)|$(r4mem)|$(r4row)" "200|A,B,C|A,B,C"
  # ── Persistence #6 on Postgres: a rollback during a QuickBooks send; restore → restart → GET; archive ↔ restore ──
  r6po()   { curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/pos -d '{"po":{"poNumber":"'"$1"'","customer":"Sixth Co","deliveryDate":"'"$(date -d '+30 day' +%F)"'","plannedVendorId":"vbt"},"splits":[{"truckId":"","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('po',{}).get('id') or d.get('error'))"; }
  r6load() { curl -s -b $PM $B2/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);print([l['id'] for l in d['loads'] if l['poId']=='$1'][0])"; }
  r6set()  { curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/_test/set-load -d "{\"id\":\"$1\",\"fields\":$2}" -o /dev/null; }
  r6row()  { $PSQL -c "select value from dispatch_data where key='store'" | python3 -c "import json,sys;d=json.load(sys.stdin);$1"; }
  r6mem()  { curl -s -b $PM $B2/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);print(','.join(sorted(p['poNumber'][3:] for p in d['pos'] if p['poNumber'].startswith('R6-'))))"; }
  r6rowpo() { $PSQL -c "select value from dispatch_data where key='$1'" | python3 -c "import json,sys;d=json.load(sys.stdin);print(','.join(sorted(p['poNumber'][3:] for p in d['pos'] if p['poNumber'].startswith('R6-'))))"; }
  r6where() { curl -s -b $PM $B2/api/history | python3 -c "import json,sys;d=json.load(sys.stdin);arc=sum(1 for b in d.get('archive',[]) for l in b.get('loads',[]) if l['id']=='$1');print('archived:%d'%arc)"; }
  r6live()  { curl -s -b $PM $B2/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);print('live:%d'%sum(1 for l in d['loads'] if l['id']=='$1'))"; }
  P6A=$(r6po R6-A); L6A=$(r6load $P6A); P6X=$(r6po R6-X); L6X=$(r6load $P6X)
  r6set $L6A '{"approvalStatus":"approved","billStatus":"ready","locked":true}'
  curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/_test/qb-fake -d '{"mode":"ok"}' -o /dev/null
  B6=$(curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/billing-batches -d "{\"loadIds\":[\"$L6A\"]}" | python3 -c "import json,sys;d=json.load(sys.stdin);print((d.get('batches') or [{}])[0].get('id') or d.get('error'))")
  curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/_test/qb-fake -d '{"mode":"slow","delayMs":2000}' -o /dev/null
  (curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/billing-batches/$B6/send -d '{}' -o /dev/null -w '%{http_code}' > /tmp/vbt-r6-send) & sleep 0.6
  r2hook '{"mode":"fail","count":1}'
  X6=$(curl -s -b $PM -H 'Content-Type: application/json' -X PUT $B2/api/loads/$L6X -d '{"notes":"other tab"}' -o /dev/null -w '%{http_code}'); wait
  curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/_test/qb-fake -d '{"mode":"ok"}' -o /dev/null
  chk "P6 Postgres: a QuickBooks send in flight while another request's save is refused and rolled back (503) — the send lands on the record AND in the row: batch sent with its invoice, load billed" "$X6 $(cat /tmp/vbt-r6-send)|$(curl -s -b $PM $B2/api/billing-batches/$B6 | python3 -c "import json,sys;b=json.load(sys.stdin)['batch'];print(b['syncStatus'], bool(b['qbInvoiceId']))")|$(r6row "b=[x for x in d['billingBatches'] if x['id']=='$B6'][0];l=[x for x in d['loads'] if x['id']=='$L6A'][0];print(b['syncStatus'], bool(b['qbInvoiceId']), l['billStatus'])")" "503 200|sent_to_quickbooks True|sent_to_quickbooks True billed"
  # restore → restart → GET: the first state after boot is the restored row, and a write after boot lands on it
  R6B=$(r2po R6-B)
  R6S=$(r2rst store_prev | r2code "d['success']")
  pkill -f "^node server.js" >/dev/null 2>&1; sleep 1
  (VBT_TEST_HOOKS=1 DATABASE_URL="$TEST_DATABASE_URL" PORT=$P2 node server.js > /tmp/vbt-test-pg.log 2>&1 &)
  for i in $(seq 1 20); do sleep 1; curl -sf $B2/healthz >/dev/null 2>&1 && break; done
  curl -s -c $PM -X POST -d "username=joshua&password=joshua123" $B2/login -o /dev/null
  chk "   restore (store_prev: the state before R6-B) → restart → GET: the first state after boot is the restored row — R6-B gone from memory and row alike, kept in store_before_restore; a write after boot lands on the restored state" "$R6B $R6S|$(r6mem)|$(r6rowpo store)|$(r6rowpo store_before_restore)|$(r2po R6-C)|$(r6mem)|$(r6rowpo store)" "200 200 True|A,X|A,X|A,B,X|200|A,C,X|A,C,X"
  # archive, then restore the state before it: the load is live again and in no archive batch — once, never twice — in memory and in the row
  P6H=$(r6po R6-H); L6H=$(r6load $P6H)
  r6set $L6H '{"approvalStatus":"approved","billStatus":"billed","locked":true,"billedAt":"2026-01-01T00:00:00Z","manualBillRef":"INV-H"}'
  AR6=$(curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/history/archive -d '{}' | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['archived']['loads'] >= 1)")
  chk "   archive (the billed load leaves the live list) → restore the state before it (store_prev): live again, in no archive batch, memory = row; undo the restore: archived again, once" "$AR6 $(r6live $L6H) $(r6where $L6H)|$(r2rst store_prev | r2code "d['success']")|$(r6live $L6H) $(r6where $L6H)|$(r6row "live=sum(1 for l in d['loads'] if l['id']=='$L6H');arc=sum(1 for b in d.get('archive',[]) for l in b.get('loads',[]) if l['id']=='$L6H');print('live:%d archived:%d'%(live,arc))")|$(r2rst store_before_restore | r2code "d['success']")|$(r6live $L6H) $(r6where $L6H)" "True live:0 archived:1|200 True|live:1 archived:0|live:1 archived:0|200 True|live:0 archived:1"
  # ── Persistence #7 on Postgres: removed seed records stay removed across a restart (fleet, roster, login); an UNKNOWN QuickBooks result survives a restart and reconciles first ──
  R7T=$(curl -s -b $PM -o /dev/null -w '%{http_code}' -X DELETE $B2/api/fleet/trucks/truck-14); R7D=$(curl -s -b $PM -o /dev/null -w '%{http_code}' -X DELETE "$B2/api/drivers/leonardo?hard=1")
  P7Q=$(r6po R7-Q); L7Q=$(r6load $P7Q); r6set $L7Q '{"approvalStatus":"approved","billStatus":"ready","locked":true}'
  curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/_test/qb-fake -d '{"mode":"ok"}' -o /dev/null
  B7=$(curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/billing-batches -d "{\"loadIds\":[\"$L7Q\"]}" | python3 -c "import json,sys;d=json.load(sys.stdin);print((d.get('batches') or [{}])[0].get('id') or d.get('error'))")
  curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/_test/qb-fake -d '{"mode":"timeout"}' -o /dev/null
  R7S=$(curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/billing-batches/$B7/send -d '{}' -o /dev/null -w '%{http_code}')
  pkill -f "^node server.js" >/dev/null 2>&1; sleep 1
  (VBT_TEST_HOOKS=1 DATABASE_URL="$TEST_DATABASE_URL" PORT=$P2 node server.js > /tmp/vbt-test-pg.log 2>&1 &)
  for i in $(seq 1 20); do sleep 1; curl -sf $B2/healthz >/dev/null 2>&1 && break; done
  curl -s -c $PM -X POST -d "username=joshua&password=joshua123" $B2/login -o /dev/null
  curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/_test/qb-fake -d '{"mode":"ok"}' -o /dev/null   # the fake QuickBooks lives in the process: re-armed after the restart (the connection itself was saved)
  chk "P7 Postgres: a removed seed truck, a removed seed driver and his login stay removed across a restart — nothing is re-seeded onto a store that has a fleet and a roster, no login is re-inserted into a users table that has logins; the row agrees" "$R7T $R7D|$(curl -s -b $PM $B2/api/fleet | python3 -c "import json,sys;d=json.load(sys.stdin);print(any(t['id']=='truck-14' for t in d['trucks']), any(x['id']=='leonardo' for x in d['drivers']))")|$($PSQL -c "select count(*) from users where username='leonardo'")|$(curl -s -o /dev/null -w '%{redirect_url}' -X POST -d 'username=leonardo&password=leo123' $B2/login | sed 's|.*//[^/]*||')|$(r6row "print(any(t['id']=='truck-14' for t in d['trucks']), any(x['id']=='leonardo' for x in d['drivers']))")" "200 200|False False|0|/login?error=1|False False"
  chk "   an UNKNOWN QuickBooks result survives the restart with its reconciliation record (same requestid); Retry reconciles first — not found → ready, nothing re-created — and the send then creates exactly one invoice" "$R7S|$(curl -s -b $PM $B2/api/billing-batches/$B7 | python3 -c "import json,sys;b=json.load(sys.stdin)['batch'];print(b['syncStatus'], b['reconcile']['requestId']=='$B7', b['reconcile']['kind'])")|$(curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/billing-batches/$B7/retry -d '{}' | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('reconciled'), d['batch']['syncStatus'])")|$(curl -s -b $PM -H 'Content-Type: application/json' -X POST $B2/api/billing-batches/$B7/send -d '{}' -o /dev/null -w '%{http_code}')|$(curl -s -b $PM $B2/api/_test/qb-fake | python3 -c "import json,sys;print(json.load(sys.stdin)['invoicesCreated'])")" "502|unknown True timeout|not_found ready_to_bill|200|1"
  # A missing store row next to existing backups is a lost row, not a new company.
  pkill -f "^node server.js" >/dev/null 2>&1; sleep 1
  $PSQL -c "delete from dispatch_data where key='store'" >/dev/null
  (VBT_TEST_HOOKS=1 DATABASE_URL="$TEST_DATABASE_URL" PORT=$P2 node server.js > /tmp/vbt-test-pg.log 2>&1 &)
  for i in $(seq 1 20); do sleep 1; curl -sf $B2/healthz >/dev/null 2>&1 && break; done
  chk "missing store row + backups present: refuses to seed" "$(curl -s $B2/healthz | python3 -c "import json,sys;print(json.load(sys.stdin)['loaded'])")" "False"
  chk "  ...no store row was created" "$($PSQL -c "select count(*) from dispatch_data where key='store'")" "0"
  pkill -f "^node server.js" >/dev/null 2>&1; sleep 1
  # ── Linxup L2 on Postgres: the §48 scenario, word for word, on the linxup_* tables ──
  $PSQL -c "DROP TABLE IF EXISTS dispatch_data, users, companies, user_sessions, linxup_trackers, linxup_positions, linxup_latest_positions, linxup_geofences, linxup_geofence_events, linxup_webhook_log, linxup_stops, linxup_vehicle_trips, linxup_usage" >/dev/null
  PGL2="(VBT_TEST_HOOKS=1 LINXUP_WEBHOOK_TOKEN=test-token LINXUP_COMPANY_ID=1 DATABASE_URL=\"$TEST_DATABASE_URL\" PORT=$P2 node server.js > /tmp/vbt-test-pg-l2.log 2>&1 &); for i in \$(seq 1 20); do sleep 1; curl -sf $B2/healthz >/dev/null 2>&1 && break; done"
  eval "$PGL2"
  l2_suite $B2 "21/pg" "pkill -f '^node server.js' >/dev/null 2>&1; sleep 1; $PGL2"
  PGM=$(mktemp); curl -s -c $PGM -X POST -d "username=joshua&password=joshua123" $B2/login -o /dev/null
  chk "21/pg the calendar on Postgres: today's loads from the store row, the archived one once and flagged" "$(curl -s -b $PGM "$B2/api/calendar?from=$(date +%F)&to=$(date +%F)" | python3 -c "import json,sys;d=json.load(sys.stdin);r=d['days'][d['today']];print(sorted((x['poNumber'], x['archived'], x['bucket']) for x in r))")" "[('LX-2', True, 'completed'), ('LX-3', False, 'in-progress')]"
  chk "21/pg the evidence lives in its own tables; the dispatch store row carries none of it — only the yard mapping and its audit entry" "$($PSQL -c "select (select count(*) from linxup_geofence_events) > 0, (select count(*) from linxup_stops) > 0, (select count(*) from linxup_vehicle_trips) > 0, (select count(*) from linxup_usage) > 0, (select count(*) from linxup_geofences)")|$($PSQL -c "select count(*) from dispatch_data where key='store' and (value like '%FENCE_ENTER%' or value like '%enteredAt%' or value like '%durationMin%' or value like '%stopType%')")|$($PSQL -c "select count(*) from dispatch_data where key='store' and value like '%linxupGeofenceId%'")|$($PSQL -c "select count(*) from dispatch_data where key='store' and value like '%mapped-geofence%'")" "t|t|t|t|3|0|1|1"
  pkill -f "^node server.js" >/dev/null 2>&1
fi
echo
echo "── 23. Old data: approved-but-unlocked load becomes locked on load ──"
rm -f data-ids.json   # a fresh legacy file: no high-water marks beside it yet
cat > data.json <<'JSON'
{"pos":[{"id":"PO-OLD","poNumber":"OLD-1","customer":"Legacy Co","deliveryDate":"2026-01-05","status":"completed"},
        {"id":"PO-AUTO","poNumber":"PO-1050","customer":"Legacy Co","deliveryDate":"2026-01-06","status":"active"}],
 "loads":[{"id":"L-OLD","poId":"PO-OLD","truckId":"beryle","material":"Dirt","loadsAssigned":1,"loadsDelivered":1,
           "deliveryDate":"2026-01-05","status":"completed","approvalStatus":"approved","locked":false,"billingBatchId":"BB-STUCK"},
          {"id":"LOAD-7","poId":"PO-AUTO","truckId":null,"material":"Dirt","loadsAssigned":1,"loadsDelivered":0,"deliveryDate":"2026-01-06","status":"unassigned","approvalStatus":"pending"}],
 "nextLoadId":3,"nextPoNum":1001,
 "billingBatches":[{"id":"BB-STUCK","loadIds":["L-OLD"],"syncStatus":"syncing","qbInvoiceId":"","customer":"Legacy Co","totalAmount":0,"lineItems":[]}],
 "unitConfig":{"byUnit":{"ton":25,"load":1,"hour":1,"mile":1},"byMaterial":{}}}
JSON
(VBT_TEST_HOOKS=1 node server.js > /tmp/vbt-test-old.log 2>&1 &)
for i in $(seq 1 20); do sleep 1; curl -sf $B/healthz >/dev/null 2>&1 && break; done
curl -s -c $M -X POST -d "username=joshua&password=joshua123" $B/login -o /dev/null
chk "legacy approved load is locked after normalize" "$(curl -s -b $M $B/api/data | python3 -c "import json,sys;print([x for x in json.load(sys.stdin)['loads'] if x['id']=='L-OLD'][0]['locked'])")" "True"
chk "  ...and the generic update is refused" "$(curl -s -b $M -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X PUT $B/api/loads/L-OLD -d '{"material":"Sand"}')" "403"
chk "fabricated hour:1 / mile:1 seeds are removed on load" "$(curl -s -b $M $B/api/costing/settings | python3 -c "import json,sys;u=json.load(sys.stdin)['unitConfig']['byUnit'];print('hour' in u, 'mile' in u, u['ton'])")" "False False 25"
chk "batch stuck in 'syncing' at restart (no invoice id) becomes external-result-unknown" "$(curl -s -b $M $B/api/billing-batches | python3 -c "import json,sys;b=[x for x in json.load(sys.stdin)['items'] if x['id']=='BB-STUCK'][0];print(b['syncStatus'], 'restart' in b['errorMessage'], b['mayExistInQuickBooks'])")" "unknown True True"
chk "Persistence 3: a legacy file whose counters sit below its own records (nextLoadId 3 beside LOAD-7, nextPoNum 1001 beside PO-1050) boots and issues past them — LOAD-8, PO-1051 — and the marks on disk follow" "$(curl -s -b $M -H 'Content-Type: application/json' -X POST $B/api/pos -d '{"po":{"customer":"Legacy Co","deliveryDate":"2026-01-07"},"splits":[{"truckId":"","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['po']['poNumber'])")|$(curl -s -b $M $B/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);print(sorted(l['id'] for l in d['loads'] if l['id'].startswith('LOAD-')))")|$(python3 -c "import json;d=json.load(open('data-ids.json'));print(d['load'], d['po'])")" "PO-1051|['LOAD-7', 'LOAD-8']|9 1052"
pkill -f "^node server.js" >/dev/null 2>&1
rm -f data.json data-ids.json telemetry.json

[ "$SKIPPED" -gt 0 ] && SK=", $SKIPPED section(s) skipped" || SK=""
echo "════ $PASS passed, $FAIL failed$SK ════"
[ "$FAIL" -eq 0 ]
