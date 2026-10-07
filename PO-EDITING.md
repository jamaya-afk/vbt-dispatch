# Editing a Purchase Order — propagation rules

A **PO is the order**: which customer, which PO number, which jobsite, which day,
which yard the material is planned to come from. **Loads are the work**: one
record per driver per material, carrying the driver, truck, trailer, yard,
trips, tickets, signature, and the prices that were in force when it was
created.

When the order changes, what happens to the work depends on whether each load
is still *operational* or already *historical*.

## Operational vs historical

| A load is… | when | a PO edit… |
|---|---|---|
| **Operational** | pending or rejected, not locked, **no trip started, nothing delivered** | follows the order (date, customer pricing, planned yard) |
| **Working** | a trip has started or something was delivered, but not yet submitted | keeps its date and prices — the work happened under them; it is listed in the response as "kept" |
| **Historical** | submitted, approved, billed, or voided after approval | never touched; it is legal proof (ticket, signature, GPS, timestamps) |

"Never touched" is enforced by the server, not by the screen.

## When the order's jobsite and customer freeze (OA5)

Where the work went and for whom is part of the work's record, so those
fields close earlier than the invoice fields:

| Loads on the order are… | Address, city, customer | PO number, job, job code | Date, notes, planned yard | Jobsite pin |
|---|---|---|---|---|
| Assigned, started, or loaded (ticket on the truck, nothing delivered) | change | change | change (date and yard follow operational loads only) | change |
| At least one trip completed, or any load submitted or sent back | **frozen** (403 `po_work_frozen`, naming the field) | change | change | change |
| Any load approved or billed | frozen | **frozen** (403, "approved loads") | change | change |
| A delivered load voided before approval | the freeze lifts if no other load holds it | — | — | change |
| A load voided after approval | frozen (a voided approved load stays on the record) | frozen | — | change |

The jobsite pin ("Set jobsite location") is never frozen: it is the office's
reference for telemetry evidence and the map, not the record of where the load
went, and every change is audited (`set-location`). A wrong address after a
delivery is a new PO; the delivered order keeps the address its tickets,
signature and GPS stamps describe. Submission therefore freezes only the two
things the field record depends on; everything the office may still need to
correct before approval (number, job, date, notes, yard, pin) stays open.

## Field by field

| PO field | Editable? | Propagation |
|---|---|---|
| PO number | Yes, until any load is **approved or billed** (frozen after: it is on an invoice). Must stay unique across active and archived POs. | None needed — loads reference the PO by id, billing reads the number at billing time. |
| Customer | Frozen once any load has delivered work or is submitted (the deliveries on record were for this customer), and after approval or billing as before. Resolved against the customer master (canonical spelling; a new name is added to the master, as on creation). | **Operational** loads whose customer rate is still the old customer's list/default rate are re-priced from the new customer's rates. A load whose rate was set by hand keeps it (listed as `keptPrice`). Working and historical loads keep their snapshot. |
| Job name, job code | Same freeze rule. | None. A job name that merely mirrored the customer follows a customer change. |
| Address, city | Frozen once any load has delivered work or is submitted — the deliveries on record went to this jobsite; a new address is a new PO (403 `po_work_frozen`). Until then, as before. | Saved jobsite coordinates are **cleared** (they described the old address); set them again from the PO card. |
| Delivery date | Yes. | **Operational** loads move to the new date with a move-history entry ("PO date changed" plus your reason). Working and historical loads **keep their date** and are listed as `dateKept`. The move is checked like any assignment: a truck or trailer already on another driver's load on the new date is a conflict — shown in the app, Cancel or go ahead (audited). |
| Planned pickup yard | Yes. | **Operational** loads that were following the plan (their yard equals the old planned yard) switch to the new yard and are re-priced with that vendor's rate. A load whose yard was chosen explicitly keeps it. Once a driver has loaded somewhere, the actual yard is a fact and is never changed. |
| Notes | Yes. | None. |
| Status, materials, created/completed dates | **No** — derived from the loads. | Recomputed after every edit. |
| Jobsite coordinates, customer-update settings | Not here — they have their own actions (Set jobsite location, Customer updates). | |

Anything else in the request is refused (400) so nothing can be smuggled onto
a PO through a generic update.

## Adding work to an order

"They need two more loads" is an edit to the order, not a new PO (PO numbers
are unique). **Add load** on the Edit PO screen creates one more load on the
same PO with the same validation, price snapshot and conflict rules as the New
PO form (an off-duty driver or a truck in the shop is refused; a truck or
trailer already on another driver's load that day is a conflict to confirm).
A completed PO that receives new work becomes active again. Nothing already on
the PO changes.

Removing work: an operational load is deleted from its own record (Delete
load). Anything with a field record is voided, never deleted — see SPEC.md.

## What is written down

Every PO edit is one audit entry (`updated-po`) with each changed field's old
and new value and the propagation that happened: loads moved, loads kept on
their date, loads re-priced, loads whose hand-set price was kept, loads whose
yard followed, whether coordinates were cleared, and any conflict that was
overridden with its reason. Every added load is an `added-load` entry.
