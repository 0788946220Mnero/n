/*
 * استخراج الإحداثيات من رابط مشاركة موقع — نفس الملف يعمل في المتصفح (DC.LocationLink)
 * وفي الخادم (require). المصدر الوحيد: shared/location-link.js، وأداة tools/sync-shared.js
 * تنسخه إلى backend/alburaq/locationLink.js ومنصة الزبائن.
 *
 * يقبل:
 *   • خرائط جوجل: maps.google.com/?q=31.95,35.91 · google.com/maps/place/…/@31.95,35.91,17z
 *     · …!3d31.95!4d35.91 (الدبوس الدقيق) · ?query= · ?ll= · ?daddr= · ?destination= · q=loc:…
 *     · /maps/place/31°57'10.2"N+35°54'38.1"E (دبوس مُسقط يدوياً) · /maps/search/31.95,+35.91
 *   • رموز Plus Code: «8Q6C+X4 عمّان» أو كاملة «8G3Q8Q6C+X4» (ما يظهر عند إسقاط دبوس في خرائط جوجل)
 *   • ما يرسله واتساب عند مشاركة الموقع (رابط خرائط جوجل بإحداثيات)
 *   • خرائط آبل: maps.apple.com/?ll=… أو ?q=… أو ?coordinate=… · ويز: waze.com/ul?ll=…
 *   • geo:31.95,35.91 · نص «31.95, 35.91» · صيغة الدرجات 31°57'10.2"N 35°54'38.1"E
 * الروابط المختصرة (maps.app.goo.gl، goo.gl/maps، g.page، maps.apple/p) لا إحداثيات فيها: isShortLink() → يحلّها الخادم.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.DC = root.DC || {}; root.DC.LocationLink = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  const NUM = '(-?\\d{1,3}(?:\\.\\d+)?)';
  const PAIR = new RegExp(`^\\s*${NUM}\\s*[,،\\s]\\s*${NUM}\\s*$`);
  // عمّان: مرجع الرموز المختصرة (Plus Code بلا أول 4 أحرف) وتصحيح الإحداثيات المعكوسة
  const DEFAULT_REF = { lat: 31.95, lng: 35.91 };
  const inJordanBox = (p) => p.lat > 29 && p.lat < 33.5 && p.lng > 34.8 && p.lng < 39.5;

  const valid = (lat, lng) =>
    Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0);
  const point = (lat, lng) => {
    let a = Number(lat); let b = Number(lng);
    if (!valid(a, b)) return null;
    // بعض التطبيقات تكتب «خط الطول، خط العرض»: إن وقع المعكوس في الأردن والأصل خارجه نصحّحه
    if (!inJordanBox({ lat: a, lng: b }) && valid(b, a) && inJordanBox({ lat: b, lng: a })) [a, b] = [b, a];
    return { lat: Math.round(a * 1e6) / 1e6, lng: Math.round(b * 1e6) / 1e6 };
  };

  function fromPair(s) {
    if (!s) return null;
    let t = String(s);
    try { t = decodeURIComponent(t.replace(/\+/g, ' ')); } catch (_) { /* كما هو */ }
    t = t.replace(/^loc:/i, '').trim();
    const m = PAIR.exec(t);
    return m ? point(m[1], m[2]) : null;
  }

  /** 31°57'10.2"N 35°54'38.1"E (ومنها المكتوب داخل الرابط بعد فك الترميز) */
  function fromDms(text) {
    const re = /(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*(\d{1,2}(?:\.\d+)?)\s*(?:["″]|'')\s*\+?\s*([NSEW])/gi;
    const parts = [];
    let m;
    while ((m = re.exec(text)) && parts.length < 2) {
      const v = Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600;
      parts.push({ v: /[SW]/i.test(m[4]) ? -v : v, axis: /[NS]/i.test(m[4]) ? 'lat' : 'lng' });
    }
    if (parts.length !== 2) return null;
    const lat = parts.find((p) => p.axis === 'lat'); const lng = parts.find((p) => p.axis === 'lng');
    return lat && lng ? point(lat.v, lng.v) : null;
  }

  /* ── Plus Code (Open Location Code) — فك الرمز إلى مركز المربع ── */
  const OLC = '23456789CFGHJMPQRVWX';
  const PAIR_RES = [20, 1, 0.05, 0.0025, 0.000125];
  function olcEncode(lat, lng) {
    // حساب بالأعداد الصحيحة (1/8000 درجة) لتفادي أخطاء الكسور عند حدود المربعات
    let la = Math.floor((Math.min(Math.max(lat, -90), 90 - 1e-9) + 90) * 8000 + 1e-7);
    let lo = Math.floor(((((lng + 180) % 360) + 360) % 360) * 8000 + 1e-7);
    const dl = []; const dn = [];
    for (let i = 0; i < 5; i++) { dl.unshift(la % 20); dn.unshift(lo % 20); la = Math.floor(la / 20); lo = Math.floor(lo / 20); }
    let code = '';
    for (let i = 0; i < 5; i++) { code += OLC[dl[i]] + OLC[dn[i]]; if (i === 3) code += '+'; }
    return code; // 8 أحرف + «+» + حرفان
  }
  function olcDecodeFull(code) {
    const c = code.replace('+', '').replace(/0+$/, '').toUpperCase();
    let lat = -90; let lng = -180; let latRes = 0; let lngRes = 0;
    for (let i = 0; i < Math.min(c.length, 10); i += 2) {
      const r = PAIR_RES[i / 2];
      lat += OLC.indexOf(c[i]) * r; lng += OLC.indexOf(c[i + 1] || '2') * r;
      latRes = r; lngRes = r;
    }
    // الشبكة الدقيقة (الحرف 11 وما بعده): 4 صفوف × 5 أعمدة
    for (let i = 10; i < c.length; i++) {
      const d = OLC.indexOf(c[i]);
      latRes /= 5; lngRes /= 4;
      lat += Math.floor(d / 4) * latRes; lng += (d % 4) * lngRes;
    }
    return point(lat + latRes / 2, lng + lngRes / 2);
  }
  const PLUS = /(?:^|[^0-9A-Z])([23456789CFGHJMPQRVWX]{2,8}0{0,6}\+[23456789CFGHJMPQRVWX]{0,7})(?![0-9A-Z])/i;
  function fromPlusCode(text, ref = DEFAULT_REF) {
    const m = PLUS.exec(String(text || '').toUpperCase());
    if (!m) return null;
    const code = m[1];
    const sep = code.indexOf('+');
    if (sep === 8) return olcDecodeFull(code);
    if (sep < 4 || sep % 2 || /0/.test(code)) return null; // رمز مختصر: 4 أو 6 أحرف قبل «+»
    // رمز مختصر: نكمله من المرجع (عمّان افتراضياً، أو موقع المطعم) ثم نختار الأقرب
    const pad = 8 - sep;
    const full = olcEncode(ref.lat, ref.lng).slice(0, pad) + code;
    const p = olcDecodeFull(full);
    if (!p) return null;
    const res = Math.pow(20, 2 - pad / 2); const half = res / 2;
    let { lat, lng } = p;
    if (ref.lat + half < lat && lat - res >= -90) lat -= res; else if (ref.lat - half > lat && lat + res <= 90) lat += res;
    if (ref.lng + half < lng) lng -= res; else if (ref.lng - half > lng) lng += res;
    return point(lat, lng);
  }

  function firstUrl(text) {
    const m = /((?:https?:\/\/|comgooglemaps:\/\/)[^\s<>"]+)/i.exec(String(text || ''));
    if (m) return m[1].replace(/[)\].,،]+$/, '');
    // رابط بلا http (ينسخه البعض هكذا): maps.app.goo.gl/xxx
    const bare = /(?:^|\s)((?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.page|maps\.apple(?:\.com)?|(?:www\.)?google\.[a-z.]+\/maps)\/[^\s<>"]*)/i.exec(String(text || ''));
    return bare ? 'https://' + bare[1].replace(/[)\].,،]+$/, '') : null;
  }

  function isShortLink(text) {
    const u = firstUrl(text);
    if (!u) return false;
    try {
      const url = new URL(u);
      if (/^(maps\.app\.goo\.gl|g\.co|share\.google|g\.page|maps\.apple)$/i.test(url.hostname)) return true;
      if (/^goo\.gl$/i.test(url.hostname) && /^\/maps/i.test(url.pathname)) return true;
      return false;
    } catch (_) { return false; }
  }

  /** يعيد { lat, lng } أو null. opts.ref: مرجع الرموز المختصرة (موقع المطعم مثلاً). */
  function parse(input, opts = {}) {
    const text = String(input || '').trim();
    if (!text) return null;
    const ref = opts.ref && valid(opts.ref.lat, opts.ref.lng) ? opts.ref : DEFAULT_REF;

    // geo:lat,lng
    const geo = /geo:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i.exec(text);
    if (geo) return point(geo[1], geo[2]);

    const u = firstUrl(text);
    if (u) {
      let url = null;
      try { url = new URL(u); } catch (_) { url = null; }
      if (url) {
        let full = url.href;
        try { full = decodeURIComponent(url.href); } catch (_) { /* ترميز ناقص */ }
        // الدبوس الدقيق في روابط المكان: !3dLAT!4dLNG (الأولوية له على مركز العرض @)
        const pin = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(full);
        if (pin) return point(pin[1], pin[2]);
        for (const key of ['q', 'query', 'll', 'sll', 'daddr', 'destination', 'coordinate', 'latlng', 'center', 'viewpoint', 'saddr', 'markers']) {
          const p = fromPair(url.searchParams.get(key));
          if (p) return p;
        }
        // /maps/search/31.95,+35.91 أو /maps/place/31.95,35.91 أو /maps/dir//31.95,35.91
        const path = /\/(?:search|place|dir)\/+(-?\d+(?:\.\d+)?)\s*,\s*\+?\s*(-?\d+(?:\.\d+)?)/.exec(full);
        if (path) return point(path[1], path[2]);
        // دبوس مُسقط يدوياً: /maps/place/31°57'10.2"N+35°54'38.1"E
        const dms = fromDms(full);
        if (dms) return dms;
        // Plus Code في الرابط: /maps/search/8Q6C%2BX4 أو ?q=8Q6C+X4 (قبل @ لأن @ مركز العرض لا الدبوس)
        const pc = fromPlusCode(url.href.replace(/%2B/gi, '+'), ref) || fromPlusCode(full, ref);
        if (pc) return pc;
        const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(full);
        if (at) return point(at[1], at[2]);
      }
    }
    return fromPair(text) || fromDms(text) || fromPlusCode(text, ref);
  }

  /** اسم المكان من رابط بلا إحداثيات (/maps/place/دوار+الداخلية أو ?q=مول+مكة) — يبحث عنه الخادم */
  function placeQuery(input) {
    const u = firstUrl(input);
    if (!u) return '';
    try {
      const url = new URL(u);
      const q = url.searchParams.get('q') || url.searchParams.get('query') || url.searchParams.get('destination') || url.searchParams.get('daddr') || '';
      const m = /\/maps\/(?:place|search)\/([^/@?]+)/.exec(url.pathname);
      let name = q || (m ? m[1] : '');
      try { name = decodeURIComponent(name.replace(/\+/g, ' ')); } catch (_) { /* كما هو */ }
      return name.replace(/^loc:/i, '').trim().slice(0, 120);
    } catch (_) { return ''; }
  }

  /** رابط لفتح الموقع في الخرائط (للسائق وللرسائل). */
  const mapsUrl = (p) => `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;

  return { parse, isShortLink, firstUrl, mapsUrl, valid, placeQuery, fromPlusCode, olcEncode };
});
