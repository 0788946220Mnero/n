/**
 * البحث عن معلم/مكان بالاسم (OpenStreetMap — Nominatim) عبر الخادم:
 * User-Agent صحيح كما تشترط سياسة Nominatim، طلب واحد في الثانية، ذاكرة مؤقتة، والأردن أولاً.
 * يستعمله: البحث عن معلم في الخرائط، وروابط جوجل التي تحمل اسم المكان بلا إحداثيات.
 */
const cache = new Map(); // q → { at, results }
const CACHE_MS = 6 * 3600 * 1000;
let lastCall = 0;

async function searchPlaces(q, { limit = 8, fetchImpl = globalThis.fetch } = {}) {
  q = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (q.length < 2) return [];
  const key = q.toLowerCase() + '|' + limit;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.results;
  const wait = Math.max(0, lastCall + 1100 - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
    q, format: 'jsonv2', limit: String(limit), countrycodes: 'jo', 'accept-language': 'ar', addressdetails: '0',
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetchImpl(url, { headers: { 'User-Agent': 'AlBuraqDelivery/1.0 (delivery company dispatch; contact via admin)', Accept: 'application/json' }, signal: ctrl.signal });
    if (!r.ok) throw new Error('status ' + r.status);
    const list = await r.json();
    const results = (Array.isArray(list) ? list : []).map((x) => ({
      name: String(x.name || String(x.display_name || '').split(',')[0] || '').trim(),
      display: String(x.display_name || '').split(',').slice(0, 3).join('،').trim(),
      lat: Number(x.lat), lng: Number(x.lon), type: x.type || '',
    })).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng));
    if (cache.size > 500) cache.clear();
    cache.set(key, { at: Date.now(), results });
    return results;
  } finally { clearTimeout(timer); }
}

module.exports = { searchPlaces };
