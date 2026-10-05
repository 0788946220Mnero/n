const ShiftSession = require('../models/ShiftSession');

const nameOf = (u) => (u && (u.name || u.username)) || '';
const stamp = (d = new Date()) => d.toISOString().replace(/[-:T.]/g, '').slice(0, 14);
const newShiftId = (user, scope) => `SHIFT-${stamp()}-${scope === 'all' ? 'ALL' : (user && user.username) || 'user'}`;

/**
 * الدورة المفتوحة للمستخدم، أو تُفتح الآن.
 * ذرّية: upsert بشرط «مفتوحة لهذا المستخدم» — فلا تُفتح دورتان لنفس المستخدم معاً.
 * auto=true عند فتحها تلقائياً بأول بيع/تأكيد (بلا ضغط «فتح الجرد»).
 */
const ensureOpenSession = async (user, { auto = false } = {}) => {
  if (!user || !user._id) return null;
  const filter = { user: user._id, scope: 'mine', status: 'open' };
  const existing = await ShiftSession.findOne(filter);
  if (existing) return existing;
  try {
    const session = await ShiftSession.findOneAndUpdate(
      filter,
      {
        $setOnInsert: {
          shiftId: newShiftId(user, 'mine'),
          scope: 'mine',
          user: user._id,
          userName: nameOf(user),
          status: 'open',
          openedAt: new Date(),
          openedBy: user._id,
          openedByName: nameOf(user),
          autoOpened: !!auto,
        },
      },
      { new: true, upsert: true }
    );
    // الفتح التلقائي (بأول بيع/تأكيد) عملية فتح جرد حقيقية: تُسجَّل في سجل المستخدم
    if (auto && session && session.autoOpened) {
      require('../utils/activity').logActivity({
        user, action: 'shift.open', details: { shiftId: session.shiftId, auto: true },
      });
    }
    return session;
  } catch (e) {
    // سباق نادر بين طلبين متزامنين: الأول فتحها، نقرأها
    if (e && e.code === 11000) return ShiftSession.findOne(filter);
    throw e;
  }
};

/** فتح تلقائي بلا انتظار — لا يعطّل البيع أو التأكيد إن فشل. */
const touchOpenSession = (user) => {
  ensureOpenSession(user, { auto: true }).catch((e) => console.error('shift auto-open failed:', e.message));
};

const getOpenSession = (user) =>
  user ? ShiftSession.findOne({ user: user._id, scope: 'mine', status: 'open' }) : null;

/** أرقام مختصرة من ملخص الجرد للجداول والبحث. */
const numbersFrom = (summary = {}) => ({
  ordersCount: Number(summary.successCount || 0),
  salesTotal: Number(summary.successTotal || 0),
  deliveryTotal: Number(summary.deliveryIncluded ? summary.deliveryTotal || 0 : summary.deliveryInfoTotal || 0),
  cashTotal: Number(summary.cashTotal || 0),
  cliqTotal: Number(summary.cliqTotal || 0),
  cardTotal: Number(summary.cardTotal || 0),
  otherPaymentsTotal: Number(summary.otherPaymentsTotal || 0),
  expensesTotal: Number(summary.expensesTotal || 0),
  cashNet: Number(summary.cashNet || 0),
  periodStart: summary.firstAt || null,
});

module.exports = { ensureOpenSession, touchOpenSession, getOpenSession, newShiftId, numbersFrom, nameOf };
