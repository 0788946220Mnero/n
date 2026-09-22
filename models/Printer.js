const mongoose = require('mongoose');

/*
  ═══════════════════════════════════════════════════════════════
  الطابعة — مستند مستقل لكل جهاز طباعة في المطعم.

  الحقول هنا مطابقة تماماً للنموذج في لوحة التحكم (submitPrinterForm)
  وتطبيق DiyarPOS، فلا تُغيّر اسم حقل دون تغييره في الطرفين.

  سلسلة التوجيه المعتمدة:
      الصنف → تصنيفه → طابعة التصنيف → الطابعة الرئيسية
  ═══════════════════════════════════════════════════════════════
*/
const printerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true }, // الاسم المنطقي: "مطبخ"، "شاورما"
    type: { type: String, enum: ['THERMAL', 'A4', 'LABEL'], default: 'THERMAL' },
    connectionType: {
      type: String,
      enum: ['WINDOWS', 'USB', 'LAN', 'WIFI'],
      default: 'WINDOWS',
    },

    // للاتصال المحلي: اسم الطابعة في ويندوز كما يراه winspool
    systemName: { type: String, default: '', trim: true },

    // للاتصال الشبكي
    address: { type: String, default: '', trim: true },
    port: { type: Number, default: 9100 },

    paperWidth: { type: Number, enum: [58, 80], default: 80 },
    copies: { type: Number, default: 1, min: 1, max: 5 },
    autoCut: { type: Boolean, default: true },

    isActive: { type: Boolean, default: true },
    isMain: { type: Boolean, default: false, index: true }, // الرئيسية: واحدة فقط
  },
  { timestamps: true }
);

// الوجهة الفعلية للطباعة — يستخدمها تطبيق الطباعة مباشرة
printerSchema.virtual('target').get(function target() {
  return this.connectionType === 'LAN' || this.connectionType === 'WIFI'
    ? `${this.address}:${this.port || 9100}`
    : this.systemName || this.name;
});

printerSchema.set('toJSON', { virtuals: true });
printerSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Printer', printerSchema);
