/**
 * حل روابط الموقع المختصرة (maps.app.goo.gl …) على الخادم: المتصفح لا يستطيع تتبّع
 * تحويلاتها بسبب CORS. نتتبّع التحويلات يدوياً ولا نزور إلا نطاقات خرائط معروفة —
 * فلا يُستعمل الخادم لطلب عناوين داخلية أو مواقع أخرى (SSRF).
 *
 * الترتيب: إحداثيات مباشرة في النص ← تتبّع التحويلات ← الإحداثيات داخل الصفحة
 * ← اسم المكان من الرابط (بحث في الخرائط، تقريبي) ← رسالة واضحة.
 */
const LocationLink = require('../locationLink');

const ALLOWED = [
  /^maps\.app\.goo\.gl$/i, /^goo\.gl$/i, /^g\.co$/i, /^share\.google$/i, /^g\.page$/i,
  /^(www\.|maps\.|consent\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/i,
  /^maps\.apple\.com$/i, /^maps\.apple$/i, /^(www\.|ul\.)?waze\.com$/i,
];
const allowed = (host) => ALLOWED.some((re) => re.test(host));
const MAX_HOPS = 8;
const TIMEOUT_MS = 7000;

const fail = (message) => Object.assign(new Error(message), { status: 400 });

async function fetchManual(url, fetchImpl) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      redirect: 'manual', signal: ctrl.signal,
      // متصفح جوال عادي: جوجل تعيد التحويل الكامل بالإحداثيات بدل صفحة «افتح التطبيق»
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36', 'Accept-Language': 'ar,en;q=0.8', Cookie: 'CONSENT=YES+1' },
    });
  } finally { clearTimeout(t); }
}

/** الإحداثيات من محتوى صفحة الخرائط (حين لا يحملها الرابط نفسه). */
function fromPage(body, ref) {
  const parse = (s) => (s ? LocationLink.parse(s, { ref }) : null);
  const tries = [
    // og:image لصفحة المكان: staticmap?center=31.95%2C35.91 أو markers=
    () => { const m = /(?:center|markers|ll)=(-?\d{1,3}\.\d+)(?:%2C|,)(-?\d{1,3}\.\d+)/.exec(body); return m && parse(`${m[1]},${m[2]}`); },
    // رابط خرائط كامل داخل الصفحة (canonical / og:url)
    () => { const m = /https:\/\/www\.google\.[a-z.]+\/maps\/[^"'\s<>\\]*(?:!3d|@)-?\d[^"'\s<>\\]*/.exec(body); return m && parse(m[0].replace(/\\u0026/g, '&')); },
    // حالة تطبيق خرائط جوجل: [[[zoom,lng,lat]
    () => { const m = /APP_INITIALIZATION_STATE=\[\[\[[\d.]+,(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)\]/.exec(body); return m && parse(`${m[2]},${m[1]}`); },
    // خرائط آبل: "latitude":31.95,"longitude":35.91
    () => { const m = /"latitude"\s*:\s*(-?\d{1,3}\.\d+)\s*,\s*"longitude"\s*:\s*(-?\d{1,3}\.\d+)/.exec(body); return m && parse(`${m[1]},${m[2]}`); },
    () => { const m = /<meta[^>]+(?:place:location:latitude|og:latitude)[^>]+content="(-?\d+\.\d+)"[\s\S]{0,300}?(?:place:location:longitude|og:longitude)[^>]+content="(-?\d+\.\d+)"/.exec(body); return m && parse(`${m[1]},${m[2]}`); },
  ];
  for (const t of tries) { const p = t(); if (p) return p; }
  return null;
}

/**
 * يعيد { lat, lng, resolvedUrl, approx?, place? } أو يرمي خطأ 400 برسالة عربية.
 * opts.ref: مرجع رموز Plus Code المختصرة (موقع المطعم). opts.geocode: بحث بالاسم (للاختبار).
 */
async function resolve(text, { fetchImpl = globalThis.fetch, ref, geocode } = {}) {
  const direct = LocationLink.parse(text, { ref });
  if (direct) return { ...direct, resolvedUrl: null };
  let url = LocationLink.firstUrl(text);
  if (!url) throw fail('لم نجد إحداثيات ولا رابطاً في النص — الصق رابط المشاركة من خرائط جوجل');

  const visited = [];
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let u;
    try { u = new URL(url); } catch (_) { throw fail('رابط غير صالح'); }
    if (u.protocol === 'http:' && allowed(u.hostname)) { u.protocol = 'https:'; url = u.href; }
    if (u.protocol !== 'https:' || !allowed(u.hostname)) throw fail('الرابط ليس من خرائط جوجل أو آبل أو ويز');
    visited.push(url);
    // صفحة الموافقة في جوجل تحمل الرابط الحقيقي في continue
    const cont = u.searchParams.get('continue');
    if (/^consent\./i.test(u.hostname) && cont) { url = cont; continue; }
    // روابط «افتح في التطبيق» تحمل الرابط الأصلي في link= / url=
    const inner = u.searchParams.get('link') || u.searchParams.get('url');
    if (inner && /^https?:\/\//i.test(inner)) { const p = LocationLink.parse(inner, { ref }); if (p) return { ...p, resolvedUrl: inner }; }
    const p = LocationLink.parse(url, { ref });
    if (p) return { ...p, resolvedUrl: url };

    let res;
    try { res = await fetchManual(url, fetchImpl); } catch (_) { break; }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) { url = new URL(loc, url).href; continue; }
    // بلا تحويل: نبحث عن الإحداثيات داخل الصفحة (أول 600 ك.ب فقط)
    const body = (await res.text().catch(() => '')).slice(0, 600000);
    const fromBody = fromPage(body, ref);
    if (fromBody) return { ...fromBody, resolvedUrl: url };
    // تحويل بالصفحة نفسها (meta refresh / location.replace)
    const meta = /http-equiv=["']?refresh["']?[^>]*url=([^"'>]+)/i.exec(body) || /location\.(?:replace|href)\s*\(?\s*=?\s*["'](https:\/\/[^"']+)["']/.exec(body);
    if (meta) { url = new URL(meta[1].replace(/&amp;/g, '&'), url).href; continue; }
    break;
  }

  // آخر محاولة: الرابط يحمل اسم المكان فقط (مثل /maps/place/مول+مكة) ← بحث بالاسم، تقريبي
  const name = visited.map((v) => LocationLink.placeQuery(v)).find((n) => n && n.length >= 3);
  if (name) {
    try {
      const search = geocode || require('./geocode').searchPlaces;
      const hit = (await search(name, { limit: 1 }))[0];
      if (hit) return { lat: Math.round(hit.lat * 1e6) / 1e6, lng: Math.round(hit.lng * 1e6) / 1e6, resolvedUrl: visited[visited.length - 1], approx: true, place: name };
    } catch (_) { /* نكمل للرسالة */ }
  }
  throw fail('لم نستطع قراءة الموقع من هذا الرابط — اطلب من الزبون «مشاركة الموقع» من خرائط جوجل، أو حدّد على الخريطة');
}

module.exports = { resolve, allowed, fromPage };
