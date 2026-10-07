const mongoose = require('mongoose');
const ActivityLog = require('../models/ActivityLog');

const ACTIONS = {
  login: 'تسجيل الدخول',
  logout: 'تسجيل الخروج',
  'order.confirm': 'تأكيد طلب',
  'order.status': 'تغيير حالة طلب',
  'order.complete': 'إكمال طلب (تم التسليم)',
  'order.cancel': 'إلغاء طلب',
  'order.assign_driver': 'تعيين موظف توصيل',
  'order.delivery_sent': 'إرسال تفاصيل الطلب للمندوب',
  'order.payment': 'تغيير طريقة الدفع',
  'order.request.accept': 'قبول إضافة أصناف طلبها الزبون',
  'order.request.reject': 'رفض رسالة/إضافة من الزبون',
  'order.request.seen': 'الاطلاع على رسالة الزبون',
  'delivery.map_clean': 'إزالة طلبات عالقة من خريطة التوصيل',
  'pos.sale': 'بيع سفري',
  'shift.open': 'فتح الجرد',
  'shift.close': 'إغلاق الجرد',
  'expense.create': 'تسجيل مصروف',
  'expense.void': 'إلغاء مصروف',
  'receivable.create': 'تسجيل فاتورة مورّد (ذمة على المطعم)',
  'receivable.pay': 'تسديد ذمة لمورّد',
  'receivable.unpay': 'تراجع عن تسديد ذمة مورّد',
  'receivable.delete': 'إزالة فاتورة مورّد',
  'capital.deposit': 'إيداع في رأس المال',
  'capital.withdraw': 'سحب من رأس المال',
  'capital.void': 'إلغاء حركة رأس مال',
  'employee.create': 'إضافة موظف',
  'employee.update': 'تعديل موظف',
  'user.create': 'إضافة مستخدم',
  'user.update': 'تعديل مستخدم',
  'user.delete': 'حذف مستخدم',
  'settings.update': 'تعديل الإعدادات',
  'product.create': 'إضافة صنف',
  'product.update': 'تعديل صنف',
  'product.delete': 'حذف صنف',
  'phone.block': 'حظر رقم',
  'phone.unblock': 'إلغاء حظر رقم',
};

// GET /api/activity?user=&action=&from=&to=&q=&page=&limit=
const listActivity = async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const f = {};
  if (req.query.user && mongoose.Types.ObjectId.isValid(req.query.user)) f.user = req.query.user;
  if (req.query.action && ACTIONS[req.query.action]) f.action = req.query.action;
  if (req.query.from || req.query.to) {
    f.createdAt = {};
    if (req.query.from) f.createdAt.$gte = new Date(`${req.query.from}T00:00:00+03:00`);
    if (req.query.to) f.createdAt.$lt = new Date(new Date(`${req.query.to}T00:00:00+03:00`).getTime() + 86400000);
  }
  if (req.query.q) f.orderNumber = String(req.query.q).trim();

  const [data, total] = await Promise.all([
    ActivityLog.find(f).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ActivityLog.countDocuments(f),
  ]);
  res.json({ success: true, data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
};

// GET /api/activity/actions — أسماء العمليات للفلتر
const listActions = async (req, res) => res.json({ success: true, data: ACTIONS });

module.exports = { listActivity, listActions, ACTIONS };
