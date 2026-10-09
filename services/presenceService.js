/**
 * الحضور اللحظي للمستخدمين — أساس «مراقبة موظفي السنتر».
 *
 * • الجلسة تبدأ مع أول اتصال WebSocket للمستخدم وتنتهي بآخر اتصال له.
 * • الانقطاع القصير (شبكة الجوال، تحديث الصفحة) لا يُعدّ انقطاعاً: مهلة GRACE_MS
 *   قبل إنهاء الجلسة، وإن عاد خلالها تستمر نفس الجلسة.
 * • الصفحة في الخلفية (هاتف مقفل/تطبيق آخر): الواجهة ترسل away/active فيُحسب وقتها.
 * • خروج طبيعي: الواجهة ترسل bye قبل تسجيل الخروج → لا يُعدّ انقطاعاً.
 * • كل تغيّر يُبثّ لمن يملك صلاحية «مراقبة موظفي السنتر».
 */
const PresenceSession = require('../models/PresenceSession');

const GRACE_MS = Number(process.env.PRESENCE_GRACE_MS || 30000);
const live = new Map(); // userId → { userId, name, role, sockets:Set, state, stateSince, sessionId, startedAt, timer, bye, device }
let notify = () => {};  // (event) => يُعيَّن من realtimeService

const nowIso = () => new Date();

const logActivity = (entry, action, details) => {
  // سجل نشاط المستخدم لموظفي السنتر فقط (لا نُغرق سجل بقية الموظفين)
  if (entry.role !== 'center') return;
  try {
    require('../utils/activity').logActivity({
      user: { _id: entry.userId, name: entry.name, role: entry.role },
      action, details,
    });
  } catch (_) {}
};

const snapshotOf = (e) => ({
  userId: e.userId, name: e.name, role: e.role,
  online: e.sockets.size > 0, state: e.sockets.size ? e.state : 'offline',
  stateSince: e.stateSince, startedAt: e.startedAt, device: e.device || '',
  reconnecting: !!e.timer,
});

const emit = (e, extra = {}) => notify({ type: 'presence', presence: snapshotOf(e), ...extra });

async function connect({ userId, name, role, socket, device }) {
  const id = String(userId);
  let e = live.get(id);
  if (e && e.timer) {
    // عاد خلال مهلة الانقطاع: نفس الجلسة
    clearTimeout(e.timer);
    e.timer = null;
    e.sockets.add(socket);
    e.state = 'active'; e.stateSince = nowIso();
    PresenceSession.updateOne({ _id: e.sessionId }, { $set: { lastSeenAt: new Date(), awaySince: null } }).catch(() => {});
    emit(e, { event: 'resumed' });
    return;
  }
  if (e && e.sockets.size) { e.sockets.add(socket); return; } // تبويب/جهاز إضافي
  e = { userId: id, name, role, sockets: new Set([socket]), state: 'active', stateSince: nowIso(), startedAt: nowIso(), timer: null, bye: false, device: device || '' };
  live.set(id, e);
  e.ready = PresenceSession.create({ user: id, userName: name, role, startedAt: e.startedAt, lastSeenAt: e.startedAt, device: e.device })
    .then((doc) => { e.sessionId = doc._id; })
    .catch(() => { /* المراقبة لا تُفشل الاتصال */ });
  await e.ready;
  logActivity(e, 'presence.online', { device: e.device });
  emit(e, { event: 'online' });
}

async function endSession(e, reason) {
  live.delete(e.userId);
  const end = new Date();
  await e.ready;
  const set = { endedAt: end, endReason: reason, lastSeenAt: end, awaySince: null };
  try {
    if (e.sessionId) {
      const doc = await PresenceSession.findById(e.sessionId).select('awaySince awayMs startedAt').lean();
      if (doc && doc.awaySince) set.awayMs = (doc.awayMs || 0) + (end - new Date(doc.awaySince));
      await PresenceSession.updateOne({ _id: e.sessionId }, { $set: set });
    }
  } catch (_) {}
  const minutes = Math.round((end - new Date(e.startedAt)) / 60000);
  logActivity(e, reason === 'lost' ? 'presence.lost' : 'presence.offline', { minutes, reason });
  notify({ type: 'presence', event: reason === 'lost' ? 'lost' : 'offline', presence: { ...snapshotOf({ ...e, sockets: new Set() }), endedAt: end, endReason: reason, minutes } });
}

function disconnect(userId, socket) {
  const e = live.get(String(userId));
  if (!e) return;
  e.sockets.delete(socket);
  if (e.sockets.size) return;
  if (e.bye) { endSession(e, 'logout'); return; }
  // ننتظر قليلاً: شبكة الجوال وتحديث الصفحة يعيدان الاتصال خلال ثوانٍ
  e.timer = setTimeout(() => { e.timer = null; if (!e.sockets.size) endSession(e, 'lost'); }, GRACE_MS);
  emit(e, { event: 'reconnecting' });
}

async function setState(userId, state) {
  const e = live.get(String(userId));
  if (!e || !['away', 'active'].includes(state) || e.state === state) return;
  const t = new Date();
  e.state = state; e.stateSince = t;
  await e.ready;
  if (state === 'away') {
    PresenceSession.updateOne({ _id: e.sessionId }, { $set: { awaySince: t, lastSeenAt: t } }).catch(() => {});
  } else {
    PresenceSession.findById(e.sessionId).select('awaySince awayMs').lean().then((doc) => {
      if (!doc || !doc.awaySince) return null;
      return PresenceSession.updateOne({ _id: e.sessionId }, { $set: { awaySince: null, lastSeenAt: t, awayMs: (doc.awayMs || 0) + (t - new Date(doc.awaySince)) } });
    }).catch(() => {});
  }
  logActivity(e, state === 'away' ? 'presence.away' : 'presence.back', {});
  emit(e, { event: state });
}

function bye(userId) {
  const e = live.get(String(userId));
  if (!e) return;
  e.bye = true;
  // الاتصال انقطع قبل وصول طلب الخروج: الجلسة تُغلق خروجاً طبيعياً لا انقطاعاً
  if (e.timer) { clearTimeout(e.timer); e.timer = null; endSession(e, 'logout'); }
}

function snapshot() { return [...live.values()].map(snapshotOf); }

/** نبضة: آخر ظهور للجلسات الحية (مرة كل دقيقة) — لو سقط الخادم فجأة يبقى وقت دقيق. */
function heartbeat() {
  const ids = [...live.values()].filter((e) => e.sessionId && e.sockets.size).map((e) => e.sessionId);
  if (ids.length) PresenceSession.updateMany({ _id: { $in: ids } }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
}

/** عند تشغيل الخادم: الجلسات المفتوحة من تشغيل سابق تُغلق عند آخر ظهور لها. */
async function closeStale() {
  try {
    const open = await PresenceSession.find({ endedAt: null }).select('lastSeenAt').lean();
    for (const s of open) {
      await PresenceSession.updateOne({ _id: s._id }, { $set: { endedAt: s.lastSeenAt, endReason: 'server', awaySince: null } });
    }
  } catch (_) {}
}

let hb = null;
function init(notifier) {
  notify = notifier;
  if (!hb) { hb = setInterval(heartbeat, 60000); if (hb.unref) hb.unref(); }
  closeStale();
}

module.exports = { init, connect, disconnect, setState, bye, snapshot, GRACE_MS };
