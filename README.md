# VBT Dispatch

Clean rebuild — focused on the essentials. Now multi-tenant: any trucking /
material-hauling company can sign up at `/signup`, get an isolated workspace
with a free trial, manage their own team, and subscribe via Stripe.

## Multi-tenant SaaS

- **Signup** at `/signup` creates an organization + admin account (scrypt-hashed
  passwords). Each org's data is fully isolated (own POs, loads, vendors,
  customers, pricing, QuickBooks connection, audit log).
- **Team** — admins add drivers/admins in **Company & Billing**; drivers get
  their own truck identity automatically.
- **Billing** — free trial (`TRIAL_DAYS`, default 14), then Stripe Checkout
  subscription. Expired orgs hit a paywall (HTTP 402); data is never deleted.
- The original VBT install lives on as the grandfathered `default` org with the
  legacy hardcoded logins below — nothing changes for existing users.

### Stripe env vars

```
STRIPE_SECRET_KEY      # sk_live_... or sk_test_...
STRIPE_PRICE_ID        # recurring price (e.g. price_123) for the subscription
STRIPE_WEBHOOK_SECRET  # whsec_... for /api/stripe/webhook
APP_BASE_URL           # e.g. https://your-domain (used in checkout redirects)
TRIAL_DAYS             # optional, default 14
COMPANY_NAME           # optional display name for the legacy default org
```

Point a Stripe webhook at `POST /api/stripe/webhook` with events:
`checkout.session.completed`, `customer.subscription.updated`,
`customer.subscription.deleted`.

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

### Sync Log

Every QuickBooks request (customer create/match, invoice create, attachment,
bill create, OAuth connect/disconnect) is recorded with timestamp, related
load IDs, batch ID, QB entity ID, status, and the user who triggered it. View
in **QuickBooks → Sync Log**.
