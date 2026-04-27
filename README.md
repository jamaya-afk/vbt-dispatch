# VBT Dispatch

Clean rebuild — focused on the essentials.

## What it does

- **Manager** creates POs, assigns drivers, sees today's board, approves submitted loads, marks loads as billed
- **Drivers** see their assigned trips with PO/customer/material info, follow guided flow: Start Trip → Arrived at Pickup → Upload Ticket Photo → Customer Signature → Complete Delivery
- All steps auto-capture GPS + timestamps
- Loads must have ticket photo + signature before delivery is allowed
- Approved loads are locked and immutable
- Push everything to Google Sheets with one click

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

## Files

- `server.js` — backend (~580 lines)
- `public/index.html` — frontend (single page app)
- `public/logo.png` — VBC logo
- `service-account.json` — Google Sheets service account (optional, for sync)

## Sheet Sync

Sync writes two tabs:
- **POs** — all purchase orders
- **Loads** — all individual load records with status/approval/billing

Sync replaces the contents — it doesn't append. Run as needed.
