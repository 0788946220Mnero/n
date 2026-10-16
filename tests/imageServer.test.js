/**
 * «Mero Server» المستقل: يقترن برمز من مدير النظام — بلا حساب مستخدم —
 * ثم يستلم الأسرار وينبض ويتصل بالنفق بسرّه وحده.
 *   node --test tests/imageServer.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const WebSocket = require('ws');

const ImageCloud = require('../models/ImageCloud');
let DOC = null;
const clone = (v) => (v ? JSON.parse(JSON.stringify(v)) : null);
ImageCloud.findOne = () => ({ select() { return this; }, lean: async () => clone(DOC) });
ImageCloud.updateOne = async (f, u) => {
  DOC = DOC || { key: 'main', nodes: [] };
  Object.entries(u.$set || {}).forEach(([k, v]) => { DOC[k] = clone(v); });
  if (u.$pull && u.$pull.requests) DOC.requests = (DOC.requests || []).filter((r) => r.nodeId !== u.$pull.requests.nodeId);
  return { modifiedCount: 1 };
};
const users = { ADMIN: { _id: 'u1', name: 'مروان', role: 'admin', permissions: [] }, CASHIER: { _id: 'u2', name: 'سامي', role: 'cashier', permissions: [] } };
require.cache[require.resolve('../middlewares/auth')] = { exports: {
  protect: (req, res, next) => { const t = String(req.headers.authorization || '').replace('Bearer ', ''); if (!users[t]) return res.status(401).json({}); req.user = users[t]; next(); },
} };
const realtime = require('../services/realtimeService');
const sent = [];
realtime.broadcast = (t, p) => sent.push({ t, ...p });
const relay = require('../services/imageRelayService');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

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

const call = async (path, body, token) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const PROOF = 'srv-proof-' + crypto.randomBytes(16).toString('hex');
const NODE = 'imgsrv-office';
let code;

test('رمز الاقتران: لمدير النظام وحده، 8 خانات، صالح 30 دقيقة، وتُحفظ بصمته فقط', async () => {
  DOC = { key: 'main', nodes: [{ nodeId: 'pos-cashier', name: 'CASHIER', lanUrl: 'http://192.168.1.20:7443', proofHash: sha('pos-proof-xxxxxxxxxxxx'), lastSeen: new Date().toISOString() }], requests: [], syncSecret: 'S'.repeat(48), signingSecret: 'G'.repeat(48) };
  assert.equal((await call('/api/image-cloud/pair-codes', {}, 'CASHIER')).status, 403);
  assert.equal((await call('/api/image-cloud/pair-codes', {})).status, 401);
  const r = await call('/api/image-cloud/pair-codes', {}, 'ADMIN');
  assert.equal(r.status, 200);
  assert.match(r.body.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  const left = new Date(r.body.expiresAt).getTime() - Date.now();
  assert.ok(left > 29 * 60000 && left <= 30 * 60000);
  assert.ok(!JSON.stringify(DOC).includes(r.body.code) && !JSON.stringify(DOC).includes(r.body.code.replace('-', '')), 'الرمز لا يُحفظ نصاً');
  code = r.body.code;
});

test('الاقتران بلا حساب: رمز خاطئ يُرفض، والصحيح يُستهلك مرة واحدة', async () => {
  const body = { nodeId: NODE, proofHash: sha(PROOF), name: 'خادم المكتب', machine: 'OFFICE-PC', lanUrl: 'http://192.168.1.30:7443' };
  const bad = await call('/api/image-cloud/nodes/pair', { ...body, code: 'AAAA-AAAA' });
  assert.equal(bad.status, 403); assert.match(bad.body.message, /غير صحيح أو انتهت/);
  const ok = await call('/api/image-cloud/nodes/pair', { ...body, code: code.toLowerCase().replace('-', ' ') }); // كما يكتبه المستخدم
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'approved'); assert.equal(ok.body.approvedBy, 'مروان');
  const again = await call('/api/image-cloud/nodes/pair', { ...body, code });
  assert.equal(again.status, 403, 'الرمز لمرة واحدة');
  assert.ok(sent.some((m) => /اقترن برمز/.test(m.message || '')), 'إشعار لمدير النظام');
});

test('الاستلام بالسر وحده (بلا حساب): الأسرار وقائمة الأجهزة، ويُعلَّم «خادم صور»', async () => {
  const wrong = await call('/api/image-cloud/nodes/claim', { nodeId: NODE, proof: 'not-the-proof-xxxxxxxx', kind: 'server' });
  assert.equal(wrong.status, 403);
  const r = await call('/api/image-cloud/nodes/claim', { nodeId: NODE, proof: PROOF, kind: 'server', name: 'خادم المكتب', lanUrl: 'http://192.168.1.30:7443' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.syncSecret, 'S'.repeat(48));
  assert.deepEqual(r.body.peers, [{ nodeId: 'pos-cashier', url: 'http://192.168.1.20:7443' }], 'يتزامن مع الكاشير');
  assert.match(r.body.relayUrl, /^ws:\/\/.*\/api\/image-cloud\/relay\/ws$/);
  const node = DOC.nodes.find((n) => n.nodeId === NODE);
  assert.equal(node.kind, 'server');
  assert.equal(node.joinedBy, 'مروان');
});

test('النبض بالسر: يُقبل؛ وبسر خاطئ أو بلا سر يُرفض', async () => {
  const ok = await call('/api/image-cloud/nodes/heartbeat', { nodeId: NODE, proof: PROOF, running: true, local: { images: 42, missingFiles: 0, peers: [] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.config, 'يستلم إعدادات النفق');
  assert.equal(DOC.nodes.find((n) => n.nodeId === NODE).images, 42);
  assert.equal((await call('/api/image-cloud/nodes/heartbeat', { nodeId: NODE, proof: 'wrong-proof-xxxxxxxxxx' })).status, 403);
  assert.equal((await call('/api/image-cloud/nodes/heartbeat', { nodeId: NODE })).status, 401);
  assert.equal((await call('/api/image-cloud/nodes/heartbeat', { nodeId: 'pos-cashier', proof: PROOF })).status, 403, 'سر جهاز لا ينفع لجهاز آخر');
});

test('يتصل بالنفق بسرّه ويبث الصور للمنصة', async () => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}${relay.WS_PATH}`);
  const welcome = await new Promise((resolve) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', nodeId: NODE, proof: PROOF })));
    ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.type === 'welcome') resolve(true); });
    ws.on('close', () => resolve(false));
  });
  assert.ok(welcome, 'اتصل بالنفق');
  assert.ok(relay.isConnected(NODE));
  ws.close();
});

test('حساب مستخدم لا يستطيع انتحال الجهاز عبر مسار الجهاز', async () => {
  // بلا Authorization وبلا proof كافٍ ← 401 (لا يصل للمتحكم)
  assert.equal((await call('/api/image-cloud/nodes/key', { nodeId: NODE, proof: 'short' })).status, 401);
});
