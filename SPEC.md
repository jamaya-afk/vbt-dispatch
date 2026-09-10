# Valley Best Dispatch — Master Specification

Single-company system for Valley Best. Not a SaaS product, not a generic TMS.
The workflow is deliberately narrow: **material delivery → yard → truck →
jobsite → customer → billing.**

Valley Best is the operational source of truth. QuickBooks is the accounting
destination.

---

## 1. Current state

Verified by `./test-e2e.sh` (22 assertions against a live server), not by
reading code. Run it after every change.

### Working

| Area | Notes |
|---|---|
| PO → loads | One load row per assignment; individual hauls are `trips[]` |
| Driver flow | start → arrive yard → loaded → arrive job → complete, per trip |
| Per-trip timestamps + GPS | Stored permanently in `trips[]`, never overwritten |
| Pickup yard | `resolvePickupYard()` is the single source of truth |
| Trucks & drivers | Separate entities; any driver can take any truck |
| Multi-trip analytics | Every trip counted, attributed to the yard that loaded it |
| Approval → Ready to Bill | Approved loads locked; void, never delete |
| QuickBooks | Batch → invoice → attachments; duplicate billing blocked (409) |
| Costing consistency | One engine; Profitability and Material Costs agree |
| Mobile dispatch | Tap-to-assign, 44px targets, no horizontal overflow |

### Known gaps

- **Quantity per load is undefined for CY** (and SF/LF). Until set, those loads
  cost $0 and Profitability shows a "margin is overstated" warning. See §5.
- Labor, fuel and truck operating cost are configurable but unset, so margin is
  currently gross material margin only.
- No distance/mileage model. Nothing to compute fuel or per-mile cost from yet.
- Jobsites are free text on the PO, not an entity.
- Board groups by driver, not by the four status columns.

---

## 2. Data model

```
CUSTOMER ── JOB/SITE ── PO ── LOAD ── TRIP[]
                                │       ├─ timestamps (5 events)
                                │       ├─ gps (per event)
                                │       └─ actualYardId
                                ├─ truckId      → DRIVER (legacy field name)
                                ├─ truckUnitId  → TRUCK
                                └─ vendorId     → YARD/SUPPLIER
```

`load.truckId` names the **driver**, not a vehicle. Renaming it would touch a
hundred call sites and every saved load, so it stays and is documented instead.
The vehicle is `load.truckUnitId`.

### Pickup yard authority

`trip.actualYardId` → `load.actualYardId` → `load.vendorId` →
`po.plannedVendorId` → `vbt`. The name is always looked up from the vendor
record so label and id cannot drift. Reassigning a yard clears the load-level
mirror but never rewrites `trips[]` history.

---

## 3. Planned features

Five additions, taken from the Truckbase discussion. Conceptual borrowing only —
Valley Best stays narrow.

### 3.1 Per-PO customer notifications

Dispatcher toggles updates per PO, with per-event checkboxes:

```
ABC Construction        Customer Updates: ON
Contact: john@abcconstruction.com
  [x] Driver assigned   [x] Arrived at pickup   [x] Loaded / leaving yard
  [x] Arrived at job    [x] Delivered           [x] Ticket/POD ready
  [ ] Delay
```

Model:

```js
po.notifications = {
  enabled: false,
  contacts: [{ name, email, phone, channel: 'email' | 'sms' }],
  events: { driverAssigned, arrivedPickup, loaded, arrivedJobsite,
            delivered, podReady, delay },
}
```

Every send is written to a `notificationLog` (event, load, trip, recipient,
channel, status, provider id, error) — the same audit discipline as the
QuickBooks sync log, so we can prove what was sent.

**Design rules**
- Off by default. A wrong address emails a real customer.
- Fire from the existing `trip-action` transitions — those events already exist.
- Queue with retry; a failed email must never block a driver's step.
- Dry-run mode that logs instead of sending, for testing against real POs.
- Needs an email/SMS provider; none is configured today.

### 3.2 Live customer tracking link

Per-load unguessable URL, active only while the load is running.

```js
load.tracking = { token, enabled, expiresAt, revokedAt }
```

Shows: customer, job, material, load N of M, truck number, current status,
last-updated time, and — only while in transit — the truck's last known point.

**Security rules (these matter more than the feature)**
- Token is 32+ random bytes, never sequential, never derived from the load id.
- Exposes exactly one load. Never a driver's other work, never the fleet.
- **Auto-expires at delivery** unless explicitly extended.
- No PII beyond what that customer already knows about their own order.
- Revocable from the PO screen.
- Rate-limited and `noindex`.

### 3.3 Automatic status updates

Already half-built: the five per-trip events exist and are stamped. What's
missing is pushing them out rather than waiting for a refresh.

- Driver's TODAY screen updates on assignment change without a manual reload.
- Dispatcher board reflects driver progress live.
- Start with short polling — it is honest, simple, and enough for this fleet
  size. Move to SSE only if polling proves insufficient.

### 3.4 ELD integration architecture (design now, build later)

Today all location comes from the driver's phone. That should become one
*source* among several, not the assumption baked into the schema.

```js
// A location fix, wherever it came from
{ loadId, tripNum, at, lat, lng, accuracy,
  source: 'driver-phone' | 'eld' | 'manual' }

truck.eld = { provider, deviceId, externalTruckId, lastSyncAt }
```

The change that must happen **now** to avoid a rebuild: stop treating GPS as a
field of a driver button-press, and start treating it as a timestamped fix with
a source. The existing per-event GPS then becomes `source: 'driver-phone'` and
ELD data lands in the same place.

Deferred: the provider integrations themselves, and telemetry Valley Best
doesn't yet act on (odometer, engine hours, HOS).

### 3.5 QuickBooks operational → accounting sync

Already built and staying. The boundary is the point: dispatch, drivers,
trucks, yards, loads, tickets, signatures, GPS and operational cost live here.
QuickBooks receives invoices and vendor bills only.

Not yet decided: whether internal cost figures should reach QuickBooks at all.
Probably not — they are management numbers, not accounting entries. Confirm
with the bookkeeper before sending anything beyond invoices.

---

## 4. Priority order

1. ~~Multi-trip analytics~~ — done
2. ~~Trucks as real entities~~ — done
3. ~~Pickup yard single source of truth~~ — done
4. ~~Unit model / costing consistency~~ — done (needs the CY figure, §5)
5. ~~Configurable cost rates~~ — scaffolding done, values unset
6. Quick Assign on mobile + live driver refresh (§3.3)
7. Per-PO customer notifications (§3.1)
8. Customer tracking link (§3.2)
9. Jobsites as an entity; status-column board
10. Distance/mileage → fuel and per-mile truck cost
11. ELD integration (§3.4)

---

## 5. Open questions for Valley Best

These block correct numbers. The code deliberately refuses to guess.

1. **How many cubic yards are in one Valley Best truck load?** Until answered,
   every CY-priced load costs $0 and margin is overstated. Set it under
   costing settings, per material if rock and sand differ.
2. Are SF/LF ever used for material pricing, or only ton / CY / load?
3. Driver wage per hour — flat, per driver, or with an overtime multiplier?
4. Diesel price per gallon, and loaded vs empty MPG per truck.
5. Truck operating cost per mile — tires, maintenance, depreciation.
6. Should internal cost ever be pushed to QuickBooks, or stay operational?

---

## 6. Rules

- Never reset, wipe or recreate the database.
- Never delete approved, billed or QuickBooks-synced records — void instead.
- Never reintroduce multi-tenant/SaaS architecture.
- Never break duplicate-billing protection.
- Never hard-code a costing assumption that has not been confirmed. Report
  "unconfigured" instead — a silent wrong number is worse than a visible gap.
- Test end-to-end after each change; commit only when `./test-e2e.sh` passes.
