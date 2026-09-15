/*
  ═══════════════════════════════════════════════════════════════
  معالج الأخطاء غير المتزامنة.

  المشكلة التي يحلّها: في Express 4، أي دالة async ترفض (reject) داخل
  متحكّم بلا try/catch لا يلتقطها Express — فتتحوّل إلى
  unhandledRejection، ومع Node 18+ يسقط الخادم كاملاً (502 على Railway).
  مثال واقعي: /api/products/:id بمعرّف غير صالح ← CastError ← سقوط الخادم.

  asyncHandler يلفّ الدالة فيُمرّر أي خطأ إلى errorHandler بدل إسقاط الخادم.
  wrapAll يطبّق ذلك تلقائياً على كل دوال المتحكّم دون تعديل منطقها.
  ═══════════════════════════════════════════════════════════════
*/

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// يلفّ كل دوال الوسائط/المتحكّمات في كائن واحد.
// الدوال المساعدة (التي تأخذ أقل من وسيطين مثل normalizePhone) تبقى كما هي.
const wrapAll = (handlers) => {
  const out = {};
  for (const [name, fn] of Object.entries(handlers)) {
    out[name] = typeof fn === 'function' && fn.length >= 2 ? asyncHandler(fn) : fn;
  }
  return out;
};

module.exports = { asyncHandler, wrapAll };
