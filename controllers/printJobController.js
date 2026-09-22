const { wrapAll } = require('../utils/asyncHandler');
const PrintJob = require('../models/PrintJob');
const Order = require('../models/Order');
const Expense = require('../models/Expense');
const realtime = require('../services/realtimeService');

const JOB_TTL_MS = 5 * 60 * 1000; // مهلة الحجز
const TYPES = ['confirm', 'invoice', 'shift', 'drawer', 'expense', 'pos'];

const nameOf = (u) => (u && (u.name || u.username)) || '';

/** المهام التي فات أوان حجزها تُعلَّم منتهية — تُستدعى قبل كل قراءة. */
const expireStale = async () => {
  const stale = await PrintJob.find({ status: 'pending', expiresAt: { $lte: new Date() } });
  for (const job of stale) {
    job.status = 'expired';
    job.finishedAt = new Date();
    job.error = 'لم يستلمها أي جهاز كاشير خلال 5 دقائق';
    await job.save();
    try { realtime.emitPrintJobUpdated(job); } catch (_) {}
  }
};

// POST /api/print-jobs  { type, orderId?, payload?, openDrawer? }
const createJob = async (req, res) => {
  const { type, orderId, expenseId, payload, openDrawer } = req.body || {};

  if (!TYPES.includes(type)) {
    return res.status(400).json({ message: 'نوع مهمة الطباعة غير صحيح' });
  }

  let order = null;
  // pos: بيع سفري من نقطة البيع في اللوحة — قصاصات وفاتورة وأقسام معاً
  if (type === 'confirm' || type === 'invoice' || type === 'pos') {
    if (!orderId) return res.status(400).json({ message: 'الطلب مطلوب لهذه الطباعة' });
    order = await Order.findById(orderId).select('_id');
    if (!order) return res.status(404).json({ message: 'الطلب غير موجود' });
  }

  if (type === 'shift' && (!payload || typeof payload !== 'object')) {
    return res.status(400).json({ message: 'بيانات الجرد مطلوبة للطباعة' });
  }

  // السند يُقرأ من القاعدة لا من المرسِل: لا يمكن طباعة سند صرف مزوَّر
  let expense = null;
  if (type === 'expense') {
    if (!expenseId) return res.status(400).json({ message: 'المصروف مطلوب للطباعة' });
    expense = await Expense.findById(expenseId).lean();
    if (!expense) return res.status(404).json({ message: 'المصروف غير موجود' });
    if (expense.voided) return res.status(400).json({ message: 'المصروف ملغى' });
  }

  const job = await PrintJob.create({
    type,
    order: order ? order._id : null,
    payload: type === 'shift' ? payload : (expense || null),
    // الدرج: أمر مستقل يعني فتحه دائماً؛ ومع الطباعة حسب طلب المرسِل
    openDrawer: type === 'drawer' ? true : !!openDrawer,
    requestedBy: req.user._id,
    requestedByName: nameOf(req.user),
    expiresAt: new Date(Date.now() + JOB_TTL_MS),
  });

  try { realtime.emitPrintJob(job); } catch (_) {}
  res.status(201).json({ success: true, job });
};

// GET /api/print-jobs/pending — لجهاز الكاشير عند اتصاله: ما فاته أثناء انقطاعه
const pendingJobs = async (req, res) => {
  await expireStale();
  const jobs = await PrintJob.find({ status: 'pending', expiresAt: { $gt: new Date() } })
    .sort({ createdAt: 1 })
    .limit(50)
    .lean();
  res.json({ success: true, jobs });
};

// POST /api/print-jobs/:id/claim  { station? }
// حجز ذرّي: أول جهاز يحجز يطبع، والباقي يتلقون 409
const claimJob = async (req, res) => {
  const job = await PrintJob.findOneAndUpdate(
    { _id: req.params.id, status: 'pending', expiresAt: { $gt: new Date() } },
    {
      $set: {
        status: 'claimed',
        claimedAt: new Date(),
        claimedBy: String((req.body && req.body.station) || nameOf(req.user)).slice(0, 60),
      },
    },
    { new: true }
  ).populate('order');

  if (!job) {
    return res.status(409).json({ message: 'المهمة محجوزة لجهاز آخر أو انتهت صلاحيتها' });
  }

  try { realtime.emitPrintJobUpdated(job); } catch (_) {}
  res.json({ success: true, job });
};

// PATCH /api/print-jobs/:id  { status: 'done'|'failed', error? }
const finishJob = async (req, res) => {
  const { status, error } = req.body || {};
  if (!['done', 'failed'].includes(status)) {
    return res.status(400).json({ message: 'الحالة يجب أن تكون done أو failed' });
  }

  const job = await PrintJob.findOneAndUpdate(
    { _id: req.params.id, status: 'claimed' },
    {
      $set: {
        status,
        finishedAt: new Date(),
        error: status === 'failed' ? String(error || 'فشل غير محدد').slice(0, 300) : '',
      },
    },
    { new: true }
  );

  if (!job) return res.status(404).json({ message: 'المهمة غير محجوزة أو غير موجودة' });

  try { realtime.emitPrintJobUpdated(job); } catch (_) {}
  res.json({ success: true, job });
};

// GET /api/print-jobs/:id — ليتابع المرسِل حالة مهمته إن فاته حدث البث
const getJob = async (req, res) => {
  const job = await PrintJob.findById(req.params.id).lean();
  if (!job) return res.status(404).json({ message: 'المهمة غير موجودة' });
  res.json({ success: true, job });
};

module.exports = wrapAll({ createJob, pendingJobs, claimJob, finishJob, getJob });
