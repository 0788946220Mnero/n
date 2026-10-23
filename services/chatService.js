/*
  ═══════════════════════════════════════════════════════════════
  دردشة الطاقم — «واتساب للعمل» داخل لوحة التحكم.

  • محادثات خاصة (شخصان)، مجموعات (ينشئها أي مستخدم)، و«كل الطاقم» (كل من يملك الدردشة).
  • رسائل: نص، صورة (مضغوطة)، رسالة صوتية، ردّ على رسالة، حذف للجميع، علامات القراءة، «يكتب…».
  • مكالمات صوت/فيديو بين شخصين: WebRTC مباشرة بين الجهازين، والخادم ينقل الإشارات فقط
    (دعوة/قبول/رفض/إنهاء) عبر WebSocket الموجود (/ws). ترنّ 45 ثانية ثم «فائتة».
  • الإشعارات: رسالة أو مكالمة لمن التطبيق ليس أمامه — عبر اشتراك «إشعارات الطاقم» على جهازه.
  • مدير النظام (chat:monitor): يراجع كل المحادثات، ويحذف، ويضبط الإعدادات — والموظفون يعرفون ذلك.
  ═══════════════════════════════════════════════════════════════
*/
const crypto = require('crypto');
const ChatConversation = require('../models/ChatConversation');
const ChatMessage = require('../models/ChatMessage');
const ChatMedia = require('../models/ChatMedia');
const ChatSetting = require('../models/ChatSetting');
const { effectivePermissionsFor, PERSONAL_KEYS } = require('../utils/permissions');

const rt = () => require('./realtimeService');
const can = (u, k) => !!u && (u.perms || effectivePermissionsFor(u)).includes(k);
const nameOf = (u) => (u && (u.name || u.username)) || '';
const idOf = (x) => String((x && x._id) || x);
const ALL = 'all';
const ALL_NAME = 'كل الطاقم';
const RING_MS = Number(process.env.CHAT_RING_MS || 45000);

/* ═════════ الإعدادات ═════════ */
let setCache = null; let setAt = 0;
async function settings() {
  if (setCache && Date.now() - setAt < 30000) return setCache;
  const d = await ChatSetting.findOne({ key: 'settings' }).lean();
  setCache = {
    callsEnabled: d ? d.callsEnabled !== false : true,
    videoEnabled: d ? d.videoEnabled !== false : true,
    voiceEnabled: d ? d.voiceEnabled !== false : true,
    imagesEnabled: d ? d.imagesEnabled !== false : true,
    maxVoiceSec: d && d.maxVoiceSec ? d.maxVoiceSec : 300,
    retentionDays: d && d.retentionDays ? d.retentionDays : 0,
  };
  setAt = Date.now();
  return setCache;
}
async function saveSettings(b) {
  const cur = await settings();
  const next = {
    callsEnabled: b.callsEnabled != null ? !!b.callsEnabled : cur.callsEnabled,
    videoEnabled: b.videoEnabled != null ? !!b.videoEnabled : cur.videoEnabled,
    voiceEnabled: b.voiceEnabled != null ? !!b.voiceEnabled : cur.voiceEnabled,
    imagesEnabled: b.imagesEnabled != null ? !!b.imagesEnabled : cur.imagesEnabled,
    maxVoiceSec: b.maxVoiceSec != null ? Math.max(10, Math.min(900, Math.round(Number(b.maxVoiceSec) || 300))) : cur.maxVoiceSec,
    retentionDays: b.retentionDays != null ? Math.max(0, Math.min(3650, Math.round(Number(b.retentionDays) || 0))) : cur.retentionDays,
  };
  await ChatSetting.findOneAndUpdate({ key: 'settings' }, { $set: next }, { upsert: true, new: true, setDefaultsOnInsert: true });
  setCache = next; setAt = Date.now();
  return next;
}

/* ═════════ المستخدمون والعضوية ═════════ */
let usersCache = null; let usersAt = 0;
/** كل من يملك الدردشة (نشط، وليس حساب مندوب بلا دخول). */
async function chatUsers({ fresh = false } = {}) {
  if (!fresh && usersCache && Date.now() - usersAt < 20000) return usersCache;
  const User = require('../models/User');
  const list = await User.find({ isActive: { $ne: false }, role: { $ne: 'delivery' } }).select('name username role permissions').lean();
  usersCache = list.filter((u) => effectivePermissionsFor(u).includes('chat:use'))
    .map((u) => ({ _id: String(u._id), name: u.name || u.username, role: u.role, calls: effectivePermissionsFor(u).includes('chat:calls') }));
  usersAt = Date.now();
  return usersCache;
}
const invalidateUsers = () => { usersCache = null; };

async function ensureAll() {
  let c = await ChatConversation.findOne({ key: ALL }).lean();
  if (c) return c;
  try {
    c = (await ChatConversation.create({ type: 'group', key: ALL, name: ALL_NAME, createdByName: 'النظام' })).toObject();
  } catch (e) {
    if (e && e.code === 11000) c = await ChatConversation.findOne({ key: ALL }).lean();
    else throw e;
  }
  return c;
}

/** أعضاء المحادثة (معرّفات). «كل الطاقم» = كل من يملك الدردشة. */
async function memberIds(conv) {
  if (conv.key === ALL) return (await chatUsers()).map((u) => u._id);
  return (conv.members || []).map(String);
}
async function isMember(conv, user) {
  if (!conv || conv.deleted) return false;
  if (conv.key === ALL) return can(user, 'chat:use');
  return (conv.members || []).map(String).includes(idOf(user));
}
const canMonitor = (u) => can(u, 'chat:monitor');

/* ═════════ عرض المحادثات والرسائل ═════════ */
const PREVIEW = { image: '📷 صورة', voice: '🎤 رسالة صوتية' };
const mmss = (s) => `${Math.floor((s || 0) / 60)}:${String(Math.round(s || 0) % 60).padStart(2, '0')}`;
function preview(m) {
  if (m.deleted) return 'حُذفت هذه الرسالة';
  if (m.kind === 'text' || m.kind === 'system') return String(m.text || '').slice(0, 120);
  if (m.kind === 'voice') return `${PREVIEW.voice} (${mmss(m.duration)})`;
  if (m.kind === 'image') return m.text ? `${PREVIEW.image}: ${String(m.text).slice(0, 80)}` : PREVIEW.image;
  if (m.kind === 'call') {
    const c = m.call || {};
    const what = c.video ? 'مكالمة فيديو' : 'مكالمة صوتية';
    return c.status === 'answered' ? `📞 ${what} (${mmss(c.duration)})` : c.status === 'busy' ? `📞 ${what} — مشغول` : `📞 ${what} فائتة`;
  }
  return '';
}
function messageOut(m) {
  return {
    _id: String(m._id), conversation: String(m.conversation), sender: m.sender ? String(m.sender) : null, senderName: m.senderName || '',
    kind: m.kind, text: m.deleted ? '' : (m.text || ''), media: m.deleted || !m.media ? null : String(m.media),
    mediaMime: m.deleted ? '' : (m.mediaMime || ''), mediaSize: m.mediaSize || 0, duration: m.duration || 0,
    width: m.width || 0, height: m.height || 0, call: m.call || null, replyTo: m.deleted ? null : (m.replyTo || null),
    deleted: !!m.deleted, deletedByName: m.deletedByName || '', createdAt: m.createdAt,
  };
}

/** ملخص محادثة لمستخدم: الاسم (للخاصة: اسم الطرف الآخر)، غير المقروء، القراءات. */
async function summary(conv, me, userMap) {
  const meId = idOf(me);
  const map = userMap || Object.fromEntries((await chatUsers()).map((u) => [u._id, u]));
  const members = conv.key === ALL ? [] : (conv.members || []).map(String);
  let name = conv.name || '';
  let other = null;
  if (conv.type === 'direct') {
    other = members.find((x) => x !== meId) || members[0] || null;
    const ou = other && map[other];
    name = ou ? ou.name : (conv.name || 'مستخدم');
  }
  const reads = conv.reads || {};
  const myRead = reads[meId] ? new Date(reads[meId]) : new Date(0);
  const unread = await ChatMessage.countDocuments({ conversation: conv._id, createdAt: { $gt: myRead }, sender: { $ne: me._id || meId }, deleted: { $ne: true } });
  const othersRead = {};
  Object.entries(reads).forEach(([k, v]) => { if (k !== meId) othersRead[k] = v; });
  return {
    _id: String(conv._id), type: conv.type, key: conv.key || null, name, other,
    members, memberCount: conv.key === ALL ? Object.keys(map).length : members.length,
    admins: (conv.admins || []).map(String), createdByName: conv.createdByName || '',
    lastMessage: conv.lastMessage || null, lastAt: conv.lastAt, unread,
    muted: (conv.muted || []).map(String).includes(meId), reads: othersRead,
    member: conv.key === ALL ? can(me, 'chat:use') : members.includes(meId),
    deleted: !!conv.deleted,
  };
}

/* ═════════ إرسال رسالة ═════════ */
/**
 * ينشئ الرسالة، يحدّث المحادثة، يبثّها لأعضائها (ولمدير النظام المراقب)، ويُشعر الغائبين.
 * @returns {Promise<object>} الرسالة كما تُعرض
 */
async function post(conv, sender, fields) {
  const now = new Date();
  const msg = await ChatMessage.create({
    conversation: conv._id, sender: sender ? sender._id : null, senderName: sender ? nameOf(sender) : 'النظام', ...fields,
  });
  const m = messageOut(msg.toObject());
  const last = { text: preview(m), kind: m.kind, senderName: m.senderName, sender: m.sender, at: msg.createdAt || now };
  const set = { lastMessage: last, lastAt: msg.createdAt || now };
  if (sender) set[`reads.${idOf(sender)}`] = (msg.createdAt || now).toISOString();
  await ChatConversation.updateOne({ _id: conv._id }, { $set: set });
  const members = await memberIds(conv);
  const payload = { type: 'chat.message', conversationId: String(conv._id), message: m, conversation: { _id: String(conv._id), type: conv.type, key: conv.key || null, name: conv.name || '', members: conv.key === ALL ? [] : members, lastMessage: last, lastAt: last.at } };
  rt().sendToUsers(members, payload);
  rt().sendToUsers(null, payload, (c) => (c.perms || []).includes('chat:monitor') && !members.includes(c.userId));
  if (sender) setImmediate(() => notify(conv, m, sender, members).catch((e) => console.error('chat push:', e.message)));
  return m;
}

/** إشعار دفع لمن التطبيق ليس أمامه (ولم يكتم المحادثة). */
async function notify(conv, m, sender, members) {
  const live = require('./liveReportService');
  if (!live.enabled()) return;
  const muted = new Set((conv.muted || []).map(String));
  const to = members.filter((id) => id !== idOf(sender) && !muted.has(id) && !rt().isVisible(id));
  if (!to.length) return;
  const StaffDevice = require('../models/StaffDevice');
  const devices = await StaffDevice.find({ user: { $in: to } }).lean();
  if (!devices.length) return;
  const group = conv.type === 'group' ? (conv.key === ALL ? ALL_NAME : conv.name) : '';
  await require('./staffAlertService').pushTo(devices, {
    title: group ? `${nameOf(sender)} • ${group}` : `💬 ${nameOf(sender)}`,
    body: preview(m), url: `dashboard.html#chat/${conv._id}`, tag: `diyar-chat-${conv._id}`, type: 'chat.message',
  });
}

/* ═════════ المكالمات (إشارات WebRTC) ═════════ */
const calls = new Map(); // callId → call
const busy = new Map(); // userId → callId
const callOut = (c) => ({ callId: c.id, conversationId: c.conversation, video: c.video, from: { _id: c.from, name: c.fromName }, to: { _id: c.to, name: c.toName }, state: c.state, startedAt: c.startedAt });

function iceServers(userId) {
  const list = [];
  const stun = String(process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302').split(',').map((s) => s.trim()).filter(Boolean);
  if (stun.length) list.push({ urls: stun });
  const turn = String(process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (turn.length) {
    if (process.env.TURN_SECRET) {
      // بيانات مؤقتة (24 ساعة) بطريقة coturn REST — السرّ لا يغادر الخادم
      const username = `${Math.floor(Date.now() / 1000) + 86400}:${userId}`;
      const credential = crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
      list.push({ urls: turn, username, credential });
    } else if (process.env.TURN_USERNAME) {
      list.push({ urls: turn, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL || '' });
    }
  }
  return list;
}

async function directWith(a, b) {
  const ids = [String(a), String(b)].sort();
  const key = `d:${ids.join(':')}`;
  let c = await ChatConversation.findOne({ key }).lean();
  if (c) {
    if (c.deleted) { await ChatConversation.updateOne({ _id: c._id }, { $set: { deleted: false } }); c.deleted = false; }
    return c;
  }
  try {
    c = (await ChatConversation.create({ type: 'direct', key, members: ids })).toObject();
  } catch (e) {
    if (e && e.code === 11000) c = await ChatConversation.findOne({ key }).lean();
    else throw e;
  }
  return c;
}

const sendErr = (client, callId, message) => rt().send(client, { type: 'call.error', callId: callId || null, message });

async function invite(client, m) {
  const st = await settings();
  if (!(client.perms || []).includes('chat:use') || !(client.perms || []).includes('chat:calls')) return sendErr(client, null, 'ليس لديك صلاحية الاتصال');
  if (!st.callsEnabled) return sendErr(client, null, 'المكالمات موقوفة من مدير النظام');
  const video = !!m.video;
  if (video && !st.videoEnabled) return sendErr(client, null, 'مكالمات الفيديو موقوفة — اتصل صوتياً');
  const to = String(m.to || '');
  if (!/^[a-f0-9]{24}$/i.test(to) || to === client.userId) return sendErr(client, null, 'مستخدم غير صالح');
  const sdp = String(m.sdp || '');
  if (!sdp || sdp.length > 60000) return sendErr(client, null, 'وصف الاتصال غير صالح');
  const target = (await chatUsers()).find((u) => u._id === to);
  if (!target) return sendErr(client, null, 'هذا المستخدم لا يملك الدردشة');
  const conv = await directWith(client.userId, to);
  if (busy.has(to) || busy.has(client.userId)) {
    rt().send(client, { type: 'call.ended', callId: null, reason: 'busy', conversationId: String(conv._id) });
    await post(conv, { _id: client.userId, name: client.name }, { kind: 'call', call: { video, status: 'busy', duration: 0 } });
    return null;
  }
  const call = {
    id: crypto.randomUUID(), from: client.userId, fromName: client.name || '', to, toName: target.name,
    conversation: String(conv._id), video, offer: sdp, state: 'ringing', startedAt: Date.now(), answeredAt: 0,
    callerClient: client, calleeClient: null, timer: null, ice: [],
  };
  calls.set(call.id, call); busy.set(call.from, call.id); busy.set(call.to, call.id);
  call.timer = setTimeout(() => finish(call, 'missed', 'no-answer'), RING_MS);
  const got = rt().sendToUsers([to], { type: 'call.incoming', ...callOut(call), sdp });
  rt().send(client, { type: 'call.ringing', ...callOut(call), delivered: got.size > 0 });
  startRingPush(call);
  return call;
}

/* ── الرنين على شاشة القفل: إشعار المكالمة يتكرر كل 6 ثوانٍ (بالوسم نفسه + renotify) طوال الرنين،
      فيرن الهاتف مرة بعد مرة بدل تنبيه واحد يمر — ويتوقف فور الرد أو الرفض أو الإلغاء أو فتح التطبيق. ── */
const RING_PUSH_MS = Number(process.env.CHAT_RING_PUSH_MS || 6000);
async function callDevices(call) {
  const live = require('./liveReportService');
  if (!live.enabled()) return [];
  return require('../models/StaffDevice').find({ user: call.to }).lean();
}
function startRingPush(call) {
  const tick = async () => {
    if (calls.get(call.id) !== call || call.state !== 'ringing') return stopRingPush(call);
    if (rt().isVisible(call.to)) return; // التطبيق أمامه: يرن داخله (شاشة المكالمة)
    try {
      const devices = await callDevices(call);
      if (!devices.length || calls.get(call.id) !== call || call.state !== 'ringing') return;
      call.pushed = true;
      await require('./staffAlertService').pushTo(devices, {
        title: `📞 ${call.video ? 'مكالمة فيديو' : 'مكالمة صوتية'} من ${call.fromName}`, body: 'يرن الآن — اضغط للرد',
        url: `dashboard.html#chat/call/${call.id}`, tag: `diyar-call-${call.id}`, type: 'chat.call',
      });
    } catch (e) { console.error('call push:', e.message); }
  };
  setImmediate(tick);
  call.ringPush = setInterval(tick, RING_PUSH_MS);
  if (call.ringPush.unref) call.ringPush.unref();
}
function stopRingPush(call) { if (call.ringPush) { clearInterval(call.ringPush); call.ringPush = null; } }
/** يُستبدل إشعار الرنين على أجهزة المتصَل به («انتهت») — فلا يبقى يرن بعد الرد من جهاز آخر أو الإلغاء. */
async function endRingPush(call, text) {
  stopRingPush(call);
  if (!call.pushed) return;
  try {
    const devices = await callDevices(call);
    if (devices.length) await require('./staffAlertService').pushTo(devices, { title: `📞 ${call.fromName}`, body: text, url: `dashboard.html#chat/${call.conversation}`, tag: `diyar-call-${call.id}`, type: 'chat.call.end' });
  } catch (e) { console.error('call end push:', e.message); }
}

/** تنتهي المكالمة: تُحذف من الذاكرة ويُسجَّل أثرها في المحادثة. */
async function finish(call, status, reason) {
  if (!calls.has(call.id)) return;
  clearTimeout(call.timer);
  stopRingPush(call);
  if (status === 'rejected') endRingPush(call, 'رُفضت المكالمة');
  calls.delete(call.id);
  if (busy.get(call.from) === call.id) busy.delete(call.from);
  if (busy.get(call.to) === call.id) busy.delete(call.to);
  const duration = call.answeredAt ? Math.round((Date.now() - call.answeredAt) / 1000) : 0;
  const msg = { type: 'call.ended', callId: call.id, reason, status, duration, conversationId: call.conversation };
  rt().sendToUsers([call.from, call.to], msg);
  try {
    const conv = await ChatConversation.findById(call.conversation).lean();
    if (conv) {
      await post(conv, { _id: call.from, name: call.fromName }, { kind: 'call', call: { video: call.video, status, duration } });
      if (status === 'missed' || status === 'rejected') {
        // «مكالمة فائتة» على جهاز من لم يردّ (تحل محل إشعار الرنين)
        const live = require('./liveReportService');
        if (status === 'missed' && live.enabled()) {
          const devices = await require('../models/StaffDevice').find({ user: call.to }).lean();
          await require('./staffAlertService').pushTo(devices, {
            title: `📵 مكالمة فائتة من ${call.fromName}`, body: call.video ? 'مكالمة فيديو' : 'مكالمة صوتية',
            url: `dashboard.html#chat/${call.conversation}`, tag: `diyar-call-${call.id}`, type: 'chat.call',
          });
        }
      }
    }
  } catch (e) { console.error('call log:', e.message); }
}

const otherSide = (call, userId) => (userId === call.from ? call.to : call.from);
function forward(call, fromUserId, payload) {
  const to = otherSide(call, fromUserId);
  // بعد الرد: للجهاز الذي ردّ تحديداً؛ قبله: لكل أجهزة المتصَل به
  if (to === call.to && call.calleeClient) return rt().send(call.calleeClient, payload);
  if (to === call.from && call.callerClient && call.callerClient.socket.readyState === 1) return rt().send(call.callerClient, payload);
  return rt().sendToUsers([to], payload).size > 0;
}

async function onSocket(client, m) {
  if (m.type === 'chat.typing') return typing(client, m);
  if (m.type === 'call.invite') return invite(client, m);
  const call = calls.get(String(m.callId || ''));
  if (!call) return sendErr(client, m.callId, 'انتهت المكالمة');
  const me = client.userId;
  if (me !== call.from && me !== call.to) return null;
  switch (m.type) {
    case 'call.accept': {
      if (me !== call.to || call.state !== 'ringing') return null;
      const sdp = String(m.sdp || '');
      if (!sdp || sdp.length > 60000) return sendErr(client, call.id, 'وصف الاتصال غير صالح');
      clearTimeout(call.timer);
      call.state = 'active'; call.answeredAt = Date.now(); call.calleeClient = client;
      endRingPush(call, 'تم الرد على المكالمة');
      // حد أقصى للمكالمة: 4 ساعات (حماية من مكالمة معلّقة في الذاكرة)
      call.timer = setTimeout(() => finish(call, 'answered', 'limit'), 4 * 3600 * 1000);
      rt().send(call.callerClient, { type: 'call.accepted', callId: call.id, sdp });
      rt().sendToUsers([call.to], { type: 'call.taken', callId: call.id }, (c) => c !== client);
      return null;
    }
    case 'call.reject':
      if (me !== call.to || call.state !== 'ringing') return null;
      return finish(call, 'rejected', 'rejected');
    case 'call.cancel':
      if (me !== call.from || call.state !== 'ringing') return null;
      return finish(call, 'missed', 'cancelled');
    case 'call.end':
      return finish(call, call.state === 'active' ? 'answered' : 'missed', 'hangup');
    case 'call.ice':
      if (!m.candidate || JSON.stringify(m.candidate).length > 4000) return null;
      forward(call, me, { type: 'call.ice', callId: call.id, candidate: m.candidate });
      return null;
    case 'call.media': // الطرف الآخر أطفأ الكاميرا/الميكروفون (للعرض فقط)
      forward(call, me, { type: 'call.media', callId: call.id, video: !!m.video, audio: m.audio !== false });
      return null;
    default:
      return null;
  }
}

/** فتح التطبيق (من إشعار الاتصال مثلاً): مكالمة ترنّ له الآن تصله فوراً. */
function onConnect(client) {
  for (const call of calls.values()) {
    if (call.to === client.userId && call.state === 'ringing') rt().send(client, { type: 'call.incoming', ...callOut(call), sdp: call.offer });
  }
}
/** المتصل أغلق الصفحة أثناء الرنين ← تُلغى. المكالمة الجارية تستمر (الصوت مباشر بين الجهازين). */
function onDisconnect(client) {
  for (const call of calls.values()) {
    if (call.state === 'ringing' && call.callerClient === client) finish(call, 'missed', 'cancelled');
  }
}
function pendingFor(userId) {
  return [...calls.values()].filter((c) => c.to === String(userId) && c.state === 'ringing').map((c) => ({ ...callOut(c), sdp: c.offer }));
}

/* ═════════ «يكتب…» ═════════ */
const typingConv = new Map(); // convId → { members, at }
async function typing(client, m) {
  const id = String(m.conversationId || '');
  if (!/^[a-f0-9]{24}$/i.test(id)) return;
  let ent = typingConv.get(id);
  if (!ent || Date.now() - ent.at > 30000) {
    const conv = await ChatConversation.findById(id).lean();
    if (!conv || !(await isMember(conv, { _id: client.userId, perms: client.perms }))) return;
    ent = { members: await memberIds(conv), at: Date.now() };
    typingConv.set(id, ent);
  }
  if (!ent.members.includes(client.userId)) return;
  rt().sendToUsers(ent.members.filter((x) => x !== client.userId), { type: 'chat.typing', conversationId: id, userId: client.userId, name: client.name || '' });
}

/* ═════════ مدة الاحتفاظ بالوسائط ═════════ */
async function sweepMedia() {
  const st = await settings();
  if (!st.retentionDays) return 0;
  const before = new Date(Date.now() - st.retentionDays * 86400000);
  const r = await ChatMedia.updateMany({ createdAt: { $lt: before }, expired: { $ne: true } }, { $set: { expired: true, data: null } });
  return r.modifiedCount || 0;
}
/* ═════════ ترحيل مرة واحدة: الدردشة لمن لديه «صلاحيات مخصّصة» ═════════
   من حُفظت له صلاحيات مخصّصة قبل إضافة الدردشة لا تشمل chat:use ولا chat:calls،
   فلا يراها وإن كان دوره يملكها. نضيفها له مرة واحدة (ما عدا مدير النظام والمندوب)،
   ثم يتحكم مدير النظام بها كأي صلاحية. العلامة تمنع تكرار الترحيل بعد أي تعديل لاحق. */
async function migratePersonalPermissions() {
  const cur = await ChatSetting.findOne({ key: 'settings' }).lean();
  if (cur && cur.personalPermsMigrated) return 0;
  const User = require('../models/User');
  const users = await User.find({ role: { $ne: 'admin' } }).select('role permissions').lean();
  let changed = 0;
  for (const u of users) {
    const own = Array.isArray(u.permissions) ? u.permissions : [];
    // بلا صلاحيات مخصّصة يرث دوره (وفيه الدردشة)، والمندوب بلا دخول أصلاً
    if (!own.length || u.role === 'delivery') continue;
    const missing = PERSONAL_KEYS.filter((k) => !own.includes(k));
    if (!missing.length) continue;
    await User.updateOne({ _id: u._id }, { $set: { permissions: [...own, ...missing] } });
    changed++;
  }
  await ChatSetting.findOneAndUpdate({ key: 'settings' }, { $set: { personalPermsMigrated: true } }, { upsert: true, setDefaultsOnInsert: true });
  if (changed) console.log(`دردشة الطاقم: أُضيفت صلاحيات الدردشة لـ ${changed} مستخدم بصلاحيات مخصّصة (مرة واحدة)`);
  return changed;
}

let timer = null;
function start() {
  if (timer) return;
  migratePersonalPermissions().catch((e) => console.error('chat permissions migration:', e.message));
  timer = setInterval(() => sweepMedia().catch((e) => console.error('chat media sweep:', e.message)), 6 * 3600 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = {
  _calls: calls, RING_PUSH_MS,
  ALL, ALL_NAME, settings, saveSettings, chatUsers, invalidateUsers, ensureAll, memberIds, isMember, canMonitor, can,
  summary, messageOut, preview, post, directWith, iceServers, pendingFor, onSocket, onConnect, onDisconnect, sweepMedia, migratePersonalPermissions, start,
  _calls: calls, _reset: () => { calls.forEach((c) => clearTimeout(c.timer)); calls.clear(); busy.clear(); typingConv.clear(); usersCache = null; setCache = null; },
};
