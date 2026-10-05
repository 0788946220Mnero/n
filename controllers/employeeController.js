const mongoose = require('mongoose');
const Employee = require('../models/Employee');
const Expense = require('../models/Expense');
const { wrapAll } = require('../utils/asyncHandler');
const { logActivity } = require('../utils/activity');

const nameOf = (u) => (u && (u.name || u.username)) || '';
const r3 = (n) => Number(Number(n || 0).toFixed(3));
const monthStart = () => {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman', year: 'numeric', month: '2-digit' }).format(new Date());
  return new Date(`${ymd}-01T00:00:00+03:00`);
};
const payDate = (e) => e.spentAt || e.createdAt;

/** مجاميع صرف موظف (غير الملغى): الكل، هذا الشهر، وحسب النوع. */
const totalsOf = (rows) => {
  const ms = monthStart();
  const t = { all: 0, month: 0, salary: 0, advance: 0, bonus: 0, other: 0, count: rows.length };
  rows.forEach((e) => {
    t.all += e.amount;
    if (new Date(payDate(e)) >= ms) t.month += e.amount;
    t[e.kind] = (t[e.kind] || 0) + e.amount;
  });
  Object.keys(t).forEach((k) => { if (k !== 'count') t[k] = r3(t[k]); });
  return t;
};

// GET /api/employees?active=1 — الموظفون مع مجاميع صرفهم
const listEmployees = async (req, res) => {
  const f = req.query.active === '0' ? { active: false } : req.query.active === 'all' ? {} : { active: true };
  const emps = await Employee.find(f).sort({ name: 1 }).lean();
  const pays = await Expense.find({ employee: { $in: emps.map((e) => e._id) }, voided: { $ne: true } }).select('employee amount kind spentAt createdAt').lean();
  const byEmp = new Map();
  pays.forEach((p) => { const k = String(p.employee); if (!byEmp.has(k)) byEmp.set(k, []); byEmp.get(k).push(p); });
  res.json({ success: true, data: emps.map((e) => ({ ...e, totals: totalsOf(byEmp.get(String(e._id)) || []) })) });
};

const pick = (b) => {
  const o = {};
  if (b.name !== undefined) o.name = String(b.name).trim().slice(0, 80);
  if (b.phone !== undefined) o.phone = String(b.phone).trim().slice(0, 20);
  if (b.jobTitle !== undefined) o.jobTitle = String(b.jobTitle).trim().slice(0, 60);
  if (b.salary !== undefined) o.salary = Math.max(0, Number(b.salary) || 0);
  if (b.notes !== undefined) o.notes = String(b.notes).trim().slice(0, 300);
  if (b.startDate !== undefined) o.startDate = b.startDate ? new Date(b.startDate) : null;
  if (b.active !== undefined) o.active = !!b.active;
  return o;
};

const createEmployee = async (req, res) => {
  const data = pick(req.body || {});
  if (!data.name) return res.status(400).json({ message: 'اسم الموظف مطلوب' });
  const emp = await Employee.create({ ...data, createdByName: nameOf(req.user) });
  logActivity({ req, action: 'employee.create', details: { name: emp.name } });
  res.status(201).json({ success: true, employee: emp });
};

const updateEmployee = async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'معرّف غير صالح' });
  const data = pick(req.body || {});
  if (data.name === '') return res.status(400).json({ message: 'اسم الموظف مطلوب' });
  const emp = await Employee.findByIdAndUpdate(req.params.id, { $set: data }, { new: true });
  if (!emp) return res.status(404).json({ message: 'الموظف غير موجود' });
  logActivity({ req, action: 'employee.update', details: { name: emp.name, fields: Object.keys(data) } });
  res.json({ success: true, employee: emp });
};

// GET /api/employees/:id/payments?page&limit — سجل صرف الموظف (الملغى ظاهر للمراجعة)
const employeePayments = async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'معرّف غير صالح' });
  const emp = await Employee.findById(req.params.id).lean();
  if (!emp) return res.status(404).json({ message: 'الموظف غير موجود' });
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const f = { employee: emp._id };
  const [data, total, live] = await Promise.all([
    Expense.find(f).sort({ spentAt: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Expense.countDocuments(f),
    Expense.find({ ...f, voided: { $ne: true } }).select('amount kind spentAt createdAt').lean(),
  ]);
  res.json({ success: true, employee: emp, totals: totalsOf(live), data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
};

module.exports = wrapAll({ listEmployees, createEmployee, updateEmployee, employeePayments });
