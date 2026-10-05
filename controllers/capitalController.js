const mongoose = require('mongoose');
const CapitalEntry = require('../models/CapitalEntry');
const { wrapAll } = require('../utils/asyncHandler');
const { logActivity } = require('../utils/activity');

const nameOf = (u) => (u && (u.name || u.username)) || '';
const r3 = (n) => Number(Number(n || 0).toFixed(3));
const day = (s) => new Date(`${s}T00:00:00+03:00`);
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

const balanceNow = async () => {
  const all = await CapitalEntry.find({ voided: { $ne: true } }).select('type amount').lean();
  const deposits = all.filter((e) => e.type === 'deposit').reduce((t, e) => t + e.amount, 0);
  const withdrawals = all.filter((e) => e.type !== 'deposit').reduce((t, e) => t + e.amount, 0);
  return { balance: r3(deposits - withdrawals), deposits: r3(deposits), withdrawals: r3(withdrawals) };
};

// GET /api/capital?from&to&type&page&limit — الرصيد الحالي + الحركات
const getCapital = async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const f = {};
  if (['deposit', 'withdraw', 'expense'].includes(req.query.type)) f.type = req.query.type;
  if (req.query.voided !== '1') f.voided = { $ne: true };
  if (isYmd(req.query.from) || isYmd(req.query.to)) {
    f.date = {};
    if (isYmd(req.query.from)) f.date.$gte = day(req.query.from);
    if (isYmd(req.query.to)) f.date.$lt = new Date(day(req.query.to).getTime() + 86400000);
  }
  const [data, total, totals, inRange] = await Promise.all([
    CapitalEntry.find(f).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    CapitalEntry.countDocuments(f),
    balanceNow(),
    CapitalEntry.find({ ...f, voided: { $ne: true } }).select('type amount').lean(),
  ]);
  const inD = inRange.filter((e) => e.type === 'deposit').reduce((t, e) => t + e.amount, 0);
  const inW = inRange.filter((e) => e.type !== 'deposit').reduce((t, e) => t + e.amount, 0);
  res.json({
    success: true,
    ...totals,
    range: { deposits: r3(inD), withdrawals: r3(inW), net: r3(inD - inW), count: inRange.length },
    data,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

// POST /api/capital { type: deposit|withdraw, amount, note, date }
const addEntry = async (req, res) => {
  const type = req.body && req.body.type;
  const amount = Number(req.body && req.body.amount);
  if (!['deposit', 'withdraw'].includes(type)) return res.status(400).json({ message: 'نوع الحركة: إيداع أو سحب' });
  if (!(amount > 0) || amount > 10000000) return res.status(400).json({ message: 'أدخل مبلغاً صحيحاً' });
  if (type === 'withdraw') {
    const { balance } = await balanceNow();
    if (amount > balance + 1e-9) return res.status(400).json({ message: `الرصيد الحالي (${balance.toFixed(3)}) لا يكفي للسحب` });
  }
  let date = new Date();
  if (req.body.date) {
    const t = new Date(req.body.date);
    if (!isNaN(t) && t.getTime() <= Date.now() + 60000) date = t;
  }
  const entry = await CapitalEntry.create({
    type, amount: r3(amount), note: String(req.body.note || '').trim().slice(0, 200), date,
    createdBy: req.user._id, createdByName: nameOf(req.user),
  });
  logActivity({ req, action: type === 'deposit' ? 'capital.deposit' : 'capital.withdraw', amount: entry.amount, details: { name: entry.note } });
  res.status(201).json({ success: true, entry, ...(await balanceNow()) });
};

// PATCH /api/capital/:id/void — لمدير النظام وحده (حركات المصروف تُلغى بإلغاء سندها)
const voidEntry = async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'إلغاء حركات رأس المال لمدير النظام فقط' });
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'معرّف غير صالح' });
  const e = await CapitalEntry.findById(req.params.id);
  if (!e || e.voided) return res.status(404).json({ message: 'الحركة غير موجودة أو ملغاة' });
  if (e.type === 'expense') return res.status(400).json({ message: 'هذه حركة سند صرف — ألغِ السند نفسه من «سجل المصروف»' });
  e.voided = true; e.voidedAt = new Date(); e.voidedByName = nameOf(req.user);
  await e.save();
  logActivity({ req, action: 'capital.void', amount: e.amount, details: { name: e.note } });
  res.json({ success: true, ...(await balanceNow()) });
};

module.exports = wrapAll({ getCapital, addEntry, voidEntry });
