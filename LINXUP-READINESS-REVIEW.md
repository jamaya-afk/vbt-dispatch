# Linxup Readiness Review — L0 + L1 + L2, before any L3 design

Date: 2026-09-29. Scope: everything Linxup-related now in the code
(`linxup.js`, the `/api/linxup/*` and `/api/loads/:id/telemetry` routes in
`server.js`, the board, Load Details, approval dialog and Vendors screens in
`public/index.html`), reviewed against the architecture rule:

> Linxup is the source of truth for vehicle telematics. VBT is the source of
> truth for operations, dispatch and billing. Telemetry is evidence attached
> to VBT records; it never changes them.

Verdict: **the rule holds.** No code path lets a Linxup message write a
dispatch, assignment, status, approval or billing field. Two things were
corrected during this review (§2); everything else is a note, a hardening
suggestion or a question for Linxup. L3 has not been started.

---

## 1. Findings, area by area

### 1.1 Data ownership

**Every VBT store field Linxup can influence.** There are exactly three, and
all three are written only by a manager's request, never by a webhook:

| Field | Written by | Route | Audit action |
|---|---|---|---|
| `truck.linxup` = `{trackerId, name, deviceNumber, deviceSerialNumber, vin, linkedAt, linkedBy, seen}` | manager | `PUT /api/fleet/trucks/:id/linxup` | `linked-tracker` / `unlinked-tracker` |
| `driver.linxupPersonId` | manager | `PUT /api/drivers/:username` | (driver update) |
| `vendor.linxupGeofenceId` | manager | `PUT /api/vendors/:id/linxup-geofence` | `mapped-geofence` |

The name / IMEI / serial / VIN copied into `truck.linxup` at link time are a
snapshot for later verification (§1.2), not live data.

**Linxup does not write business state.** Verified three ways:

- `linxup.js` contains no reference to the dispatch store (`grep -v '^\s*//' linxup.js | grep -c 'store\.'` = 0, asserted by e2e §47).
- The webhook route calls `linxup.authorize` and `linxup.handle` and nothing else (`server.js`, `app.post('/api/linxup/:type')`); it never calls `saveData`.
- The evidence engine `loadTelemetryEvidence` and the telemetry route are read-only (asserted by e2e §48: zero occurrences of `saveData`, `logAction`, `approvalStatus`, `.locked`, `.status =`, `truckId =`, `driverName =` in the function; the route exists only as GET). §48 also compares the load's JSON byte for byte before and after evidence is read.

**Telemetry stays outside the dispatch store.** Tables `linxup_trackers`,
`linxup_latest_positions`, `linxup_positions`, `linxup_geofences`,
`linxup_geofence_events`, `linxup_stops`, `linxup_vehicle_trips`,
`linxup_usage`, `linxup_webhook_log` (file mode: `telemetry.json`, git-ignored).
The Postgres run (§21/pg) asserts the store row contains no fence event, visit,
stop or duration field — only the yard mapping and its audit entry.

### 1.2 Truck identity

- **trackerId is the only linkage.** `truckTelematics` resolves the tracker by `truck.linxup.trackerId`; names are labels only. One tracker per truck is enforced (409).
- **VIN / device changes are flagged, not applied.** `truckTelematics` compares the tracker mirror's current VIN and IMEI to the snapshot taken at link time and produces `trackerMismatch` ("VIN now … (linked as …)"), which becomes a `tracker-mismatch` attention item on the board and appears in the load's Current block. The VBT truck record is not touched (e2e §47 and §48 assert `truck.linxup.vin` unchanged and the load's truck unchanged).
- **Renaming a tracker changes its label only.** A Device Update with a new name updates `linxup_trackers.name`; the link, the driver flag and the load stand (e2e §47 "a rename changes the label only").

### 1.3 Driver identity

- `linxupDriver` on the board and in evidence is `{personId, name, vbtDriverId, vbtDriverName}` computed from the tracker mirror's latest `person` and the manager's `linxupPersonId` mapping. It is displayed as "Linxup driver: …" and is never written to a load.
- The only automatic effect of a Linxup person is `driverMismatch` → the `driver-mismatch` attention item ("Linxup reports Jesus Guzman in Truck #2, but VBT has Beryle assigned."). e2e §47/§48 assert `load.truckId` and `load.driverName` are unchanged while the flag is up.
- A Device Update without a person clears Linxup's driver (Linxup's word, not VBT's); an unmapped person raises no flag.

### 1.4 Geofences

- **Mapping.** `vendor.linxupGeofenceId` is set only through the Vendors panel (manager). Unknown fence → 400; fence already mapped to another yard → 409; "Edit Vendor" preserves the mapping.
- **Name match is a suggestion on the mapping screen.** `GET /api/linxup/geofences` returns `suggestedVendorId` for an exact, case-insensitive name match; the panel shows "Suggested by name: … — pick it and Save to confirm" and never saves on its own (browser suite, "only SUGGESTS the name match").
- **Note for L3 (decision needed, §2.4):** the evidence engine also *uses* an exact name match when no mapping is saved, labelled "matched by name" and with `confidence: 'name'` in the API. That is acceptable for evidence a person reads; it must not be enough for any automation.
- **Unmapped yards are ordinary VBT yards.** A yard with no fence and no pin shows "no Linxup geofence mapped and no saved pin, so nothing to compare"; nothing else changes. A yard with a pin but no fence gets GPS-near-pin evidence.
- **Jobsite proximity is derived, not confirmed.** It is computed at read time from positions against the PO's own pin (300 m), presented as "near jobsite based on GPS", never stored, and never called confirmed (e2e §48 greps the page and server for "confirmed by GPS" / "arrival confirmed"; the browser suite asserts the word "confirmed" is absent from the section).

### 1.5 Load evidence

- **Tied to the truck that ran each trip.** `truckFor(trip)` uses `trip.truckUnitId`, stamped at Start trip (Phase 0 C7); e2e §48 moves a load from Truck #2 to Truck #4 between trips and asserts trip 1 keeps Truck #2's visits while trip 2 shows Truck #4's. Trips from before Phase 0 (no `truckUnitId` on the trip) fall back to the load's current truck — noted in §2.5.
- **Archived loads work.** The route uses `findLoadAnywhere` / `findPoAnywhere`; §48 archives the load and reads its evidence (200, both trips, both sets of visits); an unknown id is 404.
- **Trips on one load are not mixed.** Each trip gets its own window on its own truck. During this review a real overlap was found and fixed: the 30-minute pad after trip 1's completion reached into trip 2 on the same truck, so a yard visit that belonged to trip 2 was also listed under trip 1. Windows are now clipped at the previous trip's completion and the next trip's start (§2.1; new §48 check "back-to-back trips on Truck #12").
- **Out-of-order delivery cannot corrupt visit history.** Visits are keyed by (tracker, geofence, enterDateTime): an EXIT arriving first inserts the completed row; the late ENTER is a duplicate and erases nothing (§48 "out of order"). Positions never move the latest fix backwards. Stops/trips/usage are keyed by (tracker, start).

### 1.6 Board

- VBT's state (`bucket`, `stage`, driver `state`, truck `state`) is computed without reading telemetry (`boardBucket` and `boardLoadRow` contain no telematics reference). Linxup arrives as a separate `telematics` object on the same row.
- On screen it is a second line under VBT's line, with its own dot and source label ("Linxup GPS n ago"), so a truck reads "AWAITING APPROVAL … Linxup At Clovis Unified SD · Fresno · 1 min ago", or "In progress … Stopped". The example in §4 shows exactly this.
- The driver row carries the Linxup line only while the driver is actually on a truck (a load's truck or an open shift's); a driver marked Done shows "(usual)" and no telemetry, by L1 design. The truck chip always carries it.

### 1.7 Performance

- The board loop runs the evidence engine only for loads that hold resources today **and** have an open trip **and** whose truck is linked (`/api/today`, "L2: evidence flags"). Completed and archived loads are never queried by the board.
- Per qualifying load, `linxup.window()` runs five indexed range queries (visits, stops, trips, usage, positions capped at 5,000 rows) on the open trip's window only. With five trucks that is at most 25 small queries per board fetch, and the board fetches only when its fingerprint changes.
- Full history lives on Load Details (`GET /api/loads/:id/telemetry`), opened on demand.

### 1.8 Security

- **Authentication.** Bearer token from `Authorization` or `Authentication`, compared in constant time (SHA-256 + `timingSafeEqual`) against `LINXUP_WEBHOOK_TOKEN` and, during rotation, `LINXUP_WEBHOOK_TOKEN_NEXT`. No token configured → the path answers 404 and the integration is off. Wrong token → 401, counted, never explained (e2e §47).
- **Company isolation.** Every message's `company.companyId` must equal `LINXUP_COMPANY_ID`; otherwise 403 and nothing stored (§47). See §2.6 for the "unset" case.
- **Malformed payloads.** Missing tracker, bad dates, coordinates out of range, unrecognisable shape → 400, nothing stored (§47, §48); bodies over 2 MB → 413; unknown type → 404.
- **Outside sessions.** The route has no `reqAuth`/`reqMgr`; the session middleware runs but stores nothing (`saveUninitialized: false`); the route is exempt from the write lock and from the store-locked guard so it answers even when the dispatch store is unavailable.
- **No cross-company injection.** The company check is the gate; a valid token with another company's id is refused; the reads (`/api/linxup/*` and `/api/loads/:id/telemetry`) require a manager session.

### 1.9 Retention

The implementation (`linxup.js` constants and `prune()`, run at boot and every 24 h):

| Data | Retention |
|---|---|
| Positions | raw 30 days → one per 5 min per tracker to 365 days → dropped |
| Latest position, trackers, geofences | kept |
| Geofence visits, stops, vehicle trips, usage | kept indefinitely (no pruning) |
| Webhook log | 30 days (Position entries 7 days) |
| Alerts, geofence changes, media | raw body in the webhook log only → gone after 30 days |

The table in `LINXUP-INTEGRATION.md` was out of date (older table names, "7 days" for the log, "12 months" for stops, alert/media tables that do not exist yet); it now matches the code. Raw positions cannot grow without bound (asserted by §47 "retention"). Alerts are the one evidence type not retained beyond 30 days — they are an L3 item (§6).

### 1.10 Testing

All four suites run after the review's changes; results in §5. No test was removed or weakened; §48 gained one check.

---

## 2. Bugs and risks

### 2.1 Fixed in this review — evidence window overlap on back-to-back trips (correctness)
The ±30-minute pad let a Linxup event just after trip 1's completion also appear under trip 1 when it belonged to trip 2 on the same truck. Windows are now clipped at the neighbouring trips (`server.js`, `loadTelemetryEvidence`), tested in §48 and both modes.

### 2.2 Fixed in this review — retention documentation drift (documentation)
See §1.9. Code unchanged.

### 2.3 Risk — `LINXUP_COMPANY_ID` is optional
If the variable is unset, the company check is skipped and the token alone gates the endpoint. The token is per account so this is not an open door, but it removes one layer. Recommendation: treat the variable as required in production (refuse to enable, or log loudly at boot). Not changed here.

### 2.4 Decision needed before L3 — name-matched fences as evidence
Evidence uses an exact name match when no mapping is saved, labelled "matched by name". For a person reading Load Details this is useful and honest; for L3 it must not count. Recommendation: any automation requires `vendor.linxupGeofenceId` (a saved mapping), and the name match stays a suggestion.

### 2.5 Note — trips older than Phase 0
A trip without `truckUnitId` (started before the C7 stamping) is attributed to the load's *current* truck. Only historical loads are affected; new trips are stamped.

### 2.6 Note — batch semantics
An array payload is processed item by item. A persistence failure part-way returns 503 after storing the earlier items; because every store is idempotent, Linxup's retry of the batch is harmless (earlier items become duplicates). A wrong-company item part-way returns 403 for the batch and the later items are not processed. Both are safe; both are worth knowing.

### 2.7 Hardening — size check after parsing
The 2 MB limit is checked against `Content-Length` after Express has already parsed the body under the app-wide 25 MB limit. A per-route body limit would be cleaner. Not a data risk.

### 2.8 Hardening — implausible timestamps on L2 messages
Positions reject fixes more than 7 days in the future; Geofence Events, Stops, Trips and Usage do not. A far-future `enterDateTime` would sit as a truck's "Last geofence" until a newer one arrives. Evidence only; no VBT record is affected. L3 must apply plausibility filters before acting on any timestamp.

### 2.9 Observation outside Linxup
A submitted (awaiting approval) load card reads "Approved and locked — assignment can no longer change." because VBT locks a load at submission. The lock is right; the wording predates approval-vs-submitted and could say "Submitted and locked". Not touched.

---

## 3. Assumptions still to confirm with Linxup

From the analysis document's table (numbers as there):

| # | Question | Why it matters now |
|---|---|---|
| 2, 3 | Does Linxup retry a 503, and how? | Without retries, a database outage loses the messages sent during it. VBT answers 503 correctly either way. |
| 4, 7 | Is order guaranteed? Can messages repeat? | Assumed no / yes; the code is safe under both, so this only matters for expectations. |
| 8, 9 | Pull API for the tracker list; historical backfill | Today a tracker exists in VBT once any message names it; there is no gap-filling. |
| 10, 11 | Odometer and fuel units | Displayed as received. L3 utilization reporting needs the units. |
| 13, 14 | Source IP ranges; HMAC signing | Would add a second gate to the bearer token. |
| 15 | API to manage geofences | Today fences are created in Linxup's UI and learned from events. |
| 17 | Are Positions sent while stopped / engine off? | Drives the Stale vs Stopped rule on the board. |
| 22 | Does FENCE_EXIT carry its own ENTER's `enterDateTime`? | The visit key depends on it; a mismatch leaves an open ENTER and a separate EXIT row (visible, not merged). |
| 23 | Are Stop / Trip / Usage sent once, at close? | Keyed by start; a later delivery with a later end updates the row. |
| 24 | Duration units; `startDate` vs `startDateTime` on Usage | Read as minutes; both field names accepted. |
| 25 | Are Trip start/end fences always populated? | Used as labels only. |

---

## 4. One realistic load: what VBT says vs what the truck says

Run on the test build in real time (the driver's taps minutes apart, the
tracker's messages posted with their own timestamps). Times are Pacific.

**The VBT record (the operational truth).** PO 10517, Clovis Unified SD,
3/4 Rock, 1 load. Assigned driver Beryle, assigned Truck #2, planned pickup
yard Vulcan, jobsite 2400 N Clovis Ave, Fresno (pinned on the PO).

| VBT tap (driver's phone) | Time | Recorded with |
|---|---|---|
| Start trip | 2:11:29 PM | phone GPS 36.7290, −119.6650 |
| Arrived at pickup — Vulcan (actual yard = Vulcan) | 2:13:59 PM | phone GPS at the yard |
| Loaded — ticket VM-448211, 24.6 t | 2:15:29 PM | ticket typed and confirmed by Beryle |
| Arrived at jobsite | 2:18:59 PM | phone GPS at the site |
| Trip complete | 2:20:00 PM | phone GPS at the site |
| Delivered, signed by R. Ortega (site super) | 2:20 PM | signature |

Load status afterwards: 1/1 delivered, **awaiting approval**, locked for the
driver. Nothing in this row was written by Linxup.

**The Linxup record (the truck's own evidence).** Tracker 701 "VBT #2",
linked to Truck #2 by id; Linxup's person 88 "Beryle Guzman" is mapped to
Beryle; geofence 9 "Vulcan Materials - Sanger" is mapped to the Vulcan yard.

| Linxup message | Says | Time |
|---|---|---|
| Usage Hours | engine on, 10 min | 2:10:29 – 2:20:39 PM |
| Position × 3 | approaching the yard at 34 → 28 mph | 2:10 – 2:12 PM |
| Geofence Event ENTER | entered Vulcan Materials - Sanger | 2:13:29 PM |
| Stop | idling 2 min inside the fence, 11500 E Jensen Ave, Sanger | 2:13:59 PM |
| Geofence Event EXIT | left the fence, 3 min inside | 2:16:29 PM |
| Trip (Linxup vehicle trip) | ignition cycle from the fence to 2400 N Clovis Ave, 4.6 mi, all authorized | 2:16:29 – 2:18:41 PM |
| Position | first fix within 300 m of the PO's jobsite pin | 2:18:39 PM |
| Stop | engine off 2 min at 2400 N Clovis Ave | 2:18:44 – 2:20:49 PM |
| Position × 2 | parked, engine off | 2:19 – 2:20 PM |

**Side by side, as Load Details shows it** (every line names its source):

| Moment | What VBT says happened | What the truck says happened | Gap |
|---|---|---|---|
| Pickup | Driver tapped Arrived at Vulcan at 2:13:59 PM | Entered the Vulcan fence 2:13:29 PM, idled 2 min, left 2:16:29 PM (3 min inside) | tap 30 s after entry |
| Loading | Driver tapped Loaded at 2:15:29 PM, ticket 24.6 t | Truck was inside the fence from 2:13:29 to 2:16:29 PM | consistent |
| Haul | (no tap) | Vehicle trip 2:16:29 → 2:18:41 PM, 4.6 mi | — |
| Jobsite | Driver tapped Arrived at jobsite at 2:18:59 PM | "Near jobsite based on GPS" first at 2:18:39 PM; engine off at the site from 2:18:44 PM | tap 20 s after first fix |
| Completion | Driver tapped Trip complete at 2:20:00 PM; delivered, signed | Parked, engine off; last fix near the jobsite 2:20:39 PM | consistent |
| Driver | Beryle | Linxup driver: Beryle Guzman (mapped to Beryle) | no mismatch |
| Truck | Truck #2 | tracker VBT #2, VIN as linked | no mismatch |

Flags raised: none. Board: the load card reads **AWAITING APPROVAL** (VBT)
with, beside it, **Linxup · At Clovis Unified SD · Fresno · 1 min ago**; the
Truck #2 chip reads **available · AT CLOVIS UNIFIED SD · FRESNO**. The
approval dialog shows the five VBT checks and one line of Linxup evidence:
"Trip 1: Vulcan 2:13 PM–2:16 PM (geofence) · near jobsite 2:18 PM–2:20 PM
(GPS)". Approving remains a person's click.

What would have changed if the stories disagreed: nothing on the load. Had
Beryle tapped Arrived at CEMEX, the section would read "Pickup — CEMEX · no
Linxup activity there", list the Vulcan visit under "also in", and raise
"⚠ Pickup telemetry mismatch — trip 1: …" on the load and the board's
Telemetry tile; VBT's yard choice (and therefore costing) would stand until a
person changed it.

---

## 5. Test results after the review

| Suite | Result |
|---|---|
| API, file mode (`bash test-e2e.sh`) | 682 passed, 0 failed |
| API, Postgres (`./test-pg-local.sh`, same scenario on the `linxup_*` tables) | 775 passed, 0 failed |
| Browser (`node test-browser.js`) | 168 passed, 0 failed |
| Five-truck scenario day (`npm run test:scenario`) | 44 passed, 0 failed |

No existing test was removed or relaxed. §48 gained "back-to-back trips on
Truck #12" (file and Postgres).

---

## 6. What L3 should eventually contain — a recommendation, not an implementation

Principles first: every automation is a **separate, individually enabled
rule**; each one requires a **saved geofence mapping** (never a name match);
each one records **"by telemetry"** with the evidence it used and the person
who enabled the rule; each one has a **kill switch** and runs in **shadow
mode** ("would have …") on the board for at least two weeks before it can be
turned on; and none of them ever touches approval, billing, QuickBooks,
driver or truck assignment, or the pickup yard and jobsite that a person set.

Candidates, in the order they earn trust:

1. **Alerts as episodes.** Store alerts in `linxup_alerts` (today they die with the webhook log after 30 days), roll one-per-minute speeding into episodes, show them on the truck and in Load Details, with acknowledge. No status effect.
2. **Utilization report.** Engine hours per truck per day/week (Usage Hours), idle share (Stops), Linxup miles vs VBT odometer legs per shift, fuel trend once units are confirmed. Read-only.
3. **Attention at approval.** When a load carries a pickup / jobsite / driver / tracker flag, the approval dialog requires the acknowledgement the checklist already supports, and the reason is written to the audit log. A person still approves.
4. **Suggested taps on the driver's phone.** When the truck has been inside the mapped pickup fence for N minutes and the driver has not tapped Arrived, the phone shows "Linxup sees you at Vulcan since 7:42 — tap Arrived?" The driver taps; VBT stamps the driver's tap, and records that it was suggested. This is the only "automatic Arrived at Yard" I would design first, because the driver remains the author.
5. **Telemetry-stamped secondary times.** Alongside each VBT tap keep a read-only `telemetry` companion (fence entry, first fix near the jobsite) for reports and disputes, never overwriting the tap.
6. **Unattended-stop reminders.** A truck engine-off away from any yard, jobsite or pin for more than N minutes while a trip is open → attention item, nothing else.

Explicitly not recommended, even for L3: automatic Loaded (the ticket is the
proof), automatic trip or load completion, automatic driver or truck
assignment, automatic approval or Ready to Bill, any billing change from
telemetry.

Prerequisites before any of 3–6 is switched on: Linxup answers to §3 items
2/3, 17 and 22–24; every yard the fleet uses has a saved fence mapping and a
pin; two weeks of live L2 data reviewed against the drivers' taps.
