/**
 * التنبيه القوي:
 *  • رسالة زبون ← إشعار دفع (شاشة القفل) لأجهزة الطاقم الذين اللوحة ليست أمامهم:
 *    للمسؤول وحده إن كانت المحادثة معيّنة، وإلا لكل من يملك «رسائل الزبائن».
 *  • مكالمة واردة ← إشعار الرنين يتكرر (الوسم نفسه) حتى الرد، ثم يُستبدل بـ«تم الرد» — ولا يتكرر بعد الرد.
 *   node --test tests/strongAlerts.test.js
 */
process.env.JWT_SECRET = 'strong-alerts-secret-0123456789abcd';
process.env.CHAT_RING_PUSH_MS = '120';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

['User', 'PhoneUser', 'SupportThread', 'SupportMessage', 'SupportSetting', 'CustomerMedia', 'CustomerProfile', 'Order', 'Setting', 'ActivityLog',
  'Customer', 'PushSubscriber', 'StaffDevice', 'StaffAlert', 'ChatConversation', 'ChatMessage', 'ChatMedia', 'ChatSetting'].forEach((m) => require(`../models/${m}`));
require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);

// إشعارات الدفع: نلتقط ما يُرسل لأي جهاز
const live = require('../services/liveReportService');
live.enabled = () => true;
const alerts = require('../services/staffAlertService');
const pushed = [];
alerts.pushTo = async (devices, p) => { pushed.push({ users: devices.map((d) => String(d.user)), ...p }); return { sent: devices.length, failed: 0 }; };
const rt = require('../services/realtimeService');
const visible = new Set();
rt.isVisible = (id) => visible.has(String(id));
rt.sendToUsers = (ids) => new Set(ids || []);
rt.send = () => true;
require('../services/customerRealtime').sendToCustomer = () => 0;

let server; let base; const tok = {}; const ids = {};
const call = async (method, url, { token, body } = {}) => {
  const r = await fetch(base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const device = (k, n = 1) => M('StaffDevice').create({ user: ids[k], userName: k, endpoint: `https://push.example/${k}/${n}`, keys: { p256dh: 'p', auth: 'a' } });

test.before(async () => {
  const app = express(); app.use(express.json());
  app.use('/api/support', require('../routes/supportRoutes'));
  server = http.createServer(app); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [k, role] of [['admin', 'admin'], ['sami', 'cashier'], ['rami', 'cashier'], ['nour', 'employee']]) {
    const u = await M('User').create({ name: k, username: k, password: 'x'.repeat(20), role, isActive: true, permissions: [] });
    ids[k] = String(u._id); tok[k] = jwt.sign({ id: ids[k] }, process.env.JWT_SECRET);
    await device(k);
  }
  const c = await M('PhoneUser').create({ phone: '+962791112233', isPhoneVerified: true });
  tok.ali = jwt.sign({ id: String(c._id), type: 'customer' }, process.env.JWT_SECRET);
});
test.after(() => server && server.close());

test('رسالة زبون: إشعار لشاشة القفل لكل من يرد — إلا من اللوحة أمامه، ولا للموظف بلا صلاحية', async () => {
  visible.add(ids.rami); // رامي يرى اللوحة الآن: يكفيه التنبيه داخلها
  pushed.length = 0;
  await call('POST', '/api/support/me/messages', { token: tok.ali, body: { text: 'هل الطلب جاهز؟', name: 'علي' } });
  await wait(50);
  assert.equal(pushed.length, 1);
  const p = pushed[0];
  assert.equal(p.type, 'support.message');
  assert.match(p.title, /رسالة من زبون: علي/);
  assert.equal(p.body, 'هل الطلب جاهز؟');
  assert.match(p.url, /^dashboard\.html#support\/[a-f0-9]{24}$/);
  assert.match(p.tag, /^diyar-support-/);
  assert.deepEqual(p.users.sort(), [ids.admin, ids.sami].sort(), 'مدير النظام والكاشير سامي — لا رامي (أمامه) ولا نور (بلا صلاحية)');
  visible.clear();
});

test('المحادثة المعيّنة: الإشعار للمسؤول وحده', async () => {
  const t = (await call('GET', '/api/support/threads', { token: tok.sami })).body.threads[0];
  await call('PATCH', `/api/support/threads/${t._id}`, { token: tok.sami, body: { assign: ids.rami } });
  pushed.length = 0;
  await call('POST', '/api/support/me/messages', { token: tok.ali, body: { text: 'ننتظر' } });
  await wait(50);
  assert.equal(pushed.length, 1);
  assert.deepEqual(pushed[0].users, [ids.rami]);
});

test('المكالمة: الرنين على شاشة القفل يتكرر حتى الرد، ثم «تم الرد» ولا تكرار بعده', async () => {
  const chat = require('../services/chatService');
  const conv = await chat.directWith(ids.sami, ids.rami);
  pushed.length = 0;
  const caller = { userId: ids.sami, name: 'sami', role: 'cashier', perms: ['chat:use', 'chat:calls'], socket: { readyState: 1, send() {} } };
  const callee = { userId: ids.rami, name: 'rami', role: 'cashier', perms: ['chat:use', 'chat:calls'], socket: { readyState: 1, send() {} } };
  await chat.onSocket(caller, { type: 'call.invite', to: ids.rami, conversationId: String(conv._id), video: false, sdp: 'v=0 offer' });
  await wait(420);
  const rings = pushed.filter((p) => p.type === 'chat.call');
  assert.ok(rings.length >= 3, `تكرّر الرنين ${rings.length} مرات خلال 0.4 ثانية (كل 120ms في الاختبار)`);
  assert.ok(rings.every((p) => p.users.length === 1 && p.users[0] === ids.rami && /مكالمة صوتية من sami/.test(p.title)));
  assert.equal(new Set(rings.map((p) => p.tag)).size, 1, 'الوسم نفسه: يحل محل السابق ويرن مجدداً');
  const callId = rings[0].tag.replace('diyar-call-', '');
  await chat.onSocket(callee, { type: 'call.accept', callId, sdp: 'v=0 answer' });
  await wait(50);
  const end = pushed.find((p) => p.type === 'chat.call.end');
  assert.ok(end && end.tag === rings[0].tag && /تم الرد/.test(end.body), 'استُبدل الرنين بـ«تم الرد على المكالمة»');
  const after = pushed.length;
  await wait(400);
  assert.equal(pushed.length, after, 'لا رنين بعد الرد');
  await chat.onSocket(caller, { type: 'call.end', callId });
});

test('المكالمة واللوحة أمام المتصَل به: لا إشعار دفع (يرن داخل اللوحة)', async () => {
  const chat = require('../services/chatService');
  const conv = await chat.directWith(ids.sami, ids.rami);
  visible.add(ids.rami);
  pushed.length = 0;
  const caller = { userId: ids.sami, name: 'sami', role: 'cashier', perms: ['chat:use', 'chat:calls'], socket: { readyState: 1, send() {} } };
  await chat.onSocket(caller, { type: 'call.invite', to: ids.rami, conversationId: String(conv._id), video: true, sdp: 'v=0 offer' });
  await wait(300);
  assert.equal(pushed.filter((p) => p.type === 'chat.call').length, 0);
  const callId = [...chat._calls.keys()][0];
  await chat.onSocket(caller, { type: 'call.cancel', callId });
  visible.clear();
});
