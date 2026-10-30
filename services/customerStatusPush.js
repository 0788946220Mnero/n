/**
 * إشعار الزبون على جواله بحالة طلبه (من منصة الزبائن): تأكيد، تحضير، جاهز، في الطريق، تسليم، إلغاء.
 * يصل لأجهزته المشتركة في الإشعارات (PushSubscriber) المطابقة لرقم هاتف الطلب.
 * لا يعطّل أي شيء إن لم تُضبط Firebase أو لم يشترك الزبون.
 */
const siteUrl = () => String(process.env.PUBLIC_SITE_URL || 'https://diyaralanbat.com').replace(/\/$/, '');
const last9 = (p) => String(p || '').replace(/\D/g, '').slice(-9);

function messageFor(order, prev) {
  const n = order.orderNumber ? `#${order.orderNumber}` : '';
  const pickup = order.orderType === 'pickup';
  switch (order.status) {
    case 'new': return prev === 'pending' ? { title: `✅ تم تأكيد طلبك ${n}`, body: 'بدأنا بتحضيره الآن — شكراً لاختيارك', urgent: false } : null;
    case 'preparing': return { title: `👨‍🍳 طلبك ${n} قيد التحضير`, body: 'نحضّره لك طازجاً', urgent: false };
    case 'ready': return pickup
      ? { title: `🔔 طلبك ${n} جاهز للاستلام`, body: 'تفضّل لاستلامه من المطعم', urgent: true }
      : { title: `📦 طلبك ${n} جاهز`, body: 'بانتظار السائق لينطلق إليك', urgent: false };
    case 'out_for_delivery': return { title: `🛵 طلبك ${n} في الطريق إليك`, body: 'جهّز نفسك — السائق قادم', urgent: true };
    case 'delivered': return { title: `✅ وصل طلبك ${n}`, body: 'بالعافية! يسعدنا تقييمك', urgent: false };
    case 'cancelled': return { title: `⛔ أُلغي طلبك ${n}`, body: order.cancelReason ? `السبب: ${String(order.cancelReason).slice(0, 120)}` : 'تواصل معنا إن كان لديك استفسار', urgent: true };
    default: return null;
  }
}

async function notify(order, prev) {
  try {
    if (!order || (order.source && order.source !== 'web')) return;
    if (prev && prev === order.status) return;
    const msg = messageFor(order, prev);
    const key = last9(order.phone);
    if (!msg || key.length < 9) return;
    const pushService = require('./pushService');
    if (!pushService.isEnabled()) return;
    const PushSubscriber = require('../models/PushSubscriber');
    const subs = await PushSubscriber.find({ isActive: true, phone: { $regex: key + '$' } }).select('token').lean();
    const tokens = [...new Set(subs.map((s) => s.token).filter(Boolean))];
    if (!tokens.length) return;
    const admin = require('firebase-admin');
    const link = siteUrl() + '/';
    const res = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title: msg.title, body: msg.body },
      data: { kind: 'order.status', orderId: String(order._id), status: order.status, link },
      android: { priority: 'high', notification: { channelId: 'orders_channel', sound: 'default' } },
      apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
      webpush: {
        headers: { Urgency: 'high', TTL: '3600' },
        notification: {
          title: msg.title, body: msg.body, dir: 'rtl', lang: 'ar', tag: 'order-' + order._id, renotify: true,
          requireInteraction: msg.urgent, vibrate: msg.urgent ? [700, 150, 700, 150, 700] : [300, 120, 300],
        },
        fcmOptions: { link },
      },
    });
    const dead = [];
    res.responses.forEach((r, i) => { if (!r.success && pushService.isDeadToken(r.error && r.error.code)) dead.push(tokens[i]); });
    if (dead.length) await PushSubscriber.updateMany({ token: { $in: dead } }, { $set: { isActive: false } });
  } catch (e) {
    console.error('customer status push:', e.message);
  }
}

module.exports = { notify, messageFor };
