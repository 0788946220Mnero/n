/*
  ═══════════════════════════════════════════════════════════════
  نفق الصور عبر سيرفر ميرو السحابي (بلا Cloudflare ولا فتح منافذ):

    جهاز الكاشير (ImageStorage) ──اتصال WebSocket طالع──→ هذا الخادم (Railway)
    زبون / الموقع ──GET /api/image-cloud/relay/media/{id}/medium──→ هذا الخادم ──النفق──→ الجهاز

  • الجهاز يتصل بنفسه ويثبت هويته بسرّه (الخادم يحفظ بصمته فقط — نفس سرّ الربط التلقائي).
  • العامة يرون الصور فقط (GET/HEAD على /media/*). الرفع والفحص يمرّان داخل الخادم نفسه
    (imageCloudService) بمفتاح الرفع — لا يصل أحد من الخارج لواجهة الإدارة.
  • تخزين مؤقت في الذاكرة للصور المعروضة (افتراضياً 64 ميغابايت، ساعة) — أخف على الجهاز وعلى الإنترنت.
  • أكثر من جهاز متصل: يُختار آخر جهاز اتصل، وإن فشل الطلب عليه يُعاد على جهاز آخر.

  الإطارات (JSON نصي + ثنائي):
    خادم ← جهاز:  {type:'req', id, method, path, headers, size}  ثم (إن size>0) ثنائي: id(16) + الجسم
    جهاز ← خادم:  {type:'res', id, status, headers, size}        ثم (إن size>0) ثنائي: id(16) + الجسم
    أول رسالة من الجهاز: {type:'hello', nodeId, proof} ← {type:'welcome'} أو إغلاق 4003
  ═══════════════════════════════════════════════════════════════
*/
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const ImageCloud = require('../models/ImageCloud');

const WS_PATH = '/api/image-cloud/relay/ws';
const MOUNT = '/api/image-cloud/relay';
const REQ_TIMEOUT_MS = Number(process.env.IMAGE_RELAY_TIMEOUT_MS || 25000);
const CACHE_MAX = Number(process.env.IMAGE_RELAY_CACHE_MB || 64) * 1024 * 1024;
const CACHE_TTL_MS = Number(process.env.IMAGE_RELAY_CACHE_TTL_MS || 3600000);
const MAX_BODY = 32 * 1024 * 1024;
const ID_LEN = 16;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sameHash = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === 64 && b.length === 64 &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** الأجهزة المتصلة الآن: nodeId ← { ws, since, name, pending: Map(id ← طلب) } */
const nodes = new Map();
let wss = null;
/** الجهاز المفضّل (صاحب مفتاح الرفع وصوره): يُوجَّه إليه أولاً. undefined = لم يُقرأ بعد. */
let preferred;
const setPreferred = (id) => { preferred = id || null; };
const isConnected = (id) => !!id && nodes.has(id);

/* ═════════ اتصال الأجهزة ═════════ */

function init() {
  if (wss) return wss;
  wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY + 1024 });
  wss.on('connection', onConnection);
  // نبض كل 25 ثانية: جهاز لا يرد يُفصل (فيتحوّل الطلب لجهاز آخر)
  const iv = setInterval(() => {
    for (const n of nodes.values()) {
      if (n.ws.isAlive === false) { n.ws.terminate(); continue; }
      n.ws.isAlive = false;
      try { n.ws.ping(); } catch (_) { /* */ }
    }
  }, 25000);
  if (iv.unref) iv.unref();
  return wss;
}

// IMAGE-SERVER / SECURITY: سجلات تشخيص النفق — المسار ونتيجة التحقق فقط، بلا أسرار ولا رؤوس
const handleUpgrade = (req, socket, head) => {
  console.log(`[image-relay] websocket upgrade: ${String(req.url || '').split('?')[0]}`);
  return init().handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
};

function onConnection(ws) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let node = null;
  const helloTimer = setTimeout(() => { if (!node) ws.close(4001, 'hello timeout'); }, 10000);

  ws.on('message', async (data, isBinary) => {
    if (!node) {
      if (isBinary) { console.warn('[image-relay] rejected: binary hello'); return ws.close(4002, 'hello first'); }
      clearTimeout(helloTimer);
      let m; try { m = JSON.parse(String(data)); } catch (_) { console.warn('[image-relay] rejected: invalid hello JSON'); return ws.close(4002, 'bad hello'); }
      node = await authenticate(m).catch((err) => { console.error('[image-relay] authentication lookup failed:', err.message); return null; });
      if (!node) {
        // جهاز غير منضم، أو سرّه لا يطابق (أُعيد تثبيته؟) ← يحتاج «موافقة» من اللوحة من جديد
        console.warn(`[image-relay] rejected: unknown/unapproved device ${String((m && m.nodeId) || '').slice(0, 64)}`);
        ws.close(4003, 'unknown device'); return;
      }
      console.log(`[image-relay] device connected: ${node.nodeId}`);
      const prev = nodes.get(node.nodeId);
      if (prev && prev.ws !== ws) { try { prev.ws.close(4000, 'replaced'); } catch (_) { /* */ } failAll(prev, 'أُعيد اتصال الجهاز'); }
      node = { ...node, ws, since: Date.now(), pending: new Map(), awaiting: null };
      nodes.set(node.nodeId, node);
      ws.send(JSON.stringify({ type: 'welcome', nodeId: node.nodeId }));
      return;
    }
    if (isBinary) return onBody(node, data);
    let m; try { m = JSON.parse(String(data)); } catch (_) { return; }
    if (m.type === 'res') onHead(node, m);
  });

  const gone = () => {
    clearTimeout(helloTimer);
    if (!node) return;
    if (nodes.get(node.nodeId) === node) nodes.delete(node.nodeId);
    failAll(node, 'انقطع اتصال جهاز الصور');
  };
  ws.on('close', (code) => { if (node) console.log(`[image-relay] device disconnected: ${node.nodeId} (code ${code})`); gone(); });
  ws.on('error', (err) => { console.warn('[image-relay] websocket error:', err.message); gone(); });
}

/** الجهاز يثبت هويته: منضم للمزامنة، وبصمة سرّه تطابق المحفوظة. */
async function authenticate(m) {
  if (!m || m.type !== 'hello' || typeof m.nodeId !== 'string' || typeof m.proof !== 'string') return null;
  const d = await ImageCloud.findOne({ key: 'main' }).lean();
  const n = d && (d.nodes || []).find((x) => x.nodeId === m.nodeId);
  if (!n || !sameHash(sha(m.proof), n.proofHash)) return null;
  return { nodeId: n.nodeId, name: n.name || n.machine || n.nodeId };
}

function failAll(node, message) {
  for (const p of node.pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error(message), { status: 0 })); }
  node.pending.clear();
}

function onHead(node, m) {
  const p = node.pending.get(m.id);
  if (!p) return;
  p.head = { status: Number(m.status) || 502, headers: m.headers || {} };
  if (!(m.size > 0)) finish(node, m.id, Buffer.alloc(0));
}

function onBody(node, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < ID_LEN) return;
  finish(node, buf.subarray(0, ID_LEN).toString('latin1'), buf.subarray(ID_LEN));
}

function finish(node, id, body) {
  const p = node.pending.get(id);
  if (!p || !p.head) return;
  node.pending.delete(id);
  clearTimeout(p.timer);
  p.resolve({ status: p.head.status, headers: p.head.headers, body: Buffer.from(body), node: node.nodeId });
}

/* ═════════ الطلبات عبر النفق ═════════ */

const connected = (prefer) => [...nodes.values()].sort((a, b) =>
  (b.nodeId === prefer) - (a.nodeId === prefer) || b.since - a.since);
const connectedCount = () => nodes.size;
const status = () => connected().map((n) => ({ nodeId: n.nodeId, name: n.name, since: new Date(n.since), pending: n.pending.size }));

function sendTo(node, method, path, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomBytes(8).toString('hex'); // 16 حرفاً
    const timer = setTimeout(() => {
      node.pending.delete(id);
      reject(Object.assign(new Error('جهاز الصور لم يرد في الوقت'), { status: 0, timeout: true }));
    }, timeoutMs);
    node.pending.set(id, { resolve, reject, timer, head: null });
    try {
      node.ws.send(JSON.stringify({ type: 'req', id, method, path, headers, size: body ? body.length : 0 }));
      if (body && body.length) node.ws.send(Buffer.concat([Buffer.from(id, 'latin1'), body]), { binary: true });
    } catch (err) {
      clearTimeout(timer); node.pending.delete(id);
      reject(Object.assign(new Error(err.message), { status: 0 }));
    }
  });
}

/**
 * طلب على خدمة الصور عبر النفق. يرجع { status, headers, body: Buffer }.
 * بلا جهاز متصل ← خطأ status 0 (فيرجع الرفع لـ Cloudinary كالعادة).
 */
async function request(method, path, { headers = {}, body = null, timeoutMs = REQ_TIMEOUT_MS, prefer, tryAllOn404 = false } = {}) {
  if (preferred === undefined) {
    // أول طلب بعد تشغيل الخادم: نعرف صاحب المفتاح من الإعدادات
    try { await require('./imageCloudService').activeConfig(); } catch (_) { /* */ }
    if (preferred === undefined) preferred = null;
  }
  const list = connected(prefer || preferred);
  if (!list.length) throw Object.assign(new Error('لا يوجد جهاز صور متصل بالخادم — DiyarPOS مطفأ أو بلا إنترنت'), { status: 0 });
  let last; let notFound = null;
  // جهاز ثانٍ عند فشل الأول. وللعرض: صورة غير موجودة على جهاز (شبكتان لا تتزامنان) ← تُطلب من الأجهزة الأخرى
  for (const node of list.slice(0, tryAllOn404 ? list.length : 2)) {
    try {
      const out = await sendTo(node, method, path, headers, body, timeoutMs);
      if (tryAllOn404 && out.status === 404) { notFound = notFound || out; continue; }
      return out;
    } catch (err) { last = err; }
  }
  if (notFound) return notFound;
  throw last;
}

/** طلب على جهاز محدد بعينه (لا بديل) — لـ «مزامنة الآن» وتمرير المزامنة بين الأجهزة. */
async function requestNode(nodeId, method, path, { headers = {}, body = null, timeoutMs = REQ_TIMEOUT_MS } = {}) {
  const node = nodes.get(nodeId);
  if (!node) throw Object.assign(new Error('الجهاز غير متصل بسيرفر ميرو السحابي الآن'), { status: 0 });
  return sendTo(node, method, path, headers, body, timeoutMs);
}

/* ═════════ المزامنة بين الأجهزة عبر السيرفر (أماكن مختلفة) ═════════
   جهاز ──HTTPS بسرّه──→ /api/image-cloud/relay/peer/{جهاز آخر}/internal/sync/(vv|events|blobs/{sha})
                       ──نفق الجهاز الآخر──→ منفذ المزامنة هناك، حيث يُتحقق من توقيع HMAC بالسر المشترك.
   السيرفر لا يفهم الأحداث ولا يخزّنها: يمرّر البايتات كما هي (الجسم ≤ 32 ميغابايت، الملفات بأجزاء 8 ميغابايت). */
const PEER_RX = /^\/peer\/([A-Za-z0-9_-]{1,64})(\/internal\/sync\/(?:vv|events|blobs\/[a-f0-9]{64}))$/;
const PEER_IN = ['content-type', 'range', 'x-sync-node', 'x-sync-ts', 'x-sync-nonce', 'x-sync-sig', 'x-sync-proto'];
const PEER_OUT = ['content-type', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
const PEER_TIMEOUT_MS = Number(process.env.IMAGE_RELAY_PEER_TIMEOUT_MS || 60000);

async function peerProxy(req, res) {
  const m = PEER_RX.exec(req.path);
  if (!m) return res.status(404).json({ success: false, message: 'غير موجود' });
  const [, target, inner] = m;
  const allowed = (inner === '/internal/sync/vv' && req.method === 'GET') || (inner === '/internal/sync/events' && req.method === 'POST')
    || (inner.startsWith('/internal/sync/blobs/') && (req.method === 'GET' || req.method === 'HEAD'));
  if (!allowed) return res.status(405).json({ success: false, message: 'طريقة غير مسموحة' });
  const from = String(req.headers['x-relay-node'] || '');
  const who = await authenticate({ type: 'hello', nodeId: from, proof: String(req.headers['x-relay-proof'] || '') }).catch(() => null);
  if (!who) return res.status(401).json({ success: false, message: 'جهاز غير معروف أو سرّه غير صحيح — أعد اقترانه من لوحة التحكم' });
  if (from === target) return res.status(400).json({ success: false, message: 'لا مزامنة للجهاز مع نفسه' });
  const node = nodes.get(target);
  if (!node) return res.status(503).json({ success: false, message: `الجهاز ${target} غير متصل بسيرفر ميرو السحابي الآن` });
  const headers = {};
  PEER_IN.forEach((h) => { if (req.headers[h]) headers[h] = String(req.headers[h]); });
  const body = Buffer.isBuffer(req.body) && req.body.length ? req.body : null;
  if (req.method === 'POST' && !body) return res.status(400).json({ success: false, message: 'دفعة فارغة' });
  let out;
  try { out = await sendTo(node, req.method, inner, headers, body, PEER_TIMEOUT_MS); }
  catch (err) { return res.status(err.timeout ? 504 : 502).json({ success: false, message: err.message }); }
  Object.entries(out.headers || {}).forEach(([k, v]) => { if (PEER_OUT.includes(k.toLowerCase())) res.set(k, v); });
  res.status(out.status);
  if (req.method === 'HEAD') return res.end();
  return res.end(out.body);
}

/** كـ fetch تماماً (Response حقيقي) — ليستعمله imageCloudService بلا تغيير في منطقه. */
async function relayFetch(path, init = {}, prefer) {
  const headers = {};
  new Headers(init.headers || {}).forEach((v, k) => { headers[k] = v; });
  let body = null;
  if (init.body != null) {
    // FormData/Blob/نص ← بايتات + نوع المحتوى (حدود multipart)
    const r = new Request('http://relay.local/', { method: 'POST', body: init.body, headers: init.headers });
    body = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get('content-type');
    if (ct) headers['content-type'] = ct;
  }
  const r = await request(init.method || 'GET', path, { headers, body, prefer, ...(init.timeoutMs ? { timeoutMs: init.timeoutMs } : {}) });
  return new Response(r.status === 204 || r.status === 304 ? null : r.body, { status: r.status, headers: r.headers });
}

/* ═════════ التخزين المؤقت (LRU) ═════════ */

/** ذاكرة LRU بحد بايتات: الصور (64MB افتراضياً) والفيديو منفصلاً (96MB) — فيديو واحد لا يطرد كل الصور. */
function lru(max, maxEntry) {
  const map = new Map(); let size = 0;
  return {
    get(key) {
      const e = map.get(key);
      if (!e) return null;
      if (Date.now() - e.at > CACHE_TTL_MS) { map.delete(key); size -= e.size; return null; }
      map.delete(key); map.set(key, e); // الأحدث استعمالاً في الآخر
      return e;
    },
    put(key, e) {
      if (e.size > maxEntry) return; // أكبر من المسموح لعنصر واحد لا يُخزَّن
      const old = map.get(key); if (old) { map.delete(key); size -= old.size; }
      map.set(key, e); size += e.size;
      for (const [k, v] of map) { if (size <= max) break; map.delete(k); size -= v.size; }
    },
    clear() { map.clear(); size = 0; },
    stats() { return { entries: map.size, bytes: size }; },
  };
}
const VIDEO_CACHE_MAX = Number(process.env.IMAGE_RELAY_VIDEO_CACHE_MB || 96) * 1024 * 1024;
const imgCache = lru(CACHE_MAX, CACHE_MAX / 8);
const vidCache = lru(VIDEO_CACHE_MAX, MAX_BODY);
const isVideoType = (h) => /^video\//i.test(String((h && (h['content-type'] || h['Content-Type'])) || ''));
const cacheGet = (key) => imgCache.get(key) || vidCache.get(key);
const cachePut = (key, e) => (isVideoType(e.headers) ? vidCache : imgCache).put(key, e);
const clearCache = () => { imgCache.clear(); vidCache.clear(); };
const cacheStats = () => { const a = imgCache.stats(); const b = vidCache.stats(); return { entries: a.entries + b.entries, bytes: a.bytes + b.bytes, video: b }; };

/** «bytes=a-b» من نسخة كاملة في الذاكرة ← { start, end } أو null (غير صالح) أو undefined (بلا Range). */
function parseRange(header, total) {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start; let end;
  if (m[1] === '') { const n = Number(m[2]); start = Math.max(0, total - n); end = total - 1; } // آخر n بايت
  else { start = Number(m[1]); end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1); }
  if (start > end || start >= total) return null;
  return { start, end };
}

/* ═════════ عرض الصور للعامة ═════════ */

const MEDIA_RX = /^\/media\/[A-Za-z0-9_-]{1,64}(\/(small|medium|large|original|thumb))?$/;
const PASS = ['content-type', 'etag', 'last-modified', 'cache-control', 'content-range', 'accept-ranges', 'content-disposition', 'x-variant'];

/** GET/HEAD /api/image-cloud/relay/media/{id}/{variant}[?width=&sig=&exp=] */
async function serveMedia(req, res) {
  const path = req.path; // داخل الموجّه: /media/...
  if (!MEDIA_RX.test(path)) return res.status(404).json({ success: false, message: 'غير موجود' });
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  const fwd = {};
  ['range', 'if-none-match', 'if-modified-since', 'accept'].forEach((h) => { if (req.headers[h]) fwd[h] = req.headers[h]; });
  // الروابط العامة (بلا توقيع) تُجلب كاملة مرة واحدة وتُخزَّن، وطلبات Range (مشغّل الفيديو) تُخدم منها هنا
  const cacheable = !/[?&](sig|exp|token)=/.test(qs);
  const key = path + qs;

  let r = cacheable ? cacheGet(key) : null;
  const fromCache = !!r;
  if (!r) {
    try {
      const out = await request('GET', path + qs, { headers: cacheable ? { accept: fwd.accept || '*/*' } : fwd, tryAllOn404: true, timeoutMs: 120000 });
      r = { status: out.status, headers: out.headers, body: out.body, size: out.body.length, at: Date.now() };
      if (cacheable && out.status === 200) cachePut(key, r);
    } catch (err) {
      res.set('Retry-After', '30');
      return res.status(503).json({ success: false, message: err.message });
    }
  }
  const h = {};
  Object.entries(r.headers || {}).forEach(([k, v]) => { if (PASS.includes(k.toLowerCase()) && k.toLowerCase() !== 'content-range') h[k] = v; });
  res.set(h);
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.set('X-Image-Relay', fromCache ? 'hit' : 'miss');
  if (!h['cache-control'] && !h['Cache-Control'] && r.status === 200) res.set('Cache-Control', 'public, max-age=86400');
  // إعادة تحقق المتصفح من النسخة المخزّنة
  const etag = r.headers && (r.headers.etag || r.headers.ETag);
  if (fromCache && etag && req.headers['if-none-match'] === etag && !fwd.range) return res.status(304).end();
  if (cacheable && r.status === 200) {
    res.set('Accept-Ranges', 'bytes');
    const range = parseRange(fwd.range, r.body.length);
    if (range === null) { res.set('Content-Range', `bytes */${r.body.length}`); return res.status(416).end(); }
    if (range) {
      res.set('Content-Range', `bytes ${range.start}-${range.end}/${r.body.length}`);
      res.set('Content-Length', String(range.end - range.start + 1));
      res.status(206);
      return req.method === 'HEAD' ? res.end() : res.end(r.body.subarray(range.start, range.end + 1));
    }
  } else if (r.headers && (r.headers['content-range'] || r.headers['Content-Range'])) {
    res.set('Content-Range', r.headers['content-range'] || r.headers['Content-Range']);
  }
  res.status(r.status);
  if (req.method === 'HEAD') { res.set('Content-Length', String(r.body.length)); return res.end(); }
  return res.end(r.body);
}

/** الرابط العام للنفق على هذا الخادم: PUBLIC_API_URL أو من رأس الطلب (Railway خلف بروكسي). */
function baseFor(req) {
  const env = String(process.env.PUBLIC_API_URL || '').trim().replace(/\/+$/, '');
  if (env) return env + MOUNT;
  const hdr = (req && req.headers) || {};
  const proto = hdr['x-forwarded-proto'] || (req && req.protocol) || 'https';
  const host = hdr['x-forwarded-host'] || hdr.host;
  return host ? `${String(proto).split(',')[0].trim()}://${String(host).split(',')[0].trim()}${MOUNT}` : '';
}
const isRelayUrl = (u) => typeof u === 'string' && /\/api\/image-cloud\/relay\/?$/.test(u.trim());

/** رابط لا يصل إليه الخادم من الإنترنت أبداً (الجهاز نفسه أو شبكة محلية) — يُستبدل بنفق الخادم. */
function isPrivateUrl(u) {
  if (process.env.IMAGE_CLOUD_ALLOW_PRIVATE === '1') return false; // للاختبار على نفس الجهاز فقط
  let h;
  try { h = new URL(String(u || '').trim()).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch (_) { return false; }
  if (h === 'localhost' || h.endsWith('.local') || h === '0.0.0.0' || h === '::1') return true;
  const m = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const a = Number(m[1]); const b = Number(m[2]);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

/** للاختبار: إغلاق كل الاتصالات. */
function reset() { for (const n of nodes.values()) { try { n.ws.terminate(); } catch (_) { /* */ } } nodes.clear(); clearCache(); }

module.exports = {
  WS_PATH, MOUNT, init, handleUpgrade, request, requestNode, peerProxy, relayFetch, serveMedia, baseFor, isRelayUrl,
  connectedCount, status, clearCache, cacheStats, reset, setPreferred, isConnected, isPrivateUrl,
};
