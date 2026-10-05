const ActivityLog = require('../models/ActivityLog');

const nameOf = (user) => (user && (user.name || user.username)) || '';

/**
 * يسجّل عملية في سجل نشاط المستخدم — لا ينتظر ولا يرمي أبداً:
 * فشل التسجيل لا يُفشل العملية الأصلية.
 *
 * @param {object} p
 * @param {object} [p.req]   الطلب (يُقرأ منه المستخدم وعنوان IP)
 * @param {object} [p.user]  المستخدم إن لم يوجد req.user (كتسجيل الدخول)
 * @param {string} p.action
 * @param {object} [p.order] الطلب المرتبط (يُقرأ منه المعرّف والرقم والقيمة)
 * @param {string} [p.before] الحالة قبل
 * @param {string} [p.after]  الحالة بعد
 * @param {object} [p.details] تفاصيل ضرورية فقط
 */
const logActivity = ({ req, user, action, order, before, after, details, amount } = {}) => {
  try {
    const u = user || (req && req.user) || null;
    const doc = {
      user: u ? u._id : null,
      userName: nameOf(u),
      role: (u && u.role) || '',
      action,
      order: order ? order._id : null,
      orderNumber: order ? String(order.orderNumber || '') : '',
      amount: amount != null ? Number(amount) : order && order.total != null ? Number(order.total) : null,
      statusBefore: before || '',
      statusAfter: after || '',
      details: details || {},
      ip: req ? String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 64) : '',
    };
    ActivityLog.create(doc).catch((e) => console.error('activity log failed:', e.message));
  } catch (e) {
    console.error('activity log failed:', e.message);
  }
};

module.exports = { logActivity };
