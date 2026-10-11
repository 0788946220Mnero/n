/**
 * نفق الصور عبر خادم ديار: جهاز (وهمي هنا — والحقيقي في اختبارات DiyarPOS) يتصل بـ WebSocket،
 * والصور تُعرض للعامة عبر الخادم، والرفع والفحص يمرّان داخلياً.
 *   node --test tests/imageRelay.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const WebSocket = require('ws');

// ── ImageCloud في الذاكرة ──
const ImageCloud = require('../models/ImageCloud');
let DOC = null;
const clone = (v) => (v ? JSON.parse(JSON.stringify(v)) : null);
ImageCloud.findOne = () => ({ select() { return this; }, lean: async () => clone(DOC) });
ImageCloud.updateOne = async (f, u) => {
  DOC = DOC || { key: 'main', nodes: [] };
  Object.entries(u.$set || {}).forEach(([k, v]) => { DOC[k] = clone(v); });
  return { modifiedCount: 1 };
};
// دخول وهمي: «ADMIN» مدير النظام، «CASHIER» كاشير
const users = { ADMIN: { _id: 'u1', name: 'مروان', role: 'admin', permissions: [] }, CASHIER: { _id: 'u2', name: 'سامي', role: 'cashier', permissions: [] } };
require.cache[require.resolve('../middlewares/auth')] = { exports: {
  protect: (req, res, next) => { const t = String(req.headers.authorization || '').replace('Bearer ', ''); if (!users[t]) return res.status(401).json({}); req.user = users[t]; next(); },
} };
const realtime = require('../services/realtimeService');
const sent = [];
realtime.broadcast = (t, p) => sent.push({ t, ...p });

const relay = require('../services/imageRelayService');
const imageCloud = require('../services/imageCloudService');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const IMG = crypto.randomBytes(5000);

let server; let base;
test.before(async () => {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/image-cloud', require('../routes/imageCloudRoutes'));
  server = http.createServer(app);
  server.on('upgrade', (req, socket, head) => (req.url.split('?')[0] === relay.WS_PATH ? relay.handleUpgrade(req, socket, head) : socket.destroy()));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { relay.reset(); server.close(); });

/** جهاز وهمي يجيب طلبات النفق كما تجيبها خدمة ImageStorage. */
function device(nodeId, proof, { onReq } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}${relay.WS_PATH}`);
    const seen = [];
    let pendingBody = null;
    const answer = (m, body) => {
      seen.push({ ...m, body });
      const reply = (status, headers, buf) => {
        ws.send(JSON.stringify({ type: 'res', id: m.id, status, headers, size: buf ? buf.length : 0 }));
        if (buf && buf.length) ws.send(Buffer.concat([Buffer.from(m.id, 'latin1'), buf]));
      };
      if (onReq) return onReq(m, body, reply);
      if (m.path.startsWith('/media/')) return reply(200, { 'content-type': 'image/jpeg', etag: '"v1"', 'cache-control': 'public, max-age=31536000, immutable' }, IMG);
      if (m.path === '/api/v1/health') return reply(200, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({ status: 'ok', node: nodeId })));
      if (m.path.startsWith('/api/v1/images') && m.method === 'GET') {
        return m.headers['x-api-key'] === 'isk_relaytestkey123' ? reply(200, { 'content-type': 'application/json' }, Buffer.from('{"items":[]}')) : reply(401, {}, Buffer.from('{"error":{"message":"مفتاح خاطئ"}}'));
      }
      if (m.path === '/api/v1/images' && m.method === 'POST') return reply(201, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({ id: '01RELAYUPLOAD', size: body.length })));
      return reply(404, {}, null);
    };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', nodeId, proof })));
    ws.on('message', (data, isBinary) => {
      if (isBinary) { const b = Buffer.from(data); if (pendingBody && b.subarray(0, 16).toString('latin1') === pendingBody.id) { const m = pendingBody; pendingBody = null; answer(m, b.subarray(16)); } return; }
      const m = JSON.parse(String(data));
      if (m.type === 'welcome') return resolve({ ws, seen, ok: true });
      if (m.type === 'req') { if (m.size > 0) pendingBody = m; else answer(m, Buffer.alloc(0)); }
    });
    ws.on('close', (code) => resolve({ ws, seen, ok: false, code }));
  });
}

const get = async (path, headers = {}) => {
  const r = await fetch(base + path, { headers });
  return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) };
};

test('جهاز بسرّ خاطئ أو غير منضم لا يتصل بالنفق', async () => {
  DOC = { key: 'main', nodes: [{ nodeId: 'pos-relay-1', name: 'CASHIER', proofHash: sha('SECRET-R') }] };
  let d = await device('pos-relay-1', 'WRONG');
  assert.equal(d.ok, false); assert.equal(d.code, 4003);
  d = await device('pos-unknown', 'SECRET-R');
  assert.equal(d.ok, false);
  assert.equal(relay.connectedCount(), 0);
  const r = await get('/api/image-cloud/relay/media/01ABC/medium');
  assert.equal(r.status, 503, 'بلا جهاز: 503 مع السبب');
});

let dev;
test('الجهاز يتصل، والصور تُعرض للعامة عبر الخادم، ثم من التخزين المؤقت', async () => {
  dev = await device('pos-relay-1', 'SECRET-R');
  assert.equal(dev.ok, true);
  assert.equal(relay.connectedCount(), 1);
  let r = await get('/api/image-cloud/relay/media/01ABC/medium');
  assert.equal(r.status, 200);
  assert.ok(r.body.equals(IMG), 'الصورة مطابقة بايت ببايت');
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.equal(r.headers.get('x-image-relay'), 'miss');
  assert.equal(r.headers.get('cross-origin-resource-policy'), 'cross-origin', 'تُعرض على موقع الزبائن (نطاق آخر)');
  assert.match(r.headers.get('cache-control'), /max-age/);
  r = await get('/api/image-cloud/relay/media/01ABC/medium');
  assert.equal(r.headers.get('x-image-relay'), 'hit', 'المرة الثانية من ذاكرة الخادم — لا تصل للجهاز');
  assert.equal(dev.seen.filter((m) => m.path === '/media/01ABC/medium').length, 1);
  r = await get('/api/image-cloud/relay/media/01ABC/medium', { 'if-none-match': '"v1"' });
  assert.equal(r.status, 304);
  const h = await fetch(base + '/api/image-cloud/relay/media/01ABC/large', { method: 'HEAD' });
  assert.equal(h.status, 200);
  r = await get('/api/image-cloud/relay/media/01ABC?width=300');
  assert.equal(r.status, 200);
  assert.ok(dev.seen.some((m) => m.path === '/media/01ABC?width=300'), 'المعاملات تمر');
});

test('العامة لا يصلون لغير الصور (لا رفع ولا إدارة ولا مسارات غريبة)', async () => {
  for (const p of ['/api/image-cloud/relay/api/v1/images', '/api/image-cloud/relay/api/v1/local/peers', '/api/image-cloud/relay/media/../api/v1/images', '/api/image-cloud/relay/media/01ABC/medium/extra']) {
    const r = await get(p);
    assert.ok(r.status === 404, `${p} ← ${r.status}`);
  }
  const post = await fetch(base + '/api/image-cloud/relay/media/01ABC/medium', { method: 'POST' });
  assert.equal(post.status, 404);
  assert.ok(!dev.seen.some((m) => m.method !== 'GET'), 'لم يصل الجهاز أي طلب غير GET من العامة');
});

test('الفحص والرفع من الخادم يمرّان داخل النفق بالمفتاح', async () => {
  const cfg = { baseUrl: `${base}/api/image-cloud/relay`, apiKey: 'isk_relaytestkey123', projectId: 'diyar' };
  const t = await imageCloud.test(cfg);
  assert.equal(t.ok, true, t.message);
  assert.equal(t.node, 'pos-relay-1');
  const bad = await imageCloud.test({ ...cfg, apiKey: 'isk_wrongkey00000' });
  assert.equal(bad.ok, false);
  const up = await imageCloud.upload(IMG, { cfg, filename: 'p.jpg', mime: 'image/jpeg', folder: 'products', variant: 'medium' });
  assert.equal(up.id, '01RELAYUPLOAD');
  assert.equal(up.url, `${base}/api/image-cloud/relay/media/01RELAYUPLOAD/medium`, 'الرابط المحفوظ رابط النفق');
  const m = dev.seen.find((x) => x.method === 'POST');
  assert.equal(m.headers['x-api-key'], 'isk_relaytestkey123');
  assert.match(m.headers['content-type'], /multipart\/form-data; boundary=/);
  assert.ok(m.body.includes(IMG), 'الملف كاملاً داخل الطلب');
});

test('بلا رابط عام: نبض جهاز متصل ← الصور عبر الخادم وتُفعَّل السحابة تلقائياً', async () => {
  DOC = { key: 'main', enabled: false, wantEnabled: true, apiKey: 'isk_relaytestkey123', projectId: 'diyar', baseUrl: '',
    nodes: [{ nodeId: 'pos-relay-1', name: 'CASHIER', proofHash: sha('SECRET-R'), lastSeen: new Date().toISOString() }] };
  imageCloud.invalidate();
  const r = await fetch(base + '/api/image-cloud/nodes/heartbeat', {
    method: 'POST', headers: { Authorization: 'Bearer CASHIER', 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({ nodeId: 'pos-relay-1', running: true, proof: 'SECRET-R' }),
  });
  const hb = await r.json();
  assert.equal(hb.relayConnected, true);
  assert.match(hb.config.relayUrl, /^wss:\/\/127\.0\.0\.1:\d+\/api\/image-cloud\/relay\/ws$/, 'الجهاز يعرف عنوان النفق');
  for (let i = 0; i < 40 && !DOC.enabled; i++) await wait(25);
  assert.match(DOC.baseUrl, /\/api\/image-cloud\/relay$/);
  assert.equal(DOC.enabled, true, DOC.lastError);
  assert.ok(sent.some((m) => /فُعّلت سحابة الصور تلقائياً/.test(m.message || '')));
});

test('انقطع الجهاز: الصور المخزّنة تبقى تُعرض، والجديدة 503 حتى يعود', async () => {
  dev.ws.close();
  for (let i = 0; i < 40 && relay.connectedCount(); i++) await wait(25);
  assert.equal(relay.connectedCount(), 0);
  let r = await get('/api/image-cloud/relay/media/01ABC/medium');
  assert.equal(r.status, 200, 'من التخزين المؤقت');
  r = await get('/api/image-cloud/relay/media/01NEW/medium');
  assert.equal(r.status, 503);
  const up = await imageCloud.upload(IMG, { cfg: { baseUrl: `${base}/api/image-cloud/relay`, apiKey: 'isk_relaytestkey123' } }).catch((e) => e);
  assert.equal(up.status, 0, 'الرفع يفشل بـ status 0 ← يرجع لـ Cloudinary كالعادة');
  dev = await device('pos-relay-1', 'SECRET-R');
  r = await get('/api/image-cloud/relay/media/01NEW/medium');
  assert.equal(r.status, 200, 'عاد الجهاز ← تعمل فوراً');
});

test('جهاز لا يرد: مهلة ثم يُجرَّب جهاز آخر متصل', async () => {
  DOC.nodes.push({ nodeId: 'pos-relay-2', name: 'OFFICE', proofHash: sha('SECRET-2') });
  const silent = await device('pos-relay-2', 'SECRET-2', { onReq: () => {} }); // آخر من اتصل ← يُختار أولاً
  assert.equal(silent.ok, true);
  const t0 = Date.now();
  const r = await relay.request('GET', '/media/01X/small', { timeoutMs: 300 });
  assert.equal(r.status, 200);
  assert.equal(r.node, 'pos-relay-1', 'أجاب الجهاز الآخر');
  assert.ok(Date.now() - t0 < 2000);
  silent.ws.close();
});
