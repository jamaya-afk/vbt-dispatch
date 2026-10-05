# VBT Architecture Checkpoint — review before any further features

Date: 2026-10-01. Scope: the whole system as it stands (PO creation, loads,
assignment, yards and vendors, driver workflow, Dispatch, Calendar, Load
Details, approval, Ready to Bill, billing and QuickBooks, costing, Fleet Map,
phone GPS fallback, Linxup L0–L2, the regression suites). Review only: nothing
was changed in this pass except this document.

Method. Four independent read-only code sweeps (assignment and driver
workflow; approval, billing, QuickBooks and costing; PO creation, persistence
and data duplication; the front end, duplication, contradictions and lost
features), each required to cite file and line. Every finding ranked CRITICAL
or IMPORTANT below was then verified by me: by a live probe against a fresh
server where the behaviour could be exercised through the API, otherwise by
reading the cited code. Findings that could only be confirmed by QuickBooks'
own behaviour are marked "by code reading".

Regression suites run as part of the review, on the current commit:

| Suite | Result |
|---|---|
| API, file mode (`bash test-e2e.sh`) | 693 passed, 0 failed |
| API, Postgres (`./test-pg-local.sh`) | 787 passed, 0 failed |
| Browser (`node test-browser.js`) | 176 passed, 0 failed |
| Five-truck scenario day | 44 passed, 0 failed |

Verdict in one paragraph. The separations the owner set — Calendar for
planning, Dispatch for now, Load Details for the complete record, Linxup as
evidence, VBT as the operational truth — hold: the two screens build rows
with one server function, telemetry writes nothing, and the Phase 0
protections (locked loads, duplicate-billing guards on the batch path,
conflict checks on assignment, archive-aware lookups) all held up under
probing. Four defects can still put wrong numbers on an invoice or corrupt a
load from an office session; they are listed first and should be fixed before
anything else is built. The rest is a set of places where two screens or two
rules disagree, a few billing guards with gaps, and a dispatcher workflow that
is still more complicated than it needs to be.

---

## 1. CRITICAL — could corrupt operational or billing data

### C1. "Stop early" lets a driver submit more loads than were hauled, and approval does not notice
**Status: FIXED 2026-10-01** (commit following this review). Rule enforced: the delivered count is the number of completed trips (`completedTripCount`/`deliveredRecord` in `server.js`); Stop early submits exactly that and refuses any other number (`400 delivered_mismatch`); nothing can be submitted with no completed trip (`400 nothing_delivered`); a load whose count disagrees with its trips is refused at approval even with an acknowledgement (`409 approval_blocked`), is not priceable in Ready to Bill, and costs only its completed trips. The phone dialog shows the completed trips and offers nothing to adjust. Tests: e2e §50, §40 R1 (rewritten to the new rule), browser driver section.
Verified live. The driver's Stop-early dialog defaults to **assigned − 1**
(`public/index.html` `openIncompleteDialog`: `incompleteCount = Math.max(0,
incompleteAssigned - 1)`), and the server accepts any count up to
`loadsAssigned` without comparing it with completed trips (`server.js`
trip-action `incomplete`: `reported = Math.min(Number(req.body.delivered) ...,
l.loadsAssigned); l.loadsDelivered = reported`). The approval checklist
compares nothing with the trip count. Probe: 1 of 5 trips done, submit the
dialog's default → `loadsDelivered 4`, `trips 1`; checklist green, no
acknowledgement asked; Ready to Bill priced **$2,500 for 4 loads**; vendor bill
preview **4 loads, $3,800**. One extra tap on the phone bills the customer and
pays the vendor for three loads that never happened.
Fix shape: the server derives the delivered count from completed trips (the
dialog can only confirm it, never raise it); the checklist flags
`loadsDelivered ≠ completed trips` as a blocking item.

### C2. An ambiguous QuickBooks answer can end in two live invoices
By code reading (`server.js` billing-batch void and retry; `qb.js`). Two gaps
compound:
- Only a thrown `fetch` marks a request `uncertain` (`qb.js`: `err.uncertain =
  !!mutating` in the catch). A 5xx or gateway response, a connection dropped
  while reading the body, or a 200 with an unparseable body all count as
  "nothing was created": `mayExistInQuickBooks` stays false, Retry resets the
  batch to `ready_to_bill` and the screen re-sends.
- Void consults QuickBooks only when the batch has an invoice id (`if
  (b.qbInvoiceId) {` …); a `failed` batch flagged `mayExistInQuickBooks` is
  voided with no lookup and its loads go straight back to `ready`. The page
  asks about QuickBooks only in the same case. The DocNumber + note lookup
  that Retry already uses is not used here.
Scenario: a send times out after Intuit created the invoice; the manager
clicks Void, re-selects the loads, sends again → two invoices. Vendor bills
have the same two gaps.
Fix shape: treat every mutating request that reached the network as uncertain
unless a definitive validation error came back; on Void of a batch that may
exist, run the lookup first and refuse to release the loads until QuickBooks
answers.

**Status: FIXED 2026-10-01** (CRITICAL 4 commit). A QuickBooks create now has
three outcomes, never two. `qb.js` classifies every mutating request:
`uncertain: false` only for a definitive 4xx or a failure before the request
left; `uncertain: true` for a timeout, a dropped connection, a body that could
not be read or parsed, any 5xx, and a 2xx whose body carries no entity
(`httpOutcome`, `noEntityError`). The server has an explicit state for the
third outcome: `syncStatus: 'unknown'` — "External result unknown — reconcile
before sending again" — on billing batches and vendor bills, with a `reconcile`
record (reason, kind, the `requestid` the create carried, the exact lookup, the
attempts and the result). An unknown batch or bill: Send → `409
external_unknown`; Retry is a reconciliation (QuickBooks is asked for the
document; found → adopted and the loads billed, not found → ready again, the
re-send carrying the same requestid; QuickBooks unreachable or the lookup
failed → refused, nothing changed); Void looks up first and never releases the
loads on an assumption (found → voided/deleted in QuickBooks, then released;
not found → released; unreachable → `409`; or the operator states on the
record that they checked QuickBooks by hand: `confirmedNoInvoiceInQuickBooks`
/ `confirmedNoBillInQuickBooks`). The load keeps its `billingBatchId`, so it
cannot join another batch, and no invoice id is ever recorded without
QuickBooks' word. A restart mid-send parks the batch as unknown (with an id,
`failed` — Retry confirms it). Idempotency: every create carries Intuit's
`requestid` query parameter (= the batch / bill id; Intuit replays the
original answer for a repeated requestid). Intuit does not document how long a
requestid is kept, so it is the second line of defence; the unknown state and
the DocNumber / private-note lookup remain the guarantee. Probed before/after:
invoice created, answer lost, manager voids and bills again — before: `failed`,
void released the loads with no lookup, re-send created a second invoice (2
live); after: `unknown`, void with QuickBooks unreachable `409`, void with it
connected found and voided the invoice in QuickBooks, re-send created one (1
live). Tests: e2e §53 (confirmed success, confirmed failure, thrown, timeout,
created-and-lost, 5xx after creation, 5xx with nothing created, 2xx with no
body, retry / void / re-bill while unknown, operator statement, simultaneous
sends, second-send refusal — for invoices and for vendor bills); §40 C6 and
the restart test rewritten to the new state; the fake QuickBooks counts create
requests received separately from documents that exist.

### C3. The office branch of the generic load update spreads the request body into the load
Verified by code (`server.js` `PUT /api/loads/:id`, office branch: `const
updated = { ...l, ...req.body, id: l.id, poId: l.poId }` behind a short
blocklist). An office session can set `truckId`, `truckUnitId`, `trailerId`,
`deliveryDate`, `driverName`, `loadsDelivered`, `customerRate`, `tonsPerLoad`,
`manualBillRef`, `vendorBillId`, `billHistory` and `status` on any unlocked
load with no conflict check, no validation and a partial audit entry (a driver
change replaces the audit details). No office screen calls this route today
(the driver branch is a strict whitelist and was probed: progress fields →
400), so it is latent, but one future button or one curl makes it a
corruption path. Fix shape: a whitelist like the driver branch (notes, trailer
through the assign rule), everything else refused.

**Status: FIXED 2026-10-01** (CRITICAL 2 commit). The office branch of
`PUT /api/loads/:id` is now a strict allowlist: `notes`; `loadsAssigned` only
while the load is operational (the Edit PO rule — no trip started, nothing
delivered; otherwise `409 not_operational`); `pod`, `ticketImage` and
`ticketImageUrl` (evidence the office may attach on the driver's behalf, as the
driver branch already allowed). Every other field is refused with
`400` naming the field and the operation that owns it (`routes` in the
response): driver / truck / trailer / yard → Quick Assign; date → Move Date or
Edit PO; delivered count, trips, stamps, GPS, actual yard, status → the
driver's trip steps; approval, billing, void, bookkeeping, history, pricing
snapshots, ids → their own actions or never. A request with one refused field
writes nothing. A voided load answers `403`; a locked load still answers `403`.
Probed before/after on the same fixture (driver, truck, delivered count, date,
history arrays, pricing, vendor-bill bookkeeping, status: all `200` and written
before; all `400` and untouched after). Tests: e2e §51, §22 loop extended; §8,
§29 and §44 fixtures moved off the bypass (test hook or Quick Assign). No
office screen called the route, so no UI change. Owner note: there is no
dedicated office operation that hand-sets a per-load customer rate (prices are
set at creation and by Edit PO propagation); the PO-edit "hand-set price stays"
rule is still tested with a planted fixture.

### C4. Actual-tons customers can be billed for a trip that was loaded but never delivered
Verified by code (`server.js` `loadTons`: `actualTons` sums every trip with a
ticket, not every completed trip; `revenueDetail` bills `rate × actualTons`
whenever `ticketsWithTons ≥ loadsDelivered`). Scenario: trip 3 is loaded (ticket
captured at the scale) and the truck breaks down; the driver submits
`incomplete` with 2 delivered; the invoice includes trip 3's tons while the
vendor side counts 2 trips. Fix shape: sum tons of completed trips only, and
show the loaded-but-undelivered ticket on the approval checklist.

**Status: FIXED 2026-10-01** (CRITICAL 3 commit). Rule enforced: delivered
actual tons = ticket tons of completed trips only, using the one completion
predicate from CRITICAL 1 (`tripIsCompleted` in `server.js`, read by
`completedTripCount`, `loadTons`, `loadCostLines` and the freight segment).
`loadTons` is the single calculation; `actualTons`, `tickets`,
`ticketsWithTons`, `ticketNumbers` and `tonsSource` now describe completed
trips, and a ticket on a trip that never completed is returned as
`openTickets` / `openTons` — shown in Load Details, on the approval ticket row
("ticket #N on trip 2 was loaded but never delivered (26 t, not counted)") and
recorded in the approval audit, counted nowhere. Consumers that follow it
without their own formula: Load Details and the approvals ticket summary, the
Dispatch board row, the Fleet Map row, the driver's phone, Ready to Bill and
the invoice line (`revenueDetail`), the billing batch line and its ticket
numbers, the approve audit, the freight segment's `actualTons` (was its own
all-tickets sum) and the Freight Bill total. Vendor costing already costed
completed trips only (actual yard per trip, planned tons) and is unchanged.
Pre-trip-tracking loads (no trips) are unchanged: no tickets, planned tons from
the delivered count, and an actual-basis one is still not priced. Probed
before/after on one completed trip (24.5 t) plus one loaded, ticketed,
undelivered trip (26 t) for an actual-basis customer: before 50.5 t, 2 tickets,
invoice $1,262.50 with both ticket numbers; after 24.5 t, 1 ticket, invoice
$612.50 with the delivered ticket only; vendor cost 1 trip both times. Tests:
e2e §52; §36 check 8 rewritten (running tons on the Fleet Map while load 4 is
en route are now 70.84 / 3 tickets, with the current ticket shown beside them).
Owner note: material loaded at a vendor yard and never delivered is now neither
billed nor costed and is only shown; whether it should block approval or be
costed to the vendor is an owner decision, not made here.

---

## 2. IMPORTANT — could cause dispatcher or user errors

### Assignment and the driver's day
- **I1. A driver mid-haul on yesterday's load shows "Available" today, and can be given a new load with no conflict.** Verified live: `/api/today` lists the load under carried-over, but the driver row is computed from today's loads only, and `assignmentConflicts` scopes `sameDay` by `deliveryDate`. The truck is likewise "free". Calendar shows the load on its own date (correct). Dispatch contradicts its own carried-over tile.
- **I2. One driver can start trips on two loads at once.** Verified live: `start-trip` checks only this load; the phone shows a Start button on every card; the board then shows both as open with no conflict.
- **I3. Reject puts a load back on its truck without checking who has it now.** Verified live: a partial submission frees the truck, Quick Assign moves it to another driver, Reject re-holds it; the board flags the conflict only afterwards.
- **I4. Shift truck versus load truck: no warning anywhere but the printed Freight Bill.** Verified live: Beryle starts her day on Truck #12 while her load says Truck #2; the board, Fleet Map and the trip stamp all say Truck #2; odometer legs are on #12; Linxup evidence will read #2's tracker and raise false "no activity" flags. The segment records `truckMismatch`, the screens never show it.
- **I5. A truck can be put in maintenance while mid-haul.** Verified live: allowed, the chip reads "In shop" with the load still on it, no warning.
- **I6. Reject resets nothing.** Verified live: the load keeps its tickets, signature and "all trips done"; the driver can tap Submit again unchanged. The driver does see the reason banner. (ASSESSMENT §5.2 asked for reject to clear the submission so the wrong step is redone.)
- **I7. Move-all reassign ignores the truck, trailer and yard and spans every date** (`public/index.html` `confirmReassign` posts `{ driverId }` only; the modal says "regardless of date"), so the new driver inherits the old driver's truck and an unassign leaves a truck on a driverless load. ASSESSMENT §5.2 asked for it to be limited to the selected day with a typed confirmation; that was not done. By code reading.
- **I8. Two date-change paths with different rules.** Edit PO moves only loads with no trip started (per PO-EDITING.md); Load Details → Move Date moves any unlocked load, partly delivered ones included (`server.js` `/api/loads/move`: `toMove.filter(l => !l.locked)`), and only "entire PO" updates the PO's date. By code reading.

### Screens that disagree
- **I9. The browser's copy of loads goes stale.** By code reading: since Phase 1.1 the refresh loop re-renders only Dispatch (and now Calendar); on Approvals, Purchase Orders, Ready to Bill and History it reloads data without redrawing, and opening those tabs does not reload. Scenario: the Dispatch tile says "Awaiting Approval 1 · review now"; Approvals says "No loads awaiting approval" until the tab is reopened. Load Details, drag-drop and Reassign silently do nothing for a load created after the page loaded (`if (!l) return;`).
  **Status: FIXED 2026-10-05** (Persistence #5 commit). Audit of every office screen (what it reads, when it repaints) and every action (what it sends, what the server revalidates). The poll now repaints the current screen from the fresh copy on every change — Approvals, Purchase Orders, Ready to Bill and History, not only Dispatch and Calendar — and refreshes the approvals badge; opening Approvals or Purchase Orders reloads before it paints. The audit also found three forms that sent a whole object from a stale copy, so one tab's save could revert another tab's change (CRITICAL): Quick Assign sent all four prefilled fields (driver, truck, yard, trailer), the customer form sent every field including the billing basis, and the fleet rows sent every field including a truck's status. Each now sends only what the person changed (the sheet against the values it opened with, the customer form against `cmBase`, the fleet rows against `fleetState`), and sends nothing when nothing changed. Edit PO already sent only touched fields and still does. Every action is revalidated on the server against the current store (locked → 403, not submitted → 400, archived or deleted → 404, same truck twice on a day → 409); the browser refresh is a convenience, never the guard. Not changed: Load Details renders from the client copy and may show a stale snapshot until the next poll — every button on it is server-validated (MINOR, documented). Tests: browser two-tab block (Quick Assign, customer form, fleet row, Edit PO, stale Approvals and Purchase Orders); e2e §56.
- **I10. Rejected loads have no bucket.** `boardBucket` has no rejected case, so a rejected load shows as In Progress / Assigned on Dispatch and Calendar; only Load Details prints the raw word. (Verified: `boardBucket` source.)
  **Status: FIXED 2026-10-05** (Persistence #5 commit). `boardBucket` has a `rejected` case (a rejected load that still has a driver); Dispatch, Calendar and the day summary label and count it; a rejected load with no driver is Unassigned on both. Test: e2e §56.
- **I11. "Ready to Bill" is five rules.** Tile and amount: approved and `billStatus 'ready'` (includes loads on an unsent or failed batch); the Ready to Bill table drops batched loads in the browser while its footer keeps the server total; the billing strip uses a third rule on the stale copy; the board bucket uses `billStatus !== 'billed'`; Reports use approved and ready. After a failed send the tile shows more loads and dollars than the table. By code reading.
  **Status: FIXED 2026-10-05** (Persistence #5 commit). One rule on the server, `isReadyToBill(l)` (approved, `billStatus 'ready'`, not voided, not on a batch), used by `/api/ready-to-bill` (items and totals), the Dispatch tile and its amount, the Reports total and the office fingerprint. A load on an unsent batch is counted nowhere as Ready to Bill; on the board it stays "Approved" (bucket `ready-to-bill`, which means approved-and-not-yet-billed) and the tile, the strip and Reports agree. Test: e2e §56 (four approved loads — plain, batched, voided, billed — move the three counts by exactly one; the tile's amount is the strip's total).
- **I12. Dispatch counts mix scopes and words.** "In Progress" (tile: any trip or delivery on the selected day) vs "N hauling" (drivers with an open trip); "Drivers Free" tile counts done-for-the-day drivers, the section's "free" does not; "Trucks Free" excludes in-service trucks, the section includes them. The attention row is "about now" but Unassigned, In Progress, Missing Info and Conflicts count the selected day, so planning tomorrow changes the nav badge. By code reading.
- **I13. The drivers' day panel is folded with no tile pointing at it**, hiding "stale open day — driver is blocked" and "closed by the office — confirm ending", the latter holding hours and miles out of billing until confirmed. By code reading.

### Billing guards with gaps
- **I14. Mark Billed can leave half-applied state.** Verified by code: the route sets `billStatus 'billed'` on eligible loads, then returns 409 when any selected load is on a batch — before `saveData` and before the audit entry. The in-memory change is written by the next unrelated save, silently.
- **I15. Customer default rates are billed silently, and $0 is a valid price.** Verified by code: `resolveCustomerRate` falls back to the default ($25/ton) with `isDefault: true`; `customerRateIsDefault` is stored on the load and read by nothing in billing; Ready to Bill shows a `rateLabel` but no "default" or "unconfigured" flag; a $0 customer price is accepted and invoiced (`amount: r * qty * n`, `unconfigured: false`). SPEC rule 6 says "report unconfigured instead of a silent number".
- **I16. Deleting a PO ignores its archived loads.** Verified by code (`DELETE /api/pos/:id` checks `store.loads` only). A partly billed PO (billed loads archived, the rest live and never started) can be deleted; the archived invoiced loads lose their PO and can never be unarchived (orphan 409).
- **I17. The invoice-field freeze ignores archived loads.** Verified by code (`hasApproved = store.loads.some(...)`): once a PO's billed loads are archived, its PO number, customer and address can be edited again although they are on an invoice.
- **I18. A load billed by hand (or vendor-billed) can be voided, and voided loads release their ticket numbers.** By code reading: void refuses only batch/QuickBooks-billed loads; ticket uniqueness skips voided loads; a re-run load with the same tickets can be billed again. Unvoid has no ticket conflict check.
- **I19. Retry and Void on the same batch can overlap.** By code reading: both are exempt from the write lock, Retry never sets `syncing`, and Void's guard looks only for `syncing`; Void releases every load in `b.loadIds` without checking `l.billingBatchId === b.id`. Needs two office users within one QuickBooks round-trip.
- **I20. QuickBooks state edges.** By code reading: Retry adopts an invoice that was voided in QuickBooks (`getEntity` returns voided invoices); a batch can sit in `syncing` until a restart (no timeout on the token refresh, `syncingSince` unused); reconnecting QuickBooks to a different company keeps cached customer, vendor, item and account ids from the old realm; void calls QuickBooks before anything is persisted, so a failed save afterwards leaves VBT "sent" while QuickBooks is voided.
- **I21. A failed save from a GET route rolls back everyone.** Verified by code: `/api/data` and `/api/reports` save when they reconcile PO statuses, outside the write lock and without a request context; `rollbackStore` then restores the last good copy, wiping a concurrent locked request's unsaved change while that request still reports success. Only under a database failure at the wrong moment, but it is the one hole in the Phase 1.6 promise.
  **Status: FIXED 2026-10-05** (Persistence #4 commit). Audit of every read path, every write's response and every store mutation outside the write path. Reads never save: `/api/data` and `/api/reports` still correct a stale, derived PO status in memory (documented self-heal) but no longer write; the boot path does the same once; the QuickBooks OAuth callback is the one GET that saves (a redirect carrying a write; it runs with the exempt routes' context). A save with no owning request (a background notification flush, the five-minute GPS flush) can no longer roll the store back — `rollbackStore` requires a request context, because the only unsaved change a rollback may undo is the failing request's own. Reads wait for the writes in flight when they arrive (`writeLockTail`), so a GET describes committed state and never a value still being saved that may yet roll back (reproduced: a GET 0.3 s into a write whose save then failed returned the uncommitted value; now it waits and returns the committed one). The browser applies `/api/data`, `/api/today` and `/api/calendar` answers in request order, dropping a slow older answer that lands after a newer one. Every mutating handler awaits its save before answering success (scan of 141 handlers; the only matches were test hooks), responses return live objects, the store is one row so a save is all or nothing. Not changed, reported: screens other than Dispatch and Calendar render from the client copy and are not repainted by the poll (I9, screen-consistency group); the office version includes the Linxup version so GPS movement triggers full reloads on other tabs (I36, polling group; read-only, performance); file mode writes `data.json` in place without a temp-and-rename (dev only). Tests: e2e §55, Postgres section (read after restore, after a restore whose audit save failed, after a write on the restored state), browser (held older GET then newer GET; save then read).
- **I22. Hour/mile customers.** By code reading: the segment measure is billed once on the segment's first load; if that load is voided or ton-priced, the hours and miles are never billed; a segment can be edited or reopened after one of its loads was invoiced.

### Persistence, identity and two office users
- **I26. The write lock is released when the client disconnects.** Verified by code (`res.once('close', () => { … release(); })`): a phone that drops the connection mid-save lets the next locked request run concurrently; if the first save then fails, the rollback wipes the second request's change while it reports success.
  **Status: FIXED 2026-10-01** (Persistence #1 commit). The lock is acquired by the `/api` middleware for every non-GET request that is not exempt (one promise chain, FIFO), and is now released when the handler ends its response — `res.end` is wrapped, and it runs whether or not the client is still connected — or after the 30 s fallback; the socket's `close` event no longer releases it. Reproduced before/after with the save-mode hook's new `delayMs`: a request that drops its connection 0.5 s into a 1.5 s save that then fails, followed at once by a second write. Before: the second write entered during the first's save, reported `200`, and its change was gone from memory and disk (the rollback took it). After: the second write waited for the first save to settle and roll back, then landed in memory and on disk, and its answer carries it. Still true: a handler that never answers releases after 30 s (the one way the lock can be released while work is in flight — a hung database write; documented, not changed). Test: e2e §46, two checks.
- **I27. A restore can undo itself, and backups are one step deep.** Verified by code: `lastGoodJson` is refreshed only on successful saves and at boot, never by `restoreFromBackup`; if the audit save right after a restore fails, memory rolls back to the pre-restore data and the next save writes it over the restored row. `store_before_restore` is written but cannot be restored through the API. `store_prev` is rotated by every save made for a person (each driver tap, each of the three saves in a QuickBooks send) and `store_boot` is overwritten on every boot, so the undo window after a wrong delete is seconds.
  **Status: FIXED 2026-10-01** (Persistence #2 commit) for the "undo itself" mechanism and the API gap; the backup depth is unchanged by design. Path: `POST /api/admin/restore` → `restoreFromBackup` → `queueWrite`. Mechanism found and reproduced on a throwaway Postgres: the restore wrote the row and reloaded memory from the database, but never refreshed `lastGoodJson`; the audit save right after it failed, `rollbackStore` put the pre-restore data back in memory while the row held the restored data, the route answered 409, and the next ordinary write saved the pre-restore memory over the restored row. Now a restore runs inside the one write queue every save uses (no interleaving with a save in flight; a save queued after it serializes the restored store), refuses while a QuickBooks send is in flight (its batch lives in memory), parses and normalizes the backup before anything is written, writes `store_before_restore` and `store` in one transaction, and only after the commit replaces memory in place, makes the restored JSON the rollback point and clears the lock state — no reload from the database, so a read failure cannot leave the process locked with a restored row. A failed restore changes nothing (row, backups, memory, rollback point) and answers 409 `restored:false`; a committed restore whose audit save fails answers 200 with `auditSaved:false` and a warning, memory rolled back to exactly the restored state. `store_before_restore` is restorable, so a restore is undoable. Tests: Postgres section, 12 checks (success, failed parse, unknown and missing backup, write refused during the restore, the I27 mechanism, the next write after each, repeated restore, queued concurrent writes, QuickBooks send in flight, static guards).
- **I28. Seed records come back on every boot.** Verified by code: the seed vehicles and seed drivers are re-added when missing, and the seed logins are re-inserted with their default passwords (`ON CONFLICT DO NOTHING`) if they were deleted. A driver the office removed reappears, active, after a redeploy.
  **Status: FIXED 2026-10-05** (Persistence #7 commit). Reproduced: hard-delete the seed truck Truck #2B and the seed driver Carlos (no history), restart → both back; on Postgres the seed login came back too, with the default password. Now the seed trucks are planted only onto a store with no vehicle (first boot, or a legacy fleet array holding only driver rows), the seed drivers only onto an empty roster, and the seed logins only into a users table with no login for the company. A removed truck, driver or login stays removed across restarts. Tests: Postgres block (truck, driver and login absent after a restart; the row agrees).
- **I29. Quick Assign resends the board's resolved yard and re-prices the load every time.** Verified by code: the sheet sends `{driverId, truckUnitId, yardId, trailerId}` from the board snapshot, where `yardId` is the resolved pickup (which can be the driver's last actual yard); the server treats any `yardId` as a yard change, clears `actualYardId` and re-prices `vendorRate` from today's list. Changing only the driver silently turns the last actual yard into the planned yard; with two users, a 12-second-old board reverts the other user's yard and trailer.
- **I30. Whole-record forms are last-write-wins.** By code reading: the customer, truck, driver and trailer forms send the entire record and nothing checks a version; office A sets a driver Off, office B saves a stale form a moment later and the driver is assignable again. The PO form sends only changed fields and is safer.
- **I31. Load ids rewind after a restore.** Verified by code: `LOAD-<n>` comes from a counter inside the store, so restoring an older snapshot reuses ids; the `driver_locations` table keyed by load id survives the restore, so a new load's trail shows the discarded load's points. PO ids are timestamps and are not checked for uniqueness.
  **Status: FIXED 2026-10-01** (Persistence #3 commit). Every generator audited: `LOAD-<n>` and the auto PO number `PO-<n>` (store counters), the PO id `PO-<ms>`, `genId` (`BB`, `VB`, `FS`, `SH`, `QBL`), audit `AUD-`, archive `BATCH-<ms>`, customers `cust-`, prices `price-`/`cprice-`, notifications `NTF-`, trucks and trailers (slug plus suffix), vendors (name slug, duplicate-checked). Reproduced before/after: on Postgres, restoring `store_prev` after three creations handed out `LOAD-3` and `PO-1003` again; in file mode a creation whose save failed left its id to the next creation. Now the two counters also have high-water marks outside the row — in memory, never rolled back, and in their own `dispatch_data` row `id_high_water` (file mode `data-ids.json`) written in the same transaction as every save and never rotated, backed up or restored; a new id is the max of the store counter, the mark and the highest id on record (live or archived), reconciled at boot, after a restore and before every id. A failed save consumes the id it took. The PO id and the archive batch id are bumped past any id on record; `genId` is `<prefix>-<ms>-<n>` with a per-process sequence and an existence check for store-resident records; trucks and trailers re-draw their suffix until unique. Formats are unchanged. Tests: e2e §54 (sequential, failed save, ten concurrent creations, static guards), §23 (a legacy file whose counter was rewound below its records boots and issues past them), Postgres section (restore, repeated restore, failed save, restart, the high-water row only climbs).
- **I32. Several routes change the store and then return a validation error without saving or rolling back** (customer rename then 400 on billing basis; truck and trailer number then 400 on status; costing units and rates; PO notifications; driver roster then 500 on the login update). By code reading. The half-applied change is written by the next save from anyone. For the customer case the list shows the new name while POs and prices keep the old one, and an "actual tons" customer is then looked up by name and billed on planned tons.
  **Status: FIXED in part 2026-10-05** (Persistence #6 commit). Reproduced: a manual bill of two loads where one sits on a batch answered 409 and still marked the other load billed in memory (persisted by the next unrelated save, with no reference and no audit entry); a customer update with a bad billing basis answered 400 and still renamed the master while its POs kept the old name. Both routes now decide before they change anything. Still as described, documented as MINOR: truck and trailer number/type edits refused on a later field, the notification settings, costing units and rates, and a PO create that refuses after auto-adding its customer.
  **Status: FIXED 2026-10-05** (Persistence #7 commit) for the remainder: truck and trailer updates, notification settings (a refused "turn on" had emptied the contact list), costing units and rates, the PO create's auto-added customer (now added only after every check passes), the driver update (login row first, roster after) and the driver's Stop-early submission (the trip at the jobsite is stamped completed only once the submission is accepted). Reproduced each before the change; e2e §58 covers each after it.
- **I33. A voided load can be left pointing at an archived PO, then unvoided and billed with a blank customer.** By code reading: archiving ignores voided loads when deciding a PO is fully billed; unvoid never checks the PO; Ready to Bill and the batch builder fall back to `customer ''`, `poNumber ''`.
  **Status: FIXED 2026-10-05** (Persistence #6 commit). Reproduced: void one of two approved loads, archive (the PO leaves with its billed load, the voided load stays live), unvoid → 200 and a Ready to Bill row with no PO. Unvoid now refuses (409 `po_archived`) until that history is unarchived. Archiving itself is unchanged (a voided load is never archived).
- **I34. The load-level ticket photo is the first trip's only.** By code reading: approval and the QuickBooks attachment use the load-level photo; a corrected ticket updates only the trip; multi-trip loads attach one photo.
- **I35. A customer rename does not reach billing batches or open freight segments.** By code reading: an unsent batch keeps the old name and may create a second QuickBooks customer; the segment key keeps the old name and the driver's next arrival is refused with "Finish the Old freight before starting New's".
- **I36. Office browsers re-download the whole dataset every 12 s while any truck moves.** Verified by code: the office version hash includes the Linxup version, which changes on every position; on any tab other than Dispatch or Calendar a changed version triggers a full `/api/data` reload (every load with its inline photos when Supabase is not configured). Introduced by L1; cheap to fix (telemetry should not bump the dataset version).
- **I37. The browser's local date decides "today" for New PO and Move Date.** By code reading (`ymd(new Date())` for the New PO default and the Move dialog's minimum); the board and calendar use the server's Pacific date. A dispatcher in another zone, or anyone after 11 PM, files tonight's job on tomorrow.
- **I38. Validation gaps on create (API only).** By code reading: a PO can be created with no loads; `loadsAssigned` 0 or negative is stored and the load holds its driver and truck forever (start-trip refused); the date format is unchecked on create; a whitespace customer becomes blank; an auto-added customer survives a refused PO (duplicate number, unknown truck).
- **I39. Deleting a started load leaves its freight segment pointing at it**, and with I22 the segment's hours and miles are then never billed. By code reading.
- **I40. A rollback reaches a QuickBooks send in flight.** Verified by probe (Persistence #6 audit). The QuickBooks batch and vendor-bill routes run outside the write lock on purpose and hold their batch, its loads and the connection object across a seconds-long call; a LOCKED request's failed save meanwhile rolls the store back, and `replaceStoreContents` makes every object in the store a fresh copy. Reproduced: (a) rollback during the call → QuickBooks answers, the invoice is recorded on an orphan; the store's batch stays `syncing` for good (send 409, void 409, retry 400, restore refused) while the loads read billed and the response said "sent"; (b) rollback between the answer and the send's save → batch `syncing`, loads back to `ready`, invoice live in QuickBooks, response "sent"; (c) the database refuses the save that marks the batch `syncing` → nothing sent, batch stuck `syncing` until a restart.
  **Status: FIXED 2026-10-05** (Persistence #6 commit). The records an exempt route works on are pinned for the request (`pinExemptRecords`: the batch or bill named by the URL, the live loads it names, `store.qbConnection` for the QuickBooks routes); `rollbackStore` puts those very objects back into the restored store, so the route's state — its recovery record, which keepOnFailure already keeps on its own failed saves — survives another request's rollback. The customer and vendor QuickBooks-id mappings are looked up again by id after the call. A refused `syncing` save puts the batch or bill back as it was and answers 503 (both send routes). Tests: e2e §57 (three reproductions, memory = disk), Postgres block (memory = row).
- **I41. The notification log's background save inherits the request context and can roll the store back.** Verified by probe. `notifyLoadEvent` sends mail in a promise chain started inside the handler; the chain inherits the handler's `{ keepOnFailure: false }` context, so when its `saveData({ rotatePrev: false })` fails (long after the lock was released) `rollbackStore` replaces the whole store — sweeping away whatever the request that arrived meanwhile has changed and not yet saved, which then answers 200 with its change gone. Reproduced: assign (notifications on) → background save refused → a PUT arriving meanwhile answers 200, its note is gone from memory and disk, one rollback counted.
  **Status: FIXED 2026-10-05** (Persistence #6 commit). The mail sends run under `requestCtx.exit`, so the background save has no owning request and never rolls back (the Persistence #4 rule); a failure is logged and the next save carries memory forward. Test: e2e §57.
- **I42. The PO edit's frozen-field guard and the PO delete guard see only live loads.** Verified by probe. A PO stays live while it still has unbilled loads, but its billed loads move to the archive; after that, the invoice fields (customer, PO number, address) could change (200) and the PO could be deleted (200) — the archived loads then point at a PO that is gone (History and Calendar show no PO; the archive batch can never be unarchived, 409).
  **Status: FIXED 2026-10-05** (Persistence #6 commit). Both guards read `allLoadsWithArchive()`: frozen fields 403, delete 403; a note still saves; unarchive works. Test: e2e §57.
- **I43. Reconciliation can match the wrong document.** By code reading, confirmed by unit check. `findInvoiceForBatch` matched the private note with `includes('batch ' + id)`, so `BB-<ms>-1` also matched the note of `BB-<ms>-12` (two batches made in the same millisecond differ only in that last number); and a vendor bill's QuickBooks DocNumber is its id cut to 21 characters, which with a process-wide sequence past 9999 made two bills from one millisecond share a DocNumber, the key `findBillByDocNumber` recovers by.
- **I44. A QuickBooks refusal can lose refreshed login tokens.** By code reading (Persistence #7 scan). `qb.getEntity`, `voidInvoice` and `deleteBill` refresh the stored tokens when the access token is near expiry (qb.js rotates them in place: "caller persists"); the batch and vendor-bill Retry routes then answered 409 ("QuickBooks does not have it") or 502 without saving, and the void routes answered 502 without saving. The rotated tokens lived in memory only until the next save; a rollback before it handed QuickBooks back the retired tokens.
  **Status: FIXED 2026-10-05** (Persistence #7 commit). Those six refusals save the connection first (`saveConnectionQuietly`, quiet because the refusal is the answer). Static guard in e2e §58.
- **I45. A new driver's login row outlived a failed save.** By code reading. `POST /api/drivers` inserts the users row, then changes the roster and saves; if that save failed the roster rolled back but the login row stayed, and adding the driver again was refused ("username already exists").
  **Status: FIXED 2026-10-05** (Persistence #7 commit). A failed save removes the login row it had just created, then answers 503 as before. Static guard in e2e §58.
  **Status: FIXED 2026-10-05** (Persistence #6 commit). The invoice matcher requires the id to end where it ends (`invoiceNoteNamesBatch`, shared with the test fake); `genId` restarts its sequence every millisecond, so an id is never longer than 21 characters. Test: e2e §57 (unit check and static guards).

### Security and operations
- **I23. No session invalidation.** Verified: nothing destroys sessions when a driver is disabled or a password changes; a removed driver keeps a valid cookie until it expires (pre-existing, ASSESSMENT "Missing").
- **I24. Default passwords.** Verified: seed admins joshua / oscar / perla and the five drivers have default passwords unless the `*_PASS` variables were set at first boot; there is no production guard. README's "Users" block lists `manager / vbt2025!`, which does not exist.

### Lost in the consolidation (b753d39) and not replaced
- **I25. Board search and filters.** The old Board had "Search PO / customer / job" plus driver, material, customer and city filters. Nothing on Dispatch, Calendar or Purchase Orders can find "PO 45021", one customer's loads or one driver's loads today (Ready to Bill and Duration Analytics keep their own filters). The per-driver columns and the driver-strip filter are also gone; the Calendar's Day view groups by driver but has no assign actions. Day navigation, month view (now the Calendar, minus the per-driver grid), Quick Assign variants, drag-drop, Load Details, reports, exports and notification settings all survive. No server route was lost.

---

## 3. MINOR — UI, polish, usability

- **M1. 51 native browser dialogs remain** (25 `prompt`, 20 `confirm`, 6 `alert`): void load / PO loads, delete load / PO, restore load, odometer-below-last, stop early, batch void (where Cancel means "I already voided it in QuickBooks", not abort), restore backup, close day / segment, add driver / truck / trailer (the driver's initial password typed into a visible prompt), add / edit vendor, set location ("1 = geocode … 4 = clear"). The in-app `askDialog` already exists for conflicts and approval.
- **M2. Status vocabulary.** "Completed" means billed on Dispatch, trips finished on the Fleet Map, approved in Reports; Calendar says Approved / Billed where Dispatch says Ready to Bill / Completed; the billing strip's "Approved" counts billed loads too. One glossary would do.
- **M3. Two screens are both called "Drivers & Trucks"** (the board section and the roster tab). "Usual driver" on the truck and "usual truck" on the driver are two fields for one relationship; only the driver's field is read.
- **M4. Quick Assign opened from the Calendar or Load Details for another day swaps the board's data to that day and Cancel does not swap it back**; the next tile click repaints that day under "Planning".
- **M5. The QuickBooks preview's Send button stays disabled ("Sending 1/1…") after a successful send until the page reloads.** Pre-dates the consolidation.
- **M6. Purchase Orders screen** has no New PO button, no search, and shows counts without the loads; the New PO date defaults to today even when the board or calendar is on another day.
- **M7. Linxup thresholds and renderers.** Phone GPS is "stale" at 5 minutes on the map, Linxup at 10; four separate renderers draw the same telemetry (board line, Load Details panel, approval line, map card).
- **M8. `reqAdmin` equals `reqMgr`** (no manager accounts exist today, so moot) while the Default Rates screen text says "Admins only"; `GET /api/tickets/check` tells a driver another load's PO, customer and driver; `shiftOwnedBy` lets any office user end a driver's day without the reason `/close` requires (API-only).
- **M9. Archived calendar items open History, where the single load cannot be viewed** (accepted for now). Missing jobsite pins are reported in several places with no button to set them there.
- **M10. "Missing Info — cannot proceed"** counts gaps that can be approved anyway; "Telemetry — Linxup disagrees" also counts merely stale GPS.
- **M11. Material Costs shows default prices as real**; `PUT /api/costing/units` can half-apply on a later validation error.
- **M12. Carried-over work keeps its original date**; pulling it to today takes Details → Move Date with a required reason.
- **M13. Naming in the data API.** `/api/data` returns `trucks` (the driver roster) and `fleet` (the vehicles); `load.pricePerUnit` and `load.vendorRate` are the same value stored twice; PO status is computed in three slightly different places; `load.gps` is not reset when trip 2 starts (nothing reads it).
- **M14. Snapshots that go stale after a rename:** `load.driverName`, `load.vendorName`, `po.pickup`, `trip.actualYardName`, the segment origin; vendor delete checks live loads' `vendorId` only, not trips or archived loads.
- **M15. Reports and logs use UTC or the host's zone** for the weekly trend, "billed this month" and the audit-log date filter; trip times hard-code Los Angeles instead of `OPERATING_TZ`; the telemetry panel shows browser-local times next to Pacific flag text.
- **M16. Dev-mode writes are not atomic** (`data.json` and `telemetry.json` written in place); `/healthz` serializes the whole store on every probe.

---

- **Persistence #6 audit — documented only (MINOR):** file mode writes `data.json` and `data-ids.json` in place, not via a temporary file and rename (dev only; a crash mid-write is caught at boot because the row will not parse); the dev `data.json` → Postgres migration marks the store loaded even when its first save failed; `locationHandler` answers 500 (not 503) with the pre-rollback coordinates when its save fails; the QuickBooks disconnect route saves in a `finally` and answers success even if decrypting the old token threw; the driver delete and update routes write the `users` table before the store save (a failed save leaves the login row changed); vendor delete ignores voided and archived loads, planned yards and vendor bills; a load delete does not recompute its PO status (the next reconcile does); unvoid does not re-check ticket uniqueness; a truck number can be edited to a duplicate; unarchive drops an archived copy whose id is already live; the `id_high_water` row is overwritten, not max-merged, and a failed read of it is only warned about; audit, notification and sync-log ids have no existence check (unique only through the clock and the per-millisecond sequence); an exempt route's audit and sync-log lines written before another request's rollback are lost from the log; a locked request whose change was already written by an exempt save (GPS flush, QuickBooks route) and whose own save then fails answers 503 although the change is on disk — only the driver update route has an await between its change and its save, and it is idempotent; the write lock's 30 s fallback (documented, unchanged by decision).

- **Persistence #7 audit — documented only (MINOR / by design):** the auto PO number is consumed by a PO create that is then refused (a gap, never a reuse — Persistence #3's rule); `ensureNotifyCfg` and the legacy trip migration normalise a record in place before a route refuses (defaults only, no business change); the reconcile step counts an attempt before it refuses and saves it, while its message says "nothing changed"; a `driver-location` ping and a Linxup webhook arriving during a locked write are unaffected by it (the ping's memory-only point can be swept by a later rollback until the next 5-minute flush); two dispatchers queuing two loads for the same idle driver both succeed by design (a driver's next job is queued, the conflict rule is for a driver mid-haul or a truck under another driver); a hung database connection (socket open, server silent) has no statement timeout and would stall the write queue until the connection times out — not reproduced here, FUTURE.

## 4. FUTURE — worth improving, not necessary now

- **F1. Vendor cost is priced on planned tons (25 t × trips), never the scale ticket's net tons**; vendor bills will not match supplier invoices based on weight. Confirm with the owner which is wanted.
- **F2. Seeded vendor prices (e.g. Vulcan 3/4 Rock $38, "a starting set") resolve as real prices**, so they pass the "no default-rate vendor bill" rule. Confirm production data was entered, not seeded.
- **F3. The driver's day is front-loaded** (four odometer entries minimum, shift/segment blocks mid-haul) — ASSESSMENT §3 and §5.3, unchanged; decide with the drivers before simplifying.
- **F4. Vendor bills have no screen** (API only).
- **F5. Photos.** With Supabase unset, ticket photos and signatures are stored inline as base64 inside the one store row; confirm production has `SUPABASE_URL` and key.
- **F6. Id generation.** `LOAD-<counter>` with no uniqueness check and a counter that resets to 1 if missing; unarchive silently skips colliding ids. Harmless today, worth a guard before any import or merge of data.
- **F7. Linxup L3** stays paused (see LINXUP-READINESS-REVIEW.md §6); alerts live only in the 30-day webhook log until then.
- **F8. Hour/mile billing** deserves its own design (I22) rather than piggybacking on the segment's first load.
- **F9. Optimistic concurrency** (a version on each record, refused when stale) for the whole-record forms (I30), and a deeper backup ring than one `store_prev` (I27).
- **F10. Retention** for shifts, segments and the archive (never pruned), and a size guard on the single store row.

---

## 5. What was checked and found sound

- Two concurrent assigns of one vehicle to two drivers: one 200, one 409 (write lock plus conflict check). Driver acting on another driver's load: 403. Driver tampering with progress through the generic update: 400. Trip steps out of order, twice, without ticket, delivered without photo: all refused.
- Approve a pending or rejected load, approve twice: refused. Bill before approval: nothing billed. Concurrent Mark Billed: one bills, the other bills nothing, a single reference kept. Batch a manually billed load: refused. Void of a manually billed load keeps `billed` through unvoid and never returns to Ready to Bill.
- Delete a PO or load with billed or submitted work: 403. Send twice, retry with an invoice id, boot normalisation of `syncing` → `failed` + may-exist, DocNumber + note lookup on retry: present and tested.
- Calendar and Dispatch build every row with the same `boardLoadRow`; a PO date change moves the calendar item at once; archived loads appear once, flagged; voided loads are excluded.
- Linxup: `linxup.js` has no reference to the dispatch store; the calendar route reads no telemetry; the only three store fields that carry Linxup data are written by manager routes; telemetry never alters a date, assignment, status, approval or billing field (probed again this session).
- Costing: one engine (`computeAmount`) prices invoices, previews and profitability; unpriceable lines block batch creation and send; vendor bills refuse default and zero rates.
- No dead click handlers; every logged-in route a driver can call checks ownership; no server route was lost in the consolidation.

---

## 6. Proposed order of work

1. **C1 — Stop-early count.** Server clamps the delivered count to completed trips; the dialog only confirms; checklist blocks a mismatch. Half a day, with a regression test on the exact probe above.
2. **C4 — Actual tons from completed trips only**, and the loaded-but-undelivered ticket shown at approval. Small; same day as 1.
3. **C3 — Whitelist the office load update.** Small; closes a latent corruption path.
4. **C2 — QuickBooks ambiguity.** Mark every network-reached mutation uncertain unless a definitive validation error; Void of a may-exist batch (and vendor bill) runs the lookup first. Add the same for I19 (Retry sets `syncing`; Void checks `l.billingBatchId === b.id`) and I14 (Mark Billed validates before it writes). One to two days, with tests using the QuickBooks fake.
5. **I21 / I26 / I27 / I31 / I32 — Persistence.** Never save from a GET; keep the lock until the handler finishes, not until the socket closes; refresh the rollback point after a restore and make `store_before_restore` restorable; derive the next load id from the highest existing one; validate before mutating in the routes listed in I32. One day.
5a. **I28 / I36 / I38 — Boot, polling and create validation.** Seeds only on an empty store (never re-add deleted drivers or logins); telemetry no longer bumps the dataset version; `POST /api/pos` validates date, count and at least one load, and removes an auto-added customer on refusal. Half a day.
6. **I9 / I10 / I11 — Screens agree.** Refresh re-renders the current tab and tabs reload on entry; a `rejected` bucket; one Ready-to-Bill rule shared by tile, table, strip and reports. One day.
7. **I1 / I2 / I3 / I4 / I5 — The driver's real state.** Driver and truck state from open work across dates (carried-over counts as busy); a driver cannot start a second trip while one is open; Reject re-runs the conflict check and says so; a visible "day on Truck #12, load on Truck #2" warning on the board, map and Linxup evidence; a maintenance change warns when the truck is mid-haul. One to two days, with scenario-day coverage.
8. **I6 / I7 / I8 / I29 / I37 — One rule per action.** Reject clears the submission; Move-all limited to the day with the full assign payload; Move Date and Edit PO date share the PO-EDITING rule; Quick Assign sends only what the user changed (no re-price unless the yard was chosen); New PO and Move Date default to the server's date. One day.
9. **I15 / I16 / I17 / I18 / I22 / I33 / I34 / I35 / I39 — Billing edges.** Default-rate and $0 flags in Ready to Bill and the batch preview; PO delete, PO freeze and archive decisions look in the archive and at voided loads; voiding a hand-billed load records the reference as voided and keeps its tickets claimed; attachments and approval use the trip tickets, not a first-trip copy; a rename reaches batches and segments; hour/mile billing moved off "first load". Two days.
10. **I13 / I12 / I25 — Dispatch usability.** A tile for the drivers' day panel when it needs a person; consistent counts and scopes; search by PO / customer / driver on Dispatch and Calendar. One day.
11. **I23 / I24 / I30 — Sessions, passwords, two users.** Invalidate sessions on disable or password change; refuse default passwords in production; fix README; forms send only changed fields. Half a day to one day.
12. **M1 — Native dialogs → `askDialog`**, then the rest of §3 as time allows.
13. **Then** decide F1/F2 with the owner, and only after 1–9 are green: Linxup L3 design.

Items 1–5 are the ones I would not deploy a new billing cycle without.
