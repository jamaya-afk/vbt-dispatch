'use strict';
// ── LINXUP PUSH API V3 — receiver and telemetry store ────────────────────────
// See LINXUP-INTEGRATION.md. Linxup is the truck's telemetry; VBT is dispatch.
// Nothing here touches the dispatch JSON store: telemetry lives in its own
// Postgres tables (dev without DATABASE_URL: telemetry.json) with one latest
// position per tracker kept in memory for the board and the map.
//
// Written against the Push API V3 message documentation only. Every message
// type is accepted and logged; L1 interprets Position, Device Status and
// Device Update. The others are stored raw (30 days) so L2/L3 can be built
// on real payloads. Assumptions the document leaves open are listed in the
// integration doc; each is a one-line change here, never a redesign.
const fs = require('fs');
const crypto = require('crypto');

// 1 = interpreted in L1 · 2 = kept raw for L2/L3 · 3 = accepted and dropped · 0 = classify by shape
const TYPES = {
  position: 1, 'device-status': 1, 'device-update': 1,
  'geofence-event': 1, stop: 1, trip: 1, 'usage-hours': 1,          // L2: evidence, stored by their own event times
  alert: 2, 'geofence-change': 2, media: 2,
  'item-location': 3, 'item-left-behind': 3,
  event: 0,
};
const RAW_DAYS = 30, DROP_DAYS = 365, THIN_SECONDS = 300, LOG_DAYS = 30, LOG_POSITION_DAYS = 7;
const MAX_FUTURE_MS = 7 * 24 * 3600 * 1000, MAX_PAST_MS = 5 * 365 * 24 * 3600 * 1000;

// ── Normalizing the common objects (field names vary between messages) ──────
const num = v => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const str = v => (v === null || v === undefined) ? null : String(v);
const bool = v => (v === true || v === 'true') ? true : (v === false || v === 'false') ? false : null;
const idOf = (o, key) => (o && typeof o === 'object') ? num(o[key] ?? o.id) : null;
const normTracker = o => o && typeof o === 'object' ? { trackerId: idOf(o, 'trackerId'), name: str(o.name), deviceNumber: str(o.deviceNumber), deviceSerialNumber: str(o.deviceSerialNumber) } : null;
const normPerson  = o => { const id = idOf(o, 'personId'); return (id != null || (o && o.name)) ? { personId: id, name: str(o.name) } : null; };
const normCompany = o => o && typeof o === 'object' ? { companyId: idOf(o, 'companyId'), name: str(o.name) } : null;
const normFleet   = o => o && typeof o === 'object' ? { fleetId: idOf(o, 'fleetId'), name: str(o.name) } : null;
const normAsset   = o => o && typeof o === 'object' ? { vin: str(o.vin), make: str(o.make), model: str(o.model), year: num(o.year), licensePlate: str(o.licensePlate) } : null;
const normFence   = o => { const id = idOf(o, 'geofenceId'); return (id != null || (o && o.name)) ? { geofenceId: id, name: str(o.name), fenceGroup: str(o.fenceGroup) } : null; };
function normAddress(a) {
  if (!a || typeof a !== 'object') return null;
  const out = { street: str(a.street), street2: str(a.street2 ?? a.street_2), street3: str(a.street3 ?? a.street_3), city: str(a.city), county: str(a.county),
    stateCode: str(a.stateCode), postalCode: str(a.postalCode), postalCodeExtension: str(a.postalCodeExtension), countryCode: str(a.countryCode) };
  out.line = [out.street, out.city, [out.stateCode, out.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null;
  return out;
}
function epochToDate(v) { const n = num(v); if (n == null) return null; const d = new Date(n < 1e11 ? n * 1000 : n); return isNaN(d) ? null : d; }

// A Position, validated. Returns { ok, errors, p }.
function normalizePosition(raw, now) {
  const errors = [];
  const tracker = normTracker(raw.tracker);
  if (!tracker || tracker.trackerId == null) errors.push('tracker.trackerId missing');
  const at = epochToDate(raw.date);
  if (!at) errors.push('date missing or not epoch milliseconds');
  else if (at.getTime() > now + MAX_FUTURE_MS || at.getTime() < now - MAX_PAST_MS) errors.push('date out of range');
  const lat = num(raw.latitude), lng = num(raw.longitude);
  if (lat == null || lat < -90 || lat > 90) errors.push('latitude out of range');
  if (lng == null || lng < -180 || lng > 180) errors.push('longitude out of range');
  if (errors.length) return { ok: false, errors };
  const fence = normFence(raw.geofence), person = normPerson(raw.person), address = normAddress(raw.address);
  return { ok: true, p: {
    trackerId: tracker.trackerId, tracker, at, lat, lng,
    altitude: num(raw.altitude), speed: num(raw.speed), heading: str(raw.heading), direction: num(raw.direction),
    odometer: num(raw.odometer), battery: str(raw.battery), fuelLevel: str(raw.fuelLevel), accuracy: str(raw.accuracy), signal: str(raw.signal),
    estSpeedLimit: num(raw.estimatedSpeedLimit), speeding: bool(raw.speeding), behaviorCode: str(raw.behaviorCode ?? raw.behaviourCode),
    engineOn: bool(raw.engineOn), editAt: epochToDate(raw.editDate), address, addressLine: address ? address.line : null,
    geofenceId: fence ? fence.geofenceId : null, geofenceName: fence ? fence.name : null,
    personId: person ? person.personId : null, personName: person ? person.name : null, person,
    batched: str(raw.batchedPositions), sensor: raw.sensorData ?? null,
    company: normCompany(raw.company), fleet: normFleet(raw.fleet), asset: normAsset(raw.asset),
  } };
}
// ── L2 messages: evidence, keyed by their own event times ────────────────────
// A Geofence Event is one visit (enter, and later exit) to a Linxup fence; a
// Stop is idle or engine-off time at a place; a Linxup VEHICLE trip is one
// ignition cycle (never a VBT hauling trip); Usage Hours is one usage period.
function normFenceEvent(raw) {
  const errors = [];
  const tracker = normTracker(raw.tracker); if (!tracker || tracker.trackerId == null) errors.push('tracker.trackerId missing');
  const fence = normFence(raw.geofence); if (!fence || fence.geofenceId == null) errors.push('geofence.geofenceId missing');
  const type = String(raw.eventType || '').toUpperCase();
  if (type !== 'FENCE_ENTER' && type !== 'FENCE_EXIT') errors.push('eventType must be FENCE_ENTER or FENCE_EXIT');
  const enteredAt = epochToDate(raw.enterDateTime); if (!enteredAt) errors.push('enterDateTime missing');
  const leftAt = type === 'FENCE_EXIT' ? epochToDate(raw.exitDateTime) : null;
  if (type === 'FENCE_EXIT' && !leftAt) errors.push('exitDateTime missing on FENCE_EXIT');
  if (errors.length) return { ok: false, errors };
  const person = normPerson(raw.person), asset = normAsset(raw.asset), fleet = normFleet(raw.fleet);
  return { ok: true, v: { trackerId: tracker.trackerId, tracker, asset, fleet, geofenceId: fence.geofenceId, geofenceName: fence.name, fenceGroup: fence.fenceGroup, type, enteredAt, leftAt,
    durationMin: leftAt ? (num(raw.durationMinutes) ?? Math.round((leftAt - enteredAt) / 60000)) : null,
    personId: person ? person.personId : null, personName: person ? person.name : null, vin: asset ? asset.vin : null, fleetId: fleet ? fleet.fleetId : null } };
}
function normStop(raw) {
  const errors = [];
  const tracker = normTracker(raw.tracker); if (!tracker || tracker.trackerId == null) errors.push('tracker.trackerId missing');
  const startAt = epochToDate(raw.startDateTime); if (!startAt) errors.push('startDateTime missing');
  const endAt = epochToDate(raw.endDateTime);
  const lat = num(raw.latitude), lng = num(raw.longitude);
  if (lat == null || lat < -90 || lat > 90 || lng == null || lng < -180 || lng > 180) errors.push('latitude/longitude out of range');
  if (errors.length) return { ok: false, errors };
  const kind = String(raw.stopType || '').toLowerCase();
  const stopType = /idl/.test(kind) ? 'idle' : /off/.test(kind) ? 'off' : (kind || 'stop');
  const person = normPerson(raw.person), asset = normAsset(raw.asset), fence = normFence(raw.geofence), address = normAddress(raw.address);
  return { ok: true, s: { trackerId: tracker.trackerId, tracker, asset, startAt, endAt, stopType, durationMin: num(raw.durationMinutes) ?? (endAt ? Math.round((endAt - startAt) / 60000) : null),
    lat, lng, address, addressLine: address ? address.line : null, geofenceId: fence ? fence.geofenceId : null, geofenceName: fence ? fence.name : null,
    personId: person ? person.personId : null, personName: person ? person.name : null, vin: asset ? asset.vin : null } };
}
function normVehicleTrip(raw) {
  const errors = [];
  const tracker = normTracker(raw.tracker); if (!tracker || tracker.trackerId == null) errors.push('tracker.trackerId missing');
  const startAt = epochToDate(raw.startDateTime); if (!startAt) errors.push('startDateTime missing');
  const endAt = epochToDate(raw.endDateTime);
  if (errors.length) return { ok: false, errors };
  const person = normPerson(raw.person), asset = normAsset(raw.asset), sa = normAddress(raw.startAddress), ea = normAddress(raw.endAddress);
  const sf = normFence(raw.startGeofence), ef = normFence(raw.endGeofence);
  return { ok: true, t: { trackerId: tracker.trackerId, tracker, asset, startAt, endAt, startLat: num(raw.startLatitude), startLng: num(raw.startLongitude), endLat: num(raw.endLatitude), endLng: num(raw.endLongitude),
    startAddress: sa, startAddressLine: sa ? sa.line : null, endAddress: ea, endAddressLine: ea ? ea.line : null, authorized: bool(raw.authorized),
    durationMin: num(raw.durationMinutes) ?? (endAt ? Math.round((endAt - startAt) / 60000) : null), distanceMi: num(raw.distanceMiles),
    authorizedMi: num(raw.authorizedMiles ?? raw['authorized Miles']), unauthorizedMi: num(raw.unauthorizedMiles),
    startGeofenceId: sf ? sf.geofenceId : null, startGeofenceName: sf ? sf.name : null, endGeofenceId: ef ? ef.geofenceId : null, endGeofenceName: ef ? ef.name : null,
    personId: person ? person.personId : null, personName: person ? person.name : null, vin: asset ? asset.vin : null } };
}
function normUsage(raw) {
  const errors = [];
  const tracker = normTracker(raw.tracker); if (!tracker || tracker.trackerId == null) errors.push('tracker.trackerId missing');
  const startAt = epochToDate(raw.startDate ?? raw.startDateTime); if (!startAt) errors.push('startDate missing');
  const endAt = epochToDate(raw.endDate ?? raw.endDateTime);
  if (errors.length) return { ok: false, errors };
  const person = normPerson(raw.person), asset = normAsset(raw.asset), sa = normAddress(raw.startAddress), ea = normAddress(raw.endAddress);
  const sf = normFence(raw.startGeofence), ef = normFence(raw.endGeofence);
  return { ok: true, u: { trackerId: tracker.trackerId, tracker, asset, startAt, endAt, engineOn: bool(raw.engineOn),
    durationMin: num(raw.durationMinutes) ?? (endAt ? Math.round((endAt - startAt) / 60000) : null),
    startLat: num(raw.startLatitude), startLng: num(raw.startLongitude), endLat: num(raw.endLatitude), endLng: num(raw.endLongitude),
    startAddress: sa, startAddressLine: sa ? sa.line : null, endAddress: ea, endAddressLine: ea ? ea.line : null,
    startGeofenceId: sf ? sf.geofenceId : null, startGeofenceName: sf ? sf.name : null, endGeofenceId: ef ? ef.geofenceId : null, endGeofenceName: ef ? ef.name : null,
    personId: person ? person.personId : null, personName: person ? person.name : null, vin: asset ? asset.vin : null } };
}
const iso = d => d ? (d instanceof Date ? d.toISOString() : new Date(d).toISOString()) : null;
const memVisit = v => ({ trackerId: v.trackerId, geofenceId: v.geofenceId, geofenceName: v.geofenceName, fenceGroup: v.fenceGroup, enteredAt: iso(v.enteredAt), leftAt: iso(v.leftAt), durationMin: v.durationMin, personId: v.personId, personName: v.personName, vin: v.vin, source: 'Linxup geofence' });
const memStop = s => ({ trackerId: s.trackerId, startAt: iso(s.startAt), endAt: iso(s.endAt), stopType: s.stopType, durationMin: s.durationMin, lat: s.lat, lng: s.lng, address: s.address, addressLine: s.addressLine, geofenceId: s.geofenceId, geofenceName: s.geofenceName, personId: s.personId, personName: s.personName, vin: s.vin, source: 'Linxup stop' });
const memTrip = t => ({ trackerId: t.trackerId, startAt: iso(t.startAt), endAt: iso(t.endAt), startLat: t.startLat, startLng: t.startLng, endLat: t.endLat, endLng: t.endLng, startAddress: t.startAddress, startAddressLine: t.startAddressLine, endAddress: t.endAddress, endAddressLine: t.endAddressLine, authorized: t.authorized, durationMin: t.durationMin, distanceMi: t.distanceMi, authorizedMi: t.authorizedMi, unauthorizedMi: t.unauthorizedMi, startGeofenceId: t.startGeofenceId, startGeofenceName: t.startGeofenceName, endGeofenceId: t.endGeofenceId, endGeofenceName: t.endGeofenceName, personId: t.personId, personName: t.personName, vin: t.vin, source: 'Linxup vehicle trip' });
const memUsage = u => ({ trackerId: u.trackerId, startAt: iso(u.startAt), endAt: iso(u.endAt), engineOn: u.engineOn, durationMin: u.durationMin, startLat: u.startLat, startLng: u.startLng, endLat: u.endLat, endLng: u.endLng, startAddress: u.startAddress, startAddressLine: u.startAddressLine, endAddress: u.endAddress, endAddressLine: u.endAddressLine, startGeofenceId: u.startGeofenceId, startGeofenceName: u.startGeofenceName, endGeofenceId: u.endGeofenceId, endGeofenceName: u.endGeofenceName, personId: u.personId, personName: u.personName, vin: u.vin, source: 'Linxup usage' });
const nid = v => v == null ? null : Number(v);
const rowVisit = r => ({ trackerId: Number(r.tracker_id), geofenceId: Number(r.geofence_id), geofenceName: r.geofence_name, fenceGroup: r.fence_group, enteredAt: iso(r.entered_at), leftAt: iso(r.left_at), durationMin: r.duration_min, personId: nid(r.person_id), personName: r.person_name, vin: r.vin, source: 'Linxup geofence' });
const rowStop = r => ({ trackerId: Number(r.tracker_id), startAt: iso(r.start_at), endAt: iso(r.end_at), stopType: r.stop_type, durationMin: r.duration_min, lat: r.lat, lng: r.lng, address: r.address, addressLine: r.address_line, geofenceId: nid(r.geofence_id), geofenceName: r.geofence_name, personId: nid(r.person_id), personName: r.person_name, vin: r.vin, source: 'Linxup stop' });
const rowTrip = r => ({ trackerId: Number(r.tracker_id), startAt: iso(r.start_at), endAt: iso(r.end_at), startLat: r.start_lat, startLng: r.start_lng, endLat: r.end_lat, endLng: r.end_lng, startAddress: r.start_address, startAddressLine: r.start_address_line, endAddress: r.end_address, endAddressLine: r.end_address_line, authorized: r.authorized, durationMin: r.duration_min, distanceMi: r.distance_mi, authorizedMi: r.authorized_mi, unauthorizedMi: r.unauthorized_mi, startGeofenceId: nid(r.start_geofence_id), startGeofenceName: r.start_geofence_name, endGeofenceId: nid(r.end_geofence_id), endGeofenceName: r.end_geofence_name, personId: nid(r.person_id), personName: r.person_name, vin: r.vin, source: 'Linxup vehicle trip' });
const rowUsage = r => ({ trackerId: Number(r.tracker_id), startAt: iso(r.start_at), endAt: iso(r.end_at), engineOn: r.engine_on, durationMin: r.duration_min, startLat: r.start_lat, startLng: r.start_lng, endLat: r.end_lat, endLng: r.end_lng, startAddress: r.start_address, startAddressLine: r.start_address_line, endAddress: r.end_address, endAddressLine: r.end_address_line, startGeofenceId: nid(r.start_geofence_id), startGeofenceName: r.start_geofence_name, endGeofenceId: nid(r.end_geofence_id), endGeofenceName: r.end_geofence_name, personId: nid(r.person_id), personName: r.person_name, vin: r.vin, source: 'Linxup usage' });
const J = v => v == null ? null : JSON.stringify(v);

// One URL per type is the plan; when only one URL is possible, classify by shape.
function classify(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.alertId !== undefined) return 'alert';
  if (raw.statusChangeType !== undefined) return 'device-status';
  if (raw.eventType !== undefined) return 'geofence-event';
  if (raw.stopType !== undefined) return 'stop';
  if (raw.distanceMiles !== undefined) return 'trip';
  if (raw.mediaId !== undefined) return 'media';
  if (raw.geofenceId !== undefined && raw.action !== undefined) return 'geofence-change';
  if (raw.leftBehindTimestamp !== undefined) return 'item-left-behind';
  if (raw.trackedItem !== undefined) return 'item-location';
  if (raw.engineOn !== undefined && raw.durationMinutes !== undefined && (raw.startDate !== undefined || raw.startDateTime !== undefined)) return 'usage-hours';
  if (raw.date !== undefined && raw.latitude !== undefined) return 'position';
  if (raw.tracker !== undefined) return 'device-update';
  return null;
}

const POS_COLS = ['tracker_id', 'at', 'lat', 'lng', 'altitude', 'speed', 'heading', 'direction', 'odometer', 'battery', 'fuel_level', 'accuracy', 'signal',
  'est_speed_limit', 'speeding', 'behavior_code', 'engine_on', 'edit_at', 'address', 'address_line', 'geofence_id', 'geofence_name', 'person_id', 'person_name', 'batched', 'sensor', 'received_at'];
const POS_COLDEFS = `tracker_id BIGINT NOT NULL, at TIMESTAMPTZ NOT NULL, lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL,
  altitude REAL, speed REAL, heading TEXT, direction REAL, odometer DOUBLE PRECISION, battery TEXT, fuel_level TEXT, accuracy TEXT, signal TEXT,
  est_speed_limit REAL, speeding BOOLEAN, behavior_code TEXT, engine_on BOOLEAN, edit_at TIMESTAMPTZ, address JSONB, address_line TEXT,
  geofence_id BIGINT, geofence_name TEXT, person_id BIGINT, person_name TEXT, batched TEXT, sensor JSONB, received_at TIMESTAMPTZ NOT NULL DEFAULT now()`;
const POS_JSON = new Set(['address', 'sensor']);
function posValues(p, receivedAt) {
  return [p.trackerId, p.at, p.lat, p.lng, p.altitude, p.speed, p.heading, p.direction, p.odometer, p.battery, p.fuelLevel, p.accuracy, p.signal,
    p.estSpeedLimit, p.speeding, p.behaviorCode, p.engineOn, p.editAt, p.address ? JSON.stringify(p.address) : null, p.addressLine, p.geofenceId, p.geofenceName,
    p.personId, p.personName, p.batched, p.sensor == null ? null : JSON.stringify(p.sensor), receivedAt];
}
// The in-memory shape of a latest position (also what the API returns).
function memPosition(p, receivedAt) {
  return { trackerId: p.trackerId, at: p.at.toISOString(), lat: p.lat, lng: p.lng, altitude: p.altitude, speed: p.speed, heading: p.heading, direction: p.direction,
    odometer: p.odometer, battery: p.battery, fuelLevel: p.fuelLevel, accuracy: p.accuracy, signal: p.signal, estSpeedLimit: p.estSpeedLimit, speeding: p.speeding,
    behaviorCode: p.behaviorCode, engineOn: p.engineOn, editAt: p.editAt ? p.editAt.toISOString() : null, address: p.address, addressLine: p.addressLine,
    geofenceId: p.geofenceId, geofenceName: p.geofenceName, personId: p.personId, personName: p.personName, batched: p.batched, sensor: p.sensor, receivedAt: receivedAt.toISOString() };
}
function rowToMemPosition(r) {
  return { trackerId: Number(r.tracker_id), at: new Date(r.at).toISOString(), lat: r.lat, lng: r.lng, altitude: r.altitude, speed: r.speed, heading: r.heading, direction: r.direction,
    odometer: r.odometer, battery: r.battery, fuelLevel: r.fuel_level, accuracy: r.accuracy, signal: r.signal, estSpeedLimit: r.est_speed_limit, speeding: r.speeding,
    behaviorCode: r.behavior_code, engineOn: r.engine_on, editAt: r.edit_at ? new Date(r.edit_at).toISOString() : null, address: r.address, addressLine: r.address_line,
    geofenceId: r.geofence_id == null ? null : Number(r.geofence_id), geofenceName: r.geofence_name, personId: r.person_id == null ? null : Number(r.person_id), personName: r.person_name,
    batched: r.batched, sensor: r.sensor, receivedAt: new Date(r.received_at).toISOString() };
}
function rowToMemTracker(r) {
  return { trackerId: Number(r.tracker_id), name: r.name, deviceNumber: r.device_number, deviceSerialNumber: r.device_serial, vin: r.vin, make: r.make, model: r.model, year: r.year,
    licensePlate: r.license_plate, companyId: r.company_id == null ? null : Number(r.company_id), fleetId: r.fleet_id == null ? null : Number(r.fleet_id), fleetName: r.fleet_name,
    personId: r.person_id == null ? null : Number(r.person_id), personName: r.person_name, active: r.active !== false, statusChangedAt: r.status_changed_at ? new Date(r.status_changed_at).toISOString() : null,
    firstSeenAt: r.first_seen_at ? new Date(r.first_seen_at).toISOString() : null, lastMessageAt: r.last_message_at ? new Date(r.last_message_at).toISOString() : null };
}

class Linxup {
  // opts: { token, tokenNext, companyId, getPg, filePath, failWrites, log }
  constructor(opts) {
    this.token = opts.token || ''; this.tokenNext = opts.tokenNext || '';
    this.companyId = num(opts.companyId);
    this.getPg = opts.getPg || (() => null);
    this.filePath = opts.filePath;
    this.failWrites = opts.failWrites || (() => false);
    this.logger = opts.log || console;
    this.enabled = !!this.token;
    this.trackers = new Map();   // trackerId → mirror row
    this.latest = new Map();     // trackerId → latest position
    this.geofences = new Map();  // geofenceId → { geofenceId, name, fenceGroup }
    this.lastVisit = new Map();  // trackerId → most recent geofence visit (for the board's "Last geofence")
    this.file = null;            // dev mode: { trackers, latest, positions[], visits[], stops[], trips[], usage[], geofences{}, log[] }
    this.version = 0;
    this.counters = { received: 0, stored: 0, duplicates: 0, deferred: 0, dropped: 0, rejected: 0, unauthorized: 0, wrongCompany: 0, failed: 0 };
    this.lastMessageAt = {};     // type → ISO
    this.recent = [];            // last 50 log entries (memory)
    this.lastError = '';
  }
  get pg() { return this.getPg(); }

  async init() {
    if (this.pg) {
      await this.pg.query(`CREATE TABLE IF NOT EXISTS linxup_trackers (
        tracker_id BIGINT PRIMARY KEY, name TEXT, device_number TEXT, device_serial TEXT, vin TEXT, make TEXT, model TEXT, year INTEGER, license_plate TEXT,
        company_id BIGINT, fleet_id BIGINT, fleet_name TEXT, person_id BIGINT, person_name TEXT, active BOOLEAN NOT NULL DEFAULT true, status_changed_at TIMESTAMPTZ,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_message_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await this.pg.query(`CREATE TABLE IF NOT EXISTS linxup_positions (${POS_COLDEFS}, PRIMARY KEY (tracker_id, at))`);
      await this.pg.query(`CREATE INDEX IF NOT EXISTS linxup_positions_at ON linxup_positions (at)`);
      await this.pg.query(`CREATE TABLE IF NOT EXISTS linxup_latest_positions (${POS_COLDEFS}, PRIMARY KEY (tracker_id))`);
      await this.pg.query(`CREATE TABLE IF NOT EXISTS linxup_geofences (geofence_id BIGINT PRIMARY KEY, name TEXT, fence_group TEXT, type TEXT, radius REAL, points JSONB,
        notification JSONB, vbt_kind TEXT, vbt_id TEXT, deleted_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await this.pg.query(`CREATE TABLE IF NOT EXISTS linxup_geofence_events (tracker_id BIGINT NOT NULL, geofence_id BIGINT NOT NULL, entered_at TIMESTAMPTZ NOT NULL,
        left_at TIMESTAMPTZ, duration_min REAL, geofence_name TEXT, fence_group TEXT, person_id BIGINT, person_name TEXT, load_id TEXT, trip_number INTEGER,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tracker_id, geofence_id, entered_at))`);
      await this.pg.query(`CREATE TABLE IF NOT EXISTS linxup_webhook_log (id BIGSERIAL PRIMARY KEY, received_at TIMESTAMPTZ NOT NULL DEFAULT now(), type TEXT NOT NULL,
        tracker_id BIGINT, outcome TEXT NOT NULL, http_status INTEGER, body_sha1 TEXT, note TEXT, body JSONB)`);
      await this.pg.query(`CREATE INDEX IF NOT EXISTS linxup_webhook_log_received ON linxup_webhook_log (received_at)`);
      // L2 evidence tables. Keyed by the event's own time, never by arrival.
      await this.pg.query(`ALTER TABLE linxup_geofence_events ADD COLUMN IF NOT EXISTS vin TEXT`);
      await this.pg.query(`ALTER TABLE linxup_geofence_events ADD COLUMN IF NOT EXISTS fleet_id BIGINT`);
      await this.pg.query(`CREATE INDEX IF NOT EXISTS linxup_geofence_events_tracker_entered ON linxup_geofence_events (tracker_id, entered_at DESC)`);
      await this.pg.query(`CREATE TABLE IF NOT EXISTS linxup_stops (tracker_id BIGINT NOT NULL, start_at TIMESTAMPTZ NOT NULL, end_at TIMESTAMPTZ, stop_type TEXT, duration_min REAL,
        lat DOUBLE PRECISION, lng DOUBLE PRECISION, address JSONB, address_line TEXT, geofence_id BIGINT, geofence_name TEXT, person_id BIGINT, person_name TEXT, vin TEXT,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tracker_id, start_at))`);
      await this.pg.query(`CREATE TABLE IF NOT EXISTS linxup_vehicle_trips (tracker_id BIGINT NOT NULL, start_at TIMESTAMPTZ NOT NULL, end_at TIMESTAMPTZ,
        start_lat DOUBLE PRECISION, start_lng DOUBLE PRECISION, end_lat DOUBLE PRECISION, end_lng DOUBLE PRECISION, start_address JSONB, start_address_line TEXT, end_address JSONB, end_address_line TEXT,
        authorized BOOLEAN, duration_min REAL, distance_mi REAL, authorized_mi REAL, unauthorized_mi REAL, start_geofence_id BIGINT, start_geofence_name TEXT, end_geofence_id BIGINT, end_geofence_name TEXT,
        person_id BIGINT, person_name TEXT, vin TEXT, received_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tracker_id, start_at))`);
      await this.pg.query(`CREATE TABLE IF NOT EXISTS linxup_usage (tracker_id BIGINT NOT NULL, start_at TIMESTAMPTZ NOT NULL, end_at TIMESTAMPTZ, engine_on BOOLEAN, duration_min REAL,
        start_lat DOUBLE PRECISION, start_lng DOUBLE PRECISION, end_lat DOUBLE PRECISION, end_lng DOUBLE PRECISION, start_address JSONB, start_address_line TEXT, end_address JSONB, end_address_line TEXT,
        start_geofence_id BIGINT, start_geofence_name TEXT, end_geofence_id BIGINT, end_geofence_name TEXT, person_id BIGINT, person_name TEXT, vin TEXT,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tracker_id, start_at))`);
      const t = await this.pg.query(`SELECT * FROM linxup_trackers`);
      t.rows.forEach(r => this.trackers.set(Number(r.tracker_id), rowToMemTracker(r)));
      const l = await this.pg.query(`SELECT * FROM linxup_latest_positions`);
      l.rows.forEach(r => this.latest.set(Number(r.tracker_id), rowToMemPosition(r)));
      const g = await this.pg.query(`SELECT geofence_id, name, fence_group FROM linxup_geofences WHERE deleted_at IS NULL`);
      g.rows.forEach(r => this.geofences.set(Number(r.geofence_id), { geofenceId: Number(r.geofence_id), name: r.name, fenceGroup: r.fence_group }));
      const lv = await this.pg.query(`SELECT DISTINCT ON (tracker_id) * FROM linxup_geofence_events ORDER BY tracker_id, entered_at DESC`);
      lv.rows.forEach(r => this.lastVisit.set(Number(r.tracker_id), rowVisit(r)));
    } else {
      this.file = { trackers: {}, latest: {}, positions: [], visits: [], stops: [], trips: [], usage: [], geofences: {}, log: [] };
      try { if (this.filePath && fs.existsSync(this.filePath)) this.file = { ...this.file, ...JSON.parse(fs.readFileSync(this.filePath, 'utf8')) }; } catch (e) { this.logger.warn('[linxup] telemetry file unreadable, starting empty:', e.message); }
      Object.values(this.file.trackers).forEach(t => this.trackers.set(Number(t.trackerId), t));
      Object.values(this.file.latest).forEach(p => this.latest.set(Number(p.trackerId), p));
      Object.values(this.file.geofences).forEach(g => this.geofences.set(Number(g.geofenceId), g));
      this.file.visits.forEach(v => this._noteVisit(v));
    }
    this.mode = this.pg ? 'postgres' : 'file';
  }
  _noteVisit(v) { const cur = this.lastVisit.get(v.trackerId); if (!cur || Date.parse(v.enteredAt) >= Date.parse(cur.enteredAt)) this.lastVisit.set(v.trackerId, v); }

  // ── auth ──
  authorize(headers) {
    if (!this.enabled) return { ok: false, status: 404 };
    const h = headers['authorization'] || headers['authentication'] || '';
    const presented = String(Array.isArray(h) ? h[0] : h).replace(/^\s*Bearer\s+/i, '').trim();
    if (!presented) return { ok: false, status: 401 };
    const eq = (a, b) => { const x = crypto.createHash('sha256').update(a).digest(), y = crypto.createHash('sha256').update(b).digest(); return crypto.timingSafeEqual(x, y); };
    if (eq(presented, this.token) || (this.tokenNext && eq(presented, this.tokenNext))) return { ok: true };
    return { ok: false, status: 401 };
  }

  // ── storage primitives (both backends) ──
  _guard() { if (this.failWrites()) { const e = new Error('telemetry store: simulated database write failure'); e.code = 'ECONNRESET'; throw e; } }
  _flushFile() { if (!this.filePath) return; fs.writeFileSync(this.filePath, JSON.stringify(this.file)); }

  // Merge what a message says about a tracker into the mirror. `patch` may carry
  // person: null to clear (Device Update), active (Device Status).
  async upsertTracker(patch, at) {
    this._guard();
    const id = num(patch.trackerId); if (id == null) return null;
    const cur = this.trackers.get(id) || { trackerId: id, active: true, firstSeenAt: at.toISOString() };
    const next = { ...cur };
    for (const k of ['name', 'deviceNumber', 'deviceSerialNumber', 'vin', 'make', 'model', 'year', 'licensePlate', 'companyId', 'fleetId', 'fleetName']) if (patch[k] !== undefined && patch[k] !== null) next[k] = patch[k];
    if (patch.personGiven) { next.personId = patch.personId ?? null; next.personName = patch.personName ?? null; }
    if (patch.active !== undefined) { next.active = !!patch.active; next.statusChangedAt = at.toISOString(); }
    next.lastMessageAt = at.toISOString();
    const changed = JSON.stringify({ ...cur, lastMessageAt: 0 }) !== JSON.stringify({ ...next, lastMessageAt: 0 });
    if (this.pg) {
      await this.pg.query(`INSERT INTO linxup_trackers (tracker_id, name, device_number, device_serial, vin, make, model, year, license_plate, company_id, fleet_id, fleet_name,
          person_id, person_name, active, status_changed_at, first_seen_at, last_message_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now())
        ON CONFLICT (tracker_id) DO UPDATE SET name=$2, device_number=$3, device_serial=$4, vin=$5, make=$6, model=$7, year=$8, license_plate=$9, company_id=$10, fleet_id=$11,
          fleet_name=$12, person_id=$13, person_name=$14, active=$15, status_changed_at=$16, last_message_at=$18, updated_at=now()`,
        [id, next.name ?? null, next.deviceNumber ?? null, next.deviceSerialNumber ?? null, next.vin ?? null, next.make ?? null, next.model ?? null, next.year ?? null, next.licensePlate ?? null,
         next.companyId ?? null, next.fleetId ?? null, next.fleetName ?? null, next.personId ?? null, next.personName ?? null, next.active !== false, next.statusChangedAt ?? null,
         next.firstSeenAt ?? at.toISOString(), next.lastMessageAt]);
    } else { this.file.trackers[id] = next; this._flushFile(); }
    this.trackers.set(id, next);
    if (changed) this.version++;
    return next;
  }

  async storePosition(p, receivedAt) {
    this._guard();
    let stored, latestUpdated;
    if (this.pg) {
      const ph = POS_COLS.map((c, i) => POS_JSON.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`).join(',');
      const vals = posValues(p, receivedAt);
      const r1 = await this.pg.query(`INSERT INTO linxup_positions (${POS_COLS.join(',')}) VALUES (${ph}) ON CONFLICT (tracker_id, at) DO NOTHING`, vals);
      stored = r1.rowCount === 1;
      const sets = POS_COLS.filter(c => c !== 'tracker_id').map(c => `${c} = EXCLUDED.${c}`).join(', ');
      const r2 = await this.pg.query(`INSERT INTO linxup_latest_positions (${POS_COLS.join(',')}) VALUES (${ph}) ON CONFLICT (tracker_id) DO UPDATE SET ${sets} WHERE linxup_latest_positions.at < EXCLUDED.at`, vals);
      latestUpdated = r2.rowCount === 1;
    } else {
      const key = `${p.trackerId}:${p.at.toISOString()}`;
      stored = !this.file.positions.some(x => `${x.trackerId}:${x.at}` === key);
      if (stored) this.file.positions.push(memPosition(p, receivedAt));
      const cur = this.file.latest[p.trackerId];
      latestUpdated = !cur || Date.parse(cur.at) < p.at.getTime();
      if (latestUpdated) this.file.latest[p.trackerId] = memPosition(p, receivedAt);
      this._flushFile();
    }
    if (latestUpdated) { this.latest.set(p.trackerId, memPosition(p, receivedAt)); this.version++; }
    return { stored, duplicate: !stored, latestUpdated };
  }

  // The geofence mirror: identity only (id, name, group), learned from every
  // event that names a fence. Mapping a fence to a VBT place is VBT's data.
  async upsertGeofence(f) {
    if (!f || f.geofenceId == null) return;
    const cur = this.geofences.get(f.geofenceId);
    const next = { geofenceId: f.geofenceId, name: f.name ?? (cur ? cur.name : null), fenceGroup: f.fenceGroup ?? (cur ? cur.fenceGroup : null) };
    if (cur && cur.name === next.name && cur.fenceGroup === next.fenceGroup) return;
    if (this.pg) await this.pg.query(`INSERT INTO linxup_geofences (geofence_id, name, fence_group, updated_at) VALUES ($1,$2,$3,now())
      ON CONFLICT (geofence_id) DO UPDATE SET name = COALESCE(EXCLUDED.name, linxup_geofences.name), fence_group = COALESCE(EXCLUDED.fence_group, linxup_geofences.fence_group), updated_at = now()`, [next.geofenceId, next.name, next.fenceGroup]);
    else { this.file.geofences[next.geofenceId] = next; this._flushFile(); }
    this.geofences.set(next.geofenceId, next); this.version++;
  }
  // One visit per (tracker, fence, enter time). An EXIT completes the visit
  // whether its ENTER came before or after it; repeats change nothing.
  async storeVisit(v, receivedAt) {
    this._guard();
    let existing = null;
    if (this.pg) { const r = await this.pg.query(`SELECT left_at, duration_min FROM linxup_geofence_events WHERE tracker_id=$1 AND geofence_id=$2 AND entered_at=$3`, [v.trackerId, v.geofenceId, v.enteredAt]); existing = r.rows[0] ? { leftAt: iso(r.rows[0].left_at), durationMin: r.rows[0].duration_min } : null; }
    else existing = this.file.visits.find(x => x.trackerId === v.trackerId && x.geofenceId === v.geofenceId && x.enteredAt === v.enteredAt.toISOString()) || null;
    const duplicate = !!existing && (v.type === 'FENCE_ENTER' || (existing.leftAt && v.leftAt && existing.leftAt === v.leftAt.toISOString()));
    if (!duplicate) {
      if (this.pg) await this.pg.query(`INSERT INTO linxup_geofence_events (tracker_id, geofence_id, entered_at, left_at, duration_min, geofence_name, fence_group, person_id, person_name, vin, fleet_id, received_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (tracker_id, geofence_id, entered_at) DO UPDATE SET left_at = COALESCE(EXCLUDED.left_at, linxup_geofence_events.left_at), duration_min = COALESCE(EXCLUDED.duration_min, linxup_geofence_events.duration_min),
            geofence_name = COALESCE(EXCLUDED.geofence_name, linxup_geofence_events.geofence_name), fence_group = COALESCE(EXCLUDED.fence_group, linxup_geofence_events.fence_group),
            person_id = COALESCE(EXCLUDED.person_id, linxup_geofence_events.person_id), person_name = COALESCE(EXCLUDED.person_name, linxup_geofence_events.person_name), vin = COALESCE(EXCLUDED.vin, linxup_geofence_events.vin)`,
        [v.trackerId, v.geofenceId, v.enteredAt, v.leftAt, v.durationMin, v.geofenceName, v.fenceGroup, v.personId, v.personName, v.vin, v.fleetId, receivedAt]);
      else {
        const m = memVisit(v);
        if (existing) { if (m.leftAt) { existing.leftAt = m.leftAt; existing.durationMin = m.durationMin; } for (const k of ['geofenceName', 'fenceGroup', 'personId', 'personName', 'vin']) if (m[k] != null) existing[k] = m[k]; }
        else this.file.visits.push(m);
        this._flushFile();
      }
      this.version++;
    }
    const mem = this.pg ? memVisit(v) : (existing || memVisit(v));
    if (existing && this.pg && !mem.leftAt && existing.leftAt) { mem.leftAt = existing.leftAt; mem.durationMin = existing.durationMin; }
    this._noteVisit(mem);
    return { stored: !duplicate, duplicate };
  }
  async _storeKeyed(table, fileKey, key, row, cols, vals, toMem) {
    // Stops, vehicle trips and usage periods: keyed by (tracker, start time);
    // a repeat is a no-op, a revised end time updates the row.
    this._guard();
    let duplicate;
    if (this.pg) {
      const r = await this.pg.query(`SELECT end_at FROM ${table} WHERE tracker_id=$1 AND start_at=$2`, [key.trackerId, key.startAt]);
      duplicate = !!r.rows[0] && iso(r.rows[0].end_at) === iso(row.endAt);
      if (!duplicate) {
        const ph = cols.map((c, i) => /address$/.test(c) ? `$${i + 1}::jsonb` : `$${i + 1}`).join(',');
        const sets = cols.filter(c => c !== 'tracker_id' && c !== 'start_at').map(c => `${c} = EXCLUDED.${c}`).join(', ');
        await this.pg.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph}) ON CONFLICT (tracker_id, start_at) DO UPDATE SET ${sets}`, vals);
      }
    } else {
      const arr = this.file[fileKey];
      const i = arr.findIndex(x => x.trackerId === key.trackerId && x.startAt === key.startAt.toISOString());
      const m = toMem(row);
      duplicate = i >= 0 && arr[i].endAt === m.endAt;
      if (!duplicate) { if (i >= 0) arr[i] = m; else arr.push(m); this._flushFile(); }
    }
    if (!duplicate) this.version++;
    return { stored: !duplicate, duplicate };
  }
  storeStop(s, receivedAt) {
    return this._storeKeyed('linxup_stops', 'stops', { trackerId: s.trackerId, startAt: s.startAt }, s,
      ['tracker_id', 'start_at', 'end_at', 'stop_type', 'duration_min', 'lat', 'lng', 'address', 'address_line', 'geofence_id', 'geofence_name', 'person_id', 'person_name', 'vin', 'received_at'],
      [s.trackerId, s.startAt, s.endAt, s.stopType, s.durationMin, s.lat, s.lng, J(s.address), s.addressLine, s.geofenceId, s.geofenceName, s.personId, s.personName, s.vin, receivedAt], memStop);
  }
  storeVehicleTrip(t, receivedAt) {
    return this._storeKeyed('linxup_vehicle_trips', 'trips', { trackerId: t.trackerId, startAt: t.startAt }, t,
      ['tracker_id', 'start_at', 'end_at', 'start_lat', 'start_lng', 'end_lat', 'end_lng', 'start_address', 'start_address_line', 'end_address', 'end_address_line', 'authorized', 'duration_min', 'distance_mi', 'authorized_mi', 'unauthorized_mi',
       'start_geofence_id', 'start_geofence_name', 'end_geofence_id', 'end_geofence_name', 'person_id', 'person_name', 'vin', 'received_at'],
      [t.trackerId, t.startAt, t.endAt, t.startLat, t.startLng, t.endLat, t.endLng, J(t.startAddress), t.startAddressLine, J(t.endAddress), t.endAddressLine, t.authorized, t.durationMin, t.distanceMi, t.authorizedMi, t.unauthorizedMi,
       t.startGeofenceId, t.startGeofenceName, t.endGeofenceId, t.endGeofenceName, t.personId, t.personName, t.vin, receivedAt], memTrip);
  }
  storeUsage(u, receivedAt) {
    return this._storeKeyed('linxup_usage', 'usage', { trackerId: u.trackerId, startAt: u.startAt }, u,
      ['tracker_id', 'start_at', 'end_at', 'engine_on', 'duration_min', 'start_lat', 'start_lng', 'end_lat', 'end_lng', 'start_address', 'start_address_line', 'end_address', 'end_address_line',
       'start_geofence_id', 'start_geofence_name', 'end_geofence_id', 'end_geofence_name', 'person_id', 'person_name', 'vin', 'received_at'],
      [u.trackerId, u.startAt, u.endAt, u.engineOn, u.durationMin, u.startLat, u.startLng, u.endLat, u.endLng, J(u.startAddress), u.startAddressLine, J(u.endAddress), u.endAddressLine,
       u.startGeofenceId, u.startGeofenceName, u.endGeofenceId, u.endGeofenceName, u.personId, u.personName, u.vin, receivedAt], memUsage);
  }
  // Everything the tracker did in a time window, for a load's evidence.
  async window(trackerId, fromMs, toMs) {
    const id = num(trackerId), from = new Date(fromMs), to = new Date(toMs);
    const overlap = (s, e) => Date.parse(s) <= toMs && (e == null || Date.parse(e) >= fromMs);
    if (this.pg) {
      const q = (sql, map) => this.pg.query(sql, [id, from, to]).then(r => r.rows.map(map));
      const [visits, stops, trips, usage, positions] = await Promise.all([
        q(`SELECT * FROM linxup_geofence_events WHERE tracker_id=$1 AND entered_at <= $3 AND (left_at IS NULL OR left_at >= $2) ORDER BY entered_at`, rowVisit),
        q(`SELECT * FROM linxup_stops WHERE tracker_id=$1 AND start_at <= $3 AND (end_at IS NULL OR end_at >= $2) ORDER BY start_at`, rowStop),
        q(`SELECT * FROM linxup_vehicle_trips WHERE tracker_id=$1 AND start_at <= $3 AND (end_at IS NULL OR end_at >= $2) ORDER BY start_at`, rowTrip),
        q(`SELECT * FROM linxup_usage WHERE tracker_id=$1 AND start_at <= $3 AND (end_at IS NULL OR end_at >= $2) ORDER BY start_at`, rowUsage),
        q(`SELECT tracker_id, at, lat, lng, speed, engine_on, geofence_name, address_line FROM linxup_positions WHERE tracker_id=$1 AND at BETWEEN $2 AND $3 ORDER BY at LIMIT 5000`,
          r => ({ at: iso(r.at), lat: r.lat, lng: r.lng, speed: r.speed, engineOn: r.engine_on, geofenceName: r.geofence_name, addressLine: r.address_line })),
      ]);
      return { visits, stops, trips, usage, positions };
    }
    const f = this.file;
    return {
      visits: f.visits.filter(v => v.trackerId === id && overlap(v.enteredAt, v.leftAt)).sort((a, b) => a.enteredAt.localeCompare(b.enteredAt)),
      stops: f.stops.filter(s => s.trackerId === id && overlap(s.startAt, s.endAt)).sort((a, b) => a.startAt.localeCompare(b.startAt)),
      trips: f.trips.filter(t => t.trackerId === id && overlap(t.startAt, t.endAt)).sort((a, b) => a.startAt.localeCompare(b.startAt)),
      usage: f.usage.filter(u => u.trackerId === id && overlap(u.startAt, u.endAt)).sort((a, b) => a.startAt.localeCompare(b.startAt)),
      positions: f.positions.filter(p => p.trackerId === id && Date.parse(p.at) >= fromMs && Date.parse(p.at) <= toMs).sort((a, b) => a.at.localeCompare(b.at))
        .map(p => ({ at: p.at, lat: p.lat, lng: p.lng, speed: p.speed, engineOn: p.engineOn, geofenceName: p.geofenceName, addressLine: p.addressLine })),
    };
  }
  geofence(id) { return this.geofences.get(num(id)) || null; }
  listGeofences() { return [...this.geofences.values()].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))); }
  lastVisitFor(trackerId) { return this.lastVisit.get(num(trackerId)) || null; }

  async logMessage(entry) {
    const e = { receivedAt: new Date().toISOString(), ...entry };
    this.recent.unshift({ ...e, body: undefined }); if (this.recent.length > 50) this.recent.length = 50;
    try {
      if (this.pg) await this.pg.query(`INSERT INTO linxup_webhook_log (type, tracker_id, outcome, http_status, body_sha1, note, body) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [e.type, e.trackerId ?? null, e.outcome, e.status ?? null, e.sha1 ?? null, e.note ?? null, e.body === undefined ? null : JSON.stringify(e.body)]);
      else if (this.file) { this.file.log.push({ ...e, body: e.body === undefined ? undefined : e.body }); if (this.file.log.length > 5000) this.file.log.splice(0, this.file.log.length - 5000); this._flushFile(); }
    } catch (err) { this.lastError = 'log: ' + err.message; }
  }

  // ── retention ──
  async prune(now = Date.now()) {
    const out = { dropped: 0, thinned: 0, logs: 0 };
    if (this.pg) {
      out.dropped = (await this.pg.query(`DELETE FROM linxup_positions WHERE at < now() - ($1 || ' days')::interval`, [String(DROP_DAYS)])).rowCount;
      out.thinned = (await this.pg.query(`DELETE FROM linxup_positions p USING (
          SELECT tracker_id, at, row_number() OVER (PARTITION BY tracker_id, floor(extract(epoch FROM at) / $2) ORDER BY at) AS rn
          FROM linxup_positions WHERE at < now() - ($1 || ' days')::interval) k
        WHERE k.rn > 1 AND p.tracker_id = k.tracker_id AND p.at = k.at`, [String(RAW_DAYS), THIN_SECONDS])).rowCount;
      out.logs = (await this.pg.query(`DELETE FROM linxup_webhook_log WHERE received_at < now() - ($1 || ' days')::interval OR (type = 'position' AND received_at < now() - ($2 || ' days')::interval)`, [String(LOG_DAYS), String(LOG_POSITION_DAYS)])).rowCount;
    } else if (this.file) {
      const before = this.file.positions.length;
      const dropBefore = now - DROP_DAYS * 86400000, thinBefore = now - RAW_DAYS * 86400000;
      const keep = []; const seen = new Set();
      this.file.positions.sort((a, b) => a.trackerId - b.trackerId || Date.parse(a.at) - Date.parse(b.at)).forEach(x => {
        const t = Date.parse(x.at);
        if (t < dropBefore) { out.dropped++; return; }
        if (t < thinBefore) { const k = `${x.trackerId}:${Math.floor(t / 1000 / THIN_SECONDS)}`; if (seen.has(k)) { out.thinned++; return; } seen.add(k); }
        keep.push(x);
      });
      this.file.positions = keep;
      const lb = this.file.log.length;
      this.file.log = this.file.log.filter(e => { const t = Date.parse(e.receivedAt); return t >= now - LOG_DAYS * 86400000 && !(e.type === 'position' && t < now - LOG_POSITION_DAYS * 86400000); });
      out.logs = lb - this.file.log.length;
      if (before !== keep.length || out.logs) this._flushFile();
    }
    return out;
  }

  // ── message handling ──
  // Returns { status, json }. Never answers 200 for something it did not store.
  async handle(type, body, now = Date.now()) {
    const kind = TYPES[type];
    if (kind === undefined) return { status: 404, json: { error: 'Unknown Linxup message type' } };
    const items = Array.isArray(body) ? body : [body];
    if (!items.length || items.some(x => !x || typeof x !== 'object' || Array.isArray(x))) { this.counters.rejected++; return { status: 400, json: { error: 'Expected a JSON object or an array of objects' } }; }
    const receivedAt = new Date(now);
    const summary = { ok: true, type, received: items.length, stored: 0, duplicates: 0, deferred: 0, dropped: 0 };
    const errors = [];
    for (const raw of items) {
      const t = kind === 0 ? classify(raw) : type;
      if (!t) { errors.push('unrecognized message shape'); continue; }
      const sha1 = crypto.createHash('sha1').update(JSON.stringify(raw)).digest('hex');
      // Every message must be ours.
      if (this.companyId != null) {
        const cid = idOf(raw.company, 'companyId');
        if (cid !== this.companyId) { this.counters.wrongCompany++; await this.logMessage({ type: t, outcome: 'wrong-company', status: 403, sha1, note: `company ${cid}` }); return { status: 403, json: { error: 'Message is not for this account' } }; }
      }
      this.counters.received++; this.lastMessageAt[t] = receivedAt.toISOString();
      const k = TYPES[t];
      try {
        if (t === 'position') {
          const n = normalizePosition(raw, now);
          if (!n.ok) { errors.push(...n.errors); continue; }
          const p = n.p;
          await this.upsertTracker({ trackerId: p.trackerId, ...p.tracker, ...(p.asset || {}), companyId: p.company?.companyId ?? null, fleetId: p.fleet?.fleetId ?? null, fleetName: p.fleet?.name ?? null,
            ...(p.person ? { personGiven: true, personId: p.personId, personName: p.personName } : {}) }, p.at);
          const r = await this.storePosition(p, receivedAt);
          if (r.stored) { summary.stored++; this.counters.stored++; } else { summary.duplicates++; this.counters.duplicates++; }
          await this.logMessage({ type: t, trackerId: p.trackerId, outcome: r.stored ? (r.latestUpdated ? 'stored' : 'stored-older') : 'duplicate', status: 200, sha1 });
        } else if (t === 'device-status') {
          const tr = normTracker(raw.tracker), asset = normAsset(raw.asset), fleet = normFleet(raw.fleet), company = normCompany(raw.company);
          if (!tr || tr.trackerId == null) { errors.push('tracker.trackerId missing'); continue; }
          const active = String(raw.statusChangeType || '').toUpperCase() !== 'INACTIVATE';
          await this.upsertTracker({ trackerId: tr.trackerId, ...tr, ...(asset || {}), fleetId: fleet?.fleetId ?? null, fleetName: fleet?.name ?? null, companyId: company?.companyId ?? null, active }, receivedAt);
          summary.stored++; this.counters.stored++;
          await this.logMessage({ type: t, trackerId: tr.trackerId, outcome: active ? 'activated' : 'inactivated', status: 200, sha1, body: raw });
        } else if (t === 'device-update') {
          const tr = normTracker(raw.tracker), asset = normAsset(raw.asset), fleet = normFleet(raw.fleet), company = normCompany(raw.company), person = normPerson(raw.person);
          if (!tr || tr.trackerId == null) { errors.push('tracker.trackerId missing'); continue; }
          await this.upsertTracker({ trackerId: tr.trackerId, ...tr, ...(asset || {}), fleetId: fleet?.fleetId ?? null, fleetName: fleet?.name ?? null, companyId: company?.companyId ?? null,
            personGiven: true, personId: person ? person.personId : null, personName: person ? person.name : null }, receivedAt);
          summary.stored++; this.counters.stored++;
          await this.logMessage({ type: t, trackerId: tr.trackerId, outcome: 'updated', status: 200, sha1, body: raw });
        } else if (t === 'geofence-event') {
          const n = normFenceEvent(raw); if (!n.ok) { errors.push(...n.errors); continue; }
          const v = n.v;
          await this.upsertTracker({ trackerId: v.trackerId, ...v.tracker, ...(v.asset || {}), fleetId: v.fleetId, ...(v.personId != null ? { personGiven: true, personId: v.personId, personName: v.personName } : {}) }, receivedAt);
          await this.upsertGeofence({ geofenceId: v.geofenceId, name: v.geofenceName, fenceGroup: v.fenceGroup });
          const r = await this.storeVisit(v, receivedAt);
          if (r.stored) { summary.stored++; this.counters.stored++; } else { summary.duplicates++; this.counters.duplicates++; }
          await this.logMessage({ type: t, trackerId: v.trackerId, outcome: r.stored ? (v.type === 'FENCE_EXIT' ? 'exit' : 'enter') : 'duplicate', status: 200, sha1 });
        } else if (t === 'stop' || t === 'trip' || t === 'usage-hours') {
          const n = t === 'stop' ? normStop(raw) : t === 'trip' ? normVehicleTrip(raw) : normUsage(raw);
          if (!n.ok) { errors.push(...n.errors); continue; }
          const x = n.s || n.t || n.u;
          await this.upsertTracker({ trackerId: x.trackerId, ...x.tracker, ...(x.asset || {}), ...(x.personId != null ? { personGiven: true, personId: x.personId, personName: x.personName } : {}) }, receivedAt);
          for (const g of [x.geofenceId != null ? { geofenceId: x.geofenceId, name: x.geofenceName } : null, x.startGeofenceId != null ? { geofenceId: x.startGeofenceId, name: x.startGeofenceName } : null, x.endGeofenceId != null ? { geofenceId: x.endGeofenceId, name: x.endGeofenceName } : null]) if (g) await this.upsertGeofence(g);
          const r = t === 'stop' ? await this.storeStop(x, receivedAt) : t === 'trip' ? await this.storeVehicleTrip(x, receivedAt) : await this.storeUsage(x, receivedAt);
          if (r.stored) { summary.stored++; this.counters.stored++; } else { summary.duplicates++; this.counters.duplicates++; }
          await this.logMessage({ type: t, trackerId: x.trackerId, outcome: r.stored ? 'stored' : 'duplicate', status: 200, sha1 });
        } else if (k === 2) {
          // Kept raw for L3: the tracker is still mirrored so the link screen knows it.
          const tr = normTracker(raw.tracker);
          if (tr && tr.trackerId != null) await this.upsertTracker({ trackerId: tr.trackerId, ...tr, ...(normAsset(raw.asset) || {}) }, receivedAt);
          summary.deferred++; this.counters.deferred++;
          await this.logMessage({ type: t, trackerId: tr ? tr.trackerId : null, outcome: 'deferred', status: 200, sha1, body: raw });
        } else {
          summary.dropped++; this.counters.dropped++;
          await this.logMessage({ type: t, outcome: 'dropped', status: 200, sha1 });
        }
      } catch (e) {
        // Could not persist: say so, so Linxup has a reason to retry. Memory was not changed.
        this.counters.failed++; this.lastError = e.message;
        await this.logMessage({ type: t, outcome: 'failed', status: 503, sha1, note: e.message });
        return { status: 503, json: { error: 'Telemetry could not be stored; retry later', retry: true } };
      }
    }
    if (errors.length) { this.counters.rejected++; return { status: 400, json: { error: 'Invalid payload: ' + [...new Set(errors)].join('; '), ...summary, ok: false } }; }
    return { status: 200, json: summary };
  }

  // ── reads ──
  tracker(id) { return this.trackers.get(num(id)) || null; }
  latestFor(id) { return this.latest.get(num(id)) || null; }
  listTrackers() { return [...this.trackers.values()].map(t => ({ ...t, latestAt: (this.latest.get(t.trackerId) || {}).at || null })).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))); }
  listPersons() {
    const seen = new Map();
    for (const t of this.trackers.values()) if (t.personId != null) seen.set(t.personId, { personId: t.personId, name: t.personName || String(t.personId), trackerName: t.name });
    for (const p of this.latest.values()) if (p.personId != null && !seen.has(p.personId)) seen.set(p.personId, { personId: p.personId, name: p.personName || String(p.personId) });
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  health() {
    return { enabled: this.enabled, mode: this.mode || 'off', companyIdConfigured: this.companyId != null, trackers: this.trackers.size, latest: this.latest.size, geofences: this.geofences.size,
      counters: { ...this.counters }, lastMessageAt: { ...this.lastMessageAt }, lastError: this.lastError, version: this.version };
  }
}

module.exports = { Linxup, normalizePosition, classify, TYPES };
