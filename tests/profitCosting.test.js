/**
 * محرك الربحية — المرحلتان 1 و2:
 * تحويل الوحدات، تكلفة المنتج (مواد + تغليف + هدر + إضافات + تحضيرات)، متوسط التكلفة المرجّح،
 * ترحيل المبيعات ولقطات التكلفة الثابتة، منع الخصم المكرر، عكس الملغى، وجبة الموظف، الجرد.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

['Order', 'Product', 'Category', 'Employee', 'Counter', 'User'].forEach((m) => require(`../models/${m}`));
['Ingredient', 'Recipe', 'StockMovement', 'SaleCost', 'StockReceipt', 'StockCount', 'InternalUse', 'CostItem', 'ProfitConfig'].forEach((m) => require(`../profit/models/${m}`));
const db = require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);
const units = require('../profit/services/units');
const costing = require('../profit/services/costing');
const inv = require('../profit/services/inventory');
const cons = require('../profit/services/consumption');
const cfgSvc = require('../profit/services/config');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const I = {}; const P = {}; let cat;
const user = { name: 'مروان', _id: null };

async function setup() {
  db.reset(); cfgSvc.invalidate();
  cat = await M('Category').create({ name: 'سناكات', nameAr: 'سناكات' }).catch(async () => M('Category').create({ nameAr: 'سناكات', name: 'snacks' }));
  I.bread = await inv.createIngredient({ name: 'خبز صاج', baseUnit: 'pc', purchaseUnits: [{ name: 'ربطة 10', factor: 10 }] });
  I.chicken = await inv.createIngredient({ name: 'صدر دجاج', baseUnit: 'g', wastePct: 10 });
  I.potato = await inv.createIngredient({ name: 'بطاطا', baseUnit: 'g', purchaseUnits: [{ name: 'كيس 5 كغ', factor: 5000 }] });
  I.mayo = await inv.createIngredient({ name: 'مايونيز', baseUnit: 'g', purchaseUnits: [{ name: 'جالون 4 كغ', factor: 4000 }] });
  I.garlic = await inv.createIngredient({ name: 'ثوم', baseUnit: 'g' });
  I.oil = await inv.createIngredient({ name: 'زيت', baseUnit: 'ml' });
  I.box = await inv.createIngredient({ name: 'علبة كرتون', baseUnit: 'pc', category: 'packaging', purchaseUnits: [{ name: 'كرتونة', factor: 200 }] });
  I.toum = await inv.createIngredient({ name: 'ثومية', baseUnit: 'g', kind: 'prep', trackMode: 'explode' });
  P.zinger = await M('Product').create({ nameAr: 'ساندويشة زنجر', price: 2.5, category: cat._id });
  P.fries = await M('Product').create({ nameAr: 'بطاطا', price: 1, category: cat._id });
  // استلام بأسعار معروفة
  await inv.createReceipt({ supplier: 'مخبز', lines: [{ ingredient: I.bread._id, qty: 10, unit: 'ربطة 10', unitPrice: 1 }] }, user);   // 0.1/رغيف
  await inv.createReceipt({ supplier: 'دواجن', lines: [{ ingredient: I.chicken._id, qty: 10, unit: 'kg', unitPrice: 5 }] }, user);      // 0.005/غ
  await inv.createReceipt({ supplier: 'خضار', lines: [{ ingredient: I.potato._id, qty: 2, unit: 'كيس 5 كغ', unitPrice: 4 }] }, user); // 0.0008/غ
  await inv.createReceipt({ lines: [{ ingredient: I.mayo._id, qty: 1, unit: 'جالون 4 كغ', unitPrice: 8 }, { ingredient: I.garlic._id, qty: 1, unit: 'kg', unitPrice: 2 }, { ingredient: I.oil._id, qty: 2, unit: 'l', unitPrice: 1.5 }, { ingredient: I.box._id, qty: 1, unit: 'كرتونة', unitPrice: 10 }] }, user);
  // ثومية: 100غ ثوم + 400مل زيت ← 450غ
  await inv.saveRecipe({ targetType: 'prep', target: I.toum._id, yieldQty: 450, lines: [{ ingredient: I.garlic._id, qty: 100, unit: 'g' }, { ingredient: I.oil._id, qty: 400, unit: 'ml' }] });
  await inv.saveRecipe({
    targetType: 'product', target: P.zinger._id, byName: 'مروان',
    lines: [
      { ingredient: I.bread._id, qty: 1, unit: 'pc' },
      { ingredient: I.chicken._id, qty: 120, unit: 'g' },                 // + هدر 10% = 132غ
      { ingredient: I.potato._id, qty: 50, unit: 'g', wastePct: 0 },
      { ingredient: I.mayo._id, qty: 20, unit: 'g' },
      { ingredient: I.box._id, qty: 1, unit: 'pc' },
    ],
    addonLines: [
      { addonName: 'ثومية', lines: [{ ingredient: I.toum._id, qty: 30, unit: 'g' }] },
      { addonName: 'بدون مايونيز', lines: [{ ingredient: I.mayo._id, qty: -20, unit: 'g' }] },
    ],
  });
  await M('ProfitConfig').updateOne({ key: 'main' }, { $set: { enabled: true, startedAt: new Date(Date.now() - 3600000), dayStartHour: 6 } }, { upsert: true });
  cfgSvc.invalidate();
}
const order = (o) => M('Order').create({ orderNumber: String(o.n || 1), total: o.total || 0, status: o.status || 'new', source: 'pos', orderType: 'pickup', items: o.items, createdAt: o.at || new Date(), discount: o.discount || 0 });
const stock = async (ing) => (await M('Ingredient').findById(ing._id).lean()).stockQty;

test('تحويل الوحدات: 5 كغ بـ 4 دنانير ← تكلفة الغرام وكمية الوصفة', () => {
  const pot = { name: 'بطاطا', baseUnit: 'g', purchaseUnits: [{ name: 'كيس 5 كغ', factor: 5000 }] };
  near(units.baseCostFromPurchase(pot, 4, 'كيس 5 كغ'), 0.0008);
  near(units.toBase(pot, 0.15, 'kg'), 150);
  near(units.toBase({ name: 'زيت', baseUnit: 'ml' }, 1.5, 'لتر'), 1500);
  near(units.toBase({ name: 'علب', baseUnit: 'pc', purchaseUnits: [{ name: 'كرتونة', factor: 24 }] }, 2, 'كرتونة'), 48);
  assert.throws(() => units.toBase(pot, 1, 'ml'), /لا تتوافق/);
  assert.throws(() => units.toBase(pot, 1, 'صندوق'), /غير معروفة/);
});

test('تكلفة المنتج: مواد + تغليف + هدر، والإضافات والاستبدال والتحضير الوسيط', async () => {
  await setup();
  const card = await costing.productCard(await M('Product').findById(P.zinger._id).lean());
  // خبز 0.1 + دجاج 132×0.005=0.66 + بطاطا 50×0.0008=0.04 + مايونيز 20×0.002=0.04 = 0.84 مواد، علبة 0.05 تغليف
  near(card.material, 0.84, 1e-3); near(card.packaging, 0.05, 1e-3); near(card.unitCost, 0.89, 1e-3);
  near(card.grossProfit, 1.61, 1e-3); near(card.marginPct, 64.4, 0.01); near(card.foodCostPct, 35.6, 0.01);
  assert.equal(card.recipeVersion, 1); assert.equal(card.missingRecipe, false);
  // ثومية: (100×0.002 + 400×0.0015) ÷ 450 لكل غ → 30غ = 0.0533
  const withToum = await costing.costLine({ product: P.zinger._id, qty: 1, addons: [{ name: 'ثومية' }] });
  near(withToum.cost, 0.89 + 30 * (0.2 + 0.6) / 450, 1e-4);
  assert.ok(withToum.components.some((c) => c.name === 'ثوم' && c.addon === 'ثومية'), 'التحضير explode يُفكّ لمكوّناته الخام');
  const noMayo = await costing.costLine({ product: P.zinger._id, qty: 1, addons: [{ name: 'بدون مايونيز' }] });
  near(noMayo.cost, 0.85, 1e-3);
  const fries = await costing.productCard(await M('Product').findById(P.fries._id).lean());
  assert.equal(fries.missingRecipe, true); assert.equal(fries.basis, 'missing');
});

test('متوسط التكلفة المرجّح مع كل استلام وسجل الأسعار', async () => {
  await setup();
  // رصيد 10كغ بـ 0.005 + استلام 10كغ بـ 6/كغ ← (50 + 60) / 20000 = 0.0055
  await inv.createReceipt({ lines: [{ ingredient: I.chicken._id, qty: 10, unit: 'kg', unitPrice: 6 }] }, user);
  const ch = await M('Ingredient').findById(I.chicken._id).lean();
  near(ch.avgCost, 0.0055); near(ch.lastCost, 0.006); near(ch.stockQty, 20000);
  assert.equal((await inv.priceHistory(I.chicken._id)).length, 2);
  // نفس clientRef لا يُدخل مرتين
  const a = await inv.createReceipt({ clientRef: 'r-1', lines: [{ ingredient: I.bread._id, qty: 1, unit: 'ربطة 10', unitPrice: 1 }] }, user);
  const b = await inv.createReceipt({ clientRef: 'r-1', lines: [{ ingredient: I.bread._id, qty: 1, unit: 'ربطة 10', unitPrice: 1 }] }, user);
  assert.equal(b.duplicate, true); assert.equal(String(a.receipt._id), String(b.receipt._id));
  near(await stock(I.bread), 110);
});

test('ترحيل البيع: لقطة تكلفة + خصم المخزون، ولا يتكرر عند الإعادة أو التزامن', async () => {
  await setup();
  const o = await order({ n: 7, total: 5.5, items: [{ product: P.zinger._id, nameAr: 'زنجر', quantity: 2, price: 2.5 }, { product: P.fries._id, nameAr: 'بطاطا', quantity: 1, price: 1 }], discount: 0.6 });
  const before = { bread: await stock(I.bread), chicken: await stock(I.chicken) };
  const [r1, r2] = await Promise.all([cons.runOnce(), cons.postOrder(await M('Order').findById(o._id).lean())]);
  void r1; void r2;
  await cons.runOnce(); await cons.postOrder(await M('Order').findById(o._id).lean());
  const sc = db.all('SaleCost').filter((x) => x.kind === 'sale');
  assert.equal(sc.length, 2, 'لقطة لكل سطر مرة واحدة');
  const z = sc.find((x) => x.lineIndex === 0);
  near(z.cost, 1.78, 1e-3); near(z.revenue, 5); near(z.discountShare, 0.5, 1e-6); assert.equal(z.recipeVersion, 1);
  assert.equal(sc.find((x) => x.lineIndex === 1).missingRecipe, true);
  near(before.bread - await stock(I.bread), 2); near(before.chicken - await stock(I.chicken), 264);
  const saleMoves = db.all('StockMovement').filter((m) => m.type === 'sale');
  assert.equal(saleMoves.length, 5, 'حركة لكل مكوّن مرة واحدة');
  assert.equal((await M('Order').findById(o._id).lean()).costPosted, true);
});

test('اللقطة التاريخية ثابتة: تغيّر السعر والوصفة لا يغيّر تكلفة مبيعات الأمس', async () => {
  await setup();
  const o = await order({ n: 8, total: 2.5, items: [{ product: P.zinger._id, nameAr: 'زنجر', quantity: 1, price: 2.5 }] });
  await cons.runOnce();
  const old = db.all('SaleCost').find((x) => String(x.order) === String(o._id));
  // ارتفاع الدجاج + وصفة جديدة بـ 150غ
  await inv.createReceipt({ lines: [{ ingredient: I.chicken._id, qty: 50, unit: 'kg', unitPrice: 9 }] }, user);
  await inv.saveRecipe({ targetType: 'product', target: P.zinger._id, lines: [{ ingredient: I.bread._id, qty: 1, unit: 'pc' }, { ingredient: I.chicken._id, qty: 150, unit: 'g' }] });
  const recs = db.all('Recipe').filter((r) => String(r.target) === String(P.zinger._id));
  assert.equal(recs.length, 2); assert.equal(recs.filter((r) => r.current).length, 1);
  assert.ok(recs.find((r) => r.version === 1).effectiveTo, 'النسخة القديمة أُنهيت ولم تُعدَّل');
  await cons.runOnce();
  const again = db.all('SaleCost').find((x) => String(x.order) === String(o._id));
  near(again.cost, old.cost); assert.equal(again.recipeVersion, 1);
  // بيع جديد يأخذ النسخة 2 والسعر الجديد
  await new Promise((r) => setTimeout(r, 5));
  const o2 = await order({ n: 9, total: 2.5, items: [{ product: P.zinger._id, nameAr: 'زنجر', quantity: 1, price: 2.5 }] });
  await cons.runOnce();
  const fresh = db.all('SaleCost').find((x) => String(x.order) === String(o2._id));
  assert.equal(fresh.recipeVersion, 2); assert.ok(fresh.cost > old.cost);
  // بيع قديم يُرحّل متأخراً (بيع بلا اتصال) يأخذ نسخة الوصفة السارية وقت بيعه
  const r1 = recs.find((r) => r.version === 1);
  const late = await costing.recipeAt('product', P.zinger._id, new Date(new Date(r1.effectiveFrom).getTime() + 1));
  assert.equal(late.version, 1);
});

test('إلغاء طلب بعد ترحيله يعيد المكوّنات للمخزون مرة واحدة', async () => {
  await setup();
  const o = await order({ n: 10, total: 2.5, items: [{ product: P.zinger._id, nameAr: 'زنجر', quantity: 1, price: 2.5 }] });
  const b0 = await stock(I.bread);
  await cons.runOnce();
  near(await stock(I.bread), b0 - 1);
  await M('Order').updateOne({ _id: o._id }, { $set: { status: 'cancelled' } });
  await cons.runOnce(); await cons.runOnce(); await cons.reverseOrder(await M('Order').findById(o._id).lean());
  near(await stock(I.bread), b0);
  assert.equal(db.all('SaleCost').find((x) => String(x.order) === String(o._id)).reversed, true);
  // طلب pending (لم يُؤكَّد) لا يُرحَّل
  await order({ n: 11, total: 2.5, status: 'pending', items: [{ product: P.zinger._id, nameAr: 'زنجر', quantity: 1, price: 2.5 }] });
  await cons.runOnce();
  near(await stock(I.bread), b0);
  // طلب قبل تاريخ التفعيل لا يُكلَّف بأسعار اليوم
  await order({ n: 12, total: 2.5, at: new Date(Date.now() - 5 * 3600000), items: [{ product: P.zinger._id, nameAr: 'زنجر', quantity: 1, price: 2.5 }] });
  await cons.runOnce();
  near(await stock(I.bread), b0);
});

test('وجبة موظف: تخصم المكوّنات وتُسجَّل تكلفة داخلية بلا إيراد', async () => {
  await setup();
  const emp = await M('Employee').create({ name: 'أحمد', salary: 300 });
  const b0 = await stock(I.chicken);
  const r = await inv.internalUse({ kind: 'staff_meal', employee: emp._id, clientRef: 'meal-1', items: [{ product: P.zinger._id, qty: 1 }] }, user);
  const dup = await inv.internalUse({ kind: 'staff_meal', employee: emp._id, clientRef: 'meal-1', items: [{ product: P.zinger._id, qty: 1 }] }, user);
  assert.equal(dup.duplicate, true);
  near(r.doc.cost, 0.89, 1e-3);
  near(b0 - await stock(I.chicken), 132);
  const sc = db.all('SaleCost').filter((x) => x.kind === 'staff_meal');
  assert.equal(sc.length, 1); assert.equal(sc[0].revenue, 0); assert.equal(sc[0].employeeName, 'أحمد');
  assert.equal(db.all('Order').length, 0, 'الوجبة ليست طلب بيع');
  await assert.rejects(inv.internalUse({ kind: 'product_waste', items: [{ product: P.zinger._id, qty: 1 }] }, user), /سبب/);
});

test('الجرد الفعلي: الفرق حركة واحدة بقيمتها ولا يُعتمد مرتين', async () => {
  await setup();
  const c = await inv.createCount({ lines: [{ ingredient: I.potato._id, counted: 9.5, unit: 'kg' }] }, user);
  const posted = await inv.postCount(c._id, user);
  near(posted.lines[0].expected, 10000); near(posted.lines[0].diff, -500); near(posted.shortageValue, 0.4);
  near(await stock(I.potato), 9500);
  await assert.rejects(inv.postCount(c._id, user), /مسبقاً/);
  assert.equal(db.all('StockMovement').filter((m) => m.type === 'count').length, 1);
  const usage = await inv.usageReport(new Date(Date.now() - 864e5), new Date(Date.now() + 1000));
  near(usage.rows.find((x) => x.name === 'بطاطا').countValue, -0.4);
});

test('دفعة تحضير stock: تخصم الخام وتُدخل التحضير بتكلفته', async () => {
  await setup();
  const sauce = await inv.createIngredient({ name: 'صلصة زنجر', baseUnit: 'g', kind: 'prep', trackMode: 'stock' });
  await inv.saveRecipe({ targetType: 'prep', target: sauce._id, yieldQty: 1000, lines: [{ ingredient: I.mayo._id, qty: 800, unit: 'g' }, { ingredient: I.garlic._id, qty: 100, unit: 'g' }] });
  const m0 = await stock(I.mayo);
  const r = await inv.produceBatch({ prep: sauce._id, batches: 2, clientRef: 'b1' }, user);
  const again = await inv.produceBatch({ prep: sauce._id, batches: 2, clientRef: 'b1' }, user);
  assert.equal(again.duplicate, true);
  near(r.produced, 2000); near(r.cost, 1600 * 0.002 + 200 * 0.002, 1e-6);
  near(m0 - await stock(I.mayo), 1600);
  const s = await M('Ingredient').findById(sauce._id).lean();
  near(s.stockQty, 2000); near(s.avgCost, 0.0018);
});
