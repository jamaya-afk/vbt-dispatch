# Valley Best paperwork — what the application fills in, what it calculates, what a person still provides

The sample packet (CamScanner, 14 Sep 2026: Cornelio, Truck #3, trailer 3B,
four Vulcan loads of 3/4" Class 2 Base from the Madera plant to the CCC campus
at North Fork for Dave Christian Construction, then a VBT pre-load of pea
gravel on PO 3298) holds five documents. Three are **VBT's own** (the Daily
Log Book, the Freight Bill/Log, the internal pickup/delivery ticket) and should
be *generated* from the records the office and the driver already create in the
app. One is an **external source document** (the supplier scale ticket) that
VBT captures and links but never recreates. One is a **regulatory attestation**
(the DVIR) that the app prefills but never answers.

The rule throughout: **enter once, carry forward, calculate what is reliable,
leave unknown what is unknown, make the gaps visible.** Nothing here changes
the approved financial rules (delivered quantity = completed trips; planned
tons stay distinct from scale-ticket tons; vendor cost on planned tons unless
the owner changes that rule; batches freeze rate and basis).

Legend for the "How" column: **CARRY** = copied from the authoritative record;
**CALC** = derived by the server from records; **DRIVER** = the driver taps or
types it on the phone; **OFFICE** = the office enters it; **CAPTURE** = read
from a supplier document (photo now, OCR-assisted later), confirmed by a
person; **UNKNOWN** = left blank and flagged until entered.

What already exists in VBT and is reused by every form below:

| Record | Holds |
|---|---|
| Shift (Start day → End day) | driver, truck, trailer, date, start/end time, start/end odometer, breaks, truck changes with odometers, pre-trip inspection (11 items, satisfactory/defects, remarks, signature), daily miles (derived, one leg per vehicle) |
| Freight segment | customer, jobsite, origin yard(s), start/end odometer, start/end time, billable miles and hours (derived), its loads and trips, ticket numbers and tons |
| Load / trip | PO, customer, job, jobsite address, material, planned count, driver, truck, trailer, planned and actual yard, per-trip timestamps (start, at yard, loaded, at job, delivered), per-trip ticket (source, number, net tons, photo), signature (name, image, server time) |
| PO / customer / vendor masters | PO number, customer, job, jobsite, planned yard, material, prices and billing basis, yard addresses and pins |
| Print pages (today) | `Daily Log` (shift: odometer legs, segments, breaks, inspection, events) and `Freight Bill / Log` (segment: loads, tickets, step times, corrections), DRAFT until final |

---

## 1. Daily Log Book

One per driver per day. **Implemented (P1).** Generated on every read from the
shift and the day's segments, trips, tickets and inspection; the driver
reviews it on the phone, adds fuel purchases and signs it once the day is
ended; the office prints it from Today → Drivers' day. See README, "The Daily
Log Book". Only two inputs were new: fuel entries and the end-of-day signature
(server-stamped, with a snapshot and hash of what was signed; later changes
read "changed since signed" and ask for a new signature).

| Paper field | Authoritative source in VBT | How | Still provided by | Validation / exception | Output |
|---|---|---|---|---|---|
| Driver | shift.driverName (roster) | CARRY | — | — | Daily Log |
| Truck # | shift.truckNum (Start day; today's dispatched truck is the default) | CARRY | driver confirms at Start day | truck ≠ the truck on the day's loads → exception on the log and the board | Daily Log |
| Trailer # | shift.trailerNum | CARRY | driver confirms at Start day | — | Daily Log |
| Date, day of week | shift.date | CARRY / CALC | — | — | Daily Log |
| Time start | shift.startAt (server time of Start day) | CARRY | — | — | Daily Log |
| Time end | shift.endAt (server time of End day) | CARRY | — | day still open at print → "DRAFT, day open" | Daily Log |
| Total time (e.g. "11.5 − .5 = 11 hr") | end − start − breaks (shift.breaks) | CALC | driver taps Break / back | no break on a day over 8 h → note "no break recorded" (never invented) | Daily Log |
| Row: Invoice # / PO | load.poId → po.poNumber for each load hauled in the leg | CARRY | — | — | Daily Log |
| Row: Material | load.material | CARRY | — | — | Daily Log |
| Row: Start location | leg origin: VBT yard, the trip's actual yard, or the previous destination | CARRY (from trips and segments) | — | a yard the driver tapped that is not the planned one is shown as tapped (no substitution) | Daily Log |
| Row: Destination | po.address / city for the leg's loads; "End of day" for the last leg | CARRY | — | — | Daily Log |
| Row: OD start / OD end / Total miles | shift start odometer, segment start/end odometers, truck-change odometers, end odometer; legs derived in order | CARRY / CALC | driver types each odometer when asked (Start day, freight start, Finish freight, truck change, End day) | a reading below the previous one is refused unless confirmed; a missing freight end leaves the leg "open"; Linxup odometer shown beside it as a read-only check | Daily Log |
| "Miles today" | end odometer − start odometer, per vehicle | CALC | — | — | Daily Log |
| Loads count per row ("4 loads") | completed trips in the leg | CALC | — | never counts a started or loaded trip | Daily Log |
| Condition checklist (12 items) | shift.inspection (11 items today; see §5 for the item list change) | CARRY from the DVIR confirmation | driver confirms each item at Start day | not confirmed → printed blank, flagged | Daily Log + DVIR |
| Comments / Repairs | shift.inspection.remarks + shift.notes | CARRY | driver / office types | — | Daily Log |
| Fuel purchase location (and gallons) | **shift.fuel (P1)** — was not recorded before | DRIVER (new: a Fuel tap on the day card: gallons, location, optional receipt photo) | driver | gallons must be a number; location from the yard/vendor list or typed | Daily Log + Freight Bill |
| Signature, date | **shift.dayLog (P1)**: the driver signs the finished log on the phone; server time; snapshot + hash kept | DRIVER | driver signs after End day | unsigned → DRAFT; changed after signing → DRAFT "changed since signed", sign again | Daily Log |

Time saved: the office never retypes the day; the driver's taps are the day.
The only new input is fuel.

## 2. Freight Bill / Log

One per freight segment (customer + jobsite + day). Generated from the
segment, its trips and their tickets. Replaces the handwritten trip table.

| Paper field | Authoritative source in VBT | How | Still provided by | Validation / exception | Output |
|---|---|---|---|---|---|
| Customer (header) | segment.customer ← po.customer | CARRY | — | — | Freight Bill |
| Truck #, Trailer # | segment.truckNum / trailerNum (the shift's at segment open) | CARRY | — | differs from the load's dispatched truck → printed note (exists) | Freight Bill |
| Date, day | segment.date | CARRY / CALC | — | — | Freight Bill |
| Driver | segment.driverName | CARRY | — | — | Freight Bill |
| Time start / Time end / Total hours | segment.startAt (first pickup arrival) / segment.endAt (Finish freight tap); hours derived, lunch deducted when a break falls inside | CALC | driver taps | segment still open → DRAFT; office-typed ending → "needs review" (exists) | Freight Bill |
| Row: Tons | trip.ticket.netTons (supplier ticket) | CAPTURE (typed today, OCR-assisted later) | driver | required for a supplier ticket; 0–200; "VBT" tickets have no tons; actual tons never replaced by planned tons | Freight Bill |
| Row: Tag # | trip.ticket.number | CAPTURE | driver | unique across all loads; mismatch with the photo → exception at approval | Freight Bill |
| Row: Start location | trip.actualYardName | CARRY | driver's one tap (or the picker) | — | Freight Bill |
| Row: End destination | po.address / city | CARRY | — | — | Freight Bill |
| OD start / OD end / Total miles | segment.odStart / odEnd; billable miles derived | CARRY / CALC | driver types at freight start and Finish freight | window checks exist (below the leg start, overlap with another segment) | Freight Bill |
| Total tons | sum of completed trips' ticket tons | CALC | — | a completed trip without tons on an actual-tons customer → exception (exists) | Freight Bill |
| Total gallons purchased / purchase location | fuel entries of the day (new, §1) | CARRY | driver | — | Freight Bill |
| Lunch start / end | shift.breaks | CARRY | driver taps Break | — | Freight Bill |
| Signature, date | End-day signature or the paper signature | DRIVER | — | — | Freight Bill |

The existing Freight Bill page already prints the loads, tickets and step
times; it needs the paper layout (tons and tag columns, odometers, totals,
lunch, fuel, signature) rather than new data.

## 3. Supplier scale tickets (Vulcan Materials and others)

External source documents. VBT keeps the photo as the evidence and records
what it needs; it never prints its own version of the supplier's ticket.

| Ticket field | VBT record | How | Still provided by | Validation / exception | Used by |
|---|---|---|---|---|---|
| Ticket No | trip.ticket.number | CAPTURE (typed; OCR suggestion later) | driver | unique; duplicate → 409 (exists) | Freight Bill, invoice note, vendor bill |
| Supplier / plant (5098-112 Austin Quarry) | trip.actualYardId (the yard the driver tapped) | CARRY | driver's one tap | plant on the ticket ≠ tapped yard → exception at approval (new, OCR-era) | cost, Freight Bill |
| Date, time in/out of plant | trip timestamps (arrived at yard, loaded) | CARRY (VBT's own stamps); ticket time kept on the photo | — | ticket time far from the Loaded stamp → exception (new, OCR-era) | evidence |
| Customer, customer PO (214176 / 25031), order, destination | po.customer, po.poNumber, po.address | CARRY | — | ticket customer PO ≠ VBT PO → exception (new, OCR-era) | approval |
| Product (16020 3/4IN CL 2 BASE) | load.material | CARRY | — | product ≠ material → exception | approval |
| Truck (VB3), license, trailer id | trip.truckUnitId / trailerId (dispatched) | CARRY | — | truck on ticket ≠ truck on trip → exception | approval |
| Gross / tare / net lbs, net kg | **net tons only today** (ticket.netTons) | CAPTURE: add gross and tare (optional) so net = gross − tare is checked | driver (optional) | net ≠ gross − tare → exception | Freight Bill, billing on actual tons |
| Tons, tons today, loads today | ticket.netTons; running totals derived from VBT's own completed trips | CALC | — | supplier's "loads today" ≠ VBT's completed trips at that time → exception | Freight Bill |
| Weighmaster, warranty text, QR | photo only | — | — | — | evidence |

The vendor-cost rule is unchanged: cost is priced on planned tons per trip
until the owner approves otherwise; the ticket's tons remain the customer-side
actual quantity and the evidence.

## 4. Valley Best internal pickup / delivery ticket (No. 4721)

Today a pre-printed pad. Generated from the load and PO; the office prints or
the driver shows it on the phone; the receiver signs.

| Paper field | Authoritative source in VBT | How | Still provided by | Validation / exception | Output |
|---|---|---|---|---|---|
| Ticket No. | a VBT ticket number series (new: `VBT-<n>`, issued when the internal ticket is created at Loaded) | CALC | — | unique (exists for ticket numbers) | internal ticket |
| Company name (sold to) | po.customer | CARRY | — | — | internal ticket |
| Truck number | trip.truckNum | CARRY | — | — | internal ticket |
| Date | trip loaded time / load.deliveryDate | CARRY | — | — | internal ticket |
| Job location, address, city/state/zip | po.job, po.address, po.city | CARRY | — | — | internal ticket |
| PO number | po.poNumber | CARRY | — | — | internal ticket |
| Pickup / delivery box | pickup when the customer collects at the VBT yard; delivery otherwise (new: a flag on the load) | OFFICE | office | — | internal ticket |
| Sold by / Cash / COD / Charge / On acct | customer master terms (new: a `terms` field, default "Charge") | CARRY | office once per customer | — | internal ticket |
| Quantity, description | completed trips (count or tons) and load.material | CALC / CARRY | — | never counts an open trip | internal ticket |
| Price, amount | the load's customer rate and the approved pricing rules (list, default flagged, frozen by the batch) | CALC | — | default rate → printed "default rate"; $0 → flagged | internal ticket |
| Received by | the customer signature already captured at delivery (name, image, server time) | CARRY | customer signs the phone | missing → submission refused (exists) | internal ticket |

This replaces the pad for yard sales and pre-loads (the "Pre-load / PO 3298 /
Pea Gravel" case) with the same record the invoice uses.

## 5. Driver's Vehicle Inspection Report (DVIR)

Prefilled, never pre-answered. The record is the driver's confirmation.

| Paper field | Authoritative source in VBT | How | Still provided by | Validation / exception | Output |
|---|---|---|---|---|---|
| Carrier, address | company constants | CARRY | — | — | DVIR |
| Date, time | shift.date, shift.startAt (and endAt for the post-trip line) | CARRY | — | — | DVIR |
| Truck / tractor no., trailer no. | shift.truckNum, trailerNum | CARRY | driver confirms | — | DVIR |
| Odometer reading | shift.startOdometer (– endOdometer) | CARRY | driver types | below last reading → confirm (exists) | DVIR |
| Defective-item checklist (truck ~48 items, trailer 14) | shift.inspection.items / defects — **today 11 items with "all satisfactory" pre-ticked** | DRIVER: the phone shows the DOT list grouped as on the form; the driver ticks the defects found or confirms "no defects" explicitly; the box is not pre-ticked | driver | no explicit confirmation → the day cannot start (exists: boolean required); defects without remarks → prompt | DVIR + Daily Log checklist |
| Remarks | inspection.remarks | DRIVER | driver | — | DVIR |
| "Condition of the above vehicle is satisfactory" | inspection.satisfactory, set only by the driver's explicit confirmation | DRIVER | driver | — | DVIR |
| Driver's signature | inspection signature (exists, required) | DRIVER | driver | unsigned → refused (exists) | DVIR |
| Above defects corrected / need not be corrected; mechanic's signature and date; driver's second signature | **new**: an office/mechanic follow-up on the shift's inspection when defects were listed | OFFICE | mechanic / office | defects listed and no follow-up → open exception on the review | DVIR |

Only the pre-ticked default changes: the app stops answering the inspection
for the driver. Everything else is prefilled.

## 6. What is missing in VBT today (the gaps the forms expose)

1. **Fuel purchases** — *closed by P1 (shift.fuel)*. Was: not recorded anywhere; needed on the Daily Log and the Freight Bill. Smallest: a Fuel entry on the day card (gallons, location, optional receipt photo) stored on the shift.
2. **Day-end signature** — *closed for the Daily Log by P1 (shift.dayLog, signed on the phone after End day)*; the Freight Bill still signs on paper until P2. Was: the Daily Log and Freight Bill are signed on paper; the phone collects a signature at Start day only. Smallest: a signature at End day, stored on the shift and printed on both forms.
3. **Daily Log legs by destination** — *closed by P1 (rows derived from the legs and segments)*. Was: the page prints odometer legs per vehicle and segments; the paper lists each leg with its start location, destination, PO and material. Smallest: derive legs from the shift's odometer points and the trips' yard/jobsite facts (no new data).
4. **Freight Bill layout** — the page prints loads and step times; the paper's columns (tons, tag, start, end, odometers, totals, lunch, fuel) are a different arrangement of data VBT already has.
5. **Internal ticket** — no equivalent exists; generated from load, PO, price and signature; needs a ticket-number series, a pickup/delivery flag and customer terms.
6. **DVIR** — the inspection list is 11 generic items with "all satisfactory" pre-ticked; the DOT form lists ~60 items by vehicle part and a trailer section, and has the defect-correction follow-up. Smallest: replace the item list with the form's, remove the pre-tick, add the follow-up on the shift.
7. **Scale-ticket data** — only number, net tons and the photo are captured; gross/tare, plant, time, the customer PO and the truck printed on the ticket are on the photo only. Smallest: optional gross and tare now (net checked); OCR-assisted capture of the rest later, always confirmed by a person, with mismatches as approval exceptions.

## 7. Smallest practical implementation (in order of time saved)

| Step | Delivers | Touches | New data |
|---|---|---|---|
| P1 Daily Log Book — **DONE** | the paper form generated per shift: header, legs with PO/material/locations/odometers/miles, checklist, remarks, fuel, signature; DRAFT while the day is open | the existing Daily Log page (layout), shift record | fuel entries, End-day signature |
| P2 Freight Bill/Log | the paper form generated per segment: trip rows (tons, tag, locations, odometers), totals, hours with lunch, fuel, signature | the existing Freight Bill page (layout) | none beyond P1 |
| P3 Internal ticket | generated per load/trip from PO, material, completed count or tons, price rules, received-by signature; printable and shown on the phone | load/PO, a ticket-number series, customer terms, pickup/delivery flag | three small fields |
| P4 DVIR | the DOT item list by part and trailer, no pre-tick, defect follow-up; the Daily Log checklist reads from it | Start-day form, shift.inspection, Daily Log page, End of day review (open defects) | item list change, follow-up record |
| P5 Scale-ticket capture | optional gross/tare with net check; mismatch exceptions (truck, PO, product, plant, time) once OCR suggestions exist; the photo stays the evidence | Loaded form, approval checklist | two optional numbers now |

Each step is a print page or a small form over records VBT already keeps; none
adds a document store, a scheduler or a second data model. The financial rules
do not move: the internal ticket's price and amount come from the same engine
as the invoice, the Freight Bill's tons are the tickets', the Daily Log's
miles are the odometers', and every "could not be calculated" stays blank and
flagged rather than guessed.
