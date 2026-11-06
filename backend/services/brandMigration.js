/*
  ═══════════════════════════════════════════════════════════════
  الاسم الجديد «البراق» في كل ما يُطبع — مرة واحدة عند بدء الخادم (brand-buraq-v1).

  ما يطبع على الفواتير وقسائم الأقسام ورأس المال والذمم يأتي من «الإعدادات» المحفوظة:
  اسم المطعم وشعاره. إن كانا ما زالا «ديار الأنباط»:
    • الاسم ← «البراق» (وكذلك أي نص محفوظ فيه الاسم القديم: العنوان، تذييل الفاتورة…)
    • الشعار المرفوع ← يُزال، فتطبع الفواتير شعار البراق المدمج وتعرض المنصة شعارها الجديد
      (ويرفع المدير شعاراً جديداً متى أراد من «الإعدادات»)
  العلامة تمنع التكرار: ما يغيّره المدير بعدها يبقى كما هو.
  ═══════════════════════════════════════════════════════════════
*/
const SystemMigration = require('../models/SystemMigration');

const KEY = 'brand-buraq-v1';
const OLD = /(?:مطاعم\s+)?ديار\s*ال[أاإ]نباط|Diyar\s*Al[-\s]?Anbat/gi;
const NEW_AR = 'البراق';

const fix = (v) => (typeof v === 'string' ? v.replace(OLD, (m) => (/[a-z]/i.test(m) ? 'Al-Buraq' : NEW_AR)) : v);
const hasOld = (v) => typeof v === 'string' && new RegExp(OLD.source, 'i').test(v);

/** يستبدل الاسم القديم في كل نص داخل كائن (عمق محدود). */
function deepFix(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return { value: obj, changed: false };
  let changed = false;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') { const n = fix(v); if (n !== v) changed = true; out[k] = n; }
    else if (v && typeof v === 'object' && !(v instanceof Date) && !(v && v._bsontype)) {
      const r = deepFix(v, depth + 1); if (r.changed) changed = true; out[k] = r.value;
    } else out[k] = v;
  }
  return { value: out, changed };
}

async function migrateBrand() {
  if (await SystemMigration.findOne({ key: KEY }).lean()) return 0;
  const Setting = require('../models/Setting');
  const docs = await Setting.find().lean();
  let changed = 0;
  for (const s of docs) {
    const set = {};
    const wasOld = hasOld(s.restaurantName) || !s.restaurantName;
    for (const field of ['restaurantName', 'aboutTitle', 'aboutText', 'address', 'workHoursNote', 'location']) {
      if (hasOld(s[field])) set[field] = fix(s[field]);
    }
    if (!s.restaurantName) set.restaurantName = NEW_AR;
    for (const field of ['invoiceSettings', 'kitchenTicketSettings']) {
      if (s[field] && typeof s[field] === 'object') {
        const r = deepFix(s[field]);
        if (r.changed) set[field] = r.value;
      }
    }
    // الشعار المرفوع أيام «ديار الأنباط» عليه الاسم القديم: يُزال (تبقى صورته في التخزين)
    if (wasOld && s.logo) set.logo = '';
    if (Object.keys(set).length) { await Setting.updateOne({ _id: s._id }, { $set: set }); changed++; }
  }
  try { await SystemMigration.create({ key: KEY, changed }); }
  catch (e) { if (!(e && e.code === 11000)) throw e; }
  if (changed) console.log('الاسم: «ديار الأنباط» ← «البراق» في الإعدادات والمطبوعات (مرة واحدة)');
  return changed;
}

function start() {
  migrateBrand().catch((e) => console.error('brand migration:', e.message));
}

module.exports = { migrateBrand, start, KEY };
