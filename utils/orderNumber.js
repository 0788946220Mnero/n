const Counter = require('../models/Counter');
const Order = require('../models/Order');

/*
  ═══════════════════════════════════════════════════════════════
  توليد رقم طلب تسلسلي (1، 2، 3 ...).

  الخلفية: كان الرقم يُولَّد سابقاً من `Date.now()` فيظهر عشوائياً
  (ORD-15150313). الآن نستخدم عدّاداً ذرّياً في قاعدة البيانات.

  عند أول تشغيل بعد التحديث، يُزرَع العدّاد تلقائياً من أكبر رقم
  موجود فعلاً في الطلبات — فيكمل التسلسل من حيث توقّف (مثلاً 401)
  ولا يعيد استخدام رقم قديم.

  الصيغة قابلة للضبط عبر متغيّر البيئة ORDER_NUMBER_PREFIX:
      (فارغ)     →  401
      ORD-       →  ORD-401
  ═══════════════════════════════════════════════════════════════
*/

const COUNTER_ID = 'order';
const PREFIX = process.env.ORDER_NUMBER_PREFIX || '';

// يستخرج الجزء الرقمي من أي رقم طلب قديم: "52" → 52 | "ORD-15150313" → 15150313
const numericPart = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? parseInt(digits, 10) : 0;
};

// يزرع العدّاد من أكبر رقم موجود — يُنفَّذ مرة واحدة فقط
const seedCounter = async () => {
  const existing = await Counter.findById(COUNTER_ID);
  if (existing) return existing;

  // نتجاهل الأرقام الضخمة الناتجة عن الطابع الزمني القديم (8 خانات فأكثر)
  // حتى لا يقفز التسلسل إلى 15 مليوناً
  const orders = await Order.find().select('orderNumber').lean();
  const max = orders.reduce((m, o) => {
    const n = numericPart(o.orderNumber);
    return n > m && n < 1000000 ? n : m;
  }, 0);

  const seeded = await Counter.findOneAndUpdate(
    { _id: COUNTER_ID },
    { $setOnInsert: { seq: max } },
    { new: true, upsert: true }
  );
  console.log(`🔢 تم تهيئة عدّاد الطلبات — يكمل التسلسل من ${seeded.seq + 1}`);
  return seeded;
};

// الرقم التالي (ذرّي — آمن مع الطلبات المتزامنة)
const nextOrderNumber = async () => {
  await seedCounter();
  const counter = await Counter.findOneAndUpdate(
    { _id: COUNTER_ID },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return `${PREFIX}${counter.seq}`;
};

/*
  توليد آمن: لو حدث تصادم مع رقم موجود مسبقاً (مثلاً بعد استيراد بيانات)
  نحاول الرقم التالي بدل إفشال الطلب.
*/
const generateUniqueOrderNumber = async (attempts = 5) => {
  for (let i = 0; i < attempts; i += 1) {
    const candidate = await nextOrderNumber();
    const exists = await Order.exists({ orderNumber: candidate });
    if (!exists) return candidate;
    console.warn(`⚠️ رقم الطلب ${candidate} مستخدم مسبقاً — ننتقل للرقم التالي`);
  }
  // احتياط أخير حتى لا يفشل الطلب على الزبون إطلاقاً
  return `${PREFIX}${Date.now().toString().slice(-6)}`;
};

module.exports = { generateUniqueOrderNumber, nextOrderNumber, numericPart };
