/**
 * عند تغيّر رصيد أي عضوية: تحديث بطاقة Apple (إشعار APNs) وGoogle (PATCH) في الخلفية.
 * تغييرات متتالية خلال ثانيتين (استبدال ثم منح في البيع نفسه) تُدمج في تحديث واحد.
 * أي فشل يُسجَّل على العضوية ولا يصل للكاشير أبداً.
 */
const loyalty = require('./loyaltyService');
const apple = require('./appleWalletService');
const google = require('./googleWalletService');

const DELAY = Number(process.env.LOYALTY_SYNC_DELAY_MS || 2000);
const timers = new Map();
let started = false;

async function syncNow(accountId) {
  const results = await Promise.allSettled([apple.pushUpdate(accountId), google.syncAccount(accountId)]);
  return { apple: results[0].value || results[0].reason, google: results[1].value || results[1].reason };
}

function schedule(accountId) {
  const k = String(accountId);
  clearTimeout(timers.get(k));
  const t = setTimeout(() => {
    timers.delete(k);
    syncNow(accountId).catch((e) => console.error('wallet sync:', e.message));
  }, DELAY);
  if (t.unref) t.unref();
  timers.set(k, t);
}

function start() {
  if (started) return;
  started = true;
  loyalty.onChanged(schedule);
}

module.exports = { start, syncNow, schedule };
