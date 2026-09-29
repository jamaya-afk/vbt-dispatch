# VBT Dispatch — Current State Assessment

Date: 2026-09-29. Baseline commit: `660b9ff`.
Method: full read of `server.js`, `public/index.html`, `qb.js`, `mailer.js`, `geocode.js`, tests and scripts, split across eight parallel reviews (persistence/auth, PO/load/assign, driver flow, billing/QuickBooks, GPS/fleet, manager UI, reports/archive/costing, live test run). Every finding marked **verified** was confirmed by reading the exact code path; several were re-checked independently. Nothing in the codebase was changed.

---

## 1. Architecture in one paragraph

One Express process (`server.js`, 6,600 lines) serves one single-page app (`public/index.html`, 7,050 lines). Every operational record (POs, loads, trips, drivers, trucks, trailers, vendors, customers, shifts, freight segments, billing batches, audit log) lives in one in-memory JavaScript object that is serialized as **one JSON text row** in Postgres (`dispatch_data`, key `store`) on every mutation, with a one-save-deep `store_prev` copy and a per-boot `store_boot` copy. Real tables exist only for `users`, `user_sessions`, and `driver_locations` (GPS points). Photos go to Supabase Storage. QuickBooks Online is reached through `qb.js`. The e2e suite (`test-e2e.sh`, 454 assertions) and browser suite (`test-browser.js`, 104 assertions) both pass cleanly on this commit.

This design is fine for a five-truck operation as long as it runs as a **single instance**. It must never be scaled to two replicas; each would hold its own store and overwrite the other.

---

## 2. VBT CURRENT STATE

### Working (verified by the live test run and by reading)

- **Core chain** Customer → PO → Loads → Driver + Truck + Trailer → Yard → per-trip Start / Arrive Yard / Loaded (ticket) / Arrive Job / Drop → Submit → Approve → Ready to Bill → Batch → QuickBooks invoice. Per-trip timestamps and GPS stored permanently in `trips[]`.
- **Quick Assign sheet**: Driver → Truck → Yard → Trailer → Confirm, four clicks, nothing commits before Confirm, busy/off states visible, refuses off-duty drivers and maintenance trucks. Drag-and-drop only opens the same sheet. (`index.html:4606-4692`)
- **New PO form**: two steps, live PO-number uniqueness (spans archive), date defaults today, yard defaults VBT, jobsite reuse per customer, usual-truck prefill, per-row price preview, summary line. (`index.html:2001-2290`)
- **Duplicate-billing protection on the batch path**: loads are claimed synchronously before any await; concurrent sends yield one 200 and one 409 (tested); `send` and `retry` refuse any batch that already has an invoice id; unpriceable lines block batch creation. (`server.js:4210-4272`)
- **Protection of approved/billed records**: approved → `locked` blocks PUT, assign, move, delete; PO identity fields freeze once any load is approved; void requires a reason and keeps all evidence; loads on a batch cannot be voided until the batch is voided. (`server.js:2688, 2738, 2854, 3821`)
- **Tickets**: captured once per trip at the scale, unique across live and archived loads, voided loads excluded, owner named on conflict, planned vs actual tons side by side.
- **Pickup yard**: one resolver (`resolvePickupYard`) by id; label cannot drift; trip history never rewritten on yard change.
- **Fleet Map**: live positions, 5-minute stale marking, trip trail, per-truck card, no geocoder calls on refresh, drivers get 403 on all fleet routes.
- **Persistence safety**: refuses to write a store that was never loaded, refuses to seed when backups exist, backup and write in one transaction, restore validates before writing, no silent file fallback when Postgres is configured, 503 instead of an empty board when the DB is down.
- **Auth basics**: scrypt with per-user salt, login rate limit, driver payloads stripped of prices and billing, ownership checks on every driver route.
- **Costing engine**: one `computeAmount` used by invoices, preview, profitability; unconfigured units are reported, never priced silently.
- **Shift → Freight Segment → Daily Log → Freight Bill**: built and tested (truck conflicts, breaks, truck change, stale-shift office close, segment open/close/reopen).

### Partially working

| Area | What works | What does not |
|---|---|---|
| Drivers and trucks as separate records | Separate entities, any driver on any truck, deactivate instead of delete when history exists | `status` is manual-only: nothing ever sets `working` / `in-service` or resets it; a truck set `in-service` is unavailable forever. Truck `mileage` and `maintenanceNotes` exist server-side but have **no UI**. (`server.js:298, 6154-6172`; `index.html:6548-6574`) |
| Dispatch board | Landing screen (Quick Assign / "Today's Dispatch") shows tiles and status-sorted cards | A second **Board** screen shows the same day with different status math and different colors (Completed is green on one, purple on the other; Unassigned is red on one, amber on the other). Board is grouped by driver, not status. (`index.html:1656-1668` vs `server.js:6120-6126`) |
| Assignment | Quick Assign sheet is correct | Board "Assign" button posts only `driverId`, so the load ends up with a driver and **no truck**. "Reassign all" moves every unlocked load on every date after one click. Server checks nothing about conflicts (see Broken §3). (`index.html:2839`; `server.js:6300`) |
| Approval | Card shows tickets, tons, signature, times | One click, no confirmation, locks immediately. No GPS or timeline on the card. Reject resets nothing, so the driver's next button is Submit again. Badge is stale until Board is visited. (`index.html:3979, 4027`; `server.js:3794-3807`) |
| Vendor bills (payables) | Preview, create, send to QB | No void, no retry, no `syncing` guard, no restart recovery; priced at the **planned** vendor's rate while grouped by the **actual** yard (see Broken §6). (`server.js:4575-4737`) |
| Archive | Full copies kept in Postgres, audited | Archiving moves loads out of `store.loads`, and batch void, batch detail, segment lock, vendor-bill writeback, Material Costs and Reports all look only in `store.loads`. See Broken §2. |
| GPS | Server pipeline, table, map, staleness all sound | Phone posts only while the page is in the foreground; an expired session makes posts silently "succeed" (302 to /login is followed by fetch); no driver-side indicator of GPS state; accuracy never gated. (`index.html:1416-1441`; `server.js:1665`) |
| Driver flow | Order of the five trip steps is enforced; one open trip per load | ~14 taps, 4 typed numbers, a photo and a signature for the first delivery of the day; a minimum of four odometer entries per outside-yard day; the shift/segment layer can block trip actions mid-haul. See §4. |

### Broken (concrete, verified)

1. **Double billing through the manual path.** "Mark Billed (manual)" sets `billStatus='billed'` with no batch. Void only refuses when `billingBatchId` or `qbInvoiceId` is set, so the manually-billed load can be voided, then `unvoid` unconditionally sets `billStatus='ready'`. The load reappears in Ready to Bill and can be invoiced in QuickBooks. (`server.js:3896-3925, 3833, 3868`)
2. **Archive severs every link to the archived loads.** Batch void after archive voids the QB invoice but leaves the archived copies `billed` with QB ids forever (no re-bill possible, reports count voided revenue). A locked freight segment whose loads are archived becomes unlocked and its Freight Bill prints "DRAFT, 0 loads". Profitability re-prices actual-tons customers as planned once the PO is archived. Material Costs and Reports drop archived loads while Profitability keeps them, so the screens disagree after the first archive. There is no unarchive. (`server.js:6030-6067, 4287-4306, 4537-4547, 3218-3260, 1590-1592, 5848, 5948`)
3. **Reassignment has no conflict or mid-trip protection.** `/api/loads/:id/assign` checks the driver and truck exist and are not off/maintenance, but not whether the driver already has an open load, whether the truck is on another driver's load today, or whether the load is mid-trip. Trips carry no `driverId`, so reassigning a load with three completed hauls re-attributes those hauls to the new driver on the board, in approval, and on the invoice. The PO form has the same gap (it accepts off-duty drivers and maintenance trucks that Quick Assign refuses). (`server.js:6275-6346, 2543-2546`)
4. **Create PO reports success when the save failed.** The `saveData` error is caught and logged; the client gets `success:true`. The PO exists in memory only and vanishes on the next restart. Every other handler returns 500/503 in this case. (`server.js:2664-2671`)
5. **Truck change strands the driver.** After a mid-day truck change, the next outside-yard arrival is refused because the segment overlap check compares odometers across both trucks ("Odometer 50,100 is inside the closed freight 200,000 → 200,180"). The driver cannot proceed until the office intervenes. (`server.js:3267-3272`)
6. **Vendor bill amounts are wrong when the actual yard differs from the plan.** Groups are keyed by the actual pickup yard, but the amount is `load.vendorRate`, snapshotted from the planned vendor at PO creation. Planned Vulcan at $22, actually loaded at Yard B at $30 → Yard B billed at $22. Planned VBT (rate 0), actually external → a **$0 vendor bill** is created for an external vendor without a flag. Arrival at a yard never re-prices. (`server.js:4575-4590, 1606, 3011-3016`)
7. **QuickBooks retry after a lost response creates a second invoice.** If QB commits the invoice but the HTTP response is lost (no fetch timeout in `qb.js:172`), `qbInvoiceId` is never set, the batch is `failed`, and Retry creates a new invoice. Nothing queries QB by batch id before creating. Same pattern on vendor bills, which also allow two clicks on Send. (`server.js:4307-4490, 4554, 4689`)
8. **Stale-shift office close inflates and locks a segment.** Driver forgets End Day; loads approved that evening; office closes the day next morning with a typed odometer. The segment's `timeEnd` becomes next morning and, because all loads are approved, it locks immediately. Correction requires voiding approved loads. (`server.js:3598-3603, 3225-3231`)
9. **Submitted work can be hard-deleted.** Delete PO / Delete Load block only `approved`, on-batch, or QB-invoiced. A load with four completed trips, tickets, photos, signature, and `approvalStatus='submitted'` is deleted with the PO in one confirm. No soft delete. (`server.js:2746, 2857-2862`)
10. **Drivers can bypass the trip state machine through the generic PUT.** A driver may set `loadsDelivered`, `timestamps`, and `gps` directly (no clamp, `NaN` accepted), then submit a "full" delivery with no trips behind it. Not reachable from the UI; reachable from a phone browser console. (`server.js:2789-2793`)
11. **Save ordering is not serialized.** Two overlapping requests each stringify the whole store and commit in whatever order they acquire the row lock; the older snapshot can win. Memory stays correct so it self-heals on the next save, but a redeploy in the gap loses the newer write. `store_prev` is rotated by every save, including background GPS flushes, so the undo window is one save. (`server.js:836-897, 2120, 1357`)

### Missing

- **Edit PO.** There is no UI to change a PO's customer, jobsite, date, or notes after save; the only path is delete and re-enter, which §9 makes dangerous and the approved-freeze makes impossible. The API's `PUT /api/pos/:id` propagates only `deliveryDate` to loads and skips submitted ones.
- **Driver and truck attribution on trips.** `trips[]` records yard and GPS but not who drove or which truck.
- **Server-side conflict checks** for driver double-assignment and truck double-booking on the same day (shift-level truck conflict exists; load-level does not).
- **Archive-aware lookups** and an unarchive path.
- **Vendor bill void/retry.**
- **Manager-set or simulated driver location** in production (only a test hook gated to non-prod exists). No `source` column on `driver_locations`.
- **Session invalidation** when a driver is disabled or a password changes; a removed driver keeps a valid cookie for up to seven days. (`server.js:1665, 5167-5195`)
- **Distinct manager role.** `reqAdmin` is identical to `reqMgr`, so restore, default rates, and QuickBooks connect/disconnect are open to managers. (`server.js:1666-1672`)
- **Truck mileage and maintenance UI**, driver phone/notes UI.
- **Dashboard tiles** for busy trucks, ready to bill, active POs, and missing tickets (the server already sends `summary.missingTicket`; the UI ignores it).
- **Amounts on the Ready to Bill table** (the manager selects blind; dollars appear only in the preview).
- **Tests** for PO edit propagation, reassignment mid-trip, truck double-booking, `/api/loads/:id/reject`, `DELETE /api/loads/:id`, all vendor-bill routes, restore in file mode.

---

## 3. The 7:00 AM test

"I am dispatching five dump trucks. Can I understand what is happening immediately?"

**Mostly yes, with three caveats.** The landing screen (Quick Assign) answers unassigned, in progress, awaiting approval, and who is free. Cards are sorted by status, and assignment is four clicks with a real Confirm. That part is good.

The caveats:

1. **Two boards, two truths.** Board and Quick Assign count "Completed" and "In Progress" differently and color them differently. A dispatcher who checks both will see different numbers for the same morning. One of them has to go, or both must read the same server-side status.
2. **Trucks are invisible at the tile level.** You see free drivers but not free trucks; "Truck: NONE" is per card only. Assigning from Board leaves the truck unset, so the driver discovers it at Start Day.
3. **You cannot trust the red badge or the shift count.** The Approvals badge is stale until Board is visited; "N drivers on shift" is the roster size.

For the **driver**, the answer is "no, not yet". The flow is correct but the day is front-loaded with administration: Start Day (truck, trailer, odometer, inspection checkbox, signature), then odometer again at the first outside yard, ticket photo, ticket number, net tons, then odometer again to finish freight, then odometer again to end the day. Four odometer entries is the minimum; a truck change adds two, a customer switch adds one. Several of these can block a trip action mid-haul (`odometer_required`, `segment_open`, `stale_shift_open`). This is the opposite of "Today → Start → Arrive Yard → Loaded → Arrive Job → Complete".

---

## 4. Synchronization map

Where a change in one place does not reach the others.

| Change here | Should update | Actually |
|---|---|---|
| PO delivery date (API) | all loads on the PO | unlocked loads only; submitted loads keep the old date; no move history |
| PO customer / jobsite / planned yard / material (API) | loads, price snapshots, `po.materials` | nothing; `customerRate` stays priced at the old customer |
| Driver rename | `load.driverName` on every load | not propagated; board shows the old name |
| Vendor rename / deactivate / delete | `load.vendorName`, `trip.actualYardName`, `po.plannedVendorId` | names not propagated (id lookup mitigates in most views; `/api/my-dispatch` prefers the stale name); deactivated vendors still assignable; delete checks live loads only |
| Reassign driver | trips' attribution, truck, statuses | driver name overwritten, trips silently re-attributed, truck untouched from Board, `allTripsDone` never reset |
| Arrive at a different yard than planned | vendor cost | load-level `actualYardId` updated, `vendorRate` not re-priced |
| Approve / assign / shift start | `driver.status`, `truck.status` | never touched |
| Archive | batches, segments, reports | links broken (see Broken §2) |
| Load material edit (API) | `customerRate`, `vendorRate`, `tonsPerLoad`, `po.materials` | none re-priced |
| Disable driver / change password | live sessions | sessions untouched for 7 days |

---

## 5. Recommendations

Ordering principle: anything that can produce a wrong invoice or destroy evidence first; then the daily dispatch loop; then driver simplicity; then GPS. Every item below is a targeted fix inside the existing design. None requires a rebuild.

### 5.1 Critical (fix before the next real billing cycle)

**Status (2026-09-29): all eleven items below are done, plus a twelfth (double-tap guards on Start and Arrived at Job Site). Each is covered by section 40 of `test-e2e.sh` (73 assertions); the full suite is 528 end-to-end and 104 browser assertions, all passing.** Two related adjustments made while implementing: the vendor cost model became per-trip (each trip carries the rate fixed at the scale, and a missing or default price is resolved live when the office adds it), and PO creation warns about truck or trailer double-booking but not about a driver who is out hauling, since queuing a driver's next job is normal planning.

| # | Fix | Where | Size |
|---|---|---|---|
| C1 | Void refuses a load whose `billStatus==='billed'` unless it is first un-marked through an audited "Unbill (manual)" action; unvoid restores the prior `billStatus` instead of forcing `ready`. | `server.js:3821-3880` | small |
| C2 | One `findLoadAnywhere(id)` / `findPoAnywhere(id)` helper (live + archive) used by batch detail, batch void, vendor-bill writeback, segment lock, `revenueDetail`, Material Costs, Reports. Additionally: archive refuses loads whose batch is not `sent` or `voided`. | `server.js:4287, 4537, 3218-3260, 1590, 5848, 5948, 6030` | medium |
| C3 | Create PO returns 503 and rolls back the in-memory push when `saveData` fails, like every other handler. | `server.js:2664-2671` | tiny |
| C4 | Driver branch of `PUT /api/loads/:id` accepts only `pod`, `ticketImage(Url)`, `notes`. Drop `loadsDelivered`, `timestamps`, `gps`. Audit the driver branch. | `server.js:2789-2793` | tiny |
| C5 | Vendor bills price at the **actual** yard's rate: re-snapshot `vendorRate` at `arrived-pickup` when the yard differs from plan, and at bill time refuse any external-vendor line with amount 0 or `unconfigured`. Add `syncing` guard, double-click guard, restart reset, and a void path mirroring batches. | `server.js:3011-3016, 4575-4737, 1163-1170` | medium |
| C6 | QB lost-response recovery: on send/retry, query QB for an invoice whose `PrivateNote` carries the batch id before creating; add a fetch timeout in `qb.js`. Mark the batch `unknown` rather than `failed` when the create call errors after the request was sent. | `server.js:4307-4490, 4554`; `qb.js:172` | medium |
| C7 | Assignment guards on `/assign`, `/api/pos`, and `/loads/move`: refuse when the driver has an open (started, not completed) load; refuse when the truck or trailer is on another driver's load the same day; refuse reassignment when a trip is open unless `force` with reason. Stamp `driverId` and `truckUnitId` on each trip at `start-trip`. | `server.js:6275-6346, 2543-2546, 4758, 2992` | medium |
| C8 | Delete PO / Delete Load refuse when any load is `submitted`, has `loadsDelivered>0`, or any trip has a ticket. Offer Void instead. | `server.js:2746, 2857` | small |
| C9 | Segment overlap check filters to `other.truckId === seg.truckId`; the floor hint does the same. | `server.js:3267-3272, 3335` | tiny |
| C10 | Serialize `saveData` with a promise-chain mutex so snapshots commit in order; skip the `store_prev` rotation for background saves (GPS flush, notification log) so the undo copy survives more than one tap. | `server.js:836-897` | small |
| C11 | Office stale-shift close: do not lock the segment on forced close; record `forcedBy` and allow a manager edit of `timeEnd`/`odEnd` with reason until a manager marks it final. | `server.js:3598-3603, 3225` | small |

### 5.2 High value (the daily loop)

- **One board.** Keep Quick Assign (rename it "Dispatch") as the only day view, driven by the server's `bucketOf` status. Convert Board-day into a status-column layout of the same data or retire it. One color language: green = complete, red = needs action, amber = assigned/waiting, blue = in progress. Remove the second set of status math in `computeBoardStats`.
- **Board Assign uses the full sheet** (driver → truck → yard → confirm). "Reassign all" limited to the selected day, with a typed confirmation.
- **Approve with a confirm step** that lists what is missing (partial, tickets without tons, no signature) and shows the timeline and GPS. Reject clears `allTripsDone`, `pod`, and the submission flag so the driver must re-do the step that was wrong.
- **Edit PO** (customer, job, jobsite, date, notes, planned yard) with propagation to unlocked loads, a move-history entry, and an audit line. Block identity fields once any load is approved (already enforced server-side).
- **Landing tiles**: add Trucks Free / Trucks Busy, Ready to Bill, Missing Tickets (data already sent), Active POs; fix "drivers on shift" to count open shifts; refresh the Approvals badge on landing.
- **Ready to Bill table** shows amount, basis (planned/actual), and a "default rate" flag per row.
- **Automatic statuses**: derive `driver.status` and `truck.status` from open loads and shifts on read; keep the manual field only for `off` / `maintenance` / `out-of-service`.
- **Replace `prompt()` chains** for Add Driver / Truck / Trailer / Set Location with small forms. Admin-only, but five sequential native prompts is error-prone. (`index.html:6660-6800`)
- **Truck mileage and maintenance** fields on the Trucks screen, with a manager correction path for a bad odometer (today a typo blocks the next Start Day).

### 5.3 Driver simplicity (decide with the owner, then build)

The current administrative layer is correct but heavy. Proposed target: the driver enters an odometer **twice a day**, not four to seven times.

- Start Day: truck and trailer pre-selected, odometer pre-filled and editable, inspection as one tap plus signature (the pre-trip inspection is a DOT requirement, so keep it, but make it one screen).
- Freight segments open **automatically** at the first outside-yard arrival for a customer/jobsite and close **automatically** at the last drop of the day or at End Day with the end-day odometer. Remove the mid-day odometer prompts for ton-billed customers entirely; keep an odometer prompt only when the customer bills by hour or mile, and only at segment open. Prompt "Finish freight?" after the last drop rather than blocking End Day with a 409.
- Truck change: close the old leg with the reading the driver already typed, open the new one; never force-close an en-route trip's segment (C9 handles the odometer; this handles the trip).
- Stale shift: at Start Day, if yesterday's shift is still open, offer "Close yesterday's day (ended at last drop)" in one tap instead of refusing Start Day or blocking trips at the 20-hour mark.
- Remove the end-of-load "Upload Ticket Photo" for loads whose trips already carry VBT internal tickets. (`server.js:3042-3045, 3068-3069`)
- Ticket uniqueness scoped per source and vendor (CEMEX #45012 and Vulcan #45012 are both legitimate); normalize leading zeros.
- Double-tap guards on `start-trip` and `arrived-jobsite`; disable the button while the request is pending.
- Manager may fix a ticket while the load is `submitted` (the route's own comment says so; the `locked` check contradicts it). (`server.js:3740`)
- Single-trip loads fire the `delivered` notification like multi-trip loads.

### 5.4 GPS / driver location

- **Driver-side GPS chip**: On / Denied / No fix / Session expired, re-armed on `visibilitychange`; `/api/*` returns JSON 401 instead of redirecting so the client can detect an expired session. (`server.js:1665`; `index.html:1416-1441`)
- **Accuracy gate**: points worse than ~250 m update "last seen" but not the marker position.
- **`source` column** on `driver_locations` now (`driver-phone` / `manual` / `eld`), per SPEC §3.4, before more code depends on the table.
- **Manager-set / simulated location** in production: manager-only, audited, `source='manual'`, drawn with a distinct marker. This is the hardware-free test path the owner asked for.
- Background delivery will require a native wrapper or an ELD; the web page cannot post from a locked phone. Plan for it; do not expect the current page to do it.

### 5.5 Nice to have

- Fold Material Costs into Profitability → By Vendor (one engine, one screen); trim Duration Analytics to by-yard and by-driver averages; wire `costRates` (labor, fuel, per-mile) into the internal-yard cost or remove the scaffolding; move Customer Notifications out of the QuickBooks tab; remove the redundant Preview Invoice button, dead CSS, and the unused `podReady`/`delay` notification events.
- Add PO/customer context to the Delete Load confirm; require a reason on unvoid; give the invoice memo a customer-facing text without the internal batch id.
- Gate `/healthz` internals behind auth (it currently lists recent error messages, paths, and roles to anyone); rotate the seeded default passwords by making `*_PASS` required in production or forcing a change at first login; make `manager` a real role distinct from `admin`; invalidate sessions on driver disable/password change; pin Node 20 in `nixpacks.toml`.
- Restrict vendor-price `unit` to the supported list so a "CY" price cannot be entered where the engine refuses to price it.
- Tests for the gaps listed under Missing.

### 5.6 Future (after the core is stable)

- Customer notifications and tracking link (SPEC §3.1, §3.2) once a provider is configured and the `delivered` event fires consistently.
- ELD / background GPS integration.
- Relational tables for loads and trips. Not needed now; revisit only if the blob exceeds a few MB or a second instance is ever required.

---

## 6. Open questions for the owner

These change the shape of Phase 2 and should be answered before the driver flow is simplified.

1. How often are customers billed by the **hour or mile** rather than by the ton? If rarely, freight segments and their odometers can be hidden except for those customers.
2. For an hourly customer, is VBT yard → jobsite billable time, or repositioning? (Today a VBT pickup never opens a segment, so that time is never billable.)
3. Is a per-segment odometer really needed, or is the daily start/end odometer plus the segment's start/end **time** enough for the freight bill?
4. Is a wrong ticket ever legitimately corrected after approval, or is void-and-redo acceptable?
5. Should the office be able to set a driver's location manually on the Fleet Map (for testing and for trucks without a phone)?
6. Cubic yards per truck load, so CY-priced material stops costing $0 (SPEC §5, still open).

---

## 7. What to do first

Phase 0, in this order, each with an e2e assertion added: C3, C4, C9, C1, C8, C10 (all small), then C2, C5, C6, C7, C11. This closes every path to a wrong invoice or lost evidence and does not touch the UI. Phase 1 then collapses the two boards into one, fixes assignment from the Board, adds Edit PO and the approve confirm. Phase 2 is the driver simplification, after the owner answers §6.

### Status

- **Phase 0 — done** (commits "Phase 0: …" through "Phase 0 review fixes"). Every item in §5.1 is fixed with a regression test in `test-e2e.sh` §40, and the five-truck day in `test-scenario-day.sh` runs green.
- **Phase 1 — done** (commits "Phase 1.1" … "Phase 1.6"), in the order proposed:
  1. One dispatch board (`/api/today` computes every status once; the Board tab is gone) — e2e §41.
  2. Assignment conflicts decided in an in-app dialog (Cancel / Reassign), never a browser `confirm()` — e2e §42.
  3. Approval confirms the record (Driver · Truck · Pickup yard · Ticket · Delivery); a ⚠ item needs an explicit acknowledgement that is written down — e2e §43.
  4. Edit PO with the propagation rules written in `PO-EDITING.md`; add a load to an existing order — e2e §44.
  5. Billing visibility: amounts and totals in Ready to Bill, the Submitted → Approved → Ready to Bill → Billed → Archived strip, manual billing with a reference, Unbill (manual only, with a reason), Unarchive — e2e §45.
  6. A failed save leaves nothing behind: the store rolls back to the last saved state and mutating requests run one at a time — e2e §46.
  The browser suite (`test-browser.js`) covers each screen, and the five-truck scenario now asserts the rollback instead of the old "known limit".
- **Remaining, by design or for later:** the QuickBooks and vendor-bill send/retry/void routes keep their in-flight state on a failed save (it is their recovery record); a re-billed load still needs its archive batch unarchived first (one click, with a reason); the driver-busy rule looks at the same day only; vendor bills are API-only; the driver screen (Phase 2) is unchanged.
