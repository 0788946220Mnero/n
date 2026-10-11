/*
  ═══════════════════════════════════════════════════════════════
  نفق الصور عبر خادم ديار (بلا Cloudflare ولا فتح منافذ):

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

const handleUpgrade = (req, socket, head) => init().handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));

function onConnection(ws) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let node = null;
  const helloTimer = setTimeout(() => { if (!node) ws.close(4001, 'hello timeout'); }, 10000);

  ws.on('message', async (data, isBinary) => {
    if (!node) {
      if (isBinary) return ws.close(4002, 'hello first');
      clearTimeout(helloTimer);
      let m; try { m = JSON.parse(String(data)); } catch (_) { return ws.close(4002, 'bad hello'); }
      node = await authenticate(m).catch(() => null);
      if (!node) { ws.close(4003, 'unknown device'); return; }
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
  ws.on('close', gone);
  ws.on('error', gone);
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

const connected = () => [...nodes.values()].sort((a, b) => b.since - a.since);
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
async function request(method, path, { headers = {}, body = null, timeoutMs = REQ_TIMEOUT_MS } = {}) {
  const list = connected();
  if (!list.length) throw Object.assign(new Error('لا يوجد جهاز صور متصل بالخادم — DiyarPOS مطفأ أو بلا إنترنت'), { status: 0 });
  let last;
  for (const node of list.slice(0, 2)) { // جهاز ثانٍ عند فشل الأول
    try { return await sendTo(node, method, path, headers, body, timeoutMs); } catch (err) { last = err; }
  }
  throw last;
}

/** كـ fetch تماماً (Response حقيقي) — ليستعمله imageCloudService بلا تغيير في منطقه. */
async function relayFetch(path, init = {}) {
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
  const r = await request(init.method || 'GET', path, { headers, body });
  return new Response(r.status === 204 || r.status === 304 ? null : r.body, { status: r.status, headers: r.headers });
}

/* ═════════ التخزين المؤقت (LRU) ═════════ */

const cache = new Map(); // key ← { at, size, status, headers, body }
let cacheSize = 0;
function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) { cache.delete(key); cacheSize -= e.size; return null; }
  cache.delete(key); cache.set(key, e); // الأحدث استعمالاً في الآخر
  return e;
}
function cachePut(key, e) {
  if (e.size > CACHE_MAX / 8) return; // صورة ضخمة لا تُخزَّن
  const old = cache.get(key); if (old) { cache.delete(key); cacheSize -= old.size; }
  cache.set(key, e); cacheSize += e.size;
  for (const [k, v] of cache) { if (cacheSize <= CACHE_MAX) break; cache.delete(k); cacheSize -= v.size; }
}
const clearCache = () => { cache.clear(); cacheSize = 0; };
const cacheStats = () => ({ entries: cache.size, bytes: cacheSize });

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
  const cacheable = !fwd.range && !/[?&](sig|exp|token)=/.test(qs);
  const key = path + qs;

  let r = cacheable ? cacheGet(key) : null;
  const fromCache = !!r;
  if (!r) {
    try {
      const out = await request('GET', path + qs, { headers: cacheable ? { accept: fwd.accept || '*/*' } : fwd });
      r = { status: out.status, headers: out.headers, body: out.body, size: out.body.length, at: Date.now() };
      if (cacheable && out.status === 200) cachePut(key, r);
    } catch (err) {
      res.set('Retry-After', '30');
      return res.status(503).json({ success: false, message: err.message });
    }
  }
  const h = {};
  Object.entries(r.headers || {}).forEach(([k, v]) => { if (PASS.includes(k.toLowerCase())) h[k] = v; });
  res.set(h);
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.set('X-Image-Relay', fromCache ? 'hit' : 'miss');
  if (!h['cache-control'] && !h['Cache-Control'] && r.status === 200) res.set('Cache-Control', 'public, max-age=86400');
  // إعادة تحقق المتصفح من النسخة المخزّنة
  const etag = r.headers && (r.headers.etag || r.headers.ETag);
  if (fromCache && etag && req.headers['if-none-match'] === etag) return res.status(304).end();
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

/** للاختبار: إغلاق كل الاتصالات. */
function reset() { for (const n of nodes.values()) { try { n.ws.terminate(); } catch (_) { /* */ } } nodes.clear(); clearCache(); }

module.exports = {
  WS_PATH, MOUNT, init, handleUpgrade, request, relayFetch, serveMedia, baseFor, isRelayUrl,
  connectedCount, status, clearCache, cacheStats, reset,
};
