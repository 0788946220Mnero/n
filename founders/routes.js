/*
  ═══════════════════════════════════════════════════════════════
  /api/founders — ديون الشركة والمؤسسون.

  ثلاث طبقات:
   1) /auth/*      دخول الواجهة المستقلة بحساب اللوحة نفسه (المستخدم الذي عليه دور «مؤسس»).
                   جلستها منفصلة: الدخول هنا لا يُخرج جلسة لوحة التحكم.
   2) /*           للمؤسس (توكن الواجهة المستقلة): الديون والدفع بالتوقيع ولقطة الوجه،
                   حسابه البنكي، الملفات الشخصية، المنشورات والقوانين، الدردشة، الإشعارات والمكالمات.
   3) /admin/*     للوحة التحكم (protect + founders:manage). الختم والتصحيح لمدير النظام وحده.
  ═══════════════════════════════════════════════════════════════
*/
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const { asyncHandler } = require('../utils/asyncHandler');
const { logActivity } = require('../utils/activity');
const { protect } = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/permission');
const User = require('../models/User');
const {
  FounderProfile, FounderSettings, CompanyDebt, DebtPayment, FounderLedger,
  FounderPost, FounderComment, FounderMessage, FounderDevice, nextNumber,
} = require('./models');
const L = require('./ledger');
const hub = require('./hub');

const r3 = L.r3;
const EPS = L.EPS;
const a = asyncHandler;
const bad = (res, message, code = 400, extra = {}) => res.status(code).json({ success: false, message, ...extra });
const validId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''));
const nameOf = (u) => (u && (u.name || u.username)) || '';
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const money = (v) => `${Number(v || 0).toFixed(3)} د.أ`;
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 64);

const SIG_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const JPEG_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
const IMG_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const AUDIO_RE = /^data:audio\/(webm|mp4|mpeg|ogg|aac|x-m4a)(;codecs=[a-z0-9.,]+)?;base64,[A-Za-z0-9+/=]+$/i;
const validSig = (s) => SIG_RE.test(s) && s.length <= 300000;
const validFace = (s) => JPEG_RE.test(s) && s.length <= 450000;
const validImg = (s, max = 900000) => IMG_RE.test(s) && s.length <= max;
const validAudio = (s) => AUDIO_RE.test(s) && s.length <= 2600000;

const KIND_LABEL = { founding_fee: 'رسوم تأسيس (قسط دين شركة مختوم)', deposit: 'مبلغ دفعه للشركة', shares: 'شراء أسهم', spent: 'صرفه على الشركة من ماله' };

async function settings({ withStamp = false } = {}) {
  let s = await FounderSettings.findOne({ key: 'main' }).select(withStamp ? '+stampImage' : '').lean();
  if (!s) { await FounderSettings.create({ key: 'main' }); s = await FounderSettings.findOne({ key: 'main' }).select(withStamp ? '+stampImage' : '').lean(); }
  return s;
}

/** ملف عام لمؤسس (للقوائم والمنشورات والدردشة). */
function publicProfile(u, p) {
  return {
    _id: String(u._id), username: u.username, name: (p && p.displayName) || u.name || u.username,
    title: (p && p.title) || 'مؤسس', bio: (p && p.bio) || '', phone: (p && p.phone) || '', photo: (p && p.photo) || '', cover: (p && p.cover) || '',
    sharePct: (p && p.sharePct) || 0, joinedAt: (p && p.joinedAt) || u.createdAt, lastSeenAt: (p && p.lastSeenAt) || null,
    online: hub.isOnline(u._id), role: u.role,
  };
}
async function founders() {
  const users = await User.find({ isFounder: true, isActive: { $ne: false } }).select('name username role createdAt').lean();
  const profs = await FounderProfile.find({ user: { $in: users.map((u) => u._id) } }).lean();
  const byUser = new Map(profs.map((p) => [String(p.user), p]));
  return users.map((u) => publicProfile(u, byUser.get(String(u._id))));
}

/* ═════════ حسابات الديون ═════════ */

async function debtSummary(debt) {
  const pays = await DebtPayment.find({ debt: debt._id, status: { $in: ['review', 'stamped'] } }).select('amount status installmentMonth').lean();
  return L.summarize(debt, pays);
}
async function debtsFor(user, { admin = false, status } = {}) {
  const q = { status: status || { $ne: 'archived' } };
  if (!admin) q.$or = [{ scope: 'company' }, { scope: 'personal', owner: user._id }];
  const debts = await CompanyDebt.find(q).sort({ scope: 1, number: 1 }).lean();
  const out = [];
  for (const d of debts) out.push(await debtSummary(d));
  return out;
}
function totalsOf(list) {
  const sum = (k, f = () => true) => r3(list.filter(f).reduce((t, d) => t + d[k], 0));
  const co = (d) => d.scope === 'company';
  return {
    company: { total: sum('totalAmount', co), paid: sum('paid', co), remaining: sum('remaining', co), arrears: sum('arrears', co), monthly: sum('monthlyInstallment', (d) => co(d) && d.remaining > EPS), pending: sum('pending', co) },
    personal: { total: sum('totalAmount', (d) => !co(d)), paid: sum('paid', (d) => !co(d)), remaining: sum('remaining', (d) => !co(d)), arrears: sum('arrears', (d) => !co(d)), monthly: sum('monthlyInstallment', (d) => !co(d) && d.remaining > EPS), pending: sum('pending', (d) => !co(d)) },
  };
}

async function accountOf(founderId) {
  const rows = await FounderLedger.find({ founder: founderId }).sort({ date: -1, number: -1 }).lean();
  const by = { founding_fee: 0, deposit: 0, shares: 0, spent: 0 };
  let shares = 0;
  rows.forEach((r) => { by[r.kind] = r3(by[r.kind] + r.amount); if (r.kind === 'shares') shares += Number(r.sharesCount) || 0; });
  const balance = r3(Object.values(by).reduce((t, v) => t + v, 0));
  return { balance, byKind: by, sharesCount: shares, entries: rows.map((r) => ({ ...r, kindLabel: KIND_LABEL[r.kind], corrections: r.corrections || [] })) };
}

const paymentView = (p) => ({
  _id: p._id, number: p.number, debt: p.debt, debtTitle: p.debtTitle, scope: p.scope, payer: p.payer, payerName: p.payerName,
  amount: p.amount, forMonth: p.forMonth, forMonthLabel: L.monthLabel(p.forMonth), status: p.status, reviewNote: p.reviewNote,
  installmentMonth: p.installmentMonth || '', installmentLabel: L.monthLabel(p.installmentMonth), installmentAmount: p.installmentAmount || 0, partial: !!p.partial,
  stampedByName: p.stampedByName, stampedAt: p.stampedAt, rejectedByName: p.rejectedByName, rejectedAt: p.rejectedAt,
  createdAt: p.createdAt, corrections: p.corrections || [], ledgerEntry: p.ledgerEntry,
});

/** رؤية دفعة: دين الشركة لكل المؤسسين، والشخصي لصاحبه فقط. */
const canSeePayment = (user, p) => p.scope === 'company' || String(p.payer) === String(user._id);

/* ═════════ مصادقة الواجهة المستقلة ═════════ */

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'محاولات كثيرة — حاول بعد ربع ساعة' } });

function signFounder(user, fsid) {
  return jwt.sign({ id: String(user._id), aud: 'founders', fsid }, process.env.JWT_SECRET, { expiresIn: '60d' });
}

const fauth = a(async (req, res, next) => {
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Bearer ')) return bad(res, 'سجّل الدخول أولاً', 401);
  let who;
  try { who = await hub.verifyToken(h.slice(7)); } catch (e) {
    return bad(res, e.message === 'session' ? 'تم الدخول بحسابك من جهاز آخر' : 'انتهت الجلسة — سجّل الدخول من جديد', 401, { code: e.message === 'session' ? 'SESSION_REPLACED' : 'AUTH' });
  }
  req.user = who.user; req.founder = who.prof;
  next();
});

/* ═════════════════════════════════ الراوتر ═════════════════════════════════ */

function router() {
  const r = express.Router();

  /* ─────────── الدخول ─────────── */
  r.post('/auth/login', loginLimiter, a(async (req, res) => {
    const username = str(req.body && req.body.username, 60).toLowerCase();
    const password = String((req.body && req.body.password) || '');
    if (!username || !password) return bad(res, 'اكتب اسم المستخدم وكلمة المرور');
    const user = await User.findOne({ username }).select('+password');
    if (!user || !(await user.comparePassword(password))) return bad(res, 'اسم المستخدم أو كلمة المرور غير صحيحة', 401);
    if (user.isActive === false) return bad(res, 'الحساب موقوف', 403);
    if (!user.isFounder) return bad(res, 'هذا الحساب ليس عليه دور «مؤسس» — يضيفه مدير النظام من لوحة التحكم', 403);
    const fsid = crypto.randomBytes(16).toString('hex');
    await FounderProfile.findOneAndUpdate({ user: user._id }, { $set: { sessionId: fsid, active: true }, $setOnInsert: { displayName: user.name } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    logActivity({ req, user, action: 'founders.login', details: { app: 'الواجهة المستقلة للمؤسسين' } });
    const prof = await FounderProfile.findOne({ user: user._id }).lean();
    res.json({ success: true, token: signFounder(user, fsid), me: publicProfile(user, prof) });
  }));
  r.post('/auth/logout', fauth, a(async (req, res) => {
    await FounderProfile.updateOne({ user: req.user._id }, { $set: { sessionId: crypto.randomBytes(16).toString('hex') } });
    await FounderDevice.deleteMany({ user: req.user._id, key: str(req.body && req.body.deviceKey, 2000) || '__none__' });
    res.json({ success: true });
  }));

  /* ─────────── المؤسس ─────────── */
  r.get('/me', fauth, a(async (req, res) => {
    const s = await settings();
    res.json({ success: true, me: publicProfile(req.user, req.founder), companyName: s.companyName, notice: s.notice, vapidKey: require('../services/liveReportService').publicKey(), ringingCall: hub.callFor(req.user._id) });
  }));

  r.get('/overview', fauth, a(async (req, res) => {
    const s = await settings();
    const debts = await debtsFor(req.user);
    const account = await accountOf(req.user._id);
    const recent = await DebtPayment.find({ $or: [{ scope: 'company' }, { payer: req.user._id }] }).sort({ createdAt: -1 }).limit(15).lean();
    res.json({
      success: true, month: L.monthNow(), monthLabel: L.monthLabel(L.monthNow()), companyName: s.companyName, notice: s.notice, hasStamp: !!s.stampUpdatedAt,
      debts, totals: totalsOf(debts), account: { balance: account.balance, byKind: account.byKind, sharesCount: account.sharesCount },
      recent: recent.map(paymentView),
    });
  }));

  r.get('/debts/:id', fauth, a(async (req, res) => {
    if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
    const d = await CompanyDebt.findById(req.params.id).lean();
    if (!d || d.status === 'archived' || (d.scope === 'personal' && String(d.owner) !== String(req.user._id))) return bad(res, 'الدين غير موجود', 404);
    const pays = await DebtPayment.find({ debt: d._id }).sort({ createdAt: -1 }).lean();
    res.json({ success: true, debt: L.summarize(d, pays.filter((p) => p.status !== 'rejected')), payments: pays.map(paymentView), corrections: d.corrections || [] });
  }));

  // الدفع: توقيع يدوي جديد + لقطة وجه في كل مرة ← قيد المراجعة حتى ختم مدير النظام
  r.post('/debts/:id/pay', fauth, a(async (req, res) => {
    if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
    const b = req.body || {};
    const d = await CompanyDebt.findById(req.params.id).lean();
    if (!d || d.status === 'archived') return bad(res, 'الدين غير موجود', 404);
    if (d.status !== 'active') return bad(res, 'الدين مغلق — لا يُدفع');
    if (d.scope === 'personal' && String(d.owner) !== String(req.user._id)) return bad(res, 'هذا دين شخصي لمؤسس آخر', 403);
    const amount = r3(b.amount);
    const sig = String(b.signature || '');
    const face = String(b.face || '');
    if (!validSig(sig)) return bad(res, 'التوقيع اليدوي إجباري — وقّع على الشاشة', 400, { code: 'SIGNATURE_REQUIRED' });
    if (!validFace(face)) return bad(res, 'لقطة الوجه إجبارية — اسمح بالكاميرا والتقط صورة لوجهك', 400, { code: 'FACE_REQUIRED' });
    const sum = await debtSummary(d);
    if (!(amount > 0)) return bad(res, 'اكتب مبلغ الدفعة');
    // الدفع على قسط بعينه: كاملاً أو جزءاً منه، ولا يتجاوز المفتوح منه
    const instMonth = b.installmentMonth ? String(b.installmentMonth) : '';
    let inst = null;
    if (instMonth) {
      inst = sum.schedule.find((x) => x.month === instMonth);
      if (!inst) return bad(res, 'القسط غير موجود في جدول هذا الدين');
      if (inst.open <= EPS) return bad(res, inst.state === 'paid' ? 'هذا القسط مدفوع بالكامل' : 'المتبقي من هذا القسط قيد المراجعة');
      if (amount > inst.open + EPS) return bad(res, `أكثر من المتبقي من قسط ${inst.label} (${money(inst.open)})`, 400, { open: inst.open });
    }
    if (amount > sum.payable + EPS) return bad(res, `أكثر من المتبقي القابل للدفع (${money(sum.payable)})`, 400, { payable: sum.payable });
    const p = await DebtPayment.create({
      number: await nextNumber('debtPayment'), debt: d._id, debtTitle: d.title, scope: d.scope,
      payer: req.user._id, payerName: req.founder.displayName || nameOf(req.user), amount, forMonth: L.monthNow(),
      installmentMonth: inst ? inst.month : '', installmentAmount: inst ? inst.amount : 0, partial: !!inst && amount < inst.amount - EPS, // أقل من قيمة القسط = جزء منه
      signature: sig, facePhoto: face, status: 'review', ip: ipOf(req), ua: str(req.headers['user-agent'], 250),
    });
    // حماية من دفعتين متزامنتين تتجاوزان المتبقي
    const after = await debtSummary(d);
    const afterInst = inst ? after.schedule.find((x) => x.month === inst.month) : null;
    const overInst = afterInst && r3(afterInst.covered + afterInst.inReview) > afterInst.amount + EPS;
    if (after.payable < -EPS || overInst) { await DebtPayment.deleteOne({ _id: p._id }); return bad(res, 'سبقتك دفعة أخرى على الدين نفسه — حدّث الصفحة', 409); }
    logActivity({ req, action: 'founders.pay', amount, details: { debt: d.title, number: p.number, scope: d.scope === 'company' ? 'دين الشركة' : 'دين شخصي' } });
    const ids = d.scope === 'company' ? await hub.founderIds() : [String(req.user._id)];
    await hub.notifyFounders(ids, { type: 'payment.new', payment: paymentView(p.toObject()), debtId: String(d._id) }, {
      type: 'payment.new', tag: `fpay-${p._id}`, title: `💳 ${p.payerName} دفع ${money(amount)}`,
      body: `${d.title}${inst ? ` — قسط ${inst.label}${p.partial ? ' (جزء)' : ''}` : ''} — بتوقيعه، بانتظار ختم مدير النظام`, url: `./#debt=${d._id}`,
    });
    res.status(201).json({ success: true, payment: paymentView(p.toObject()), debt: after });
  }));

  // السند للطباعة: التوقيع والصورة، والختم إن خُتم
  r.get('/payments/:id', fauth, a(async (req, res) => {
    if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
    const p = await DebtPayment.findById(req.params.id).select('+signature +facePhoto').lean();
    if (!p || !canSeePayment(req.user, p)) return bad(res, 'السند غير موجود', 404);
    res.json({ success: true, payment: { ...paymentView(p), signature: p.signature, facePhoto: p.facePhoto }, ...(await receiptExtras(p)) });
  }));

  r.get('/account', fauth, a(async (req, res) => {
    res.json({ success: true, account: await accountOf(req.user._id), kinds: KIND_LABEL });
  }));

  /* ─────────── الملفات الشخصية ─────────── */
  r.get('/founders', fauth, a(async (req, res) => { res.json({ success: true, founders: await founders(), online: hub.onlineIds() }); }));
  r.get('/founders/:id', fauth, a(async (req, res) => {
    if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
    const u = await User.findOne({ _id: req.params.id, isFounder: true }).select('name username role createdAt').lean();
    if (!u) return bad(res, 'المؤسس غير موجود', 404);
    const p = await FounderProfile.findOne({ user: u._id }).lean();
    // قوانينه: الموجّهة له بالاسم + العامة لكل المؤسسين
    const laws = (await FounderPost.find({ kind: 'law', deleted: { $ne: true } }).sort({ createdAt: -1 }).limit(200).lean())
      .filter((x) => !(x.founders || []).length || x.founders.map(String).includes(String(u._id))).slice(0, 50);
    const posts = await FounderPost.find({ kind: 'post', author: u._id, deleted: { $ne: true } }).sort({ createdAt: -1 }).limit(20).lean();
    res.json({ success: true, founder: publicProfile(u, p), laws: laws.map((x) => postView(x, req.user)), posts: posts.map((x) => postView(x, req.user)) });
  }));
  r.put('/profile', fauth, a(async (req, res) => {
    const b = req.body || {};
    const set = {};
    if (b.displayName != null) set.displayName = str(b.displayName, 80);
    if (b.bio != null) set.bio = str(b.bio, 600);
    if (b.phone != null) set.phone = str(b.phone, 20);
    if (b.photo != null) { if (b.photo && !validImg(b.photo, 280000)) return bad(res, 'الصورة كبيرة أو غير صالحة'); set.photo = b.photo; }
    if (b.cover != null) { if (b.cover && !validImg(b.cover, 600000)) return bad(res, 'صورة الغلاف كبيرة أو غير صالحة'); set.cover = b.cover; }
    await FounderProfile.updateOne({ user: req.user._id }, { $set: set });
    const p = await FounderProfile.findOne({ user: req.user._id }).lean();
    const me = publicProfile(req.user, p);
    hub.emit(null, { type: 'profile', founder: me });
    res.json({ success: true, me });
  }));

  /* ─────────── المنشورات والقوانين ─────────── */
  r.get('/posts', fauth, a(async (req, res) => {
    const q = { deleted: { $ne: true } };
    if (req.query.kind === 'law') q.kind = 'law';
    if (req.query.before && !Number.isNaN(Date.parse(req.query.before))) q.createdAt = { $lt: new Date(req.query.before) };
    const posts = await FounderPost.find(q).sort({ createdAt: -1 }).limit(20).lean();
    const pinned = !req.query.before ? await FounderPost.find({ deleted: { $ne: true }, pinned: true }).sort({ createdAt: -1 }).limit(5).lean() : [];
    res.json({ success: true, posts: posts.map((p) => postView(p, req.user)), pinned: pinned.map((p) => postView(p, req.user)) });
  }));
  r.post('/posts', fauth, a(async (req, res) => {
    const b = req.body || {};
    const text = str(b.text, 8000);
    const images = (Array.isArray(b.images) ? b.images : []).slice(0, 4).map(String);
    if (images.some((i) => !validImg(i))) return bad(res, 'صورة غير صالحة أو كبيرة جداً');
    if (!text && !images.length) return bad(res, 'اكتب شيئاً أو أضف صورة');
    const p = await FounderPost.create({ kind: 'post', text, images, author: req.user._id, authorName: req.founder.displayName || nameOf(req.user) });
    const view = postView(p.toObject(), req.user);
    const ids = (await hub.founderIds()).filter((i) => i !== String(req.user._id));
    hub.emit(null, { type: 'post.new', post: view });
    hub.push(ids, { type: 'post.new', tag: `fpost-${p._id}`, title: `📝 ${p.authorName} نشر منشوراً`, body: text || '📷 صورة', url: `./#post=${p._id}` }, { skipOnline: true });
    res.status(201).json({ success: true, post: view });
  }));
  r.delete('/posts/:id', fauth, a(async (req, res) => {
    if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
    const p = await FounderPost.findById(req.params.id).lean();
    if (!p || p.deleted) return bad(res, 'المنشور غير موجود', 404);
    if (p.kind === 'law') return bad(res, 'القوانين تُدار من لوحة التحكم فقط', 403);
    if (String(p.author) !== String(req.user._id)) return bad(res, 'تحذف منشوراتك فقط', 403);
    await FounderPost.updateOne({ _id: p._id }, { $set: { deleted: true } });
    hub.emit(null, { type: 'post.deleted', postId: String(p._id) });
    res.json({ success: true });
  }));
  r.post('/posts/:id/like', fauth, a(async (req, res) => {
    if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
    const p = await FounderPost.findById(req.params.id).lean();
    if (!p || p.deleted) return bad(res, 'المنشور غير موجود', 404);
    const me = String(req.user._id);
    const liked = (p.likes || []).map(String).includes(me);
    const likes = liked ? p.likes.filter((x) => String(x) !== me) : [...(p.likes || []), req.user._id];
    await FounderPost.updateOne({ _id: p._id }, { $set: { likes } });
    hub.emit(null, { type: 'post.likes', postId: String(p._id), likes: likes.map(String) });
    if (!liked && String(p.author) !== me && p.kind === 'post') hub.push([String(p.author)], { type: 'post.like', tag: `flike-${p._id}`, title: `👍 ${req.founder.displayName || nameOf(req.user)} أعجبه منشورك`, body: str(p.text, 80) || '📷', url: `./#post=${p._id}` }, { skipOnline: true });
    res.json({ success: true, liked: !liked, likes: likes.map(String) });
  }));
  r.get('/posts/:id/comments', fauth, a(async (req, res) => {
    if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
    const list = await FounderComment.find({ post: req.params.id, deleted: { $ne: true } }).sort({ createdAt: 1 }).limit(300).lean();
    res.json({ success: true, comments: list.map((c) => commentView(c, req.user)) });
  }));
  r.post('/posts/:id/comments', fauth, a(async (req, res) => {
    if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
    const p = await FounderPost.findById(req.params.id).lean();
    if (!p || p.deleted) return bad(res, 'المنشور غير موجود', 404);
    const text = str(req.body && req.body.text, 2000);
    if (!text) return bad(res, 'اكتب تعليقك');
    const c = await FounderComment.create({ post: p._id, author: req.user._id, authorName: req.founder.displayName || nameOf(req.user), text });
    await FounderPost.updateOne({ _id: p._id }, { $inc: { commentsCount: 1 } });
    const view = commentView(c.toObject(), req.user);
    hub.emit(null, { type: 'comment.new', postId: String(p._id), comment: view });
    // صاحب المنشور + من علّق قبله
    const prev = await FounderComment.find({ post: p._id, deleted: { $ne: true } }).select('author').lean();
    const ids = [...new Set([String(p.author), ...prev.map((x) => String(x.author))])].filter((i) => i !== String(req.user._id));
    hub.push(ids, { type: 'comment.new', tag: `fcom-${p._id}`, title: `💬 ${c.authorName} علّق`, body: text, url: `./#post=${p._id}` }, { skipOnline: true });
    res.status(201).json({ success: true, comment: view });
  }));
  r.post('/comments/:id/like', fauth, a(async (req, res) => {
    if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
    const c = await FounderComment.findById(req.params.id).lean();
    if (!c || c.deleted) return bad(res, 'التعليق غير موجود', 404);
    const me = String(req.user._id);
    const liked = (c.likes || []).map(String).includes(me);
    const likes = liked ? c.likes.filter((x) => String(x) !== me) : [...(c.likes || []), req.user._id];
    await FounderComment.updateOne({ _id: c._id }, { $set: { likes } });
    hub.emit(null, { type: 'comment.likes', postId: String(c.post), commentId: String(c._id), likes: likes.map(String) });
    res.json({ success: true, liked: !liked, likes: likes.map(String) });
  }));
  r.delete('/comments/:id', fauth, a(async (req, res) => {
    if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
    const c = await FounderComment.findById(req.params.id).lean();
    if (!c || c.deleted) return bad(res, 'التعليق غير موجود', 404);
    if (String(c.author) !== String(req.user._id)) return bad(res, 'تحذف تعليقاتك فقط', 403);
    await FounderComment.updateOne({ _id: c._id }, { $set: { deleted: true } });
    await FounderPost.updateOne({ _id: c.post }, { $inc: { commentsCount: -1 } });
    hub.emit(null, { type: 'comment.deleted', postId: String(c.post), commentId: String(c._id) });
    res.json({ success: true });
  }));

  /* ─────────── الدردشة ─────────── */
  const dmKey = (a1, b1) => `dm:${[String(a1), String(b1)].sort().join(':')}`;
  const convMembers = async (conv, me) => {
    if (conv === 'group') return hub.founderIds();
    const parts = String(conv).split(':');
    if (parts.length !== 3 || parts[0] !== 'dm' || !parts.includes(String(me))) return null;
    return parts.slice(1);
  };
  r.get('/chat/convs', fauth, a(async (req, res) => {
    const me = String(req.user._id);
    const list = (await founders()).filter((f) => f._id !== me);
    const convs = [{ conv: 'group', name: 'مجموعة المؤسسين', group: true }, ...list.map((f) => ({ conv: dmKey(me, f._id), name: f.name, photo: f.photo, peer: f._id, online: f.online, title: f.title }))];
    for (const c of convs) {
      const last = await FounderMessage.findOne({ conv: c.conv, deleted: { $ne: true } }).sort({ createdAt: -1 }).lean();
      c.last = last ? { text: last.text || (last.image ? '📷 صورة' : last.audio ? '🎤 رسالة صوتية' : ''), fromName: last.fromName, from: String(last.from), at: last.createdAt } : null;
      c.unread = await FounderMessage.countDocuments({ conv: c.conv, from: { $ne: req.user._id }, readBy: { $ne: req.user._id }, deleted: { $ne: true } });
    }
    convs.sort((x, y) => (y.group ? 1 : 0) - (x.group ? 1 : 0) || new Date((y.last && y.last.at) || 0) - new Date((x.last && x.last.at) || 0));
    res.json({ success: true, convs, online: hub.onlineIds() });
  }));
  r.get('/chat/messages', fauth, a(async (req, res) => {
    const conv = str(req.query.conv, 80);
    if (!(await convMembers(conv, req.user._id))) return bad(res, 'محادثة غير صالحة', 403);
    const q = { conv };
    if (req.query.before && !Number.isNaN(Date.parse(req.query.before))) q.createdAt = { $lt: new Date(req.query.before) };
    const rows = await FounderMessage.find(q).sort({ createdAt: -1 }).limit(40).lean();
    res.json({ success: true, messages: rows.reverse().map(msgView) });
  }));
  r.post('/chat/messages', fauth, a(async (req, res) => {
    const b = req.body || {};
    const conv = str(b.conv, 80);
    const members = await convMembers(conv, req.user._id);
    if (!members) return bad(res, 'محادثة غير صالحة', 403);
    const text = str(b.text, 4000);
    const image = String(b.image || '');
    const audio = String(b.audio || '');
    if (image && !validImg(image, 1500000)) return bad(res, 'الصورة كبيرة أو غير صالحة');
    if (audio && !validAudio(audio)) return bad(res, 'الرسالة الصوتية كبيرة أو غير صالحة');
    if (!text && !image && !audio) return bad(res, 'الرسالة فارغة');
    const m = await FounderMessage.create({ conv, from: req.user._id, fromName: req.founder.displayName || nameOf(req.user), text, image, audio, audioSec: Math.min(600, Math.max(0, Number(b.audioSec) || 0)), readBy: [req.user._id] });
    const view = msgView(m.toObject());
    hub.emit(members, { type: 'chat.message', message: view });
    const others = members.filter((i) => i !== String(req.user._id));
    hub.push(others, { type: 'chat.message', tag: `fchat-${conv.replace(/[^a-z0-9]/gi, '').slice(-24)}`, title: conv === 'group' ? `👥 ${m.fromName} — مجموعة المؤسسين` : `💬 ${m.fromName}`, body: text || (image ? '📷 صورة' : '🎤 رسالة صوتية'), url: `./#chat=${encodeURIComponent(conv)}` }, { skipOnline: true });
    res.status(201).json({ success: true, message: view });
  }));
  r.post('/chat/read', fauth, a(async (req, res) => {
    const conv = str(req.body && req.body.conv, 80);
    const members = await convMembers(conv, req.user._id);
    if (!members) return bad(res, 'محادثة غير صالحة', 403);
    const unread = await FounderMessage.find({ conv, readBy: { $ne: req.user._id } }).select('_id readBy').lean();
    for (const m of unread) await FounderMessage.updateOne({ _id: m._id }, { $addToSet: { readBy: req.user._id } });
    if (unread.length) hub.emit(members, { type: 'chat.read', conv, by: String(req.user._id), ids: unread.map((m) => String(m._id)) });
    res.json({ success: true, read: unread.length });
  }));
  r.delete('/chat/messages/:id', fauth, a(async (req, res) => {
    if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
    const m = await FounderMessage.findById(req.params.id).lean();
    if (!m || String(m.from) !== String(req.user._id)) return bad(res, 'تحذف رسائلك فقط', 403);
    await FounderMessage.updateOne({ _id: m._id }, { $set: { deleted: true, text: '', image: '', audio: '' } });
    hub.emit(await convMembers(m.conv, req.user._id), { type: 'chat.deleted', conv: m.conv, id: String(m._id) });
    res.json({ success: true });
  }));

  /* ─────────── الإشعارات والمكالمات ─────────── */
  r.post('/push/subscribe', fauth, a(async (req, res) => {
    const sub = (req.body && req.body.subscription) || {};
    const endpoint = str(sub.endpoint, 1500);
    const keys = sub.keys || {};
    if (!/^https:\/\//.test(endpoint) || !keys.p256dh || !keys.auth) return bad(res, 'اشتراك إشعارات غير صالح');
    await FounderDevice.findOneAndUpdate({ key: endpoint }, { $set: { user: req.user._id, kind: 'webpush', endpoint, keys: { p256dh: str(keys.p256dh, 200), auth: str(keys.auth, 100) }, platform: str(req.body.platform, 20) || 'other', ua: str(req.headers['user-agent'], 250), lastError: '' } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    res.json({ success: true });
  }));
  // تطبيق الأندرويد (APK): رمز FCM — رسائل بيانات بأولوية عالية لشاشة الاتصال الكاملة
  r.post('/push/fcm', fauth, a(async (req, res) => {
    const token = str(req.body && req.body.token, 400);
    if (token.length < 20) return bad(res, 'رمز FCM غير صالح');
    await FounderDevice.findOneAndUpdate({ key: token }, { $set: { user: req.user._id, kind: 'fcm', token, platform: 'android', ua: str(req.headers['user-agent'], 250), lastError: '' } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    res.json({ success: true });
  }));
  r.post('/push/test', fauth, a(async (req, res) => {
    const out = await hub.push([String(req.user._id)], { type: 'test', tag: 'ftest', title: '🔔 تجربة إشعار', body: 'الإشعارات تعمل على هذا الجهاز', url: './' });
    res.json({ success: true, ...out, devices: await FounderDevice.countDocuments({ user: req.user._id }) });
  }));
  r.post('/calls', fauth, a(async (req, res) => {
    const b = req.body || {};
    const all = await hub.founderIds();
    const to = b.to === 'all' ? all : (Array.isArray(b.to) ? b.to : [b.to]).map(String).filter((id) => all.includes(id));
    const out = await hub.startCall({ from: req.user._id, fromName: req.founder.displayName || nameOf(req.user), to, video: !!b.video, note: str(b.note, 120) });
    res.status(201).json({ success: true, ...out });
  }));

  /* ═══════════════════════════ لوحة التحكم ═══════════════════════════ */
  const admin = [protect, requirePermission('founders:manage')];
  const sysAdmin = (req, res, next) => (req.user.role === 'admin' ? next() : bad(res, 'هذا الإجراء لمدير النظام وحده', 403));
  const reasonOf = (req) => str(req.body && req.body.reason, 300);

  r.get('/admin/state', ...admin, a(async (req, res) => {
    const s = await settings();
    const users = await User.find({ role: { $ne: 'delivery' }, isActive: { $ne: false } }).select('name username role isFounder').sort({ name: 1 }).lean();
    const debts = await debtsFor(req.user, { admin: true });
    const pending = await DebtPayment.countDocuments({ status: 'review' });
    res.json({
      success: true, settings: s, founders: await founders(), users: users.map((u) => ({ _id: u._id, name: u.name, username: u.username, role: u.role, isFounder: !!u.isFounder })),
      debts, totals: totalsOf(debts), pending, isAdmin: req.user.role === 'admin', month: L.monthNow(), monthLabel: L.monthLabel(L.monthNow()),
    });
  }));

  // إضافة دور «مؤسس» لمستخدم موجود (لا حساب جديد)
  r.post('/admin/founders', ...admin, sysAdmin, a(async (req, res) => {
    const b = req.body || {};
    if (!validId(b.userId)) return bad(res, 'اختر المستخدم');
    const u = await User.findById(b.userId);
    if (!u || u.isActive === false) return bad(res, 'المستخدم غير موجود', 404);
    if (u.role === 'delivery') return bad(res, 'حساب المندوب لا يدخل');
    await User.updateOne({ _id: u._id }, { $set: { isFounder: true } });
    await FounderProfile.findOneAndUpdate({ user: u._id }, { $set: { active: true, title: str(b.title, 80) || 'مؤسس', sharePct: Math.max(0, Math.min(100, Number(b.sharePct) || 0)) }, $setOnInsert: { displayName: u.name, joinedAt: new Date() } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    logActivity({ req, action: 'founders.add', details: { founder: nameOf(u) } });
    res.json({ success: true, founders: await founders() });
  }));
  r.put('/admin/founders/:userId', ...admin, sysAdmin, a(async (req, res) => {
    if (!validId(req.params.userId)) return bad(res, 'معرّف غير صالح');
    const b = req.body || {};
    const set = {};
    if (b.title != null) set.title = str(b.title, 80);
    if (b.displayName != null) set.displayName = str(b.displayName, 80);
    if (b.sharePct != null) set.sharePct = Math.max(0, Math.min(100, Number(b.sharePct) || 0));
    await FounderProfile.updateOne({ user: req.params.userId }, { $set: set });
    res.json({ success: true, founders: await founders() });
  }));
  // إزالة الدور: السجلات المالية تبقى كما هي (حق للشركة)
  r.delete('/admin/founders/:userId', ...admin, sysAdmin, a(async (req, res) => {
    if (!validId(req.params.userId)) return bad(res, 'معرّف غير صالح');
    await User.updateOne({ _id: req.params.userId }, { $set: { isFounder: false } });
    await FounderProfile.updateOne({ user: req.params.userId }, { $set: { active: false, sessionId: crypto.randomBytes(16).toString('hex') } });
    await FounderDevice.deleteMany({ user: req.params.userId });
    logActivity({ req, action: 'founders.remove', details: { userId: req.params.userId } });
    res.json({ success: true, founders: await founders() });
  }));

  r.put('/admin/settings', ...admin, sysAdmin, a(async (req, res) => {
    const b = req.body || {};
    const set = {};
    if (b.companyName != null) set.companyName = str(b.companyName, 80) || 'شركة البراق';
    if (b.notice != null) set.notice = str(b.notice, 300) || 'الديون المشتركة لا تُنسب لأحد إلا إذا دُفعت بتوقيع مؤسس وختم الشركة';
    if (b.callRingSeconds != null) set.callRingSeconds = Math.max(15, Math.min(180, Number(b.callRingSeconds) || 60));
    if (b.stampImage != null) {
      if (b.stampImage && !validImg(b.stampImage, 900000)) return bad(res, 'صورة الختم غير صالحة (PNG/JPEG حتى ~650KB)');
      set.stampImage = b.stampImage; set.stampUpdatedAt = b.stampImage ? new Date() : null; set.stampUpdatedByName = nameOf(req.user);
    }
    await settings();
    await FounderSettings.updateOne({ key: 'main' }, { $set: set });
    if (set.stampImage !== undefined) logActivity({ req, action: 'founders.stamp', details: { change: set.stampImage ? 'رفع ختم الشركة المعتمد' : 'إزالة الختم' } });
    res.json({ success: true, settings: await settings() });
  }));
  r.get('/admin/stamp', ...admin, a(async (req, res) => { const s = await settings({ withStamp: true }); res.json({ success: true, stampImage: s.stampImage || '' }); }));

  /* الديون */
  r.post('/admin/debts', ...admin, sysAdmin, a(async (req, res) => {
    const b = req.body || {};
    const scope = b.scope === 'personal' ? 'personal' : 'company';
    const title = str(b.title, 120);
    const total = r3(b.totalAmount);
    const monthly = r3(b.monthlyInstallment);
    const startMonth = L.isMonth(b.startMonth) ? b.startMonth : L.monthNow();
    if (!title) return bad(res, 'اكتب اسم الدين');
    if (!(total > 0)) return bad(res, 'القيمة الكلية للدين أكبر من صفر');
    if (!(monthly > 0) || monthly > total + EPS) return bad(res, 'القسط الشهري أكبر من صفر ولا يتجاوز القيمة الكلية');
    let owner = null; let ownerName = '';
    if (scope === 'personal') {
      if (!validId(b.owner)) return bad(res, 'اختر المؤسس صاحب الدين الشخصي');
      const u = await User.findOne({ _id: b.owner, isFounder: true }).lean();
      if (!u) return bad(res, 'المؤسس غير موجود');
      const p = await FounderProfile.findOne({ user: u._id }).lean();
      owner = u._id; ownerName = (p && p.displayName) || nameOf(u);
    }
    const d = await CompanyDebt.create({ number: await nextNumber('debt'), scope, owner, ownerName, title, creditor: str(b.creditor, 100), notes: str(b.notes, 500), totalAmount: total, monthlyInstallment: monthly, startMonth, createdBy: req.user._id, createdByName: nameOf(req.user) });
    logActivity({ req, action: 'founders.debt', amount: total, details: { title, scope: scope === 'company' ? 'دين الشركة' : `دين شخصي — ${ownerName}`, monthly } });
    const sum = await debtSummary(d.toObject());
    const ids = scope === 'company' ? await hub.founderIds() : [String(owner)];
    await hub.notifyFounders(ids, { type: 'debt.update', debtId: String(d._id) }, { type: 'debt.new', tag: `fdebt-${d._id}`, title: scope === 'company' ? `📌 دين جديد على الشركة: ${title}` : `📌 دين شخصي مسجّل عليك: ${title}`, body: `${money(total)} — قسط شهري ${money(monthly)} من ${L.monthLabel(startMonth)}`, url: `./#debt=${d._id}` });
    res.status(201).json({ success: true, debt: sum });
  }));
  r.get('/admin/debts/:id', ...admin, a(async (req, res) => {
    if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
    const d = await CompanyDebt.findById(req.params.id).lean();
    if (!d) return bad(res, 'الدين غير موجود', 404);
    const pays = await DebtPayment.find({ debt: d._id }).sort({ createdAt: -1 }).lean();
    res.json({ success: true, debt: L.summarize(d, pays.filter((p) => p.status !== 'rejected')), payments: pays.map(paymentView), corrections: d.corrections || [] });
  }));
  // تصحيح خطأ إدخال في الدين — مدير النظام، بسبب مكتوب، وكل تغيير يُسجَّل
  r.put('/admin/debts/:id', ...admin, sysAdmin, a(async (req, res) => {
    if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
    const reason = reasonOf(req);
    if (reason.length < 4) return bad(res, 'اكتب سبب التصحيح (خطأ الإدخال) — يُحفظ في سجل التصحيح', 400, { code: 'REASON_REQUIRED' });
    const d = await CompanyDebt.findById(req.params.id).lean();
    if (!d) return bad(res, 'الدين غير موجود', 404);
    const b = req.body || {};
    const next = {};
    if (b.title != null) next.title = str(b.title, 120);
    if (b.creditor != null) next.creditor = str(b.creditor, 100);
    if (b.notes != null) next.notes = str(b.notes, 500);
    if (b.totalAmount != null) next.totalAmount = r3(b.totalAmount);
    if (b.monthlyInstallment != null) next.monthlyInstallment = r3(b.monthlyInstallment);
    if (b.startMonth != null) { if (!L.isMonth(b.startMonth)) return bad(res, 'شهر البداية غير صالح'); next.startMonth = b.startMonth; }
    const merged = { ...d, ...next };
    if (!merged.title) return bad(res, 'اسم الدين مطلوب');
    if (!(merged.totalAmount > 0) || !(merged.monthlyInstallment > 0) || merged.monthlyInstallment > merged.totalAmount + EPS) return bad(res, 'القيمة الكلية والقسط غير منطقيين');
    const sum = await debtSummary(d);
    if (merged.totalAmount < sum.paid + sum.pending - EPS) return bad(res, `القيمة الكلية أقل من المدفوع وقيد المراجعة (${money(sum.paid + sum.pending)})`);
    const corrections = Object.keys(next).filter((k) => String(next[k]) !== String(d[k])).map((k) => ({ at: new Date(), by: req.user._id, byName: nameOf(req.user), field: k, from: d[k], to: next[k], reason }));
    if (!corrections.length) return bad(res, 'لا تغيير');
    await CompanyDebt.updateOne({ _id: d._id }, { $set: next, $push: { corrections: { $each: corrections } } });
    logActivity({ req, action: 'founders.correct', details: { debt: d.title, fields: corrections.map((c) => c.field).join('، '), reason } });
    const fresh = await CompanyDebt.findById(d._id).lean();
    hub.emit(d.scope === 'company' ? null : [String(d.owner)], { type: 'debt.update', debtId: String(d._id) });
    res.json({ success: true, debt: await debtSummary(fresh) });
  }));
  r.post('/admin/debts/:id/status', ...admin, sysAdmin, a(async (req, res) => {
    if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
    const status = ['active', 'closed', 'archived'].includes(req.body && req.body.status) ? req.body.status : null;
    if (!status) return bad(res, 'حالة غير صالحة');
    const d = await CompanyDebt.findById(req.params.id).lean();
    if (!d) return bad(res, 'الدين غير موجود', 404);
    await CompanyDebt.updateOne({ _id: d._id }, { $set: { status }, $push: { corrections: { at: new Date(), by: req.user._id, byName: nameOf(req.user), field: 'status', from: d.status, to: status, reason: reasonOf(req) || 'تغيير الحالة' } } });
    hub.emit(null, { type: 'debt.update', debtId: String(d._id) });
    res.json({ success: true });
  }));

  /* الدفعات: المراجعة والختم */
  r.get('/admin/payments', ...admin, a(async (req, res) => {
    const q = {};
    if (['review', 'stamped', 'rejected'].includes(req.query.status)) q.status = req.query.status;
    if (validId(req.query.debt)) q.debt = req.query.debt;
    if (validId(req.query.payer)) q.payer = req.query.payer;
    const list = await DebtPayment.find(q).sort({ createdAt: -1 }).limit(200).lean();
    res.json({ success: true, payments: list.map(paymentView) });
  }));
  r.get('/admin/payments/:id', ...admin, a(async (req, res) => {
    if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
    const p = await DebtPayment.findById(req.params.id).select('+signature +facePhoto').lean();
    if (!p) return bad(res, 'السند غير موجود', 404);
    res.json({ success: true, payment: { ...paymentView(p), signature: p.signature, facePhoto: p.facePhoto, ip: p.ip, ua: p.ua }, ...(await receiptExtras(p)) });
  }));
  // الختم: مدير النظام وحده — دفعة دين الشركة تُرحَّل لحساب المؤسس البنكي «رسوم تأسيس»
  r.post('/admin/payments/:id/stamp', ...admin, sysAdmin, a(async (req, res) => {
    if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
    const s = await settings({ withStamp: true });
    if (!s.stampImage) return bad(res, 'ارفع ختم شركة البراق المعتمد أولاً من «الإعدادات والختم»', 400, { code: 'STAMP_REQUIRED' });
    // تبديل ذرّي: review ← stamped (لا يُختم مرتين)
    const p = await DebtPayment.findOneAndUpdate({ _id: req.params.id, status: 'review' }, { $set: { status: 'stamped', stampedBy: req.user._id, stampedByName: nameOf(req.user), stampedAt: new Date(), reviewNote: str(req.body && req.body.note, 300) } }, { new: true }).lean();
    if (!p) return bad(res, 'السند ليس قيد المراجعة (خُتم أو رُفض)', 409);
    let entry = null;
    if (p.scope === 'company') {
      entry = await FounderLedger.create({ number: await nextNumber('ledger'), founder: p.payer, founderName: p.payerName, kind: 'founding_fee', amount: p.amount, note: `قسط «${p.debtTitle}» — سند رقم ${p.number}`, payment: p._id, date: new Date(), createdBy: req.user._id, createdByName: nameOf(req.user) });
      await DebtPayment.updateOne({ _id: p._id }, { $set: { ledgerEntry: entry._id } });
    }
    logActivity({ req, action: 'founders.stamp.payment', amount: p.amount, details: { number: p.number, payer: p.payerName, debt: p.debtTitle } });
    const ids = p.scope === 'company' ? await hub.founderIds() : [String(p.payer)];
    await hub.notifyFounders(ids, { type: 'payment.stamped', paymentId: String(p._id), debtId: String(p.debt) }, {
      type: 'payment.stamped', tag: `fpay-${p._id}`, title: `✅ خُتمت دفعة ${p.payerName}: ${money(p.amount)}`,
      body: p.scope === 'company' ? `${p.debtTitle} — رُحّلت لحسابه البنكي لدى الشركة كرسوم تأسيس` : `${p.debtTitle} — دين شخصي مختوم`, url: `./#receipt=${p._id}`,
    });
    // تحديث الدين (أُغلق إن سُدّد كاملاً)
    const d = await CompanyDebt.findById(p.debt).lean();
    const sum = d ? await debtSummary(d) : null;
    if (sum && sum.remaining <= EPS && d.status === 'active') await CompanyDebt.updateOne({ _id: d._id }, { $set: { status: 'closed' } });
    res.json({ success: true, payment: paymentView({ ...p, ledgerEntry: entry && entry._id }), debt: sum });
  }));
  r.post('/admin/payments/:id/reject', ...admin, sysAdmin, a(async (req, res) => {
    if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
    const reason = reasonOf(req);
    if (reason.length < 3) return bad(res, 'اكتب سبب الرفض');
    const p = await DebtPayment.findOneAndUpdate({ _id: req.params.id, status: 'review' }, { $set: { status: 'rejected', reviewNote: reason, rejectedByName: nameOf(req.user), rejectedAt: new Date() } }, { new: true }).lean();
    if (!p) return bad(res, 'السند ليس قيد المراجعة', 409);
    logActivity({ req, action: 'founders.reject.payment', amount: p.amount, details: { number: p.number, payer: p.payerName, reason } });
    await hub.notifyFounders([String(p.payer)], { type: 'payment.rejected', paymentId: String(p._id), debtId: String(p.debt) }, { type: 'payment.rejected', tag: `fpay-${p._id}`, title: `⛔ رُفضت دفعتك ${money(p.amount)}`, body: `${p.debtTitle} — ${reason}`, url: `./#debt=${p.debt}` });
    res.json({ success: true, payment: paymentView(p) });
  }));
  // تصحيح مبلغ دفعة لخطأ إدخال — ويتبعه قيدها في الحساب البنكي
  r.post('/admin/payments/:id/correct', ...admin, sysAdmin, a(async (req, res) => {
    if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
    const reason = reasonOf(req);
    if (reason.length < 4) return bad(res, 'اكتب سبب التصحيح (خطأ الإدخال)', 400, { code: 'REASON_REQUIRED' });
    const p = await DebtPayment.findById(req.params.id).lean();
    if (!p || p.status === 'rejected') return bad(res, 'السند غير موجود أو مرفوض', 404);
    const amount = r3(req.body && req.body.amount);
    if (!(amount > 0)) return bad(res, 'المبلغ الصحيح أكبر من صفر');
    if (Math.abs(amount - p.amount) < EPS) return bad(res, 'لا تغيير');
    const d = await CompanyDebt.findById(p.debt).lean();
    const sum = await debtSummary(d);
    if (sum.paid + sum.pending - p.amount + amount > sum.totalAmount + EPS) return bad(res, 'المبلغ يتجاوز القيمة الكلية للدين');
    if (p.installmentMonth) {
      const inst = sum.schedule.find((x) => x.month === p.installmentMonth);
      if (inst && inst.covered + inst.inReview - p.amount + amount > inst.amount + EPS) return bad(res, `المبلغ يتجاوز قيمة قسط ${inst.label} (${money(inst.amount)})`);
    }
    const partialNow = p.installmentMonth ? amount < (p.installmentAmount || amount) - EPS : false;
    const corr = { at: new Date(), by: req.user._id, byName: nameOf(req.user), field: 'amount', from: p.amount, to: amount, reason };
    await DebtPayment.updateOne({ _id: p._id }, { $set: { amount, partial: partialNow }, $push: { corrections: corr } });
    if (p.ledgerEntry) await FounderLedger.updateOne({ _id: p.ledgerEntry }, { $set: { amount }, $push: { corrections: corr } });
    logActivity({ req, action: 'founders.correct', amount, details: { payment: p.number, from: p.amount, to: amount, reason } });
    hub.emit(p.scope === 'company' ? null : [String(p.payer)], { type: 'debt.update', debtId: String(p.debt) });
    res.json({ success: true });
  }));

  /* الحساب البنكي للمؤسسين */
  r.get('/admin/ledger', ...admin, a(async (req, res) => {
    const list = await founders();
    const out = [];
    for (const f of list) out.push({ founder: f, ...(await accountOf(f._id)) });
    res.json({ success: true, accounts: out, kinds: KIND_LABEL });
  }));
  r.post('/admin/ledger', ...admin, sysAdmin, a(async (req, res) => {
    const b = req.body || {};
    if (!validId(b.founder)) return bad(res, 'اختر المؤسس');
    const u = await User.findOne({ _id: b.founder, isFounder: true }).lean();
    if (!u) return bad(res, 'المؤسس غير موجود');
    const kind = ['deposit', 'shares', 'spent'].includes(b.kind) ? b.kind : null;
    if (!kind) return bad(res, 'نوع الحركة: مبلغ دفعه، شراء أسهم، أو صرفه على الشركة (رسوم التأسيس تأتي من ختم الأقساط فقط)');
    const amount = r3(b.amount);
    if (!(amount > 0)) return bad(res, 'المبلغ أكبر من صفر');
    const p = await FounderProfile.findOne({ user: u._id }).lean();
    const date = b.date && !Number.isNaN(Date.parse(b.date)) ? new Date(b.date) : new Date();
    const e = await FounderLedger.create({ number: await nextNumber('ledger'), founder: u._id, founderName: (p && p.displayName) || nameOf(u), kind, amount, sharesCount: kind === 'shares' ? Math.max(0, Number(b.sharesCount) || 0) : 0, note: str(b.note, 300), date, createdBy: req.user._id, createdByName: nameOf(req.user) });
    logActivity({ req, action: 'founders.ledger', amount, details: { founder: e.founderName, kind: KIND_LABEL[kind] } });
    await hub.notifyFounders([String(u._id)], { type: 'account.update' }, { type: 'account.entry', tag: `fled-${e._id}`, title: `🏦 حركة في حسابك لدى الشركة: ${money(amount)}`, body: `${KIND_LABEL[kind]}${e.note ? ' — ' + e.note : ''} (مسجّلة حقاً للشركة)`, url: './#account' });
    res.status(201).json({ success: true, entry: e });
  }));
  r.post('/admin/ledger/:id/correct', ...admin, sysAdmin, a(async (req, res) => {
    if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
    const reason = reasonOf(req);
    if (reason.length < 4) return bad(res, 'اكتب سبب التصحيح (خطأ الإدخال)', 400, { code: 'REASON_REQUIRED' });
    const e = await FounderLedger.findById(req.params.id).lean();
    if (!e) return bad(res, 'الحركة غير موجودة', 404);
    if (e.kind === 'founding_fee') return bad(res, 'رسوم التأسيس تُصحَّح من سند الدفعة نفسه (حتى يبقى الدين والحساب متطابقين)');
    const b = req.body || {};
    const next = {};
    if (b.amount != null) { next.amount = r3(b.amount); if (!(next.amount > 0)) return bad(res, 'المبلغ أكبر من صفر'); }
    if (b.note != null) next.note = str(b.note, 300);
    if (b.sharesCount != null && e.kind === 'shares') next.sharesCount = Math.max(0, Number(b.sharesCount) || 0);
    const corrections = Object.keys(next).filter((k) => String(next[k]) !== String(e[k])).map((k) => ({ at: new Date(), by: req.user._id, byName: nameOf(req.user), field: k, from: e[k], to: next[k], reason }));
    if (!corrections.length) return bad(res, 'لا تغيير');
    await FounderLedger.updateOne({ _id: e._id }, { $set: next, $push: { corrections: { $each: corrections } } });
    logActivity({ req, action: 'founders.correct', details: { ledger: e.number, founder: e.founderName, reason } });
    hub.emit([String(e.founder)], { type: 'account.update' });
    res.json({ success: true });
  }));

  /* قوانين المطعم */
  r.get('/admin/laws', ...admin, a(async (req, res) => {
    const laws = await FounderPost.find({ kind: 'law' }).sort({ createdAt: -1 }).limit(200).lean();
    res.json({ success: true, laws: laws.map((p) => postView(p, req.user)), founders: await founders() });
  }));
  r.post('/admin/laws', ...admin, sysAdmin, a(async (req, res) => {
    const b = req.body || {};
    const title = str(b.title, 160);
    const text = str(b.text, 8000);
    if (!title || !text) return bad(res, 'اكتب عنوان القانون ونصّه');
    const all = await hub.founderIds();
    const target = (Array.isArray(b.founders) ? b.founders : []).map(String).filter((id) => all.includes(id));
    const images = (Array.isArray(b.images) ? b.images : []).slice(0, 4).map(String);
    if (images.some((i) => !validImg(i))) return bad(res, 'صورة غير صالحة');
    const p = await FounderPost.create({ kind: 'law', lawNumber: await nextNumber('law'), title, text, images, founders: target, pinned: !!b.pinned, author: req.user._id, authorName: `إدارة ${(await settings()).companyName} — ${nameOf(req.user)}` });
    logActivity({ req, action: 'founders.law', details: { number: p.lawNumber, title } });
    const view = postView(p.toObject(), req.user);
    hub.emit(null, { type: 'post.new', post: view });
    await hub.push(target.length ? target : all, { type: 'law.new', urgent: true, tag: `flaw-${p._id}`, title: `⚖️ قانون رقم ${p.lawNumber}: ${title}`, body: text, url: `./#post=${p._id}` });
    res.status(201).json({ success: true, law: view });
  }));
  r.put('/admin/laws/:id', ...admin, sysAdmin, a(async (req, res) => {
    if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
    const p = await FounderPost.findOne({ _id: req.params.id, kind: 'law' }).lean();
    if (!p) return bad(res, 'القانون غير موجود', 404);
    const reason = reasonOf(req) || 'تعديل';
    const b = req.body || {};
    const next = {};
    if (b.title != null) next.title = str(b.title, 160);
    if (b.text != null) next.text = str(b.text, 8000);
    if (b.pinned != null) next.pinned = !!b.pinned;
    if (Array.isArray(b.founders)) { const all = await hub.founderIds(); next.founders = b.founders.map(String).filter((id) => all.includes(id)); }
    const corrections = ['title', 'text'].filter((k) => next[k] != null && next[k] !== p[k]).map((k) => ({ at: new Date(), by: req.user._id, byName: nameOf(req.user), field: k, from: p[k], to: next[k], reason }));
    await FounderPost.updateOne({ _id: p._id }, { $set: { ...next, editedAt: corrections.length ? new Date() : p.editedAt }, ...(corrections.length ? { $push: { corrections: { $each: corrections } } } : {}) });
    const fresh = await FounderPost.findById(p._id).lean();
    hub.emit(null, { type: 'post.update', post: postView(fresh, req.user) });
    res.json({ success: true, law: postView(fresh, req.user) });
  }));
  r.delete('/admin/laws/:id', ...admin, sysAdmin, a(async (req, res) => {
    if (!validId(req.params.id)) return bad(res, 'معرّف غير صالح');
    await FounderPost.updateOne({ _id: req.params.id, kind: 'law' }, { $set: { deleted: true } });
    hub.emit(null, { type: 'post.deleted', postId: String(req.params.id) });
    res.json({ success: true });
  }));

  return r;
}

/* ═════════ عرض ═════════ */

function postView(p, user) {
  const me = String(user && user._id);
  return {
    _id: String(p._id), kind: p.kind, lawNumber: p.lawNumber, title: p.title, text: p.text, images: p.images || [],
    founders: (p.founders || []).map(String), author: String(p.author), authorName: p.authorName,
    likes: (p.likes || []).map(String), liked: (p.likes || []).map(String).includes(me), commentsCount: Math.max(0, p.commentsCount || 0),
    pinned: !!p.pinned, deleted: !!p.deleted, editedAt: p.editedAt, createdAt: p.createdAt, corrections: (p.corrections || []).length,
  };
}
function commentView(c, user) {
  const me = String(user && user._id);
  return { _id: String(c._id), post: String(c.post), author: String(c.author), authorName: c.authorName, text: c.text, likes: (c.likes || []).map(String), liked: (c.likes || []).map(String).includes(me), createdAt: c.createdAt };
}
function msgView(m) {
  return { _id: String(m._id), conv: m.conv, from: String(m.from), fromName: m.fromName, text: m.text, image: m.image, audio: m.audio, audioSec: m.audioSec, readBy: (m.readBy || []).map(String), deleted: !!m.deleted, createdAt: m.createdAt };
}
/** للطباعة: الختم المعتمد (للمختوم فقط) واسم الشركة وملخص الدين. */
async function receiptExtras(p) {
  const s = await settings({ withStamp: p.status === 'stamped' });
  const d = await CompanyDebt.findById(p.debt).lean();
  return { companyName: s.companyName, notice: s.notice, stampImage: p.status === 'stamped' ? (s.stampImage || '') : '', debt: d ? { title: d.title, creditor: d.creditor, scope: d.scope, totalAmount: d.totalAmount, monthlyInstallment: d.monthlyInstallment, number: d.number } : null };
}

module.exports = { router, fauth, KIND_LABEL };
