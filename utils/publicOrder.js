const crypto = require('crypto');
const { deliveryState } = require('./deliveryState');

/**
 * ما يراه الزبون من طلبه — بلا بيانات إدارية: لا أسماء موظفين، لا جرد،
 * لا ملاحظات داخلية، لا رمز التتبع نفسه، ولا هاتف/عنوان (يعرفهما الزبون).
 */
// حالات يُسمح فيها للزبون بمراسلة المطعم، وبإضافة أصناف لنفس الطلب
const REQ_ACTIVE = ['pending', 'new', 'preparing', 'ready', 'out_for_delivery'];
const REQ_ADDABLE = ['pending', 'new', 'preparing'];

const publicOrder = (o) => {
  if (!o) return null;
  const isDelivery = o.orderType === 'delivery' && o.source !== 'pos';
  const at = (d) => (d ? new Date(d).toISOString() : null);
  return {
    id: String(o._id),
    orderNumber: o.orderNumber,
    createdAt: at(o.createdAt),
    orderType: o.orderType,
    status: o.status,
    deliveryState: isDelivery ? deliveryState(o) : '',
    hasDriver: !!o.driver,
    items: (o.items || []).map((i) => ({
      product: i.product ? String(i.product) : null,
      name: i.nameAr || '',
      quantity: i.quantity || 1,
      price: Number(i.price || 0),
      addons: (i.addons || []).map((a) => ({ name: a.name || '', price: Number(a.price || 0) })),
      notes: i.notes || '',
    })),
    itemsTotal: Number(o.itemsTotal || 0),
    deliveryFee: Number(o.deliveryFee || 0),
    total: Number(o.total || 0),
    paymentMethod: o.paymentMethod || 'cash',
    times: {
      confirmedAt: at(o.confirmedAt),
      driverAssignedAt: at(o.driverAssignedAt),
      deliverySentAt: at(o.deliverySentAt),
      outForDeliveryAt: at(o.outForDeliveryAt),
      deliveredAt: at(o.deliveredAt),
      cancelledAt: at(o.cancelledAt),
    },
    timeline: (o.timeline || []).map((t) => ({ event: t.event, at: at(t.at) })),
    // رسائل الزبون وردّ المطعم عليها (بلا أسماء موظفين)
    requests: (o.customerRequests || []).map((r) => ({
      id: String(r._id),
      kind: r.kind,
      text: r.text || '',
      items: (r.items || []).map((i) => ({
        name: i.nameAr || '', quantity: i.quantity || 1, price: Number(i.price || 0),
        addons: (i.addons || []).map((a) => ({ name: a.name || '', price: Number(a.price || 0) })), notes: i.notes || '',
      })),
      amount: Number(r.amount || 0),
      status: r.status,
      reply: r.reply || '',
      createdAt: at(r.createdAt),
      resolvedAt: at(r.resolvedAt),
    })),
    // ما يستطيع الزبون فعله الآن (الخادم يتحقق مجدداً عند الإرسال)
    can: {
      message: !o.closed && REQ_ACTIVE.includes(o.status),
      add: !o.closed && REQ_ADDABLE.includes(o.status),
      nudge: !o.closed && o.status === 'pending',
    },
    updatedAt: at(o.updatedAt),
  };
};

/** مقارنة رمز التتبع بزمن ثابت. */
const tokenMatches = (stored, given) => {
  const a = Buffer.from(String(stored || ''));
  const b = Buffer.from(String(given || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
};

module.exports = { publicOrder, tokenMatches, REQ_ACTIVE, REQ_ADDABLE };
