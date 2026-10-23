/*
  «الدردشة العامة» — غرفة واحدة لزبائن منصة ديار الأنباط (دخول برقم الهاتف) وفريق العمل.

  الزبون: اسم ظاهر + صورة شخصية + إطار/وسم بعدد طلباته المكتملة (services/customerProfileService).
          رقم هاتفه لا يظهر لأحد غير فريق العمل.
  الفلترة: كلمات ممنوعة يحددها الفريق + منع الروابط وأرقام الهواتف + وضع بطيء + حد 10 رسائل/دقيقة
           (في القاعدة نفسها — يصمد بعد إعادة التشغيل وعلى أكثر من نسخة من الخادم).
  الإشراف (community:moderate): فلترة العرض، حذف أي رسالة (وإرجاعها)، حظر مؤقت/دائم مع حذف رسائله،
           إزالة صورة أو اسم غير لائق، النشر باسم فريق العمل، والإعدادات. كل إجراء في «سجل النشاط».
*/
const mongoose = require('mongoose');
const CommunityMessage = require('../models/CommunityMessage');
const CommunitySetting = require('../models/CommunitySetting');
const CustomerProfile = require('../models/CustomerProfile');
const CustomerMedia = require('../models/CustomerMedia');
const P = require('../services/customerProfileService');
const textFilter = require('../utils/textFilter');
const { acceptImage } = require('../utils/imageSafe');
const { effectivePermissionsFor } = require('../utils/permissions');
const { logActivity } = require('../utils/activity');
const { localJo, phoneVariantsJo } = require('../utils/phone');

const MAX_LEN = 500;
const PAGE = 50;
const PER_MINUTE = 10;
const STAFF_AUTHOR = 'فريق ديار الأنباط';
const cr = () => require('../services/customerRealtime');
const validId = (id) => mongoose.isValidObjectId(id);
const bad = (res, message, status = 400, extra = {}) => res.status(status).json({ success: false, message, ...extra });
const clean = (raw) => String(raw == null ? '' : raw).replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F]/g, '').replace(/\n{3,}/g, '\n\n').trim();
const escRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ── الإعدادات (مخبّأة 10 ثوانٍ) ── */
let settingsCache = { at: 0, doc: null };
async function settings() {
  if (settingsCache.doc && Date.now() - settingsCache.at < 10000) return settingsCache.doc;
  let s = await CommunitySetting.findOne({ key: 'settings' }).lean();
  if (!s) {
    try { await CommunitySetting.create({ key: 'settings' }); } catch (_) { /* سباق: أُنشئت للتو */ }
    s = await CommunitySetting.findOne({ key: 'settings' }).lean();
  }
  settingsCache = { at: Date.now(), doc: s };
  return s;
}
const publicSettings = (s) => ({ enabled: s.enabled !== false, rules: s.rules || '', slowModeSeconds: s.slowModeSeconds || 0 });

/* ── المشرفون: يصلهم كل جديد فوراً عبر /ws الطاقم ── */
let modCache = { at: 0, ids: [] };
async function moderatorIds() {
  if (Date.now() - modCache.at < 20000) return modCache.ids;
  const User = require('../models/User');
  const users = await User.find({ isActive: true }).select('role permissions').lean();
  modCache = { at: Date.now(), ids: users.filter((u) => effectivePermissionsFor(u).includes('community:moderate')).map((u) => String(u._id)) };
  return modCache.ids;
}
async function notifyModerators(payload) {
  try {
    const rt = require('../services/realtimeService');
    const ids = await moderatorIds();
    if (ids.length && rt.sendToUsers) rt.sendToUsers(ids, payload);
  } catch (e) { console.error('community notify:', e.message); }
}

/* ── العرض ── */
async function hydrate(list) {
  const pids = [...new Set(list.map((m) => m.profile && String(m.profile)).filter(Boolean))];
  const rids = [...new Set(list.map((m) => m.replyTo && String(m.replyTo)).filter(Boolean))];
  const [profiles, replies] = await Promise.all([
    pids.length ? CustomerProfile.find({ _id: { $in: pids } }).lean() : [],
    rids.length ? CommunityMessage.find({ _id: { $in: rids } }).lean() : [],
  ]);
  const byProfile = new Map(profiles.map((p) => [String(p._id), p]));
  const rp = replies.map((r) => r.profile && String(r.profile)).filter((id) => id && !byProfile.has(id));
  if (rp.length) (await CustomerProfile.find({ _id: { $in: rp } }).lean()).forEach((p) => byProfile.set(String(p._id), p));
  return { byProfile, byReply: new Map(replies.map((r) => [String(r._id), r])) };
}
function authorOf(m, byProfile) {
  if (m.from === 'staff') return { staff: true, name: STAFF_AUTHOR, staffName: m.staffName || '', avatar: '', orderCount: 0, tier: null };
  return P.publicAuthor(byProfile.get(String(m.profile)));
}
function replyView(m, ctx) {
  if (!m.replyTo) return null;
  const r = ctx.byReply.get(String(m.replyTo));
  if (!r) return null;
  return { _id: String(r._id), name: authorOf(r, ctx.byProfile).name, text: r.deleted ? '' : String(r.text).slice(0, 120), deleted: !!r.deleted };
}
/** ما يراه الزبائن — بلا هواتف ولا معرّفات حسابات. */
function customerView(m, ctx) {
  return { _id: String(m._id), from: m.from, author: authorOf(m, ctx.byProfile), text: m.text, createdAt: m.createdAt, replyTo: replyView(m, ctx) };
}
/** ما يراه المشرف: + الرقم والحذف والبلاغات. */
function staffView(m, ctx) {
  const p = m.profile ? ctx.byProfile.get(String(m.profile)) : null;
  return {
    ...customerView(m, ctx),
    profileId: m.profile ? String(m.profile) : null,
    phone: p ? localJo(p.phone) : '',
    banned: p ? !!P.banState(p) : false,
    deleted: !!m.deleted, deletedByOwner: !!m.deletedByOwner, deletedByName: m.deletedByName || '', deletedReason: m.deletedReason || '', deletedAt: m.deletedAt || null,
    reportCount: m.reportCount || 0,
  };
}
async function views(list, kind) { const ctx = await hydrate(list); return list.map((m) => (kind === 'staff' ? staffView(m, ctx) : customerView(m, ctx))); }

function meView(p) {
  const ban = P.banState(p);
  return {
    id: String(p._id), displayName: p.displayName || '', avatar: P.avatarUrl(p), orderCount: p.orderCount || 0, tier: P.tierOf(p.orderCount),
    banned: !!ban, banUntil: ban ? ban.until : null, banReason: ban ? ban.reason : '',
  };
}
function memberView(p) {
  const ban = P.banState(p);
  return {
    id: String(p._id), name: p.displayName || '', phone: localJo(p.phone), avatar: P.avatarUrl(p), orderCount: p.orderCount || 0, tier: P.tierOf(p.orderCount),
    messages: p.communityMessages || 0, lastAt: p.lastCommunityAt || null,
    banned: !!ban, banUntil: ban ? ban.until : null, banReason: ban ? ban.reason : '', bannedBy: ban ? (p.communityBan.byName || '') : '',
  };
}
/** تغيّر اسم أو صورة: القوائم المفتوحة تحدّث صاحبها. */
function announceAuthor(p) {
  const payload = { type: 'community.author', author: P.publicAuthor(p) };
  cr().broadcastCommunity(payload);
  notifyModerators({ ...payload, member: memberView(p) });
}

/* ═════════════════ الزبون ═════════════════ */

// GET /api/community/me — ملفي (الاسم، الصورة، عدد الطلبات والإطار، الحظر)
exports.getMe = async (req, res) => {
  const p = await P.refreshOrderCount(await P.forPhoneUser(req.phoneUser));
  res.json({ success: true, profile: meView(p), tiers: P.TIERS });
};

// PUT /api/community/me { displayName }
exports.updateMe = async (req, res) => {
  const name = clean(req.body && req.body.displayName).replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 30) return bad(res, 'الاسم بين حرفين و30 حرفاً');
  if (/^[\d\s+]+$/.test(name)) return bad(res, 'اختر اسماً لا رقماً');
  const s = await settings();
  const chk = textFilter.check(name, { blockedWords: s.blockedWords, blockLinks: true, blockPhones: true });
  if (!chk.ok) return bad(res, 'هذا الاسم غير مسموح — اختر اسماً آخر', 422);
  if (/فريق|ديار\s*الانباط|ديار\s*الأنباط|إدارة|ادارة|admin|staff/i.test(name)) return bad(res, 'هذا الاسم محجوز لفريق العمل', 422);
  const p = await P.forPhoneUser(req.phoneUser);
  await CustomerProfile.updateOne({ _id: p._id }, { $set: { displayName: name } });
  p.displayName = name;
  announceAuthor(p);
  res.json({ success: true, profile: meView(p) });
};

// POST /api/community/me/avatar (file) — تُصغَّر في المتصفح، وهنا: تحقق + إزالة بيانات الموقع
exports.uploadAvatar = async (req, res) => {
  if (!req.file || !req.file.buffer) return bad(res, 'اختر صورة');
  const img = acceptImage(req.file.buffer, 600 * 1024);
  if (img.error) return bad(res, img.error, 415);
  const p = await P.forPhoneUser(req.phoneUser);
  const media = await CustomerMedia.create({ kind: 'avatar', mime: img.mime, size: img.data.length, width: img.width, height: img.height, data: img.data, phoneUser: req.phoneUser._id });
  const old = p.avatar;
  await CustomerProfile.updateOne({ _id: p._id }, { $set: { avatar: media._id } });
  if (old) await CustomerMedia.deleteOne({ _id: old });
  p.avatar = media._id;
  announceAuthor(p);
  res.status(201).json({ success: true, profile: meView(p) });
};

// DELETE /api/community/me/avatar
exports.removeAvatar = async (req, res) => {
  const p = await P.forPhoneUser(req.phoneUser);
  if (p.avatar) { await CustomerMedia.deleteOne({ _id: p.avatar }); await CustomerProfile.updateOne({ _id: p._id }, { $set: { avatar: null } }); p.avatar = null; announceAuthor(p); }
  res.json({ success: true, profile: meView(p) });
};

// GET /api/community/avatar/:id — عامة (تظهر في الدردشة العامة)؛ المعرّف يتغيّر مع كل صورة فتُخبّأ طويلاً
exports.avatar = async (req, res) => {
  if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
  const m = await CustomerMedia.findById(req.params.id).select('+data').lean();
  if (!m || m.kind !== 'avatar' || m.deleted || !m.data) return bad(res, 'غير موجودة', 404);
  const buf = Buffer.isBuffer(m.data) ? m.data : Buffer.from(m.data.buffer || m.data);
  res.set({ 'Content-Type': m.mime, 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=2592000, immutable', 'X-Content-Type-Options': 'nosniff' });
  res.end(buf);
};

// GET /api/community/messages?before=<ISO> — آخر 50 رسالة ظاهرة
exports.list = async (req, res) => {
  const s = await settings();
  const p = await P.refreshOrderCount(await P.forPhoneUser(req.phoneUser));
  const filter = { deleted: { $ne: true } };
  if (req.query.before) { const d = new Date(req.query.before); if (!isNaN(d)) filter.createdAt = { $lt: d }; }
  const rows = s.enabled === false ? [] : await CommunityMessage.find(filter).sort({ createdAt: -1 }).limit(PAGE).lean();
  res.json({
    success: true, settings: publicSettings(s), me: meView(p), online: cr().communityOnline(),
    messages: (await views(rows.reverse(), 'customer')), hasMore: rows.length === PAGE,
  });
};

// POST /api/community/messages { text, replyTo? }
exports.post = async (req, res) => {
  const s = await settings();
  if (s.enabled === false) return bad(res, 'الدردشة العامة متوقفة مؤقتاً', 403, { code: 'DISABLED' });
  const p = await P.refreshOrderCount(await P.forPhoneUser(req.phoneUser));
  if (!p.displayName) return bad(res, 'اختر اسمك الظاهر أولاً', 409, { code: 'NEED_NAME' });
  const ban = P.banState(p);
  if (ban) return bad(res, ban.until ? 'أنت موقوف عن الكتابة مؤقتاً' : 'أنت موقوف عن الكتابة في الدردشة العامة', 403, { code: 'BANNED', until: ban.until, reason: ban.reason });
  const text = clean(req.body && req.body.text);
  if (!text) return bad(res, 'اكتب رسالتك أولاً');
  if (text.length > MAX_LEN) return bad(res, `الرسالة أطول من ${MAX_LEN} حرف`);
  const chk = textFilter.check(text, s);
  if (!chk.ok) return bad(res, chk.message, 422, { code: 'FILTERED', reason: chk.reason });
  const slow = Number(s.slowModeSeconds) || 0;
  if (slow && p.lastCommunityAt) {
    const wait = Math.ceil((new Date(p.lastCommunityAt).getTime() + slow * 1000 - Date.now()) / 1000);
    if (wait > 0) return bad(res, `انتظر ${wait} ثانية قبل رسالتك التالية`, 429, { code: 'SLOW', retryAfter: wait });
  }
  const recent = await CommunityMessage.countDocuments({ phoneUser: req.phoneUser._id, createdAt: { $gte: new Date(Date.now() - 60000) } });
  if (recent >= PER_MINUTE) return bad(res, 'أرسلت رسائل كثيرة خلال دقيقة — انتظر قليلاً', 429, { code: 'RATE', retryAfter: 30 });
  let replyTo = null;
  if (req.body && req.body.replyTo) {
    if (!validId(req.body.replyTo)) return bad(res, 'رسالة الرد غير صالحة');
    const r = await CommunityMessage.findById(req.body.replyTo).select('deleted').lean();
    if (!r || r.deleted) return bad(res, 'الرسالة التي ترد عليها حُذفت', 404);
    replyTo = r._id;
  }
  const msg = await CommunityMessage.create({ from: 'customer', phoneUser: req.phoneUser._id, profile: p._id, text, replyTo });
  await CustomerProfile.updateOne({ _id: p._id }, { $set: { lastCommunityAt: msg.createdAt || new Date() }, $inc: { communityMessages: 1 } });
  p.communityMessages = (p.communityMessages || 0) + 1; p.lastCommunityAt = msg.createdAt;
  const plain = msg.toObject ? msg.toObject() : msg;
  const ctx = await hydrate([plain]);
  const view = customerView(plain, ctx);
  cr().broadcastCommunity({ type: 'community.message', message: view });
  notifyModerators({ type: 'community.message', message: staffView(plain, ctx), member: memberView(p) });
  res.status(201).json({ success: true, message: view });
};

// DELETE /api/community/messages/:id — حذف رسالتي
exports.removeOwn = async (req, res) => {
  if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
  const m = await CommunityMessage.findById(req.params.id).lean();
  if (!m || m.deleted) return bad(res, 'الرسالة غير موجودة', 404);
  if (String(m.phoneUser) !== String(req.phoneUser._id)) return bad(res, 'تحذف رسائلك فقط', 403);
  await CommunityMessage.updateOne({ _id: m._id }, { $set: { deleted: true, deletedByOwner: true, deletedByName: 'صاحب الرسالة', deletedAt: new Date() } });
  cr().broadcastCommunity({ type: 'community.delete', id: String(m._id) });
  notifyModerators({ type: 'community.delete', id: String(m._id), byOwner: true });
  res.json({ success: true });
};

// POST /api/community/messages/:id/report — إبلاغ فريق العمل عن رسالة
exports.report = async (req, res) => {
  if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
  const m = await CommunityMessage.findById(req.params.id).lean();
  if (!m || m.deleted) return bad(res, 'الرسالة غير موجودة', 404);
  if (String(m.phoneUser) === String(req.phoneUser._id)) return bad(res, 'لا يمكنك الإبلاغ عن رسالتك');
  if (m.from === 'staff') return bad(res, 'هذه رسالة من فريق العمل');
  if ((m.reports || []).some((r) => String(r.phoneUser) === String(req.phoneUser._id))) return res.json({ success: true, already: true });
  await CommunityMessage.updateOne({ _id: m._id }, { $push: { reports: { phoneUser: req.phoneUser._id, at: new Date() } }, $inc: { reportCount: 1 } });
  notifyModerators({ type: 'community.report', id: String(m._id), reportCount: (m.reportCount || 0) + 1 });
  res.json({ success: true });
};

/* ═════════════════ الإشراف (community:moderate) ═════════════════ */

// GET /api/community/admin/messages?q=&profile=&show=all|visible|deleted|reported&before=&limit=
exports.adminList = async (req, res) => {
  const f = {};
  const show = String(req.query.show || 'all');
  if (show === 'visible') f.deleted = { $ne: true };
  else if (show === 'deleted') f.deleted = true;
  else if (show === 'reported') { f.reportCount = { $gt: 0 }; f.deleted = { $ne: true }; }
  if (req.query.profile) { if (!validId(req.query.profile)) return bad(res, 'معرّف غير صالح'); f.profile = req.query.profile; }
  const q = clean(req.query.q).slice(0, 60);
  if (q) f.text = { $regex: escRx(q), $options: 'i' };
  if (req.query.before) { const d = new Date(req.query.before); if (!isNaN(d)) f.createdAt = { $lt: d }; }
  const limit = Math.min(200, Math.max(10, parseInt(req.query.limit, 10) || 100));
  const rows = await CommunityMessage.find(f).sort({ createdAt: -1 }).limit(limit).lean();
  const dayStart = new Date(Date.now() - 24 * 3600 * 1000);
  const [today, deleted, reported, members, banned] = await Promise.all([
    CommunityMessage.countDocuments({ createdAt: { $gte: dayStart } }),
    CommunityMessage.countDocuments({ deleted: true }),
    CommunityMessage.countDocuments({ reportCount: { $gt: 0 }, deleted: { $ne: true } }),
    CustomerProfile.countDocuments({ communityMessages: { $gt: 0 } }),
    CustomerProfile.countDocuments({ 'communityBan.banned': true }),
  ]);
  res.json({
    success: true, messages: await views(rows.reverse(), 'staff'), hasMore: rows.length === limit,
    stats: { today, deleted, reported, members, banned, online: cr().communityOnline() },
    settings: await settings(),
  });
};

// POST /api/community/admin/messages { text, replyTo? } — باسم «فريق ديار الأنباط»
exports.adminPost = async (req, res) => {
  const text = clean(req.body && req.body.text);
  if (!text) return bad(res, 'اكتب الرسالة أولاً');
  if (text.length > MAX_LEN) return bad(res, `الرسالة أطول من ${MAX_LEN} حرف`);
  let replyTo = null;
  if (req.body && req.body.replyTo) {
    if (!validId(req.body.replyTo)) return bad(res, 'رسالة الرد غير صالحة');
    const r = await CommunityMessage.findById(req.body.replyTo).select('_id').lean();
    if (!r) return bad(res, 'الرسالة غير موجودة', 404);
    replyTo = r._id;
  }
  const msg = await CommunityMessage.create({ from: 'staff', staffUser: req.user._id, staffName: req.user.name || '', text, replyTo });
  const plain = msg.toObject ? msg.toObject() : msg;
  const ctx = await hydrate([plain]);
  cr().broadcastCommunity({ type: 'community.message', message: customerView(plain, ctx) });
  notifyModerators({ type: 'community.message', message: staffView(plain, ctx) });
  logActivity({ req, action: 'community.post', details: { text: text.slice(0, 80) } });
  res.status(201).json({ success: true, message: staffView(plain, ctx) });
};

// DELETE /api/community/admin/messages/:id { reason? }
exports.adminDelete = async (req, res) => {
  if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
  const m = await CommunityMessage.findById(req.params.id).lean();
  if (!m) return bad(res, 'الرسالة غير موجودة', 404);
  if (m.deleted) return res.json({ success: true, already: true });
  const reason = clean(req.body && req.body.reason).slice(0, 120);
  await CommunityMessage.updateOne({ _id: m._id }, { $set: { deleted: true, deletedByOwner: false, deletedByName: req.user.name || '', deletedReason: reason, deletedAt: new Date() } });
  cr().broadcastCommunity({ type: 'community.delete', id: String(m._id) });
  notifyModerators({ type: 'community.delete', id: String(m._id), byName: req.user.name || '', reason });
  logActivity({ req, action: 'community.delete', details: { text: String(m.text).slice(0, 80), reason } });
  res.json({ success: true });
};

// POST /api/community/admin/messages/:id/restore — تراجع عن حذف بالخطأ
exports.adminRestore = async (req, res) => {
  if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
  const m = await CommunityMessage.findById(req.params.id).lean();
  if (!m) return bad(res, 'الرسالة غير موجودة', 404);
  if (m.deletedByOwner) return bad(res, 'حذفها صاحبها — لا تُعاد', 409);
  await CommunityMessage.updateOne({ _id: m._id }, { $set: { deleted: false, deletedByName: '', deletedReason: '', deletedAt: null, reportCount: 0, reports: [] } });
  const fresh = await CommunityMessage.findById(m._id).lean();
  const ctx = await hydrate([fresh]);
  cr().broadcastCommunity({ type: 'community.restore', message: customerView(fresh, ctx) });
  notifyModerators({ type: 'community.restore', message: staffView(fresh, ctx) });
  logActivity({ req, action: 'community.restore', details: { text: String(m.text).slice(0, 80) } });
  res.json({ success: true, message: staffView(fresh, ctx) });
};

// GET /api/community/admin/members?q=&banned=1
exports.adminMembers = async (req, res) => {
  const f = {};
  if (req.query.banned === '1') f['communityBan.banned'] = true;
  const q = clean(req.query.q).slice(0, 40);
  if (q) {
    const ors = [{ displayName: { $regex: escRx(q), $options: 'i' } }];
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 3) {
      ors.push({ phone: { $regex: escRx(digits.replace(/^0/, '')) } });
      phoneVariantsJo(q).forEach((v) => ors.push({ phone: v }));
    }
    f.$or = ors;
  } else if (req.query.banned !== '1') {
    f.$or = [{ communityMessages: { $gt: 0 } }, { displayName: { $ne: '' } }];
  }
  const list = await CustomerProfile.find(f).sort({ lastCommunityAt: -1, updatedAt: -1 }).limit(200).lean();
  res.json({ success: true, members: list.map(memberView) });
};

const loadProfile = async (req, res) => {
  if (!validId(req.params.id)) { bad(res, 'معرّف غير صالح'); return null; }
  const p = await CustomerProfile.findById(req.params.id);
  if (!p) { bad(res, 'العضو غير موجود', 404); return null; }
  return p;
};

// POST /api/community/admin/members/:id/ban { hours (0 = دائم), reason, purge }
exports.adminBan = async (req, res) => {
  const p = await loadProfile(req, res); if (!p) return;
  const hours = Math.max(0, Math.min(24 * 365, Number(req.body && req.body.hours) || 0));
  const reason = clean(req.body && req.body.reason).slice(0, 120);
  const until = hours ? new Date(Date.now() + hours * 3600 * 1000) : null;
  await CustomerProfile.updateOne({ _id: p._id }, { $set: { communityBan: { banned: true, until, reason, byName: req.user.name || '', at: new Date() } } });
  let purged = 0;
  if (req.body && req.body.purge) {
    const mine = await CommunityMessage.find({ profile: p._id, deleted: { $ne: true } }).select('_id').lean();
    if (mine.length) {
      await CommunityMessage.updateMany({ _id: { $in: mine.map((m) => m._id) } }, { $set: { deleted: true, deletedByName: req.user.name || '', deletedReason: 'حُذفت مع الحظر', deletedAt: new Date() } });
      purged = mine.length;
      mine.forEach((m) => cr().broadcastCommunity({ type: 'community.delete', id: String(m._id) }));
    }
  }
  const fresh = await CustomerProfile.findById(p._id).lean();
  cr().sendToCustomer(p.phoneUser, { type: 'community.banned', until, reason });
  notifyModerators({ type: 'community.member', member: memberView(fresh), purged });
  logActivity({ req, action: 'community.ban', details: { name: p.displayName || '', phone: localJo(p.phone), hours, reason, purged } });
  res.json({ success: true, member: memberView(fresh), purged });
};

// DELETE /api/community/admin/members/:id/ban
exports.adminUnban = async (req, res) => {
  const p = await loadProfile(req, res); if (!p) return;
  await CustomerProfile.updateOne({ _id: p._id }, { $set: { communityBan: { banned: false, until: null, reason: '', byName: '', at: null } } });
  const fresh = await CustomerProfile.findById(p._id).lean();
  cr().sendToCustomer(p.phoneUser, { type: 'community.unbanned' });
  notifyModerators({ type: 'community.member', member: memberView(fresh) });
  logActivity({ req, action: 'community.unban', details: { name: p.displayName || '', phone: localJo(p.phone) } });
  res.json({ success: true, member: memberView(fresh) });
};

// DELETE /api/community/admin/members/:id/avatar — صورة غير لائقة
exports.adminRemoveAvatar = async (req, res) => {
  const p = await loadProfile(req, res); if (!p) return;
  if (p.avatar) await CustomerMedia.deleteOne({ _id: p.avatar });
  await CustomerProfile.updateOne({ _id: p._id }, { $set: { avatar: null } });
  const fresh = await CustomerProfile.findById(p._id).lean();
  announceAuthor(fresh);
  logActivity({ req, action: 'community.avatar', details: { name: p.displayName || '', phone: localJo(p.phone) } });
  res.json({ success: true, member: memberView(fresh) });
};

// DELETE /api/community/admin/members/:id/name — اسم غير لائق: يختار الزبون اسماً جديداً قبل أن يكتب
exports.adminResetName = async (req, res) => {
  const p = await loadProfile(req, res); if (!p) return;
  await CustomerProfile.updateOne({ _id: p._id }, { $set: { displayName: '' } });
  const fresh = await CustomerProfile.findById(p._id).lean();
  announceAuthor(fresh);
  logActivity({ req, action: 'community.name', details: { name: p.displayName || '', phone: localJo(p.phone) } });
  res.json({ success: true, member: memberView(fresh) });
};

// GET /api/community/admin/settings
exports.adminGetSettings = async (req, res) => res.json({ success: true, settings: await settings() });

// PUT /api/community/admin/settings { enabled, blockedWords, blockLinks, blockPhones, slowModeSeconds, rules }
exports.adminSaveSettings = async (req, res) => {
  const b = req.body || {};
  const set = {};
  if (b.enabled !== undefined) set.enabled = !!b.enabled;
  if (b.blockLinks !== undefined) set.blockLinks = !!b.blockLinks;
  if (b.blockPhones !== undefined) set.blockPhones = !!b.blockPhones;
  if (b.slowModeSeconds !== undefined) set.slowModeSeconds = Math.max(0, Math.min(600, parseInt(b.slowModeSeconds, 10) || 0));
  if (b.rules !== undefined) set.rules = clean(b.rules).slice(0, 600);
  if (b.blockedWords !== undefined) {
    const arr = Array.isArray(b.blockedWords) ? b.blockedWords : String(b.blockedWords).split(/[\n,،]+/);
    set.blockedWords = [...new Set(arr.map((w) => clean(w).slice(0, 40)).filter(Boolean))].slice(0, 500);
  }
  await settings();
  await CommunitySetting.updateOne({ key: 'settings' }, { $set: set });
  settingsCache = { at: 0, doc: null };
  const s = await settings();
  cr().broadcastCommunity({ type: 'community.settings', settings: publicSettings(s) });
  notifyModerators({ type: 'community.settings', settings: s });
  logActivity({ req, action: 'community.settings', details: { enabled: s.enabled, words: (s.blockedWords || []).length, slow: s.slowModeSeconds, links: s.blockLinks, phones: s.blockPhones } });
  res.json({ success: true, settings: s });
};

exports._notifyModerators = notifyModerators;
exports._reset = () => { settingsCache = { at: 0, doc: null }; modCache = { at: 0, ids: [] }; };
