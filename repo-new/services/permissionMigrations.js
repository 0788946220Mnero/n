/*
  ═══════════════════════════════════════════════════════════════
  ترحيل الصلاحيات لمرة واحدة عند بدء الخادم.

  «المبيعات وإغلاق الجرد لمدير النظام» (sales-admin-only-v1):
    صلاحيات الأدوار الافتراضية تغيّرت في utils/permissions.js، لكن من حُفظت له
    «صلاحيات مخصّصة» يحمل نسخة قديمة منها (كانت تُعلَّم تلقائياً من صلاحيات دوره).
    نسحب منها مرة واحدة: إغلاق الجرد، عرض المبيعات، الإحصائيات، سجل الجرد —
    ما عدا مدير النظام (كل الصلاحيات دائماً) ومراقب البيانات (دوره العرض أصلاً).
    كل حساب تغيّر يُسجَّل في «سجل النشاط»، ثم يمنحها مدير النظام لمن يريد،
    والعلامة تمنع التكرار فيبقى قراره.
  ═══════════════════════════════════════════════════════════════
*/
const SystemMigration = require('../models/SystemMigration');
const { SALES_KEYS } = require('../utils/permissions');

const SALES_KEY = 'sales-admin-only-v1';
const SKIP_ROLES = ['admin', 'observer', 'delivery'];
const SYSTEM = { _id: null, name: 'تحديث النظام', role: 'system' };

async function migrateSalesPermissions() {
  if (await SystemMigration.findOne({ key: SALES_KEY }).lean()) return 0;
  const User = require('../models/User');
  const users = await User.find({ role: { $ne: 'admin' } }).select('name username role permissions').lean();
  let changed = 0;
  for (const u of users) {
    const own = Array.isArray(u.permissions) ? u.permissions : [];
    if (!own.length || SKIP_ROLES.includes(u.role)) continue; // بلا مخصّصة: يرث دوره الجديد
    const removed = own.filter((k) => SALES_KEYS.includes(k));
    if (!removed.length) continue;
    const kept = own.filter((k) => !SALES_KEYS.includes(k));
    await User.updateOne({ _id: u._id }, { $set: { permissions: kept } });
    changed++;
    try {
      require('../utils/activity').logActivity({
        user: SYSTEM, action: 'permissions.sales',
        details: { forUser: u.name || u.username, removed },
      });
    } catch (_) { /* السجل لا يُفشل الترحيل */ }
  }
  try {
    await SystemMigration.create({ key: SALES_KEY, changed });
  } catch (e) {
    if (!(e && e.code === 11000)) throw e; // نسخة أخرى من الخادم سبقت
  }
  if (changed) console.log(`الصلاحيات: سُحبت صلاحيات المبيعات وإغلاق الجرد من ${changed} مستخدم بصلاحيات مخصّصة (مرة واحدة)`);
  return changed;
}

function start() {
  migrateSalesPermissions().catch((e) => console.error('sales permissions migration:', e.message));
}

module.exports = { migrateSalesPermissions, start, SALES_KEY };
