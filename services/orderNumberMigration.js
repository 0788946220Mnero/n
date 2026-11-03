/*
 * ترحيل أرقام الفواتير الدورية (order-number-series-v1):
 *   كان orderNumber فريداً في القاعدة (فهرس orderNumber_1). الآن يدور (1…400 / 1…200)،
 *   فالفهرس الفريد القديم يرفض أول رقم يعود — نستبدله بفهرس عادي، والفرادة صارت على
 *   (numberSeries, numberSeq). يُعاد التحقق عند كل تشغيل (آمن ومتكرر)، فلا يبقى الفهرس القديم أبداً.
 */
const Order = require('../models/Order');

async function migrate() {
  const coll = Order.collection;
  let indexes = [];
  try { indexes = await coll.indexes(); } catch (e) { if (e && e.codeName === 'NamespaceNotFound') return false; throw e; }
  const old = indexes.find((i) => i.key && Object.keys(i.key).length === 1 && i.key.orderNumber === 1 && i.unique);
  if (old) {
    await coll.dropIndex(old.name);
    console.log('🔢 أرقام الفواتير: أُزيل الفهرس الفريد القديم على orderNumber (الأرقام تدور الآن)');
  }
  // الفهارس الجديدة (العادي على الرقم، والفريد على السلسلة والتسلسل)
  await Order.createIndexes().catch((e) => console.error('order indexes:', e.message));
  return !!old;
}

function start() {
  const mongoose = require('mongoose');
  const run = () => migrate().catch((e) => console.error('order number migration:', e.message));
  if (mongoose.connection.readyState === 1) run();
  else mongoose.connection.once('open', run);
}

module.exports = { migrate, start };
