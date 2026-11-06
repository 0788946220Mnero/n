/**
 * تحويل الوحدات: كل كمية تُحوَّل إلى وحدة أساس المادة (g | ml | pc).
 * الوحدات المعيارية: kg g mg | l ml | pc dozen. أي اسم آخر يُبحث عنه في وحدات شراء المادة
 * (كرتونة = 24 pc، كيس 5 كغ = 5000 g). وحدة غير متوافقة ← خطأ صريح، لا تخمين.
 */
const STANDARD = {
  g: { base: 'g', f: 1 }, kg: { base: 'g', f: 1000 }, mg: { base: 'g', f: 0.001 },
  'غ': { base: 'g', f: 1 }, 'غرام': { base: 'g', f: 1 }, 'كغ': { base: 'g', f: 1000 }, 'كيلو': { base: 'g', f: 1000 },
  ml: { base: 'ml', f: 1 }, l: { base: 'ml', f: 1000 }, 'مل': { base: 'ml', f: 1 }, 'لتر': { base: 'ml', f: 1000 },
  pc: { base: 'pc', f: 1 }, 'حبة': { base: 'pc', f: 1 }, 'قطعة': { base: 'pc', f: 1 }, dozen: { base: 'pc', f: 12 }, 'دزينة': { base: 'pc', f: 12 },
};

class UnitError extends Error {}

/** معامل التحويل: كم وحدة أساس في وحدة واحدة من unit لهذه المادة. */
function factorFor(ingredient, unit) {
  const u = String(unit || '').trim();
  const key = u.toLowerCase();
  const std = STANDARD[key] || STANDARD[u];
  if (std) {
    if (std.base !== ingredient.baseUnit) {
      throw new UnitError(`الوحدة «${u}» لا تتوافق مع وحدة «${ingredient.name}» الأساسية (${ingredient.baseUnit})`);
    }
    return std.f;
  }
  const pu = (ingredient.purchaseUnits || []).find((p) => p.name.trim() === u);
  if (pu) return pu.factor;
  throw new UnitError(`وحدة غير معروفة «${u}» للمادة «${ingredient.name}»`);
}

const toBase = (ingredient, qty, unit) => Number(qty) * factorFor(ingredient, unit);

/** تكلفة وحدة الأساس من سعر وحدة شراء: 5 كغ بـ 4 دنانير ← 0.0008 دينار/غ. */
const baseCostFromPurchase = (ingredient, unitPrice, unit) => Number(unitPrice) / factorFor(ingredient, unit);

module.exports = { factorFor, toBase, baseCostFromPurchase, UnitError, STANDARD };
