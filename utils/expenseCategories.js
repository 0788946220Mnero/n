/**
 * تصنيفات المصروف ووسائل الدفع والحسابات — مصدر واحد للخادم (والواجهة تأخذها من GET /api/expenses/meta).
 */
const CATEGORIES = [
  { key: 'purchases', label: 'مشتريات وبضاعة' },
  { key: 'delivery', label: 'أجور توصيل ونقل' },
  { key: 'maintenance', label: 'صيانة وإصلاح' },
  { key: 'utilities', label: 'فواتير وخدمات' },
  { key: 'salaries', label: 'رواتب وأجور' },
  { key: 'rent', label: 'إيجار' },
  { key: 'marketing', label: 'تسويق وإعلان' },
  { key: 'obligation', label: 'التزام ثابت' },
  { key: 'other', label: 'أخرى' },
];
const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);
// يختارها الموظف بنفسه (الالتزام الثابت يأتي من قسمه، والرواتب من صرف الموظف)
const PICKABLE = CATEGORY_KEYS.filter((k) => k !== 'obligation');
const categoryLabel = (k) => (CATEGORIES.find((c) => c.key === k) || { label: k ? k : 'بلا تصنيف' }).label;

const METHODS = { cash: 'نقداً', cliq: 'كليك' };
const SOURCES = { drawer: 'الصندوق', capital: 'رأس المال' };
const ACCOUNTS = {
  drawer_cash: 'نقدية الصندوق',
  drawer_cliq: 'كليك الصندوق',
  capital_cash: 'رأس المال — نقداً',
  capital_cliq: 'رأس المال — كليك',
};

/** وسيلة الدفع الفعلية: السند القديم بلا وسيلة كان يُحسب نقداً دائماً. */
const methodOf = (e) => (e && e.paymentMethod === 'cliq' ? 'cliq' : 'cash');
const sourceOf = (e) => (e && e.source === 'capital' ? 'capital' : 'drawer');
/** الحساب الذي خرج منه المال: من المصدر والوسيلة معاً — لا من أحدهما وحده. */
const accountOf = (e) => (e && e.account) || `${sourceOf(e)}_${methodOf(e)}`;

module.exports = { CATEGORIES, CATEGORY_KEYS, PICKABLE, categoryLabel, METHODS, SOURCES, ACCOUNTS, methodOf, sourceOf, accountOf };
