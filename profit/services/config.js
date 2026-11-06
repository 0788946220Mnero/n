const ProfitConfig = require('../models/ProfitConfig');

let cache = null; let cacheAt = 0;
async function getConfig(fresh = false) {
  if (!fresh && cache && Date.now() - cacheAt < 30000) return cache;
  const c = await ProfitConfig.findOneAndUpdate({ key: 'main' }, { $setOnInsert: { key: 'main' } }, { upsert: true, new: true }).lean();
  cache = c; cacheAt = Date.now();
  return c;
}
function invalidate() { cache = null; }
module.exports = { getConfig, invalidate };
