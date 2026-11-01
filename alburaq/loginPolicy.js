/**
 * سياسة قفل تسجيل الدخول: بعد عدد محدد من المحاولات الخاطئة يُقفل الحساب مؤقتاً.
 * دوال نقية (بلا قاعدة بيانات) لتسهيل الاختبار.
 */
const MAX_FAILURES = Number(process.env.LOGIN_MAX_FAILURES || 5);
const LOCK_MS = Number(process.env.LOGIN_LOCK_MS || 15 * 60 * 1000);

/** الحالة الجديدة بعد محاولة خاطئة. */
function nextFailureState(failedAttempts, now = Date.now()) {
  const failed = (Number(failedAttempts) || 0) + 1;
  if (failed >= MAX_FAILURES) {
    return { failedAttempts: 0, lockedUntil: new Date(now + LOCK_MS) };
  }
  return { failedAttempts: failed, lockedUntil: null };
}

function isLocked(lockedUntil, now = Date.now()) {
  return !!lockedUntil && new Date(lockedUntil).getTime() > now;
}

module.exports = { nextFailureState, isLocked, MAX_FAILURES, LOCK_MS };
