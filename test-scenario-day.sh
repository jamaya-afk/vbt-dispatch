#!/usr/bin/env bash
# test-scenario-day.sh — a realistic VBT day against a fresh server (file mode, port 4700).
# Run: bash test-scenario-day.sh   (or npm run test:scenario). Not part of test-e2e.sh;
# this reads like a day at the office and prints the board as the dispatcher sees it.
# A realistic VBT day against a fresh server: five drivers, one customer PO,
# loads at different stages, assignment conflicts, reassignment mid-haul,
# billing end to end with the failure cases, internal vs external yard
# costing both ways, a database write failure, archiving, and a restart.
set -u
SP=${SCENARIO_LOG_DIR:-/tmp}
PORT=4700; B=http://localhost:$PORT
cd "$(dirname "$0")"
pkill -f "^node server.js" >/dev/null 2>&1; sleep 1; rm -f data.json data-ids.json telemetry.json
start() { (VBT_TEST_HOOKS=1 PORT=$PORT node server.js >> $SP/scenario-server.log 2>&1 &); for i in $(seq 1 20); do sleep 1; curl -sf $B/healthz >/dev/null 2>&1 && break; done; }
: > $SP/scenario-server.log; start
PASS=0; FAIL=0
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; PASS=$((PASS+1)); else echo "  FAIL  $1 — got '$2' want '$3'"; FAIL=$((FAIL+1)); fi; }
say() { echo; echo "▶ $*"; }
J='Content-Type: application/json'; TODAY=$(date +%F)
jq() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
PNG="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
tkt() { echo "{\"source\":\"supplier\",\"number\":\"T$RANDOM$RANDOM\",\"netTons\":24.5,\"photo\":\"$PNG\"}"; }
M=$(mktemp); login() { local f=$(mktemp); curl -s -c $f -X POST -d "username=$1&password=$2" $B/login -o /dev/null; echo $f; }
M=$(login joshua joshua123); BE=$(login beryle beryle123); MA=$(login matthew matthew123); RG=$(login rigo rigo123); LE=$(login leonardo leo123); CA=$(login carlos carlos123)
mg()  { curl -s -b $M -H "$J" -X "$1" "$B$2" -d "${3:-"{}"}" "${@:4}"; }
mgc() { curl -s -b $M -H "$J" -X "$1" "$B$2" -d "${3:-"{}"}" -o /dev/null -w '%{http_code}'; }
dr()  { curl -s -b "$1" -H "$J" -X POST $B/api/loads/$2/trip-action -d "$3"; }
load() { curl -s -b $M $B/api/data | python3 -c "import json,sys;d=json.load(sys.stdin);l=[x for x in d['loads'] if x['id']=='$1'][0];print($2)"; }
data() { curl -s -b $M $B/api/data | jq "$1"; }
loadof() { curl -s -b $M $B/api/data | jq "[l['id'] for l in d['loads'] if l['poId']=='$1' and (l['truckId'] or '')=='${2:-}'][0]"; }
board() { curl -s -b $M "$B/api/today" | python3 -c "
import json,sys;d=json.load(sys.stdin);s=d['summary']
print(f\"  BOARD {d['date']}: {s['loads']} loads · unassigned {s['unassigned']} · assigned {s['assigned']} · in progress {s['inProgress']} · awaiting approval {s['awaitingApproval']} · completed {s['completed']} · drivers working {s['driversWorking']} / free {s['driversAvailable']}\")
print(f\"  {'STATUS':18}{'DRIVER':10}{'TRUCK':11}{'YARD':11}{'CUSTOMER':16}{'MATERIAL':10}PROGRESS\")
for l in sorted(d['loads'], key=lambda x: x['bucket']): print(f\"  {l['bucket']:18}{(l['driverName'] or '— unassigned'):10}{(l['truckNum'] or '— none'):11}{l['yardName']:11}{l['customer'][:15]:16}{l['material']:10}{l['loadsDelivered']}/{l['loadsAssigned']}\")
print('  drivers free:', [x['name'] for x in d['drivers'] if x['available']], '· trucks free:', [x['truckNum'] for x in d['trucks'] if x['available']])"; }
fleet() { curl -s -b $M $B/api/fleet/live | jq "[(x['driverId'], x['truckNum'], x['workflowStatus']) for x in d['trucks']]"; }
mg POST /api/_test/qb-fake '{"mode":"ok"}' >/dev/null

say "1. MORNING — Hilltop Grading PO, 8 loads of 3/4 Rock from Vulcan to 400 Ridge Rd, Clovis"
P1=$(mg POST /api/pos '{"po":{"poNumber":"HG-101","customer":"Hilltop Grading","deliveryDate":"'"$TODAY"'","address":"400 Ridge Rd","city":"Clovis","plannedVendorId":"vulcan"},
 "splits":[{"truckId":"beryle","truckUnitId":"truck-2","material":"3/4 Rock","loadsAssigned":3,"vendorId":"vulcan"},
           {"truckId":"matthew","truckUnitId":"truck-4","material":"3/4 Rock","loadsAssigned":2,"vendorId":"vulcan"},
           {"truckId":"rigo","truckUnitId":"truck-14","material":"3/4 Rock","loadsAssigned":2,"vendorId":"vulcan"},
           {"truckId":null,"truckUnitId":null,"material":"3/4 Rock","loadsAssigned":1,"vendorId":"vbt"}]}' | jq "d['po']['id']")
LB=$(loadof $P1 beryle); LM=$(loadof $P1 matthew); LR=$(loadof $P1 rigo); LU=$(loadof $P1 "")
chk "PO created with four load assignments" "$(data "len([l for l in d['loads'] if l['poId']=='$P1'])")" "4"
dr $BE $LB '{"action":"start-trip","gps":{"lat":36.74,"lng":-119.77}}' >/dev/null; dr $BE $LB '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null
dr $MA $LM '{"action":"start-trip"}' >/dev/null; dr $MA $LM '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null; dr $MA $LM "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null
board
chk "dispatcher sees: 2 in progress, 1 assigned, 1 unassigned, 3 working, 2 free" "$(curl -s -b $M $B/api/today | jq "(lambda s: (s['inProgress'], s['assigned'], s['unassigned'], s['driversWorking'], s['driversAvailable']))(d['summary'])")" "(2, 1, 1, 3, 2)"
chk "fleet map statuses follow the workflow" "$(fleet)" "[('beryle', 'Truck #2', 'At Yard'), ('matthew', 'Truck #4', 'Loaded / En Route'), ('rigo', 'Truck #14', 'Assigned'), ('leonardo', 'Truck #12', 'Available'), ('carlos', 'Truck #2B', 'Available')]"
say "   Quick Assign: the unassigned load → Carlos → Truck #2B → planned pickup at OUR yard"
chk "Driver → Truck → Yard → Confirm in one call" "$(mg POST /api/loads/$LU/assign '{"driverId":"carlos","truckUnitId":"truck-2b","yardId":"vbt"}' | jq "d['success'], d['load']['driverName'], d['truck']['truckNum'], d['pickup']['name']")" "True Carlos Truck #2B VBT Yard"
board

say "2. CONFLICTS — the dispatcher is told, not silently allowed or blocked"
R=$(mg POST /api/loads/$LR/assign '{"driverId":"beryle"}')
echo "  → $(echo "$R" | jq "d['error']")"
chk "driver already mid-haul → 409, load unchanged" "$(echo "$R" | jq "d['code'], d['conflicts'][0]['type']")|$(load $LR "l['driverName']")" "assignment_conflict driver-busy|Rigo"
R=$(mg POST /api/loads/$LR/assign '{"truckUnitId":"truck-2"}')
echo "  → $(echo "$R" | jq "d['error']")"
chk "truck on another driver's open load → 409, load unchanged" "$(echo "$R" | jq "d['conflicts'][0]['type']")|$(load $LR "l['truckUnitId']")" "truck-busy|truck-14"
say "   Two dispatchers, one sheet: Joshua opens Quick Assign on Rigo's load; Perla puts Carlos on it meanwhile; Joshua submits his older choice"
PE=$(login perla perla123)
curl -s -b $PE -H "$J" -X POST $B/api/loads/$LR/assign -d '{"driverId":"carlos","base":{"driverId":"rigo"}}' -o /dev/null
R=$(mg POST /api/loads/$LR/assign '{"driverId":"matthew","base":{"driverId":"rigo"}}')
echo "  → $(echo "$R" | jq "d['error']")"
chk "the older sheet is refused (409 stale_assignment) and Perla's assignment stands; nothing is overwritten unseen" "$(echo "$R" | jq "d['code'], d['stale'], d['current']['driverId']")|$(load $LR "l['driverName']")" "stale_assignment ['driver'] carlos|Carlos"
chk "   reopened on the current state, Joshua puts Rigo back (200)" "$(mg POST /api/loads/$LR/assign '{"driverId":"rigo","base":{"driverId":"carlos"}}' | jq "d['success'], d['load']['driverName']")" "True Rigo"
say "   Reassignment mid-haul: Beryle (at the yard on trip 1 of 3) goes home sick → Leonardo takes over on Truck #12"
R=$(mg POST /api/loads/$LB/assign '{"driverId":"leonardo","truckUnitId":"truck-12"}')
echo "  → $(echo "$R" | jq "d['error']")"
chk "moving a mid-haul load asks first (409 load-in-progress)" "$(echo "$R" | jq "d['conflicts'][0]['type']")" "load-in-progress"
chk "with the dispatcher's go-ahead it moves; the handover is recorded" "$(mg POST /api/loads/$LB/assign '{"driverId":"leonardo","truckUnitId":"truck-12","force":true,"reason":"Beryle went home sick"}' | jq "d['success'], d['load']['driverName'], d['truck']['truckNum'], d['conflictsOverridden']")" "True Leonardo Truck #12 ['load-in-progress']"
chk "trip 1 keeps the record of who started it and on what" "$(load $LB "l['trips'][0]['driverId'], l['trips'][0]['truckUnitId'], l['reassignHistory'][0]['from'], l['reassignHistory'][0]['to'], l['reassignHistory'][0]['atTrip'], l['reassignHistory'][0]['reason']")" "beryle truck-2 beryle leonardo 1 Beryle went home sick"
chk "Beryle and Truck #2 are free again immediately" "$(curl -s -b $M $B/api/today | jq "[x['available'] for x in d['drivers'] if x['id']=='beryle'][0], [x['available'] for x in d['trucks'] if x['id']=='truck-2'][0]")" "True True"
chk "Beryle's phone no longer shows the load; Leonardo's does" "$(curl -s -b $BE $B/api/my-dispatch | jq "len([l for l in d['loads'] if (l.get('id') or l.get('loadId'))=='$LB'])")|$(curl -s -b $LE $B/api/my-dispatch | jq "[(l.get('id') or l.get('loadId')) for l in d['loads'] if (l.get('id') or l.get('loadId'))=='$LB'][0]")" "0|$LB"
dr $LE $LB "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null; dr $LE $LB '{"action":"arrived-jobsite"}' >/dev/null; dr $LE $LB '{"action":"trip-complete"}' >/dev/null
for n in 2 3; do dr $LE $LB '{"action":"start-trip"}' >/dev/null; dr $LE $LB '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null; dr $LE $LB "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null; dr $LE $LB '{"action":"arrived-jobsite"}' >/dev/null; dr $LE $LB '{"action":"trip-complete"}' >/dev/null; done
chk "trips 2 and 3 are Leonardo's on Truck #12; trip 1 still Beryle's on Truck #2" "$(load $LB "[(t['tripNum'], t['driverId'], t['truckUnitId']) for t in l['trips']]")" "[(1, 'beryle', 'truck-2'), (2, 'leonardo', 'truck-12'), (3, 'leonardo', 'truck-12')]"
curl -s -b $LE -H "$J" -X PUT $B/api/loads/$LB -d "{\"pod\":{\"signedBy\":\"Site foreman\",\"signature\":\"$PNG\",\"signedAt\":\"$(date -u +%FT%TZ)\"}}" -o /dev/null
dr $LE $LB '{"action":"delivered"}' >/dev/null
board
chk "8. after submission Leonardo and Truck #12 are no longer shown occupied" "$(curl -s -b $M $B/api/today | jq "[x['available'] for x in d['drivers'] if x['id']=='leonardo'][0], [x['available'] for x in d['trucks'] if x['id']=='truck-12'][0], [l['bucket'] for l in d['loads'] if l['id']=='$LB'][0]")" "True True awaiting-approval"

say "3. BILLING END TO END — Leonardo's 3 loads: approve → Ready to Bill → batch → QuickBooks"
chk "the order has delivered loads: its jobsite and customer are frozen (403), its notes still change — where the work went stays on record" "$(mg PUT /api/pos/$P1 '{"address":"1 Elsewhere Ave"}' | jq "d.get('code'), d.get('frozenFields')")|$(mgc PUT /api/pos/$P1 '{"notes":"gate code 4411"}')" "po_work_frozen ['address']|200"
mg POST /api/loads/$LB/approve >/dev/null
chk "approved → locked, Ready to Bill lists it" "$(load $LB "l['locked'], l['billStatus']")|$(curl -s -b $M $B/api/ready-to-bill | jq "len([x for x in d['items'] if x['id']=='$LB'])")" "True ready|1"
chk "invoice preview: 3 loads × 25 t × \$25 = \$1,875 to Hilltop Grading, PO HG-101" "$(mg POST /api/billing-batches/preview "{\"loadIds\":[\"$LB\"]}" | jq "d['groups'][0]['customer'], d['groups'][0]['poNumber'], d['groups'][0]['totalLoads'], d['groups'][0]['totalAmount']")" "Hilltop Grading HG-101 3 1875"
B1=$(mg POST /api/billing-batches "{\"loadIds\":[\"$LB\"]}" | jq "d['batches'][0]['id']")
chk "sent: invoice INV-1, load billed" "$(mg POST /api/billing-batches/$B1/send | jq "d['batch']['syncStatus'], d['batch']['qbInvoiceId']")|$(load $LB "l['billStatus'], l['qbInvoiceId']")" "sent_to_quickbooks INV-1|billed INV-1"
say "   Case A — Send clicked twice"
chk "second Send refused; still one invoice" "$(mgc POST /api/billing-batches/$B1/send)|$(curl -s -b $M $B/api/_test/qb-fake | jq "d['invoicesCreated']")" "400|1"
say "   Case D — void / unvoid a billed load"
chk "a billed load cannot be voided on its own — it points at the batch" "$(mg POST /api/loads/$LB/void '{"reason":"wrong site"}' | jq "d['billingBatchId']=='$B1', d['error'][:31]")" "True This load is on a billing batch"
chk "voiding the batch voids the QuickBooks invoice and releases the load to Ready to Bill" "$(mg POST /api/billing-batches/$B1/void '{"reason":"wrong site"}' | jq "d['qbVoided']")|$(load $LB "l['billStatus'], repr(l['qbInvoiceId'])")" "True|ready ''"
chk "marked billed by hand, voided, restored → still billed, never back in Ready to Bill" "$(mg POST /api/loads/bill "{\"loadIds\":[\"$LB\"]}" >/dev/null; mg POST /api/loads/$LB/void '{"reason":"typo"}' >/dev/null; mg POST /api/loads/$LB/unvoid >/dev/null; load $LB "l['billStatus']")|$(curl -s -b $M $B/api/ready-to-bill | jq "len([x for x in d['items'] if x['id']=='$LB'])")|$(mgc POST /api/billing-batches "{\"loadIds\":[\"$LB\"]}")" "billed|0|400"
# Matthew finishes his 2 loads and submits; approve
dr $MA $LM '{"action":"arrived-jobsite"}' >/dev/null; dr $MA $LM '{"action":"trip-complete"}' >/dev/null
dr $MA $LM '{"action":"start-trip"}' >/dev/null; dr $MA $LM '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null; dr $MA $LM "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null; dr $MA $LM '{"action":"arrived-jobsite"}' >/dev/null; dr $MA $LM '{"action":"trip-complete"}' >/dev/null
curl -s -b $MA -H "$J" -X PUT $B/api/loads/$LM -d "{\"pod\":{\"signedBy\":\"Site foreman\",\"signature\":\"$PNG\",\"signedAt\":\"$(date -u +%FT%TZ)\"}}" -o /dev/null
dr $MA $LM '{"action":"delivered"}' >/dev/null; mg POST /api/loads/$LM/approve >/dev/null
say "   Case B — QuickBooks accepts the invoice, VBT loses the answer"
B2=$(mg POST /api/billing-batches "{\"loadIds\":[\"$LM\"]}" | jq "d['batches'][0]['id']")
mg POST /api/_test/qb-fake '{"mode":"lost"}' >/dev/null
R=$(mg POST /api/billing-batches/$B2/send); echo "  → $(echo "$R" | jq "d['batch']['errorMessage']")"
# (CRITICAL 4: a lost answer is an UNKNOWN external result, not a failure — the batch is parked for reconciliation.)
chk "batch parked as external-result-unknown and flagged; load NOT marked billed; QuickBooks holds INV-2" "$(echo "$R" | jq "d['batch']['syncStatus'], d['batch']['mayExistInQuickBooks']")|$(load $LM "l['billStatus']")|$(curl -s -b $M $B/api/_test/qb-fake | jq "d['invoicesCreated']")" "unknown True|ready|2"
mg POST /api/_test/qb-fake '{"mode":"ok"}' >/dev/null
chk "Retry finds INV-2 in QuickBooks and adopts it — no third invoice" "$(mg POST /api/billing-batches/$B2/retry | jq "d['recovered'], d['batch']['qbInvoiceId']")|$(load $LM "l['billStatus'], l['qbInvoiceId']")|$(curl -s -b $M $B/api/_test/qb-fake | jq "d['invoicesCreated']")" "True INV-2|billed INV-2|2"
say "   Case C — the user refreshes during Send"
mg POST /api/billing-batches/$B2/void '{"reason":"re-run for the refresh case"}' >/dev/null
B3=$(mg POST /api/billing-batches "{\"loadIds\":[\"$LM\"]}" | jq "d['batches'][0]['id']")
mg POST /api/_test/qb-fake '{"mode":"slow","delayMs":1500}' >/dev/null
curl -s -b $M -H "$J" -X POST $B/api/billing-batches/$B3/send -d '{}' -o /dev/null &
sleep 0.3
chk "mid-send the batch reads 'syncing'; a second Send and a void are refused" "$(curl -s -b $M $B/api/billing-batches/$B3 | jq "d['batch']['syncStatus']")|$(mgc POST /api/billing-batches/$B3/send)|$(mgc POST /api/billing-batches/$B3/void '{"reason":"x"}')" "syncing|409|409"
wait
chk "…it finishes exactly once" "$(curl -s -b $M $B/api/billing-batches/$B3 | jq "d['batch']['syncStatus'], d['batch']['qbInvoiceId']")|$(curl -s -b $M $B/api/_test/qb-fake | jq "d['invoicesCreated']")" "sent_to_quickbooks INV-3|3"
mg POST /api/_test/qb-fake '{"mode":"ok"}' >/dev/null

say "5. YARD COSTING — planned OUR yard, actually loaded at Vulcan (Carlos)"
dr $CA $LU '{"action":"start-trip"}' >/dev/null
chk "the phone shows the planned pickup: VBT Yard" "$(curl -s -b $CA $B/api/my-dispatch | jq "[l['pickupLocation'] for l in d['loads'] if (l.get('id') or l.get('loadId'))=='$LU'][0]")" "VBT Yard"
dr $CA $LU '{"action":"arrived-pickup","yardId":"vulcan"}' >/dev/null
chk "operational record: the trip was loaded at Vulcan, at Vulcan's \$38 rate (planned rate was \$0)" "$(load $LU "l['trips'][0]['actualYardId'], l['trips'][0]['vendorRate'], l['vendorRate']")|$(curl -s -b $CA $B/api/my-dispatch | jq "[l['pickupLocation'] for l in d['loads'] if (l.get('id') or l.get('loadId'))=='$LU'][0]")" "vulcan 38 0|Vulcan"
dr $CA $LU "{\"action\":\"loaded\",\"ticket\":$(tkt)}" >/dev/null; dr $CA $LU '{"action":"arrived-jobsite"}' >/dev/null; dr $CA $LU '{"action":"trip-complete"}' >/dev/null
curl -s -b $CA -H "$J" -X PUT $B/api/loads/$LU -d "{\"pod\":{\"signedBy\":\"x\",\"signature\":\"$PNG\",\"signedAt\":\"$(date -u +%FT%TZ)\"}}" -o /dev/null
dr $CA $LU '{"action":"delivered"}' >/dev/null; mg POST /api/loads/$LU/approve >/dev/null
chk "vendor bill: Vulcan, 1 load, \$950 — not a \$0 VBT line" "$(mg POST /api/vendor-bills/preview "{\"loadIds\":[\"$LU\"]}" | jq "[(g['vendorName'], g['totalAmount'], g['lineItems'][0]['description']) for g in d['groups']]")" "[('Vulcan', 950, '3/4 Rock — 1 load (25.00 ton @ \$38/ton)')]"
chk "customer invoice for the same load is unaffected by the yard: \$625" "$(mg POST /api/billing-batches/preview "{\"loadIds\":[\"$LU\"]}" | jq "d['groups'][0]['totalAmount']")" "625"
say "   …and the opposite: planned Vulcan, actually loaded at OUR yard (Rigo, 2 loads)"
for n in 1 2; do dr $RG $LR '{"action":"start-trip"}' >/dev/null; dr $RG $LR '{"action":"arrived-pickup","yardId":"vbt"}' >/dev/null; dr $RG $LR "{\"action\":\"loaded\",\"ticket\":{\"source\":\"vbt\",\"number\":\"VBT-R$n\",\"photo\":\"$PNG\"}}" >/dev/null; dr $RG $LR '{"action":"arrived-jobsite"}' >/dev/null; dr $RG $LR '{"action":"trip-complete"}' >/dev/null; done
curl -s -b $RG -H "$J" -X PUT $B/api/loads/$LR -d "{\"pod\":{\"signedBy\":\"x\",\"signature\":\"$PNG\",\"signedAt\":\"$(date -u +%FT%TZ)\"}}" -o /dev/null
chk "Rigo submits (2/2, photo and signature on file) and the office approves" "$(dr $RG $LR '{"action":"delivered"}' | jq "d.get('success')")|$(mg POST /api/loads/$LR/approve | jq "d.get('success') or d.get('code')")" "True|True"
chk "planned Vulcan (\$38 snapshot) but loaded at VBT: no vendor cost, no vendor bill" "$(load $LR "l['vendorRate'], [t['actualYardId'] for t in l['trips']]")|$(mgc POST /api/vendor-bills/preview "{\"loadIds\":[\"$LR\"]}")" "38 ['vbt', 'vbt']|400"
chk "Profitability and Material Costs agree: Vulcan 6 loads = \$5,700 in material, nothing for the VBT hauls" "$(curl -s -b $M $B/api/profitability | jq "int(d['grand']['cost']), d['grand']['costIncomplete']")|$(curl -s -b $M $B/api/material-costs | jq "int(d['grandTotal']), d['vendors']['vulcan']['totalLoads'], 'vbt' in d['vendors']")" "5700 False|5700 6 False"

say "5b. END OF DAY — one list instead of five screens: what is clean, what is open, what needs a person, what is blocked"
review() { curl -s -b $M "$B/api/day-review" | python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
chk "the day's 4 loads: 2 billed (clean), 2 approved at the default rate (attention, 'bill it'); nothing open, nothing blocked; the board tile carries the same counts" "$(review "d['counts']")|$(curl -s -b $M $B/api/today | jq "d['review']['attention'], d['review']['blocked']")" "{'total': 4, 'clean': 2, 'open': 0, 'attention': 2, 'blocked': 0}|2 0"
chk "   each line says why and what is next" "$(review "sorted((i['id'], i['state'], ' · '.join(i['reasons']), i['next']) for i in d['items'])")" "[('$LB', 'clean', 'billed by hand', ''), ('$LM', 'clean', 'billed · invoice HG-101', ''), ('$LR', 'attention', 'approved, not yet billed · default customer rate — no price on file', 'bill it'), ('$LU', 'attention', 'approved, not yet billed · default customer rate — no price on file', 'bill it')]"
chk "   the reconciliation reads as sentences: 8 deliveries on 4 loads, every delivered load accounted for, 2 at a default rate" "$(review "' / '.join(d['reconciliation'])")" "8 deliveries on 4 loads — 0 waiting for approval, 2 ready to bill, 0 on a batch, 2 billed. / Every delivered load is submitted, approved or billed. / 2 loads are priced at a default customer rate."
echo "  $(review "' | '.join(f\"{i['state']}: {i['customer']} {i['poNumber']} {i['id']} — {' · '.join(i['reasons'])}\" for i in d['items'])")"

say "6. SAVE FAILURE — what the dispatcher sees when the database refuses the write"
mg POST /api/_test/save-mode '{"mode":"fail"}' >/dev/null
R=$(mg POST /api/pos '{"po":{"poNumber":"HG-LOST","customer":"Hilltop Grading","deliveryDate":"'"$TODAY"'"},"splits":[{"truckId":"beryle","truckUnitId":"truck-2","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' -w '\n%{http_code}')
echo "  → HTTP $(echo "$R" | tail -1): $(echo "$R" | head -1 | jq "d['error']")"
chk "create PO: 503, the message says nothing was created, and nothing was" "$(echo "$R" | tail -1)|$(echo "$R" | head -1 | jq "'Nothing was created' in d['error']")|$(data "len([p for p in d['pos'] if p['poNumber']=='HG-LOST'])")" "503|True|0"
P9=$(mg POST /api/pos '{"po":{"poNumber":"HG-102","customer":"Hilltop Grading","deliveryDate":"'"$TODAY"'"},"splits":[{"truckId":"beryle","truckUnitId":"truck-2","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' | jq "d.get('po',{}).get('id','')")
chk "   (every other write also answers 503 while the database is down)" "$(mgc PUT /api/drivers/leonardo '{"phone":"559-555-0100"}')" "503"
mg POST /api/_test/save-mode '{"mode":"ok"}' >/dev/null
chk "once the database is back the same PO saves" "$(mgc POST /api/pos '{"po":{"poNumber":"HG-LOST","customer":"Hilltop Grading","deliveryDate":"'"$TODAY"'"},"splits":[{"truckId":"beryle","truckUnitId":"truck-2","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}')" "200"
say "   A driver tap that fails to save is refused and leaves nothing behind (the store rolls back to what is on disk)"
P8=$(mg POST /api/pos '{"po":{"poNumber":"HG-103","customer":"Hilltop Grading","deliveryDate":"'"$TODAY"'","plannedVendorId":"vbt"},"splits":[{"truckId":"matthew","truckUnitId":"truck-4","material":"Dirt","loadsAssigned":1,"vendorId":"vbt"}]}' | jq "d['po']['id']"); L8=$(loadof $P8 matthew)
mg POST /api/_test/save-mode '{"mode":"fail"}' >/dev/null
chk "trip step during the outage → 503 to the phone" "$(curl -s -b $MA -H "$J" -X POST $B/api/loads/$L8/trip-action -d '{"action":"start-trip"}' -o /dev/null -w '%{http_code}')" "503"
chk "   …and the load shows no trip: memory was rolled back, the board still says 'assigned'" "$(load $L8 "len(l['trips'])")|$(curl -s -b $M $B/api/today | jq "[l['bucket'] for l in d['loads'] if l['id']=='$L8'][0]")" "0|assigned"
mg POST /api/_test/save-mode '{"mode":"ok"}' >/dev/null

say "7. ARCHIVE — billed work leaves the board, not the records; then a restart"
BEFORE=$(curl -s -b $M $B/api/material-costs | jq "int(d['grandTotal'])")
chk "archive: Leonardo's (manual) and Matthew's (QuickBooks) billed loads leave the board" "$(mg POST /api/history/archive | jq "d['archived']['loads'], d['heldBack']")|$(data "len([l for l in d['loads'] if l['id'] in ('$LB','$LM')])")" "2 0|0"
chk "the batch still knows its load; the archived load still knows its PO, trips and invoice" "$(curl -s -b $M $B/api/billing-batches/$B3 | jq "[l['id'] for l in d['loads']]")|$(curl -s -b $M $B/api/history | python3 -c "
import json,sys;d=json.load(sys.stdin);l=[x for b in d['archive'] for x in b['loads'] if x['id']=='$LM'][0];po=[p for b in d['archive'] for p in b['pos'] if p['id']==l['poId']]
print(len(po), len(l['trips']), l['qbInvoiceId'], l['billingBatchId']=='$B3')")" "['$LM']|0 2 INV-3 True"
echo "  $(review "' | '.join(f\"{i['state']}: {i['poNumber']} {i['id']} — {' · '.join(i['reasons'])}\" for i in d['items'])")"
chk "the end-of-day list follows the board: the two billed loads leave it; the two orders saved since (HG-LOST, HG-103 — HG-102 was refused during the outage) are open" "$(review "d['counts'], [i['id'] for i in d['items'] if i['id'] in ('$LB','$LM')]")" "{'total': 4, 'clean': 0, 'open': 2, 'attention': 2, 'blocked': 0} []"
chk "the archived order's jobsite is still a saved site for its customer (the New PO picker offers it, with its pin if one was set)" "$(curl -s -b $M "$B/api/jobsites?customer=Hilltop%20Grading" | jq "[(s['address'], s['city'], s['count']>=1) for s in d['jobsites'] if s['address']=='400 Ridge Rd']")" "[('400 Ridge Rd', 'Clovis', True)]"
chk "Material Costs and Reports unchanged by archiving" "$(curl -s -b $M $B/api/material-costs | jq "int(d['grandTotal'])==$BEFORE")|$(curl -s -b $M $B/api/reports | jq "d['totals']['billedThisMonth']")" "True|2"
chk "Case E: voiding the batch after archive releases the archived copy too" "$(mg POST /api/billing-batches/$B3/void '{"reason":"customer dispute"}' | jq "d['success'], d['qbVoided']")|$(curl -s -b $M $B/api/history | python3 -c "
import json,sys;d=json.load(sys.stdin);l=[x for b in d['archive'] for x in b['loads'] if x['id']=='$LM'][0];print(l['billStatus'], repr(l['qbInvoiceId']))")" "True True|ready ''"
chk "   …and it cannot be batched twice from the board (it is archived)" "$(mgc POST /api/billing-batches "{\"loadIds\":[\"$LM\"]}")|$(curl -s -b $M $B/api/ready-to-bill | jq "len([x for x in d['items'] if x['id']=='$LM'])")" "400|0"
say "   Restart: what survives is exactly what was saved"
pkill -f "^node server.js" >/dev/null 2>&1; sleep 1; start
M=$(login joshua joshua123)
chk "after restart: archive, batches, sync log and the recovered invoice ids are all there" "$(curl -s -b $M $B/api/history | jq "sum(len(b['loads']) for b in d['archive'])")|$(curl -s -b $M $B/api/billing-batches | jq "sorted((b['id']==('$B1','$B2','$B3')[i], b['syncStatus']) for i,b in enumerate(sorted(d['items'], key=lambda x: x['createdAt'])))")|$(curl -s -b $M "$B/api/qb-sync-log?actionType=recover_invoice" | jq "len(d['items'])")" "2|[(True, 'voided'), (True, 'voided'), (True, 'voided')]|1"
chk "the tap that was answered 503 never took effect: after the restart the load still has no trip" "$(load $L8 "len(l['trips'])")" "0"
chk "   …so the driver's retry simply starts the trip — no duplicate, no confusing 'already started'" "$(MA=$(login matthew matthew123); curl -s -b $MA -H "$J" -X POST $B/api/loads/$L8/trip-action -d '{"action":"start-trip"}' | jq "d.get('success'), len(d['load']['trips'])")" "True 1"
chk "the PO refused during the outage never existed; the one saved afterwards does" "$(data "len([p for p in d['pos'] if p['poNumber']=='HG-LOST'])")" "1"

echo; echo "════ scenario: $PASS passed, $FAIL failed ════"
pkill -f "^node server.js" >/dev/null 2>&1; rm -f data.json data-ids.json telemetry.json
[ "$FAIL" -eq 0 ]
