const mongoose = require('mongoose');
const ShiftSession = require('../models/ShiftSession');
const { ensureOpenSession, getOpenSession } = require('../services/shiftService');
const { hasPermission } = require('../middlewares/permission');
const { logActivity } = require('../utils/activity');

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// POST /api/shifts/open — «فتح الجرد»: يسجّل من فتح ومتى. إن كانت مفتوحة يعيدها كما هي.
const openShift = async (req, res) => {
  const existing = await getOpenSession(req.user);
  if (existing) {
    return res.json({ success: true, alreadyOpen: true, shift: existing, message: 'لديك جرد مفتوح مسبقاً' });
  }
  const shift = await ensureOpenSession(req.user, { auto: false });
  logActivity({ req, action: 'shift.open', details: { shiftId: shift.shiftId } });
  res.status(201).json({ success: true, shift, message: 'تم فتح الجرد' });
};

// GET /api/shifts/current — دورتي المفتوحة (أو null)
const getCurrentShift = async (req, res) => {
  const shift = await getOpenSession(req.user);
  res.json({ success: true, shift: shift || null });
};

/** من يملك shifts:view يرى كل الدورات؛ غيره يرى دوراته هو فقط. */
const scopeFilter = (req) => (hasPermission(req.user, 'shifts:view') ? {} : { user: req.user._id });

// GET /api/shifts?user=&status=&scope=&from=&to=&q=&page=&limit=
const listShifts = async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const f = scopeFilter(req);

  if (req.query.user && mongoose.Types.ObjectId.isValid(req.query.user) && !f.user) f.user = req.query.user;
  if (['open', 'closed'].includes(req.query.status)) f.status = req.query.status;
  if (['mine', 'all'].includes(req.query.scope)) f.scope = req.query.scope;
  if (req.query.from || req.query.to) {
    f.openedAt = {};
    if (req.query.from) f.openedAt.$gte = new Date(`${req.query.from}T00:00:00+03:00`);
    if (req.query.to) f.openedAt.$lt = new Date(new Date(`${req.query.to}T00:00:00+03:00`).getTime() + 86400000);
  }
  if (req.query.q) f.shiftId = { $regex: esc(String(req.query.q).trim()), $options: 'i' };

  const [data, total] = await Promise.all([
    ShiftSession.find(f).sort({ openedAt: -1 }).skip((page - 1) * limit).limit(limit).select('-summary').lean(),
    ShiftSession.countDocuments(f),
  ]);
  res.json({ success: true, data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
};

// GET /api/shifts/:id — تفاصيل دورة مع ملخصها الكامل كما طُبع
const getShift = async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'معرّف غير صالح' });
  const shift = await ShiftSession.findOne({ _id: req.params.id, ...scopeFilter(req) }).lean();
  if (!shift) return res.status(404).json({ message: 'الدورة غير موجودة' });
  res.json({ success: true, shift });
};

module.exports = { openShift, getCurrentShift, listShifts, getShift };
