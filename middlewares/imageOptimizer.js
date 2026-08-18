/*
  ═══════════════════════════════════════════════════════════════
  بعد التحويل إلى Cloudinary، لم يعد ضغط/تصغير الصور يتم محلياً بمكتبة sharp.
  Cloudinary يقوم بذلك تلقائياً وقت الرفع (transformation في middlewares/upload.js):
    • أقصى أبعاد 1600px
    • ضغط جودة تلقائي (quality: auto:good)
    • اختيار الصيغة الأنسب تلقائياً (fetch_format: auto)

  أبقينا هذا الـ middleware كـ "ممرّر" (passthrough) بنفس اسم التصدير optimizeImages
  حتى تستمر جميع الـ routes التي تستدعيه بالعمل دون أي تعديل.
  لم يعد يعتمد على sharp ولا على القرص إطلاقاً.
  ═══════════════════════════════════════════════════════════════
*/

const optimizeImages = (req, res, next) => next();

module.exports = { optimizeImages };
