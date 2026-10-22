/**
 * مركز تزامن الصور: أول جهاز «مراقبة فقط» يصبح المركز تلقائياً، ومدير النظام يختار غيره أو يوقفه،
 * والأجهزة تستلمه مع الانضمام والنبض، والتنبيهات تحسبه، والنفق يخدم الزبائن منه أولاً.
 *   node --test tests/imageHub.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
['ImageCloud', 'User', 'ActivityLog'].forEach((m) => require(`../models/${m}`));
require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);
const nodes = require('../services/imageCloudNodes');
const relay = require('../services/imageRelayService');
const ADMIN = { _id: 'u1', name: 'مروان', role: 'admin' };

const join = (nodeId, kind, extra = {}) => nodes.join(ADMIN, { nodeId, name: nodeId, lanUrl: `http://10.0.0.${nodeId.length}:7443`, kind, ...extra });
const beat = (nodeId, extra = {}) => nodes.heartbeat({ nodeId, running: true, ...extra }, () => {});

test('بلا جهاز مراقبة: لا مركز (كل جهاز مع كل جهاز كما كان)', async () => {
  const a = await join('pos-a', 'pos');
  const b = await join('pos-b', 'pos');
  assert.equal(a.hub, ''); assert.equal(b.hub, '');
  assert.equal((await beat('pos-a')).hub, '');
});

test('جهاز «مراقبة فقط» ينضم ← يصبح المركز تلقائياً، ويستلمه الجميع', async () => {
  const m = await join('monitor-office', 'monitor');
  assert.equal(m.hub, 'monitor-office', 'المركز في رد الانضمام');
  assert.equal((await beat('pos-a')).hub, 'monitor-office', 'وفي نبض الأجهزة الأخرى');
  // جهاز كاشير تحوّل لوضع المراقبة (من DiyarPOS) ← النوع يتغيّر، لكن المركز يبقى الأقدم
  await join('pos-c', 'pos');
  const r = await beat('pos-c', { mode: 'monitor' });
  assert.equal(r.hub, 'monitor-office');
  const d = await M('ImageCloud').findOne({ key: 'main' }).lean();
  assert.equal(d.nodes.find((n) => n.nodeId === 'pos-c').kind, 'monitor');
  await beat('pos-c', { mode: 'pos' });
  assert.equal((await M('ImageCloud').findOne({ key: 'main' }).lean()).nodes.find((n) => n.nodeId === 'pos-c').kind, 'pos', 'ويعود كاشيراً');
});

test('مدير النظام يختار المركز بنفسه (Mero Server مثلاً) أو يوقفه', async () => {
  await join('mero-office', 'server');
  assert.equal(await nodes.setHub(ADMIN, { mode: 'manual', nodeId: 'mero-office' }), 'mero-office');
  assert.equal((await beat('pos-a')).hub, 'mero-office');
  await assert.rejects(nodes.setHub(ADMIN, { mode: 'manual', nodeId: 'ghost' }), /منضماً/);
  assert.equal(await nodes.setHub(ADMIN, { mode: 'off' }), '');
  assert.equal((await beat('pos-a')).hub, '', 'إيقاف: كل جهاز مع كل جهاز');
  assert.equal(await nodes.setHub(ADMIN, { mode: 'auto' }), 'monitor-office', 'تلقائي: جهاز المراقبة');
  // حُذف المركز المختار ← لا مركز (لا يبقى معلّقاً على جهاز غير موجود)
  await nodes.setHub(ADMIN, { mode: 'manual', nodeId: 'pos-b' });
  await nodes.remove('pos-b');
  assert.equal(nodes.hubOf(await M('ImageCloud').findOne({ key: 'main' }).lean()), '');
  await nodes.setHub(ADMIN, { mode: 'auto' });
});

test('التنبيهات بمركز: الجهاز العادي يكفيه المركز — لا «لا يتصل بـ» لبقية الأجهزة', async () => {
  const now = new Date();
  const all = [
    { nodeId: 'monitor-office', name: 'المركز', lastSeen: now, running: true, peers: [] },
    { nodeId: 'pos-a', name: 'كاشير 1', lastSeen: now, running: true, peers: [{ nodeId: 'monitor-office', connected: true }, { nodeId: 'pos-c', connected: false }] },
    { nodeId: 'pos-c', name: 'كاشير 2', lastSeen: now, running: true, peers: [{ nodeId: 'monitor-office', connected: false }, { nodeId: 'pos-a', connected: false }] },
  ];
  assert.equal(nodes.issueOf(all[1], all, Date.now(), 'monitor-office'), '', 'كاشير 1 يصل المركز: سليم');
  assert.match(nodes.issueOf(all[2], all, Date.now(), 'monitor-office'), /لا يصل لمركز التزامن المركز/);
  assert.match(nodes.issueOf(all[1], all, Date.now(), ''), /لا يتصل بـ كاشير 2/, 'بلا مركز: القاعدة القديمة كما هي');
});

test('النفق يخدم الزبائن من المركز أولاً («يبث»)، وإلا من صاحب المفتاح', async () => {
  const seen = [];
  const orig = relay.setPreferred;
  relay.setPreferred = (id) => { seen.push(id); orig(id); };
  const svc = require('../services/imageCloudService');
  await M('ImageCloud').updateOne({ key: 'main' }, { $set: { enabled: true, baseUrl: 'https://x/api/image-cloud/relay', keyNodeId: 'pos-a' } });
  svc.invalidate(); await svc.activeConfig();
  assert.equal(seen.pop(), 'monitor-office');
  await nodes.setHub(ADMIN, { mode: 'off' });
  svc.invalidate(); await svc.activeConfig();
  assert.equal(seen.pop(), 'pos-a', 'بلا مركز: صاحب المفتاح كما كان');
  relay.setPreferred = orig;
});
