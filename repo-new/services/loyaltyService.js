/*
  ═══════════════════════════════════════════════════════════════
  نظام نقاط الولاء — كل تغيير على الرصيد يمر من هنا فقط.

  تدفق النقاط:
    الكاشير يبيع (POST /api/orders/pos + loyalty) أو يتحول طلب الموقع/السنتر إلى «تم التسليم»
      ← earnForOrder: معاملة earn:<orderId> (فريدة) + $inc على الرصيد — داخل معاملة MongoDB إن دعمتها القاعدة
      ← walletSync: تحديث بطاقة Apple (إشعار APNs) وGoogle (PATCH) في الخلفية — فشلها لا يمس البيع
    الاستبدال: redeem:<clientRef> بشرط balance ≥ التكلفة داخل التحديث نفسه (لا رصيد سالب بالاستبدال)
    الإلغاء/الاسترداد: reverse_earn و reverse_redeem — مرة واحدة لكل فاتورة

  قواعد التقريب: الفاتورة تُحوّل لفلوس (×1000 ثم تقريب)، ثم النقاط = floor(فلوس × earnPerJod ÷ 1000).
  مثال بالافتراضي (10 نقاط/دينار): 12.345 د.أ ← 123 نقطة؛ 0.099 د.أ ← 0 نقطة.
  ═══════════════════════════════════════════════════════════════
*/
const crypto = require('crypto');
const mongoose = require('mongoose');
const LoyaltyProgram = require('../models/LoyaltyProgram');
const LoyaltyAccount = require('../models/LoyaltyAccount');
const LoyaltyTransaction = require('../models/LoyaltyTransaction');
const LoyaltyReward = require('../models/LoyaltyReward');
const Counter = require('../models/Counter');
const { normalizeJo } = require('../utils/phone');

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const isDup = (e) => e && (e.code === 11000 || /E11000/.test(String(e.message)));
const round3 = (n) => Math.round(Number(n || 0) * 1000) / 1000;
const nameOf = (u) => (u && (u.name || u.username)) || '';

/* ═════════ البرنامج والمكافآت ═════════ */

let progCache = null; let progAt = 0;
async function program() {
  if (progCache && Date.now() - progAt < 30000) return progCache;
  let p = await LoyaltyProgram.findOne({ key: 'main' }).lean();
  if (!p) {
    try { await LoyaltyProgram.create({ key: 'main' }); } catch (e) { if (!isDup(e)) throw e; }
    p = await LoyaltyProgram.findOne({ key: 'main' }).lean();
    // مكافأة افتراضية: خصم دينار مقابل نقاط دينار واحد (قابلة للتعديل/التعطيل)
    if (!(await LoyaltyReward.countDocuments({}))) {
      await LoyaltyReward.create({ name: 'خصم دينار', description: 'خصم 1 د.أ من الفاتورة', type: 'amount', pointsCost: p.redeemPointsPerJod || 1000, value: 1 });
    }
  }
  progCache = p; progAt = Date.now();
  return p;
}
const invalidateProgram = () => { progCache = null; progAt = 0; };

const PROGRAM_FIELDS = ['enabled', 'programName', 'earnPerJod', 'redeemPointsPerJod', 'minOrderToEarn', 'earnOnDeliveryFee', 'earnSources', 'terms', 'logoUrl'];

async function updateProgram(body, user) {
  await program();
  const $set = { updatedByName: nameOf(user) };
  for (const k of PROGRAM_FIELDS) if (body[k] !== undefined) $set[k] = body[k];
  if ($set.earnPerJod !== undefined && !(Number($set.earnPerJod) >= 0 && Number($set.earnPerJod) <= 1000)) throw fail(400, 'معدل الاكتساب بين 0 و1000 نقطة لكل دينار');
  if ($set.redeemPointsPerJod !== undefined && !(Number($set.redeemPointsPerJod) >= 1)) throw fail(400, 'قيمة الاستبدال يجب أن تكون نقطة واحدة على الأقل');
  if ($set.minOrderToEarn !== undefined && !(Number($set.minOrderToEarn) >= 0)) throw fail(400, 'أقل قيمة طلب غير صالحة');
  if ($set.earnSources !== undefined) $set.earnSources = (Array.isArray($set.earnSources) ? $set.earnSources : []).filter((s) => ['pos', 'web', 'app', 'center'].includes(s));
  if (body.colors) {
    for (const c of ['background', 'foreground', 'label']) {
      if (body.colors[c] !== undefined) {
        if (!/^#[0-9a-fA-F]{6}$/.test(String(body.colors[c]))) throw fail(400, 'الألوان بصيغة #RRGGBB');
        $set[`colors.${c}`] = String(body.colors[c]);
      }
    }
  }
  if ($set.programName !== undefined) $set.programName = String($set.programName).trim().slice(0, 60) || 'نقاط الولاء';
  await LoyaltyProgram.updateOne({ key: 'main' }, { $set }, { runValidators: true });
  invalidateProgram();
  return program();
}

/** المكافآت — بعد تهيئة البرنامج (أول تشغيل يُنشئ مكافأة «خصم دينار» الافتراضية). */
async function rewards(activeOnly = true) {
  await program();
  return LoyaltyReward.find(activeOnly ? { active: true } : {}).sort({ sortOrder: 1, pointsCost: 1 }).lean();
}

async function saveReward(id, body, user) {
  const doc = {};
  for (const k of ['name', 'description', 'type', 'pointsCost', 'value', 'active', 'sortOrder', 'product', 'productName']) if (body[k] !== undefined) doc[k] = body[k];
  if (doc.pointsCost !== undefined && !(Number.isInteger(Number(doc.pointsCost)) && Number(doc.pointsCost) >= 1)) throw fail(400, 'تكلفة المكافأة عدد صحيح من النقاط (1 على الأقل)');
  if (doc.type === 'amount' && doc.value !== undefined && !(Number(doc.value) > 0)) throw fail(400, 'قيمة الخصم يجب أن تكون أكبر من صفر');
  if (doc.type === 'free_item' && !doc.product && !id) throw fail(400, 'اختر الصنف المجاني');
  doc.updatedByName = nameOf(user);
  if (id) {
    const r = await LoyaltyReward.findOneAndUpdate({ _id: id }, { $set: doc }, { new: true, runValidators: true });
    if (!r) throw fail(404, 'المكافأة غير موجودة');
    return r;
  }
  if (!doc.name) throw fail(400, 'اسم المكافأة مطلوب');
  return LoyaltyReward.create(doc);
}

/* ═════════ العضوية ═════════ */

const MEMBER_PREFIX = () => (process.env.LOYALTY_MEMBER_PREFIX || 'DY').replace(/[^A-Z0-9]/gi, '').slice(0, 4).toUpperCase() || 'DY';
async function nextMemberNo() {
  const c = await Counter.findOneAndUpdate({ _id: 'loyalty_member' }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return `${MEMBER_PREFIX()}-${String(c.seq).padStart(6, '0')}`;
}
const newQrCode = () => `DYL${crypto.randomBytes(12).toString('hex').toUpperCase()}`;

/** العضوية لرقم الهاتف — تُنشأ عند أول حاجة (دخول المحفظة، أول فاتورة، أو بحث الكاشير). */
async function ensureAccount({ phone, name, customerId, phoneUserId } = {}) {
  const intl = normalizeJo(phone);
  if (!intl) throw fail(400, 'رقم الهاتف غير صالح (مثال: 0791234567)');
  let acc = await LoyaltyAccount.findOne({ phone: intl });
  if (!acc) {
    try {
      acc = await LoyaltyAccount.create({
        phone: intl, name: String(name || '').trim().slice(0, 80), customer: customerId || null, phoneUser: phoneUserId || null,
        memberNo: await nextMemberNo(), qrCode: newQrCode(),
      });
    } catch (e) {
      if (!isDup(e)) throw e;
      acc = await LoyaltyAccount.findOne({ phone: intl }); // سباق: أنشأها طلب آخر الآن
    }
  }
  const $set = {};
  if (name && !acc.name) $set.name = String(name).trim().slice(0, 80);
  if (phoneUserId && !acc.phoneUser) $set.phoneUser = phoneUserId;
  if (customerId && !acc.customer) $set.customer = customerId;
  if (Object.keys($set).length) acc = await LoyaltyAccount.findOneAndUpdate({ _id: acc._id }, { $set }, { new: true });
  return acc;
}

const findByCode = (code) => {
  const c = String(code || '').trim().toUpperCase();
  return /^DYL[0-9A-F]{24}$/.test(c) ? LoyaltyAccount.findOne({ qrCode: c }) : null;
};
const findByPhone = (phone) => { const p = normalizeJo(phone); return p ? LoyaltyAccount.findOne({ phone: p }) : null; };

/* ═════════ الاحتساب ═════════ */

/** النقاط لمبلغ بالدينار — فلوس صحيحة ثم تقريب للأسفل. */
function pointsFor(amountJod, prog) {
  const fils = Math.round(Number(amountJod || 0) * 1000);
  if (!(fils > 0)) return 0;
  return Math.floor((fils * Number(prog.earnPerJod || 0)) / 1000 + 1e-9);
}

/** المبلغ الذي تُحتسب عليه النقاط: الأصناف − الخصم (+ التوصيل إن فُعّل). */
function earnBase(order, prog) {
  const fee = Number(order.deliveryFee || 0);
  const items = order.itemsTotal != null ? Number(order.itemsTotal) : Number(order.total || 0) - fee;
  return round3(Math.max(0, items - Number(order.discount || 0) + (prog.earnOnDeliveryFee ? fee : 0)));
}

/** الفاتورة مدفوعة؟ بيع الكاشير يُدفع لحظة البيع؛ غيره عند «تم التسليم». */
const isPaid = (order) => order.status !== 'cancelled' && order.status !== 'pending' &&
  (order.source === 'pos' || order.status === 'delivered');

/* ═════════ المعاملات (قلب النظام) ═════════ */

const txnUnsupported = (e) => e && (e.code === 20 || e.codeName === 'IllegalOperation' ||
  /Transaction numbers are only allowed|replica set|does not support transactions/i.test(String(e.message)));

/** معاملة MongoDB إن دعمتها القاعدة (Replica Set/Atlas)، وإلا تنفيذ عادي بنفس الضمانات الأساسية. */
async function withTxn(fn) {
  if (process.env.LOYALTY_DISABLE_TXN === '1' || mongoose.connection.readyState !== 1) return fn(null);
  let session;
  try { session = await mongoose.startSession(); } catch (_) { return fn(null); }
  try {
    let out;
    await session.withTransaction(async () => { out = await fn(session); });
    return out;
  } catch (e) {
    if (txnUnsupported(e)) return fn(null);
    throw e;
  } finally { try { await session.endSession(); } catch (_) { /* */ } }
}

/**
 * تسجيل حركة نقاط واحدة على عضوية — مرة واحدة لكل idemKey مهما تكرر الاستدعاء.
 *   noOverdraw: الخصم مشروط بأن يغطيه الرصيد (الاستبدال والخصم اليدوي)
 * يرجع { tx, account, duplicate }.
 */
async function post({ accountId, type, points, idemKey, noOverdraw = false, ...meta }) {
  points = Math.trunc(Number(points));
  if (!points) throw fail(400, 'عدد النقاط يجب ألا يكون صفراً');
  const existing = await LoyaltyTransaction.findOne({ idemKey }).lean();
  if (existing) return { tx: existing, duplicate: true, account: await LoyaltyAccount.findById(existing.account).lean() };

  const DUP = 'loyalty-duplicate';
  let out;
  try {
    out = await withTxn(async (session) => {
    const opt = session ? { session } : {};
    let tx;
    try {
      [tx] = await LoyaltyTransaction.create([{ account: accountId, type, points, idemKey, balanceAfter: 0, ...meta }], opt);
    } catch (e) {
      // داخل معاملة Mongo: خطأ المفتاح المكرر يُبطل المعاملة كلها على الخادم، فلا يصح «الإرجاع» منها —
      // نرمي علامة تُلغي المعاملة بنظافة، ثم نرجع المعاملة الأصلية من خارجها
      if (isDup(e)) throw Object.assign(new Error(DUP), { [DUP]: true });
      throw e;
    }
    // العكس (إلغاء فاتورة) يُنفَّذ حتى على عضوية موقوفة؛ الاكتساب والاستبدال والتعديل للعضوية الفعّالة فقط
    const filter = { _id: accountId };
    if (!type.startsWith('reverse_')) filter.status = 'active';
    if (noOverdraw && points < 0) filter.balance = { $gte: -points };
    const inc = { balance: points, passVersion: 1 };
    if (type === 'earn' || type === 'reverse_earn' || (type === 'adjust' && points > 0)) inc.lifetimeEarned = points;
    if (type === 'redeem' || type === 'reverse_redeem') inc.lifetimeRedeemed = -points;
    const account = await LoyaltyAccount.findOneAndUpdate(filter,
      { $inc: inc, $set: { passUpdatedAt: new Date() } }, { new: true, ...opt });
    if (!account) {
      await LoyaltyTransaction.deleteOne({ _id: tx._id }, opt); // لم تُنفَّذ — لا أثر لها
      const acc = await LoyaltyAccount.findById(accountId).lean();
      if (!acc) throw fail(404, 'عضوية الولاء غير موجودة');
      if (acc.status !== 'active') throw fail(403, 'عضوية الولاء موقوفة');
      throw fail(409, `رصيد النقاط غير كافٍ (المتاح ${acc.balance})`, 'INSUFFICIENT');
    }
    await LoyaltyTransaction.updateOne({ _id: tx._id }, { $set: { balanceAfter: account.balance } }, opt);
    return { tx: { ...(tx.toObject ? tx.toObject() : tx), balanceAfter: account.balance }, account: account.toObject ? account.toObject() : account };
    });
  } catch (e) {
    if (!(e && (e[DUP] || isDup(e)))) throw e;
    out = { duplicate: true };
  }
  if (out.duplicate) {
    const tx = await LoyaltyTransaction.findOne({ idemKey }).lean();
    return { tx, duplicate: true, account: tx ? await LoyaltyAccount.findById(tx.account).lean() : null };
  }
  changed(out.account._id);
  return out;
}

/* ═════════ الفواتير ═════════ */

/** حساب خصم مكافأة على سلة مسعّرة من الخادم. لا يغيّر شيئاً. */
function rewardDiscount(reward, items, itemsTotal) {
  if (!reward || !reward.active) throw fail(400, 'المكافأة غير متاحة');
  if (reward.type === 'amount') return round3(Math.min(Number(reward.value || 0), Number(itemsTotal || 0)));
  if (reward.type === 'free_item') {
    const line = (items || []).find((i) => String(i.product) === String(reward.product));
    if (!line) throw fail(400, `أضف «${reward.productName || 'الصنف المجاني'}» إلى السلة لاستبدال هذه المكافأة`);
    const base = Number(line.basePrice != null ? line.basePrice : line.price || 0);
    return round3(Math.min(base, Number(itemsTotal || 0)));
  }
  throw fail(400, 'نوع مكافأة غير معروف');
}

/**
 * استبدال مكافأة عند البيع — يُستدعى قبل إنشاء الفاتورة. idemKey من clientRef: إعادة الإرسال لا تخصم مرتين.
 * يرجع { discount, tx, reward }.
 */
async function redeemForSale({ account, rewardId, items, itemsTotal, saleRef, user }) {
  const prog = await program();
  if (!prog.enabled) throw fail(400, 'برنامج الولاء متوقف');
  const reward = await LoyaltyReward.findById(rewardId).lean();
  if (!reward) throw fail(404, 'المكافأة غير موجودة');
  const discount = rewardDiscount(reward, items, itemsTotal);
  if (!(discount > 0)) throw fail(400, 'لا يوجد ما يُخصم في هذه السلة');
  const { tx, duplicate } = await post({
    accountId: account._id, type: 'redeem', points: -reward.pointsCost, idemKey: `redeem:${saleRef}`, noOverdraw: true,
    amount: discount, reward: reward._id, rewardName: reward.name, byUser: user ? user._id : null, byName: nameOf(user), source: 'pos',
  });
  return { discount: duplicate ? Number(tx.amount) : discount, tx, reward };
}

/** ربط معاملة الاستبدال بالفاتورة بعد إنشائها (للمراجعة والعكس عند الإلغاء). */
const attachRedeemToOrder = (saleRef, order) =>
  LoyaltyTransaction.updateOne({ idemKey: `redeem:${saleRef}` }, { $set: { order: order._id, orderNumber: String(order.orderNumber || '') } });

/** فشل إنشاء الفاتورة بعد الاستبدال: إرجاع النقاط. */
async function undoRedeem(saleRef, user) {
  const tx = await LoyaltyTransaction.findOne({ idemKey: `redeem:${saleRef}` }).lean();
  if (!tx) return null;
  return post({ accountId: tx.account, type: 'reverse_redeem', points: -tx.points, idemKey: `reverse_redeem:${tx._id}`,
    reason: 'لم تكتمل عملية البيع', byName: nameOf(user), source: 'system' });
}

/**
 * منح نقاط فاتورة مدفوعة — مرة واحدة لكل فاتورة (earn:<orderId>).
 * الفاتورة الملغاة أو غير المدفوعة لا تكسب. يرجع { points, account } أو null.
 */
async function earnForOrder(order, { user, account: givenAccount } = {}) {
  const prog = await program();
  if (!prog.enabled || !order || !isPaid(order)) return null;
  if (!(prog.earnSources || []).includes(order.source || 'web')) return null;
  const base = earnBase(order, prog);
  if (base < Number(prog.minOrderToEarn || 0)) return null;
  const points = pointsFor(base, prog);
  if (points <= 0) return null;

  let account = givenAccount || null;
  if (!account && order.loyalty && order.loyalty.account) account = await LoyaltyAccount.findById(order.loyalty.account);
  if (!account && order.source !== 'pos' && order.phone) account = await ensureAccount({ phone: order.phone, name: order.customerName, customerId: order.customer });
  if (!account) return null; // بيع سفري بلا عضوية: لا نقاط

  const { tx, duplicate } = await post({
    accountId: account._id, type: 'earn', points, idemKey: `earn:${order._id}`, order: order._id, orderNumber: String(order.orderNumber || ''),
    amount: base, byUser: user ? user._id : null, byName: nameOf(user), source: order.source || 'web',
  });
  if (!duplicate) {
    const Order = require('../models/Order');
    await Order.updateOne({ _id: order._id }, { $set: { 'loyalty.account': account._id, 'loyalty.memberNo': account.memberNo, 'loyalty.pointsEarned': points } });
  }
  return { points: duplicate ? tx.points : points, duplicate, account: tx ? await LoyaltyAccount.findById(tx.account).lean() : null };
}

/**
 * فاتورة أُلغيت (أو استُردت) بعد أن كسبت أو استُبدل عليها: تُعكس النقاط مرة واحدة.
 * سحب النقاط المكتسبة قد يجعل الرصيد سالباً إن صرفها الزبون — يُسجَّل ويُسدّ من مشترياته القادمة.
 */
async function reverseForOrder(order, { user } = {}) {
  const out = { reversedEarn: 0, refundedRedeem: 0 };
  const earn = await LoyaltyTransaction.findOne({ idemKey: `earn:${order._id}` }).lean();
  if (earn) {
    const r = await post({ accountId: earn.account, type: 'reverse_earn', points: -earn.points, idemKey: `reverse_earn:${order._id}`,
      order: order._id, orderNumber: String(order.orderNumber || ''), reason: 'إلغاء الفاتورة', byUser: user ? user._id : null, byName: nameOf(user), source: 'system' });
    if (!r.duplicate) out.reversedEarn = earn.points;
  }
  const redeem = await LoyaltyTransaction.findOne({ order: order._id, type: 'redeem' }).lean();
  if (redeem) {
    const r = await post({ accountId: redeem.account, type: 'reverse_redeem', points: -redeem.points, idemKey: `reverse_redeem:${order._id}`,
      order: order._id, orderNumber: String(order.orderNumber || ''), reason: 'إلغاء الفاتورة — إرجاع النقاط المستبدلة', byUser: user ? user._id : null, byName: nameOf(user), source: 'system' });
    if (!r.duplicate) out.refundedRedeem = -redeem.points;
  }
  return out;
}

/** بعد تغيير حالة طلب (يُستدعى بعد الرد — لا يؤخر الكاشير ولا يُفشله). */
async function onOrderStatusChanged(order, previousStatus, user) {
  if (!order) return null;
  if (order.status === 'delivered' && previousStatus !== 'delivered') return earnForOrder(order, { user });
  if (order.status === 'cancelled' && previousStatus !== 'cancelled') return reverseForOrder(order, { user });
  return null;
}

/* ═════════ الإدارة ═════════ */

/** تعديل يدوي — السبب والمستخدم إلزاميان، ولا يُخصم أكثر من الرصيد. */
async function adjust(accountId, { points, reason }, user) {
  points = Math.trunc(Number(points));
  if (!points) throw fail(400, 'أدخل عدد نقاط (موجب للإضافة، سالب للخصم)');
  if (Math.abs(points) > 1000000) throw fail(400, 'عدد نقاط كبير جداً');
  const why = String(reason || '').trim();
  if (why.length < 3) throw fail(400, 'سبب التعديل مطلوب');
  if (!user) throw fail(401, 'غير مصرح');
  return post({ accountId, type: 'adjust', points, idemKey: `adjust:${crypto.randomUUID()}`, noOverdraw: true,
    reason: why.slice(0, 300), byUser: user._id, byName: nameOf(user), source: 'admin' });
}

/** إعادة حساب الرصيد من السجل (المرجع الأساسي) — يرجع الفرق إن وُجد. */
async function recalc(accountId) {
  const txs = await LoyaltyTransaction.find({ account: accountId }).lean();
  const balance = txs.reduce((s, t) => s + Number(t.points || 0), 0);
  const lifetimeEarned = txs.filter((t) => ['earn', 'reverse_earn'].includes(t.type) || (t.type === 'adjust' && t.points > 0)).reduce((s, t) => s + t.points, 0);
  const lifetimeRedeemed = txs.filter((t) => ['redeem', 'reverse_redeem'].includes(t.type)).reduce((s, t) => s - t.points, 0);
  const before = await LoyaltyAccount.findById(accountId).lean();
  if (!before) throw fail(404, 'عضوية الولاء غير موجودة');
  await LoyaltyAccount.updateOne({ _id: accountId }, { $set: { balance, lifetimeEarned, lifetimeRedeemed, passUpdatedAt: new Date() }, $inc: { passVersion: 1 } });
  if (before.balance !== balance) changed(accountId);
  return { before: before.balance, after: balance, difference: balance - before.balance, transactions: txs.length };
}

const history = (accountId, limit = 30) =>
  LoyaltyTransaction.find({ account: accountId }).sort({ createdAt: -1 }).limit(Math.min(200, limit)).lean();

/* ═════════ تحديث البطاقات (Apple/Google) ═════════ */

const listeners = [];
/** wallet services تسجّل هنا؛ الاستدعاء بلا انتظار وأخطاؤه لا تخرج أبداً. */
const onChanged = (fn) => listeners.push(fn);
function changed(accountId) {
  for (const fn of listeners) {
    Promise.resolve().then(() => fn(accountId)).catch((e) => console.error('loyalty wallet sync:', e.message));
  }
}

module.exports = {
  program, invalidateProgram, updateProgram, rewards, saveReward,
  ensureAccount, findByCode, findByPhone,
  pointsFor, earnBase, isPaid, rewardDiscount,
  post, redeemForSale, attachRedeemToOrder, undoRedeem, earnForOrder, reverseForOrder, onOrderStatusChanged,
  adjust, recalc, history, onChanged, withTxn,
};
