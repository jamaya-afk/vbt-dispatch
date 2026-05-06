// VBT Dispatch — QuickBooks Online integration
// Self-contained helper for OAuth, token refresh, customer/invoice/bill/attachment APIs.
// Tokens are encrypted at rest with AES-256-GCM using QB_ENCRYPTION_KEY (32-byte hex / base64 / passphrase).

const crypto = require('crypto');

// ── ENV CONFIG ───────────────────────────────────────────────────────────────
const QB_CLIENT_ID     = process.env.QB_CLIENT_ID || '';
const QB_CLIENT_SECRET = process.env.QB_CLIENT_SECRET || '';
const QB_REDIRECT_URI  = process.env.QB_REDIRECT_URI || '';
const QB_ENVIRONMENT   = (process.env.QB_ENVIRONMENT || 'sandbox').toLowerCase();
const QB_SCOPES        = process.env.QB_SCOPES || 'com.intuit.quickbooks.accounting';
const QB_DEFAULT_ITEM  = process.env.QB_DEFAULT_ITEM_NAME || 'Services';
const QB_MINOR_VERSION = process.env.QB_MINOR_VERSION || '70';
const QB_ENCRYPTION_KEY_RAW = process.env.QB_ENCRYPTION_KEY || process.env.SESSION_SECRET || 'vbt-2025-qb-default-key';

const QB_AUTH_BASE  = 'https://appcenter.intuit.com/connect/oauth2';
const QB_TOKEN_URL  = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QB_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';

function apiBase() {
  return QB_ENVIRONMENT === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

function isConfigured() {
  return !!(QB_CLIENT_ID && QB_CLIENT_SECRET && QB_REDIRECT_URI);
}

function configSummary() {
  return {
    configured: isConfigured(),
    environment: QB_ENVIRONMENT,
    redirectUri: QB_REDIRECT_URI,
    clientIdSuffix: QB_CLIENT_ID ? QB_CLIENT_ID.slice(-6) : '',
    defaultItem: QB_DEFAULT_ITEM,
  };
}

// ── ENCRYPTION ───────────────────────────────────────────────────────────────
// AES-256-GCM. Key derived via SHA-256 from the configured passphrase so any
// length input works. Output: base64(iv | tag | ciphertext).
function encKey() {
  return crypto.createHash('sha256').update(String(QB_ENCRYPTION_KEY_RAW)).digest();
}

function encrypt(plain) {
  if (plain == null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

function decrypt(blob) {
  if (!blob) return '';
  try {
    const buf = Buffer.from(blob, 'base64');
    const iv  = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct  = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    throw new Error('QuickBooks token decrypt failed (key changed?)');
  }
}

// ── OAUTH ────────────────────────────────────────────────────────────────────
function buildAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: QB_CLIENT_ID,
    response_type: 'code',
    scope: QB_SCOPES,
    redirect_uri: QB_REDIRECT_URI,
    state,
  });
  return `${QB_AUTH_BASE}?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: QB_REDIRECT_URI,
  });
  return tokenRequest(body);
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  return tokenRequest(body);
}

async function tokenRequest(body) {
  const auth = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(QB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) {
    const e = new Error(`QB token request failed (${r.status}): ${data.error_description || data.error || text.slice(0, 200)}`);
    e.statusCode = r.status;
    e.responseBody = text;
    throw e;
  }
  return data; // { access_token, refresh_token, expires_in, x_refresh_token_expires_in, token_type }
}

async function revokeToken(token) {
  if (!token) return;
  const auth = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');
  await fetch(QB_REVOKE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ token }),
  });
}

// Ensure connection has a non-expired access token. If access_token is within
// 5 minutes of expiry, refresh it. `conn` is mutated in place; caller persists.
async function ensureFreshToken(conn) {
  if (!conn || !conn.refreshTokenEnc) throw new Error('QuickBooks not connected');
  const now = Date.now();
  const exp = conn.accessExpiresAt ? new Date(conn.accessExpiresAt).getTime() : 0;
  if (exp - now > 5 * 60 * 1000 && conn.accessTokenEnc) {
    return decrypt(conn.accessTokenEnc);
  }
  const refresh = decrypt(conn.refreshTokenEnc);
  const tok = await refreshAccessToken(refresh);
  applyTokenToConnection(conn, tok);
  return tok.access_token;
}

function applyTokenToConnection(conn, tok) {
  conn.accessTokenEnc  = encrypt(tok.access_token);
  conn.refreshTokenEnc = encrypt(tok.refresh_token);
  conn.accessExpiresAt  = new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString();
  conn.refreshExpiresAt = new Date(Date.now() + (tok.x_refresh_token_expires_in || 8726400) * 1000).toISOString();
  conn.status = 'connected';
  conn.lastError = '';
}

// ── API HELPER ───────────────────────────────────────────────────────────────
async function qbFetch(conn, method, pathWithQuery, jsonBody, extraHeaders) {
  if (!conn || !conn.realmId) throw new Error('QuickBooks not connected (no realmId)');
  const access = await ensureFreshToken(conn);
  const sep = pathWithQuery.includes('?') ? '&' : '?';
  const url = `${apiBase()}/v3/company/${conn.realmId}${pathWithQuery}${sep}minorversion=${QB_MINOR_VERSION}`;
  const headers = {
    'Authorization': `Bearer ${access}`,
    'Accept': 'application/json',
    ...(extraHeaders || {}),
  };
  let body;
  if (jsonBody !== undefined && jsonBody !== null && !extraHeaders?.['Content-Type']) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(jsonBody);
  } else if (jsonBody) {
    body = jsonBody;
  }
  const r = await fetch(url, { method, headers, body });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) {
    const fault = data?.Fault?.Error?.[0];
    const msg = fault ? `${fault.Message}${fault.Detail ? ' — ' + fault.Detail : ''}` : (data?.error_description || data?.error || text.slice(0, 300));
    const err = new Error(`QB API ${method} ${pathWithQuery} → ${r.status}: ${msg}`);
    err.statusCode = r.status;
    err.responseBody = text;
    throw err;
  }
  return data;
}

// ── ENTITY OPERATIONS ────────────────────────────────────────────────────────
async function findCustomerByName(conn, displayName) {
  const safe = String(displayName || '').replace(/'/g, "\\'");
  const q = encodeURIComponent(`select * from Customer where DisplayName = '${safe}'`);
  const data = await qbFetch(conn, 'GET', `/query?query=${q}`);
  const list = data?.QueryResponse?.Customer || [];
  return list[0] || null;
}

async function createCustomer(conn, customer) {
  // customer: { name, address, city, phone, email }
  const body = {
    DisplayName: customer.name,
    PrimaryEmailAddr: customer.email ? { Address: customer.email } : undefined,
    PrimaryPhone:    customer.phone ? { FreeFormNumber: customer.phone } : undefined,
    BillAddr: (customer.address || customer.city) ? {
      Line1: customer.address || '',
      City:  customer.city || '',
      CountrySubDivisionCode: 'CA',
      Country: 'USA',
    } : undefined,
  };
  const data = await qbFetch(conn, 'POST', `/customer`, body);
  return data?.Customer || null;
}

async function findOrCreateCustomer(conn, customer) {
  const existing = await findCustomerByName(conn, customer.name);
  if (existing) return { customer: existing, created: false };
  const created = await createCustomer(conn, customer);
  return { customer: created, created: true };
}

async function findVendorByName(conn, displayName) {
  const safe = String(displayName || '').replace(/'/g, "\\'");
  const q = encodeURIComponent(`select * from Vendor where DisplayName = '${safe}'`);
  const data = await qbFetch(conn, 'GET', `/query?query=${q}`);
  return (data?.QueryResponse?.Vendor || [])[0] || null;
}

async function createVendor(conn, vendor) {
  const body = { DisplayName: vendor.name };
  const data = await qbFetch(conn, 'POST', `/vendor`, body);
  return data?.Vendor || null;
}

async function findOrCreateVendor(conn, vendor) {
  const existing = await findVendorByName(conn, vendor.name);
  if (existing) return { vendor: existing, created: false };
  const created = await createVendor(conn, vendor);
  return { vendor: created, created: true };
}

// Cache resolved item ref by name on the connection object so repeated invoices
// on the same session don't re-query.
async function resolveItemId(conn, itemName) {
  const name = itemName || QB_DEFAULT_ITEM;
  conn._itemCache = conn._itemCache || {};
  if (conn._itemCache[name]) return conn._itemCache[name];
  const safe = name.replace(/'/g, "\\'");
  const q = encodeURIComponent(`select * from Item where Name = '${safe}'`);
  let data = await qbFetch(conn, 'GET', `/query?query=${q}`);
  let item = (data?.QueryResponse?.Item || [])[0];
  if (!item) {
    // Fall back to the first active service-type item in the account
    const fallback = encodeURIComponent(`select * from Item where Type = 'Service' maxresults 1`);
    data = await qbFetch(conn, 'GET', `/query?query=${fallback}`);
    item = (data?.QueryResponse?.Item || [])[0];
  }
  if (!item) throw new Error(`No QuickBooks Item named "${name}" and no Service item to fall back on. Create one in QuickBooks.`);
  conn._itemCache[name] = { Id: item.Id, Name: item.Name };
  return conn._itemCache[name];
}

async function resolveExpenseAccountId(conn) {
  if (conn._expenseAccountId) return conn._expenseAccountId;
  const q = encodeURIComponent(`select * from Account where AccountType = 'Cost of Goods Sold' maxresults 1`);
  let data = await qbFetch(conn, 'GET', `/query?query=${q}`);
  let acct = (data?.QueryResponse?.Account || [])[0];
  if (!acct) {
    const fallback = encodeURIComponent(`select * from Account where AccountType = 'Expense' maxresults 1`);
    data = await qbFetch(conn, 'GET', `/query?query=${fallback}`);
    acct = (data?.QueryResponse?.Account || [])[0];
  }
  if (!acct) throw new Error('No COGS or Expense account found in QuickBooks; cannot create vendor bill.');
  conn._expenseAccountId = acct.Id;
  return acct.Id;
}

async function createInvoice(conn, args) {
  // args: { qbCustomerId, lines: [{description, quantity, rate, amount, itemName?}], memo, docNumber, txnDate }
  const itemRefs = {};
  const lines = [];
  for (const ln of args.lines) {
    const item = await resolveItemId(conn, ln.itemName);
    itemRefs[item.Name] = item.Id;
    lines.push({
      DetailType: 'SalesItemLineDetail',
      Amount: Number(ln.amount.toFixed(2)),
      Description: ln.description,
      SalesItemLineDetail: {
        ItemRef: { value: item.Id, name: item.Name },
        Qty: Number(ln.quantity) || 1,
        UnitPrice: Number((ln.amount / (ln.quantity || 1)).toFixed(4)),
      },
    });
  }
  const body = {
    CustomerRef: { value: String(args.qbCustomerId) },
    Line: lines,
    CustomerMemo: args.memo ? { value: args.memo.slice(0, 999) } : undefined,
    PrivateNote: args.privateNote ? args.privateNote.slice(0, 3999) : undefined,
    DocNumber: args.docNumber || undefined,
    TxnDate: args.txnDate || undefined,
    BillEmail: args.billEmail ? { Address: args.billEmail } : undefined,
  };
  const data = await qbFetch(conn, 'POST', `/invoice`, body);
  return data?.Invoice || null;
}

async function voidInvoice(conn, invoiceId) {
  const data = await qbFetch(conn, 'POST', `/invoice?operation=void`, { Id: invoiceId, SyncToken: '0' });
  return data?.Invoice || null;
}

async function createBill(conn, args) {
  // args: { qbVendorId, lines: [{description, amount}], memo, txnDate, docNumber }
  const acctId = await resolveExpenseAccountId(conn);
  const lines = args.lines.map(ln => ({
    DetailType: 'AccountBasedExpenseLineDetail',
    Amount: Number(ln.amount.toFixed(2)),
    Description: ln.description,
    AccountBasedExpenseLineDetail: {
      AccountRef: { value: acctId },
    },
  }));
  const body = {
    VendorRef: { value: String(args.qbVendorId) },
    Line: lines,
    PrivateNote: args.memo ? args.memo.slice(0, 3999) : undefined,
    DocNumber: args.docNumber || undefined,
    TxnDate: args.txnDate || undefined,
  };
  const data = await qbFetch(conn, 'POST', `/bill`, body);
  return data?.Bill || null;
}

// ── ATTACHMENTS ──────────────────────────────────────────────────────────────
// Upload a single binary as an Attachable linked to a QB entity (Invoice/Bill).
// Uses multipart/form-data (RFC 2388) hand-built to keep zero deps.
async function attachToEntity(conn, args) {
  // args: { entityType: 'Invoice'|'Bill', entityId, fileName, contentType, buffer, includeOnSend }
  const access = await ensureFreshToken(conn);
  const url = `${apiBase()}/v3/company/${conn.realmId}/upload?minorversion=${QB_MINOR_VERSION}`;
  const boundary = '----QBVBT' + crypto.randomBytes(8).toString('hex');

  const meta = {
    AttachableRef: [{ EntityRef: { type: args.entityType, value: String(args.entityId) }, IncludeOnSend: !!args.includeOnSend }],
    FileName: args.fileName,
    ContentType: args.contentType,
  };

  const lf = '\r\n';
  const head1 = Buffer.from(
    `--${boundary}${lf}` +
    `Content-Disposition: form-data; name="file_metadata_01"${lf}` +
    `Content-Type: application/json${lf}${lf}` +
    JSON.stringify(meta) + lf, 'utf8');
  const head2 = Buffer.from(
    `--${boundary}${lf}` +
    `Content-Disposition: form-data; name="file_content_01"; filename="${args.fileName}"${lf}` +
    `Content-Type: ${args.contentType}${lf}${lf}`, 'utf8');
  const tail = Buffer.from(`${lf}--${boundary}--${lf}`, 'utf8');
  const body = Buffer.concat([head1, head2, args.buffer, tail]);

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${access}`,
      'Accept': 'application/json',
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) {
    const err = new Error(`QB attach ${args.entityType}/${args.entityId} → ${r.status}: ${text.slice(0, 200)}`);
    err.statusCode = r.status;
    throw err;
  }
  // Response shape: { AttachableResponse: [{ Attachable: { Id, ... } }] }
  return data?.AttachableResponse?.[0]?.Attachable || null;
}

// Fetch a remote URL into a buffer for re-upload.
async function fetchRemoteAsBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Fetch attachment failed: ${r.status} ${url}`);
  const ct = r.headers.get('content-type') || 'application/octet-stream';
  const buf = Buffer.from(await r.arrayBuffer());
  return { buffer: buf, contentType: ct };
}

module.exports = {
  isConfigured,
  configSummary,
  buildAuthUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  revokeToken,
  applyTokenToConnection,
  ensureFreshToken,
  encrypt,
  decrypt,
  qbFetch,
  findCustomerByName,
  createCustomer,
  findOrCreateCustomer,
  findVendorByName,
  createVendor,
  findOrCreateVendor,
  resolveItemId,
  createInvoice,
  voidInvoice,
  createBill,
  attachToEntity,
  fetchRemoteAsBuffer,
  QB_ENVIRONMENT,
  QB_DEFAULT_ITEM,
};
