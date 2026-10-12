const mongoose = require('mongoose');

/**
 * سحابة الصور الخاصة (ImageStorage يعمل داخل DiyarPOS على جهاز المطعم).
 * وثيقة واحدة فقط. المفتاح لا يُعاد للواجهات أبداً (select: false).
 */
const imageCloudSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'main', unique: true },
    enabled: { type: Boolean, default: false },
    // المدير يريدها مفعّلة لكن الجهاز لم يرد بعد (رمز النفق في طريقه إليه) ← تُفعَّل تلقائياً عند أول رد
    wantEnabled: { type: Boolean, default: false },
    lastAutoTry: { type: Date, default: null },
    baseUrl: { type: String, default: '', trim: true },   // الرابط العام (نفق Cloudflare مثلاً)
    projectId: { type: String, default: '', trim: true },
    apiKey: { type: String, default: '', select: false },
    keyNodeId: { type: String, default: '' },             // الجهاز الذي أنشأ المفتاح — النفق يوجّه إليه أولاً
    keyRejectedAt: { type: Date, default: null },         // رفض جهاز الصور المفتاح (401/403) ← يُطلب مفتاح من جهاز متصل
    // الرجوع لـ Cloudinary إن لم يرد جهاز الصور — معطّل افتراضياً: الصورة إما على السحابة المحلية أو خطأ واضح
    cloudinaryFallback: { type: Boolean, default: false },
    nodeName: { type: String, default: '' },              // اسم الجهاز كما يعرّف نفسه
    linkedFrom: { type: String, default: '' },            // «DiyarPOS — اسم الجهاز» أو «لوحة التحكم»
    updatedByName: { type: String, default: '' },
    lastOkAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
    lastErrorAt: { type: Date, default: null },
    uploads: { type: Number, default: 0 },                // صور رُفعت للسحابة الخاصة
    fallbacks: { type: Number, default: 0 },              // صور رجعت لـ Cloudinary لأن الجهاز لم يرد
    // ═══ المزامنة بين أجهزة DiyarPOS ═══
    // أسرار المجموعة تُعطى لكل جهاز ينضم بجلسة مدير النظام، ولا تُعاد لأي واجهة أخرى
    syncSecret: { type: String, default: '', select: false },
    signingSecret: { type: String, default: '', select: false },
    tunnelToken: { type: String, default: '', select: false },
    nodes: [{
      _id: false,
      nodeId: { type: String, required: true },
      name: { type: String, default: '' },
      machine: { type: String, default: '' },
      lanUrl: { type: String, default: '' },        // http://192.168.1.20:7443 — للمزامنة داخل الشبكة
      joinedAt: { type: Date, default: Date.now },
      joinedBy: { type: String, default: '' },
      lastSeen: { type: Date, default: null },
      running: { type: Boolean, default: false },
      images: { type: Number, default: 0 },
      missingFiles: { type: Number, default: 0 },   // صور لا يملك هذا الجهاز ملفها بعد
      missingSince: { type: Date, default: null },
      peers: [{ _id: false, nodeId: String, connected: Boolean, pendingEvents: Number, lastError: String }],
      issue: { type: String, default: '' },         // آخر مشكلة أُبلغ عنها (لإشعار مرة واحدة)
      proofHash: { type: String, default: '' },     // بصمة سر الجهاز — يثبت هويته في النبض
    }],
    // ═══ طلبات الربط: DiyarPOS يطلب بأي حساب، ومدير النظام يوافق من اللوحة ═══
    requests: [{
      _id: false,
      nodeId: { type: String, required: true },
      name: { type: String, default: '' },
      machine: { type: String, default: '' },
      lanUrl: { type: String, default: '' },
      publicUrl: { type: String, default: '' },
      proofHash: { type: String, default: '' },     // sha256 لسر يبقى على الجهاز — لا يستلم الأسرار غيره
      requestedBy: { type: String, default: '' },
      requestedAt: { type: Date, default: Date.now },
      lastSeen: { type: Date, default: null },
      status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
      approvedBy: { type: String, default: '' },
      approvedAt: { type: Date, default: null },
    }],
    migration: {
      // done = كل الصور نُقلت وتُعرض من السحابة؛ partial = بعضها بقي على Cloudinary (السبب في errors)
      status: { type: String, enum: ['idle', 'running', 'done', 'partial', 'failed', 'interrupted'], default: 'idle' },
      total: { type: Number, default: 0 },
      done: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      updatedDocs: { type: Number, default: 0 },
      verified: { type: Number, default: 0 },       // صور تأكدنا أنها تُعرض من رابطها الجديد قبل استبداله
      remaining: { type: Number, default: 0 },      // روابط Cloudinary الباقية بعد النقل (مسح فعلي للقاعدة)
      startedAt: { type: Date, default: null },
      finishedAt: { type: Date, default: null },
      byName: { type: String, default: '' },
      errors: [{ url: String, message: String, _id: false }],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ImageCloud', imageCloudSchema);
