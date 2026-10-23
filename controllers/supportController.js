/*
  «تواصل مع فريق العمل» — دردشة الزبون (منصة الزبائن) مع طاقم المطعم.

  الزبون: يدخل برقم هاتفه (OTP) — req.phoneUser من requireCustomer.
  الطاقم: كل من يملك support:reply — يصلهم الإشعار فوراً عبر /ws (sendToUsers)،
           ولا تصل نصوص الرسائل لغيرهم.
  الزبون لا يرى أسماء حسابات الطاقم الداخلية — يرى «فريق ديار الأنباط» واسم من ردّ فقط.
*/
const mongoose = require('mongoose');
const SupportThread = require('../models/SupportThread');
const SupportMessage = require('../models/SupportMessage');
const { effectivePermissionsFor } = require('../utils/permissions');

const MAX_LEN = 1000;
const PAGE = 100;

/* ── حدّ الإرسال: 12 رسالة في الدقيقة لكل زبون (في الذاكرة) ── */
const sendLog = new Map();
const canSend = (key) => {
  const now = Date.now();
  const list = (sendLog.get(key) || []).filter((t) => now - t < 60 * 1000);
  if (list.length >= 12) { sendLog.set(key, list); return false; }
  list.push(now); sendLog.set(key, list);
  return true;
};
setInterval(() => {
  const now = Date.now();
  for (const [k, l] of sendLog) { const f = l.filter((t) => now - t < 60 * 1000); if (f.length) sendLog.set(k, f); else sendLog.delete(k); }
}, 5 * 60 * 1000).unref();

const cleanText = (raw) => String(raw == null ? '' : raw).replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F]/g, '').trim();
const cleanName = (raw) => cleanText(raw).replace(/\s+/g, ' ').slice(0, 60);

/** للزبون: بلا معرّف حساب الموظف. */
const forCustomer = (m) => ({
  _id: m._id, from: m.from, text: m.text, createdAt: m.createdAt,
  ...(m.from === 'staff' ? { staffName: m.staffName || '' } : {}),
});
const forStaff = (m) => ({
  _id: m._id, from: m.from, text: m.text, createdAt: m.createdAt, staffName: m.staffName || '', staffUser: m.staffUser || null,
});
const threadView = (t) => ({
  _id: t._id, phone: t.phone, name: t.name || '', lastText: t.lastText || '', lastFrom: t.lastFrom || '',
  lastMessageAt: t.lastMessageAt, unreadStaff: t.unreadStaff || 0, status: t.status || 'open', createdAt: t.createdAt,
});

/* ── من يستقبل رسائل الزبائن من الطاقم (مخبّأ 20 ثانية) ── */
let staffCache = { at: 0, ids: [] };
async function supportStaffIds() {
  if (Date.now() - staffCache.at < 20 * 1000) return staffCache.ids;
  const User = require('../models/User');
  const users = await User.find({ isActive: true }).select('role permissions').lean();
  const ids = users.filter((u) => effectivePermissionsFor(u).includes('support:reply')).map((u) => String(u._id));
  staffCache = { at: Date.now(), ids };
  return ids;
}
const resetStaffCache = () => { staffCache = { at: 0, ids: [] }; };

/** يُبلغ الطاقم المختص فوراً (لوحة التحكم المفتوحة). */
async function notifyStaff(type, payload) {
  try {
    const rt = require('../services/realtimeService');
    if (!rt.sendToUsers) return;
    const ids = await supportStaffIds();
    if (ids.length) rt.sendToUsers(ids, { type, ...payload });
  } catch (e) { console.error('support notify:', e.message); }
}

/** إشعار دفع للزبون بالرد (إن كان مشتركاً في إشعارات الموقع برقمه). */
async function notifyCustomer(thread, text) {
  try {
    const push = require('../services/pushService');
    if (!push.isEnabled || !push.isEnabled()) return;
    const PushSubscriber = require('../models/PushSubscriber');
    const subs = await PushSubscriber.find({ isActive: true, phone: thread.phone }).select('token').lean();
    const tokens = [...new Set(subs.map((s) => s.token).filter(Boolean))];
    if (!tokens.length) return;
    const r = await push.sendToTokens(tokens, {
      title: 'ردّ من فريق ديار الأنباط',
      body: text.length > 120 ? text.slice(0, 117) + '…' : text,
      data: { kind: 'support', link: '/#team-chat' },
    });
    if (r && r.invalidTokens && r.invalidTokens.length) {
      await PushSubscriber.updateMany({ token: { $in: r.invalidTokens } }, { $set: { isActive: false } });
    }
  } catch (e) { console.error('support push:', e.message); }
}

/* ═════════════════ الزبون ═════════════════ */

// GET /api/support/me — محادثتي (آخر 100 رسالة) وتُعلَّم ردود الطاقم مقروءة
exports.getMine = async (req, res) => {
  const thread = await SupportThread.findOne({ phoneUser: req.phoneUser._id });
  if (!thread) return res.json({ success: true, thread: null, messages: [] });
  const msgs = await SupportMessage.find({ thread: thread._id }).sort({ createdAt: -1 }).limit(PAGE).lean();
  if (thread.unreadCustomer) await SupportThread.updateOne({ _id: thread._id }, { $set: { unreadCustomer: 0 } });
  res.json({ success: true, thread: { _id: thread._id, name: thread.name || '', status: thread.status }, messages: msgs.reverse().map(forCustomer) });
};

// GET /api/support/me/unread — شارة الزر في الصفحة الرئيسية
exports.myUnread = async (req, res) => {
  const thread = await SupportThread.findOne({ phoneUser: req.phoneUser._id }).select('unreadCustomer').lean();
  res.json({ success: true, unread: (thread && thread.unreadCustomer) || 0 });
};

// POST /api/support/me/messages { text, name? }
exports.sendMine = async (req, res) => {
  const text = cleanText(req.body && req.body.text);
  if (!text) return res.status(400).json({ success: false, message: 'اكتب رسالتك أولاً' });
  if (text.length > MAX_LEN) return res.status(400).json({ success: false, message: `الرسالة أطول من ${MAX_LEN} حرف` });
  if (!canSend('c:' + req.phoneUser._id)) return res.status(429).json({ success: false, message: 'أرسلت رسائل كثيرة خلال دقيقة — انتظر قليلاً' });

  const name = cleanName(req.body && req.body.name);
  let thread = await SupportThread.findOne({ phoneUser: req.phoneUser._id });
  if (!thread) {
    thread = await SupportThread.create({ phoneUser: req.phoneUser._id, phone: req.phoneUser.phone, name });
  }
  const msg = await SupportMessage.create({ thread: thread._id, from: 'customer', text });
  const set = { lastText: text.slice(0, 200), lastFrom: 'customer', lastMessageAt: msg.createdAt || new Date(), status: 'open' };
  if (name && name !== thread.name) set.name = name;
  await SupportThread.updateOne({ _id: thread._id }, { $set: set, $inc: { unreadStaff: 1 } });
  const fresh = await SupportThread.findById(thread._id).lean();
  notifyStaff('support.message', { thread: threadView(fresh), message: forStaff(msg) });
  res.status(201).json({ success: true, message: forCustomer(msg) });
};

/* ═════════════════ الطاقم (support:reply) ═════════════════ */

// GET /api/support/threads?status=open|closed|all&q=
exports.listThreads = async (req, res) => {
  const filter = {};
  const st = String(req.query.status || 'all');
  if (st === 'open' || st === 'closed') filter.status = st;
  const q = cleanText(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 40);
  if (q) filter.$or = [{ phone: { $regex: q } }, { name: { $regex: q, $options: 'i' } }];
  const list = await SupportThread.find(filter).sort({ lastMessageAt: -1 }).limit(200).lean();
  const unread = list.reduce((t, x) => t + (x.unreadStaff ? 1 : 0), 0);
  res.json({ success: true, threads: list.map(threadView), unreadThreads: unread });
};

// GET /api/support/unread — شارة القسم في لوحة التحكم
exports.staffUnread = async (req, res) => {
  const n = await SupportThread.countDocuments({ unreadStaff: { $gt: 0 } });
  res.json({ success: true, unreadThreads: n });
};

const loadThread = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) { res.status(400).json({ success: false, message: 'معرّف غير صالح' }); return null; }
  const t = await SupportThread.findById(req.params.id);
  if (!t) { res.status(404).json({ success: false, message: 'المحادثة غير موجودة' }); return null; }
  return t;
};

// GET /api/support/threads/:id — الرسائل، وتُعلَّم رسائل الزبون مقروءة
exports.getThread = async (req, res) => {
  const t = await loadThread(req, res); if (!t) return;
  const msgs = await SupportMessage.find({ thread: t._id }).sort({ createdAt: -1 }).limit(PAGE).lean();
  if (t.unreadStaff) {
    await SupportThread.updateOne({ _id: t._id }, { $set: { unreadStaff: 0 } });
    notifyStaff('support.read', { threadId: String(t._id) });
  }
  const fresh = await SupportThread.findById(t._id).lean();
  let customer = null; // اسم الزبون من سجل الزبائن إن وُجد برقمه
  try {
    const Customer = mongoose.models.Customer || require('../models/Customer');
    const local = t.phone.replace(/^\+962/, '0');
    const c = await Customer.findOne({ phone: { $in: [t.phone, local, t.phone.replace(/^\+/, '')] } }).select('name phone').lean();
    if (c) customer = { name: c.name, phone: c.phone };
  } catch (_) { /* */ }
  res.json({ success: true, thread: threadView(fresh), customer, messages: msgs.reverse().map(forStaff) });
};

// POST /api/support/threads/:id/messages { text }
exports.reply = async (req, res) => {
  const t = await loadThread(req, res); if (!t) return;
  const text = cleanText(req.body && req.body.text);
  if (!text) return res.status(400).json({ success: false, message: 'اكتب الرد أولاً' });
  if (text.length > MAX_LEN) return res.status(400).json({ success: false, message: `الرد أطول من ${MAX_LEN} حرف` });
  const msg = await SupportMessage.create({ thread: t._id, from: 'staff', staffUser: req.user._id, staffName: req.user.name || '', text });
  await SupportThread.updateOne({ _id: t._id }, {
    $set: { lastText: text.slice(0, 200), lastFrom: 'staff', lastMessageAt: msg.createdAt || new Date(), unreadStaff: 0, status: 'open' },
    $inc: { unreadCustomer: 1 },
  });
  const fresh = await SupportThread.findById(t._id).lean();
  notifyStaff('support.message', { thread: threadView(fresh), message: forStaff(msg) });
  notifyCustomer(t, text);
  res.status(201).json({ success: true, message: forStaff(msg), thread: threadView(fresh) });
};

// PATCH /api/support/threads/:id { status: 'open'|'closed' }
exports.setStatus = async (req, res) => {
  const t = await loadThread(req, res); if (!t) return;
  const status = req.body && req.body.status;
  if (!['open', 'closed'].includes(status)) return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
  await SupportThread.updateOne({ _id: t._id }, { $set: { status, ...(status === 'closed' ? { unreadStaff: 0 } : {}) } });
  const fresh = await SupportThread.findById(t._id).lean();
  notifyStaff('support.thread', { thread: threadView(fresh) });
  res.json({ success: true, thread: threadView(fresh) });
};

exports._resetStaffCache = resetStaffCache;
