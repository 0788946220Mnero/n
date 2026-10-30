/**
 * معاملة MongoDB حين تدعمها القاعدة (Replica Set / Atlas)، وإلا تنفيذ عادي.
 *
 *   await withTxn(async (session) => { await A.create([..], { session }); await B.create([..], { session }); });
 *
 * session = null حين لا تتوفر المعاملات: على المستدعي حينها أن يعوّض بنفسه
 * (يحذف ما كتبه إن فشلت الخطوة التالية) — انظر createExpense.
 * نفس منطق services/loyaltyService.withTxn، معمّماً للعمليات المالية.
 */
const mongoose = require('mongoose');

const txnUnsupported = (e) => e && (e.code === 20 || e.codeName === 'IllegalOperation' ||
  /Transaction numbers are only allowed|replica set|does not support transactions/i.test(String(e.message)));

async function withTxn(fn) {
  if (process.env.FINANCE_DISABLE_TXN === '1' || mongoose.connection.readyState !== 1) return fn(null);
  let session;
  try { session = await mongoose.startSession(); } catch (_) { return fn(null); }
  try {
    let out;
    await session.withTransaction(async () => { out = await fn(session); });
    return out;
  } catch (e) {
    if (txnUnsupported(e)) return fn(null);
    throw e;
  } finally { try { await session.endSession(); } catch (_) { /* */ } }
}

module.exports = { withTxn, txnUnsupported };
