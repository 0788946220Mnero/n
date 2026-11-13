/**
 * دردشة الطاقم: محادثات خاصة ومجموعات و«كل الطاقم»، رسائل وصوت وصور، قراءة وحذف، إشعارات،
 * مراجعة مدير النظام، ومكالمات (إشارات WebRTC) عبر WebSocket حقيقي على /ws.
 *   node --test tests/chat.test.js
 */
process.env.JWT_SECRET = 'chat-secret-0123456789abcdef0123';
process.env.VAPID_PUBLIC_KEY = 'BTestPublicKey';
process.env.VAPID_PRIVATE_KEY = 'test-private';
process.env.CHAT_RING_MS = '600';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

['User', 'ActivityLog', 'StaffDevice', 'StaffAlert', 'PresenceSession', 'ChatConversation', 'ChatMessage', 'ChatMedia', 'ChatSetting']
  .forEach((m) => require(`../models/${m}`));
require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);

const pushed = [];
const live = require('../services/liveReportService');
live.webpush = () => ({ sendNotification: async (sub, payload) => { pushed.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }); } });
const chat = require('../services/chatService');
const realtime = require('../services/realtimeService');

let server; let base; const tokens = {}; const ids = {};
const call = async (method, url, { token, body, form } = {}) => {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  let payload;
  if (form) payload = form; else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base + url, { method, headers, body: payload });
  const ct = r.headers.get('content-type') || '';
  let json = null; let buf = null;
  if (ct.includes('json')) json = await r.json(); else buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, body: json, buf, type: ct };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const to = (k) => pushed.filter((p) => p.endpoint === `https://push.example/${k}`);

/** عميل WebSocket كجهاز المستخدم: يجمع ما يصله. */
async function sock(k) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${tokens[k]}`);
  const got = [];
  ws.on('message', (d) => { try { got.push(JSON.parse(String(d))); } catch (_) { /* */ } });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  const until = async (pred, ms = 2000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const f = got.find(pred); if (f) return f; await wait(15); }
    return null;
  };
  await until((m) => m.type === 'connected');
  return { ws, got, until, send: (m) => ws.send(JSON.stringify(m)), close: () => new Promise((r) => { ws.once('close', r); ws.close(); }) };
}

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/chat', require('../routes/chatRoutes'));
  app.use(require('../middlewares/errorHandler').errorHandler);
  server = http.createServer(app);
  realtime.init(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const mk = async (k, role, name, extra = {}) => {
    const u = await M('User').create({ name, username: k, password: 'secret123', role, isActive: true, ...extra });
    ids[k] = String(u._id); tokens[k] = jwt.sign({ id: ids[k] }, process.env.JWT_SECRET);
  };
  await mk('admin', 'admin', 'مروان'); await mk('cashier', 'cashier', 'سامي'); await mk('cashier2', 'cashier', 'رامي');
  await mk('employee', 'employee', 'ليث'); await mk('observer', 'observer', 'المراقب');
  await mk('nocalls', 'cashier', 'هبة', { permissions: ['orders:view', 'chat:use'] }); // صلاحيات مخصّصة: دردشة بلا مكالمات
  await mk('nochat', 'cashier', 'خالد', { permissions: ['orders:view'] });
  for (const k of ['admin', 'cashier', 'cashier2', 'employee']) {
    await M('StaffDevice').create({ user: ids[k], userName: k, role: 'x', endpoint: `https://push.example/${k}`, keys: { p256dh: 'p', auth: 'a' } });
  }
});
test.after(() => { chat._reset(); server.close(); });

let direct;
test('البداية: الزملاء و«كل الطاقم» والإعدادات — ومن لا يملك الدردشة يُرفض', async () => {
  const r = await call('GET', '/api/chat/bootstrap', { token: tokens.cashier });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const names = r.body.users.map((u) => u.name).sort();
  assert.ok(names.includes('مروان') && names.includes('المراقب') && names.includes('هبة'), 'كل الأدوار ومراقب البيانات');
  assert.ok(!names.includes('خالد'), 'من سُحبت منه الدردشة لا يظهر');
  const all = r.body.conversations.find((c) => c.key === 'all');
  assert.ok(all && all.name === 'كل الطاقم' && all.member);
  assert.equal(r.body.canMonitor, false); assert.equal(r.body.canCall, true);
  assert.ok(r.body.ice[0].urls.length, 'خوادم STUN');
  assert.equal((await call('GET', '/api/chat/bootstrap', { token: tokens.admin })).body.canMonitor, true);
  assert.equal((await call('GET', '/api/chat/bootstrap', { token: tokens.nochat })).status, 403);
});

test('محادثة خاصة: الرسالة تصل لحظياً، وغير المقروء، وعلامتا القراءة، وإشعار لمن ليس أمام التطبيق', async () => {
  const o = await call('POST', '/api/chat/conversations/direct', { token: tokens.cashier, body: { userId: ids.cashier2 } });
  assert.equal(o.status, 200); direct = o.body.conversation;
  assert.equal(direct.name, 'رامي', 'اسم المحادثة الخاصة = الطرف الآخر');
  const again = await call('POST', '/api/chat/conversations/direct', { token: tokens.cashier2, body: { userId: ids.cashier } });
  assert.equal(again.body.conversation._id, direct._id, 'محادثة واحدة بين الشخصين');
  assert.ok(!(await call('GET', '/api/chat/conversations', { token: tokens.cashier2 })).body.conversations.some((c) => c._id === direct._id), 'لا تظهر قبل أول رسالة');

  // رامي ليس متصلاً ← إشعار على جهازه
  pushed.length = 0;
  const s1 = await call('POST', `/api/chat/conversations/${direct._id}/messages`, { token: tokens.cashier, body: { text: 'وصلت البضاعة؟' } });
  assert.equal(s1.status, 201);
  await wait(80);
  assert.equal(to('cashier2').length, 1); assert.equal(to('cashier2')[0].title, '💬 سامي'); assert.equal(to('cashier2')[0].body, 'وصلت البضاعة؟');
  assert.equal(to('cashier2')[0].url, `dashboard.html#chat/${direct._id}`);
  assert.equal(to('cashier').length, 0, 'المرسِل لا يُشعَر');

  // رامي فتح التطبيق ← الرسالة تصله لحظياً بلا إشعار دفع
  const r2 = await sock('cashier2');
  pushed.length = 0;
  await call('POST', `/api/chat/conversations/${direct._id}/messages`, { token: tokens.cashier, body: { text: 'رد عليّ', replyTo: s1.body.message._id } });
  const live1 = await r2.until((m) => m.type === 'chat.message' && m.message.text === 'رد عليّ');
  assert.ok(live1, 'وصلت عبر WebSocket'); assert.equal(live1.message.replyTo.text, 'وصلت البضاعة؟', 'الرد على رسالة');
  await wait(60);
  assert.equal(to('cashier2').length, 0, 'التطبيق أمامه: لا إشعار دفع');
  const list = (await call('GET', '/api/chat/conversations', { token: tokens.cashier2 })).body.conversations;
  assert.equal(list.find((c) => c._id === direct._id).unread, 2);
  const s = await sock('cashier');
  assert.equal((await call('POST', `/api/chat/conversations/${direct._id}/read`, { token: tokens.cashier2 })).status, 200);
  assert.ok(await s.until((m) => m.type === 'chat.read' && m.userId === ids.cashier2), 'سامي يرى القراءة (✓✓ زرقاء)');
  assert.equal((await call('GET', '/api/chat/conversations', { token: tokens.cashier2 })).body.conversations.find((c) => c._id === direct._id).unread, 0);
  // «يكتب…»
  s.send({ type: 'chat.typing', conversationId: direct._id });
  assert.ok(await r2.until((m) => m.type === 'chat.typing' && m.name === 'سامي'));
  // غير العضو لا يقرأ
  assert.equal((await call('GET', `/api/chat/conversations/${direct._id}/messages`, { token: tokens.employee })).status, 403);
  await r2.close(); await s.close();
});

test('رسالة صوتية وصورة: محفوظة خلف تسجيل الدخول، للأعضاء ومدير النظام فقط، والملفات المزيفة تُرفض', async () => {
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(3000, 7)]);
  const fd = new FormData();
  fd.append('kind', 'voice'); fd.append('duration', '7.4');
  fd.append('file', new Blob([webm], { type: 'audio/webm' }), 'voice.webm');
  const v = await call('POST', `/api/chat/conversations/${direct._id}/media`, { token: tokens.cashier, form: fd });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  assert.equal(v.body.message.kind, 'voice'); assert.equal(v.body.message.duration, 7.4); assert.equal(v.body.message.mediaMime, 'audio/webm');
  const g = await call('GET', `/api/chat/media/${v.body.message.media}`, { token: tokens.cashier2 });
  assert.equal(g.status, 200); assert.ok(g.buf.equals(webm)); assert.equal(g.type, 'audio/webm');
  assert.equal((await call('GET', `/api/chat/media/${v.body.message.media}`, { token: tokens.employee })).status, 403);
  assert.equal((await call('GET', `/api/chat/media/${v.body.message.media}`, { token: tokens.admin })).status, 200, 'مدير النظام للمراجعة');
  assert.equal((await call('GET', `/api/chat/media/${v.body.message.media}`)).status, 401, 'بلا تسجيل دخول');
  const conv = (await call('GET', '/api/chat/conversations', { token: tokens.cashier2 })).body.conversations.find((c) => c._id === direct._id);
  assert.equal(conv.lastMessage.text, '🎤 رسالة صوتية (0:07)');

  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 1)]);
  const fi = new FormData(); fi.append('kind', 'image'); fi.append('width', '800'); fi.append('height', '600'); fi.append('text', 'فاتورة المورد');
  fi.append('file', new Blob([jpg], { type: 'image/jpeg' }), 'a.jpg');
  const im = await call('POST', `/api/chat/conversations/${direct._id}/media`, { token: tokens.cashier2, form: fi });
  assert.equal(im.status, 201); assert.equal(im.body.message.width, 800); assert.equal(im.body.message.text, 'فاتورة المورد');
  const fake = new FormData(); fake.append('kind', 'image'); fake.append('file', new Blob([Buffer.from('<script>alert(1)</script>')], { type: 'image/jpeg' }), 'x.jpg');
  assert.equal((await call('POST', `/api/chat/conversations/${direct._id}/media`, { token: tokens.cashier, form: fake })).status, 400, 'ملف ليس صورة');
  const big = new FormData(); big.append('kind', 'voice'); big.append('file', new Blob([Buffer.concat([webm, Buffer.alloc(3.2 * 1024 * 1024)])]), 'b.webm');
  assert.equal((await call('POST', `/api/chat/conversations/${direct._id}/media`, { token: tokens.cashier, form: big })).status, 413);
  // مدير النظام يوقف الصوت
  assert.equal((await call('PUT', '/api/chat/admin/settings', { token: tokens.admin, body: { voiceEnabled: false } })).status, 200);
  const fd2 = new FormData(); fd2.append('kind', 'voice'); fd2.append('file', new Blob([webm]), 'v.webm');
  assert.equal((await call('POST', `/api/chat/conversations/${direct._id}/media`, { token: tokens.cashier, form: fd2 })).status, 403);
  await call('PUT', '/api/chat/admin/settings', { token: tokens.admin, body: { voiceEnabled: true } });
});

test('المجموعات: أي مستخدم ينشئ، المشرف يدير، المغادرة، و«كل الطاقم» للجميع حتى المراقب', async () => {
  const g = await call('POST', '/api/chat/conversations/group', { token: tokens.cashier2, body: { name: 'الوردية المسائية', members: [ids.cashier, ids.employee, ids.nochat] } });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const grp = g.body.conversation;
  assert.equal(grp.memberCount, 3, 'من لا يملك الدردشة لا يُضاف');
  assert.deepEqual(grp.admins, [ids.cashier2], 'المنشئ مشرفها');
  const msgs = (await call('GET', `/api/chat/conversations/${grp._id}/messages`, { token: tokens.employee })).body.messages;
  assert.match(msgs[0].text, /أنشأ رامي المجموعة/);
  assert.equal((await call('PATCH', `/api/chat/conversations/${grp._id}`, { token: tokens.cashier, body: { name: 'x' } })).status, 403, 'غير المشرف لا يعدّل');
  assert.equal((await call('PATCH', `/api/chat/conversations/${grp._id}`, { token: tokens.cashier2, body: { add: [ids.admin], remove: [ids.employee] } })).status, 200);
  assert.equal((await call('GET', `/api/chat/conversations/${grp._id}/messages`, { token: tokens.employee })).status, 403, 'أُزيل');
  assert.equal((await call('POST', `/api/chat/conversations/${grp._id}/leave`, { token: tokens.cashier2 })).status, 200);
  const after = await M('ChatConversation').findById(grp._id).lean();
  assert.ok(!after.members.map(String).includes(ids.cashier2));
  assert.equal(after.admins.length, 1, 'المجموعة لا تبقى بلا مشرف');
  // كتم المحادثة: لا إشعار
  await call('PATCH', `/api/chat/conversations/${grp._id}`, { token: tokens.admin, body: { muted: true } });
  pushed.length = 0;
  await call('POST', `/api/chat/conversations/${grp._id}/messages`, { token: tokens.cashier, body: { text: 'تجربة' } });
  await wait(80);
  assert.equal(to('admin').length, 0, 'مكتومة');
  // «كل الطاقم»: المراقب يكتب فيها
  const all = (await call('GET', '/api/chat/conversations', { token: tokens.observer })).body.conversations.find((c) => c.key === 'all');
  pushed.length = 0;
  const ob = await call('POST', `/api/chat/conversations/${all._id}/messages`, { token: tokens.observer, body: { text: 'صباح الخير يا جماعة' } });
  assert.equal(ob.status, 201, 'مراقب البيانات يستعمل الدردشة');
  await wait(80);
  assert.equal(to('cashier').length, 1); assert.equal(to('cashier')[0].title, 'المراقب • كل الطاقم');
  assert.equal((await call('DELETE', `/api/chat/conversations/${all._id}`, { token: tokens.admin })).status, 400, '«كل الطاقم» لا تُحذف');
  assert.equal((await call('PUT', '/api/chat/admin/settings', { token: tokens.observer, body: { callsEnabled: false } })).status, 403);
});

test('مدير النظام يراجع المحادثات الخاصة (ويُسجَّل ذلك) ويحذف؛ الموظف يحذف رسائله فقط', async () => {
  const adm = await call('GET', '/api/chat/admin', { token: tokens.admin });
  assert.equal(adm.status, 200);
  const d = adm.body.conversations.find((c) => c._id === direct._id);
  assert.ok(d && /سامي/.test(d.name) && /رامي/.test(d.name));
  assert.ok(adm.body.stats.media.count >= 2 && adm.body.stats.media.bytes > 0);
  assert.equal((await call('GET', '/api/chat/admin', { token: tokens.cashier })).status, 403);
  const rd = await call('GET', `/api/chat/conversations/${direct._id}/messages`, { token: tokens.admin });
  assert.equal(rd.status, 200); assert.equal(rd.body.monitoring, true);
  await wait(30);
  assert.ok(await M('ActivityLog').findOne({ action: 'chat.monitor', user: ids.admin }).lean(), 'المراجعة في سجل النشاط');
  assert.equal((await call('POST', `/api/chat/conversations/${direct._id}/messages`, { token: tokens.admin, body: { text: 'x' } })).status, 403, 'المراجعة لا تعني الكتابة');
  const first = rd.body.messages.find((m) => m.text === 'وصلت البضاعة؟');
  assert.equal((await call('DELETE', `/api/chat/messages/${first._id}`, { token: tokens.cashier2 })).status, 403);
  const del = await call('DELETE', `/api/chat/messages/${first._id}`, { token: tokens.cashier });
  assert.equal(del.status, 200); assert.equal(del.body.message.deleted, true); assert.equal(del.body.message.text, '');
  const voice = rd.body.messages.find((m) => m.kind === 'voice');
  assert.equal((await call('DELETE', `/api/chat/messages/${voice._id}`, { token: tokens.admin })).status, 200, 'مدير النظام يحذف');
  assert.equal((await call('GET', `/api/chat/media/${voice.media}`, { token: tokens.cashier })).status, 404, 'الوسائط مُسحت');
});

test('مكالمة: رنين ← رد ← إنهاء، والإشارات تمر كما هي، والسجل في المحادثة', async () => {
  const a = await sock('cashier'); const b = await sock('cashier2');
  a.send({ type: 'call.invite', to: ids.cashier2, video: true, sdp: 'v=0 OFFER-SDP' });
  const inc = await b.until((m) => m.type === 'call.incoming');
  assert.ok(inc, 'رنّ عند رامي'); assert.equal(inc.sdp, 'v=0 OFFER-SDP'); assert.equal(inc.from.name, 'سامي'); assert.equal(inc.video, true);
  const ring = await a.until((m) => m.type === 'call.ringing');
  assert.equal(ring.delivered, true);
  b.send({ type: 'call.accept', callId: inc.callId, sdp: 'v=0 ANSWER-SDP' });
  const acc = await a.until((m) => m.type === 'call.accepted');
  assert.equal(acc.sdp, 'v=0 ANSWER-SDP');
  a.send({ type: 'call.ice', callId: inc.callId, candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0' } });
  assert.ok(await b.until((m) => m.type === 'call.ice' && /1\.2\.3\.4/.test(m.candidate.candidate)), 'مرشحات ICE تصل');
  // مشغول: الموظف يتصل برامي أثناء المكالمة
  const e = await sock('employee');
  e.send({ type: 'call.invite', to: ids.cashier2, sdp: 'x' });
  assert.equal((await e.until((m) => m.type === 'call.ended')).reason, 'busy');
  await wait(1100); // أطول من مهلة الرنين: المكالمة الجارية لا تُعدّ فائتة
  b.send({ type: 'call.end', callId: inc.callId });
  const endA = await a.until((m) => m.type === 'call.ended' && m.callId === inc.callId);
  assert.equal(endA.status, 'answered'); assert.ok(endA.duration >= 1);
  await wait(80);
  const last = (await call('GET', `/api/chat/conversations/${direct._id}/messages`, { token: tokens.cashier })).body.messages.pop();
  assert.equal(last.kind, 'call'); assert.equal(last.call.status, 'answered'); assert.equal(last.call.video, true);
  await a.close(); await b.close(); await e.close();
});

test('مكالمة فائتة: إشعار الرنين لمن التطبيق مغلق، يصله الرنين عند فتحه، ثم «فائتة»', async () => {
  const a = await sock('cashier');
  pushed.length = 0;
  a.send({ type: 'call.invite', to: ids.cashier2, video: false, sdp: 'v=0 OFFER' });
  const ring = await a.until((m) => m.type === 'call.ringing');
  assert.equal(ring.delivered, false, 'رامي غير متصل');
  await wait(80);
  assert.ok(to('cashier2').some((p) => p.type === 'chat.call' && p.title === '📞 مكالمة صوتية من سامي'), 'إشعار الاتصال على جهازه');
  const b = await sock('cashier2'); // فتح التطبيق من الإشعار
  assert.ok(await b.until((m) => m.type === 'call.incoming' && m.sdp === 'v=0 OFFER'), 'الرنين يصله فور الاتصال');
  assert.equal((await call('GET', '/api/chat/calls/pending', { token: tokens.cashier2 })).body.calls.length, 1);
  const end = await a.until((m) => m.type === 'call.ended', 2000);
  assert.equal(end.status, 'missed'); assert.equal(end.reason, 'no-answer');
  await wait(80);
  assert.ok(to('cashier2').some((p) => /مكالمة فائتة من سامي/.test(p.title)));
  // رفض
  a.send({ type: 'call.invite', to: ids.cashier2, sdp: 'v=0' });
  const inc = await b.until((m) => m.type === 'call.incoming' && m.callId !== end.callId);
  b.send({ type: 'call.reject', callId: inc.callId });
  assert.equal((await a.until((m) => m.type === 'call.ended' && m.callId === inc.callId)).status, 'rejected');
  await a.close(); await b.close();
});

test('المكالمات: الصلاحية وإعدادات مدير النظام', async () => {
  const h = await sock('nocalls');
  h.send({ type: 'call.invite', to: ids.cashier, sdp: 'x' });
  assert.match((await h.until((m) => m.type === 'call.error')).message, /صلاحية الاتصال/);
  await call('PUT', '/api/chat/admin/settings', { token: tokens.admin, body: { videoEnabled: false } });
  const a = await sock('cashier');
  a.send({ type: 'call.invite', to: ids.cashier2, video: true, sdp: 'x' });
  assert.match((await a.until((m) => m.type === 'call.error')).message, /الفيديو موقوفة/);
  await call('PUT', '/api/chat/admin/settings', { token: tokens.admin, body: { callsEnabled: false, videoEnabled: true } });
  a.got.length = 0;
  a.send({ type: 'call.invite', to: ids.cashier2, sdp: 'x' });
  assert.match((await a.until((m) => m.type === 'call.error')).message, /موقوفة من مدير النظام/);
  await call('PUT', '/api/chat/admin/settings', { token: tokens.admin, body: { callsEnabled: true } });
  await h.close(); await a.close();
});

test('مدة الاحتفاظ: تُمسح الوسائط الأقدم من المدة ويبقى السجل', async () => {
  const conv = await M('ChatConversation').findById(direct._id).lean();
  const old = await M('ChatMedia').create({ kind: 'image', mime: 'image/jpeg', size: 10, data: Buffer.from('xx'), conversation: conv._id, uploader: ids.cashier });
  await M('ChatMedia').updateOne({ _id: old._id }, { $set: { createdAt: new Date(Date.now() - 40 * 86400000) } });
  await call('PUT', '/api/chat/admin/settings', { token: tokens.admin, body: { retentionDays: 30 } });
  assert.ok((await chat.sweepMedia()) >= 1);
  assert.equal((await call('GET', `/api/chat/media/${old._id}`, { token: tokens.cashier })).status, 410);
});
