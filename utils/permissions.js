/*
  ═══════════════════════════════════════════════════════════════
  كتالوج الصلاحيات — المصدر الوحيد للحقيقة.

  المفاتيح هنا مطابقة تماماً لما تستخدمه لوحة التحكم في
  SECTION_PERMISSION و data-perm، فلا تُغيّر مفتاحاً دون تغييره هناك.

  قاعدة العمل:
    • مصفوفة permissions فارغة للمستخدم  →  يرث صلاحيات دوره
    • مصفوفة غير فارغة                    →  صلاحيات مخصّصة تتجاوز الدور
    • دور admin                            →  كل الصلاحيات دائماً
  ═══════════════════════════════════════════════════════════════
*/

const PERMISSIONS = [
  { key: 'stats:view', label: 'عرض لوحة المعلومات والإحصائيات' },
  { key: 'orders:view', label: 'عرض الطلبات' },
  { key: 'orders:manage', label: 'تأكيد الطلبات وتغيير حالتها' },
  { key: 'orders:closeShift', label: 'إغلاق الجرد (تقرير الوردية)' },
  { key: 'products:view', label: 'عرض الأصناف' },
  { key: 'products:edit', label: 'إضافة وتعديل وحذف الأصناف' },
  { key: 'categories:edit', label: 'إدارة التصنيفات' },
  { key: 'customers:view', label: 'عرض الزبائن' },
  { key: 'customers:manage', label: 'توثيق وتعديل بيانات الزبائن' },
  { key: 'printers:manage', label: 'إدارة الطابعات والطباعة' },
  { key: 'settings:manage', label: 'إعدادات المطعم والعروض' },
  { key: 'users:manage', label: 'إدارة المستخدمين والصلاحيات' },
];

const ALL_KEYS = PERMISSIONS.map((p) => p.key);

const ROLE_PERMISSIONS = {
  admin: [...ALL_KEYS],
  manager: ALL_KEYS.filter((k) => k !== 'users:manage'),
  cashier: [
    'orders:view',
    'orders:manage',
    'products:view',
    'customers:view',
    'customers:manage',
    'printers:manage',
  ],
  employee: ['orders:view', 'products:view'],
};

// هل يستخدم المستخدم صلاحيات مخصّصة أم يرث صلاحيات دوره؟
const usesCustomPermissions = (user) =>
  user.role !== 'admin' && Array.isArray(user.permissions) && user.permissions.length > 0;

// الصلاحيات الفعلية للمستخدم
const effectivePermissionsFor = (user) => {
  if (!user) return [];
  if (user.role === 'admin') return [...ALL_KEYS];
  if (usesCustomPermissions(user)) return user.permissions.filter((p) => ALL_KEYS.includes(p));
  return ROLE_PERMISSIONS[user.role] || [];
};

// تنظيف مصفوفة قادمة من الواجهة: نقبل المفاتيح المعروفة فقط، بلا تكرار
const sanitizePermissions = (list) => {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((p) => ALL_KEYS.includes(p)))];
};

// يُضيف الحقول التي تتوقعها لوحة التحكم إلى كائن المستخدم
const withPermissionFields = (user) => {
  const plain = typeof user.toObject === 'function' ? user.toObject() : { ...user };
  plain.permissions = Array.isArray(plain.permissions) ? plain.permissions : [];
  plain.usesCustomPermissions = usesCustomPermissions(plain);
  plain.effectivePermissions = effectivePermissionsFor(plain);
  return plain;
};

module.exports = {
  PERMISSIONS,
  ALL_KEYS,
  ROLE_PERMISSIONS,
  effectivePermissionsFor,
  usesCustomPermissions,
  sanitizePermissions,
  withPermissionFields,
};
