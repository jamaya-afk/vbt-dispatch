// Geocoding — provider-independent, and only ever called from an explicit
// office action ("Set location → geocode this address"). Nothing in the
// live map, the PO screens or any refresh loop calls this module.
//
//   GEOCODER_PROVIDER  nominatim (default) | none
//   GEOCODER_URL       override the provider endpoint
//   GEOCODER_EMAIL     contact for Nominatim's usage policy (recommended)
//
// A result is { lat, lng, displayName, precision, provider } or null when
// the provider found nothing. `precision` is the provider's own notion of
// what matched (Nominatim: "house", "road", "city", ...) so the office can
// judge how much to trust it before confirming.
const PROVIDER = String(process.env.GEOCODER_PROVIDER || 'nominatim').toLowerCase();
const NOMINATIM_URL = process.env.GEOCODER_URL || 'https://nominatim.openstreetmap.org/search';
const CONTACT = process.env.GEOCODER_EMAIL || '';

let override = null;   // test hook: async (query) => result | null
function setGeocoderForTests(fn) { override = fn; }

async function geocodeAddress(text) {
  const q = String(text || '').trim();
  if (!q) throw new Error('No address to geocode');
  if (override) return override(q);
  if (PROVIDER === 'none') throw new Error('Geocoding is disabled (GEOCODER_PROVIDER=none); enter coordinates manually');
  if (PROVIDER !== 'nominatim') throw new Error(`Unknown GEOCODER_PROVIDER "${PROVIDER}"`);

  const params = new URLSearchParams({ q, format: 'jsonv2', limit: '1', countrycodes: 'us' });
  if (CONTACT) params.set('email', CONTACT);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  let r;
  try {
    r = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { 'User-Agent': `ValleyBestDispatch/1.0 (${CONTACT || 'dispatch'})`, Accept: 'application/json' },
      signal: ctl.signal,
    });
  } catch (e) {
    throw new Error(`Geocoder unreachable: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
  } finally { clearTimeout(timer); }
  if (!r.ok) throw new Error(`Geocoder answered ${r.status}`);
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows.length) return null;
  const hit = rows[0];
  const lat = Number(hit.lat), lng = Number(hit.lon);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  return { lat, lng, displayName: hit.display_name || q, precision: hit.addresstype || hit.type || 'unknown', provider: 'nominatim' };
}

module.exports = { geocodeAddress, setGeocoderForTests, PROVIDER };
