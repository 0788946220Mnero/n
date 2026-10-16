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

test('جهازان على شبكتين: المفتاح المحفوظ لجهاز غير متصل ← الخادم يطلب مفتاح الكاشير المتصل فتُفعَّل', async () => {
  relay.reset();
  // الوضع الحقيقي: مفتاح من جهاز آخر (لا يتزامن مع الكاشير)، والسحابة غير مفعّلة
  DOC = { key: 'main', enabled: false, wantEnabled: true, apiKey: 'isk_otherdevicekey1', keyNodeId: '', projectId: 'diyar',
    baseUrl: `${base}/api/image-cloud/relay`,
    nodes: [
      { nodeId: 'pos-relay-1', name: 'CASHIER', proofHash: sha('SECRET-R'), lastSeen: new Date().toISOString() },
      { nodeId: 'pos-home-9', name: 'HOME', proofHash: sha('SECRET-H'), lastSeen: new Date().toISOString() },
    ] };
  imageCloud.invalidate();
  dev = await device('pos-relay-1', 'SECRET-R');
  const hb = async (nodeId, proof) => (await fetch(base + '/api/image-cloud/nodes/heartbeat', {
    method: 'POST', headers: { Authorization: 'Bearer CASHIER', 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId, running: true, proof }),
  })).json();
  let r = await hb('pos-relay-1', 'SECRET-R');
  assert.equal(r.needKey, true, 'الخادم يطلب مفتاح الكاشير');
  for (let i = 0; i < 40 && !DOC.lastError; i++) await wait(25);
  assert.equal(DOC.enabled, false);
  assert.match(DOC.lastError || '', /مرفوض/, 'المفتاح القديم مرفوض على الكاشير — هذا سبب «السحابة لا تعمل»');
  // بلا سرّ صحيح لا يُقبل مفتاح
  const post = (body) => fetch(base + '/api/image-cloud/nodes/key', { method: 'POST', headers: { Authorization: 'Bearer CASHIER', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ nodeId: 'pos-relay-1', proof: 'WRONG', apiKey: 'isk_relaytestkey123' })).status, 403);
  const k = await (await post({ nodeId: 'pos-relay-1', proof: 'SECRET-R', apiKey: 'isk_relaytestkey123' })).json();
  assert.equal(k.enabled, true, k.message);
  assert.equal(DOC.apiKey, 'isk_relaytestkey123');
  assert.equal(DOC.keyNodeId, 'pos-relay-1');
  r = await hb('pos-relay-1', 'SECRET-R');
  assert.equal(r.needKey, false, 'بعد التفعيل لا طلب');
  assert.equal((await post({ nodeId: 'pos-relay-1', proof: 'SECRET-R', apiKey: 'isk_relaytestkey123' })).status, 409);
});

test('النفق يوجّه لصاحب المفتاح أولاً حتى لو اتصل جهاز آخر بعده', async () => {
  const home = await device('pos-home-9', 'SECRET-H', { onReq: (m, b, reply) => reply(401, {}, Buffer.from('{"error":{"message":"مفتاح خاطئ"}}')) });
  assert.equal(home.ok, true);
  imageCloud.invalidate();
  const t = await imageCloud.test(await imageCloud.activeConfig());
  assert.equal(t.ok, true, `الفحص ذهب للكاشير لا للجهاز الأحدث: ${t.message}`);
  relay.clearCache();
  const m = await get('/api/image-cloud/relay/media/01PREF/medium');
  assert.equal(m.status, 200);
  assert.equal(home.seen.length, 0, 'الجهاز الآخر لم يستلم أي طلب');
  home.ws.close();
});

test('إزالة الجهاز صاحب المفتاح من اللوحة ← يُنسى صاحب المفتاح', async () => {
  const r = await fetch(base + '/api/image-cloud/nodes/pos-relay-1', { method: 'DELETE', headers: { Authorization: 'Bearer ADMIN' } });
  assert.equal(r.status, 200);
  assert.ok(!DOC.keyNodeId, 'صاحب المفتاح نُسي');
  assert.ok(!DOC.nodes.some((n) => n.nodeId === 'pos-relay-1'));
});

test('رابط محلي محفوظ (127.0.0.1 من «ربط بالخادم» بلا رابط عام) ← يُستبدل بنفق الخادم وتُفعَّل', async () => {
  assert.equal(relay.isPrivateUrl('http://127.0.0.1:5080'), true);
  assert.equal(relay.isPrivateUrl('http://192.168.1.50:5080'), true);
  assert.equal(relay.isPrivateUrl('https://images.diyaralanbat.com'), false);
  relay.reset();
  DOC = { key: 'main', enabled: false, wantEnabled: true, apiKey: 'isk_relaytestkey123', keyNodeId: 'pos-relay-1', projectId: 'diyar',
    baseUrl: 'http://127.0.0.1:5080', lastError: 'جهاز الصور لا يرد على http://127.0.0.1:5080',
    nodes: [{ nodeId: 'pos-relay-1', name: 'CASHIER', proofHash: sha('SECRET-R'), lastSeen: new Date().toISOString() }] };
  imageCloud.invalidate();
  dev = await device('pos-relay-1', 'SECRET-R');
  await fetch(base + '/api/image-cloud/nodes/heartbeat', {
    method: 'POST', headers: { Authorization: 'Bearer CASHIER', 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId: 'pos-relay-1', running: true, proof: 'SECRET-R' }),
  });
  for (let i = 0; i < 40 && !DOC.enabled; i++) await wait(25);
  assert.match(DOC.baseUrl, /\/api\/image-cloud\/relay$/, 'الرابط المحلي استُبدل بالنفق');
  assert.equal(DOC.enabled, true, DOC.lastError);
  // «ربط بالخادم» من نسخة قديمة يرسل الرابط المحلي ← النفق بدل الرفض
  const r = await fetch(base + '/api/image-cloud', { method: 'PUT', headers: { Authorization: 'Bearer ADMIN', 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, baseUrl: 'http://127.0.0.1:5080', apiKey: 'isk_relaytestkey123', nodeId: 'pos-relay-1' }) });
  const j = await r.json();
  assert.equal(r.status, 200, j.message);
  assert.equal(j.cloud.viaRelay, true);
  assert.equal(j.cloud.enabled, true);
});

/* ───────── السحابة مفعّلة ثم تعطّلت: الإصلاح الذاتي كان يعمل قبل التفعيل فقط ───────── */
const hbOf = async (nodeId, proof) => (await fetch(base + '/api/image-cloud/nodes/heartbeat', {
  method: 'POST', headers: { Authorization: 'Bearer CASHIER', 'Content-Type': 'application/json' },
  body: JSON.stringify({ nodeId, running: true, proof }),
})).json();
const sendKey = async (body) => (await fetch(base + '/api/image-cloud/nodes/key', { method: 'POST', headers: { Authorization: 'Bearer CASHIER', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const twoNodes = () => [
  { nodeId: 'pos-relay-1', name: 'CASHIER', proofHash: sha('SECRET-R'), lastSeen: new Date().toISOString() },
  { nodeId: 'pos-home-9', name: 'HOME', proofHash: sha('SECRET-H'), lastSeen: new Date().toISOString() },
];

test('مفعّلة برابط محلي محفوظ والنفق متصل ← تتحول للنفق مع أول نبض', async () => {
  relay.reset();
  DOC = { key: 'main', enabled: true, apiKey: 'isk_relaytestkey123', keyNodeId: 'pos-relay-1', projectId: 'diyar',
    baseUrl: 'http://127.0.0.1:5080', nodes: twoNodes() };
  imageCloud.invalidate();
  dev = await device('pos-relay-1', 'SECRET-R');
  await hbOf('pos-relay-1', 'SECRET-R');
  for (let i = 0; i < 40 && !/relay$/.test(DOC.baseUrl); i++) await wait(25);
  assert.match(DOC.baseUrl, /\/api\/image-cloud\/relay$/);
  assert.equal(DOC.enabled, true);
  imageCloud.invalidate();
  const up = await imageCloud.upload(IMG, { cfg: await imageCloud.activeConfig(), filename: 'p.jpg', mime: 'image/jpeg' });
  assert.match(up.url, /\/api\/image-cloud\/relay\/media\/01RELAYUPLOAD\/large$/, 'الرفع يعمل عبر النفق');
});

test('مفعّلة ومفتاحها لجهاز غير متصل (شبكة أخرى) ← يُطلب مفتاح الكاشير المتصل، ويُقبل بعد اختباره فقط', async () => {
  DOC = { ...DOC, enabled: true, apiKey: 'isk_otherdevicekey1', keyNodeId: 'pos-home-9', baseUrl: `${base}/api/image-cloud/relay`, lastError: '' };
  imageCloud.invalidate();
  const r = await hbOf('pos-relay-1', 'SECRET-R');
  assert.equal(r.needKey, true, 'مفعّلة لكن صاحب المفتاح غائب ← يُطلب المفتاح');
  // مفتاح لا يقبله جهاز الصور: لا يُستبدل به مفتاح السحابة
  const bad = await sendKey({ nodeId: 'pos-relay-1', proof: 'SECRET-R', apiKey: 'isk_wrongkey000000' });
  assert.equal(DOC.apiKey, 'isk_otherdevicekey1', 'مفتاح غير مُختبَر لا يُحفظ');
  assert.match(DOC.lastError, /مرفوض/, bad.message);
  const ok = await sendKey({ nodeId: 'pos-relay-1', proof: 'SECRET-R', apiKey: 'isk_relaytestkey123' });
  assert.equal(ok.enabled, true, ok.message);
  assert.equal(DOC.apiKey, 'isk_relaytestkey123'); assert.equal(DOC.keyNodeId, 'pos-relay-1'); assert.equal(DOC.enabled, true);
  assert.ok(sent.some((m) => /الرفع الآن إلى جهاز CASHIER/.test(m.message || '')));
  assert.equal((await hbOf('pos-relay-1', 'SECRET-R')).needKey, false, 'بعدها لا طلب');
});

test('جهاز الصور يرفض المفتاح عند الرفع ← يُسجَّل السبب ويُطلب مفتاح من الجهاز المتصل', async () => {
  relay.reset();
  dev = await device('pos-relay-1', 'SECRET-R', { onReq: (m, b, reply) => (m.method === 'POST'
    ? reply(401, { 'content-type': 'application/json' }, Buffer.from('{"error":{"message":"مفتاح غير صالح"}}'))
    : reply(200, { 'content-type': 'application/json' }, Buffer.from('{"status":"ok","node":"pos-relay-1","items":[]}'))) });
  imageCloud.invalidate();
  const e = await imageCloud.upload(IMG, { cfg: await imageCloud.activeConfig() }).catch((x) => x);
  assert.equal(e.status, 401);
  assert.match(e.message, /رفض مفتاح الرفع/);
  for (let i = 0; i < 40 && !DOC.keyRejectedAt; i++) await wait(10);
  assert.ok(DOC.keyRejectedAt, 'سُجّل الرفض');
  assert.equal((await hbOf('pos-relay-1', 'SECRET-R')).needKey, true, 'يُطلب المفتاح ولو كان الجهاز صاحبه');
  relay.reset();
  dev = await device('pos-relay-1', 'SECRET-R');
  const k = await sendKey({ nodeId: 'pos-relay-1', proof: 'SECRET-R', apiKey: 'isk_relaytestkey123' });
  assert.equal(k.enabled, true);
  assert.equal(DOC.keyRejectedAt, null, 'زال الرفض بعد مفتاح مُختبَر');
});

test('مفعّلة بلا مفتاح ← الرجوع لـ Cloudinary يُسجَّل بسببه لا بصمت', async () => {
  DOC = { ...DOC, enabled: true, apiKey: '' };
  imageCloud.invalidate();
  assert.equal(await imageCloud.activeConfig(), null);
  assert.match(imageCloud.inactiveReason(), /لا يوجد مفتاح رفع/);
  DOC = { ...DOC, enabled: false };
  imageCloud.invalidate(); await imageCloud.activeConfig();
  assert.equal(imageCloud.inactiveReason(), '', 'غير مفعّلة ← لا خطأ يُسجَّل');
});

test('صورة على جهاز آخر (شبكتان لا تتزامنان) ← تُطلب من الأجهزة الأخرى بدل 404', async () => {
  relay.reset();
  DOC = { ...DOC, nodes: twoNodes(), keyNodeId: 'pos-relay-1' };
  dev = await device('pos-relay-1', 'SECRET-R', { onReq: (m, b, reply) => reply(404, {}, null) });
  const home = await device('pos-home-9', 'SECRET-H');
  relay.setPreferred('pos-relay-1');
  const r = await get('/api/image-cloud/relay/media/01ONHOME/medium');
  assert.equal(r.status, 200, 'من جهاز البيت');
  assert.ok(home.seen.some((m) => m.path === '/media/01ONHOME/medium'));
  relay.clearCache();
  home.ws.close();
  for (let i = 0; i < 40 && relay.connectedCount() > 1; i++) await wait(25);
  const nf = await get('/api/image-cloud/relay/media/01NOWHERE/medium');
  assert.equal(nf.status, 404, 'غير موجودة في أي جهاز ← 404');
});

/* ───────── النقل من Cloudinary: لا نجاح وهمي ───────── */
test('النقل: صورة قُبل رفعها لكنها لا تُعرض ← لا يُستبدل رابطها، والنتيجة «جزئي» لا «اكتمل»', async () => {
  const migration = require('../services/imageMigrationService');
  relay.reset();
  let n = 0;
  dev = await device('pos-relay-1', 'SECRET-R', { onReq: (m, b, reply) => {
    const json = (o) => reply(200, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify(o)));
    if (m.path === '/api/v1/health') return json({ status: 'ok', node: 'pos-relay-1' });
    if (m.path.startsWith('/api/v1/images') && m.method === 'GET') return json({ items: [] });
    if (m.path === '/api/v1/images' && m.method === 'POST') {
      // الملف الأول «يُقبل» لكن نسخه لا تُنشأ أبداً (هذا ما كان يُحسب نجاحاً)
      n++; return reply(201, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({ id: n === 1 ? '01BROKEN' : `01GOOD${n}` })));
    }
    if (m.path.startsWith('/media/01GOOD')) return reply(200, { 'content-type': 'image/jpeg' }, IMG);
    return reply(404, {}, null);
  } });
  DOC = { key: 'main', enabled: true, apiKey: 'isk_relaytestkey123', keyNodeId: 'pos-relay-1', baseUrl: `${base}/api/image-cloud/relay`, projectId: 'diyar',
    nodes: [{ nodeId: 'pos-relay-1', name: 'CASHIER', proofHash: sha('SECRET-R') }] };
  imageCloud.invalidate();
  const mk = (docs) => ({
    docs,
    find: () => ({ toArray: async () => JSON.parse(JSON.stringify(docs)) }),
    updateOne: async (f, u) => { const d = docs.find((x) => x._id === f._id); const [p, val] = Object.entries(u.$set)[0];
      if (!d || d[p] !== f[p]) return { modifiedCount: 0 }; d[p] = val; return { modifiedCount: 1 }; },
  });
  const C = 'https://res.cloudinary.com/demo/image/upload/v1/diyar-alanbat/';
  const P = mk([{ _id: 'p1', image: `${C}a.jpg` }, { _id: 'p2', image: `${C}b.jpg` }]);
  require('../models/Product').collection = P;
  require('../models/Category').collection = mk([]);
  require('../models/Setting').collection = mk([]);
  require('../models/Notification').collection = mk([]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => (String(url).startsWith('https://res.cloudinary.com/')
    ? Promise.resolve(new Response(IMG, { status: 200, headers: { 'content-type': 'image/jpeg' } })) : realFetch(url, opts));
  try {
    const r = await migration.run('مروان');
    assert.equal(r.total, 2);
    assert.equal(r.done, 1, 'واحدة فقط تُعرض فعلاً');
    assert.equal(r.failed, 1);
    assert.equal(r.remaining, 1, 'عدّ حقيقي من القاعدة: رابط واحد بقي على Cloudinary');
    assert.equal(r.status, 'partial', 'لا «اكتمل» وصورة لم تُنقل');
    const broken = P.docs.find((d) => d.image === `${C}a.jpg` || d.image === `${C}b.jpg`);
    assert.ok(broken, 'الصورة التي لا تُعرض بقي رابطها على Cloudinary (لم تنكسر في الموقع)');
    assert.ok(P.docs.some((d) => /\/api\/image-cloud\/relay\/media\/01GOOD\d\/medium$/.test(d.image)), 'الأخرى استُبدلت برابط يعمل');
    assert.equal(DOC['migration.status'], 'partial');
    assert.match(JSON.stringify(DOC['migration.errors']), /لا تُعرض من رابطها/);
    for (let i = 0; i < 40 && !dev.seen.some((m) => m.method === 'DELETE'); i++) await wait(25);
    assert.ok(dev.seen.some((m) => m.method === 'DELETE' && m.path.includes('01BROKEN')), 'النسخة المكسورة حُذفت من الجهاز');
  } finally { globalThis.fetch = realFetch; }
});

/* ───────── رابط عام ميت (Cloudflare بلا cloudflared) والنفق متصل — حالة شاشة DiyarPOS ───────── */
test('رابط عام لا يرد (Https://images…) والنفق متصل ← تُفعَّل عبر خادم ديار بدل الانتظار للأبد', async () => {
  relay.reset();
  DOC = { key: 'main', enabled: false, wantEnabled: true, apiKey: 'isk_relaytestkey123', keyNodeId: 'pos-relay-1', projectId: 'diyar',
    baseUrl: 'https://images.diyar-dead.invalid', lastError: 'جهاز الصور لا يرد على https://images.diyar-dead.invalid',
    nodes: [{ nodeId: 'pos-relay-1', name: 'CASHIER', proofHash: sha('SECRET-R'), lastSeen: new Date().toISOString() }] };
  imageCloud.invalidate();
  dev = await device('pos-relay-1', 'SECRET-R');
  await hbOf('pos-relay-1', 'SECRET-R');
  for (let i = 0; i < 80 && !DOC.enabled; i++) await wait(25);
  assert.equal(DOC.enabled, true, DOC.lastError);
  assert.match(DOC.baseUrl, /\/api\/image-cloud\/relay$/, 'النفق بدل الرابط الميت');
  assert.ok(sent.some((m) => /لا يرد .*فُعّلت السحابة عبر خادم ديار/.test(m.message || '')), 'إشعار بالسبب');

  // «ربط بالخادم» من DiyarPOS بنفس الرابط الميت (كما في الصورة) ← يُفعَّل عبر النفق مع رسالة، لا «لم تُفعَّل بعد»
  DOC = { ...DOC, enabled: false, baseUrl: '' };
  imageCloud.invalidate();
  const r = await fetch(base + '/api/image-cloud', { method: 'PUT', headers: { Authorization: 'Bearer ADMIN', 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, baseUrl: 'Https://images.diyar-dead.invalid', apiKey: 'isk_relaytestkey123', nodeId: 'pos-relay-1' }) });
  const j = await r.json();
  assert.equal(r.status, 200, j.message);
  assert.equal(j.cloud.enabled, true);
  assert.equal(j.cloud.viaRelay, true);
  assert.ok(!j.pending);
  assert.match(j.message, /لا يرد .*عبر خادم ديار/);
});

test('مفعّلة برابط عام توقف عن الرد ← تتحول للنفق مع النبض', async () => {
  DOC = { ...DOC, enabled: true, baseUrl: 'https://images.diyar-dead.invalid', lastError: 'جهاز الصور لا يرد', lastAutoTry: null };
  imageCloud.invalidate();
  await hbOf('pos-relay-1', 'SECRET-R');
  for (let i = 0; i < 80 && !/relay$/.test(DOC.baseUrl); i++) await wait(25);
  assert.match(DOC.baseUrl, /\/api\/image-cloud\/relay$/);
  assert.equal(DOC.enabled, true);
  assert.equal(imageCloud.trimUrl('Https://Images.x.com/'), 'https://Images.x.com', '«Https» من الهاتف يُصحَّح');
});

/* ───────── التشخيص خطوة بخطوة ───────── */
test('التشخيص عبر النفق: كل الخطوات بالترتيب، والمصغّرة، والأصل محمي، وصورة الاختبار تُحذف', async () => {
  const { diagnose } = require('../services/imageCloudDiagnose');
  relay.reset();
  const mk = () => ({ find: () => ({ toArray: async () => [] }) });
  ['Product', 'Category', 'Setting', 'Notification'].forEach((m) => { require(`../models/${m}`).collection = mk(); });
  dev = await device('pos-relay-1', 'SECRET-R', { onReq: (m, b, reply) => {
    const json = (st, o) => reply(st, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify(o)));
    if (m.path === '/api/v1/health') return json(200, { status: 'ok', node: 'pos-relay-1', storage: { writable: true } });
    if (m.path.startsWith('/api/v1/images?')) return m.headers['x-api-key'] === 'isk_relaytestkey123' ? json(200, { items: [] }) : json(401, { error: { message: 'مفتاح خاطئ' } });
    if (m.path === '/api/v1/images' && m.method === 'POST') return json(201, { id: '01DIAG' });
    if (m.path === '/media/01DIAG/original') return json(403, { error: { message: 'محمي' } });
    if (m.path.startsWith('/media/01DIAG/')) return reply(200, { 'content-type': 'image/webp' }, IMG);
    if (m.method === 'DELETE') return reply(204, {}, null);
    return reply(404, {}, null);
  } });
  DOC = { key: 'main', enabled: true, apiKey: 'isk_relaytestkey123', keyNodeId: 'pos-relay-1', baseUrl: `${base}/api/image-cloud/relay`, nodes: [] };
  imageCloud.invalidate();
  const r = await diagnose({ req: { headers: { host: new URL(base).host } } });
  assert.equal(r.ok, true, r.summary);
  assert.deepEqual(r.steps.map((s) => s.key), ['config', 'reach', 'health', 'key', 'upload', 'view', 'thumb', 'original', 'delete', 'cloudinary']);
  assert.match(r.steps[0].message, /…y123/); assert.ok(!JSON.stringify(r).includes('isk_relaytestkey123'), 'المفتاح لا يظهر');
  assert.match(r.steps.find((s) => s.key === 'thumb').message, /small\/thumb تُعرض/);
  assert.match(r.steps.find((s) => s.key === 'original').message, /كما يجب/);
  assert.ok(dev.seen.some((m) => m.method === 'DELETE' && m.path.includes('01DIAG')));
  assert.match(r.steps.find((s) => s.key === 'cloudinary').message, /لا روابط Cloudinary/);

  // مفتاح جهاز آخر: يقف عند «مفتاح الرفع» بالسبب، ولا رفع
  DOC = { ...DOC, apiKey: 'isk_otherdevicekey1' }; imageCloud.invalidate();
  const bad = await diagnose({ req: { headers: { host: new URL(base).host } } });
  assert.equal(bad.ok, false);
  assert.match(bad.summary, /يفشل عند «مفتاح الرفع»: المفتاح مرفوض \(401\)/);
  assert.equal(bad.steps.find((s) => s.key === 'upload').ok, null, 'تُخطّى الرفع');

  // لا جهاز متصل: يقف عند «الوصول»
  relay.reset();
  const off = await diagnose({ req: { headers: { host: new URL(base).host } } });
  assert.match(off.summary, /يفشل عند «الوصول»: لا يوجد جهاز صور متصل/);
});

test('التشخيص برابط عام ميت (images… بلا cloudflared): يقول السبب ويكمل عبر النفق إن كان متصلاً', async () => {
  const { diagnose } = require('../services/imageCloudDiagnose');
  DOC = { key: 'main', enabled: false, wantEnabled: true, apiKey: 'isk_relaytestkey123', keyNodeId: 'pos-relay-1', baseUrl: 'https://images.diyar-dead.invalid',
    nodes: [{ nodeId: 'pos-relay-1', name: 'CASHIER', proofHash: sha('SECRET-R') }] };
  imageCloud.invalidate();
  dev = await device('pos-relay-1', 'SECRET-R');
  assert.equal(dev.ok, true);
  const r = await diagnose({ req: { headers: { host: new URL(base).host } } });
  const reach = r.steps.find((s) => s.key === 'reach');
  assert.equal(reach.ok, false);
  assert.match(reach.message, /لا يرد .*لا نفق Cloudflare يعمل عليه.*متصل ويُستخدم تلقائياً/);
  assert.equal(r.steps.find((s) => s.key === 'health').ok, true, 'أكمل عبر النفق');
  assert.equal(r.steps.find((s) => s.key === 'upload').ok, true);
});
