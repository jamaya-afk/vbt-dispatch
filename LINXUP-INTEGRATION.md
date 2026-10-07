# Linxup Push API V3 × VBT Dispatch — analysis and architecture proposal

Status: **L0, L1 and L2 implemented** (`linxup.js`, the `/api/linxup/*`
routes, the `linxup_*` tables, the link screens, the board and map lines; the
L2 evidence: geofence visits, stops, vehicle trips and usage hours stored and
correlated to VBT loads read-only, `GET /api/loads/:id/telemetry`, the
LINXUP TELEMETRY section on Load Details, the evidence line on the approval
dialog, the yard ↔ geofence mapping on Vendors; e2e §47/§48, the Postgres run
in §21 and the browser suite cover them). **L3 remains a proposal and nothing
telemetry-driven changes a VBT record.** Written from the
Linxup Push API V3 message documentation and from the VBT code as it stands
after Phase 1; the open questions in the "Assumptions" section below are
still to be confirmed with Linxup before go-live.

One sentence: **Linxup tells us where the trucks are and what the engines are
doing; VBT decides what the work is, who is doing it, whether it is done, and
what to bill.** Telemetry is evidence attached to VBT records, never the
record itself.

---

## A. What Push API V3 can provide VBT

| Message | Fires | What VBT gets out of it |
|---|---|---|
| **Position** | every new fix; ~1/min while moving, fewer when parked | The live truck: lat/lng, address, speed, heading (N/NE/…) and degrees, altitude, **odometer**, **engineOn**, battery (device-dependent string), **fuelLevel** (string), accuracy and signal (strings), estimated speed limit + speeding flag, behavior code, the **geofence the truck is currently inside**, current **person** (driver) if Linxup knows one, asset (VIN/make/model/year), fleet, company. `batchedPositions` carries sub-second breadcrumbs between fixes. |
| **Geofence Event** | on FENCE_ENTER / FENCE_EXIT | Which tracker entered/left which geofence, when; on exit also the duration. This is the "truck arrived at Vulcan / left the yard" signal. |
| **Trip** | when the ignition goes off | One ignition-on→off cycle: start/end time, start/end lat/lng + address, distance, authorized/unauthorized miles, duration, start/end geofence, tracker, person, asset. |
| **Stop** | when a stop ends | Idling (engine on, not moving) or engine-off stop: where, start/end, duration, geofence if inside one. |
| **Usage Hours** | when a usage period ends | A period of asset usage with `engineOn` true/false and duration, start/end place. The building block for engine hours and utilization. |
| **Alert** | when Linxup raises an alert | `alertId`, code, descriptions, time, location, tracker, person, geofence. Speeding, harsh events, geofence alerts, maintenance alerts — whatever the account has configured. |
| **Device Status** | ACTIVATE / INACTIVATE | A tracker came online or was retired. |
| **Device Update** | rename, fleet move, driver assignment change | The tracker mirror changes: name, fleet, person, asset. |
| **Geofence Change** | CREATE / UPDATE / DELETE | The geofence itself: name, group, type (Landmark / Polygon / Circle), radius, points, who it notifies. Lets VBT keep a mirror of Linxup's geofences without a pull API. VBT interprets these (OA5): CREATE/UPDATE refresh the mirrored name and group; DELETE marks the geofence deleted, so a yard still mapped to it is named stale on Vendors and on the board — the mapping itself is never rewritten. |
| **Media** | dashcam clip or thumbnail uploaded | URLs for inside/outside/aux video and thumbnails, `mediaId`, timestamp. |
| Item Tracking (Location / Left Behind) | tool trackers | Not relevant to dump-truck dispatch; ignore (accept and drop). |

Everything is push. Once the receiver is up, VBT never needs to poll Linxup
for any of the above.

## B. What it cannot provide (based on this documentation alone)

These are gaps in the *document*, not necessarily in Linxup. Section N lists
what to ask for.

1. **No message identifiers on most messages.** Only Alert (`alertId`), Media
   (`mediaId`) and geofences (`geofenceId`) carry an id. Position, Geofence
   Event, Trip, Stop, Usage Hours, Device Status/Update have none. Dedupe must
   be by natural key (§F).
2. **No message-type field in the payload.** Nothing in a Position says "I am
   a Position". Either Linxup lets us register one URL per message type, or
   there is a header the document does not mention. VBT must not guess from
   field shape alone (§E has a fallback, but it is a fallback).
3. **No delivery contract described**: retry policy, ordering guarantees,
   timeouts, whether payloads can be arrays, expected response codes, the
   exact authentication header name (the request said "bearer token in the
   Authentication header"; the standard header is `Authorization`), whether
   requests are signed, source IP ranges. A dropped webhook is simply gone
   unless Linxup retries.
4. **No pull/REST API in this document**: no way to list trackers, assets,
   drivers or geofences for the initial linking screen, no "current position"
   for a cold start after a deploy, no history backfill after downtime, no
   geofence creation. If Linxup has a REST API (it does have one commercially),
   VBT needs those docs; otherwise linking is done by hand from the Position
   messages that arrive.
5. **Fuel:** `fuelLevel` is a string with no documented unit (percent?
   gallons? raw sensor?) and is device-dependent. There is **no fuel
   transaction or fuel consumption message**. The Fuel Consumption report in
   the Linxup UI is a separate product feature; it is not in Push API V3.
6. **Odometer** has no documented unit or source (vehicle bus vs GPS-derived);
   `accuracy`, `signal` and `battery` are free-form strings.
7. **Driver identity is a hint, not a fact.** `person` is whatever Linxup has
   associated with the tracker (driver ID fob, app login, or a manual
   assignment made months ago). Nothing here says how it is set or how fresh it
   is.
8. **A Linxup "trip" is an ignition cycle**, not a haul. A VBT trip
   (yard → jobsite → done) can span several ignition cycles, and one ignition
   cycle can cover two hauls. They can be correlated by time and truck, never
   equated.
9. **Media carries no link to its alert or tracker** in the payload shown,
   although the text says each media event is tied to an alert. Without an
   `alertId` in the message, VBT can store the clip but cannot say which truck
   or event it belongs to.
10. **Inconsistent field names across messages**: `tracker.trackerId` vs
    `tracker.id` (Alert, Item Tracking), `person.personId` vs `person.id`,
    `company.companyId` vs `company.id`, `street_2` vs `street2`,
    `behaviourCode` vs `behaviorCode`, Usage Hours `startDate`/`endDate` where
    the prose says `startDateTime`. The receiver needs one normalizer.
11. **Nothing about the dump body, PTO, scale weight or ticket** — sensorData
    is unspecified. Ticket tons stay a VBT/driver fact.
12. **Geofence events may fire only for fences configured to notify** (the
    `notification` block on Geofence Change). Whether an un-configured fence
    still produces FENCE_ENTER is not stated.

## C. Recommended VBT ↔ Linxup architecture

```
Linxup cloud
   │  HTTPS POST, bearer token, one URL per message type
   ▼
VBT  /api/linxup/<type>            (server only; the browser never sees Linxup)
   │  1. authenticate  (constant-time token compare, company id check)
   │  2. validate      (shape, ranges, normalize field names)
   │  3. dedupe        (natural key / id, ON CONFLICT DO NOTHING)
   │  4. persist       (dedicated Postgres tables — NOT the JSON store)
   │  5. cache         (latest position per tracker in memory)
   │  6. derive        (place visits, attribution to the VBT load on that truck)
   │  7. ack 200
   ▼
VBT reads                          /api/today · /api/fleet/live · load detail · approvals
```

Design rules that follow from how VBT is built today:

- **Telemetry never enters the JSON store.** The store is one Postgres row
  rewritten on every save, behind a write lock, with rollback on failure
  (Phase 1.6). Thousands of positions a day would turn every save into a
  multi-megabyte write and a rollback would erase telemetry. Telemetry goes
  into its own tables, exactly like `driver_locations` already does for phone
  GPS. The only things written to the store are the **links**: a truck's
  tracker id, a vendor's or PO's geofence id — set by a person on a settings
  screen, saved once.
- **Webhook routes are exempt from the write lock** (like `/api/driver-location`
  and the QuickBooks routes) and do not use sessions or CSRF; they run inside
  the same single Node process. If VBT's database is down they answer 503 so
  Linxup can retry (if it does).
- **Attribution happens at read time and at event time, using VBT truth.**
  Tracker → VBT truck (by stored `trackerId`). Truck → load: the load that
  holds that truck at that moment (`loadHoldsResources` + `truckUnitId`, same
  day), and its open trip. Linxup's `person` is displayed as "Linxup says",
  never used to assign.
- **Automation is opt-in and explicit.** Nothing derived from GPS changes a
  VBT status by default. The only proposed automatic transitions are listed
  in §H and are off until the owner turns them on.
- **Phone GPS becomes the fallback**, not the primary. The existing
  `/api/driver-location` path, `driver_locations` table and Fleet Map keep
  working; a truck with a live Linxup position shows that instead.

## D. Recommended database fields and mappings

### In the JSON store (small, set by people)

`store.trucks[]` (already: id, truckNum, type, status, defaultDriverId, mileage, active):

```json
"linxup": {
  "trackerId": 12000030266,          // primary link — the stable id
  "deviceNumber": "IMEI…",           // verifies the physical device
  "deviceSerialNumber": "…",
  "vin": "1FUJ…",                    // verifies the vehicle the device is in
  "asset": { "make": "…", "model": "…", "year": 2019, "licensePlate": "…" },
  "fleetId": 8000003335, "companyId": 1,
  "linkedAt": "…", "linkedBy": "joshua",
  "lastName": "Truck 2 – Kenworth",   // Linxup's name at last sight (display only)
  "mismatch": null                    // set by Device Update when VIN/IMEI stop matching (see §G)
}
```

`store.drivers[]`: `linxupPersonId` (optional; only to show "Linxup thinks
Rigo is in this truck" and to flag disagreement).

`store.vendors[]` and `store.pos[]`: `linxupGeofenceId` next to the existing
`geo` pin. `store.settings.linxup = { companyId, yardGeofenceId }`.

### Dedicated Postgres tables (written by webhooks, read by VBT)

As implemented through L2 (names and retention are the code's, `linxup.js`;
the nightly `prune()` runs at boot and every 24 h):

| Table | Key | Purpose / retention |
|---|---|---|
| `linxup_trackers` | `tracker_id` PK | Mirror of every tracker Linxup has told us about: name, IMEI, serial, VIN, make/model/year, fleet, company, person_id/name, active, status_changed_at, first_seen, last_message. Feeds the "link a tracker" picker. Kept. |
| `linxup_latest_positions` | `tracker_id` PK | One row per tracker, moved only by a newer fix. Also mirrored in memory. What the board and the map read. |
| `linxup_positions` | (`tracker_id`, `at`) PK | History. Raw 30 days; thinned to one row per 5 min per tracker from 30 to 365 days; dropped after. Index on (at). |
| `linxup_geofences` | `geofence_id` PK | Learned from Geofence Events, Stops and Trips (id, name, group); the VBT mapping itself lives on the vendor (`linxupGeofenceId`). Kept. |
| `linxup_geofence_events` | (`tracker_id`, `geofence_id`, `entered_at`) PK | One row per visit: left_at, duration_min, fence name/group, person, VIN, fleet. ENTER and EXIT complete the same row in either order. Kept indefinitely — this is the evidence. Jobsite proximity is **derived at read time** from positions against the PO pin and is not stored. |
| `linxup_vehicle_trips` | (`tracker_id`, `start_at`) PK | Linxup vehicle trips (ignition cycles): end, start/end lat/lng/address, distance, authorized/unauthorized mi, duration, start/end fence, person, VIN. Kept. |
| `linxup_stops` | (`tracker_id`, `start_at`) PK | Idle / engine-off stops with duration, place, address, fence. Kept. |
| `linxup_usage` | (`tracker_id`, `start_at`) PK | Usage periods with engine_on and duration. Kept. |
| `linxup_webhook_log` | id | Every received message: type, received_at, http status we returned, payload sha1, tracker_id, outcome, note; the raw body for Device Status/Update and for deferred types (alert, geofence-change, media). Kept 30 days (Position entries 7 days). |

Not yet tables (L3): alerts and media exist only as raw bodies in
`linxup_webhook_log`, so they are lost after 30 days until L3 stores them.
Load attribution is never stored on a telemetry row; it is computed when a
load is read, by truck and time, so a later reassignment or a corrected trip
never leaves stale attribution behind.

All timestamps are `TIMESTAMPTZ` converted from Linxup's epoch milliseconds;
"day" grouping uses `OPERATING_TZ`, as everything else in VBT does.

## E. Recommended webhook endpoints

One URL per message type, registered in Linxup:

```
POST /api/linxup/position
POST /api/linxup/geofence-event
POST /api/linxup/trip
POST /api/linxup/stop
POST /api/linxup/usage-hours
POST /api/linxup/alert
POST /api/linxup/device-status
POST /api/linxup/device-update
POST /api/linxup/geofence-change
POST /api/linxup/media
POST /api/linxup/item-location, /item-left-behind   → accepted and dropped (200)
```

If Linxup turns out to allow only one URL, the same handler accepts
`POST /api/linxup/event` and classifies by shape in this order: `alertId` →
alert; `statusChangeType` → device-status; `eventType` → geofence-event;
`stopType` → stop; `distanceMiles` → trip; `mediaId` → media;
`geofenceId` + `action` → geofence-change; `engineOn` + `durationMinutes` +
`startDate` → usage-hours; `date` + `latitude` + `odometer` → position;
`tracker` + `asset` only → device-update. Anything else is logged as
`unknown` and answered 200 (so Linxup does not retry forever).

Responses: `200 {ok:true}` stored or duplicate; `401` bad/missing token (no
body detail); `400` unparseable or out-of-range payload (logged, not
retried); `503` VBT's database is down (Linxup may retry). The handler must
answer within a few seconds: persist, then derive; anything slow (attribution
to loads, place derivation) happens after the row is written.

VBT-side (session-protected, manager only), for the screens:

```
GET  /api/linxup/trackers                 mirror list + link state, for the picker
PUT  /api/fleet/trucks/:id/linxup         { trackerId } | { trackerId: null }   link / unlink
PUT  /api/vendors/:id/geofence            { geofenceId }        (and /api/pos/:id/geofence)
GET  /api/fleet/telematics                latest per truck with VBT attribution (feeds board + map)
GET  /api/loads/:id/telemetry             visits, vehicle trips, stops during the load's window
GET  /api/linxup/health                   last message per type, auth failures, dedupes, unknown trackers
```

## F. Event and idempotency strategy

Linxup may deliver a message twice, late, or out of order. Every table has a
key that makes the second delivery a no-op, and the receiver treats
"duplicate" as success.

| Message | Dedupe key | Rule |
|---|---|---|
| Position | (`tracker_id`, `date`) | History: `INSERT … ON CONFLICT DO NOTHING`. Latest: update **only if** `date` is newer than the stored one (an old fix arriving late never moves the truck backwards). `editDate` is ignored for identity. |
| Geofence Event | (`tracker_id`, `geofence_id`, `enterDateTime`) | ENTER inserts the visit (left_at null). EXIT **updates the same row** with `exitDateTime`/`durationMinutes` (matching on the enter time); an EXIT whose ENTER never arrived inserts a row with entered_at = enterDateTime from the payload. Two rows are never created for one visit. |
| Trip | (`tracker_id`, `startDateTime`) | Insert; if the same key arrives with a different end (revised trip), update end fields. |
| Stop | (`tracker_id`, `startDateTime`) | Insert or ignore. |
| Usage Hours | (`tracker_id`, `startDate`) | Insert or ignore. |
| Alert | `alertId` | Insert or ignore. |
| Media | `mediaId` | Insert or ignore. |
| Device Status / Update | `tracker_id` upsert | Last received wins for the mirror; every change appended to `linxup_webhook_log` so a rename or driver change is visible in order. |
| Geofence Change | `geofence_id` upsert | CREATE/UPDATE upsert the mirror; DELETE sets `deleted_at` (never removes the row: past visits still reference it). |

Every accepted message also writes one `linxup_webhook_log` row with the
payload's sha1; two identical bodies inside 24 h are recorded as `duplicate`.
Derived records (place visits from positions, attribution to a load) are
computed from stored rows, so re-deriving is safe and repeatable.

## G. Truck / driver / tracker mapping strategy

- **Link by `trackerId`, verify by `deviceNumber` (IMEI) and `vin`.** Names
  are display only and refreshed from every message.
- **Linking is a human action** on Drivers & Trucks: the truck card shows a
  "Linxup tracker" picker listing `linxup_trackers` (name, IMEI, VIN, last
  seen); unlinked trackers with recent positions are highlighted "not linked to
  any VBT truck". One tracker → one truck; the server refuses a second truck.
- **Device Update handling** (nothing silent):
  - name changed → update the mirror and the truck's `linxup.lastName`; the
    board never used the name for identity, so nothing breaks.
  - fleet changed → update the mirror; no operational effect.
  - `person` changed → update the mirror's current driver; the board shows
    "Linxup: Rigo" next to VBT's assigned driver; if they differ, an
    informational flag on that truck's row ("VBT has Beryle on Truck #2;
    Linxup reports Rigo"). No reassignment.
  - `asset.vin` or `deviceNumber` no longer match the truck's stored link →
    set `linxup.mismatch = { vin, deviceNumber, at }` and raise an attention
    item "Tracker on Truck #2 now reports VIN …; was it moved to another
    truck?" Positions from that tracker are still stored but shown as
    "unverified" on the board until a manager re-links or confirms.
- **Device Status INACTIVATE** → truck shows "tracker inactive since …"; the
  link is kept (history must still resolve); ACTIVATE clears it.
- **Unknown tracker** (never linked) → stored in the mirror and shown in the
  picker; its positions are kept (they resolve once linked) but never
  attributed to a load.
- `companyId` on every message must equal the configured company; anything
  else is rejected and counted.
- `fleetId` is stored for information; VBT has one fleet.

## H. Geofence integration strategy

Two sources feed one `linxup_place_visits` table:

1. **Linxup geofences for permanent places** — the VBT yard and the regular
   supplier plants (Vulcan, Teichert, Granite, CEMEX, Keith Farms). Created
   once in the Linxup UI; VBT mirrors them from Geofence Change and a manager
   maps each to a vendor (or to "VBT yard") by id, on the vendor card next to
   the existing "Set location" pin. FENCE_ENTER/EXIT become visits with
   `source = linxup`.
2. **VBT-derived visits for jobsites** — a PO's jobsite already has a saved
   pin (`pos[].geo`, Phase 0). Creating a Linxup geofence for every PO is not
   available through this API, so VBT derives arrival/departure itself from
   Position messages: inside when within a radius (300 m default, per-PO
   override) for two consecutive fixes, outside when beyond it for two fixes.
   `source = derived`. The same rule can back up a vendor visit if Linxup's
   fence event never arrives.

Attribution at event time: tracker → truck → the load holding that truck
today → its open trip. The visit is stored with `load_id`/`trip_number`, and
the load detail and approval screens show it as **vehicle evidence next to the
driver's taps**:

```
Trip 2   Driver tapped: Arrived at yard 09:58 · Loaded 10:11 · Arrived jobsite 10:47 · Done 10:55
         Truck #2:      In Vulcan 09:56–10:13 (17 min) · At 9 Gate Rd 10:45–10:56 (11 min)
```

Discrepancy flags (informational, on the approval checklist's Pickup yard and
Delivery rows): "no vehicle visit to Vulcan recorded for trip 2", "truck was
at Teichert, not Vulcan" (actual-yard costing is at stake), "delivered while
the truck never left the yard". They do not block approval; the manager
decides, as with any ⚠ item today.

**What is never automatic:** Completed, Submitted, Approved, Ready to Bill,
Billed, reassignments, ticket facts.

**Explicit, opt-in automations to consider later** (each a named setting,
default off, each writing "by telemetry" on the stamp it sets):
- A1: stamp `arrivedPickup` on the open trip when the truck enters the trip's
  planned yard and the driver has not tapped within 3 minutes.
- A2: stamp `arrivedJobsite` the same way at the PO's pin.
- A3: set `actualYardId` from the fence the truck actually loaded in when it
  differs from the plan — shown as a suggestion to the dispatcher first, not
  applied silently, because it changes vendor cost.

### Limitation: VBT learns about a fence only from what Linxup sends

The mirror of Linxup's geofences is built from the messages VBT receives:
Geofence Events, Stops and Trips name a fence (id, name, group), and Geofence
Change messages (CREATE / UPDATE / DELETE) refresh or retire it. There is no
polling of Linxup. So:

- A **renamed** fence is learned from the next message that names it.
- A **deleted** fence is known deleted only if Linxup is configured to send
  Geofence Change messages. If it is not, the deleted fence simply stops
  producing events: VBT's mapping stays as it was and never produces evidence
  again, and nothing in VBT can tell "deleted" from "no truck has been there".
- VBT therefore never assumes a mapping is current because a geofence id is
  on the yard. When the mirror knows the fence is gone (or has never heard of
  it), the mapping is named **stale** on `/api/linxup/geofences`, on the board
  (attention) and on the yard's Vendors panel; mapping a yard to a deleted
  fence is refused. When the mirror does not know, the only signals are a yard
  whose evidence reads "no visit" trip after trip — a person checks the fence
  in Linxup and remaps.
- None of this is a synchronization guarantee, and none of it rewrites a VBT
  yard: the mapping is a person's to change.

## I. Position storage and retention strategy

Volume, honestly: 5 trucks × ~10 hours × 60 fixes ≈ **3,000 positions a day**,
~90,000 a month, a few hundred bytes each. Postgres does not notice. The
design still keeps only what dispatch and disputes need:

- **Latest**: one row per tracker (`linxup_position_latest`) plus an in-memory
  map, updated only by newer fixes. This is what the board and the map read;
  they never scan history.
- **Recent history**: raw rows for 30 days — enough for "where was Truck #2 at
  2:10 pm last Tuesday" and for drawing a load's route on the map.
- **Long history**: after 30 days, thin to one row per 5 minutes per tracker
  (a nightly job, same pattern as `pruneLocationHistory`); delete after 12
  months. Visits, trips, stops and usage periods are small and stay.
- `batchedPositions` sub-points are **not stored** (they are the breadcrumbs
  between fixes; the minute-level track is plenty for dispatch). Revisit only
  if route drawing needs them.
- Positions with `accuracy` clearly bad or lat/lng out of range are logged and
  dropped; a fix that would move the truck faster than 120 mph from the last
  one is stored in history but flagged and not applied to Latest.
- Query paths: latest (by tracker) → PK; route for a load → (tracker_id, at)
  range inside the load's trip window; visits → by load_id index.

## J. How this appears on the VBT dispatch board

The board already has one row per driver and a chip per truck, all served by
`/api/today`. Telemetry adds one line under each and a status dot, from
`/api/fleet/telematics`; the VBT stage stays where it is. Concept:

```
TRUCK #2 · Beryle                ● Moving · 34 mph · engine on · GPS 20 s ago
  Load PO-1234 / 2 of 3 · Vulcan → Gate Rd Builders, Fresno
  VBT: Loaded / en route (tapped 10:11)   Truck: left Vulcan 10:13, on Hwy 41 N
TRUCK #12 · Leonardo             ● At jobsite (9 Gate Rd) · engine on 6 min · GPS 40 s ago
  Load PO-1234 / 3 of 3
TRUCK #14 · Carlos               ● Available · at Valley Best yard · engine off since 15:02
TRUCK #4  · Matthew              ● Stale · last GPS 2 h ago (tracker inactive since 09/28)
TRUCK #2B                        ○ Not linked to a Linxup tracker
```

Status vocabulary, derived on the server from Latest (one rule, like
`boardBucket`): **Moving** (engine on, speed > 3 mph) · **Idling** (engine
on, speed 0 for 3+ min) · **Stopped** (engine off) · **At <place>** (inside a
mapped geofence or within a VBT pin — takes precedence over Idling/Stopped) ·
**Stale** (no fix for 10+ min while the day is open) · **Offline** (tracker
inactive or silent 24 h) · **Not linked**. The Fleet Map uses the same rows,
so the list, the map and the board never disagree. The attention row gets one
new tile only when something needs a person: "Telemetry disagrees" (stale
truck on an open load, VBT/Linxup driver mismatch, tracker moved). No new
screens for Phase L1.

## K. What remains completely inside VBT

Customers, POs, loads, assignments (driver, truck, trailer), pickup yard
choice and actual-yard costing, jobsite, load and trip status, the driver's
taps and their timestamps, tickets and tons, signatures, approval and its
checklist, Ready to Bill, billing batches, QuickBooks, vendor bills, audit
log, archive. Also: which tracker belongs to which truck, and which geofence
means which vendor or jobsite — the links are VBT data.

## L. What remains completely inside Linxup

Tracker hardware and activation, the positions themselves, geofence
definitions (VBT mirrors, never edits), trip/stop/usage computation, alert
rules and their configuration, driver ↔ tracker association mechanics,
dashcam storage, fuel and odometer sensing. VBT never writes to Linxup.

## M. Security requirements

- Secrets in environment variables only: `LINXUP_WEBHOOK_TOKEN` (and
  `LINXUP_WEBHOOK_TOKEN_NEXT` during rotation), `LINXUP_COMPANY_ID`. Never in
  the store, never sent to the browser, never logged; `/healthz` reports only
  "configured: yes/no" and the count of rejected requests.
- Accept the token from `Authorization: Bearer …` and, because the request
  described an "Authentication" header, from that header too; compare with
  `crypto.timingSafeEqual`; on failure answer 401 with no explanation and
  count it.
- Reject: bodies over 1 MB, non-JSON, messages whose `company.companyId`/`id`
  is not ours, lat/lng out of range, timestamps more than 7 days in the future
  or 5 years in the past. Normalize field names in one place; ignore unknown
  fields.
- The endpoints are outside sessions and CSRF, exempt from the write lock, and
  rate-limited per source (a runaway sender cannot starve the app). They never
  touch the JSON store.
- HTTPS is Railway's; no plaintext endpoint. If Linxup publishes source IP
  ranges, add an allowlist as a second factor; if it can sign payloads, verify
  the signature and drop the bearer scheme.
- Media URLs are stored, not proxied; they are shown only to managers.
- Token rotation: set NEXT, update Linxup, promote, unset — no downtime.

## N. Missing documentation and dependencies before implementation

1. **Transport section of Push API V3**: exact auth header name and format,
   how message types are routed (one URL each, or a header/field), retry and
   timeout policy, whether payloads are single objects or arrays, expected
   response codes, source IP ranges, TLS requirements, payload signing if any.
2. **Linxup REST (pull) API**, if available to the account: list trackers /
   assets / drivers / geofences (initial linking, reconciliation), current
   positions (cold start), trip/position history (backfill after downtime),
   geofence create (per-PO jobsite fences), fuel consumption report.
3. **Units and formats**: odometer (mi/km, bus vs GPS), speed (mph/km/h),
   `fuelLevel`, `accuracy`, `signal`, `battery` strings; `behaviorCode` and
   `alertCode` catalogues; heading conventions.
4. **Driver association**: how `person` is set for VBT's trackers (fob, app,
   manual) and how stale it can be.
5. **Geofence events**: do they fire for every fence or only fences configured
   to notify for that tracker? Enter/exit hysteresis?
6. **Media linkage**: is there an `alertId`/tracker on Media messages that the
   sample omits? How long do the URLs stay valid?
7. **A test path**: sandbox account, a way to replay or trigger messages, and
   a handful of real payloads from VBT's own trackers.
8. **VBT facts to collect**: the five trackers' ids/IMEIs/VINs and which truck
   each is in; the account's `companyId`; the geofences that already exist;
   VBT's public HTTPS URL for Railway.
9. **Terms**: confirmation that storing positions and clips in VBT's database
   is within the Linxup agreement.

## O. Phased implementation plan

Each phase is small, ships behind `LINXUP_WEBHOOK_TOKEN` being set (unset →
the endpoints answer 404 and nothing else changes), has its own e2e section
with replayed payloads (duplicates, out-of-order, unknown tracker, bad token,
mismatched company, field-name variants), and leaves the dispatch workflow
untouched.

**L0 — Prepare (no code).** Answer §N items 1, 3, 4, 5, 8. Create Linxup
geofences for the yard and regular plants. Issue the webhook token. Decide
the per-type URLs. Deliverable: a filled-in copy of §N.

**L1 — Receive and see.** Receiver with auth, validation, normalizer, dedupe,
`linxup_webhook_log`; `linxup_trackers`, `linxup_position_latest`,
`linxup_positions` with the nightly thin/prune; Device Status/Update mirror;
tracker link picker on Drivers & Trucks; `/api/fleet/telematics`; status dot,
speed, place, "GPS n s ago", odometer and engine on the board rows and Fleet
Map (Linxup primary, phone GPS fallback, labelled); `/healthz` telematics
block and `/api/linxup/health`. Definition of done: five trucks live on the
board from Linxup alone, phones off; duplicates and out-of-order fixes proven
harmless; a renamed tracker changes nothing but its label.

**L2 — Evidence (implemented).** Geofence Event, Stop, Trip ("Linxup vehicle
trip", an ignition cycle — never a VBT trip) and Usage Hours are interpreted
and stored in `linxup_geofence_events`, `linxup_stops`,
`linxup_vehicle_trips`, `linxup_usage`, each keyed by tracker and the event's
own time (ENTER and EXIT complete the same visit; an EXIT that arrives first
is kept and the late ENTER adds nothing; a second delivery is a duplicate). The
geofence mirror (`linxup_geofences`) is learned from the events; a yard is
mapped to a fence by a manager on Vendors (`vendor.linxupGeofenceId`, audited),
an exact name match is only suggested and, when used unconfirmed, labelled
"matched by name". Correlation is by truck and time, read-only:
`GET /api/loads/:id/telemetry` takes each VBT trip's window (start − 30 min to
completed + 30 min, or now, never reaching into the previous or next trip on
the load) on the truck that trip ran on and returns, per
trip, pickup evidence (fence visits, else GPS near the yard pin), jobsite
evidence ("near jobsite based on GPS" from the PO pin, plus stops there),
other visits, stops, vehicle trips, usage, a chronological telemetry timeline
with the source on every entry and the driver's taps beside them, and flags:
`pickup-mismatch`, `jobsite-mismatch`, `location-attention` (only when the
tracker did report in the window; silence proves nothing). The board adds
"Last geofence: … — entered …" to the truck line and the open trip's flags to
the Telemetry attention tile; Load Details gets a LINXUP TELEMETRY section
(Current · Pickup · Jobsite · Vehicle activity · timeline); the approval
dialog gets one evidence line per trip. Works for archived loads. Nothing in
L2 writes to a load, trip, assignment, approval or billing record.

**L3 — Decide and report (opt-in).** Owner picks which of A1–A3 to enable,
with "by telemetry" stamps. Alerts stored and listed in a small Fleet section
(active trucks, moving/idle/stopped, alerts, last update) with acknowledge.
Utilization report: engine hours per truck per day/week (from Usage Hours),
idle share (Stops), Linxup miles vs VBT odometer legs per shift, fuel level
trend (display only until §N item 2 is answered). Definition of done: the
report answers "how many hours did Truck #4 run last week and how much of it
was idle" without anyone opening Linxup.

**Never in scope:** completing, approving or billing anything from GPS;
reassigning a driver from Linxup's `person`; editing Linxup from VBT; a
general fleet-management product.

---

## Assumptions and open questions (confirm with Linxup before go-live)

The code for L1 is written against the message documentation above and
**nothing else**. Where the document is silent, the receiver takes the safest
reading, listed here as the assumption it makes; each one is a question to
put to Linxup, and the answer may change a line or two of code, never the
design.

| # | Question | What VBT assumes until answered |
|---|---|---|
| 1 | Exact webhook authentication: header name, format, one token per account? | A bearer token is accepted from `Authorization: Bearer <token>` or `Authentication: Bearer <token>` (also the bare token). Compared in constant time against `LINXUP_WEBHOOK_TOKEN` (and `…_NEXT` during rotation). Anything else → 401, counted, never explained. |
| 2 | Does Linxup retry a failed delivery? | Unknown. VBT answers 503 when it could not persist so a retry, if any, has a reason to happen; it never answers 200 for something it did not store. |
| 3 | Retry timing / backoff? | Unknown. Nothing in VBT depends on it. |
| 4 | Is delivery order guaranteed? | **No.** Every write is order-independent: history keyed by (tracker, time), the latest position only moves forward in time, exits update their own enter row. |
| 5 | What HTTP response does Linxup expect? | `200` with a small JSON body. `4xx` for bad requests (not retried), `503` for "could not store" (retry). |
| 6 | Can the same message be delivered twice? | **Yes, assumed.** Natural keys make a second delivery a no-op, answered 200. |
| 7 | Can messages arrive out of order? | **Yes, assumed** (see 4). |
| 8 | Is there a pull API for the initial tracker list? | Unknown. L1 builds the tracker list from the messages themselves: a tracker exists in VBT the first time any message names it, and the link screen offers those. |
| 9 | Is historical position backfill available? | Unknown. L1 keeps no gap-filling; a gap is simply a gap. |
| 10 | Odometer units and source? | Displayed as received with no unit conversion, labelled "odometer (Linxup)". The map screenshot shows 55,959 for VBT #2, consistent with miles; not assumed in code. |
| 11 | `fuelLevel` format and source? | Stored as the string received, shown only when present. The map shows "N/A" for VBT #2, so it will often be empty. `battery` looks like vehicle voltage ("13.70V" in the UI) and is stored as received. |
| 12 | Position volume? | Planned for ~1/min/tracker while moving; VBT's ten trackers → ~6,000/day worst case, well within the retention plan. |
| 13 | Are webhook source IP ranges published? | Unknown; no allowlist in L1. Token + company id are the gate. |
| 14 | Is payload signing (HMAC) available? | Unknown; not assumed. If it is, it replaces the bearer token. |
| 15 | Is there an API to create/update geofences? | Not in this document. Permanent places use Linxup fences created in the UI (two exist: **Fowler Yard** and **Delano yard**, both circles, notifying for all trackers); jobsites use VBT's own pins. |
| 16 | Do media URLs need authentication or expire? | Unknown; L3 stores them and shows them to managers only; nothing is proxied. |
| 17 | Is a Position sent while stopped / engine off? | Unknown. The board therefore does not call a truck "stale" just because it is quiet with the engine off: engine-off → **Stopped** (with the age shown); engine-on and quiet for 10 min → **Stale**; silent 24 h or tracker inactive → **Offline**. The Linxup map also shows an **Unplugged** state (tracker lost power) that the Push API document does not describe; VBT will learn it from Device Status if that is where it appears. |
| 18 | Can `batchedPositions` hold points that need individual persistence? | Treated as breadcrumbs only: the string is stored with its position row and not expanded into rows. |
| 19 | How is a message type identified? | One URL per type (`/api/linxup/<type>`). If only one URL is possible, `/api/linxup/event` classifies by shape as a fallback. |
| 20 | Are payloads single objects or arrays? | Both are accepted; an array is processed element by element. |
| 21 | Which `person` is on a message? | The driver Linxup currently associates with the tracker (e.g. "VBT #2 (Jesus Guzman)"). Shown as "Linxup driver: …"; never used to assign. |
| 22 | Does a FENCE_EXIT carry the `enterDateTime` of its own ENTER? | **Assumed yes** (the document lists both on the Geofence Event). L2 keys a visit by (tracker, geofence, enterDateTime), so ENTER and EXIT complete one row in either order. If an EXIT ever arrives with a different or missing enter time it is stored as its own row and the ENTER stays open — visible, never merged by guesswork. |
| 23 | Are Stop, Trip and Usage Hours sent once, when the period closes? | **Assumed yes.** L2 keys them by (tracker, start time); a re-delivery with the same end is a duplicate, one with a later end updates the row. An open-ended message (no end) is kept and shown as "still …". |
| 24 | `durationMinutes` on Stop/Trip/Usage — minutes, and the field names `startDate`/`endDate` on Usage Hours? | Read as minutes; when absent, derived from start and end. Usage Hours accepts `startDate`/`endDate` and `startDateTime`/`endDateTime`. |
| 25 | Is a Trip's `startGeofence`/`endGeofence` populated whenever the truck was inside a fence? | Unknown. L2 uses it only as a label ("began at Fowler Yard"); pickup evidence comes from Geofence Events and positions, never from a Trip's fence fields. |

Facts taken from the account's own screens (not from the API document):
ten trackers named "VBT #1" … "VBT #26", which do not map one-to-one to
VBT's truck numbers — so links are made by id on a screen, not guessed from
names; every tracker is a linxCam 2.0 dashcam; alert settings: high speed
60 mph, idle 5 min, ignition alerts on, posted-speed +5 mph, low battery
12 V, fuel fill-up and low-fuel alerts on, time zone Pacific; authorized
hours Mon–Fri 3:00 AM–7:00 PM (this is what "authorized miles" means on a
Trip); one truck produced 4,221 alerts in a month (a High Speed alert per
minute while over 60 mph), so L3 must roll alerts up into episodes rather
than list them.

---

## The two questions asked directly

**15. Do we still need our own GPS in the driver app?** No, not as a primary
source. Recommendation: **Linxup is the truck's position; VBT is dispatch.**
Keep the existing phone posting only as a labelled fallback (rental truck, dead
tracker) and stop investing in it; the Phase 2 driver-app simplification can
drop the always-on location prompt. Advantages: the truck reports whether or
not the driver's phone is charged, unlocked, permitted or even present;
engine, odometer, idle and trips come with it; geofence and trip computation
is done by Linxup; the evidence is independent of the driver. Limitations:
the tracker knows the truck, not the person (driver stays a VBT assignment,
Linxup's `person` is a hint); VBT depends on a third party's uptime and on
webhook delivery with no documented catch-up; one fix per minute while moving
is the resolution; fuel and odometer quality are unverified; geofences for
permanent places are maintained in Linxup's UI; there is a subscription cost
per tracker.

**16. Background GPS.** Phone GPS in VBT is at the mercy of iOS/Android
background limits, battery savers, permission prompts, a phone left in the
cab, or a driver who forgets to open the app: today's Fleet Map goes stale
the moment any of that happens, which is why it has a "stale" state at all.
A tracker wired to the truck reports whenever the ignition is on and usually
on a heartbeat when it is off, with cellular backhaul, so "no position" means
"no signal or tracker problem", not "driver's phone". Reliability moves from
"most of the time, if drivers cooperate" to "whenever the truck is running",
and the office gets engine on/off and odometer, which a phone can never give.
