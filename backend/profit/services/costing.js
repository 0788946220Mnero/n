/**
 * محرك تكلفة المنتج: يفكّ الوصفة (ومكوّنات الإضافات والتحضيرات الوسيطة) إلى مواد خام
 * بوحدة الأساس شاملة الهدر، ثم يضرب في تكلفة الوحدة.
 *
 *   كمية السطر بالأساس = qty × معامل الوحدة × (1 + هدر%)
 *   تكلفة السطر         = كمية الأساس × تكلفة وحدة الأساس
 *   تحضير explode       = يُفكّ لمكوّناته بنسبة (الكمية ÷ yieldQty) ← استهلاك مباشر للخام
 *   تحضير stock         = يُعامل كمادة لها رصيد ومتوسط تكلفة (من دفعات الإنتاج)،
 *                         وإن لم تُسجَّل له تكلفة بعد تُقدَّر من وصفته
 */
const Ingredient = require('../models/Ingredient');
const Recipe = require('../models/Recipe');
const { toBase } = require('./units');

const r6 = (n) => Math.round(n * 1e6) / 1e6;
const r3 = (n) => Math.round(n * 1000) / 1000;

/** كاش لكل عملية حساب: المواد ووصفات التحضير — لا استعلام متكرر لكل سطر. */
function makeCtx() {
  return { ing: new Map(), prepRecipe: new Map() };
}
async function loadIngredients(ctx, ids) {
  const need = [...new Set(ids.map(String))].filter((id) => !ctx.ing.has(id));
  if (need.length) (await Ingredient.find({ _id: { $in: need } }).lean()).forEach((i) => ctx.ing.set(String(i._id), i));
}
async function prepRecipeOf(ctx, ingId, asOf) {
  const k = String(ingId);
  if (!ctx.prepRecipe.has(k)) ctx.prepRecipe.set(k, await recipeAt('prep', ingId, asOf));
  return ctx.prepRecipe.get(k);
}

/** نسخة الوصفة السارية في لحظة معيّنة (للمبيعات التاريخية) أو الحالية. */
async function recipeAt(targetType, target, at) {
  if (!at) return Recipe.findOne({ targetType, target, current: true }).lean();
  const list = await Recipe.find({ targetType, target, effectiveFrom: { $lte: at } }).sort({ effectiveFrom: -1, version: -1 }).lean();
  const hit = list.find((r) => !r.effectiveTo || r.effectiveTo > at) || list[0];
  if (hit) return hit;
  // بيع قبل أول نسخة (طلب منصة أُكّد متأخراً، أو وصفة أُدخلت بعد التفعيل): أقرب نسخة له هي الأولى
  const first = await Recipe.find({ targetType, target }).sort({ version: 1 }).limit(1).lean();
  return first[0] || null;
}

/**
 * يفكّ أسطر وصفة إلى مكوّنات خام (مع تحضيرات stock كمكوّن مستقل).
 * multiplier: عدد القطع × (نسبة التحضير). depth يحمي من وصفة تستدعي نفسها.
 */
async function explode(ctx, lines, multiplier, out, meta, depth = 0) {
  if (depth > 5) throw new Error('وصفة متداخلة بعمق غير منطقي (تحضير يستدعي نفسه؟)');
  await loadIngredients(ctx, lines.map((l) => l.ingredient));
  for (const l of lines) {
    const ing = ctx.ing.get(String(l.ingredient));
    if (!ing) { meta.missing.push(`مادة محذوفة ${l.ingredient}`); continue; }
    const waste = (l.wastePct == null ? ing.wastePct : l.wastePct) || 0;
    const baseQty = toBase(ing, l.qty, l.unit) * (1 + waste / 100) * multiplier;
    if (ing.kind === 'prep' && ing.trackMode === 'explode') {
      const rec = await prepRecipeOf(ctx, ing._id, meta.asOf);
      if (!rec || !rec.lines.length) { meta.missing.push(`تحضير بلا وصفة: ${ing.name}`); continue; }
      await explode(ctx, rec.lines, baseQty / (rec.yieldQty || 1), out, { ...meta, role: l.role || meta.role, addon: meta.addon }, depth + 1);
      continue;
    }
    let unitCost = ing.avgCost || 0;
    if (!unitCost && ing.kind === 'prep') unitCost = await prepUnitCost(ctx, ing, meta.asOf, depth + 1); // تقدير من الوصفة
    if (!unitCost) meta.noCost.push(ing.name);
    out.push({
      ingredient: ing._id, name: ing.name, role: meta.role || l.role || 'material', addon: meta.addon || '',
      qty: r6(baseQty), unitCost: r6(unitCost), cost: r6(baseQty * unitCost),
      deductFrom: ing._id, // التحضير stock يُخصم من رصيده هو
    });
  }
}

/** تكلفة وحدة أساس لتحضير من وصفته = تكلفة الدفعة ÷ yieldQty. */
async function prepUnitCost(ctx, ing, asOf, depth = 0) {
  const rec = await prepRecipeOf(ctx, ing._id, asOf);
  if (!rec || !rec.lines.length) return 0;
  const out = []; const meta = { missing: [], noCost: [], asOf };
  await explode(ctx, rec.lines, 1, out, meta, depth);
  return r6(out.reduce((s, c) => s + c.cost, 0) / (rec.yieldQty || 1));
}

/**
 * تكلفة سطر بيع: qty قطعة من المنتج مع إضافاتها.
 * @returns {{recipe, components, material, packaging, cost, missingRecipe, missingCost, missing[]}}
 */
async function costLine({ product, qty = 1, addons = [], at = null, ctx = makeCtx() }) {
  const recipe = await recipeAt('product', product, at);
  if (!recipe) return { recipe: null, components: [], material: 0, packaging: 0, cost: 0, missingRecipe: true, missingCost: false, missing: ['لا وصفة لهذا الصنف'] };
  const out = []; const meta = { missing: [], noCost: [], asOf: at };
  await explode(ctx, recipe.lines, qty, out, meta);
  for (const a of addons || []) {
    const name = String((a && a.name) || a || '').trim();
    const al = (recipe.addonLines || []).find((x) => x.addonName.trim() === name);
    if (al && al.lines.length) await explode(ctx, al.lines, qty, out, { ...meta, addon: name });
  }
  const material = out.filter((c) => c.role !== 'packaging').reduce((s, c) => s + c.cost, 0);
  const packaging = out.filter((c) => c.role === 'packaging').reduce((s, c) => s + c.cost, 0);
  return {
    recipe, components: out, material: r6(material), packaging: r6(packaging), cost: r6(material + packaging),
    missingRecipe: false, missingCost: meta.noCost.length > 0, missing: [...meta.missing, ...meta.noCost.map((n) => `بلا تكلفة: ${n}`)],
  };
}

/** بطاقة ربحية الصنف بالأسعار الحالية (نظرية — للتسعير والتخطيط). */
async function productCard(product, ctx = makeCtx()) {
  const c = await costLine({ product: product._id, qty: 1, ctx });
  const price = Number(product.price) || 0;
  const gross = price - c.cost;
  return {
    product: product._id, name: product.nameAr, price,
    material: r3(c.material), packaging: r3(c.packaging), unitCost: r3(c.cost),
    grossProfit: r3(gross), marginPct: price ? r3((gross / price) * 100) : null,
    foodCostPct: price ? r3((c.cost / price) * 100) : null,
    recipeVersion: c.recipe ? c.recipe.version : null,
    missingRecipe: c.missingRecipe, missingCost: c.missingCost, missing: c.missing,
    components: c.components.map((x) => ({ name: x.name, role: x.role, addon: x.addon, qty: x.qty, unitCost: x.unitCost, cost: r3(x.cost) })),
    basis: c.missingRecipe ? 'missing' : c.missingCost ? 'partial' : 'estimated',
  };
}

module.exports = { costLine, productCard, recipeAt, prepUnitCost, makeCtx, r3, r6, __explode: explode };
