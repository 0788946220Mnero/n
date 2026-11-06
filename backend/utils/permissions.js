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
  { key: 'orders:view', label: 'عرض المبيعات: سجل الطلبات ومبيعات السفري', view: true },
  { key: 'orders:manage', label: 'تأكيد الطلبات وتغيير حالتها' },
  { key: 'orders:closeShift', label: 'إغلاق الجرد — لمدير النظام افتراضياً، ومن يُمنحها يُغلق جرده هو' },
  { key: 'products:view', label: 'عرض الأصناف', view: true },
  { key: 'products:edit', label: 'إضافة وتعديل وحذف الأصناف' },
  { key: 'categories:edit', label: 'إدارة التصنيفات' },
  { key: 'customers:view', label: 'عرض الزبائن', view: true },
  { key: 'customers:manage', label: 'توثيق وتعديل بيانات الزبائن' },
  { key: 'printers:manage', label: 'إدارة الطابعات والطباعة' },
  { key: 'settings:manage', label: 'إعدادات المطعم والعروض' },
  { key: 'offers:manage', label: 'العروض الترويجية: إنشاؤها بصورة أو فيديو وخصم ثابت، ونسخ روابطها للنشر على فيسبوك وواتساب' },
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
  { key: 'obligations:manage', label: 'الالتزامات الثابتة: إنشاؤها وتعديلها بتوقيع مدير النظام (إيجار، اشتراكات، أقساط)' },
  { key: 'obligations:pay', label: 'الالتزامات الثابتة: دفع القسط اليومي بسند صرف عليه ختم «مدفوع»' },
  { key: 'chat:use', label: 'دردشة الطاقم: المحادثات والمجموعات والرسائل الصوتية والصور', personal: true },
  { key: 'chat:calls', label: 'دردشة الطاقم: المكالمات الصوتية والمرئية', personal: true },
  { key: 'chat:monitor', label: 'إدارة الدردشة (مدير النظام): مراجعة كل المحادثات، الحذف، والإعدادات' },
  { key: 'support:reply', label: 'رسائل الزبائن: الرد على «تواصل مع فريق العمل» من منصة الزبائن' },
  { key: 'community:moderate', label: 'الدردشة العامة للزبائن: الإشراف — الفلترة وحذف الرسائل وحظر الزبائن والنشر باسم فريق العمل' },
  { key: 'loyalty:manage', label: 'إدارة الولاء: الأعضاء والتعديل اليدوي للنقاط، المكافآت، القواعد، وحالة بطاقات Apple/Google' },
  // ═══ شركة البراق للتوصيل (قسم مستقل عن المطعم — يُخفى ويُظهر بهذه الصلاحيات) ═══
  { key: 'brq:manage', label: 'شركة البراق: الخريطة الحية، السائقون، المتاجر، المناطق، والطلبات' },
  { key: 'brq:ledger', label: 'شركة البراق: جرد السائقين والمتاجر، التحصيل وسندات القبض' },
  { key: 'brq:settings', label: 'شركة البراق: تسعير التوصيل وإعدادات التوزيع وربط متجر المطعم' },
  { key: 'brq:prints', label: 'شركة البراق: طباعة كشوف الأسعار، الوصولات، وتصاريح السائقين' },
  { key: 'brq:center', label: 'شركة البراق: الكول سنتر (طلبات التوصيل باسم المتاجر)' },
  { key: 'brq:chat', label: 'شركة البراق: الدردشة مع السائقين والمتاجر' },
  { key: 'brq:monitor', label: 'شركة البراق: الإشراف على كل المحادثات الخاصة بين السائقين والمتاجر' },
  { key: 'brq:request', label: 'طلب سائق البراق من «حالة الطلبات» في المطعم' },
  // ═══ الصالة (طلبات الطاولات من التابلت والجوال) ═══
  { key: 'hall:use', label: 'الصالة: فتح الطاولات، إرسال الطلبات للمطبخ، وطلب الحساب' },
  { key: 'hall:manage', label: 'الصالة: إعداد الطاولات، إلغاء صنف، نقل طاولة، وقبض الحساب وإغلاقه' },
  // ═══ الدوام (حضور وانصراف الموظفين) ═══
  { key: 'attendance:breaks', label: 'الدوام — مسؤول القسم: من على رأس عمله الآن، وتسجيل الاستراحات (البريك) لموظفي قسمه' },
  { key: 'attendance:manage', label: 'الدوام — المدير: أجهزة الحضور ورموز PIN، مراجعة الاستثناءات والصور، تعديل الدوام وإغلاقه، والإعدادات' },
  { key: 'attendance:view', label: 'الدوام: عرض تقارير الساعات والأيام والاستراحات فقط', view: true },
  // ═══ إدارة المطعم والربحية (التكاليف، الوصفات، المخزون، قائمة الدخل) ═══
  { key: 'profit:view', label: 'الربحية: لوحة الربح والخسارة، تقارير الأصناف والقنوات، نقطة التعادل والمحاكاة', view: true },
  { key: 'profit:manage', label: 'الربحية: الوصفات وتكلفة المواد، البنود الموزّعة (إيجار، كهرباء، إهلاك)، أجور الساعة، اعتماد الجرد والإعدادات' },
  { key: 'inventory:operate', label: 'المخزون: استلام البضاعة، الهدر والتالف، وجبات الموظفين، دفعات التحضير، وإدخال الجرد' },
  // عرض فقط — لمراقب البيانات (ويُمنح لغيره): يرى ولا يعدّل
  { key: 'capital:view', label: 'رأس المال: عرض الرصيد والحركات فقط (بلا إيداع ولا سحب)', view: true },
  { key: 'receivables:view', label: 'ذمم الموردين: عرض الفواتير المخزّنة وصورها فقط', view: true },
  { key: 'employees:view', label: 'الموظفون: عرض كشوف حساباتهم وسحوباتهم فقط', view: true },
  { key: 'expenses:view', label: 'المصروفات وسندات الصرف: عرض فقط', view: true },
  { key: 'obligations:view', label: 'الالتزامات الثابتة: عرض الأقساط والدورات فقط', view: true },
];

const ALL_KEYS = PERMISSIONS.map((p) => p.key);
const VIEW_KEYS = PERMISSIONS.filter((p) => p.view).map((p) => p.key);
const READ_ONLY_ROLES = ['observer'];
// مفاتيح شخصية لا تعدّل بيانات المطعم: مسموحة لمراقب البيانات أيضاً (دردشته ومكالماته)
const PERSONAL_KEYS = PERMISSIONS.filter((p) => p.personal).map((p) => p.key);
// المبيعات وإغلاق الجرد: لمدير النظام وحده افتراضياً (ومراقب البيانات بدوره)، ويمنحها لغيره صراحةً
const SALES_KEYS = ['orders:closeShift', 'orders:view', 'stats:view', 'shifts:view'];
// أقسام شركة البراق: لمدير النظام ودور «موظف شركة البراق» افتراضياً — ويمنحها مدير النظام لمن يريد
const BRQ_KEYS = ALL_KEYS.filter((k) => k.startsWith('brq:'));

const ROLE_PERMISSIONS = {
  admin: [...ALL_KEYS],
  // رأس المال لمدير النظام وحده افتراضياً (يُمنح لغيره من «المستخدمون» عند الحاجة)
  // رأس المال وصرف الموظفين: لمدير النظام افتراضياً، ويُمنحان لغيره من «المستخدمون»
  // والأوامر الصوتية: لمدير النظام افتراضياً، ويمنحها لمن يريد
  // المبيعات وإغلاق الجرد: لمدير النظام وحده افتراضياً، ويمنحها لمن يريد
  manager: ALL_KEYS.filter((k) => !['users:manage', 'capital:manage', 'capital:view', 'employees:pay', 'voice:commands', 'stats:live', 'images:cloud', 'staff:notify', 'obligations:manage', 'chat:monitor', 'profit:view', 'profit:manage', ...SALES_KEYS, ...BRQ_KEYS.filter((b) => b !== 'brq:request')].includes(k)),
  cashier: [
    'orders:manage', // يعمل على «حالة الطلبات» ويبيع — بلا سجل مبيعات ولا إغلاق جرد
    'brq:request', // يطلب سائق البراق لطلب توصيل من «حالة الطلبات»
    'products:view',
    'customers:view',
    'customers:manage',
    'printers:manage',
    'delivery:manage', // الكاشير يعيّن المندوب ويرسل الطلب — كما كان يفعل من قائمة الطلبات
    'receivables:manage', // ذمم الموردين: تسجيل وتسديد وطباعة (الإزالة لمدير النظام وحده)
    'supplies:manage', // قائمة البضائع المطلوبة
    'center:sell', // بيع سنتر من داخل المطعم (يُؤكَّد ويُطبع فوراً)
    'loyalty:use', // الولاء عند البيع: بحث العضو واستبدال مكافأة (التعديل اليدوي للإدارة)
    'obligations:pay', // الالتزامات الثابتة: دفع قسط اليوم من صندوقه
    'chat:use', 'chat:calls', // دردشة الطاقم
    'support:reply', // رسائل الزبائن من «تواصل مع فريق العمل»
    'community:moderate', // الإشراف على الدردشة العامة للزبائن
    'hall:use', 'hall:manage', // الصالة: الطلبات والقبض وإغلاق الطاولة
  ],
  employee: ['products:view', 'center:sell', 'chat:use', 'chat:calls'],
  // موظف سنتر (من المنزل): يستقبل الاتصالات ويرسل الطلبات للمطعم فقط —
  // لا دفع ولا إلغاء ولا بيع سفري ولا قوائم الطلبات والزبائن (يفرضه الخادم أيضاً)
  center: ['center:sell', 'chat:use', 'chat:calls'],
  // نادل الصالة (تابلت/جوال): الطاولات وإرسال الطلبات للمطبخ وطلب الحساب فقط — لا قبض ولا جرد ولا أي قسم آخر
  waiter: ['hall:use', 'chat:use'],
  delivery: [], // حساب محاسبي للمندوب — بلا دخول ولا صلاحيات
  // موظف شركة البراق: أقسام التوصيل وحدها (الخريطة، الجرد، الطباعة، الكول سنتر، الدردشة) — بلا أي قسم من المطعم
  company: ['brq:manage', 'brq:ledger', 'brq:prints', 'brq:center', 'brq:chat'],
  // مراقب بيانات: يرى المبيعات والإحصائيات والجرد ورأس المال وفواتير الموردين وسحوبات الموظفين — بلا أي تعديل
  observer: ['stats:view', 'orders:view', 'shifts:view', 'capital:view', 'receivables:view', 'employees:view', 'attendance:view', 'expenses:view', 'obligations:view', 'profit:view', 'chat:use', 'chat:calls'],
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
  return READ_ONLY_ROLES.includes(user.role) ? list.filter((p) => VIEW_KEYS.includes(p) || PERSONAL_KEYS.includes(p)) : list;
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
  PERSONAL_KEYS,
  SALES_KEYS,
  BRQ_KEYS,
  ROLE_PERMISSIONS,
  effectivePermissionsFor,
  usesCustomPermissions,
  sanitizePermissions,
  withPermissionFields,
};
