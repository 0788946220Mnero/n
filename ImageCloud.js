const mongoose = require('mongoose');

/**
 * سحابة الصور الخاصة (ImageStorage يعمل داخل DiyarPOS على جهاز المطعم).
 * وثيقة واحدة فقط. المفتاح لا يُعاد للواجهات أبداً (select: false).
 */
const imageCloudSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'main', unique: true },
    enabled: { type: Boolean, default: false },
    baseUrl: { type: String, default: '', trim: true },   // الرابط العام (نفق Cloudflare مثلاً)
    projectId: { type: String, default: '', trim: true },
    apiKey: { type: String, default: '', select: false },
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
    }],
    migration: {
      status: { type: String, enum: ['idle', 'running', 'done', 'failed', 'interrupted'], default: 'idle' },
      total: { type: Number, default: 0 },
      done: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      updatedDocs: { type: Number, default: 0 },
      startedAt: { type: Date, default: null },
      finishedAt: { type: Date, default: null },
      byName: { type: String, default: '' },
      errors: [{ url: String, message: String, _id: false }],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ImageCloud', imageCloudSchema);
