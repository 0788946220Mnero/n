/**
 * حل روابط الموقع المختصرة (maps.app.goo.gl …) على الخادم: المتصفح لا يستطيع تتبّع
 * تحويلاتها بسبب CORS. نتتبّع التحويلات يدوياً ولا نزور إلا نطاقات خرائط معروفة —
 * فلا يُستعمل الخادم لطلب عناوين داخلية أو مواقع أخرى (SSRF).
 */
const LocationLink = require('../locationLink');

const ALLOWED = [
  /^maps\.app\.goo\.gl$/i, /^goo\.gl$/i, /^g\.co$/i, /^share\.google$/i,
  /^(www\.|maps\.|consent\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/i,
  /^maps\.apple\.com$/i, /^(www\.|ul\.)?waze\.com$/i,
];
const allowed = (host) => ALLOWED.some((re) => re.test(host));
const MAX_HOPS = 6;
const TIMEOUT_MS = 6000;

const fail = (message) => Object.assign(new Error(message), { status: 400 });

async function fetchManual(url, fetchImpl) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      redirect: 'manual', signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (AlBuraq location resolver)', 'Accept-Language': 'ar,en' },
    });
  } finally { clearTimeout(t); }
}

/** يعيد { lat, lng, resolvedUrl } أو يرمي خطأ 400 برسالة عربية. */
async function resolve(text, { fetchImpl = globalThis.fetch } = {}) {
  const direct = LocationLink.parse(text);
  if (direct) return { ...direct, resolvedUrl: null };
  let url = LocationLink.firstUrl(text);
  if (!url) throw fail('لم نجد إحداثيات ولا رابطاً في النص');

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let u;
    try { u = new URL(url); } catch (_) { throw fail('رابط غير صالح'); }
    if (u.protocol !== 'https:' || !allowed(u.hostname)) throw fail('الرابط ليس من خرائط جوجل أو آبل أو ويز');
    // صفحة الموافقة في جوجل تحمل الرابط الحقيقي في continue
    const cont = u.searchParams.get('continue');
    if (/^consent\./i.test(u.hostname) && cont) { url = cont; continue; }
    const p = LocationLink.parse(url);
    if (p) return { ...p, resolvedUrl: url };

    let res;
    try { res = await fetchManual(url, fetchImpl); } catch (_) { throw fail('تعذّر فتح الرابط — جرّب لصق الإحداثيات أو اختر الموقع على الخريطة'); }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) { url = new URL(loc, url).href; continue; }
    // بلا تحويل: نبحث عن الإحداثيات داخل الصفحة (أول 300 ك.ب فقط)
    const body = (await res.text().catch(() => '')).slice(0, 300000);
    const fromBody = LocationLink.parse((/https:\/\/www\.google\.[^"'\s]+\/maps[^"'\s]*/.exec(body) || [])[0] || '')
      || LocationLink.parse((/(?:center|ll)=(-?\d+\.\d+)(?:%2C|,)(-?\d+\.\d+)/.exec(body) || []).slice(1).join(','));
    if (fromBody) return { ...fromBody, resolvedUrl: url };
    break;
  }
  throw fail('لم نستطع قراءة الموقع من هذا الرابط — افتحه وانسخ الإحداثيات، أو اختر على الخريطة');
}

module.exports = { resolve, allowed };
