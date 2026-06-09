// VBT Dispatch — Multi-tenant SaaS layer
// Organizations, per-org user accounts (scrypt-hashed passwords), and Stripe
// subscriptions (Checkout, Billing Portal, webhook verification) with zero
// added dependencies — Stripe is called through the built-in fetch API.

const crypto = require('crypto');

// ── ENV ──────────────────────────────────────────────────────────────────────
const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_ID       = process.env.STRIPE_PRICE_ID || '';
const APP_BASE_URL          = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const TRIAL_DAYS            = parseInt(process.env.TRIAL_DAYS || '14', 10);

function stripeConfigured() { return !!(STRIPE_SECRET_KEY && STRIPE_PRICE_ID); }

// ── PASSWORDS (scrypt) ───────────────────────────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, salt, hash] = stored.split('$');
  const check = crypto.scryptSync(String(password), salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch { return false; }
}

// ── ORG / USER INDEX ────────────────────────────────────────────────────────
// Persisted under dispatch_data key 'orgs_index'. The 'default' org is the
// original single-company install (legacy hardcoded users keep working).
function emptyIndex() {
  return { orgs: [], users: [] };
}

function newOrg(name) {
  return {
    id: 'org-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
    name: String(name || '').trim(),
    createdAt: new Date().toISOString(),
    stripeCustomerId: '',
    stripeSubscriptionId: '',
    subscriptionStatus: 'trialing',   // trialing | active | past_due | canceled | none
    trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString(),
    plan: '',
  };
}

function newUser(orgId, { username, password, displayName, role, truckNum }) {
  const uname = String(username || '').toLowerCase().trim();
  return {
    id: 'usr-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
    orgId,
    username: uname,
    passHash: hashPassword(password),
    displayName: String(displayName || '').trim() || uname,
    role: role === 'driver' ? 'driver' : 'admin',
    truckId: role === 'driver' ? uname.replace(/[^a-z0-9]/g, '') + '-' + crypto.randomBytes(2).toString('hex') : null,
    truckNum: truckNum || '',
    active: true,
    createdAt: new Date().toISOString(),
  };
}

// Org has access if: legacy default org, trialing within trial window,
// or Stripe says active/trialing/past_due (grace for past_due).
function orgHasAccess(org) {
  if (!org) return false;
  if (org.id === 'default') return true;
  const s = org.subscriptionStatus;
  if (s === 'active' || s === 'past_due') return true;
  if (s === 'trialing') {
    if (org.stripeSubscriptionId) return true;            // Stripe-managed trial
    return new Date(org.trialEndsAt || 0).getTime() > Date.now();  // local trial
  }
  return false;
}

// ── STRIPE (fetch-based) ────────────────────────────────────────────────────
// Stripe expects application/x-www-form-urlencoded with bracket notation for
// nested fields, e.g. line_items[0][price]=...
function formEncode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}

async function stripeRequest(method, path, params) {
  if (!STRIPE_SECRET_KEY) throw new Error('Stripe not configured (STRIPE_SECRET_KEY missing)');
  const r = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params ? formEncode(params) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(`Stripe ${method} ${path} → ${r.status}: ${data?.error?.message || 'unknown error'}`);
    err.statusCode = r.status;
    throw err;
  }
  return data;
}

async function createCheckoutSession(org, customerEmail, baseUrl) {
  const base = APP_BASE_URL || baseUrl;
  const params = {
    mode: 'subscription',
    line_items: { 0: { price: STRIPE_PRICE_ID, quantity: 1 } },
    success_url: `${base}/app/?billing=success`,
    cancel_url: `${base}/app/?billing=canceled`,
    client_reference_id: org.id,
    metadata: { orgId: org.id },
    subscription_data: { metadata: { orgId: org.id } },
  };
  if (org.stripeCustomerId) params.customer = org.stripeCustomerId;
  else if (customerEmail) params.customer_email = customerEmail;
  return stripeRequest('POST', '/v1/checkout/sessions', params);
}

async function createPortalSession(org, baseUrl) {
  if (!org.stripeCustomerId) throw new Error('No Stripe customer for this organization yet');
  const base = APP_BASE_URL || baseUrl;
  return stripeRequest('POST', '/v1/billing_portal/sessions', {
    customer: org.stripeCustomerId,
    return_url: `${base}/app/`,
  });
}

// Verify Stripe-Signature header against the raw request body.
function verifyWebhookSignature(rawBody, sigHeader) {
  if (!STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET not set');
  if (!sigHeader) throw new Error('Missing Stripe-Signature header');
  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) throw new Error('Malformed Stripe-Signature header');
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new Error('Webhook timestamp too old');
  const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  const ok = signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!ok) throw new Error('Webhook signature verification failed');
  return JSON.parse(rawBody.toString('utf8'));
}

module.exports = {
  stripeConfigured,
  hashPassword,
  verifyPassword,
  emptyIndex,
  newOrg,
  newUser,
  orgHasAccess,
  createCheckoutSession,
  createPortalSession,
  verifyWebhookSignature,
  stripeRequest,
  TRIAL_DAYS,
  STRIPE_PRICE_ID,
};
