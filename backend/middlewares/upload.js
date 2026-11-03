const multer = require('multer');
const path = require('path');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');
const imageCloud = require('../services/imageCloudService');

/*
  ═══════════════════════════════════════════════════════════════
  ⛔ Cloudinary موقوف: كل الصور تُرفع لسحابة الصور (ImageStorage على DiyarPOS) أو تُرفض بسبب واضح.
     لا يُرفع شيء جديد إلى Cloudinary إلا إن ضُبط CLOUDINARY_UPLOADS=on (طوارئ). الوصف أدناه لذلك الوضع فقط.

  رفع الملفات إلى Cloudinary مباشرةً (بدل حفظها على قرص السيرفر المؤقت).

  بعد الرفع، تُصبح خصائص req.file كالتالي (من multer-storage-cloudinary):
    • req.file.path     → رابط Cloudinary الكامل (secure_url) — هذا ما يُحفَظ في قاعدة البيانات
    • req.file.filename → public_id الخاص بالملف في Cloudinary
    • req.file.mimetype → نوع الملف (image/jpeg, video/mp4 ...) — يبقى متاحاً من multer

  التحسين (ضغط/تصغير الصور) يتم الآن على Cloudinary تلقائياً وقت الرفع
  عبر transformation، فلم نعد نحتاج مكتبة sharp أو مجلد uploads إطلاقاً.
  ═══════════════════════════════════════════════════════════════
*/

// المجلد داخل Cloudinary (يمكن تخصيصه عبر متغيّر بيئة اختياري)
const FOLDER = process.env.CLOUDINARY_FOLDER || 'diyar-alanbat';

// تحسين الصور تلقائياً: أقصى أبعاد 1600px مع ضغط جودة تلقائي (يوازي ما كانت تفعله sharp)
// ملاحظة: لا نضع fetch_format هنا لأنه غير مسموح في transformations وقت الرفع.
const IMAGE_TRANSFORMATION = [
  { width: 1600, height: 1600, crop: 'limit', quality: 'auto:good' },
];

// اسم فريد لكل ملف داخل Cloudinary (بدون امتداد — Cloudinary يتكفّل بالصيغة)
const uniquePublicId = () => `${Date.now()}-${Math.round(Math.random() * 1e9)}`;

// هل الملف فيديو؟ (نعتمد على mimetype أولاً ثم الامتداد احتياطاً)
const isVideoFile = (file) =>
  /^video\//i.test(file.mimetype || '') ||
  /\.(mp4|webm|mov)$/i.test(file.originalname || '');

/* ---------- تخزين الصور فقط ---------- */
const imageStorage = new CloudinaryStorage({
  cloudinary,
  params: () => ({
    folder: FOLDER,
    resource_type: 'image',
    public_id: uniquePublicId(),
    transformation: IMAGE_TRANSFORMATION,
  }),
});

/* ---------- تخزين وسائط (صورة أو فيديو) ---------- */
const mediaStorage = new CloudinaryStorage({
  cloudinary,
  params: (req, file) => {
    const video = isVideoFile(file);
    const opts = {
      folder: FOLDER,
      resource_type: video ? 'video' : 'image',
      public_id: uniquePublicId(),
    };
    if (!video) opts.transformation = IMAGE_TRANSFORMATION; // نضغط الصور فقط، لا الفيديو
    return opts;
  },
});

/* ---------- سحابة الصور الخاصة أولاً، و Cloudinary احتياطاً ----------
   إن فعّل مدير النظام «سحابة الصور» (ImageStorage داخل DiyarPOS): الصورة تُجمع في الذاكرة
   (≤ 25MB) وتُرفع لجهاز المطعم، ويُحفظ رابطها العام في قاعدة البيانات كما كان رابط Cloudinary.
   إن لم يرد الجهاز (مطفأ/بلا إنترنت) تُرفع نفس الصورة لـ Cloudinary فلا يتوقف شيء.
   الفيديو (MP4/WebM ≤ 25MB) يُرفع لسحابة الصور أيضاً ويُعرض كما هو مع دعم التقديم (Range). */
function cloudinaryFromBuffer(buf) {
  return new Promise((resolve, reject) => {
    const s = cloudinary.uploader.upload_stream(
      { folder: FOLDER, resource_type: 'image', public_id: uniquePublicId(), transformation: IMAGE_TRANSFORMATION },
      (err, r) => (err ? reject(err) : resolve(r))
    );
    s.end(buf);
  });
}

/** حد الفيديو على سحابة الصور: حد الملف في ImageStorage (25MB) وتحت حد رسالة النفق (32MB). */
const VIDEO_CLOUD_MAX = 25 * 1024 * 1024;

/** رفض الرفع بسبب واضح (يعرضه errorHandler عبر statusCode) — لا رجوع صامت لـ Cloudinary. */
function refused(reason) {
  return Object.assign(new Error(`لم تُرفع الصورة — سحابة الصور: ${reason}. شغّل DiyarPOS على جهاز الكاشير ثم أعد المحاولة.`), { status: 503, statusCode: 503 });
}
/** يستهلك تيار الملف قبل الرد (multer ينتظر انتهاءه). */
function drain(file, done) { let fired = false; const once = () => { if (!fired) { fired = true; done(); } }; file.stream.on('end', once); file.stream.on('error', once); file.stream.resume(); }

class HybridStorage {
  constructor(fallback) { this.fallback = fallback; }

  _handleFile(req, file, cb) {
    const video = isVideoFile(file);
    imageCloud.activeConfig().catch(() => null).then((cfg) => {
      if (video && !cfg) {
        // الفيديو: سحابة الصور أولاً (MP4/WebM حتى 25 ميغابايت). Cloudinary فقط إن شُغّل للطوارئ.
        if (imageCloud.cloudinaryUploads()) return this.fallback._handleFile(req, file, cb);
        const why = imageCloud.policy().reason || 'سحابة الصور غير جاهزة';
        return drain(file, () => cb(Object.assign(new Error(`لم يُرفع الفيديو — ${why}. شغّل DiyarPOS أو Mero Server ثم أعد المحاولة.`), { status: 503, statusCode: 503 })));
      }
      const pol = imageCloud.policy();
      if (!cfg) {
        // السحابة المحلية مختارة: لا Cloudinary — الصورة لم تُرفع، والسبب يصل للوحة كما هو
        if (pol.localOnly) {
          imageCloud.note(false, pol.reason || 'سحابة الصور غير جاهزة');
          return drain(file, () => cb(refused(pol.reason || 'سحابة الصور غير جاهزة')));
        }
        // مفعّلة لكن ناقصة والرجوع مسموح: يُسجَّل السبب بدل الرجوع الصامت
        if (pol.reason) imageCloud.note(false, pol.reason, { fallback: true });
        return this.fallback._handleFile(req, file, cb);
      }
      const chunks = [];
      file.stream.on('data', (c) => chunks.push(c));
      file.stream.on('error', cb);
      file.stream.on('end', async () => {
        const buf = Buffer.concat(chunks);
        if (video && buf.length > VIDEO_CLOUD_MAX) {
          return cb(Object.assign(new Error(`الفيديو ${(buf.length / 1048576).toFixed(1)} ميغابايت — الحد 25 ميغابايت. قصّره أو صدّره بدقة 720p ثم ارفعه.`), { status: 400, statusCode: 400 }));
        }
        try {
          const r = await imageCloud.upload(buf, {
            cfg, filename: file.originalname, mime: file.mimetype,
            folder: imageCloud.folderFor(req), variant: video ? 'large' : imageCloud.variantFor(req),
          });
          // النجاح = الملف يُعرض من رابطه (لا يكفي أن الجهاز قبله)
          const v = await imageCloud.verifyMedia(cfg, r.id, video ? 'large' : imageCloud.variantFor(req), { video });
          if (!v.ok) { imageCloud.remove(r.id, cfg).catch(() => {}); throw Object.assign(new Error(v.message), { status: 0 }); }
          imageCloud.note(true, null, { upload: true });
          cb(null, { path: r.url, filename: r.id, size: buf.length, storage: 'imagecloud' });
        } catch (err) {
          // رفض حقيقي للملف (ليس صورة/تالف/كبير): نعيد رسالة الخدمة العربية كما هي
          if ([413, 415, 422].includes(err.status)) return cb(Object.assign(new Error(err.message), { status: 400, statusCode: 400 }));
          if (pol.localOnly) { imageCloud.note(false, err); return cb(refused(err.message)); }
          imageCloud.note(false, err, { fallback: true });
          if (video) return cb(refused(err.message)); // لا رجوع لـ Cloudinary للفيديو من الذاكرة
          try {
            const r = await cloudinaryFromBuffer(buf);
            cb(null, { path: r.secure_url, filename: r.public_id, size: buf.length, storage: 'cloudinary' });
          } catch (e2) { cb(e2); }
        }
      });
    });
  }

  _removeFile(req, file, cb) {
    if (file.storage === 'imagecloud') { imageCloud.remove(file.filename).finally(() => cb(null)); return; }
    if (this.fallback._removeFile) return this.fallback._removeFile(req, file, cb);
    return cb(null);
  }
}

/* ---------- فلاتر الأنواع (رفض مبكر قبل رفع أي شيء إلى Cloudinary) ---------- */
const imageFileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|webp/;
  const isValid = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  if (isValid) {
    cb(null, true);
  } else {
    cb(new Error('نوع الملف غير مدعوم، الرجاء رفع صورة (jpg, png, webp)'));
  }
};

const mediaFileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|webp|mp4|webm|mov/;
  const isValid = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  if (isValid) {
    cb(null, true);
  } else {
    cb(new Error('نوع الملف غير مدعوم، الرجاء رفع صورة أو فيديو (jpg, png, webp, mp4, webm)'));
  }
};

/* ---------- نُسَخ multer (بنفس أسماء الـ exports السابقة) ---------- */
const upload = multer({
  storage: new HybridStorage(imageStorage),
  fileFilter: imageFileFilter,
  // 25MB — صور الجوالات الحديثة كبيرة؛ تُضغَط تلقائياً على Cloudinary بعد الرفع
  limits: { fileSize: 25 * 1024 * 1024 },
});

// رفع يدعم الصور والفيديو معاً (يُستخدم لخلفية الصفحة الرئيسية)
const uploadMedia = multer({
  storage: new HybridStorage(mediaStorage),
  fileFilter: mediaFileFilter,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB — للفيديوهات
});

module.exports = upload;
module.exports.uploadMedia = uploadMedia;
module.exports.HybridStorage = HybridStorage;
