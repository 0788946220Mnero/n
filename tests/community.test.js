/**
 * «الدردشة العامة» لزبائن المنصة + إشراف فريق العمل.
 *  • الملف: اسم ظاهر (بفلترة وأسماء محجوزة)، صورة شخصية (عامة، بلا EXIF، تُستبدل)، وإطار بعدد الطلبات المكتملة.
 *  • الكتابة: الاسم شرط، الفلترة (كلمات/روابط/أرقام)، الوضع البطيء، 10 رسائل/دقيقة، الرد على رسالة، الإبلاغ، حذف رسالتي.
 *  • لا يظهر رقم هاتف أي زبون للزبائن — للمشرف فقط.
 *  • الإشراف: الفلترة (نص/عضو/محذوفة/مبلّغ عنها)، الحذف بسبب والاستعادة، الحظر المؤقت والدائم مع حذف الرسائل،
 *    إزالة الصورة وإعادة تعيين الاسم، النشر باسم الفريق، والإعدادات — وكلها في سجل النشاط.
 *  • /ws/customer حقيقي: رمز الزبون فقط، وعدد المتصلين، والبث.
 *   node --test tests/community.test.js
 */
process.env.JWT_SECRET = 'community-secret-0123456789abcdef01';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

['User', 'PhoneUser', 'CustomerProfile', 'CustomerMedia', 'CommunityMessage', 'CommunitySetting', 'Order', 'ActivityLog', 'SupportThread']
  .forEach((m) => require(`../models/${m}`));
require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);

const rt = require('../services/realtimeService');
const staffSent = [];
const realSendToUsers = rt.sendToUsers;
rt.sendToUsers = (ids, payload) => { staffSent.push({ ids: [...ids].map(String), payload }); return new Set(ids); };
const cr = require('../services/customerRealtime');
const community = require('../controllers/communityController');

let server; let base; const tok = {}; const ids = {};
const call = async (method, url, { token, body, form } = {}) => {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  let payload;
  if (form) payload = form; else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base + url, { method, headers, body: payload });
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), type: ct, cache: r.headers.get('cache-control') };
  return { status: r.status, body: await r.json() };
};
function fakeJpeg(tag = 'GPS-SECRET') {
  const seg = (marker, data) => Buffer.concat([Buffer.from([0xff, marker]), Buffer.from([((data.length + 2) >> 8) & 255, (data.length + 2) & 255]), data]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary')), seg(0xe1, Buffer.from(`Exif\0\0${tag}`, 'binary')),
    seg(0xc0, Buffer.from([8, 0, 0x80, 0, 0x80, 1, 1, 0x11, 0])), Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0x55, 0xff, 0xd9])]);
}
const fileForm = (buf, type = 'image/jpeg') => { const f = new FormData(); f.append('file', new Blob([buf], { type }), 'a.jpg'); return f; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const setSlow = async (n) => { await call('PUT', '/api/community/admin/settings', { token: tok.admin, body: { slowModeSeconds: n } }); };

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/community', require('../routes/communityRoutes'));
  app.use(require('../middlewares/errorHandler').errorHandler);
  server = http.createServer(app);
  rt.init(server); // /ws للطاقم + تسجيل /ws/customer على نفس الخادم
  cr.start();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const staff = async (k, role, permissions = []) => {
    const u = await M('User').create({ name: k, username: k, password: 'x'.repeat(20), role, isActive: true, permissions });
    ids[k] = String(u._id); tok[k] = jwt.sign({ id: ids[k] }, process.env.JWT_SECRET);
  };
  await staff('admin', 'admin'); await staff('sami', 'cashier'); await staff('nour', 'employee'); await staff('watch', 'observer');
  const cust = async (k, phone) => {
    const u = await M('PhoneUser').create({ phone, isPhoneVerified: true });
    ids[k] = String(u._id); tok[k] = jwt.sign({ id: ids[k], type: 'customer' }, process.env.JWT_SECRET);
  };
  await cust('ali', '+962791112233'); await cust('huda', '+962795556677'); await cust('omar', '+962790000003');
  for (let i = 0; i < 16; i++) await M('Order').create({ orderNumber: `A${i}`, phone: i % 2 ? '0791112233' : '+962791112233', status: i < 15 ? 'delivered' : 'cancelled', total: 5, items: [] });
  await M('Order').create({ orderNumber: 'H1', phone: '0795556677', status: 'delivered', total: 5, items: [] });
});
test.after(() => { rt.sendToUsers = realSendToUsers; server && server.close(); });

test('الصلاحية: الإشراف للكاشير والمدير ومدير النظام، لا للموظف ولا للمراقب', async () => {
  const { ROLE_PERMISSIONS } = require('../utils/permissions');
  assert.ok(ROLE_PERMISSIONS.cashier.includes('community:moderate'));
  assert.ok(ROLE_PERMISSIONS.manager.includes('community:moderate'));
  assert.ok(!ROLE_PERMISSIONS.employee.includes('community:moderate'));
  assert.equal((await call('GET', '/api/community/admin/messages', { token: tok.nour })).status, 403);
  assert.equal((await call('GET', '/api/community/admin/messages', { token: tok.watch })).status, 403);
  assert.equal((await call('GET', '/api/community/admin/messages', { token: tok.sami })).status, 200);
  assert.equal((await call('GET', '/api/community/messages')).status, 401, 'القراءة للزبون المسجّل');
  assert.equal((await call('GET', '/api/community/messages', { token: tok.sami })).status, 401, 'رمز الطاقم لا يصلح');
});

test('الملف: عدد الطلبات المكتملة يحدد الإطار، والاسم مفلتر', async () => {
  const me = await call('GET', '/api/community/me', { token: tok.ali });
  assert.equal(me.status, 200);
  assert.equal(me.body.profile.orderCount, 15, 'المكتملة فقط وبالصيغتين');
  assert.equal(me.body.profile.tier.key, 'gold'); assert.equal(me.body.profile.tier.next.remaining, 15);
  assert.equal(me.body.profile.displayName, '');
  assert.equal((await call('GET', '/api/community/me', { token: tok.huda })).body.profile.tier.key, 'bronze');
  assert.equal((await call('GET', '/api/community/me', { token: tok.omar })).body.profile.tier.key, 'new');
  for (const bad of ['a', '0791234567', 'فريق ديار الأنباط', 'زوروا x.com']) {
    const r = await call('PUT', '/api/community/me', { token: tok.ali, body: { displayName: bad } });
    assert.ok([400, 422].includes(r.status), `مرفوض: ${bad}`);
  }
  assert.equal((await call('PUT', '/api/community/me', { token: tok.ali, body: { displayName: '  أبو   أحمد ' } })).body.profile.displayName, 'أبو أحمد');
  await call('PUT', '/api/community/me', { token: tok.huda, body: { displayName: 'هدى' } });
});

test('الصورة الشخصية: عامة داخل الدردشة، بلا EXIF، والاستبدال يحذف القديمة', async () => {
  assert.equal((await call('POST', '/api/community/me/avatar', { token: tok.ali, form: fileForm(Buffer.from('<svg onload=alert(1)>'), 'image/svg+xml') })).status, 415);
  const up = await call('POST', '/api/community/me/avatar', { token: tok.ali, form: fileForm(fakeJpeg()) });
  assert.equal(up.status, 201);
  const url1 = up.body.profile.avatar;
  assert.match(url1, /^\/api\/community\/avatar\/[a-f0-9]{24}$/);
  const img = await call('GET', url1);
  assert.equal(img.status, 200); assert.equal(img.type, 'image/jpeg');
  assert.ok(!img.buf.includes(Buffer.from('GPS-SECRET')), 'أُزيلت بيانات الموقع');
  assert.match(img.cache, /immutable/);
  const up2 = await call('POST', '/api/community/me/avatar', { token: tok.ali, form: fileForm(fakeJpeg('X2')) });
  assert.notEqual(up2.body.profile.avatar, url1);
  assert.equal((await call('GET', url1)).status, 404, 'القديمة حُذفت');
});

test('الكتابة: الاسم شرط، ولا يظهر رقم الهاتف لأحد', async () => {
  await setSlow(0);
  const no = await call('POST', '/api/community/messages', { token: tok.omar, body: { text: 'مرحبا' } });
  assert.equal(no.status, 409); assert.equal(no.body.code, 'NEED_NAME');
  staffSent.length = 0;
  const r = await call('POST', '/api/community/messages', { token: tok.ali, body: { text: 'الشاورما اليوم ممتازة 👌' } });
  assert.equal(r.status, 201);
  const a = r.body.message.author;
  assert.equal(a.name, 'أبو أحمد'); assert.equal(a.orderCount, 15); assert.equal(a.tier.key, 'gold'); assert.match(a.avatar, /avatar/);
  const list = await call('GET', '/api/community/messages', { token: tok.huda });
  assert.ok(!JSON.stringify(list.body.messages).includes('0791112233') && !JSON.stringify(list.body.messages).includes('791112233'), 'لا رقم للزبائن');
  const toMods = staffSent.find((x) => x.payload.type === 'community.message');
  assert.ok(toMods && toMods.payload.message.phone === '0791112233', 'المشرف يرى الرقم');
  assert.ok(toMods.ids.includes(ids.sami) && toMods.ids.includes(ids.admin) && !toMods.ids.includes(ids.nour), 'للمشرفين فقط');
});

test('الفلترة: كلمات ممنوعة (مع التحايل) وروابط وأرقام', async () => {
  await call('PUT', '/api/community/admin/settings', { token: tok.sami, body: { blockedWords: 'حمار\nسخيف، تافه' } });
  for (const [text, reason] of [['انت حــمـااار', 'words'], ['كلام س.خ.ي.ف', 'words'], ['خصم على www.spam.top', 'link'], ['كلموني ٠٧٩ ١٢٣ ٤٥٦٧', 'phone']]) {
    const r = await call('POST', '/api/community/messages', { token: tok.huda, body: { text } });
    assert.equal(r.status, 422, text); assert.equal(r.body.reason, reason);
  }
  assert.equal((await call('POST', '/api/community/messages', { token: tok.huda, body: { text: 'السعر 3.50 والوجبة 2 ساندويش' } })).status, 201, 'الأسعار والأعداد مسموحة');
  await call('PUT', '/api/community/admin/settings', { token: tok.sami, body: { blockLinks: false } });
  assert.equal((await call('POST', '/api/community/messages', { token: tok.huda, body: { text: 'شوفوا diyaralanbat.com' } })).status, 201, 'بعد السماح بالروابط');
});

test('الوضع البطيء و10 رسائل في الدقيقة', async () => {
  await setSlow(30);
  const r = await call('POST', '/api/community/messages', { token: tok.huda, body: { text: 'سريعة' } });
  assert.equal(r.status, 429); assert.equal(r.body.code, 'SLOW'); assert.ok(r.body.retryAfter > 0);
  await setSlow(0);
  const u = await M('PhoneUser').create({ phone: '+962790000099', isPhoneVerified: true });
  const t = jwt.sign({ id: String(u._id), type: 'customer' }, process.env.JWT_SECRET);
  await call('PUT', '/api/community/me', { token: t, body: { displayName: 'مستعجل' } });
  let last;
  for (let i = 0; i < 11; i++) last = await call('POST', '/api/community/messages', { token: t, body: { text: `رسالة ${i}` } });
  assert.equal(last.status, 429); assert.equal(last.body.code, 'RATE');
});

test('الرد على رسالة، الإبلاغ، وحذف رسالتي', async () => {
  const list = (await call('GET', '/api/community/messages', { token: tok.huda })).body.messages;
  const target = list.find((m) => m.author.name === 'أبو أحمد');
  const r = await call('POST', '/api/community/messages', { token: tok.huda, body: { text: 'متفقة معك', replyTo: target._id } });
  assert.equal(r.body.message.replyTo.name, 'أبو أحمد'); assert.ok(r.body.message.replyTo.text.includes('الشاورما'));
  assert.equal((await call('POST', `/api/community/messages/${target._id}/report`, { token: tok.ali })).status, 400, 'لا يبلّغ عن رسالته');
  assert.equal((await call('POST', `/api/community/messages/${target._id}/report`, { token: tok.huda })).status, 200);
  assert.equal((await call('POST', `/api/community/messages/${target._id}/report`, { token: tok.huda })).body.already, true, 'مرة واحدة');
  assert.equal((await call('DELETE', `/api/community/messages/${target._id}`, { token: tok.huda })).status, 403, 'تحذف رسائلك فقط');
  const mine = await call('POST', '/api/community/messages', { token: tok.huda, body: { text: 'خطأ مطبعي' } });
  assert.equal((await call('DELETE', `/api/community/messages/${mine.body.message._id}`, { token: tok.huda })).status, 200);
  assert.ok(!(await call('GET', '/api/community/messages', { token: tok.ali })).body.messages.some((m) => m._id === mine.body.message._id));
});

test('الإشراف: فلترة العرض، الحذف بسبب، والاستعادة', async () => {
  const rep = await call('GET', '/api/community/admin/messages?show=reported', { token: tok.sami });
  assert.equal(rep.body.messages.length, 1); assert.equal(rep.body.messages[0].reportCount, 1);
  assert.equal(rep.body.stats.reported, 1);
  const q = await call('GET', '/api/community/admin/messages?q=' + encodeURIComponent('الشاورما'), { token: tok.sami });
  assert.equal(q.body.messages.length, 1);
  const prof = q.body.messages[0].profileId;
  const byMember = await call('GET', `/api/community/admin/messages?profile=${prof}`, { token: tok.sami });
  assert.ok(byMember.body.messages.every((m) => m.profileId === prof));
  const id = q.body.messages[0]._id;
  const d = await call('DELETE', `/api/community/admin/messages/${id}`, { token: tok.sami, body: { reason: 'إعلان' } });
  assert.equal(d.status, 200);
  assert.ok(!(await call('GET', '/api/community/messages', { token: tok.huda })).body.messages.some((m) => m._id === id), 'اختفت عن الزبائن');
  const del = await call('GET', '/api/community/admin/messages?show=deleted', { token: tok.sami });
  const dm = del.body.messages.find((m) => m._id === id);
  assert.ok(dm && dm.deletedByName === 'sami' && dm.deletedReason === 'إعلان', 'باقية للمشرف مع السبب');
  assert.ok(del.body.messages.some((m) => m.deletedByOwner), 'ومنها ما حذفه صاحبه');
  const res = await call('POST', `/api/community/admin/messages/${id}/restore`, { token: tok.sami });
  assert.equal(res.status, 200);
  assert.ok((await call('GET', '/api/community/messages', { token: tok.huda })).body.messages.some((m) => m._id === id), 'عادت');
  assert.ok(await M('ActivityLog').findOne({ action: 'community.delete' }).lean());
});

test('النشر باسم فريق العمل', async () => {
  const r = await call('POST', '/api/community/admin/messages', { token: tok.sami, body: { text: 'عرض اليوم: وجبة عائلية بخصم 20%' } });
  assert.equal(r.status, 201);
  const list = (await call('GET', '/api/community/messages', { token: tok.ali })).body.messages;
  const m = list.find((x) => x._id === r.body.message._id);
  assert.ok(m.author.staff && m.author.name === 'فريق ديار الأنباط');
});

test('الحظر: المؤقت ينتهي وحده، والدائم مع حذف رسائله، وفك الحظر', async () => {
  const members = await call('GET', '/api/community/admin/members?q=' + encodeURIComponent('هدى'), { token: tok.sami });
  const huda = members.body.members[0];
  assert.equal(huda.phone, '0795556677');
  const byPhone = await call('GET', '/api/community/admin/members?q=0795556677', { token: tok.sami });
  assert.equal(byPhone.body.members[0].id, huda.id, 'البحث بالرقم');
  const b = await call('POST', `/api/community/admin/members/${huda.id}/ban`, { token: tok.sami, body: { hours: 0, reason: 'إساءة', purge: true } });
  assert.equal(b.status, 200); assert.ok(b.body.purged >= 3); assert.equal(b.body.member.banned, true);
  const p = await call('POST', '/api/community/messages', { token: tok.huda, body: { text: 'مرحبا' } });
  assert.equal(p.status, 403); assert.equal(p.body.code, 'BANNED');
  assert.ok(!(await call('GET', '/api/community/messages', { token: tok.ali })).body.messages.some((m) => m.author.name === 'هدى'), 'رسائلها حُذفت');
  assert.equal((await call('GET', '/api/community/messages', { token: tok.huda })).status, 200, 'تقرأ فقط');
  assert.equal((await call('GET', '/api/community/admin/members?banned=1', { token: tok.sami })).body.members.length, 1);
  await call('DELETE', `/api/community/admin/members/${huda.id}/ban`, { token: tok.sami });
  assert.equal((await call('POST', '/api/community/messages', { token: tok.huda, body: { text: 'رجعت' } })).status, 201);
  // مؤقت منتهٍ
  await M('CustomerProfile').updateOne({ _id: huda.id }, { $set: { communityBan: { banned: true, until: new Date(Date.now() - 1000), reason: 'x' } } });
  assert.equal((await call('POST', '/api/community/messages', { token: tok.huda, body: { text: 'انتهى الإيقاف' } })).status, 201);
});

test('إزالة صورة غير لائقة وإعادة تعيين الاسم', async () => {
  const ali = (await call('GET', '/api/community/admin/members?q=' + encodeURIComponent('أبو'), { token: tok.sami })).body.members[0];
  assert.ok(ali.avatar);
  const r = await call('DELETE', `/api/community/admin/members/${ali.id}/avatar`, { token: tok.sami });
  assert.equal(r.body.member.avatar, '');
  assert.equal((await call('GET', ali.avatar)).status, 404);
  await call('DELETE', `/api/community/admin/members/${ali.id}/name`, { token: tok.sami });
  const p = await call('POST', '/api/community/messages', { token: tok.ali, body: { text: 'مرحبا' } });
  assert.equal(p.body.code, 'NEED_NAME', 'يختار اسماً جديداً');
});

test('إيقاف الدردشة العامة من الإعدادات', async () => {
  await call('PUT', '/api/community/admin/settings', { token: tok.sami, body: { enabled: false } });
  const p = await call('POST', '/api/community/messages', { token: tok.huda, body: { text: 'مرحبا' } });
  assert.equal(p.status, 403); assert.equal(p.body.code, 'DISABLED');
  const l = await call('GET', '/api/community/messages', { token: tok.huda });
  assert.equal(l.body.settings.enabled, false); assert.equal(l.body.messages.length, 0);
  await call('PUT', '/api/community/admin/settings', { token: tok.sami, body: { enabled: true } });
  assert.ok(await M('ActivityLog').findOne({ action: 'community.settings' }).lean());
});

test('/ws/customer حقيقي: رمز الزبون فقط، والبث وعدد المتصلين', async () => {
  const wsUrl = base.replace('http', 'ws') + '/ws/customer?token=';
  const closed = await new Promise((resolve) => { const w = new WebSocket(wsUrl + tok.sami); w.on('close', (code) => resolve(code)); w.on('error', () => {}); });
  assert.equal(closed, 4001, 'رمز الطاقم مرفوض');
  const open = (t) => new Promise((resolve, reject) => {
    const w = new WebSocket(wsUrl + t); const msgs = []; w.msgs = msgs;
    w.on('message', (d) => msgs.push(JSON.parse(String(d))));
    w.on('error', reject);
    const iv = setInterval(() => { if (msgs.some((m) => m.type === 'connected')) { clearInterval(iv); resolve(w); } }, 10);
  });
  const a = await open(tok.ali); const h = await open(tok.huda);
  a.send(JSON.stringify({ type: 'community.join' })); h.send(JSON.stringify({ type: 'community.join' }));
  await wait(1500);
  assert.equal(cr.communityOnline(), 2);
  assert.ok(a.msgs.some((m) => m.type === 'community.online' && m.count === 2));
  await call('PUT', '/api/community/me', { token: tok.ali, body: { displayName: 'علي' } });
  await call('POST', '/api/community/messages', { token: tok.ali, body: { text: 'لحظياً؟' } });
  await wait(150);
  const got = h.msgs.find((m) => m.type === 'community.message' && m.message.text === 'لحظياً؟');
  assert.ok(got, 'وصلت هدى لحظياً'); assert.equal(got.message.author.name, 'علي');
  assert.ok(!JSON.stringify(h.msgs).includes('791112233'), 'بلا رقم');
  assert.equal(cr.sendToCustomer(ids.ali, { type: 'support.typing' }), 1);
  await wait(100);
  assert.ok(a.msgs.some((m) => m.type === 'support.typing'));
  assert.ok(!h.msgs.some((m) => m.type === 'support.typing'), 'لصاحبه وحده');
  a.close(); h.close();
  await wait(1500);
  assert.equal(cr.communityOnline(), 0);
});
