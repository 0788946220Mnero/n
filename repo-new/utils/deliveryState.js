/**
 * حالة التوصيل — مشتقة دائماً من حقول الطلب الحقيقية كما سجّلها الخادم،
 * فلا يظهر «تم الإرسال» أو «خرج للتوصيل» ما لم يحدث فعلاً.
 *
 *   new        طلب موقع لم يُؤكَّد بعد (pending)
 *   awaiting   مؤكَّد بانتظار تعيين موظف توصيل
 *   assigned   تم تعيين موظف، لم تُرسل التفاصيل بعد
 *   sent       أُرسلت تفاصيل الطلب للموظف
 *   out        خرج للتوصيل (status = out_for_delivery)
 *   delivered  تم التسليم
 *   cancelled  ملغي
 */
const ACTIVE = ['new', 'preparing', 'ready'];

const deliveryState = (o) => {
  if (!o) return '';
  if (o.status === 'cancelled') return 'cancelled';
  if (o.status === 'delivered') return 'delivered';
  if (o.status === 'out_for_delivery') return 'out';
  if (o.status === 'pending') return 'new';
  if (o.deliverySentAt) return 'sent';
  if (o.driver) return 'assigned';
  return 'awaiting';
};

/** شرط MongoDB لكل حالة — للفلترة في الخادم. */
const deliveryStateFilter = (state) => {
  switch (state) {
    case 'cancelled': return { status: 'cancelled' };
    case 'delivered': return { status: 'delivered' };
    case 'out': return { status: 'out_for_delivery' };
    case 'new': return { status: 'pending' };
    case 'sent': return { status: { $in: ACTIVE }, deliverySentAt: { $ne: null } };
    case 'assigned': return { status: { $in: ACTIVE }, deliverySentAt: null, driver: { $ne: null } };
    case 'awaiting': return { status: { $in: ACTIVE }, driver: null };
    default: return null;
  }
};

const DELIVERY_STATES = ['new', 'awaiting', 'assigned', 'sent', 'out', 'delivered', 'cancelled'];

/** طلبات التوصيل الحقيقية: من الموقع/التطبيق بنوع توصيل (لا السفري ولا الاستلام). */
const DELIVERY_BASE = { orderType: 'delivery', source: { $ne: 'pos' } };

module.exports = { deliveryState, deliveryStateFilter, DELIVERY_STATES, DELIVERY_BASE };
