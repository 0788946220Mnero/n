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
  { key: 'delivery:manage', label: 'نظام التوصيل: الخريطة وتعيين المندوبين وسجل التوصيل' },
  { key: 'activity:view', label: 'سجل نشاط المستخدمين' },
  { key: 'shifts:view', label: 'سجل الجرد (كل الدورات)' },
  { key: 'delivery:mapManage', label: 'إدارة خريطة التوصيل: إزالة الطلبات العالقة من جرد سابق' },
  { key: 'receivables:manage', label: 'ذمم الموردين: تسجيل فواتير الموردين وتسديدها وطباعتها (الإزالة لمدير النظام فقط)' },
  { key: 'supplies:manage', label: 'قائمة البضائع المطلوبة للمطعم' },
  { key: 'capital:manage', label: 'رأس المال: الرصيد والإيداع والسحب والصرف منه' },
  { key: 'employees:manage', label: 'الموظفون: إضافتهم وتعديلهم وكشوف حساباتهم' },
  { key: 'employees:pay', label: 'صرف للموظفين: رواتب وسلف ومكافآت (بتوقيع من يصرف)' },
  { key: 'center:sell', label: 'بيع سنتر: استقبال طلبات الزبائن هاتفياً وإرسالها للمطعم (مع سجل الزبون)' },
  { key: 'center:monitor', label: 'مراقبة موظفي السنتر: اتصالهم وانقطاعهم وطلباتهم' },
];

const ALL_KEYS = PERMISSIONS.map((p) => p.key);

const ROLE_PERMISSIONS = {
  admin: [...ALL_KEYS],
  // رأس المال لمدير النظام وحده افتراضياً (يُمنح لغيره من «المستخدمون» عند الحاجة)
  // رأس المال وصرف الموظفين: لمدير النظام افتراضياً، ويُمنحان لغيره من «المستخدمون»
  manager: ALL_KEYS.filter((k) => !['users:manage', 'capital:manage', 'employees:pay'].includes(k)),
  cashier: [
    'orders:view',
    'orders:manage',
    'orders:closeShift', // الجرد لكل مستخدم: الكاشير يُغلق جرده هو
    'products:view',
    'customers:view',
    'customers:manage',
    'printers:manage',
    'delivery:manage', // الكاشير يعيّن المندوب ويرسل الطلب — كما كان يفعل من قائمة الطلبات
    'receivables:manage', // ذمم الموردين: تسجيل وتسديد وطباعة (الإزالة لمدير النظام وحده)
    'supplies:manage', // قائمة البضائع المطلوبة
    'center:sell', // بيع سنتر من داخل المطعم (يُؤكَّد ويُطبع فوراً)
  ],
  employee: ['orders:view', 'products:view', 'center:sell'],
  // موظف سنتر (من المنزل): يستقبل الاتصالات ويرسل الطلبات للمطعم فقط —
  // لا دفع ولا إلغاء ولا بيع سفري ولا قوائم الطلبات والزبائن (يفرضه الخادم أيضاً)
  center: ['center:sell'],
  delivery: [], // حساب محاسبي للمندوب — بلا دخول ولا صلاحيات
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
