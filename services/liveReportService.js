/*
  ═══════════════════════════════════════════════════════════════
  التقرير الحي على شاشة القفل — إشعار Web Push يُستبدل مع كل تغيير.

  المحتوى (مختصر كما طلب المدير): المبيعات · المصروفات · من جرده مفتوح.
  الأرقام من shiftSummaryFor نفسها التي يُبنى منها تقرير الجرد.

  متى يُرسل: أي حدث طلب/جرد/مصروف ← touch() ← بعد 15 ثانية هدوء (لا سيل
  إشعارات وقت الذروة) ← يُرسل فقط إن تغيّر النص.
  لمن: كل جهاز مشترك ما دام صاحبه يملك صلاحية stats:live (تُفحص عند كل إرسال).
  الخصوصية: iPhone يُخفي نص الإشعار على شاشة القفل حتى يتعرّف Face ID على
  صاحبه (الإعدادات ← الإشعارات ← عرض المعاينات: «عند فتح القفل»).

  يتطلب متغيرات البيئة: VAPID_PUBLIC_KEY و VAPID_PRIVATE_KEY (و VAPID_SUBJECT اختياري).
  بدونها الميزة معطّلة بهدوء ولا تؤثر على شيء.
  ═══════════════════════════════════════════════════════════════
*/
const LiveReportSub = require('../models/LiveReportSub');

const DEBOUNCE_MS = Number(process.env.LIVE_REPORT_DEBOUNCE_MS || 15000);
// تحديث دوري ما دام هناك جرد مفتوح (الدوام): لا يبقى التقرير قديماً عند فتح القفل
// حتى لو لم يتغيّر شيء. 0 = بلا تحديث دوري.
const REFRESH_MIN = Number(process.env.LIVE_REPORT_REFRESH_MIN != null ? process.env.LIVE_REPORT_REFRESH_MIN : 15);
const TAG = 'diyar-live';

let webpush = null;
let timer = null;
let lastBody = '';
let sending = false;

const enabled = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
const publicKey = () => process.env.VAPID_PUBLIC_KEY || '';

function wp() {
  if (webpush) return webpush;
  webpush = require('web-push');
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@diyaralanbat.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  return webpush;
}

const m3 = (v) => Number(v || 0).toFixed(3);

/** «14:35» بتوقيت عمّان — يظهر في العنوان فيعرف المدير عمر الأرقام عند فتح القفل. */
function clock(at = new Date()) {
  try { return at.toLocaleTimeString('en-GB', { timeZone: 'Asia/Amman', hour: '2-digit', minute: '2-digit', hour12: false }); } catch (_) { return ''; }
}

/** نص التقرير من ملخص الجرد. */
function formatReport(summary, openNames, at) {
  const sales = summary ? summary.successTotal : 0;
  const exp = summary ? summary.expensesTotal : 0;
  const who = (openNames || []).filter(Boolean);
  return {
    title: `📊 ديار الأنباط — ${at ? clock(at) : 'الآن'}`,
    body: `المبيعات ${m3(sales)} د.أ · المصروفات ${m3(exp)} د.أ\n${who.length ? `الجرد مفتوح: ${who.join('، ')}` : 'لا يوجد جرد مفتوح'}`,
  };
}

/** يبني التقرير الآن (يُستدعى بلا req — بصلاحية مدير النظام للقراءة فقط). */
async function buildReport() {
  const { shiftSummaryFor } = require('../controllers/orderController');
  const ShiftSession = require('../models/ShiftSession');
  const [summary, open] = await Promise.all([
    shiftSummaryFor({ role: 'admin', _id: null }, 'all'),
    ShiftSession.find({ status: 'open', scope: 'mine' }).select('userName').sort({ openedAt: 1 }).lean(),
  ]);
  const names = [...new Set(open.map((s) => s.userName).filter(Boolean))];
  const r = formatReport(summary, names, new Date());
  r.openCount = names.length;
  return r;
}

/** المشتركون الذين ما زالوا يملكون الصلاحية (المستخدم معطّل أو سُحبت صلاحيته ← لا يصله شيء). */
async function eligibleSubs(filter = {}) {
  const User = require('../models/User');
  const { effectivePermissionsFor } = require('../utils/permissions');
  const subs = await LiveReportSub.find(filter).lean();
  if (!subs.length) return [];
  const users = await User.find({ _id: { $in: [...new Set(subs.map((s) => String(s.user)))] } }).lean();
  const ok = new Set(users.filter((u) => u.isActive !== false && effectivePermissionsFor(u).includes('stats:live')).map((u) => String(u._id)));
  return subs.filter((s) => ok.has(String(s.user)));
}

async function pushTo(subs, report) {
  const payload = JSON.stringify({ title: report.title, body: report.body, tag: TAG, url: 'dashboard.html#orders', at: Date.now() });
  let okCount = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      // Topic: إن لم يُسلَّم الإشعار السابق بعد، يحلّ هذا مكانه (لا تراكم)
      await wp().sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 6 * 3600, urgency: 'normal', topic: TAG });
      okCount++;
      await LiveReportSub.updateOne({ _id: s._id }, { $set: { lastOkAt: new Date(), lastError: '' } });
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) await LiveReportSub.deleteOne({ _id: s._id }); // الجهاز ألغى الاشتراك
      else await LiveReportSub.updateOne({ _id: s._id }, { $set: { lastError: String((err && err.message) || err).slice(0, 200) } });
    }
  }));
  return okCount;
}

/** يرسل الآن للجميع إن تغيّر النص (force: يرسل حتى لو لم يتغير؛ onlyOpen: فقط أثناء الدوام). */
async function sendNow({ force = false, onlyOpen = false } = {}) {
  if (!enabled() || sending) return 0;
  sending = true;
  try {
    const report = await buildReport();
    if (onlyOpen && !report.openCount) return 0;
    if (!force && report.body === lastBody) return 0;
    const subs = await eligibleSubs();
    if (!subs.length) return 0;
    lastBody = report.body;
    return await pushTo(subs, report);
  } finally {
    sending = false;
  }
}

/** يرسل لمستخدم واحد فوراً (أول تفعيل / «أرسل الآن»). */
async function sendToUser(userId) {
  if (!enabled()) return 0;
  const report = await buildReport();
  const subs = await eligibleSubs({ user: userId });
  return pushTo(subs, report);
}

/** حدث تغيّر شيء: يجمع الأحداث المتلاحقة ويرسل بعد هدوء قصير. */
function touch() {
  if (!enabled() || timer) return;
  timer = setTimeout(() => {
    timer = null;
    sendNow().catch((e) => console.error('liveReport:', e.message));
  }, DEBOUNCE_MS);
  if (timer.unref) timer.unref();
}

/** يبدأ التحديث الدوري (يُستدعى مرة عند تشغيل الخادم). */
let refreshT = null;
function start() {
  if (!enabled() || !(REFRESH_MIN > 0) || refreshT) return;
  refreshT = setInterval(() => {
    sendNow({ force: true, onlyOpen: true }).catch((e) => console.error('liveReport refresh:', e.message));
  }, REFRESH_MIN * 60000);
  if (refreshT.unref) refreshT.unref();
}

module.exports = { enabled, publicKey, webpush: () => wp(), touch, sendNow, sendToUser, buildReport, formatReport, start, clock, _reset: () => { lastBody = ''; if (timer) clearTimeout(timer); timer = null; } };
