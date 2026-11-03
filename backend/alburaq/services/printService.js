/**
 * طباعة البراق عبر نظام الطباعة عن بُعد في ديار نفسه:
 *   مهمة PrintJob من نوع «html» ← جهاز الكاشير الذي يشغّل DiyarPOS يحجزها ويطبعها حرارياً
 *   (نفس مسار فواتير المطعم: الصورة ← ESC/POS). وداخل DiyarPOS نفسه تُطبع محلياً مباشرة من اللوحة.
 * كل ورقة تُبنى هنا (مصدر واحد للتصميم)، والواجهة إما تطبعها محلياً أو تطلب طباعتها عن بُعد.
 */
const PrintJob = require('../../models/PrintJob');
const JOB_TTL_MS = 5 * 60 * 1000;
let diyarRealtime = null;

/** يُستدعى من الوحدة عند التركيب: خدمة البث في ديار (emitPrintJob). */
function setRealtime(rt) { diyarRealtime = rt; }

/** مهمة طباعة عن بُعد لجهاز الكاشير. */
async function queue({ title, html, user }) {
  const job = await PrintJob.create({
    type: 'html',
    payload: { title: String(title || 'البراق').slice(0, 80), html },
    requestedBy: user && user._id ? user._id : null,
    requestedByName: (user && (user.name || user.username)) || 'شركة البراق',
    expiresAt: new Date(Date.now() + JOB_TTL_MS),
  });
  try { if (diyarRealtime && diyarRealtime.emitPrintJob) diyarRealtime.emitPrintJob(job); } catch (_) {}
  return job;
}

/**
 * يرد بالورقة؛ وإن طلبت الواجهة (remote: true) تُرسل أيضاً لجهاز الكاشير.
 *   res.json({ html, title, printJob })
 */
async function respond(req, res, { title, html }) {
  let job = null;
  if (req.body && req.body.remote) job = await queue({ title, html, user: req.user });
  res.json({ success: true, title, html, printJob: job ? String(job._id) : null });
}

module.exports = { setRealtime, queue, respond };
