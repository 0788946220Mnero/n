/*
  «تواصل مع فريق العمل» — دردشة الزبون (منصة الزبائن) مع طاقم المطعم.

  الزبون: يدخل برقم هاتفه (OTP) — req.phoneUser من requireCustomer.
          نص، صورة (تُصغَّر في المتصفح وتُزال بياناتها الوصفية هنا)، أو إرفاق طلب من طلباته.
          علامتا القراءة ✓✓، و«فريق العمل يكتب…»، ورد تلقائي خارج ساعات العمل، وأسئلة سريعة.
  الطاقم: كل من يملك support:reply — يصلهم الجديد فوراً عبر /ws (ولا تصل النصوص لغيرهم).
          تعيين المحادثة لموظف، وسوم، ملاحظات داخلية (لا تصل الزبون أبداً)، ردود جاهزة،
          بطاقة الزبون (طلباته وإطاره)، حذف رسالة، ومؤشرات سرعة الرد.
  الزبون لا يرى معرّفات حسابات الطاقم — اسم من ردّ فقط.
*/
const mongoose = require('mongoose');
const SupportThread = require('../models/SupportThread');
const SupportMessage = require('../models/SupportMessage');
const SupportSetting = require('../models/SupportSetting');
const CustomerMedia = require('../models/CustomerMedia');
const { effectivePermissionsFor } = require('../utils/permissions');
const { acceptImage } = require('../utils/imageSafe');
const { phoneVariantsJo, localJo } = require('../utils/phone');
const { logActivity } = require('../utils/activity');
const profiles = require('../services/customerProfileService');
const workHours = require('../services/workHours');

const MAX_LEN = 1000;
const PAGE = 100;
const PER_MINUTE = 12;
const AUTO_REPLY_GAP = 6 * 3600 * 1000;
const cr = () => require('../services/customerRealtime');
const validId = (id) => mongoose.isValidObjectId(id);
const bad = (res, message, status = 400, extra = {}) => res.status(status).json({ success: false, message, ...extra });

const cleanText = (raw) => String(raw == null ? '' : raw).replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F]/g, '').trim();
const cleanName = (raw) => cleanText(raw).replace(/\s+/g, ' ').slice(0, 60);
const preview = (m) => (m.kind === 'image' ? '📷 صورة' : m.kind === 'order' ? `🧾 طلب #${(m.order && m.order.orderNumber) || ''}` : '') + (m.text ? `${m.kind !== 'text' ? ' ' : ''}${m.text}` : '');

/* ── الإعدادات (مخبّأة 10 ثوانٍ) ── */
let settingsCache = { at: 0, doc: null };
async function settings() {
  if (settingsCache.doc && Date.now() - settingsCache.at < 10000) return settingsCache.doc;
  let s = await SupportSetting.findOne({ key: 'settings' }).lean();
  if (!s) {
    try { await SupportSetting.create({ key: 'settings' }); } catch (_) { /* أُنشئت للتو */ }
    s = await SupportSetting.findOne({ key: 'settings' }).lean();
  }
  settingsCache = { at: Date.now(), doc: s };
  return s;
}

/* ── العرض ── */
const orderView = (o) => (o && o.orderNumber ? { orderNumber: o.orderNumber, status: o.status, total: o.total, orderType: o.orderType, createdAt: o.createdAt } : null);
/** للزبون: بلا الملاحظات الداخلية (تُستبعد قبل الاستدعاء) ولا معرّف حساب الموظف. */
const forCustomer = (m) => {
  if (m.deleted) return { _id: m._id, from: m.from, kind: 'text', text: '', deleted: true, createdAt: m.createdAt };
  return {
    _id: m._id, from: m.from, kind: m.kind || 'text', text: m.text || '', createdAt: m.createdAt,
    ...(m.from === 'staff' ? { staffName: m.staffName || '' } : {}),
    ...(m.kind === 'image' && m.media ? { image: `/api/support/me/media/${m.media}`, width: m.width || 0, height: m.height || 0 } : {}),
    ...(m.kind === 'order' ? { order: orderView(m.order) } : {}),
  };
};
const forStaff = (m) => ({
  _id: m._id, from: m.from, kind: m.kind || 'text', text: m.deleted ? '' : (m.text || ''), createdAt: m.createdAt,
  staffName: m.staffName || '', staffUser: m.staffUser || null,
  ...(m.kind === 'image' && m.media && !m.deleted ? { image: `/api/support/media/${m.media}`, width: m.width || 0, height: m.height || 0 } : {}),
  ...(m.kind === 'order' && !m.deleted ? { order: { ...orderView(m.order), id: m.order && m.order.id } } : {}),
  deleted: !!m.deleted, deletedByName: m.deletedByName || '', responseMs: m.responseMs || 0,
});
const threadView = (t) => ({
  _id: t._id, phone: t.phone, name: t.name || '', lastText: t.lastText || '', lastFrom: t.lastFrom || '',
  lastMessageAt: t.lastMessageAt, unreadStaff: t.unreadStaff || 0, status: t.status || 'open', createdAt: t.createdAt,
  assignedTo: t.assignedTo || null, assignedName: t.assignedName || '', tags: t.tags || [],
  customerReadAt: t.customerReadAt || null, staffReadAt: t.staffReadAt || null, awaitingSince: t.awaitingSince || null,
});
const customerThread = (t) => ({ _id: t._id, name: t.name || '', status: t.status, staffReadAt: t.staffReadAt || null });

/* ── من يستقبل رسائل الزبائن من الطاقم (مخبّأ 20 ثانية) ── */
let staffCache = { at: 0, ids: [], users: [] };
async function supportStaff() {
  if (Date.now() - staffCache.at < 20 * 1000) return staffCache;
  const User = require('../models/User');
  const users = await User.find({ isActive: true }).select('name username role permissions').lean();
  const ok = users.filter((u) => effectivePermissionsFor(u).includes('support:reply'));
  staffCache = { at: Date.now(), ids: ok.map((u) => String(u._id)), users: ok.map((u) => ({ _id: String(u._id), name: u.name || u.username || '' })) };
  return staffCache;
}
const resetStaffCache = () => { staffCache = { at: 0, ids: [], users: [] }; };

/** يُبلغ الطاقم المختص فوراً (لوحة التحكم المفتوحة). */
async function notifyStaff(type, payload) {
  try {
    const rt = require('../services/realtimeService');
    if (!rt.sendToUsers) return;
    const { ids } = await supportStaff();
    if (ids.length) rt.sendToUsers(ids, { type, ...payload });
  } catch (e) { console.error('support notify:', e.message); }
}

/** إشعار دفع للزبون بالرد (إن كان مشتركاً في إشعارات الموقع برقمه) — حين لا تكون الصفحة مفتوحة. */
async function pushCustomer(thread, text) {
  try {
    const push = require('../services/pushService');
    if (!push.isEnabled || !push.isEnabled()) return;
    const PushSubscriber = require('../models/PushSubscriber');
    const subs = await PushSubscriber.find({ isActive: true, phone: { $in: phoneVariantsJo(thread.phone).concat(thread.phone) } }).select('token').lean();
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
/** إشعار دفع قوي لأجهزة الطاقم (شاشة القفل) لمن اللوحة ليست أمامه:
    المحادثة المعيّنة لموظف تصله هو، وغير المعيّنة تصل كل من يملك «رسائل الزبائن». */
async function pushStaff(thread, msg) {
  try {
    const live = require('../services/liveReportService');
    if (!live.enabled || !live.enabled()) return;
    const rt = require('../services/realtimeService');
    const { ids } = await supportStaff();
    let to = thread.assignedTo && ids.includes(String(thread.assignedTo)) ? [String(thread.assignedTo)] : ids;
    to = to.filter((id) => !(rt.isVisible && rt.isVisible(id)));
    if (!to.length) return;
    const StaffDevice = require('../models/StaffDevice');
    const devices = await StaffDevice.find({ user: { $in: to } }).lean();
    if (!devices.length) return;
    await require('../services/staffAlertService').pushTo(devices, {
      title: `💬 رسالة من زبون: ${thread.name || localJo(thread.phone)}`,
      body: preview(msg) || '📷 صورة',
      url: `dashboard.html#support/${thread._id}`, tag: `diyar-support-${thread._id}`, type: 'support.message',
    });
  } catch (e) { console.error('support staff push:', e.message); }
}

/** رسالة من الطاقم أو النظام وصلت للزبون: لحظياً إن كان متصلاً، وإلا إشعار دفع. */
function deliverToCustomer(thread, m) {
  const n = cr().sendToCustomer(thread.phoneUser, { type: 'support.message', message: forCustomer(m) });
  if (!n && m.from === 'staff') pushCustomer(thread, m.kind === 'image' ? '📷 صورة' : m.text);
}

/* ── الحد: 12 رسالة/دقيقة للزبون — من القاعدة (يصمد بعد إعادة التشغيل) ── */
async function overLimit(thread) {
  if (!thread) return false;
  const n = await SupportMessage.countDocuments({ thread: thread._id, from: 'customer', createdAt: { $gte: new Date(Date.now() - 60000) } });
  return n >= PER_MINUTE;
}

async function threadFor(phoneUser, name) {
  let t = await SupportThread.findOne({ phoneUser: phoneUser._id });
  if (!t) {
    try { t = await SupportThread.create({ phoneUser: phoneUser._id, phone: phoneUser.phone, name: name || '' }); } catch (e) {
      if (e && e.code === 11000) t = await SupportThread.findOne({ phoneUser: phoneUser._id }); else throw e;
    }
  }
  return t;
}

/** بعد أي رسالة من الزبون: تحديث المحادثة + الطاقم + رد تلقائي خارج الدوام. */
async function afterCustomerMessage(thread, msg, name) {
  const now = msg.createdAt || new Date();
  const set = { lastText: preview(msg).slice(0, 200), lastFrom: 'customer', lastMessageAt: now, status: 'open', customerReadAt: now };
  if (!thread.awaitingSince) set.awaitingSince = now;
  if (name && name !== thread.name) set.name = name;
  await SupportThread.updateOne({ _id: thread._id }, { $set: set, $inc: { unreadStaff: 1 } });
  let fresh = await SupportThread.findById(thread._id).lean();
  notifyStaff('support.message', { thread: threadView(fresh), message: forStaff(msg) });
  setImmediate(() => pushStaff(fresh, msg));

  let auto = null;
  const s = await settings();
  if (s.autoReplyEnabled && s.autoReplyText && (!fresh.autoReplyAt || Date.now() - new Date(fresh.autoReplyAt).getTime() > AUTO_REPLY_GAP) && !(await workHours.isOpenNow())) {
    const m = await SupportMessage.create({ thread: thread._id, from: 'system', text: s.autoReplyText });
    await SupportThread.updateOne({ _id: thread._id }, { $set: { autoReplyAt: new Date(), lastText: s.autoReplyText.slice(0, 200), lastFrom: 'system', lastMessageAt: m.createdAt || new Date() } });
    fresh = await SupportThread.findById(thread._id).lean();
    auto = forCustomer(m);
    cr().sendToCustomer(thread.phoneUser, { type: 'support.message', message: auto });
    notifyStaff('support.message', { thread: threadView(fresh), message: forStaff(m) });
  }
  return auto;
}

/* ═════════════════ الزبون ═════════════════ */

// GET /api/support/me — محادثتي (بلا الملاحظات الداخلية) + الأسئلة السريعة وحالة الدوام؛ وتُعلَّم ردود الطاقم مقروءة
exports.getMine = async (req, res) => {
  const s = await settings();
  const extra = { quickQuestions: s.quickQuestions || [], open: await workHours.isOpenNow() };
  const thread = await SupportThread.findOne({ phoneUser: req.phoneUser._id });
  if (!thread) return res.json({ success: true, thread: null, messages: [], ...extra });
  const msgs = await SupportMessage.find({ thread: thread._id, from: { $ne: 'note' } }).sort({ createdAt: -1 }).limit(PAGE).lean();
  const at = new Date();
  await SupportThread.updateOne({ _id: thread._id }, { $set: { unreadCustomer: 0, customerReadAt: at } });
  notifyStaff('support.seen', { threadId: String(thread._id), at });
  res.json({ success: true, thread: customerThread(thread), messages: msgs.reverse().map(forCustomer), ...extra });
};

// GET /api/support/me/unread — شارة الزر في الصفحة الرئيسية
exports.myUnread = async (req, res) => {
  const thread = await SupportThread.findOne({ phoneUser: req.phoneUser._id }).select('unreadCustomer').lean();
  res.json({ success: true, unread: (thread && thread.unreadCustomer) || 0 });
};

// POST /api/support/me/read — قرأ الزبون (النافذة مفتوحة ووصل رد لحظياً)
exports.markMineRead = async (req, res) => {
  const thread = await SupportThread.findOne({ phoneUser: req.phoneUser._id }).select('_id').lean();
  if (!thread) return res.json({ success: true });
  const at = new Date();
  await SupportThread.updateOne({ _id: thread._id }, { $set: { unreadCustomer: 0, customerReadAt: at } });
  notifyStaff('support.seen', { threadId: String(thread._id), at });
  res.json({ success: true, at });
};

// GET /api/support/me/orders — آخر طلباتي لإرفاق أحدها بالسؤال
exports.myOrders = async (req, res) => {
  const Order = require('../models/Order');
  const list = await Order.find({ phone: { $in: phoneVariantsJo(req.phoneUser.phone) } }).sort({ createdAt: -1 }).limit(10)
    .select('orderNumber status total orderType createdAt').lean();
  res.json({ success: true, orders: list.map((o) => ({ _id: o._id, orderNumber: o.orderNumber, status: o.status, total: o.total, orderType: o.orderType, createdAt: o.createdAt })) });
};

// POST /api/support/me/messages { text, name?, orderId? }
exports.sendMine = async (req, res) => {
  const text = cleanText(req.body && req.body.text);
  const orderId = req.body && req.body.orderId;
  if (!text && !orderId) return bad(res, 'اكتب رسالتك أولاً');
  if (text.length > MAX_LEN) return bad(res, `الرسالة أطول من ${MAX_LEN} حرف`);
  let order = null;
  if (orderId) {
    if (!validId(orderId)) return bad(res, 'الطلب غير صالح');
    const Order = require('../models/Order');
    order = await Order.findOne({ _id: orderId, phone: { $in: phoneVariantsJo(req.phoneUser.phone) } }).select('orderNumber status total orderType createdAt').lean();
    if (!order) return bad(res, 'هذا الطلب ليس من طلباتك', 404);
  }
  const name = cleanName(req.body && req.body.name);
  let thread = await SupportThread.findOne({ phoneUser: req.phoneUser._id });
  if (await overLimit(thread)) return bad(res, 'أرسلت رسائل كثيرة خلال دقيقة — انتظر قليلاً', 429);
  if (!thread) thread = await threadFor(req.phoneUser, name);
  const msg = await SupportMessage.create({
    thread: thread._id, from: 'customer', kind: order ? 'order' : 'text', text,
    ...(order ? { order: { id: order._id, orderNumber: order.orderNumber, status: order.status, total: order.total, orderType: order.orderType, createdAt: order.createdAt } } : {}),
  });
  const auto = await afterCustomerMessage(thread, msg, name);
  res.status(201).json({ success: true, message: forCustomer(msg), auto });
};

// POST /api/support/me/media (file) — صورة من الزبون
exports.uploadMine = async (req, res) => {
  if (!req.file || !req.file.buffer) return bad(res, 'اختر صورة');
  const img = acceptImage(req.file.buffer, 1600 * 1024);
  if (img.error) return bad(res, img.error, 415);
  let thread = await SupportThread.findOne({ phoneUser: req.phoneUser._id });
  if (await overLimit(thread)) return bad(res, 'أرسلت رسائل كثيرة خلال دقيقة — انتظر قليلاً', 429);
  if (!thread) thread = await threadFor(req.phoneUser, cleanName(req.body && req.body.name));
  const media = await CustomerMedia.create({ kind: 'support', mime: img.mime, size: img.data.length, width: img.width, height: img.height, data: img.data, phoneUser: req.phoneUser._id, thread: thread._id });
  const text = cleanText(req.body && req.body.text).slice(0, MAX_LEN);
  const msg = await SupportMessage.create({ thread: thread._id, from: 'customer', kind: 'image', media: media._id, width: img.width, height: img.height, text });
  const auto = await afterCustomerMessage(thread, msg, cleanName(req.body && req.body.name));
  res.status(201).json({ success: true, message: forCustomer(msg), auto });
};

async function sendMedia(res, md) {
  if (!md || md.deleted || !md.data) return bad(res, 'الصورة غير موجودة', 404);
  const buf = Buffer.isBuffer(md.data) ? md.data : Buffer.from(md.data.buffer || md.data);
  res.set({ 'Content-Type': md.mime, 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=604800, immutable', 'X-Content-Type-Options': 'nosniff' });
  return res.end(buf);
}

// GET /api/support/me/media/:id — صور محادثتي فقط
exports.mineMedia = async (req, res) => {
  if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
  const md = await CustomerMedia.findById(req.params.id).select('+data').lean();
  if (!md || md.kind !== 'support') return bad(res, 'الصورة غير موجودة', 404);
  const t = await SupportThread.findOne({ _id: md.thread, phoneUser: req.phoneUser._id }).select('_id').lean();
  if (!t) return bad(res, 'ليس لديك صلاحية', 403);
  return sendMedia(res, md);
};

/* ═════════════════ الطاقم (support:reply) ═════════════════ */

// GET /api/support/stats — مؤشرات أعلى القسم
exports.stats = async (req, res) => {
  const me = String(req.user._id);
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const dayStart = new Date(Date.now() - 24 * 3600 * 1000);
  const [open, unread, unassigned, mine, waiting, replies, repliesToday] = await Promise.all([
    SupportThread.countDocuments({ status: 'open' }),
    SupportThread.countDocuments({ unreadStaff: { $gt: 0 } }),
    SupportThread.countDocuments({ status: 'open', assignedTo: null }),
    SupportThread.countDocuments({ status: 'open', assignedTo: me }),
    SupportThread.find({ status: 'open', awaitingSince: { $ne: null } }).select('awaitingSince').lean(),
    SupportMessage.find({ from: 'staff', responseMs: { $gt: 0 }, createdAt: { $gte: since } }).select('responseMs').lean(),
    SupportMessage.countDocuments({ from: 'staff', createdAt: { $gte: dayStart } }),
  ]);
  const avg = replies.length ? replies.reduce((t, r) => t + r.responseMs, 0) / replies.length : 0;
  const longest = waiting.reduce((mx, t) => Math.max(mx, Date.now() - new Date(t.awaitingSince).getTime()), 0);
  res.json({
    success: true,
    stats: {
      open, unreadThreads: unread, unassigned, mine, waiting: waiting.length,
      avgResponseMin: Math.round(avg / 6000) / 10, avgResponseSec: Math.round(avg / 1000), answered7d: replies.length, repliesToday,
      longestWaitMin: Math.round(longest / 60000),
    },
  });
};

// GET /api/support/agents — من يمكن تعيين المحادثة له
exports.agents = async (req, res) => { const { users } = await supportStaff(); res.json({ success: true, agents: users }); };

// GET /api/support/threads?status=all|open|closed|mine|unassigned|waiting&tag=&q=
exports.listThreads = async (req, res) => {
  const filter = {};
  const st = String(req.query.status || 'all');
  if (st === 'open' || st === 'closed') filter.status = st;
  else if (st === 'mine') { filter.status = 'open'; filter.assignedTo = String(req.user._id); }
  else if (st === 'unassigned') { filter.status = 'open'; filter.assignedTo = null; }
  else if (st === 'waiting') { filter.status = 'open'; filter.awaitingSince = { $ne: null }; }
  if (req.query.tag && SupportThread.TAGS.includes(req.query.tag)) filter.tags = req.query.tag;
  const q = cleanText(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 40);
  if (q) {
    const ors = [{ phone: { $regex: q.replace(/^0/, '') } }, { name: { $regex: q, $options: 'i' } }];
    filter.$or = ors;
  }
  const list = await SupportThread.find(filter).sort({ lastMessageAt: -1 }).limit(200).lean();
  const unread = await SupportThread.countDocuments({ unreadStaff: { $gt: 0 } });
  // اسم الزبون وصورته وإطاره من ملفه في الدردشة (إن لم يكتب اسماً في المحادثة)
  const CustomerProfile = require('../models/CustomerProfile');
  const profs = list.length ? await CustomerProfile.find({ phoneUser: { $in: list.map((t) => t.phoneUser) } }).select('phoneUser displayName avatar orderCount').lean() : [];
  const byUser = new Map(profs.map((p) => [String(p.phoneUser), p]));
  const threads = list.map((t) => {
    const p = byUser.get(String(t.phoneUser));
    return { ...threadView(t), ...(p ? { profileName: p.displayName || '', avatar: profiles.avatarUrl(p), tier: profiles.tierOf(p.orderCount).key } : {}) };
  });
  res.json({ success: true, threads, unreadThreads: unread, tags: SupportThread.TAGS });
};

// GET /api/support/unread — شارة القسم في لوحة التحكم
exports.staffUnread = async (req, res) => {
  const n = await SupportThread.countDocuments({ unreadStaff: { $gt: 0 } });
  res.json({ success: true, unreadThreads: n });
};

const loadThread = async (req, res) => {
  if (!validId(req.params.id)) { bad(res, 'معرّف غير صالح'); return null; }
  const t = await SupportThread.findById(req.params.id);
  if (!t) { bad(res, 'المحادثة غير موجودة', 404); return null; }
  return t;
};

/** بطاقة الزبون: اسمه في سجل الزبائن، ملفه في الدردشة (الصورة والإطار)، وآخر طلباته. */
async function customerCard(t) {
  const variants = phoneVariantsJo(t.phone);
  const card = { name: '', displayName: '', avatar: '', orderCount: 0, tier: profiles.tierOf(0), lastOrders: [] };
  try {
    const Customer = mongoose.models.Customer || require('../models/Customer');
    const c = await Customer.findOne({ phone: { $in: variants } }).select('name phone').lean();
    if (c) card.name = c.name || '';
  } catch (_) { /* */ }
  try {
    const p = await profiles.refreshOrderCount(await profiles.forPhoneUser({ _id: t.phoneUser, phone: t.phone }));
    Object.assign(card, { displayName: p.displayName || '', avatar: profiles.avatarUrl(p), orderCount: p.orderCount || 0, tier: profiles.tierOf(p.orderCount) });
  } catch (_) { /* */ }
  try {
    const Order = require('../models/Order');
    card.lastOrders = (await Order.find({ phone: { $in: variants } }).sort({ createdAt: -1 }).limit(5).select('orderNumber status total orderType createdAt').lean())
      .map((o) => ({ _id: o._id, orderNumber: o.orderNumber, status: o.status, total: o.total, orderType: o.orderType, createdAt: o.createdAt }));
  } catch (_) { /* */ }
  return card;
}

// GET /api/support/threads/:id — الرسائل (مع الملاحظات الداخلية)، وتُعلَّم رسائل الزبون مقروءة
exports.getThread = async (req, res) => {
  const t = await loadThread(req, res); if (!t) return;
  const msgs = await SupportMessage.find({ thread: t._id }).sort({ createdAt: -1 }).limit(PAGE).lean();
  const at = new Date();
  await SupportThread.updateOne({ _id: t._id }, { $set: { unreadStaff: 0, staffReadAt: at } });
  if (t.unreadStaff) notifyStaff('support.read', { threadId: String(t._id) });
  cr().sendToCustomer(t.phoneUser, { type: 'support.read', at });
  const fresh = await SupportThread.findById(t._id).lean();
  const card = await customerCard(t);
  res.json({ success: true, thread: threadView(fresh), customer: card.name ? { name: card.name, phone: localJo(t.phone) } : null, card, messages: msgs.reverse().map(forStaff) });
};

/** رد من الطاقم (نص أو صورة): قياس سرعة الرد + تعيين تلقائي لمن رد أولاً. */
async function staffReply(req, t, fields) {
  const now = new Date();
  const responseMs = t.awaitingSince ? Math.max(1, now.getTime() - new Date(t.awaitingSince).getTime()) : 0;
  const msg = await SupportMessage.create({ thread: t._id, from: 'staff', staffUser: req.user._id, staffName: req.user.name || '', responseMs, ...fields });
  const set = { lastText: preview(msg).slice(0, 200), lastFrom: 'staff', lastMessageAt: msg.createdAt || now, unreadStaff: 0, status: 'open', awaitingSince: null, staffReadAt: now };
  if (!t.assignedTo) { set.assignedTo = req.user._id; set.assignedName = req.user.name || ''; }
  await SupportThread.updateOne({ _id: t._id }, { $set: set, $inc: { unreadCustomer: 1 } });
  const fresh = await SupportThread.findById(t._id).lean();
  notifyStaff('support.message', { thread: threadView(fresh), message: forStaff(msg) });
  deliverToCustomer(t, msg);
  return { msg, fresh };
}

// POST /api/support/threads/:id/messages { text }
exports.reply = async (req, res) => {
  const t = await loadThread(req, res); if (!t) return;
  const text = cleanText(req.body && req.body.text);
  if (!text) return bad(res, 'اكتب الرد أولاً');
  if (text.length > MAX_LEN) return bad(res, `الرد أطول من ${MAX_LEN} حرف`);
  const { msg, fresh } = await staffReply(req, t, { text });
  res.status(201).json({ success: true, message: forStaff(msg), thread: threadView(fresh) });
};

// POST /api/support/threads/:id/media (file) — صورة من الطاقم
exports.staffUpload = async (req, res) => {
  const t = await loadThread(req, res); if (!t) return;
  if (!req.file || !req.file.buffer) return bad(res, 'اختر صورة');
  const img = acceptImage(req.file.buffer, 1600 * 1024);
  if (img.error) return bad(res, img.error, 415);
  const media = await CustomerMedia.create({ kind: 'support', mime: img.mime, size: img.data.length, width: img.width, height: img.height, data: img.data, staffUser: req.user._id, thread: t._id });
  const { msg, fresh } = await staffReply(req, t, { kind: 'image', media: media._id, width: img.width, height: img.height, text: cleanText(req.body && req.body.text).slice(0, MAX_LEN) });
  res.status(201).json({ success: true, message: forStaff(msg), thread: threadView(fresh) });
};

// GET /api/support/media/:id — للطاقم
exports.staffMedia = async (req, res) => {
  if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
  const md = await CustomerMedia.findById(req.params.id).select('+data').lean();
  if (!md || md.kind !== 'support') return bad(res, 'الصورة غير موجودة', 404);
  return sendMedia(res, md);
};

// POST /api/support/threads/:id/notes { text } — ملاحظة داخلية: للطاقم فقط
exports.note = async (req, res) => {
  const t = await loadThread(req, res); if (!t) return;
  const text = cleanText(req.body && req.body.text);
  if (!text) return bad(res, 'اكتب الملاحظة أولاً');
  if (text.length > MAX_LEN) return bad(res, `الملاحظة أطول من ${MAX_LEN} حرف`);
  const msg = await SupportMessage.create({ thread: t._id, from: 'note', staffUser: req.user._id, staffName: req.user.name || '', text });
  const fresh = await SupportThread.findById(t._id).lean();
  notifyStaff('support.message', { thread: threadView(fresh), message: forStaff(msg) });
  res.status(201).json({ success: true, message: forStaff(msg), thread: threadView(fresh) });
};

// PATCH /api/support/threads/:id { status?, tags?, assign?: 'me' | 'none' | <userId> }
exports.update = async (req, res) => {
  const t = await loadThread(req, res); if (!t) return;
  const b = req.body || {};
  const set = {};
  if (b.status !== undefined) {
    if (!['open', 'closed'].includes(b.status)) return bad(res, 'حالة غير صالحة');
    set.status = b.status;
    if (b.status === 'closed') { set.unreadStaff = 0; set.awaitingSince = null; }
  }
  if (b.tags !== undefined) {
    if (!Array.isArray(b.tags)) return bad(res, 'وسوم غير صالحة');
    set.tags = [...new Set(b.tags.filter((x) => SupportThread.TAGS.includes(x)))];
  }
  if (b.assign !== undefined) {
    if (b.assign === 'none' || b.assign === null) { set.assignedTo = null; set.assignedName = ''; }
    else {
      const id = b.assign === 'me' ? String(req.user._id) : String(b.assign);
      const { users } = await supportStaff();
      const u = users.find((x) => x._id === id);
      if (!u) return bad(res, 'لا يمكن تعيينها لهذا المستخدم (لا يملك «رسائل الزبائن»)');
      set.assignedTo = id; set.assignedName = u.name;
    }
  }
  if (!Object.keys(set).length) return bad(res, 'لا تغيير');
  await SupportThread.updateOne({ _id: t._id }, { $set: set });
  const fresh = await SupportThread.findById(t._id).lean();
  notifyStaff('support.thread', { thread: threadView(fresh) });
  if (set.status) logActivity({ req, action: set.status === 'closed' ? 'support.close' : 'support.reopen', details: { phone: localJo(t.phone), name: t.name || '' } });
  if (b.assign !== undefined) logActivity({ req, action: 'support.assign', details: { phone: localJo(t.phone), to: fresh.assignedName || '—' } });
  res.json({ success: true, thread: threadView(fresh) });
};
// للتوافق مع الإصدار السابق من لوحة التحكم (PATCH { status })
exports.setStatus = exports.update;

// DELETE /api/support/messages/:id — حذف رسالة (تختفي عن الزبون، ويبقى أثرها للطاقم)
exports.deleteMessage = async (req, res) => {
  if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
  const m = await SupportMessage.findById(req.params.id).lean();
  if (!m) return bad(res, 'الرسالة غير موجودة', 404);
  if (m.deleted) return res.json({ success: true, already: true });
  await SupportMessage.updateOne({ _id: m._id }, { $set: { deleted: true, deletedByName: req.user.name || '', deletedAt: new Date() } });
  if (m.media) await CustomerMedia.updateOne({ _id: m.media }, { $set: { deleted: true } });
  const t = await SupportThread.findById(m.thread).lean();
  if (t && m.from !== 'note') cr().sendToCustomer(t.phoneUser, { type: 'support.delete', id: String(m._id) });
  notifyStaff('support.delete', { threadId: String(m.thread), id: String(m._id), byName: req.user.name || '' });
  logActivity({ req, action: 'support.delete', details: { phone: t ? localJo(t.phone) : '', from: m.from, text: String(m.text || '').slice(0, 80) } });
  res.json({ success: true });
};

// GET /api/support/settings — الأسئلة السريعة والردود الجاهزة (لكل من يرد)
exports.getSettings = async (req, res) => res.json({ success: true, settings: await settings(), tags: SupportThread.TAGS });

// PUT /api/support/settings — لمن يملك «إعدادات المطعم»
exports.saveSettings = async (req, res) => {
  const b = req.body || {};
  const set = {};
  const lines = (v, max, len) => (Array.isArray(v) ? v : String(v || '').split('\n')).map((x) => cleanText(x).slice(0, len)).filter(Boolean).slice(0, max);
  if (b.quickQuestions !== undefined) set.quickQuestions = lines(b.quickQuestions, 8, 60);
  if (b.cannedReplies !== undefined) {
    if (!Array.isArray(b.cannedReplies)) return bad(res, 'الردود الجاهزة غير صالحة');
    set.cannedReplies = b.cannedReplies.map((r) => ({ title: cleanText(r && r.title).slice(0, 40), text: cleanText(r && r.text).slice(0, MAX_LEN) }))
      .filter((r) => r.title && r.text).slice(0, 30);
  }
  if (b.autoReplyEnabled !== undefined) set.autoReplyEnabled = !!b.autoReplyEnabled;
  if (b.autoReplyText !== undefined) set.autoReplyText = cleanText(b.autoReplyText).slice(0, 500);
  if (b.retentionDays !== undefined) set.retentionDays = Math.max(0, Math.min(3650, parseInt(b.retentionDays, 10) || 0));
  await settings();
  await SupportSetting.updateOne({ key: 'settings' }, { $set: set });
  settingsCache = { at: 0, doc: null };
  const s = await settings();
  logActivity({ req, action: 'support.settings', details: { quick: (s.quickQuestions || []).length, canned: (s.cannedReplies || []).length, auto: s.autoReplyEnabled, retentionDays: s.retentionDays } });
  res.json({ success: true, settings: s });
};

/* ── مدة الاحتفاظ (اختيارية — 0 = بلا حذف): تُمسح الرسائل والصور الأقدم منها ── */
async function cleanupOnce() {
  const s = await settings();
  const days = Number(s.retentionDays) || 0;
  if (!days) return { messages: 0, media: 0 };
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
  const a = await SupportMessage.deleteMany({ createdAt: { $lt: cutoff } });
  const b = await CustomerMedia.deleteMany({ kind: 'support', createdAt: { $lt: cutoff } });
  const out = { messages: (a && a.deletedCount) || 0, media: (b && b.deletedCount) || 0 };
  if (out.messages || out.media) console.log(`🧹 رسائل الزبائن: حُذفت ${out.messages} رسالة و${out.media} صورة أقدم من ${days} يوماً`);
  return out;
}
function startRetention() {
  const run = () => cleanupOnce().catch((e) => console.error('support retention:', e.message));
  const first = setTimeout(run, 60 * 1000); if (first.unref) first.unref();
  const iv = setInterval(run, 6 * 3600 * 1000); if (iv.unref) iv.unref();
}

exports.startRetention = startRetention;
exports.cleanupOnce = cleanupOnce;
exports._notifyStaff = notifyStaff;
exports._resetStaffCache = resetStaffCache;
exports._reset = () => { resetStaffCache(); settingsCache = { at: 0, doc: null }; };
