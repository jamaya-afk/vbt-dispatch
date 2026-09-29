# VBT Dispatch

Clean rebuild — focused on the essentials.

## What it does

- **Manager** creates POs, assigns drivers, sees today's board, approves submitted loads, marks loads as billed
- **Drivers** see their assigned trips with PO/customer/material info, follow guided flow: Start Trip → Arrived at Pickup → Upload Ticket Photo → Customer Signature → Complete Delivery
- All steps auto-capture GPS + timestamps
- Loads must have ticket photo + signature before delivery is allowed
- Approved loads are locked and immutable
- Archive billed loads into the database's history with one click

## Users

```
manager / vbt2025!
beryle / beryle123
matthew / matthew123
rigo / rigo123
leonardo / leo123
carlos / carlos123
```

## Setup (Railway)

1. Add a Postgres database to your project (+ New → Database → PostgreSQL)
2. Reference `DATABASE_URL` from Postgres → your app's variables
3. Deploy — data persists forever

## The office day

- **Dispatch** is the one board. Every status on it comes from the server
  (`/api/today`), computed once with the same rule that refuses a conflicting
  assignment: loads Unassigned → Assigned → In Progress → Awaiting Approval →
  Ready to Bill → Completed; drivers Available / Assigned / In progress / Done /
  Off; trucks Available / Assigned / In progress / In shop. The attention row
  (unassigned, in progress, awaiting approval, ready to bill with its amount,
  missing information, conflicts, carried over, free trucks and drivers) is
  actionable: each tile filters the board or opens the screen that works it.
- **Quick Assign** is Driver → Truck → Yard → (Trailer) → Confirm, from a card
  or by dragging a load onto a driver. A conflict (driver mid-haul elsewhere,
  truck or trailer on another driver's load) is shown in the app with Cancel
  or go ahead; a go-ahead is written to the audit log with its reason.
- **Approve** confirms five facts before a load locks: Driver, Truck, Pickup
  yard, Ticket, Delivery. A ⚠ item can be approved anyway, and what was
  missing stays on the load and in the audit log for billing to see.
- **Edit PO** changes the order; the work follows only where it is still
  operational. The rules are in [PO-EDITING.md](PO-EDITING.md). "Add a load"
  puts more work on the same order with the same checks as the New PO form.
- **Billing** reads Submitted → Approved → Ready to Bill → Billed → Archived.
  Ready to Bill prices each load with the invoice engine. Manual billing asks
  for the outside invoice reference; its undo is Unbill in History, with a
  reason. A load billed through QuickBooks is released only by voiding its
  batch. Unarchive brings an archive batch back exactly as it was.
- **A failed save leaves nothing behind.** If the database refuses a write,
  the store rolls back to what is on disk and the caller is told; mutating
  requests run one at a time so a rollback never takes another change with it.
- **Linxup beside VBT.** With `LINXUP_WEBHOOK_TOKEN` set, Linxup's Push API
  posts truck positions to `/api/linxup/position` (and device status/update
  messages to their own paths). A truck is linked to a tracker by id on
  Drivers & Trucks; the board and the Fleet Map then show the truck's own
  state (Moving / Idling / Stopped / At place / Stale / Offline) next to
  VBT's, with the source named ("Linxup GPS" vs "Phone GPS"). Linxup's driver
  is shown as information; a disagreement with VBT's assignment is an
  attention item, never a reassignment. Telemetry lives in its own tables
  (`linxup_*`), never in the dispatch store. See `LINXUP-INTEGRATION.md`.
- **Linxup as evidence.** Geofence visits, stops, Linxup vehicle trips
  (ignition cycles, not VBT trips) and usage hours are kept by event time and
  read beside each VBT load: Load Details shows a LINXUP TELEMETRY section
  (what the truck did at the yard and near the jobsite, its activity, and a
  timeline with the driver's taps between Linxup's entries, every line naming
  its source); the approval dialog gets one evidence line per trip; the board
  shows the truck's last geofence. A yard is mapped to its Linxup geofence on
  Vendors (a name match is only suggested). Disagreements — driver, pickup,
  jobsite, location — are attention items. Telemetry never completes, arrives,
  approves, assigns or bills anything.

## Files

- `server.js` — backend (Express, one in-memory store persisted as one Postgres row)
- `qb.js` — QuickBooks Online client
- `public/index.html` — frontend (single page app)
- `public/logo.png` — VBC logo
- `ASSESSMENT.md` — current state, roadmap and status; `PO-EDITING.md` — PO editing rules; `SPEC.md` — master specification and rules

## Tests

Three suites, run one at a time (they share `data.json` and stop any running
server):

```
npm test                      # bash test-e2e.sh — API end to end (port 4600)
PORT=4630 VBT_TEST_HOOKS=1 node server.js &   # then:
node test-browser.js          # headless Chromium, office and driver screens
npm run test:scenario         # a five-truck day, start to billing to restart
```

## Data

Postgres (the Railway Postgres service, via `DATABASE_URL`) is the single
source of truth for every operational record: POs, loads, trips, drivers,
trucks, trailers, vendors and yards, saved coordinates, GPS points, approvals,
billing batches, QuickBooks sync history, void/audit history and customers.
Supabase Storage holds ticket and signature photos only. There is no
spreadsheet export or sync; archiving billed loads moves them into the
database's history where reports still read them.

Field records follow the paperwork: a **load** is one driver's assignment on
a PO (material, planned count, truck, trailer); each **trip** is one physical
delivery and carries its own **ticket**, captured once when the driver taps
Loaded at the yard (supplier scale ticket with net tons and photo, or a VBT
internal ticket). Ticket numbers are unique across every trip on every load,
live or archived. A load reports **planned tons** (quantity-per-load rule,
25 t by default) and **actual tons** (sum of confirmed ticket tons) side by
side; invoices use planned unless the customer's billing basis is set to
"actual", and an actual-basis load with a delivered trip that has no ticket
tons is never priced silently.

Above the load sit the driver's day and the billable window:
**Shift → Freight Segment → Load → Trip.** A **shift** is one driver's whole
day (truck, trailer, start/end odometer, breaks, truck changes, pre-trip
inspection); daily miles come from its odometer legs, one per vehicle. A
**freight segment** is one continuous customer-billable operation, opened at
the first pickup for a customer and jobsite with a single odometer reading and
closed only by an explicit "Finish freight" (never by a delivery); it holds
one or more loads and their trips, and its miles and hours are counted once,
never split across loads. VBT yard → pickup yard repositioning is outside
every segment. Billable miles are the segment's, daily miles the shift's, and
non-billable miles the remainder, always derived. Ton customers bill from
trip tickets; hour and mile customers bill from closed segments. A segment
locks when all its loads are approved; corrections go through the existing
void path. The Daily Log and Freight Bill are print pages rendered from these
records on request, marked DRAFT until final.

## QuickBooks Online Integration

Approved loads can be batched and sent to QuickBooks as customer invoices
(receivables) and vendor bills (payables). Loads only enter QuickBooks after
admin approval AND an explicit "Send to QuickBooks" click; nothing is synced
automatically.

### Workflow

1. Driver completes load → manager approves → load is locked and lands in **Ready to Bill**.
2. In **Ready to Bill**, filter by month / customer / city / PO / material / driver, select approved loads.
3. Click **Preview Invoice** to see how loads will be grouped (one invoice per customer + PO + jobsite).
4. Click **Send to QuickBooks**. The app:
   - Finds or creates the customer in QuickBooks.
   - Creates one invoice per group, with line items grouped by material.
   - Includes PO number, jobsite, delivery date range, and internal batch ID in the memo.
   - Saves the QuickBooks invoice ID + number back into our database.
   - Attaches ticket photos and customer signatures to the QuickBooks invoice.
   - Marks the loads `sent_to_quickbooks` so they cannot be re-billed.
5. View, retry failed sends, or void batches in **Ready to Bill → Billing Batches**.

Approved/sent loads are locked from deletion. Mistakes use **Void** (which
reverses the local lock and optionally voids the invoice in QB) — never delete.

### Setup

1. Register an Intuit Developer app at https://developer.intuit.com.
2. In the QuickBooks tab (admin only), click **Connect QuickBooks** to start OAuth.
3. After authorization, the realmId / refresh token are stored encrypted.

### Environment variables

```
QB_CLIENT_ID         # from Intuit Developer Keys & OAuth tab
QB_CLIENT_SECRET     # from Intuit Developer Keys & OAuth tab
QB_REDIRECT_URI      # e.g. https://your-domain/api/quickbooks/callback
QB_ENVIRONMENT       # 'sandbox' (default) or 'production'
QB_SCOPES            # default: com.intuit.quickbooks.accounting
QB_DEFAULT_ITEM_NAME # invoice line item ref, default 'Services'
QB_MINOR_VERSION     # QB API minor version, default 70
QB_ENCRYPTION_KEY    # passphrase used to AES-256-GCM encrypt stored tokens
```

`QB_REDIRECT_URI` must match exactly what is registered in the Intuit
Developer dashboard for the chosen environment. Test in sandbox first; flip
`QB_ENVIRONMENT=production` after the integration is verified.

### Linxup environment variables

```
LINXUP_WEBHOOK_TOKEN        # bearer token Linxup presents on every webhook; unset = integration off
LINXUP_WEBHOOK_TOKEN_NEXT   # optional second token accepted during a rotation
LINXUP_COMPANY_ID           # the account's companyId; messages for any other company are refused
```

Register one URL per message type in Linxup: `https://<host>/api/linxup/position`,
`/device-status`, `/device-update`, `/geofence-event`, `/trip`, `/stop`,
`/usage-hours`, `/alert`, `/geofence-change`, `/media`. The first seven are
interpreted; alerts, geofence changes and media are kept raw for the next phase.

### Sync Log

Every QuickBooks request (customer create/match, invoice create, attachment,
bill create, OAuth connect/disconnect) is recorded with timestamp, related
load IDs, batch ID, QB entity ID, status, and the user who triggered it. View
in **QuickBooks → Sync Log**.
