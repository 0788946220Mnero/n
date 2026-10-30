/**
 * تطويرات «تواصل مع فريق العمل»:
 *  علامتا القراءة، «يكتب…»، الرد التلقائي خارج الدوام، الأسئلة السريعة، إرفاق طلب، الصور (بلا EXIF)،
 *  التعيين التلقائي واليدوي، الوسوم، الملاحظات الداخلية (لا تصل الزبون)، حذف رسالة، مؤشرات سرعة الرد،
 *  الإعدادات (لمن يملك إعدادات المطعم)، ومدة الاحتفاظ.
 *   node --test tests/supportPro.test.js
 */
process.env.JWT_SECRET = 'support-pro-secret-0123456789abcdef';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

['User', 'PhoneUser', 'SupportThread', 'SupportMessage', 'SupportSetting', 'CustomerMedia', 'CustomerProfile', 'Order', 'Setting', 'ActivityLog', 'Customer', 'PushSubscriber']
  .forEach((m) => require(`../models/${m}`));
require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);

const rt = require('../services/realtimeService');
const staffSent = [];
rt.sendToUsers = (ids, payload) => { staffSent.push({ ids: [...ids].map(String), payload }); return new Set(ids); };
const cr = require('../services/customerRealtime');
const custSent = [];
cr.sendToCustomer = (id, payload) => { custSent.push({ id: String(id), payload }); return 1; };
const support = require('../controllers/supportController');

let server; let base; const tok = {}; const ids = {};
const call = async (method, url, { token, body, form } = {}) => {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  let payload;
  if (form) payload = form; else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base + url, { method, headers, body: payload });
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), type: ct };
  return { status: r.status, body: await r.json() };
};

// JPEG صغير مُصنَّع: APP0 + APP1(Exif فيه «إحداثيات») + SOF0 (أبعاد 640×480)
function fakeJpeg() {
  const seg = (marker, data) => Buffer.concat([Buffer.from([0xff, marker]), Buffer.from([((data.length + 2) >> 8) & 255, (data.length + 2) & 255]), data]);
  const app0 = seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary'));
  const app1 = seg(0xe1, Buffer.from('Exif\0\0GPS-LAT-31.95-LON-35.91', 'binary'));
  const sof = seg(0xc0, Buffer.from([8, 0x01, 0xe0, 0x02, 0x80, 1, 1, 0x11, 0]));
  const sos = Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0x12, 0x34, 0xff, 0xd9]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, app1, sof, sos]);
}
const fileForm = (buf, name = 'p.jpg', type = 'image/jpeg', extra = {}) => {
  const f = new FormData(); f.append('file', new Blob([buf], { type }), name);
  Object.entries(extra).forEach(([k, v]) => f.append(k, v));
  return f;
};

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/support', require('../routes/supportRoutes'));
  app.use(require('../middlewares/errorHandler').errorHandler);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const staff = async (k, role, permissions = []) => {
    const u = await M('User').create({ name: k, username: k, password: 'x'.repeat(20), role, isActive: true, permissions });
    ids[k] = String(u._id); tok[k] = jwt.sign({ id: ids[k] }, process.env.JWT_SECRET);
  };
  await staff('admin', 'admin'); await staff('sami', 'cashier'); await staff('rami', 'cashier'); await staff('nour', 'employee');
  const cust = async (k, phone) => {
    const u = await M('PhoneUser').create({ phone, isPhoneVerified: true });
    ids[k] = String(u._id); tok[k] = jwt.sign({ id: ids[k], type: 'customer' }, process.env.JWT_SECRET);
  };
  await cust('ali', '+962791112233'); await cust('huda', '+962795556677');
  // طلبات علي (برقمه المحلي كما تُحفظ) وطلب لهدى
  for (let i = 0; i < 6; i++) await M('Order').create({ orderNumber: `A${i}`, phone: '0791112233', customerName: 'علي', status: i < 5 ? 'delivered' : 'preparing', total: 5 + i, items: [], orderType: 'delivery' });
  const h = await M('Order').create({ orderNumber: 'H1', phone: '0795556677', customerName: 'هدى', status: 'delivered', total: 9, items: [] });
  ids.hudaOrder = String(h._id);
});
test.after(() => server && server.close());

test('الأسئلة السريعة وحالة الدوام تصل للزبون', async () => {
  const r = await call('GET', '/api/support/me', { token: tok.ali });
  assert.equal(r.status, 200);
  assert.ok(r.body.quickQuestions.length >= 3 && r.body.quickQuestions.includes('أين طلبي؟'));
  assert.equal(r.body.open, true, 'بلا إعدادات مطعم: لا نفترض الإغلاق');
});

test('إرفاق طلب: من طلباتي فقط', async () => {
  const mine = await call('GET', '/api/support/me/orders', { token: tok.ali });
  assert.equal(mine.body.orders.length, 6);
  const o = mine.body.orders.find((x) => x.orderNumber === 'A5');
  assert.equal((await call('POST', '/api/support/me/messages', { token: tok.ali, body: { orderId: ids.hudaOrder } })).status, 404, 'طلب زبون آخر');
  staffSent.length = 0;
  const r = await call('POST', '/api/support/me/messages', { token: tok.ali, body: { orderId: o._id, text: 'متى يصل؟', name: 'علي' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.message.kind, 'order'); assert.equal(r.body.message.order.orderNumber, 'A5'); assert.equal(r.body.message.order.status, 'preparing');
  assert.equal(r.body.auto, null, 'الدوام مفتوح: لا رد تلقائي');
  assert.ok(staffSent[0].payload.thread.lastText.includes('طلب #A5'));
  assert.ok(staffSent[0].payload.thread.awaitingSince, 'بدأ انتظار الزبون');
});

test('الملاحظة الداخلية لا تصل الزبون، والرد الأول يُعيِّن المحادثة ويقيس سرعة الرد', async () => {
  const id = (await call('GET', '/api/support/threads', { token: tok.sami })).body.threads[0]._id;
  custSent.length = 0;
  const open = await call('GET', `/api/support/threads/${id}`, { token: tok.sami });
  assert.equal(open.body.card.orderCount, 5, 'بطاقة الزبون: 5 طلبات مكتملة');
  assert.equal(open.body.card.tier.key, 'silver');
  assert.equal(open.body.card.lastOrders.length, 5);
  assert.ok(open.body.thread.staffReadAt, 'قرأها الطاقم');
  assert.ok(custSent.some((x) => x.id === ids.ali && x.payload.type === 'support.read'), '✓✓ تصل الزبون لحظياً');

  const n = await call('POST', `/api/support/threads/${id}/notes`, { token: tok.sami, body: { text: 'زبون دائم — يفضّل الاتصال' } });
  assert.equal(n.status, 201); assert.equal(n.body.message.from, 'note');
  assert.ok(!custSent.some((x) => x.payload.message && x.payload.message.from === 'note'), 'الملاحظة لم تُرسل للزبون');
  const mine = await call('GET', '/api/support/me', { token: tok.ali });
  assert.ok(!mine.body.messages.some((m) => m.from === 'note' || /يفضّل الاتصال/.test(m.text)), 'ولا تظهر في محادثته');

  await new Promise((r) => setTimeout(r, 20));
  custSent.length = 0;
  const rep = await call('POST', `/api/support/threads/${id}/messages`, { token: tok.sami, body: { text: 'يصلك خلال 20 دقيقة' } });
  assert.equal(rep.status, 201);
  assert.ok(rep.body.message.responseMs > 0, 'زمن الرد محسوب');
  assert.equal(rep.body.thread.assignedName, 'sami', 'تعيين تلقائي لأول من رد');
  assert.equal(rep.body.thread.awaitingSince, null);
  const live = custSent.find((x) => x.payload.type === 'support.message');
  assert.ok(live && live.payload.message.text === 'يصلك خلال 20 دقيقة' && live.payload.message.staffUser === undefined, 'الرد لحظياً بلا معرّف الموظف');

  const st = await call('GET', '/api/support/stats', { token: tok.rami });
  assert.equal(st.body.stats.open, 1); assert.equal(st.body.stats.answered7d, 1); assert.equal(st.body.stats.waiting, 0);
  assert.equal(st.body.stats.mine, 0, 'ليست لرامي');
  assert.equal((await call('GET', '/api/support/stats', { token: tok.sami })).body.stats.mine, 1);
});

test('التعيين اليدوي والوسوم والفلاتر', async () => {
  const id = (await call('GET', '/api/support/threads', { token: tok.sami })).body.threads[0]._id;
  assert.equal((await call('PATCH', `/api/support/threads/${id}`, { token: tok.sami, body: { assign: ids.nour } })).status, 400, 'الموظف بلا الصلاحية لا يُعيَّن');
  const a = await call('PATCH', `/api/support/threads/${id}`, { token: tok.sami, body: { assign: ids.rami, tags: ['توصيل', 'مهم', 'غير-موجود'] } });
  assert.equal(a.status, 200); assert.equal(a.body.thread.assignedName, 'rami'); assert.deepEqual(a.body.thread.tags, ['توصيل', 'مهم']);
  assert.equal((await call('GET', '/api/support/threads?status=mine', { token: tok.rami })).body.threads.length, 1);
  assert.equal((await call('GET', '/api/support/threads?status=mine', { token: tok.sami })).body.threads.length, 0);
  assert.equal((await call('GET', '/api/support/threads?tag=' + encodeURIComponent('توصيل'), { token: tok.sami })).body.threads.length, 1);
  assert.equal((await call('GET', '/api/support/threads?tag=' + encodeURIComponent('شكوى'), { token: tok.sami })).body.threads.length, 0);
  await call('PATCH', `/api/support/threads/${id}`, { token: tok.sami, body: { assign: 'none' } });
  assert.equal((await call('GET', '/api/support/threads?status=unassigned', { token: tok.sami })).body.threads.length, 1);
  const agents = await call('GET', '/api/support/agents', { token: tok.sami });
  assert.deepEqual(agents.body.agents.map((x) => x.name).sort(), ['admin', 'rami', 'sami']);
});

test('الصور: بلا بيانات الموقع، ولصاحب المحادثة والطاقم فقط', async () => {
  const jpg = fakeJpeg();
  assert.ok(jpg.includes(Buffer.from('GPS-LAT')));
  assert.equal((await call('POST', '/api/support/me/media', { token: tok.ali, form: fileForm(Buffer.from('not an image at all'), 'x.jpg') })).status, 415, 'ليست صورة');
  const up = await call('POST', '/api/support/me/media', { token: tok.ali, form: fileForm(jpg) });
  assert.equal(up.status, 201); assert.equal(up.body.message.kind, 'image');
  assert.equal(up.body.message.width, 640); assert.equal(up.body.message.height, 480);
  const own = await call('GET', up.body.message.image, { token: tok.ali });
  assert.equal(own.status, 200); assert.equal(own.type, 'image/jpeg');
  assert.ok(!own.buf.includes(Buffer.from('GPS-LAT')), 'أُزيل EXIF');
  assert.ok(own.buf.includes(Buffer.from('JFIF')), 'وبقيت الصورة');
  const mediaId = up.body.message.image.split('/').pop();
  assert.equal((await call('GET', up.body.message.image, { token: tok.huda })).status, 403, 'زبون آخر لا يراها');
  assert.equal((await call('GET', `/api/support/media/${mediaId}`, { token: tok.sami })).status, 200, 'الطاقم يراها');
  assert.equal((await call('GET', `/api/support/media/${mediaId}`, { token: tok.nour })).status, 403);
  // صورة من الطاقم
  const id = (await call('GET', '/api/support/threads', { token: tok.sami })).body.threads[0]._id;
  const s = await call('POST', `/api/support/threads/${id}/media`, { token: tok.sami, form: fileForm(jpg) });
  assert.equal(s.status, 201); assert.equal(s.body.message.kind, 'image');
  const mine = await call('GET', '/api/support/me', { token: tok.ali });
  assert.ok(mine.body.messages.filter((m) => m.kind === 'image').length === 2);
});

test('حذف رسالة: تختفي عن الزبون ويبقى أثرها للطاقم', async () => {
  const id = (await call('GET', '/api/support/threads', { token: tok.sami })).body.threads[0]._id;
  const r = await call('POST', `/api/support/threads/${id}/messages`, { token: tok.sami, body: { text: 'رد بالخطأ' } });
  custSent.length = 0;
  assert.equal((await call('DELETE', `/api/support/messages/${r.body.message._id}`, { token: tok.nour })).status, 403);
  assert.equal((await call('DELETE', `/api/support/messages/${r.body.message._id}`, { token: tok.sami })).status, 200);
  assert.ok(custSent.some((x) => x.payload.type === 'support.delete' && x.payload.id === String(r.body.message._id)), 'يختفي لحظياً عند الزبون');
  const mine = await call('GET', '/api/support/me', { token: tok.ali });
  const d = mine.body.messages.find((m) => String(m._id) === String(r.body.message._id));
  assert.ok(d.deleted && d.text === '', 'نصه لا يصل الزبون');
  const t = await call('GET', `/api/support/threads/${id}`, { token: tok.sami });
  const ds = t.body.messages.find((m) => String(m._id) === String(r.body.message._id));
  assert.ok(ds.deleted && ds.deletedByName === 'sami');
  const log = await M('ActivityLog').findOne({ action: 'support.delete' }).lean();
  assert.ok(log, 'في سجل النشاط');
});

test('الرد التلقائي خارج الدوام — مرة كل 6 ساعات', async () => {
  await M('Setting').create({ restaurantStatus: { mode: 'stopped' } });
  support._reset();
  custSent.length = 0;
  const r1 = await call('POST', '/api/support/me/messages', { token: tok.huda, body: { text: 'مرحبا' } });
  assert.ok(r1.body.auto && r1.body.auto.from === 'system', 'رد تلقائي');
  assert.ok(/خارج ساعات العمل/.test(r1.body.auto.text));
  assert.ok(custSent.some((x) => x.payload.message && x.payload.message.from === 'system'));
  const r2 = await call('POST', '/api/support/me/messages', { token: tok.huda, body: { text: 'هل أنتم موجودون؟' } });
  assert.equal(r2.body.auto, null, 'لا يتكرر');
  const me = await call('GET', '/api/support/me', { token: tok.huda });
  assert.equal(me.body.open, false);
  assert.equal(me.body.messages.filter((m) => m.from === 'system').length, 1);
  await M('Setting').updateOne({}, { $set: { restaurantStatus: { mode: 'open' } } });
});

test('علامة قراءة الزبون تصل الطاقم', async () => {
  staffSent.length = 0;
  const r = await call('POST', '/api/support/me/read', { token: tok.ali });
  assert.equal(r.status, 200);
  assert.ok(staffSent.some((x) => x.payload.type === 'support.seen' && x.payload.at));
});

test('الإعدادات: يقرؤها من يرد، ويحفظها من يملك إعدادات المطعم', async () => {
  const g = await call('GET', '/api/support/settings', { token: tok.sami });
  assert.equal(g.status, 200); assert.ok(g.body.settings.cannedReplies.length >= 3); assert.ok(g.body.tags.includes('شكوى'));
  assert.equal((await call('PUT', '/api/support/settings', { token: tok.sami, body: { autoReplyEnabled: false } })).status, 403, 'الكاشير لا يغيّرها');
  const p = await call('PUT', '/api/support/settings', { token: tok.admin, body: {
    quickQuestions: 'سؤال 1\n\nسؤال 2', cannedReplies: [{ title: 'أهلاً', text: 'أهلاً بك' }, { title: '', text: 'بلا عنوان' }], autoReplyEnabled: false, retentionDays: 30,
  } });
  assert.equal(p.status, 200);
  assert.deepEqual(p.body.settings.quickQuestions, ['سؤال 1', 'سؤال 2']);
  assert.deepEqual(p.body.settings.cannedReplies, [{ title: 'أهلاً', text: 'أهلاً بك' }]);
  assert.equal(p.body.settings.retentionDays, 30);
  const me = await call('GET', '/api/support/me', { token: tok.ali });
  assert.deepEqual(me.body.quickQuestions, ['سؤال 1', 'سؤال 2']);
});

test('مدة الاحتفاظ تحذف الأقدم فقط', async () => {
  const t = await M('SupportThread').findOne({ phone: '+962791112233' }).lean();
  await M('SupportMessage').create({ thread: t._id, from: 'customer', text: 'قديمة جداً', createdAt: new Date(Date.now() - 40 * 24 * 3600 * 1000) });
  const before = await M('SupportMessage').countDocuments({ thread: t._id });
  const out = await support.cleanupOnce();
  assert.equal(out.messages, 1);
  assert.equal(await M('SupportMessage').countDocuments({ thread: t._id }), before - 1);
});

test('«الطاقم يكتب…» يصل صاحب المحادثة وحده', async () => {
  const t = await M('SupportThread').findOne({ phone: '+962791112233' }).lean();
  custSent.length = 0;
  await cr.onStaffSocket({ perms: ['support:reply'] }, { type: 'support.typing', threadId: String(t._id) });
  assert.deepEqual(custSent.map((x) => [x.id, x.payload.type]), [[ids.ali, 'support.typing']]);
  custSent.length = 0;
  await cr.onStaffSocket({ perms: ['chat:use'] }, { type: 'support.typing', threadId: String(t._id) });
  assert.equal(custSent.length, 0, 'بلا الصلاحية لا شيء');
});
