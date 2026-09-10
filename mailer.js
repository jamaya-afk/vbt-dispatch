// Valley Best — customer notification email (Gmail only, to start).
//
// Uses a Gmail account with an App Password. No OAuth dance, two env vars:
//   GMAIL_USER          e.g. dispatch@valleybest.com  (or a @gmail.com address)
//   GMAIL_APP_PASSWORD  16-char App Password, NOT the account password
// Generate at: Google Account -> Security -> 2-Step Verification -> App passwords.
//
// SAFETY POSTURE — this sends real email to real customers.
//   * Notifications are OFF per PO by default.
//   * NOTIFY_ENABLED must be 'true' or nothing is ever sent (global kill switch).
//   * Dry-run is the DEFAULT until NOTIFY_DRY_RUN is explicitly set to 'false',
//     so a misconfigured deploy logs instead of emailing customers.
//   * Every attempt is recorded, sent or not.

// Loaded defensively. Customer notifications are a convenience; dispatch is
// not. If this module is missing or fails to load — a version that needs a
// newer Node, a half-finished install — the app must still boot and drivers
// must still be able to run loads. It previously took the whole server into a
// crash loop on Railway.
let nodemailer = null;
let mailerLoadError = '';
try {
  nodemailer = require('nodemailer');
} catch (e) {
  mailerLoadError = e.message;
  console.error('⚠ nodemailer unavailable — customer email notifications are disabled.');
  console.error('  Dispatch, drivers and QuickBooks are unaffected. Cause:', e.message);
}

const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
const FROM_NAME = process.env.NOTIFY_FROM_NAME || 'Valley Best Dispatch';
const REPLY_TO = process.env.NOTIFY_REPLY_TO || GMAIL_USER;

// Global kill switch. Absent or anything but 'true' => nothing sends.
const NOTIFY_ENABLED = String(process.env.NOTIFY_ENABLED || '').toLowerCase() === 'true';
// Dry run unless explicitly turned off. Fail safe, not fail open.
const NOTIFY_DRY_RUN = String(process.env.NOTIFY_DRY_RUN || 'true').toLowerCase() !== 'false';

let transport = null;

function isConfigured() { return !!(nodemailer && GMAIL_USER && GMAIL_APP_PASSWORD); }

function status() {
  return {
    provider: 'gmail',
    configured: isConfigured(),
    user: GMAIL_USER ? GMAIL_USER.replace(/^(.{2}).*(@.*)$/, '$1***$2') : '',
    globallyEnabled: NOTIFY_ENABLED,
    dryRun: NOTIFY_DRY_RUN,
    libraryLoaded: !!nodemailer,
    loadError: mailerLoadError,
    // What will actually happen right now, in one sentence.
    effect: !nodemailer ? `Email library unavailable (${mailerLoadError}) — notifications are off, dispatch is unaffected.`
      : !isConfigured() ? 'Not configured — no email can be sent.'
      : !NOTIFY_ENABLED ? 'Disabled — NOTIFY_ENABLED is not true, nothing will send.'
      : NOTIFY_DRY_RUN ? 'Dry run — messages are logged but NOT delivered.'
      : 'LIVE — messages are delivered to customers.',
  };
}

function getTransport() {
  if (transport) return transport;
  if (!nodemailer) throw new Error('Email library unavailable: ' + mailerLoadError);
  if (!isConfigured()) throw new Error('Gmail not configured (GMAIL_USER / GMAIL_APP_PASSWORD)');
  transport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    pool: true,          // reuse the connection; a busy day is many small sends
    maxConnections: 1,
    maxMessages: 50,
  });
  return transport;
}

// Verify credentials without sending anything to a customer.
async function verify() {
  if (!nodemailer) return { ok: false, error: 'Email library unavailable: ' + mailerLoadError };
  if (!isConfigured()) return { ok: false, error: 'GMAIL_USER / GMAIL_APP_PASSWORD not set' };
  try {
    await getTransport().verify();
    return { ok: true };
  } catch (e) {
    // Gmail's own message here is usually the useful part
    return { ok: false, error: e.message };
  }
}

// Send one message. Returns { sent, dryRun, messageId, error }.
// NEVER throws — a failed email must not break a driver's step.
async function send({ to, subject, text, html, force }) {
  const base = { to, subject };
  if (!nodemailer) return { ...base, sent: false, dryRun: false, error: 'Email library unavailable' };
  if (!isConfigured()) return { ...base, sent: false, dryRun: false, error: 'Gmail not configured' };
  if (!NOTIFY_ENABLED && !force) return { ...base, sent: false, dryRun: false, error: 'Notifications globally disabled (NOTIFY_ENABLED)' };
  if (NOTIFY_DRY_RUN && !force) {
    console.log(`[notify DRY RUN] would email ${to}: ${subject}`);
    return { ...base, sent: false, dryRun: true };
  }
  try {
    const info = await getTransport().sendMail({
      from: `"${FROM_NAME}" <${GMAIL_USER}>`,
      replyTo: REPLY_TO,
      to, subject, text, html,
    });
    return { ...base, sent: true, dryRun: false, messageId: info.messageId };
  } catch (e) {
    console.error(`[notify] send failed to ${to}: ${e.message}`);
    return { ...base, sent: false, dryRun: false, error: e.message };
  }
}

// ── MESSAGE TEMPLATES ────────────────────────────────────────────────────────
// Plain and factual. A customer wants to know where their material is, not to
// read marketing. Never include internal cost, vendor pricing or driver pay.
const EVENT_COPY = {
  driverAssigned:  { verb: 'scheduled',            line: 'Your delivery has been scheduled.' },
  arrivedPickup:   { verb: 'at the pickup yard',   line: 'Our truck has arrived at the pickup yard.' },
  loaded:          { verb: 'loaded and on the way',line: 'Your material is loaded and the truck is on the way.' },
  arrivedJobsite:  { verb: 'arrived at your site', line: 'Our truck has arrived at your jobsite.' },
  delivered:       { verb: 'delivered',            line: 'Your load has been delivered.' },
  podReady:        { verb: 'paperwork ready',      line: 'The delivery ticket and signature for your load are on file.' },
  delay:           { verb: 'delayed',              line: 'There is a delay affecting your delivery.' },
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ctx: { customer, jobName, address, city, material, loadNum, totalLoads,
//        truckNum, yardName, poNumber, when, note }
function buildMessage(eventKey, ctx) {
  const copy = EVENT_COPY[eventKey] || { verb: eventKey, line: 'Delivery update.' };
  const loadLabel = ctx.totalLoads > 1 && ctx.loadNum
    ? `Load ${ctx.loadNum} of ${ctx.totalLoads}` : 'Your load';
  const site = [ctx.address, ctx.city].filter(Boolean).join(', ');

  const subject = `${ctx.customer || 'Delivery'} — ${ctx.material || 'material'} ${copy.verb}`
    + (ctx.poNumber ? ` (${ctx.poNumber})` : '');

  const rows = [
    ['Job', ctx.jobName],
    ['Delivery address', site],
    ['Material', ctx.material],
    ['Load', ctx.totalLoads > 1 ? `${ctx.loadNum || '?'} of ${ctx.totalLoads}` : '1'],
    ['Pickup yard', ctx.yardName],
    ['Truck', ctx.truckNum],
    ['PO', ctx.poNumber],
    ['Time', ctx.when],
  ].filter(([, v]) => v);

  const text = [
    copy.line,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ctx.note ? `\nNote: ${ctx.note}` : '',
    '',
    `— ${FROM_NAME}`,
    'This is an automated delivery update. Reply to this email to reach dispatch.',
  ].filter(l => l !== null).join('\n');

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;color:#0f1628">
  <p style="font-size:16px;font-weight:600;margin:0 0 4px">${esc(copy.line)}</p>
  <p style="font-size:13px;color:#5b6478;margin:0 0 16px">${esc(loadLabel)}${ctx.customer ? ` for ${esc(ctx.customer)}` : ''}</p>
  <table style="border-collapse:collapse;font-size:14px;width:100%">
    ${rows.map(([k, v]) => `<tr>
      <td style="padding:6px 12px 6px 0;color:#5b6478;white-space:nowrap">${esc(k)}</td>
      <td style="padding:6px 0;font-weight:600">${esc(v)}</td></tr>`).join('')}
  </table>
  ${ctx.note ? `<p style="margin:14px 0 0;padding:10px 12px;background:#fff8ec;border:1px solid #fcd34d;border-radius:8px;font-size:13px">${esc(ctx.note)}</p>` : ''}
  <p style="margin:20px 0 0;font-size:12px;color:#8a93a6;border-top:1px solid #e2e7f0;padding-top:12px">
    ${esc(FROM_NAME)} — automated delivery update. Reply to this email to reach dispatch.
  </p>
</div>`;

  return { subject, text, html };
}

module.exports = {
  isConfigured, status, verify, send, buildMessage,
  EVENT_KEYS: Object.keys(EVENT_COPY),
  NOTIFY_ENABLED, NOTIFY_DRY_RUN,
};
