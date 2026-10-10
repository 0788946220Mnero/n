// الرسول: إنشاء الأمر وبثّه، الاستلام الذرّي، النتيجة، الأجهزة المتصلة — بلا قاعدة بيانات
const test = require('node:test');
const assert = require('node:assert/strict');
const RelayCommand = require('../models/RelayCommand');
const realtime = require('../services/realtimeService');

const casts = [];
realtime.broadcast = (type, payload) => casts.push({ type, payload });
let DB = new Map(); let seq = 0;
RelayCommand.create = async (d) => { const doc = { _id: 'r' + (++seq), status: 'queued', createdAt: new Date(), ...d }; DB.set(doc._id, doc); return doc; };
RelayCommand.findOneAndUpdate = async (f, u) => {
  const d = DB.get(f._id);
  if (!d) return null;
  if (f.status && d.status !== f.status) return null;
  if (f.expiresAt && !(d.expiresAt > f.expiresAt.$gt)) return null;
  if (f.claimedBy && String(d.claimedBy) !== String(f.claimedBy)) return null;
  if (f.from && String(d.from) !== String(f.from)) return null;
  Object.assign(d, u.$set); return d;
};
RelayCommand.findById = (id) => ({ lean: async () => DB.get(id) || null });

const c = require('../controllers/relayController');
const call = async (fn, user, { params = {}, body = {} } = {}) => {
  const res = { code: 200, body: null, status(x) { this.code = x; return this; }, json(b) { this.body = b; return this; } };
  await c[fn]({ user, params, body, query: {} }, res, () => {});
  return res;
};
const admin = { _id: 'u1', role: 'admin', name: 'مروان' };
const cashier = { _id: 'u2', role: 'cashier', name: 'سامي' };
const cashier2 = { _id: 'u3', role: 'cashier', name: 'محمد' };
const center = { _id: 'u4', role: 'center', name: 'ليان' };

test('إنشاء أمر معروف يُبثّ فوراً، والمجهول يُرفض', async () => {
  let r = await call('create', admin, { body: { action: { type: 'confirm-print', orderId: 'o1' }, text: 'أكد أوردر 2001 واطبعه', summary: 'تأكيد وطباعة 2001' } });
  assert.equal(r.code, 201);
  assert.equal(casts.at(-1).type, 'relay.command');
  assert.equal(casts.at(-1).payload.command.fromName, 'مروان');
  r = await call('create', admin, { body: { action: { type: 'rm -rf' } } });
  assert.equal(r.code, 400);
});

test('الاستلام ذرّي: جهاز واحد فقط ينفّذ', async () => {
  const r = await call('create', admin, { body: { action: { type: 'drawer' } } });
  const id = r.body.command._id;
  const a = await call('claim', cashier, { params: { id }, body: { device: 'DiyarPOS' } });
  const b = await call('claim', cashier2, { params: { id } });
  assert.equal(a.code, 200);
  assert.equal(b.code, 409);
  assert.equal(DB.get(id).claimedByName, 'سامي');
});

test('موظف السنتر لا يستلم أوامر', async () => {
  const r = await call('create', admin, { body: { action: { type: 'drawer' } } });
  assert.equal((await call('claim', center, { params: { id: r.body.command._id } })).code, 403);
});

test('النتيجة من المستلم فقط، وتُبثّ للمرسل', async () => {
  const r = await call('create', admin, { body: { action: { type: 'message', text: 'جهّز طلب 2005' } } });
  const id = r.body.command._id;
  await call('claim', cashier, { params: { id } });
  assert.equal((await call('done', cashier2, { params: { id }, body: { result: 'x' } })).code, 404);
  const d = await call('done', cashier, { params: { id }, body: { status: 'done', result: 'أُعلنت الرسالة' } });
  assert.equal(d.code, 200);
  assert.equal(casts.at(-1).type, 'relay.done');
  assert.equal((await call('getOne', admin, { params: { id } })).body.command.result, 'أُعلنت الرسالة');
});

test('الإلغاء ممكن قبل الاستلام فقط', async () => {
  const r = await call('create', admin, { body: { action: { type: 'drawer' } } });
  const id = r.body.command._id;
  assert.equal((await call('cancel', admin, { params: { id } })).code, 200);
  assert.equal((await call('claim', cashier, { params: { id } })).code, 409);
  const r2 = await call('create', admin, { body: { action: { type: 'drawer' } } });
  await call('claim', cashier, { params: { id: r2.body.command._id } });
  assert.equal((await call('cancel', admin, { params: { id: r2.body.command._id } })).code, 409);
});

test('الأمر المنتهي لا يُستلم', async () => {
  const r = await call('create', admin, { body: { action: { type: 'drawer' } } });
  DB.get(r.body.command._id).expiresAt = new Date(Date.now() - 1000);
  assert.equal((await call('claim', cashier, { params: { id: r.body.command._id } })).code, 409);
});

test('الأجهزة المستقبلة المتصلة', async () => {
  await call('heartbeat', cashier, { body: { deviceId: 'pc1', deviceName: 'DiyarPOS' } });
  let l = await call('listReceivers', admin);
  assert.deepEqual(l.body.data, [{ deviceId: 'pc1', deviceName: 'DiyarPOS', userName: 'سامي' }]);
  await call('heartbeat', cashier, { body: { deviceId: 'pc1', off: true } });
  l = await call('listReceivers', admin);
  assert.equal(l.body.data.length, 0);
  assert.equal((await call('heartbeat', center, { body: { deviceId: 'x' } })).code, 403);
});
