#!/usr/bin/env bash
# Paperwork and fleet safety: the pre-trip inspection (DVIR), defect reports and
# vehicle clearance, the end-of-day driver-day review, the Freight Bill packet.
# File mode, port 4660. Stops any running server and resets data.json.
set -u
export PORT=${PORT:-4660}
B=http://localhost:$PORT
PASS=0; FAIL=0
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; PASS=$((PASS+1)); else echo "  FAIL  $1 — got '$2' want '$3'"; FAIL=$((FAIL+1)); fi; }
jq() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)" 2>/dev/null; }
J='Content-Type: application/json'
PNG="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
cd "$(dirname "$0")"
pkill -f '^node server.js' >/dev/null 2>&1; sleep 1; rm -f data.json data-ids.json telemetry.json
(VBT_TEST_HOOKS=1 node server.js > /tmp/vbt-paperwork.log 2>&1 &)
for i in $(seq 1 20); do sleep 1; curl -sf $B/healthz >/dev/null 2>&1 && break; done
login() { local f; f=$(mktemp); curl -s -c $f -X POST -d "username=$1&password=$2" $B/login -o /dev/null; echo $f; }
M=$(login joshua joshua123); R=$(login rigo rigo123); C=$(login carlos carlos123); L=$(login leonardo leo123)
as() { local c=$1 m=$2 u=$3; shift 3; if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then local body=$1; shift; curl -s -b $c -H "$J" -X "$m" "$B$u" -d "$body" "$@"; else curl -s -b $c -H "$J" -X "$m" "$B$u" "$@"; fi; }
mg() { as $M "$@"; }
ITEMS=$(curl -s -b $R $B/api/shifts/current | python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin)['inspectionItems']))")
ans() { python3 -c "import json,sys;print(json.dumps({i:('defect' if i in sys.argv[2:] else 'ok') for i in json.loads(sys.argv[1])}))" "$ITEMS" "$@"; }
OKA=$(ans); TODAY=$(TZ=America/Los_Angeles date +%F)
TR=$(curl -s -b $R $B/api/shifts/current | python3 -c "import json,sys;print(' '.join(t['id'] for t in json.load(sys.stdin)['trucks'][:3]))"); set -- $TR; T1=$1; T2=$2; T3=$3
start() { as $1 POST /api/shifts/start "{\"truckId\":\"$2\",\"odometer\":$3,\"inspection\":$4,\"signature\":\"$PNG\"${5:+,$5}}"; }

echo "── DVIR: the driver's answers, never the app's ──"
chk "an inspection with no answers is refused (a bare 'satisfactory: true' is not an inspection)" "$(start $R $T1 1000 '{"satisfactory":true}' | jq "d['code']")" "inspection_incomplete"
chk "ten of eleven items answered: refused, and the missing item is named" "$(start $R $T1 1000 "{\"answers\":$(python3 -c "import json,sys;a=json.loads(sys.argv[1]);a.pop('Horn');print(json.dumps(a))" "$OKA")}" | jq "d['code'], d['unanswered']")" "inspection_incomplete ['Horn']"
chk "an answer that is neither ok nor defect is not an answer" "$(start $R $T1 1000 "{\"answers\":$(python3 -c "import json,sys;a=json.loads(sys.argv[1]);a['Horn']='yes';print(json.dumps(a))" "$OKA")}" | jq "d['code']")" "inspection_incomplete"
chk "'satisfactory' with an item marked defect is a contradiction, refused" "$(start $R $T1 1000 "{\"satisfactory\":true,\"answers\":$(ans Brakes),\"remarks\":\"soft pedal\",\"safeToOperate\":true}" | jq "d['code']")" "inspection_contradiction"
chk "a defect needs the driver's words" "$(start $R $T1 1000 "{\"answers\":$(ans Brakes),\"safeToOperate\":true}" | jq "d['code']")" "defect_remarks_required"
chk "a minor defect needs the driver's explicit statement whether the truck is safe to drive" "$(start $R $T1 1000 "{\"answers\":$(ans Mirrors),\"remarks\":\"soft pedal\"}" | jq "d['code']")" "safe_to_operate_required"
chk "after every refusal: no day, no defect report, nothing half-written" "$(mg GET /api/defect-reports | jq "len(d['reports'])") $(as $R GET /api/shifts/current | jq "d['shift']")" "0 None"

echo "── A blocking defect takes the truck out of service — the driver's declaration cannot override it ──"
# Work planned on T1 before anything is wrong with it.
po() { mg POST /api/pos "{\"po\":{\"poNumber\":\"$1\",\"customer\":\"Hold Test Co\",\"deliveryDate\":\"$TODAY\",\"address\":\"1 Test Rd\",\"city\":\"Merced\",\"plannedVendorId\":\"vbt\"},\"splits\":[{\"truckId\":\"$2\",\"truckUnitId\":\"$3\",\"material\":\"Dirt\",\"loadsAssigned\":1,\"vendorId\":\"vbt\"}]${4:+,$4}}"; }
loadOf() { mg GET /api/data | jq "[l['id'] for l in d['loads'] if l['poId']==[p['id'] for p in d['pos'] if p['poNumber']=='$1'][0]][0]"; }
po HOLD-1 carlos $T1 >/dev/null; HL1=$(loadOf HOLD-1)
po HOLD-2 leonardo $T3 >/dev/null; HL2=$(loadOf HOLD-2)
NS=$(start $R $T1 1000 "{\"answers\":$(ans Brakes),\"remarks\":\"brake pedal goes to the floor\",\"safeToOperate\":true}")
chk "Brakes marked defect, driver declares 'safe to drive': the truck is held anyway (409 vehicle_out_of_service), no day starts, his declaration is recorded and changes nothing" "$(echo "$NS" | jq "d['code'], d['report']['held'], d['report']['severity'], d['report']['holdReason'], d['report']['blocking'], d['report']['safeToOperate']") $(as $R GET /api/shifts/current | jq "d['shift']")" "vehicle_out_of_service True out-of-service blocking-defect ['Brakes'] True None"
DR1=$(echo "$NS" | jq "d['report']['id']")
chk "  the original inspection is kept with the report, answer by answer" "$(mg GET /api/defect-reports | jq "(lambda r: (r['inspection']['answers']['Brakes'], r['inspection']['answers']['Horn'], len(r['inspection']['answers']), r['hasSignature'], r['history'][0]['type']))(d['reports'][0])")" "('defect', 'ok', 11, True, 'reported')"
chk "  the board: one defect report, one truck held; the truck is unavailable and says why; the load planned on it is flagged" "$(mg GET /api/today | jq "d['attention']['vehicleDefects'], d['attention']['vehiclesHeld'], [(t['state'], t['available'], t['held'], t['heldFor']) for t in d['trucks'] if t['id']=='$T1'], ['held out of service' in ' '.join(l['conflicts']) for l in d['loads'] if l['id']=='$HL1']")" "1 1 [('unavailable', False, True, 'Brakes')] [True]"
echo "── A held truck cannot be dispatched by any path ──"
chk "  Start day by another driver with a clean inspection: refused" "$(start $C $T1 1000 "{\"answers\":$OKA}" | jq "d['code']")" "vehicle_held"
chk "  Quick Assign onto the held truck: refused — and 'force' (which overrides conflicts) does not override a hold" "$(mg POST /api/loads/$HL2/assign "{\"truckUnitId\":\"$T1\"}" | jq "d['code']") $(mg POST /api/loads/$HL2/assign "{\"truckUnitId\":\"$T1\",\"force\":true,\"reason\":\"need it\"}" | jq "d['code']") $(mg GET /api/data | jq "[l['truckUnitId'] for l in d['loads'] if l['id']=='$HL2']==['$T3']")" "vehicle_held vehicle_held True"
chk "  a new PO on the held truck: refused, forced or not; no PO is created" "$(po HOLD-3 matthew $T1 | jq "d['code']") $(po HOLD-3 matthew $T1 '"force":true,"reason":"x"' | jq "d['code']") $(mg GET /api/data | jq "len([p for p in d['pos'] if p['poNumber']=='HOLD-3'])")" "vehicle_held vehicle_held 0"
HP1=$(mg GET /api/data | jq "[p['id'] for p in d['pos'] if p['poNumber']=='HOLD-1'][0]")
chk "  adding a load on the held truck to an existing PO: refused" "$(mg POST /api/pos/$HP1/loads "{\"truckId\":\"matthew\",\"truckUnitId\":\"$T1\",\"material\":\"Dirt\",\"loadsAssigned\":1,\"vendorId\":\"vbt\"}" | jq "d['code']")" "vehicle_held"
chk "  the load already planned on it cannot start a trip (Carlos, his day on another truck)" "$(start $C $T2 2000 "{\"answers\":$OKA}" | jq "d['shift']['status']") $(as $C POST /api/loads/$HL1/trip-action '{"action":"start-trip"}' | jq "d['code']") $(mg GET /api/data | jq "[len(l['trips']) for l in d['loads'] if l['id']=='$HL1']")" "open vehicle_held [0]"
CS=$(as $C GET /api/shifts/current | jq "d['shift']['id']")
chk "  a truck change onto the held truck: refused" "$(as $C POST /api/shifts/$CS/truck-change "{\"toTruckId\":\"$T1\",\"fromOdometer\":2001,\"toOdometer\":1000}" | jq "d['code']")" "vehicle_held"
chk "  the office moves the load to a free truck: accepted, and its trip starts" "$(mg POST /api/loads/$HL1/assign "{\"truckUnitId\":\"$T2\"}" | jq "d.get('success', d.get('ok'))") $(as $C POST /api/loads/$HL1/trip-action '{"action":"start-trip"}' | jq "d.get('success')")" "True True"
echo "── Clearance is an authorized, recorded act ──"
chk "  a driver cannot clear it" "$(as $C POST /api/defect-reports/$DR1/resolve '{"decision":"corrected","by":"me","note":"fine"}' | jq "d['error']")" "Office access required"
chk "  a blocking defect is cleared by a repair, never by 'no correction needed'" "$(mg POST /api/defect-reports/$DR1/resolve '{"decision":"no-correction-needed","by":"Hector","note":"looks ok"}' | jq "d['code']")" "repair_required"
chk "  no decision, no name, no description of the repair: each refused, the truck stays held" "$(mg POST /api/defect-reports/$DR1/resolve '{}' -o /dev/null -w '%{http_code}') $(mg POST /api/defect-reports/$DR1/resolve '{"decision":"corrected"}' | jq "d['error']") | $(mg POST /api/defect-reports/$DR1/resolve '{"decision":"corrected","by":"Hector"}' | jq "d['error']") | $(mg GET /api/today | jq "d['attention']['vehiclesHeld']")" "400 Name the mechanic or person who checked the truck | Say what was repaired | 1"
chk "  an admin records the repair: defect, repair, person responsible, who cleared it and when are all on the report; the hold is released; the audit log has it" "$(mg POST /api/defect-reports/$DR1/resolve '{"decision":"corrected","by":"Hector (shop)","note":"replaced master cylinder, bled brakes"}' | jq "(lambda r: (r['status'], r['held'], r['resolution']['by'], r['resolution']['note'], r['resolution']['recordedBy'], r['resolution']['recordedByRole'], r['resolution']['releasedHold'], bool(r['resolution']['at']), [e['type'] for e in r['history']]))(d['report']), d['truckStillHeld']") $(mg GET /api/audit-log | python3 -c "import json,sys;d=json.load(sys.stdin);r=d if isinstance(d,list) else d.get('entries',d.get('log',[]));print(sum(1 for e in r if e.get('action')=='cleared-vehicle-hold'), sum(1 for e in r if e.get('action')=='vehicle-held'))")" "('cleared', False, 'Hector (shop)', 'replaced master cylinder, bled brakes', 'Joshua', 'admin', True, True, ['reported', 'cleared']) False 1 1"
chk "  a closed report cannot be closed twice" "$(mg POST /api/defect-reports/$DR1/resolve '{"decision":"corrected","by":"x y","note":"again"}' | jq "d['code']")" "already_resolved"
chk "  the cleared truck takes an assignment again" "$(mg POST /api/loads/$HL2/assign "{\"truckUnitId\":\"$T1\"}" | jq "d.get('success', d.get('ok'))")" "True"
chk "  a correction is traceable: reopening needs a reason, restores the hold, and keeps the earlier clearance in the history" "$(mg POST /api/defect-reports/$DR1/reopen '{}' -o /dev/null -w '%{http_code}') $(mg POST /api/defect-reports/$DR1/reopen '{"reason":"pedal soft again on the test drive"}' | jq "d['truckHeld'], d['report']['status'], [e['type'] for e in d['report']['history']], d['report']['history'][-1]['previousResolution']['by'], d['report']['inspection']['answers']['Brakes']")" "400 True open ['reported', 'cleared', 'reopened'] Hector (shop) defect"
mg POST /api/loads/$HL2/assign "{\"truckUnitId\":\"$T3\"}" >/dev/null
chk "  cleared again after the second repair: four history entries, nothing overwritten" "$(mg POST /api/defect-reports/$DR1/resolve '{"decision":"corrected","by":"Hector (shop)","note":"replaced rear brake line"}' | jq "[e['type'] for e in d['report']['history']], d['report']['history'][1]['repair'], d['report']['history'][3]['repair']")" "['reported', 'cleared', 'reopened', 'cleared'] replaced master cylinder, bled brakes replaced rear brake line"
echo "── A minor defect the driver calls NOT safe also holds the truck ──"
RSH=$(start $R $T1 1000 "{\"answers\":$(ans 'Windshield and wipers'),\"remarks\":\"wipers dead, rain forecast\",\"safeToOperate\":false}")
chk "minor defect + driver says not safe: held (409 vehicle_not_safe), severity minor, reason is his declaration" "$(echo "$RSH" | jq "d['code'], d['report']['severity'], d['report']['holdReason'], d['report']['held']")" "vehicle_not_safe minor driver-declared-not-safe True"
DR3=$(echo "$RSH" | jq "d['report']['id']")
chk "  an admin may clear a minor hold either way, with the reason on record" "$(mg POST /api/defect-reports/$DR3/resolve '{"decision":"corrected","by":"Hector (shop)","note":"new wiper motor"}' | jq "d['report']['status'], d['truckStillHeld']")" "cleared False"
chk "  the reporting driver then starts his day on it" "$(start $R $T1 1000 "{\"answers\":$OKA}" | jq "d['shift']['status'], d['shift']['inspection']['satisfactory'], len(d['shift']['inspection']['answers'])")" "open True 11"

echo "── Safe to drive with a defect: the day starts, the report stays open ──"
LS=$(start $L $T3 3000 "{\"answers\":$(ans Mirrors 'Trailer and tarp'),\"remarks\":\"left mirror cracked, tarp torn\",\"safeToOperate\":true}")
chk "driver says safe: the day starts; the answers, the defects and his statement are on the record" "$(echo "$LS" | jq "d['shift']['status'], d['shift']['inspection']['satisfactory'], d['shift']['inspection']['defects'], d['shift']['inspection']['safeToOperate'], d['shift']['inspection']['answers']['Mirrors'], d['shift']['inspection']['answers']['Brakes']")" "open False ['Mirrors', 'Trailer and tarp'] True defect ok"
LSID=$(echo "$LS" | jq "d['shift']['id']"); DR2=$(echo "$LS" | jq "d['shift']['inspection']['defectReportId']")
chk "  an open report exists for the office (minor); the truck is not held and still takes work" "$(mg GET '/api/defect-reports?status=open' | jq "[(r['id']=='$DR2', r['held'], r['severity'], r['shiftId']=='$LSID') for r in d['reports']], d['held']") $(mg GET /api/today | jq "[t.get('held', False) for t in d['trucks'] if t['id']=='$T3']")" "[(True, False, 'minor', True)] 0 [False]"
chk "  the Daily Log checklist is the driver's answers (9 OK, 2 defect, none blank) and flags the open report" "$(as $L GET "/api/daily-log?date=$TODAY" | jq "(lambda i: (len([c for c in i['checklist'] if c['state']=='ok']), sorted(c['name'] for c in i['checklist'] if c['state']=='defect'), len([c for c in i['checklist'] if c['state']=='blank'])))(d['log']['inspections'][0]), 'defect_open' in [e['code'] for e in d['log']['exceptions']]")" "(9, ['Mirrors', 'Trailer and tarp'], 0) True"
as $L POST /api/shifts/$LSID/end '{"odometer":3050}' >/dev/null
chk "  the next driver on that truck is shown the open report and must acknowledge it (409 open_defects)" "$(RS2=$(as $R GET /api/shifts/current | jq "d['shift']['id']"); as $R POST /api/shifts/$RS2/end '{"odometer":1010}' >/dev/null; start $R $T3 3050 "{\"answers\":$OKA}" | jq "d['code'], [r['defects'] for r in d['reports']]")" "open_defects [['Mirrors', 'Trailer and tarp']]"
chk "  acknowledged: his day starts and the acknowledgment is recorded on his inspection" "$(start $R $T3 3050 "{\"answers\":$OKA}" "\"acknowledgedDefectReports\":[\"$DR2\"]" | jq "d['shift']['status'], [a['id']=='$DR2' for a in d['shift']['inspection']['acknowledgedOpenDefects']]")" "open [True]"
chk "  a later satisfactory inspection does NOT close the report — only a person does" "$(mg GET '/api/defect-reports?status=open' | jq "len(d['reports'])")" "1"
mg POST /api/defect-reports/$DR2/resolve '{"decision":"no-correction-needed","by":"Oscar","note":"mirror usable, tarp patched; replace Friday"}' >/dev/null
chk "  the office's follow-up prints beside the Daily Log and is not part of what the driver signs" "$(curl -s -b $M "$B/api/daily-log/print?driverId=leonardo&date=$TODAY" | python3 -c "import sys;h=sys.stdin.read();print('Defect report $DR2' in h, 'need not be corrected' in h, 'Oscar' in h)") $(as $L GET "/api/daily-log?date=$TODAY" | jq "'defect_open' in [e['code'] for e in d['log']['exceptions']], 'defectFollowUp' in d['log']")" "True True True False True"

echo "── End of day: the drivers' days and paperwork, with reasons, and an acknowledgment that changes nothing else ──"
rv() { mg GET "/api/day-review?date=$TODAY" | jq "$1"; }
dayOf() { echo "[x for x in d['days'] if x['driverId']=='$1'][0]"; }
chk "the review lists each driver who worked: Leonardo's day is closed and his Daily Log is unsigned (attention, with its next step); no fuel is a note, not an exception" "$(rv "(lambda x: (x['logStatus'], x['state'], [(i['code'], i['severity']) for i in x['items']], 'signs it on the phone' in x['items'][0]['next']))($(dayOf leonardo))")" "('unsigned', 'attention', [('log_unsigned', 'attention'), ('fuel_none', 'note')], True)"
chk "  Rigo's and Carlos's days are still open today: open work, not exceptions" "$(rv "[(x['driverId'], x['logStatus'], x['state']) for x in d['days'] if x['driverId'] in ('rigo','carlos')]")" "[('carlos', 'open', 'open'), ('rigo', 'open', 'open')]"
chk "  the counts keep paperwork apart from loads; the board's End-of-day tile carries it" "$(rv "d['counts']['paperwork']['attention'], d['counts']['paperwork']['open'] >= 2, d['counts']['paperwork']['notes'] >= 1") $(mg GET /api/today | jq "d['review']['paperwork']['attention']")" "1 True True 1"
KEY=$(rv "[i['key'] for i in $(dayOf leonardo)['items'] if i['code']=='log_unsigned'][0]")
NOTEKEY=$(rv "[i['key'] for i in $(dayOf leonardo)['items'] if i['code']=='fuel_none'][0]")
OPENKEY=$(rv "[i['key'] for i in $(dayOf rigo)['items'] if i['code']=='shift_open'][0]")
ack() { mg POST /api/day-review/acknowledge "{\"date\":\"$TODAY\",\"key\":\"$1\"${2:+,$2}}"; }
chk "  acknowledging needs a note; open work and notes cannot be acknowledged; a key that is no longer on the review is refused (409 stale_review)" "$(ack "$KEY" | jq "d['error'][:20]") | $(ack "$OPENKEY" '"note":"fine"' | jq "d['code']") $(ack "$NOTEKEY" '"note":"fine"' | jq "d['code']") $(ack "$TODAY|driver:leonardo:log_unsigned|0000000000" '"note":"fine"' | jq "d['code']")" "Write why this stand | not_acknowledgeable not_acknowledgeable stale_review"
chk "  acknowledged with a note: who, when and why are recorded; it stays on the list, no longer counted; the audit log has it" "$(ack "$KEY" '"note":"Leonardo left early, signs tomorrow morning"' | jq "(lambda i: (i['ack']['by'], i['ack']['note'], bool(i['ack']['at'])))([i for i in $(echo "[x for x in d['review']['days'] if x['driverId']=='leonardo'][0]")['items'] if i['code']=='log_unsigned'][0]), d['review']['counts']['paperwork']['attention'], d['review']['counts']['paperwork']['acknowledged']") $(mg GET /api/audit-log | python3 -c "import json,sys;d=json.load(sys.stdin);r=d if isinstance(d,list) else d.get('entries',d.get('log',[]));print(sum(1 for e in r if e.get('action')=='acknowledged-review-exception'))")" "('Joshua', 'Leonardo left early, signs tomorrow morning', True) 0 1 1"
chk "  the acknowledgment changed no record: the Daily Log is still unsigned and still cannot be called signed" "$(as $L GET "/api/daily-log?date=$TODAY" | jq "d['log']['status'], d['log']['signoff']")" "unsigned None"
chk "  acknowledged twice: refused; undone: it counts again" "$(ack "$KEY" '"note":"again"' | jq "d['code']") $(ack "$KEY" '"undo":true' | jq "d['review']['counts']['paperwork']['attention'], d['review']['counts']['paperwork']['acknowledged']")" "already_acknowledged 1 0"
ack "$KEY" '"note":"signs tomorrow"' >/dev/null
chk "  the driver signs his Daily Log: the exception is gone by itself (resolved, not acknowledged)" "$(as $L POST /api/daily-log/sign "{\"date\":\"$TODAY\",\"signature\":\"$PNG\"}" | jq "d['log']['status']") $(rv "(lambda x: (x['logStatus'], [i['code'] for i in x['items'] if i['severity']=='attention']))($(dayOf leonardo)), d['counts']['paperwork']['acknowledged']")" "signed ('signed', []) 0"
LSID2=$(mg GET /api/shifts | jq "[x['id'] for x in (d['shifts'] if isinstance(d, dict) else d) if x['driverId']=='leonardo'][0]")
mg POST /api/_test/set-shift "{\"id\":\"$LSID2\",\"patch\":{\"startAt\":\"$(date -u -d '-16 hour' +%FT%T.000Z)\"}}" >/dev/null
chk "  hours that look wrong are flagged with the number and the reason (16 h day), and the changed log asks for a new signature — an earlier acknowledgment does not carry over to a different exception" "$(rv "(lambda x: sorted((i['code'], i['severity'], bool(i['ack'])) for i in x['items'] if i['severity']=='attention'))($(dayOf leonardo))")" "[('hours_long', 'attention', False), ('log_changed', 'attention', False)]"
chk "  a held truck is on the review as a vehicle item that can only be resolved, never acknowledged" "$(as $L POST /api/shifts/start "{\"truckId\":\"$T2\",\"odometer\":1,\"inspection\":{\"answers\":$OKA},\"signature\":\"$PNG\"}" -o /dev/null; T4=$(curl -s -b $R $B/api/shifts/current | python3 -c "import json,sys;print([t['id'] for t in json.load(sys.stdin)['trucks'] if not t['inUseBy'] and not t['held']][0])"); MT=$(login matthew matthew123); start $MT $T4 999999 "{\"answers\":$(ans Steering),\"remarks\":\"wheel pulls hard left\"}" >/dev/null; rv "[(v['code'], v['resolveOnly']) for v in d['vehicles']], d['counts']['paperwork']['attention'] >= 1"; VK=$(rv "d['vehicles'][0]['key']"); ack "$VK" '"note":"ok"' | jq "d['code']")" "[('vehicle_held', True)] True
stale_review"

echo "── Documents are generated from the records: delivery ticket, Freight Bill, packets ──"
doc() { curl -s -b "$1" "$B$2"; }
has() { python3 -c "import sys;h=sys.stdin.read();print($1)"; }
# Carlos hauls HOLD-1 (one load, VBT yard): loaded with a VBT ticket, delivered, signed, submitted.
tk() { as $C POST /api/loads/$HL1/trip-action "$1"; }
TKT="PW$RANDOM$RANDOM"; tk '{"action":"arrived-pickup","yardId":"vbt"}' >/dev/null; tk "{\"action\":\"loaded\",\"ticket\":{\"source\":\"supplier\",\"number\":\"$TKT\",\"netTons\":24.5,\"photo\":\"$PNG\"}}" >/dev/null
chk "before delivery the ticket page says so: DRAFT, the trip listed as not delivered, no signature, counted as 0 of 1" "$(doc $M /api/loads/$HL1/delivery-ticket | has "'DT-$HL1' in h, 'DRAFT — not yet submitted' in h, 'not delivered' in h, 'Not signed' in h, '0 of 1 planned' in h, h.count('class=\"draft\"')")" "True True True True True 1"
tk '{"action":"arrived-jobsite"}' >/dev/null; tk '{"action":"trip-complete"}' >/dev/null
as $C PUT /api/loads/$HL1 "{\"ticketImage\":\"$PNG\",\"pod\":{\"signedBy\":\"Site Foreman\",\"signature\":\"$PNG\"}}" >/dev/null
tk '{"action":"delivered"}' >/dev/null
chk "delivered, signed and submitted: everything on the page is carried from dispatch — customer, PO, jobsite, driver, truck, material, ticket, signer — and it is still DRAFT until a person approves" "$(doc $M /api/loads/$HL1/delivery-ticket | has "all(x in h for x in ['Hold Test Co','HOLD-1','1 Test Rd, Merced','Carlos','Dirt','$TKT','Site Foreman','1 of 1 planned']), 'awaiting approval' in h, 'FINAL' in h, 'alt=\"customer signature\"' in h")" "True True False True"
V1=$(doc $M /api/loads/$HL1/delivery-ticket | python3 -c "import sys,re;print(re.search(r'record version (\w+)', sys.stdin.read()).group(1))")
chk "  a reprint is the same document: same number, same record version" "$(doc $M /api/loads/$HL1/delivery-ticket | python3 -c "import sys,re;h=sys.stdin.read();print(re.search(r'record version (\w+)', h).group(1)=='$V1', h.count('DT-$HL1') >= 2)")" "True True"
chk "  the driver reads his own load's ticket; another driver gets 403; nobody signed out gets it" "$(curl -s -o /dev/null -w '%{http_code}' -b $C $B/api/loads/$HL1/delivery-ticket) $(curl -s -o /dev/null -w '%{http_code}' -b $L $B/api/loads/$HL1/delivery-ticket) $(curl -s -o /dev/null -w '%{http_code}' -H 'Accept: application/json' $B/api/loads/$HL1/delivery-ticket)" "200 403 401"
chk "  the page carries no prices (it is the document a driver or customer holds)" "$(doc $M /api/loads/$HL1/delivery-ticket | has "'\$' in h")" "False"
mg POST /api/loads/$HL1/approve '{"acknowledge":true}' >/dev/null
chk "approved: the same page is FINAL, names the approver, and the record version changed because the record did" "$(doc $M /api/loads/$HL1/delivery-ticket | python3 -c "import sys,re;h=sys.stdin.read();print('FINAL — approved by Joshua' in h, h.count('class=\"draft\"'), re.search(r'record version (\w+)', h).group(1)!='$V1')")" "True 0 True"
chk "  an approved load cannot be edited through its record: the ticket and the signature stay as approved" "$(mg PUT /api/loads/$HL1 '{"pod":{"signedBy":"Someone Else"}}' -o /dev/null -w '%{http_code}') $(doc $M /api/loads/$HL1/delivery-ticket | has "'Site Foreman' in h, 'Someone Else' in h")" "403 True False"
BID=$(mg POST /api/billing-batches "{\"loadIds\":[\"$HL1\"]}" | jq "d['batches'][0]['id']")
chk "the invoice packet: the batch's frozen lines and total, then the load's delivery ticket with its POD — marked NOT SENT until QuickBooks has it (the DRAFT watermark is for supporting records that are not final; these are); office only" "$(doc $M /api/billing-batches/$BID/packet | has "'Invoice packet' in h, '$BID' in h, 'NOT SENT' in h, 'as frozen on the batch' in h, 'DT-$HL1' in h, 'Site Foreman' in h, h.count('class=\"draft\"')") $(curl -s -o /dev/null -w '%{http_code}' -b $C $B/api/billing-batches/$BID/packet)" "True True True True True True 0 403"
chk "  an unknown batch or load is a 404, never an empty document" "$(curl -s -o /dev/null -w '%{http_code}' -b $M $B/api/billing-batches/NOPE/packet) $(curl -s -o /dev/null -w '%{http_code}' -b $M $B/api/loads/NOPE/delivery-ticket)" "404 404"

echo; echo "paperwork: $PASS passed, $FAIL failed"
[ -n "${KEEP:-}" ] && { echo "KEEP: server left running on $PORT, batch $BID, load $HL1"; exit 0; }
pkill -f '^node server.js' >/dev/null 2>&1; rm -f data.json data-ids.json telemetry.json
[ "$FAIL" = "0" ]
