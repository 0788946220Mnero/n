const mongoose = require('mongoose');
const Receivable = require('../models/Receivable');
const ExpenseSequence = require('../models/ExpenseSequence');
const { wrapAll } = require('../utils/asyncHandler');
const { logActivity } = require('../utils/activity');

const nameOf = (u) => (u && (u.name || u.username)) || '';
const r3 = (n) => Number(Number(n || 0).toFixed(3));
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const day = (s) => new Date(`${s}T00:00:00+03:00`);
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** رقم تسلسلي مستقل للذمم (نفس عدّاد سندات الصرف بمفتاح مختلف). */
const nextNumber = async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      const c = await ExpenseSequence.findOneAndUpdate({ _id: 'receivable' }, { $inc: { seq: 1 } }, { new: true, upsert: true });
      return c.seq;
    } catch (err) {
      if (err && err.code === 11000 && attempt < 3) continue;
      throw err;
    }
  }
};

// POST /api/receivables  { customerName (المورّد), phone, invoiceNumber, lines:[{name,quantity,price}], amount?, notes }
const createReceivable = async (req, res) => {
  const b = req.body || {};
  const customerName = String(b.customerName || '').trim();
  if (!customerName) return res.status(400).json({ message: 'اسم المورّد مطلوب' });

  const lines = (Array.isArray(b.lines) ? b.lines : [])
    .map((l) => ({ name: String((l && l.name) || '').trim().slice(0, 120), quantity: Number(l && l.quantity) || 1, price: Number(l && l.price) || 0 }))
    .filter((l) => l.name);
  // المبلغ من الأسطر إن وُجدت، وإلا المُدخل مباشرة
  const amount = lines.length ? r3(lines.reduce((t, l) => t + l.quantity * l.price, 0)) : r3(b.amount);
  if (!(amount > 0)) return res.status(400).json({ message: 'أدخل أصناف الفاتورة بأسعارها، أو المبلغ' });

  const receivable = await Receivable.create({
    number: await nextNumber(),
    customerName,
    phone: String(b.phone || '').trim().slice(0, 20),
    lines,
    amount,
    notes: String(b.notes || '').trim().slice(0, 300),
    invoiceNumber: String(b.invoiceNumber || '').trim().slice(0, 40),
    createdBy: req.user._id,
    createdByName: nameOf(req.user),
  });
  logActivity({ req, action: 'receivable.create', amount, details: { number: receivable.number, name: customerName } });
  res.status(201).json({ success: true, receivable });
};

// GET /api/receivables?status=unpaid|paid&q=&from=&to=&deleted=1&page=&limit=
const listReceivables = async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const isAdmin = req.user.role === 'admin';
  const f = { deleted: isAdmin && req.query.deleted === '1' ? true : { $ne: true } };
  if (['unpaid', 'paid'].includes(req.query.status)) f.status = req.query.status;
  if (isYmd(req.query.from) || isYmd(req.query.to)) {
    f.createdAt = {};
    if (isYmd(req.query.from)) f.createdAt.$gte = day(req.query.from);
    if (isYmd(req.query.to)) f.createdAt.$lt = new Date(day(req.query.to).getTime() + 86400000);
  }
  if (req.query.q) {
    const q = String(req.query.q).trim();
    const rx = { $regex: esc(q), $options: 'i' };
    f.$or = [{ customerName: rx }, { phone: rx }, { notes: rx }, { invoiceNumber: rx }, ...(/^\d+$/.test(q) ? [{ number: Number(q) }] : [])];
  }

  // الأرصدة: المستحق على المطعم كله (غير المدفوع، بلا فلتر تاريخ) — أهم رقم في الذمم
  const [data, total, unpaidAll, filtered] = await Promise.all([
    Receivable.find(f).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Receivable.countDocuments(f),
    Receivable.find({ deleted: { $ne: true }, status: 'unpaid' }).select('amount').lean(),
    Receivable.find(f).select('amount status').lean(),
  ]);
  const sum = (arr) => r3(arr.reduce((t, x) => t + Number(x.amount || 0), 0));
  res.json({
    success: true,
    data,
    totals: {
      outstanding: sum(unpaidAll), outstandingCount: unpaidAll.length,
      filtered: sum(filtered), filteredCount: filtered.length,
      filteredUnpaid: sum(filtered.filter((x) => x.status === 'unpaid')),
      filteredPaid: sum(filtered.filter((x) => x.status === 'paid')),
    },
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

const getReceivable = async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'معرّف غير صالح' });
  const r = await Receivable.findById(req.params.id).lean();
  if (!r || (r.deleted && req.user.role !== 'admin')) return res.status(404).json({ message: 'الفاتورة غير موجودة' });
  res.json({ success: true, receivable: r });
};

// GET /api/receivables/drawers — من يمكن أن يُخرَج المبلغ من صندوقه (المستخدمون النشطون أصحاب الجرد)
const DRAWER_ROLES = ['admin', 'manager', 'cashier', 'employee'];
const canPickDrawer = (u) => !!u && ['admin', 'manager'].includes(u.role);
const listDrawers = async (req, res) => {
  const User = require('../models/User');
  const all = canPickDrawer(req.user)
    ? await User.find({ isActive: true, role: { $in: DRAWER_ROLES } }).select('name username role').sort({ name: 1 }).lean()
    : [];
  const me = { _id: req.user._id, name: nameOf(req.user), role: req.user.role };
  const users = all.length ? all.map((u) => ({ _id: u._id, name: u.name || u.username, role: u.role })) : [me];
  res.json({ success: true, users, canPick: canPickDrawer(req.user), me: String(req.user._id) });
};

// POST /api/receivables/:id/pay  { paymentMethod, source: drawer|capital, drawerUserId } — ذرّي: لا تُسدَّد مرتين
const payReceivable = async (req, res) => {
  const b = req.body || {};
  const method = b.paymentMethod || 'cash';
  if (!['cash', 'cliq', 'card'].includes(method)) return res.status(400).json({ message: 'طريقة دفع غير صالحة' });
  const source = b.source === 'capital' ? 'capital' : 'drawer';
  const CapitalEntry = require('../models/CapitalEntry');
  const { hasPermission } = require('../middlewares/permission');

  const current = await Receivable.findOne({ _id: req.params.id, status: 'unpaid', deleted: { $ne: true } }).lean();
  if (!current) return res.status(409).json({ message: 'الفاتورة مسدَّدة مسبقاً أو غير موجودة' });

  // ── صندوق من؟ مدير النظام والمدير يختاران أي مستخدم؛ غيرهما من صندوقه هو ──
  let drawerUser = req.user._id;
  let drawerUserName = nameOf(req.user);
  if (source === 'drawer' && b.drawerUserId && String(b.drawerUserId) !== String(req.user._id)) {
    if (!canPickDrawer(req.user)) return res.status(403).json({ message: 'التسديد من صندوق مستخدم آخر لمدير النظام والمدير فقط' });
    if (!mongoose.Types.ObjectId.isValid(b.drawerUserId)) return res.status(400).json({ message: 'مستخدم غير صالح' });
    const u = await require('../models/User').findOne({ _id: b.drawerUserId, isActive: true, role: { $in: DRAWER_ROLES } }).select('name username').lean();
    if (!u) return res.status(400).json({ message: 'المستخدم غير موجود أو غير نشط' });
    drawerUser = u._id;
    drawerUserName = u.name || u.username;
  }

  // ── رأس المال: صلاحيته ورصيده ──
  if (source === 'capital') {
    if (!hasPermission(req.user, 'capital:manage')) return res.status(403).json({ message: 'التسديد من رأس المال يحتاج صلاحية «رأس المال»' });
    const all = await CapitalEntry.find({ voided: { $ne: true } }).select('type amount').lean();
    const balance = all.reduce((t, e) => t + CapitalEntry.signed(e), 0);
    if (current.amount > balance + 1e-9) {
      return res.status(400).json({ message: `رصيد رأس المال (${balance.toFixed(3)}) لا يكفي لتسديد ${Number(current.amount).toFixed(3)}` });
    }
  }

  const r = await Receivable.findOneAndUpdate(
    { _id: req.params.id, status: 'unpaid', deleted: { $ne: true } },
    { $set: {
      status: 'paid', paidAt: new Date(), paidBy: req.user._id, paidByName: nameOf(req.user), paymentMethod: method,
      paySource: source,
      drawerUser: source === 'drawer' ? drawerUser : null,
      drawerUserName: source === 'drawer' ? drawerUserName : '',
      // من رأس المال: لا يدخل أي جرد (لا يُنتظر إغلاقه)
      collectionClosed: false,
    } },
    { new: true }
  );
  if (!r) return res.status(409).json({ message: 'الفاتورة مسدَّدة مسبقاً أو غير موجودة' });

  if (source === 'capital') {
    try {
      const entry = await CapitalEntry.create({
        type: 'receivable', amount: r3(r.amount), note: `تسديد فاتورة مورّد #${r.number} — ${r.customerName}${r.invoiceNumber ? ` (${r.invoiceNumber})` : ''}`,
        date: r.paidAt, receivable: r._id, receivableNumber: r.number,
        createdBy: req.user._id, createdByName: nameOf(req.user),
      });
      r.capitalEntry = entry._id;
      await Receivable.updateOne({ _id: r._id }, { $set: { capitalEntry: entry._id } });
    } catch (err) {
      // لم تُسجَّل حركة رأس المال: نعيد الفاتورة غير مدفوعة بدل تسديد بلا أثر
      await Receivable.updateOne({ _id: r._id }, { $set: { status: 'unpaid', paidAt: null, paidBy: null, paidByName: '', paymentMethod: '', paySource: '' } });
      throw err;
    }
  }
  logActivity({
    req, action: 'receivable.pay', amount: r.amount, before: 'unpaid', after: 'paid',
    details: { number: r.number, name: r.customerName, method, source, drawer: source === 'drawer' ? drawerUserName : '' },
  });
  res.json({ success: true, receivable: r });
};

// POST /api/receivables/:id/unpay — تراجع عن التسديد: لمدير النظام وحده، وقبل إغلاق جرد التحصيل
const unpayReceivable = async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'التراجع عن التسديد لمدير النظام فقط' });
  const r = await Receivable.findOneAndUpdate(
    { _id: req.params.id, status: 'paid', collectionClosed: { $ne: true }, deleted: { $ne: true } },
    { $set: { status: 'unpaid', paidAt: null, paidBy: null, paidByName: '', paymentMethod: '', paySource: '', drawerUser: null, drawerUserName: '', capitalEntry: null } },
    { new: false }
  );
  if (!r) return res.status(400).json({ message: 'لا يمكن التراجع: غير مسدَّدة، أو دخل تحصيلها جرداً مغلقاً' });
  // كان من رأس المال: تُلغى حركته فيعود المبلغ للرصيد (ويبقى أثرها ملغاة)
  if (r.paySource === 'capital') {
    await require('../models/CapitalEntry').updateMany(
      { receivable: r._id, voided: { $ne: true } },
      { $set: { voided: true, voidedAt: new Date(), voidedByName: nameOf(req.user) } }
    );
  }
  logActivity({ req, action: 'receivable.unpay', amount: r.amount, before: 'paid', after: 'unpaid', details: { number: r.number, name: r.customerName, source: r.paySource || 'drawer' } });
  const fresh = await Receivable.findById(r._id).lean();
  res.json({ success: true, receivable: fresh });
};

// DELETE /api/receivables/:id — إزالة (أرشفة) لمدير النظام وحده. يُفرض هنا لا في الواجهة.
const deleteReceivable = async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'لا يستطيع إزالة فواتير الذمم إلا مدير النظام' });
  const r = await Receivable.findOneAndUpdate(
    { _id: req.params.id, deleted: { $ne: true } },
    { $set: { deleted: true, deletedAt: new Date(), deletedByName: nameOf(req.user) } },
    { new: true }
  );
  if (!r) return res.status(404).json({ message: 'الفاتورة غير موجودة أو أُزيلت مسبقاً' });
  logActivity({ req, action: 'receivable.delete', amount: r.amount, details: { number: r.number, name: r.customerName, status: r.status } });
  res.json({ success: true });
};

module.exports = wrapAll({ createReceivable, listReceivables, getReceivable, payReceivable, unpayReceivable, deleteReceivable, listDrawers });
