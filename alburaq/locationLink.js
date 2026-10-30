/*
 * استخراج الإحداثيات من رابط مشاركة موقع — نفس الملف يعمل في المتصفح (DC.LocationLink)
 * وفي الخادم (require). المصدر الوحيد: shared/location-link.js، وأداة tools/sync-shared.js
 * تنسخه إلى backend/src/locationLink.js.
 *
 * يقبل:
 *   • خرائط جوجل: maps.google.com/?q=31.95,35.91 · google.com/maps/place/…/@31.95,35.91,17z
 *     · …!3d31.95!4d35.91 (الدبوس الدقيق) · ?query= · ?ll= · ?daddr= · ?destination= · q=loc:…
 *   • ما يرسله واتساب عند مشاركة الموقع (رابط خرائط جوجل بإحداثيات)
 *   • خرائط آبل: maps.apple.com/?ll=… أو ?q=… أو ?coordinate=…
 *   • ويز: waze.com/ul?ll=… أو ?latlng=…
 *   • geo:31.95,35.91 · نص «31.95, 35.91» · صيغة الدرجات 31°57'10.2"N 35°54'38.1"E
 * الروابط المختصرة (maps.app.goo.gl و goo.gl/maps) لا إحداثيات فيها: isShortLink() → يحلّها الخادم.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.DC = root.DC || {}; root.DC.LocationLink = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  const NUM = '(-?\\d{1,3}(?:\\.\\d+)?)';
  const PAIR = new RegExp(`^\\s*${NUM}\\s*[,،\\s]\\s*${NUM}\\s*$`);

  const valid = (lat, lng) =>
    Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0);
  const point = (lat, lng) => {
    const a = Number(lat); const b = Number(lng);
    return valid(a, b) ? { lat: Math.round(a * 1e6) / 1e6, lng: Math.round(b * 1e6) / 1e6 } : null;
  };

  function fromPair(s) {
    if (!s) return null;
    let t = String(s);
    try { t = decodeURIComponent(t.replace(/\+/g, ' ')); } catch (_) { /* كما هو */ }
    t = t.replace(/^loc:/i, '').trim();
    const m = PAIR.exec(t);
    return m ? point(m[1], m[2]) : null;
  }

  /** 31°57'10.2"N 35°54'38.1"E */
  function fromDms(text) {
    const re = /(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*(\d{1,2}(?:\.\d+)?)\s*(?:["″]|'')\s*([NSEW])/gi;
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

  function firstUrl(text) {
    const m = /(https?:\/\/[^\s<>"']+)/i.exec(String(text || ''));
    return m ? m[1].replace(/[)\].,،]+$/, '') : null;
  }

  function isShortLink(text) {
    const u = firstUrl(text);
    if (!u) return false;
    try {
      const url = new URL(u);
      if (/^(maps\.app\.goo\.gl|g\.co|share\.google)$/i.test(url.hostname)) return true;
      if (/^goo\.gl$/i.test(url.hostname) && /^\/maps/i.test(url.pathname)) return true;
      return false;
    } catch (_) { return false; }
  }

  /** يعيد { lat, lng } أو null. */
  function parse(input) {
    const text = String(input || '').trim();
    if (!text) return null;

    // geo:lat,lng
    const geo = /geo:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i.exec(text);
    if (geo) return point(geo[1], geo[2]);

    const u = firstUrl(text);
    if (u) {
      let url = null;
      try { url = new URL(u); } catch (_) { url = null; }
      if (url) {
        const full = decodeURIComponent(url.href);
        // الدبوس الدقيق في روابط المكان: !3dLAT!4dLNG (الأولوية له على مركز العرض @)
        const pin = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(full);
        if (pin) return point(pin[1], pin[2]);
        for (const key of ['q', 'query', 'll', 'sll', 'daddr', 'destination', 'coordinate', 'latlng', 'center', 'viewpoint', 'saddr']) {
          const p = fromPair(url.searchParams.get(key));
          if (p) return p;
        }
        const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(full);
        if (at) return point(at[1], at[2]);
        // /maps/search/31.95,+35.91 أو /maps/place/31.95,35.91
        const path = /\/(?:search|place|dir)\/(-?\d+(?:\.\d+)?)\s*,\s*\+?(-?\d+(?:\.\d+)?)/.exec(full);
        if (path) return point(path[1], path[2]);
      }
    }
    return fromPair(text) || fromDms(text);
  }

  /** رابط لفتح الموقع في الخرائط (للسائق وللرسائل). */
  const mapsUrl = (p) => `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;

  return { parse, isShortLink, firstUrl, mapsUrl, valid };
});
