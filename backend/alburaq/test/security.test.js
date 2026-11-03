const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone, isValidPin, isValidOtpFormat, generateOtp, hashSecret, compareSecret, safeEqualSecret } = require('../security');
const { nextFailureState, isLocked, MAX_FAILURES, LOCK_MS } = require('../loginPolicy');

test('normalizePhone يقبل الصيغ الشائعة ويوحّدها', () => {
  assert.equal(normalizePhone('+962 7 9012 3456'), '+962790123456');
  assert.equal(normalizePhone('00962790123456'), '+962790123456');
  assert.equal(normalizePhone('0790-123-456'), '0790123456');
});

test('normalizePhone يرفض المدخلات غير الصالحة', () => {
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone('abc'), null);
  assert.equal(normalizePhone('12'), null);
  assert.equal(normalizePhone('+1234567890123456789'), null);
});

test('PIN من 4 إلى 6 أرقام فقط', () => {
  assert.equal(isValidPin('1234'), true);
  assert.equal(isValidPin('123456'), true);
  assert.equal(isValidPin('123'), false);
  assert.equal(isValidPin('1234567'), false);
  assert.equal(isValidPin('12a4'), false);
});

test('OTP المولَّد 12 رقماً ويجتاز التحقق من الصيغة', () => {
  for (let i = 0; i < 200; i++) {
    const otp = generateOtp();
    assert.match(otp, /^\d{12}$/);
    assert.equal(isValidOtpFormat(otp), true);
  }
  assert.equal(isValidOtpFormat('12345'), false);
});

test('التجزئة تتحقق بشكل صحيح ولا تعيد النص الأصلي', async () => {
  const hash = await hashSecret('123456');
  assert.notEqual(hash, '123456');
  assert.equal(await compareSecret('123456', hash), true);
  assert.equal(await compareSecret('654321', hash), false);
  assert.equal(await compareSecret('123456', null), false);
});

test('مقارنة كلمة مرور الأدمن', () => {
  assert.equal(safeEqualSecret('abc', 'abc'), true);
  assert.equal(safeEqualSecret('abc', 'abd'), false);
  assert.equal(safeEqualSecret('abc', 'abcd'), false);
});

test('القفل بعد عدد المحاولات الخاطئة المحدد', () => {
  let state = { failedAttempts: 0, lockedUntil: null };
  const now = 1_000_000;
  for (let i = 1; i < MAX_FAILURES; i++) {
    state = nextFailureState(state.failedAttempts, now);
    assert.equal(state.lockedUntil, null, `لا قفل عند المحاولة ${i}`);
  }
  state = nextFailureState(state.failedAttempts, now);
  assert.equal(state.failedAttempts, 0);
  assert.equal(state.lockedUntil.getTime(), now + LOCK_MS);
  assert.equal(isLocked(state.lockedUntil, now + 1000), true);
  assert.equal(isLocked(state.lockedUntil, now + LOCK_MS + 1), false);
});
