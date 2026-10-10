/*
  التقرير الحي على شاشة القفل — بلا قاعدة بيانات ولا شبكة:
  تُستبدل النماذج ومكتبة web-push بنسخ وهمية.
*/
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.VAPID_PUBLIC_KEY = 'BPUB';
process.env.VAPID_PRIVATE_KEY = 'PRIV';
process.env.LIVE_REPORT_DEBOUNCE_MS = '40';

// ── web-push وهمي ──
const sent = [];
let failFor = new Map(); // endpoint → statusCode
require.cache[require.resolve('web-push')] = {
  exports: {
    setVapidDetails() {},
    async sendNotification(sub, payload, opts) {
      if (failFor.has(sub.endpoint)) { const e = new Error('gone'); e.statusCode = failFor.get(sub.endpoint); throw e; }
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), opts });
    },
  },
};

// ── النماذج والملخص ──
const LiveReportSub = require('../models/LiveReportSub');
const User = require('../models/User');
const ShiftSession = require('../models/ShiftSession');
const orderController = require('../controllers/orderController');

let SUBS = [];
const deleted = [];
LiveReportSub.find = (f = {}) => ({ lean: async () => SUBS.filter((s) => !f.user || String(s.user) === String(f.user)) });
LiveReportSub.updateOne = async () => ({});
LiveReportSub.deleteOne = async (f) => { deleted.push(f); SUBS = SUBS.filter((s) => String(s._id) !== String(f._id)); };
let USERS = [];
User.find = () => ({ lean: async () => USERS });
let OPEN = [];
ShiftSession.find = () => ({ select() { return this; }, sort() { return this; }, lean: async () => OPEN });
let SUMMARY = { successTotal: 245.5, expensesTotal: 12 };
orderController.shiftSummaryFor = async () => SUMMARY;

const live = require('../services/liveReportService');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function reset() {
  sent.length = 0; deleted.length = 0; failFor = new Map();
  SUBS = [
    { _id: 's1', user: 'u1', endpoint: 'https://push.apple.com/a', keys: { p256dh: 'k', auth: 'a' } },
    { _id: 's2', user: 'u2', endpoint: 'https://push.apple.com/b', keys: { p256dh: 'k', auth: 'a' } },
  ];
  USERS = [
    { _id: 'u1', role: 'admin', isActive: true, permissions: [] },
    { _id: 'u2', role: 'cashier', isActive: true, permissions: ['orders:view', 'stats:live'] },
  ];
  OPEN = [{ userName: 'سامي أحمد' }, { userName: 'مروان' }, { userName: 'مروان' }];
  SUMMARY = { successTotal: 245.5, expensesTotal: 12 };
  live._reset();
}

test('نص التقرير: المبيعات والمصروفات ومن جرده مفتوح', async () => {
  reset();
  const r = await live.buildReport();
  assert.equal(r.body, 'المبيعات 245.500 د.أ · المصروفات 12.000 د.أ\nالجرد مفتوح: سامي أحمد، مروان');
  OPEN = [];
  assert.match((await live.buildReport()).body, /لا يوجد جرد مفتوح/);
});

test('يرسل لكل من يملك الصلاحية بوسم واحد يستبدل السابق', async () => {
  reset();
  const n = await live.sendNow();
  assert.equal(n, 2);
  assert.ok(sent.every((x) => x.payload.tag === 'diyar-live' && x.opts.topic === 'diyar-live'));
});

test('لا يرسل إن لم يتغير شيء، ويرسل عند التغيير', async () => {
  reset();
  await live.sendNow();
  sent.length = 0;
  assert.equal(await live.sendNow(), 0);
  SUMMARY = { successTotal: 250, expensesTotal: 12 };
  assert.equal(await live.sendNow(), 2);
});

test('أحداث متلاحقة = إرسال واحد بعد الهدوء', async () => {
  reset();
  for (let i = 0; i < 10; i++) live.touch();
  await wait(120);
  assert.equal(sent.length, 2); // جهازان × مرة واحدة
});

test('من سُحبت صلاحيته أو عُطّل حسابه لا يصله شيء', async () => {
  reset();
  USERS[1].permissions = ['orders:view'];
  await live.sendNow();
  assert.deepEqual(sent.map((x) => x.endpoint), ['https://push.apple.com/a']);
  reset();
  USERS[1].isActive = false;
  await live.sendNow();
  assert.equal(sent.length, 1);
});

test('اشتراك ألغاه الجهاز (410) يُحذف تلقائياً', async () => {
  reset();
  failFor.set('https://push.apple.com/b', 410);
  await live.sendNow();
  assert.deepEqual(deleted, [{ _id: 's2' }]);
});

test('بلا مفاتيح VAPID: الميزة معطّلة بهدوء', async () => {
  reset();
  const pub = process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PUBLIC_KEY;
  assert.equal(live.enabled(), false);
  assert.equal(await live.sendNow(), 0);
  live.touch();
  await wait(80);
  assert.equal(sent.length, 0);
  process.env.VAPID_PUBLIC_KEY = pub;
});

test('صلاحية stats:live: لمدير النظام افتراضياً، لا للمدير، وتُمنح لغيره', () => {
  const { effectivePermissionsFor } = require('../utils/permissions');
  assert.ok(effectivePermissionsFor({ role: 'admin' }).includes('stats:live'));
  assert.ok(!effectivePermissionsFor({ role: 'manager', permissions: [] }).includes('stats:live'));
  assert.ok(effectivePermissionsFor({ role: 'cashier', permissions: ['stats:live'] }).includes('stats:live'));
  assert.ok(effectivePermissionsFor({ role: 'admin' }).includes('voice:commands'));
  assert.ok(!effectivePermissionsFor({ role: 'manager', permissions: [] }).includes('voice:commands'));
});
