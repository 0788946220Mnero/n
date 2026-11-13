/**
 * منصة براق — الاتصال بخوادم المتاجر (كل متجر نسخة من خادم البراق على Railway).
 *
 * المسارات العامة المستخدمة على خادم المتجر (موجودة أصلاً، بلا أي تعديل عليه):
 *   GET  /api/settings                 الاسم، الشعار، حالة المطعم، ساعات العمل
 *   GET  /api/settings/delivery-config موقع المطعم ونطاق التوصيل
 *   POST /api/settings/delivery-quote  تسعيرة توصيل سائقي المتجر لموقع الزبون
 *   GET  /api/categories               التصنيفات
 *   GET  /api/products?page&limit      المنتجات (صفحات)
 *   POST /api/orders                   إنشاء طلب (يُسعَّر في خادم المتجر)
 *   POST /api/orders/track             حالة طلبات بمعرّفاتها ورموز تتبعها
 */
const TIMEOUT_MS = Number(process.env.MKT_REMOTE_TIMEOUT_MS || 12000);
const PAGE = 200;
const MAX_PAGES = 50; // حتى 10,000 منتج للمتجر

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

/** تطبيع عنوان الخادم: https فقط (http لـ localhost في التطوير)، بلا مسار ولا شرطة أخيرة. */
function normalizeBaseUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) throw httpError(400, 'أدخل عنوان خادم المتجر');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch (_) { throw httpError(400, 'عنوان الخادم غير صالح'); }
  const local = /^(localhost|127\.0\.0\.1)$/i.test(u.hostname);
  if (u.protocol !== 'https:' && !(local && process.env.NODE_ENV !== 'production')) throw httpError(400, 'العنوان يجب أن يبدأ بـ https://');
  // حماية من توجيه الخادم لشبكات داخلية (عناوين IP خاصة)
  if (!local && /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(u.hostname)) throw httpError(400, 'عنوان غير مسموح');
  let path = u.pathname.replace(/\/+$/, '');
  if (/\/api$/i.test(path)) path = path.slice(0, -4); // من ألصق …/api
  return `${u.protocol}//${u.host}${path}`;
}

async function call(baseUrl, path, { method = 'GET', body, timeout = TIMEOUT_MS } = {}) {
  const url = baseUrl + path;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), 'User-Agent': 'BuraqPlatform/1.0' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
      redirect: 'follow',
    });
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw httpError(502, timedOut ? 'خادم المتجر لا يستجيب (انتهت المهلة)' : 'تعذّر الوصول لخادم المتجر', { remote: true });
  }
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  if (!data && res.ok) throw httpError(502, 'خادم المتجر ردّ بصيغة غير متوقعة', { remote: true });
  return { status: res.status, ok: res.ok, data: data || {} };
}

/** رابط صورة مطلق: المسارات النسبية تُكمَّل بعنوان خادم المتجر. */
function absUrl(baseUrl, u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^(https?:)?\/\//i.test(s) || s.startsWith('data:')) return s.startsWith('//') ? `https:${s}` : s;
  return baseUrl + (s.startsWith('/') ? s : `/${s}`);
}

/** فحص خادم متجر قبل إضافته: هل هو خادم براق؟ وما اسمه وموقعه وعدد منتجاته؟ */
async function probe(rawUrl) {
  const baseUrl = normalizeBaseUrl(rawUrl);
  const t0 = Date.now();
  const [settings, dcfg, cats, prods] = await Promise.all([
    call(baseUrl, '/api/settings'),
    call(baseUrl, '/api/settings/delivery-config').catch(() => ({ ok: false, data: {} })),
    call(baseUrl, '/api/categories').catch(() => ({ ok: false, data: {} })),
    call(baseUrl, '/api/products?page=1&limit=1').catch(() => ({ ok: false, data: {} })),
  ]);
  if (!settings.ok) throw httpError(502, `خادم المتجر ردّ بخطأ ${settings.status} على /api/settings`);
  const s = settings.data || {};
  const looksRight = 'restaurantName' in s || 'delivery' in s || 'restaurantStatus' in s;
  if (!looksRight) throw httpError(422, 'هذا العنوان لا يبدو خادم متجر من نظام البراق');
  const categories = listOf(cats.data);
  const total = prods.data && prods.data.pagination ? Number(prods.data.pagination.total) || 0 : listOf(prods.data).length;
  const d = dcfg.data || {};
  return {
    baseUrl,
    ms: Date.now() - t0,
    name: s.restaurantName || '',
    logo: absUrl(baseUrl, s.logo),
    phone: s.phone || s.restaurantPhone || '',
    whatsapp: s.whatsapp || '',
    address: s.address || '',
    status: (s.restaurantStatus && s.restaurantStatus.mode) || 'open',
    location: d.restaurantLatitude != null && d.restaurantLongitude != null ? { lat: Number(d.restaurantLatitude), lng: Number(d.restaurantLongitude) } : null,
    deliveryEnabled: d.enabled !== false,
    maxDistanceKm: d.maxDistanceKm != null ? Number(d.maxDistanceKm) : null,
    categories: categories.length,
    products: total,
  };
}

function listOf(d) {
  if (!d) return [];
  if (Array.isArray(d)) return d;
  if (Array.isArray(d.data)) return d.data;
  if (Array.isArray(d.categories)) return d.categories;
  if (Array.isArray(d.products)) return d.products;
  return [];
}

/** كل منتجات المتجر (كل الصفحات) + التصنيفات + الإعدادات العامة. */
async function fetchCatalog(baseUrl) {
  const [settings, dcfg, cats] = await Promise.all([
    call(baseUrl, '/api/settings'),
    call(baseUrl, '/api/settings/delivery-config').catch(() => ({ ok: false, data: {} })),
    call(baseUrl, '/api/categories'),
  ]);
  if (!settings.ok) throw httpError(502, `خادم المتجر: /api/settings ← ${settings.status}`);
  if (!cats.ok) throw httpError(502, `خادم المتجر: /api/categories ← ${cats.status}`);
  const products = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await call(baseUrl, `/api/products?page=${page}&limit=${PAGE}&sort=order`);
    if (!r.ok) throw httpError(502, `خادم المتجر: /api/products ← ${r.status}`);
    const list = listOf(r.data);
    products.push(...list);
    const pages = r.data && r.data.pagination ? Number(r.data.pagination.pages) || 1 : 1;
    if (page >= pages || list.length < PAGE) break;
  }
  return { settings: settings.data || {}, delivery: dcfg.data || {}, categories: listOf(cats.data), products };
}

module.exports = { call, probe, fetchCatalog, normalizeBaseUrl, absUrl, httpError, listOf };
