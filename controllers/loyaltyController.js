/*
  ═══════════════════════════════════════════════════════════════
  الولاء — واجهات API

  الزبون (توكن الزبون من OTP — لا يرى إلا عضويته هو):
    GET  /api/loyalty/me                 العضوية، الرصيد، السجل، المكافآت، حالة البطاقات
    GET  /api/loyalty/me/qr.svg          رمز QR للبطاقة
    POST /api/loyalty/me/apple           رابط تنزيل مؤقت (10 دقائق) لملف .pkpass
    POST /api/loyalty/me/google          رابط «أضف إلى Google Wallet»
  الكاشير (loyalty:use):
    GET  /api/loyalty/lookup?code=|phone=   العضو ورصيده والمكافآت المتاحة (الهاتف مخفي جزئياً)
    POST /api/loyalty/quote               معاينة خصم مكافأة على السلة (أسعار من القاعدة)
    POST /api/loyalty/enroll              تسجيل عضو جديد برقمه
  الإدارة (loyalty:manage): /api/loyalty/admin/*
  Apple Wallet Web Service: /api/loyalty/apple/v1/*
  ═══════════════════════════════════════════════════════════════
*/
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const { wrapAll } = require('../utils/asyncHandler');
const loyalty = require('../services/loyaltyService');
const apple = require('../services/appleWalletService');
const google = require('../services/googleWalletService');
const LoyaltyAccount = require('../models/LoyaltyAccount');
const LoyaltyTransaction = require('../models/LoyaltyTransaction');
const Product = require('../models/Product');
const Setting = require('../models/Setting');
const { logActivity } = require('../utils/activity');
const { maskPhone, localJo, normalizeJo } = require('../utils/phone');

const fail = (res, e) => res.status(e.status || 500).json({ success: false, code: e.code, message: e.status ? e.message : 'حدث خطأ — حاول مرة أخرى' });
const DL_SECRET = () => `${process.env.JWT_SECRET || ''}:loyalty-pass-download`;
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));

async function brand() {
  const s = await Setting.findOne().select('restaurantName logo').lean().catch(() => null);
  const prog = await loyalty.program();
  return { restaurantName: (s && s.restaurantName) || 'ديار الأنباط', logoUrl: prog.logoUrl || (s && s.logo) || '' };
}

const publicProgram = (p) => ({
  enabled: p.enabled, programName: p.programName, earnPerJod: p.earnPerJod, redeemPointsPerJod: p.redeemPointsPerJod,
  minOrderToEarn: p.minOrderToEarn, terms: p.terms, colors: p.colors, logoUrl: p.logoUrl,
});
const publicReward = (r, balance) => ({
  _id: r._id, name: r.name, description: r.description, type: r.type, pointsCost: r.pointsCost, value: r.value,
  productName: r.productName, eligible: balance >= r.pointsCost, missing: Math.max(0, r.pointsCost - balance),
});
const publicTx = (t) => ({
  _id: t._id, type: t.type, points: t.points, balanceAfter: t.balanceAfter, orderNumber: t.orderNumber,
  amount: t.amount, rewardName: t.rewardName, reason: t.type === 'adjust' ? t.reason : '', createdAt: t.createdAt,
});

/* ═════════ الزبون ═════════ */

async function myAccount(req) {
  return loyalty.ensureAccount({ phone: req.phoneUser.phone, phoneUserId: req.phoneUser._id });
}

/** حالة البطاقة: apple — «مضافة» إن سجّل جهاز (آلية موثوقة من Apple)، google — من hasUsers. */
async function walletState(acc) {
  const a = apple.isConfigured(); const g = google.isConfigured();
  let gState = !g ? 'unavailable' : acc.google && acc.google.objectId ? 'ready' : 'not_added';
  if (g && acc.google && acc.google.objectId) { const has = await google.hasUsers(acc); if (has === true) gState = 'added'; }
  return {
    apple: { available: a, status: !a ? 'unavailable' : (acc.apple && acc.apple.registeredDevices > 0) ? 'added' : (acc.apple && acc.apple.issuedAt) ? 'ready' : 'not_added' },
    google: { available: g, status: gState },
  };
}

const me = async (req, res) => {
  try {
    const acc = await myAccount(req);
    const prog = await loyalty.program();
    const [rewards, txs, wallet] = await Promise.all([loyalty.rewards(true), loyalty.history(acc._id, 50), walletState(acc)]);
    res.json({
      success: true,
      account: { memberNo: acc.memberNo, name: acc.name, phone: localJo(acc.phone), balance: acc.balance, lifetimeEarned: acc.lifetimeEarned,
        lifetimeRedeemed: acc.lifetimeRedeemed, status: acc.status, qrCode: acc.qrCode, since: acc.createdAt },
      program: publicProgram(prog),
      rewards: rewards.map((r) => publicReward(r, acc.balance)),
      history: txs.map(publicTx),
      wallet,
      brand: await brand(),
    });
  } catch (e) { fail(res, e); }
};

const myName = async (req, res) => {
  try {
    const acc = await myAccount(req);
    const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
    if (name.length < 2) return res.status(400).json({ success: false, message: 'اكتب اسمك' });
    await LoyaltyAccount.updateOne({ _id: acc._id }, { $set: { name, passUpdatedAt: new Date() }, $inc: { passVersion: 1 } });
    require('../services/walletSync').schedule(acc._id);
    res.json({ success: true, name });
  } catch (e) { fail(res, e); }
};

const myQr = async (req, res) => {
  try {
    const acc = await myAccount(req);
    const svg = await QRCode.toString(acc.qrCode, { type: 'svg', margin: 1, errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' } });
    res.set('Content-Type', 'image/svg+xml').set('Cache-Control', 'private, max-age=300').send(svg);
  } catch (e) { fail(res, e); }
};

/** رابط تنزيل مؤقت: Safari يفتح .pkpass بالانتقال لرابط (لا يمكن إرسال توكن في الترويسة). */
const myAppleLink = async (req, res) => {
  try {
    if (!apple.isConfigured()) return res.status(503).json({ success: false, message: 'Apple Wallet غير مفعّل بعد لدى المطعم' });
    const acc = await myAccount(req);
    const t = jwt.sign({ a: String(acc._id), k: 'pkpass' }, DL_SECRET(), { expiresIn: '10m' });
    const base = String(process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');
    res.json({ success: true, url: `${base}/api/loyalty/apple/download/${t}` });
  } catch (e) { fail(res, e); }
};

const appleDownload = async (req, res) => {
  let payload;
  try { payload = jwt.verify(String(req.params.token || ''), DL_SECRET()); } catch (_) { return res.status(410).send('انتهت صلاحية الرابط — ارجع لصفحة البطاقة واضغط الزر مرة أخرى'); }
  if (payload.k !== 'pkpass' || !isId(payload.a)) return res.status(400).send('رابط غير صالح');
  const acc = await LoyaltyAccount.findById(payload.a).lean();
  if (!acc) return res.status(404).send('غير موجود');
  try {
    const prog = await loyalty.program();
    const buf = await apple.buildPass(acc, prog, { ...(await brand()), rewards: await loyalty.rewards(true) });
    await LoyaltyAccount.updateOne({ _id: acc._id }, { $set: { 'apple.issuedAt': acc.apple && acc.apple.issuedAt ? acc.apple.issuedAt : new Date(), 'apple.lastError': '' } });
    res.set('Content-Type', 'application/vnd.apple.pkpass')
      .set('Content-Disposition', `attachment; filename="${acc.memberNo}.pkpass"`)
      .set('Last-Modified', new Date(acc.passUpdatedAt || Date.now()).toUTCString())
      .send(buf);
  } catch (e) {
    await LoyaltyAccount.updateOne({ _id: acc._id }, { $set: { 'apple.lastError': String(e.message).slice(0, 300), 'apple.lastErrorAt': new Date() } }).catch(() => {});
    res.status(e.status || 500).send(e.status ? e.message : 'تعذّر إنشاء البطاقة');
  }
};

const myGoogleLink = async (req, res) => {
  try {
    if (!google.isConfigured()) return res.status(503).json({ success: false, message: 'Google Wallet غير مفعّل بعد لدى المطعم' });
    const acc = await myAccount(req);
    const out = await google.saveUrl(acc.toObject ? acc.toObject() : acc, await loyalty.program(), await brand());
    res.json({ success: true, url: out.url, mode: out.mode });
  } catch (e) {
    fail(res, e);
  }
};

/* ═════════ الكاشير ═════════ */

const staffView = (acc, rewards) => ({
  account: { _id: acc._id, memberNo: acc.memberNo, name: acc.name, phone: maskPhone(acc.phone), balance: acc.balance, status: acc.status },
  rewards: rewards.map((r) => publicReward(r, acc.balance)),
});

const lookup = async (req, res) => {
  try {
    const { code, phone } = req.query;
    let acc = null;
    if (code) acc = await loyalty.findByCode(code);
    else if (phone) {
      if (!normalizeJo(phone)) return res.status(400).json({ success: false, message: 'رقم الهاتف غير صالح' });
      acc = await loyalty.findByPhone(phone);
    } else return res.status(400).json({ success: false, message: 'أدخل رقم الهاتف أو امسح بطاقة الولاء' });
    if (!acc) return res.status(404).json({ success: false, code: 'NOT_MEMBER', message: code ? 'بطاقة غير معروفة' : 'لا توجد عضوية بهذا الرقم', canEnroll: !!phone });
    const prog = await loyalty.program();
    res.json({ success: true, enabled: prog.enabled, ...staffView(acc, await loyalty.rewards(true)) });
  } catch (e) { fail(res, e); }
};

const enroll = async (req, res) => {
  try {
    const acc = await loyalty.ensureAccount({ phone: req.body && req.body.phone, name: req.body && req.body.name });
    logActivity({ req, action: 'loyalty.enroll', details: { memberNo: acc.memberNo } });
    res.status(201).json({ success: true, ...staffView(acc, await loyalty.rewards(true)) });
  } catch (e) { fail(res, e); }
};

/** معاينة الخصم — نفس حساب البيع (أسعار من القاعدة)، بلا أي تغيير على الرصيد. */
const quote = async (req, res) => {
  try {
    const { rewardId, items } = req.body || {};
    if (!isId(rewardId)) return res.status(400).json({ success: false, message: 'مكافأة غير صالحة' });
    const ids = (Array.isArray(items) ? items : []).map((i) => i.product).filter(isId);
    const products = await Product.find({ _id: { $in: ids } }).lean();
    const byId = new Map(products.map((p) => [String(p._id), p]));
    let itemsTotal = 0; const priced = [];
    for (const it of items || []) {
      const p = byId.get(String(it.product)); if (!p) continue;
      const q = Math.max(parseInt(it.quantity, 10) || 1, 1);
      const addons = (Array.isArray(it.addons) ? it.addons : []).reduce((s, a) => s + Number(((p.addons || []).find((x) => x.name === a.name) || {}).price || 0), 0);
      itemsTotal += (Number(p.price) + addons) * q;
      priced.push({ product: p._id, basePrice: Number(p.price), price: Number(p.price) + addons, quantity: q });
    }
    const reward = await require('../models/LoyaltyReward').findById(rewardId).lean();
    if (!reward) return res.status(404).json({ success: false, message: 'المكافأة غير موجودة' });
    const discount = loyalty.rewardDiscount(reward, priced, itemsTotal);
    res.json({ success: true, discount, pointsCost: reward.pointsCost, itemsTotal: Math.round(itemsTotal * 1000) / 1000, total: Math.round((itemsTotal - discount) * 1000) / 1000 });
  } catch (e) { fail(res, e); }
};

/* ═════════ الإدارة ═════════ */

const escRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const adminList = async (req, res) => {
  const q = String(req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const filter = {};
  if (q) {
    const p = normalizeJo(q);
    filter.$or = [{ memberNo: new RegExp(escRx(q), 'i') }, { name: new RegExp(escRx(q), 'i') }, ...(p ? [{ phone: p }] : [{ phone: new RegExp(escRx(q.replace(/^0/, ''))) }])];
  }
  const [rows, total] = await Promise.all([
    LoyaltyAccount.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * 30).limit(30).lean(),
    LoyaltyAccount.countDocuments(filter),
  ]);
  res.json({ success: true, total, page, accounts: rows.map((a) => ({
    _id: a._id, memberNo: a.memberNo, name: a.name, phone: localJo(a.phone), balance: a.balance, lifetimeEarned: a.lifetimeEarned,
    lifetimeRedeemed: a.lifetimeRedeemed, status: a.status, updatedAt: a.updatedAt,
    apple: { devices: (a.apple && a.apple.registeredDevices) || 0, issued: !!(a.apple && a.apple.issuedAt), error: (a.apple && a.apple.lastError) || '' },
    google: { issued: !!(a.google && a.google.objectId), error: (a.google && a.google.lastError) || '' },
  })) });
};

const adminGet = async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ success: false, message: 'معرّف غير صالح' });
  const a = await LoyaltyAccount.findById(req.params.id).lean();
  if (!a) return res.status(404).json({ success: false, message: 'غير موجود' });
  const txs = await LoyaltyTransaction.find({ account: a._id }).sort({ createdAt: -1 }).limit(200).lean();
  res.json({ success: true, account: { ...a, phone: localJo(a.phone) }, transactions: txs });
};

const adminAdjust = async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ success: false, message: 'معرّف غير صالح' });
    const out = await loyalty.adjust(req.params.id, req.body || {}, req.user);
    logActivity({ req, action: 'loyalty.adjust', amount: out.tx.points,
      details: { memberNo: out.account && out.account.memberNo, points: out.tx.points, reason: out.tx.reason, balanceAfter: out.tx.balanceAfter } });
    res.json({ success: true, transaction: out.tx, balance: out.account && out.account.balance });
  } catch (e) { fail(res, e); }
};

const adminRecalc = async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ success: false, message: 'معرّف غير صالح' });
    const out = await loyalty.recalc(req.params.id);
    logActivity({ req, action: 'loyalty.recalc', details: out });
    res.json({ success: true, ...out });
  } catch (e) { fail(res, e); }
};

const adminStatus = async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ success: false, message: 'معرّف غير صالح' });
    const status = req.body && req.body.status === 'blocked' ? 'blocked' : 'active';
    const a = await LoyaltyAccount.findOneAndUpdate({ _id: req.params.id }, { $set: { status, passUpdatedAt: new Date() }, $inc: { passVersion: 1 } }, { new: true }).lean();
    if (!a) return res.status(404).json({ success: false, message: 'غير موجود' });
    logActivity({ req, action: status === 'blocked' ? 'loyalty.block' : 'loyalty.unblock', details: { memberNo: a.memberNo } });
    require('../services/walletSync').schedule(a._id);
    res.json({ success: true, status });
  } catch (e) { fail(res, e); }
};

const adminProgram = async (req, res) => res.json({ success: true, program: await loyalty.program() });

const adminProgramSave = async (req, res) => {
  try {
    const before = await loyalty.program();
    const p = await loyalty.updateProgram(req.body || {}, req.user);
    logActivity({ req, action: 'loyalty.program', details: {
      before: { earnPerJod: before.earnPerJod, redeemPointsPerJod: before.redeemPointsPerJod, enabled: before.enabled },
      after: { earnPerJod: p.earnPerJod, redeemPointsPerJod: p.redeemPointsPerJod, enabled: p.enabled } } });
    google.syncClass(p, await brand()).catch(() => {});
    res.json({ success: true, program: p });
  } catch (e) { fail(res, e); }
};

const adminRewards = async (req, res) => res.json({ success: true, rewards: await loyalty.rewards(false) });

const adminRewardSave = async (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    if (body.type === 'free_item' && body.product) {
      if (!isId(body.product)) return res.status(400).json({ success: false, message: 'صنف غير صالح' });
      const p = await Product.findById(body.product).select('nameAr').lean();
      if (!p) return res.status(400).json({ success: false, message: 'الصنف غير موجود' });
      body.productName = p.nameAr;
    }
    const id = req.params.id && isId(req.params.id) ? req.params.id : null;
    const r = await loyalty.saveReward(id, body, req.user);
    logActivity({ req, action: id ? 'loyalty.reward.update' : 'loyalty.reward.create', details: { name: r.name, pointsCost: r.pointsCost, active: r.active } });
    res.status(id ? 200 : 201).json({ success: true, reward: r });
  } catch (e) { fail(res, e); }
};

const adminIntegrations = async (req, res) => {
  const [accounts, agg, appleErr, googleErr] = await Promise.all([
    LoyaltyAccount.countDocuments({}),
    LoyaltyAccount.find({}).select('balance apple.issuedAt apple.registeredDevices google.objectId').lean(),
    LoyaltyAccount.find({ 'apple.lastError': { $nin: ['', null] } }).sort({ 'apple.lastErrorAt': -1 }).limit(10).select('memberNo name apple').lean(),
    LoyaltyAccount.find({ 'google.lastError': { $nin: ['', null] } }).sort({ 'google.lastErrorAt': -1 }).limit(10).select('memberNo name google').lean(),
  ]);
  res.json({
    success: true,
    apple: apple.status(),
    google: google.status(),
    stats: {
      accounts, outstandingPoints: agg.reduce((s, a) => s + (a.balance || 0), 0),
      appleIssued: agg.filter((a) => a.apple && a.apple.issuedAt).length,
      appleOnDevices: agg.filter((a) => a.apple && a.apple.registeredDevices > 0).length,
      googleIssued: agg.filter((a) => a.google && a.google.objectId).length,
    },
    errors: [
      ...appleErr.map((a) => ({ wallet: 'apple', memberNo: a.memberNo, name: a.name, error: a.apple.lastError, at: a.apple.lastErrorAt })),
      ...googleErr.map((a) => ({ wallet: 'google', memberNo: a.memberNo, name: a.name, error: a.google.lastError, at: a.google.lastErrorAt })),
    ].sort((x, y) => new Date(y.at || 0) - new Date(x.at || 0)).slice(0, 15),
  });
};

/* ═════════ Apple Wallet Passes Web Service ═════════ */

const passTypeOk = (t) => t === String(process.env.APPLE_PASS_TYPE_ID || '');

const appleRegister = async (req, res) => {
  const { deviceId, passTypeId, serial } = req.params;
  if (!passTypeOk(passTypeId) || !apple.tokenMatches(serial, req.headers.authorization)) return res.sendStatus(401);
  const pushToken = String((req.body && req.body.pushToken) || '').slice(0, 200);
  if (!pushToken) return res.sendStatus(400);
  res.sendStatus(await apple.register({ deviceLibraryId: String(deviceId).slice(0, 200), passTypeId, serialNumber: serial, pushToken }));
};

const appleUnregister = async (req, res) => {
  const { deviceId, passTypeId, serial } = req.params;
  if (!passTypeOk(passTypeId) || !apple.tokenMatches(serial, req.headers.authorization)) return res.sendStatus(401);
  res.sendStatus(await apple.unregister({ deviceLibraryId: String(deviceId), passTypeId, serialNumber: serial }));
};

const appleSerials = async (req, res) => {
  const { deviceId, passTypeId } = req.params;
  if (!passTypeOk(passTypeId)) return res.sendStatus(404);
  const out = await apple.updatedSerials({ deviceLibraryId: String(deviceId), passTypeId, since: req.query.passesUpdatedSince });
  if (!out) return res.sendStatus(404);
  if (!out.serialNumbers.length) return res.sendStatus(204);
  res.json(out);
};

const appleLatestPass = async (req, res) => {
  const { passTypeId, serial } = req.params;
  if (!passTypeOk(passTypeId) || !apple.tokenMatches(serial, req.headers.authorization)) return res.sendStatus(401);
  const acc = await LoyaltyAccount.findOne({ memberNo: serial }).lean();
  if (!acc) return res.sendStatus(404);
  const lm = new Date(acc.passUpdatedAt || acc.updatedAt || Date.now());
  const ims = req.headers['if-modified-since'] ? new Date(req.headers['if-modified-since']) : null;
  if (ims && !isNaN(ims) && Math.floor(lm.getTime() / 1000) <= Math.floor(ims.getTime() / 1000)) return res.sendStatus(304);
  try {
    const buf = await apple.buildPass(acc, await loyalty.program(), { ...(await brand()), rewards: await loyalty.rewards(true) });
    res.set('Content-Type', 'application/vnd.apple.pkpass').set('Last-Modified', lm.toUTCString()).send(buf);
  } catch (e) {
    await LoyaltyAccount.updateOne({ _id: acc._id }, { $set: { 'apple.lastError': String(e.message).slice(0, 300), 'apple.lastErrorAt': new Date() } }).catch(() => {});
    res.sendStatus(500);
  }
};

const appleLog = async (req, res) => {
  const logs = Array.isArray(req.body && req.body.logs) ? req.body.logs.slice(0, 20) : [];
  logs.forEach((l) => console.warn('Apple Wallet log:', String(l).slice(0, 300)));
  res.sendStatus(200);
};

module.exports = wrapAll({
  me, myName, myQr, myAppleLink, myGoogleLink, appleDownload,
  lookup, enroll, quote,
  adminList, adminGet, adminAdjust, adminRecalc, adminStatus, adminProgram, adminProgramSave, adminRewards, adminRewardSave, adminIntegrations,
  appleRegister, appleUnregister, appleSerials, appleLatestPass, appleLog,
});
