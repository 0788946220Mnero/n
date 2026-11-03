const mongoose = require('mongoose');
const SupplyItem = require('../models/SupplyItem');
const { wrapAll } = require('../utils/asyncHandler');

const nameOf = (u) => (u && (u.name || u.username)) || '';

// GET /api/supplies?status=needed|bought — المطلوب أولاً (العاجل في الأعلى)
const listSupplies = async (req, res) => {
  const status = ['needed', 'bought'].includes(req.query.status) ? req.query.status : 'needed';
  const sort = status === 'needed' ? { urgent: -1, createdAt: 1 } : { boughtAt: -1 };
  const data = await SupplyItem.find({ status }).sort(sort).limit(status === 'bought' ? 100 : 500).lean();
  res.json({ success: true, data });
};

// POST /api/supplies { name, quantity, note, urgent }
const addSupply = async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ message: 'اسم البضاعة مطلوب' });
  const item = await SupplyItem.create({
    name: name.slice(0, 120),
    quantity: String(req.body.quantity || '').trim().slice(0, 40),
    note: String(req.body.note || '').trim().slice(0, 200),
    urgent: !!req.body.urgent,
    addedBy: req.user._id,
    addedByName: nameOf(req.user),
  });
  res.status(201).json({ success: true, item });
};

// PATCH /api/supplies/:id { status?, quantity?, note?, urgent? }
const updateSupply = async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'معرّف غير صالح' });
  const set = {};
  if (['needed', 'bought'].includes(req.body.status)) {
    set.status = req.body.status;
    set.boughtAt = req.body.status === 'bought' ? new Date() : null;
    set.boughtByName = req.body.status === 'bought' ? nameOf(req.user) : '';
  }
  if (req.body.quantity !== undefined) set.quantity = String(req.body.quantity).trim().slice(0, 40);
  if (req.body.note !== undefined) set.note = String(req.body.note).trim().slice(0, 200);
  if (req.body.urgent !== undefined) set.urgent = !!req.body.urgent;
  const item = await SupplyItem.findByIdAndUpdate(req.params.id, { $set: set }, { new: true });
  if (!item) return res.status(404).json({ message: 'البند غير موجود' });
  res.json({ success: true, item });
};

// DELETE /api/supplies/:id — حذف بند (لمن أضافه، أو المدير والأدمن)
const deleteSupply = async (req, res) => {
  const item = await SupplyItem.findById(req.params.id);
  if (!item) return res.status(404).json({ message: 'البند غير موجود' });
  const manager = ['admin', 'manager'].includes(req.user.role);
  if (!manager && String(item.addedBy) !== String(req.user._id)) {
    return res.status(403).json({ message: 'تحذف البنود التي أضفتها فقط' });
  }
  await item.deleteOne();
  res.json({ success: true });
};

module.exports = wrapAll({ listSupplies, addSupply, updateSupply, deleteSupply });
