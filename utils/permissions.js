/*
  ═══════════════════════════════════════════════════════════════
  كتالوج الصلاحيات — المصدر الوحيد للحقيقة.

  المفاتيح هنا مطابقة تماماً لما تستخدمه لوحة التحكم في
  SECTION_PERMISSION و data-perm، فلا تُغيّر مفتاحاً دون تغييره هناك.

  قاعدة العمل:
    • مصفوفة permissions فارغة للمستخدم  →  يرث صلاحيات دوره
    • مصفوفة غير فارغة                    →  صلاحيات مخصّصة تتجاوز الدور
    • دور admin                            →  كل الصلاحيات دائماً
    • دور observer (مراقب بيانات)          →  صلاحيات «عرض» فقط (view: true) مهما مُنح،
                                              والخادم يرفض أي تعديل منه (middlewares/auth.js)
  ═══════════════════════════════════════════════════════════════
*/

const PERMISSIONS = [
  { key: 'stats:view', label: 'عرض لوحة المعلومات والإحصائيات', view: true },
  { key: 'orders:view', label: 'عرض الطلبات والمبيعات', view: true },
  { key: 'orders:manage', label: 'تأكيد الطلبات وتغيير حالتها' },
  { key: 'orders:closeShift', label: 'إغلاق الجرد (تقرير الوردية)' },
  { key: 'products:view', label: 'عرض الأصناف', view: true },
  { key: 'products:edit', label: 'إضافة وتعديل وحذف الأصناف' },
  { key: 'categories:edit', label: 'إدارة التصنيفات' },
  { key: 'customers:view', label: 'عرض الزبائن', view: true },
  { key: 'customers:manage', label: 'توثيق وتعديل بيانات الزبائن' },
  { key: 'printers:manage', label: 'إدارة الطابعات والطباعة' },
  { key: 'settings:manage', label: 'إعدادات المطعم والعروض' },
  { key: 'users:manage', label: 'إدارة المستخدمين والصلاحيات' },
  { key: 'delivery:manage', label: 'نظام التوصيل: الخريطة وتعيين المندوبين وسجل التوصيل' },
  { key: 'activity:view', label: 'سجل نشاط المستخدمين', view: true },
  { key: 'shifts:view', label: 'سجل الجرد وقيمه (كل الدورات)', view: true },
  { key: 'delivery:mapManage', label: 'إدارة خريطة التوصيل: إزالة الطلبات العالقة من جرد سابق' },
  { key: 'receivables:manage', label: 'ذمم الموردين: تسجيل فواتير الموردين وتسديدها وطباعتها (الإزالة لمدير النظام فقط)' },
  { key: 'supplies:manage', label: 'قائمة البضائع المطلوبة للمطعم' },
  { key: 'capital:manage', label: 'رأس المال: الرصيد والإيداع والسحب والصرف منه' },
  { key: 'employees:manage', label: 'الموظفون: إضافتهم وتعديلهم وكشوف حساباتهم' },
  { key: 'employees:pay', label: 'صرف للموظفين: رواتب وسلف ومكافآت (بتوقيع من يصرف)' },
  { key: 'center:sell', label: 'بيع سنتر: استقبال طلبات الزبائن هاتفياً وإرسالها للمطعم (مع سجل الزبون)' },
  { key: 'center:monitor', label: 'مراقبة موظفي السنتر: اتصالهم وانقطاعهم وطلباتهم' },
  { key: 'voice:commands', label: 'مستقبل أوامر المدير (أوامر صوتية) — كل أمر يُنفَّذ بصلاحيات المستخدم نفسه' },
  { key: 'staff:notify', label: 'إشعارات الطاقم: إرسال إشعار لأجهزة المستخدمين، واختيار إشعارات الحركات والمبيعات ولمن تصل' },
  { key: 'stats:live', label: 'التقرير الحي على شاشة القفل: المبيعات والمصروفات ومن جرده مفتوح (يُخفى حتى Face ID)' },
  { key: 'images:cloud', label: 'سحابة الصور: ربط خادم الصور (DiyarPOS)، مفتاحه، ونقل الصور من Cloudinary' },
  { key: 'loyalty:use', label: 'الولاء عند البيع: البحث عن العضو برقمه أو بطاقته، رصيده، واستبدال المكافآت' },
  { key: 'loyalty:manage', label: 'إدارة الولاء: الأعضاء والتعديل اليدوي للنقاط، المكافآت، القواعد، وحالة بطاقات Apple/Google' },
  // عرض فقط — لمراقب البيانات (ويُمنح لغيره): يرى ولا يعدّل
  { key: 'capital:view', label: 'رأس المال: عرض الرصيد والحركات فقط (بلا إيداع ولا سحب)', view: true },
  { key: 'receivables:view', label: 'ذمم الموردين: عرض الفواتير المخزّنة وصورها فقط', view: true },
  { key: 'employees:view', label: 'الموظفون: عرض كشوف حساباتهم وسحوباتهم فقط', view: true },
  { key: 'expenses:view', label: 'المصروفات وسندات الصرف: عرض فقط', view: true },
];

const ALL_KEYS = PERMISSIONS.map((p) => p.key);
const VIEW_KEYS = PERMISSIONS.filter((p) => p.view).map((p) => p.key);
const READ_ONLY_ROLES = ['observer'];

const ROLE_PERMISSIONS = {
  admin: [...ALL_KEYS],
  // رأس المال لمدير النظام وحده افتراضياً (يُمنح لغيره من «المستخدمون» عند الحاجة)
  // رأس المال وصرف الموظفين: لمدير النظام افتراضياً، ويُمنحان لغيره من «المستخدمون»
  // والأوامر الصوتية: لمدير النظام افتراضياً، ويمنحها لمن يريد
  manager: ALL_KEYS.filter((k) => !['users:manage', 'capital:manage', 'capital:view', 'employees:pay', 'voice:commands', 'stats:live', 'images:cloud', 'staff:notify'].includes(k)),
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
    'loyalty:use', // الولاء عند البيع: بحث العضو واستبدال مكافأة (التعديل اليدوي للإدارة)
  ],
  employee: ['orders:view', 'products:view', 'center:sell'],
  // موظف سنتر (من المنزل): يستقبل الاتصالات ويرسل الطلبات للمطعم فقط —
  // لا دفع ولا إلغاء ولا بيع سفري ولا قوائم الطلبات والزبائن (يفرضه الخادم أيضاً)
  center: ['center:sell'],
  delivery: [], // حساب محاسبي للمندوب — بلا دخول ولا صلاحيات
  // مراقب بيانات: يرى المبيعات والإحصائيات والجرد ورأس المال وفواتير الموردين وسحوبات الموظفين — بلا أي تعديل
  observer: ['stats:view', 'orders:view', 'shifts:view', 'capital:view', 'receivables:view', 'employees:view', 'expenses:view'],
};

// هل يستخدم المستخدم صلاحيات مخصّصة أم يرث صلاحيات دوره؟
const usesCustomPermissions = (user) =>
  user.role !== 'admin' && Array.isArray(user.permissions) && user.permissions.length > 0;

// الصلاحيات الفعلية للمستخدم
const effectivePermissionsFor = (user) => {
  if (!user) return [];
  if (user.role === 'admin') return [...ALL_KEYS];
  const list = usesCustomPermissions(user) ? user.permissions.filter((p) => ALL_KEYS.includes(p)) : (ROLE_PERMISSIONS[user.role] || []);
  // مراقب البيانات: «عرض» فقط حتى لو مُنح غيرها بالخطأ
  return READ_ONLY_ROLES.includes(user.role) ? list.filter((p) => VIEW_KEYS.includes(p)) : list;
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
  VIEW_KEYS,
  READ_ONLY_ROLES,
  ROLE_PERMISSIONS,
  effectivePermissionsFor,
  usesCustomPermissions,
  sanitizePermissions,
  withPermissionFields,
};
