/*
  ═══════════════════════════════════════════════════════════════
  ديون الشركة والمؤسسون — النماذج.

  • المؤسس = مستخدم موجود في اللوحة عليه علامة isFounder (لا حساب جديد) + ملف FounderProfile.
  • الدين: للشركة (company) أو شخصي لمؤسس (personal). قيمة كلية + قسط شهري ثابت.
  • الدفعة: بتوقيع المؤسس اليدوي + لقطة وجهه ← «قيد المراجعة» ← ختم مدير النظام.
    دفعة دين الشركة المختومة تُرحَّل لحساب المؤسس البنكي لدى الشركة كـ«رسوم تأسيس».
    الدين الشخصي لا يدخل الحساب البنكي.
  • المسجَّل حق للشركة: لا يُعدَّل إلا لخطأ إدخال، بيد مدير النظام، مع سجل تصحيح (القيمة قبل/بعد/السبب).
  • القوانين والمنشورات والتعليقات والدردشة الداخلية بين المؤسسين.
  ═══════════════════════════════════════════════════════════════
*/
const mongoose = require('mongoose');
const { Schema } = mongoose;
const Id = Schema.Types.ObjectId;

const model = (name, schema) => mongoose.models[name] || mongoose.model(name, schema);

/** سطر في سجل التصحيح — لا يُحذف أبداً. */
const correctionSchema = new Schema({
  at: { type: Date, default: Date.now },
  by: { type: Id, ref: 'User' },
  byName: { type: String, default: '' },
  field: { type: String, default: '' },
  from: { type: Schema.Types.Mixed, default: null },
  to: { type: Schema.Types.Mixed, default: null },
  reason: { type: String, default: '' },
}, { _id: false });

const FounderProfile = model('FounderProfile', new Schema({
  user: { type: Id, ref: 'User', required: true, unique: true },
  displayName: { type: String, default: '', trim: true, maxlength: 80 },
  title: { type: String, default: 'مؤسس', trim: true, maxlength: 80 }, // «مؤسس — المدير التنفيذي»
  bio: { type: String, default: '', trim: true, maxlength: 600 },
  phone: { type: String, default: '', trim: true, maxlength: 20 },
  photo: { type: String, default: '' }, // JPEG صغير (dataURL ≤ 200KB)
  cover: { type: String, default: '' },
  sharePct: { type: Number, default: 0, min: 0, max: 100 },
  active: { type: Boolean, default: true, index: true },
  joinedAt: { type: Date, default: Date.now },
  sessionId: { type: String, default: '', select: false }, // جلسة الواجهة المستقلة (منفصلة عن جلسة اللوحة)
  lastSeenAt: { type: Date, default: null },
}, { timestamps: true }));

const FounderSettings = model('FounderSettings', new Schema({
  key: { type: String, default: 'main', unique: true },
  companyName: { type: String, default: 'شركة البراق' },
  stampImage: { type: String, default: '', select: false }, // ختم الشركة المعتمد (PNG شفاف)
  stampUpdatedAt: { type: Date, default: null },
  stampUpdatedByName: { type: String, default: '' },
  notice: { type: String, default: 'الديون المشتركة لا تُنسب لأحد إلا إذا دُفعت بتوقيع مؤسس وختم الشركة' },
  callRingSeconds: { type: Number, default: 60, min: 15, max: 180 },
}, { timestamps: true }));

const CompanyDebt = model('CompanyDebt', new Schema({
  number: { type: Number, index: true },
  scope: { type: String, enum: ['company', 'personal'], required: true, index: true },
  owner: { type: Id, ref: 'User', default: null, index: true }, // الدين الشخصي: صاحبه
  ownerName: { type: String, default: '' },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  creditor: { type: String, default: '', trim: true, maxlength: 100 }, // الدائن
  notes: { type: String, default: '', trim: true, maxlength: 500 },
  totalAmount: { type: Number, required: true, min: 0.001, max: 100000000 },
  monthlyInstallment: { type: Number, required: true, min: 0.001, max: 100000000 },
  startMonth: { type: String, required: true }, // YYYY-MM أول قسط مستحق
  status: { type: String, enum: ['active', 'closed', 'archived'], default: 'active', index: true },
  createdBy: { type: Id, ref: 'User' },
  createdByName: { type: String, default: '' },
  corrections: { type: [correctionSchema], default: [] },
}, { timestamps: true }));

const DebtPayment = model('DebtPayment', new Schema({
  number: { type: Number, index: true },
  debt: { type: Id, ref: 'CompanyDebt', required: true, index: true },
  debtTitle: { type: String, default: '' },
  scope: { type: String, enum: ['company', 'personal'], required: true },
  payer: { type: Id, ref: 'User', required: true, index: true },
  payerName: { type: String, default: '' },
  amount: { type: Number, required: true, min: 0.001 },
  forMonth: { type: String, default: '' }, // شهر الدفع YYYY-MM
  // القسط الذي تُحسب عليه الدفعة (YYYY-MM) — كاملاً أو جزءاً منه. فارغ = دفعة عامة تُوزَّع على الأقدم
  installmentMonth: { type: String, default: '', index: true },
  installmentAmount: { type: Number, default: 0 }, // قيمة القسط لحظة الدفع (للسند)
  partial: { type: Boolean, default: false }, // جزء من القسط
  signature: { type: String, required: true, select: false }, // توقيع يدوي جديد في كل مرة
  facePhoto: { type: String, required: true, select: false }, // لقطة الوجه لحظة التوقيع
  status: { type: String, enum: ['review', 'stamped', 'rejected'], default: 'review', index: true },
  reviewNote: { type: String, default: '' },
  stampedBy: { type: Id, ref: 'User', default: null },
  stampedByName: { type: String, default: '' },
  stampedAt: { type: Date, default: null },
  rejectedByName: { type: String, default: '' },
  rejectedAt: { type: Date, default: null },
  ledgerEntry: { type: Id, ref: 'FounderLedger', default: null },
  ip: { type: String, default: '' },
  ua: { type: String, default: '' },
  corrections: { type: [correctionSchema], default: [] },
}, { timestamps: true }));

/** حساب المؤسس البنكي لدى الشركة — كل حركة حق للشركة. */
const FounderLedger = model('FounderLedger', new Schema({
  number: { type: Number, index: true },
  founder: { type: Id, ref: 'User', required: true, index: true },
  founderName: { type: String, default: '' },
  // founding_fee: دفعة دين شركة مختومة (رسوم تأسيس) · deposit: ما دفعه للشركة
  // shares: شراء أسهم · spent: ما صرفه على الشركة من ماله
  kind: { type: String, enum: ['founding_fee', 'deposit', 'shares', 'spent'], required: true },
  amount: { type: Number, required: true, min: 0.001 },
  sharesCount: { type: Number, default: 0 },
  note: { type: String, default: '', maxlength: 300 },
  date: { type: Date, default: Date.now },
  payment: { type: Id, ref: 'DebtPayment', default: null },
  createdBy: { type: Id, ref: 'User' },
  createdByName: { type: String, default: '' },
  corrections: { type: [correctionSchema], default: [] },
}, { timestamps: true }));

/** منشور داخلي بين المؤسسين — أو قانون من «قوانين المطعم» (kind: law). */
const FounderPost = model('FounderPost', new Schema({
  kind: { type: String, enum: ['post', 'law'], default: 'post', index: true },
  lawNumber: { type: Number, default: null },
  title: { type: String, default: '', trim: true, maxlength: 160 },
  text: { type: String, default: '', maxlength: 8000 },
  images: { type: [String], default: [] },
  founders: { type: [Id], default: [] }, // القانون: لمؤسسين بعينهم (فارغ = الجميع)
  author: { type: Id, ref: 'User', required: true },
  authorName: { type: String, default: '' },
  likes: { type: [Id], default: [] },
  commentsCount: { type: Number, default: 0 },
  pinned: { type: Boolean, default: false },
  deleted: { type: Boolean, default: false, index: true },
  editedAt: { type: Date, default: null },
  corrections: { type: [correctionSchema], default: [] },
}, { timestamps: true }));

const FounderComment = model('FounderComment', new Schema({
  post: { type: Id, ref: 'FounderPost', required: true, index: true },
  author: { type: Id, ref: 'User', required: true },
  authorName: { type: String, default: '' },
  text: { type: String, required: true, maxlength: 2000 },
  likes: { type: [Id], default: [] },
  deleted: { type: Boolean, default: false },
}, { timestamps: true }));

/** رسالة دردشة: conv = 'group' (كل المؤسسين) أو 'dm:<idA>:<idB>' (مرتّبان). */
const FounderMessage = model('FounderMessage', new Schema({
  conv: { type: String, required: true, index: true },
  from: { type: Id, ref: 'User', required: true },
  fromName: { type: String, default: '' },
  text: { type: String, default: '', maxlength: 4000 },
  image: { type: String, default: '' },
  audio: { type: String, default: '' },
  audioSec: { type: Number, default: 0 },
  readBy: { type: [Id], default: [] },
  deleted: { type: Boolean, default: false },
}, { timestamps: true }));

/** جهاز إشعارات مؤسس: Web Push (آيفون/متصفح مثبّت) أو FCM (تطبيق أندرويد APK). */
const FounderDevice = model('FounderDevice', new Schema({
  user: { type: Id, ref: 'User', required: true, index: true },
  kind: { type: String, enum: ['webpush', 'fcm'], required: true },
  endpoint: { type: String, default: '' }, // webpush
  keys: { p256dh: { type: String, default: '' }, auth: { type: String, default: '' } },
  token: { type: String, default: '' }, // fcm
  key: { type: String, required: true, unique: true }, // endpoint أو token
  platform: { type: String, default: 'other' },
  ua: { type: String, default: '' },
  lastOkAt: { type: Date, default: null },
  lastError: { type: String, default: '' },
}, { timestamps: true }));

const FounderCounter = model('FounderCounter', new Schema({ _id: String, seq: { type: Number, default: 0 } }));

async function nextNumber(name) {
  const c = await FounderCounter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return c.seq;
}

module.exports = {
  FounderProfile, FounderSettings, CompanyDebt, DebtPayment, FounderLedger,
  FounderPost, FounderComment, FounderMessage, FounderDevice, FounderCounter, nextNumber,
};
