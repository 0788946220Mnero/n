/*
  مركز اتصال المؤسسين: بث لحظي (WebSocket على /founders/ws) + إشعارات الجوال + المكالمات.

  • القناة اللحظية مستقلة عن /ws للوحة (جلسة الواجهة المستقلة منفصلة عن جلسة اللوحة).
  • الإشعارات: Web Push (آيفون — الواجهة مثبّتة على الشاشة الرئيسية — والمتصفحات)
    و FCM رسائل بيانات بأولوية عالية (تطبيق أندرويد APK يعرض شاشة اتصال كاملة).
  • المكالمة: رنين يتكرر بالوسم نفسه كل بضع ثوانٍ حتى الرد أو الرفض أو انتهاء المهلة،
    والصوت نفسه WebRTC مباشرة بين الجهازين (الخادم يمرّر الإشارات فقط).
  • لا شيء هنا يُفشل عملية: كل إرسال يبتلع أخطاءه.
*/
const jwt = require('jsonwebtoken');
const url = require('url');
const { WebSocketServer } = require('ws');

const WS_PATH = '/founders/ws';
const clients = new Set(); // { socket, userId, name }
let wss = null;

const M = () => require('./models');
const live = () => require('../services/liveReportService');

/* ═════════ اللحظي ═════════ */

function send(c, payload) {
  if (!c || c.socket.readyState !== 1) return false;
  try { c.socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload)); return true; } catch (_) { return false; }
}
/** يرسل لمستخدمين (أو للكل إن كانت ids فارغة/null). يرجع من وصلهم. */
function emit(ids, payload) {
  const set = ids ? new Set([...ids].map(String)) : null;
  const msg = JSON.stringify(payload);
  const got = new Set();
  clients.forEach((c) => { if ((!set || set.has(c.userId)) && send(c, msg)) got.add(c.userId); });
  return got;
}
const isOnline = (id) => [...clients].some((c) => c.userId === String(id) && c.socket.readyState === 1 && c.visible !== false);
const onlineIds = () => [...new Set([...clients].filter((c) => c.socket.readyState === 1).map((c) => c.userId))];

/** معرّفات كل المؤسسين النشطين. */
async function founderIds() {
  const User = require('../models/User');
  const users = await User.find({ isFounder: true, isActive: { $ne: false } }).select('_id').lean();
  return users.map((u) => String(u._id));
}

async function verifyToken(token) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (!decoded || decoded.aud !== 'founders') throw new Error('not founders');
  const User = require('../models/User');
  const user = await User.findById(decoded.id).select('name username isActive isFounder').lean();
  if (!user || user.isActive === false || !user.isFounder) throw new Error('not founder');
  const prof = await M().FounderProfile.findOne({ user: user._id }).select('+sessionId displayName').lean();
  if (!prof || prof.active === false || (prof.sessionId && prof.sessionId !== decoded.fsid)) throw new Error('session');
  return { user, prof };
}

function handleUpgrade(req, socket, head) {
  if (!wss) wss = new WebSocketServer({ noServer: true });
  wss.handleUpgrade(req, socket, head, async (ws) => {
    const { query } = url.parse(req.url, true);
    let who;
    try { who = await verifyToken(String(query.token || '')); } catch (_) { try { ws.close(4002, 'invalid'); } catch (e) { /* */ } return; }
    if (ws.readyState !== 1) return;
    const c = { socket: ws, userId: String(who.user._id), name: who.prof.displayName || who.user.name || who.user.username, visible: true };
    clients.add(c);
    send(c, { type: 'hello', online: onlineIds() });
    emit(null, { type: 'presence', userId: c.userId, online: true });
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      const s = String(raw);
      if (s.length > 65536) return;
      let m; try { m = JSON.parse(s); } catch (_) { return; }
      if (!m || typeof m.type !== 'string') return;
      if (m.type === 'visible') { c.visible = !!m.on; return; }
      if (m.type === 'typing' && typeof m.conv === 'string') { relayTyping(c, m.conv); return; }
      if (m.type.startsWith('call.')) onCallSignal(c, m);
    });
    const gone = () => {
      if (!clients.delete(c)) return;
      if (!isOnline(c.userId)) emit(null, { type: 'presence', userId: c.userId, online: false });
      M().FounderProfile.updateOne({ user: c.userId }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
    };
    ws.on('close', gone); ws.on('error', gone);
  });
}

// نبضة إبقاء الاتصال حياً
const beat = setInterval(() => {
  clients.forEach((c) => {
    const s = c.socket;
    if (s.isAlive === false) { try { s.terminate(); } catch (_) { /* */ } return; }
    s.isAlive = false; try { s.ping(); } catch (_) { /* */ }
  });
}, 30000);
if (beat.unref) beat.unref();

function relayTyping(c, conv) {
  if (conv === 'group') { founderIds().then((ids) => emit(ids.filter((i) => i !== c.userId), { type: 'typing', conv, from: c.userId, name: c.name })).catch(() => {}); return; }
  const parts = conv.split(':');
  if (parts[0] !== 'dm' || !parts.includes(c.userId)) return;
  emit(parts.slice(1).filter((i) => i !== c.userId), { type: 'typing', conv, from: c.userId, name: c.name });
}

/* ═════════ الإشعارات على الجوال ═════════ */

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/**
 * إشعار لمؤسسين: { title, body, url, tag, kind:'alert'|'call', urgent, data }
 * skipOnline: لا يُرسل لمن الواجهة ظاهرة أمامه (يصله التنبيه داخلها).
 */
async function push(ids, msg, { skipOnline = false } = {}) {
  try {
    let targets = [...new Set((ids || []).map(String))];
    if (skipOnline) targets = targets.filter((id) => !isOnline(id));
    if (!targets.length) return { sent: 0, failed: 0 };
    const devices = await M().FounderDevice.find({ user: { $in: targets } }).lean();
    if (!devices.length) return { sent: 0, failed: 0 };
    let sent = 0; let failed = 0;
    const payload = {
      kind: msg.kind || 'alert', type: msg.type || 'founders', title: clip(msg.title, 80), body: clip(msg.body, 240),
      url: msg.url || './', tag: msg.tag || 'founders', urgent: !!msg.urgent, at: Date.now(), data: msg.data || {},
    };
    const web = devices.filter((d) => d.kind === 'webpush');
    if (web.length && live().enabled()) {
      await Promise.all(web.map(async (d) => {
        try {
          await live().webpush().sendNotification({ endpoint: d.endpoint, keys: d.keys }, JSON.stringify(payload), { TTL: msg.kind === 'call' ? 60 : 24 * 3600, urgency: 'high', topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined });
          sent++;
          M().FounderDevice.updateOne({ _id: d._id }, { $set: { lastOkAt: new Date(), lastError: '' } }).catch(() => {});
        } catch (err) {
          failed++;
          const code = err && err.statusCode;
          if (code === 404 || code === 410) await M().FounderDevice.deleteOne({ _id: d._id }).catch(() => {});
          else M().FounderDevice.updateOne({ _id: d._id }, { $set: { lastError: String((err && err.message) || err).slice(0, 200) } }).catch(() => {});
        }
      }));
    }
    const fcm = devices.filter((d) => d.kind === 'fcm');
    if (fcm.length) {
      const r = await pushFcm(fcm, payload);
      sent += r.sent; failed += r.failed;
    }
    return { sent, failed };
  } catch (e) {
    console.error('founders push:', e.message);
    return { sent: 0, failed: 0 };
  }
}

/** FCM: رسالة بيانات بأولوية عالية — تطبيق الأندرويد يقرر العرض (شاشة اتصال كاملة للمكالمة). */
async function pushFcm(devices, p) {
  const pushService = require('../services/pushService');
  if (!pushService.isEnabled()) return { sent: 0, failed: 0 };
  const admin = require('firebase-admin');
  const tokens = devices.map((d) => d.token);
  const data = { kind: p.kind, type: p.type, title: p.title, body: p.body, url: p.url, tag: p.tag, urgent: p.urgent ? '1' : '0', at: String(p.at), data: JSON.stringify(p.data || {}) };
  try {
    const res = await admin.messaging().sendEachForMulticast({
      tokens, data,
      android: { priority: 'high', ttl: p.kind === 'call' ? 60000 : 86400000 },
      apns: { headers: { 'apns-priority': '10' }, payload: { aps: { 'content-available': 1, sound: 'default', 'interruption-level': p.urgent ? 'critical' : 'time-sensitive' } } },
    });
    await Promise.all(res.responses.map(async (r, i) => {
      if (r.success) return;
      if (pushService.isDeadToken((r.error && r.error.code) || '')) await M().FounderDevice.deleteOne({ _id: devices[i]._id }).catch(() => {});
    }));
    return { sent: res.successCount, failed: res.failureCount };
  } catch (e) {
    console.error('founders fcm:', e.message);
    return { sent: 0, failed: devices.length };
  }
}

/** حدث للمؤسسين: لحظي للكل + إشعار جوال لمن ليست الواجهة أمامه. */
async function notifyFounders(ids, event, msg) {
  const list = ids || await founderIds();
  emit(list, event);
  if (msg) await push(list, msg, { skipOnline: true });
}

/* ═════════ المكالمات ═════════ */

const calls = new Map(); // callId → { id, from, fromName, to:Set, state, timer, ringTimer, startedAt, video }
const RING_EVERY_MS = () => Number(process.env.FOUNDERS_RING_PUSH_MS) || 6000;

function endCall(call, reason) {
  if (!call || call.state === 'ended') return;
  call.state = 'ended';
  clearTimeout(call.timer); clearInterval(call.ringTimer);
  calls.delete(call.id);
  const everyone = [call.from, ...call.to];
  emit(everyone, { type: 'call.end', callId: call.id, reason });
  // يستبدل إشعار الرنين على شاشة القفل (الوسم نفسه) — لا يبقى يرن
  push([...call.to].filter((id) => !call.answeredBy || id !== call.answeredBy), {
    kind: 'alert', type: 'call.ended', tag: `fcall-${call.id}`, title: reason === 'answered-elsewhere' ? 'تم الرد' : 'مكالمة فائتة',
    body: `${call.fromName}${reason === 'timeout' ? ' — لم يُرد' : ''}`, url: './#chat',
  }).catch(() => {});
}

async function startCall({ from, fromName, to, video = false, urgent = true, note = '' }) {
  const settings = await M().FounderSettings.findOne({ key: 'main' }).lean();
  const ringSec = (settings && settings.callRingSeconds) || 60;
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const call = { id, from: String(from), fromName, to: new Set(to.map(String).filter((x) => x !== String(from))), state: 'ringing', video: !!video, note: clip(note, 120), startedAt: Date.now() };
  if (!call.to.size) throw Object.assign(new Error('لا يوجد من تتصل به'), { statusCode: 400 });
  calls.set(id, call);
  const invite = { type: 'call.invite', callId: id, from: call.from, fromName, video: call.video, note: call.note, urgent };
  emit(call.to, invite);
  const ring = () => push([...call.to], {
    kind: 'call', type: 'call.ring', tag: `fcall-${id}`, urgent, title: `📞 ${fromName} يتصل بك`,
    body: call.note || (call.video ? 'مكالمة فيديو — اضغط للرد' : 'مكالمة صوتية — اضغط للرد'),
    url: `./#call=${id}`, data: { callId: id, from: call.from, fromName, video: call.video },
  });
  ring();
  call.ringTimer = setInterval(() => { if (call.state === 'ringing') ring(); }, RING_EVERY_MS());
  if (call.ringTimer.unref) call.ringTimer.unref();
  call.timer = setTimeout(() => endCall(call, 'timeout'), ringSec * 1000);
  if (call.timer.unref) call.timer.unref();
  return { callId: id };
}

function onCallSignal(c, m) {
  const call = calls.get(String(m.callId || ''));
  if (!call) { send(c, { type: 'call.end', callId: m.callId, reason: 'gone' }); return; }
  const me = c.userId;
  const isParty = me === call.from || call.to.has(me);
  if (!isParty) return;
  switch (m.type) {
    case 'call.accept': {
      if (call.state !== 'ringing' || me === call.from) return;
      call.state = 'active'; call.answeredBy = me;
      clearInterval(call.ringTimer); clearTimeout(call.timer);
      emit([call.from], { type: 'call.accept', callId: call.id, by: me, name: c.name });
      // البقية: رُدّ عليها من غيرهم — تتوقف عندهم
      emit([...call.to].filter((x) => x !== me), { type: 'call.end', callId: call.id, reason: 'answered-elsewhere' });
      push([...call.to].filter((x) => x !== me), { kind: 'alert', type: 'call.ended', tag: `fcall-${call.id}`, title: 'تم الرد', body: `${call.fromName} — ردّ ${c.name}`, url: './#chat' }).catch(() => {});
      call.to = new Set([me]);
      // مهلة قصوى للمكالمة النشطة: ساعتان
      call.timer = setTimeout(() => endCall(call, 'limit'), 2 * 3600 * 1000);
      if (call.timer.unref) call.timer.unref();
      return;
    }
    case 'call.decline': {
      if (me === call.from) return endCall(call, 'cancelled');
      call.to.delete(me);
      emit([call.from], { type: 'call.decline', callId: call.id, by: me, name: c.name });
      if (!call.to.size) endCall(call, 'declined');
      return;
    }
    case 'call.end': return endCall(call, me === call.from && call.state === 'ringing' ? 'cancelled' : 'hangup');
    case 'call.offer': case 'call.answer': case 'call.ice': {
      const target = String(m.to || '');
      if (!target || (target !== call.from && !call.to.has(target))) return;
      emit([target], { type: m.type, callId: call.id, from: me, sdp: m.sdp, candidate: m.candidate });
      return;
    }
    default:
  }
}

function callFor(userId) {
  const id = String(userId);
  for (const call of calls.values()) {
    if (call.state === 'ringing' && call.to.has(id)) return { callId: call.id, from: call.from, fromName: call.fromName, video: call.video, note: call.note };
  }
  return null;
}

module.exports = {
  WS_PATH, handleUpgrade, emit, isOnline, onlineIds, founderIds, push, notifyFounders, verifyToken,
  startCall, endCall, callFor, calls,
  _reset: () => { calls.forEach((c) => endCall(c, 'reset')); clients.clear(); },
};
