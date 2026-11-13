/** «ديار الأنباط» ← «البراق» في الإعدادات التي تُطبع، مرة واحدة. */
const test = require('node:test');
const assert = require('node:assert/strict');
['Setting', 'SystemMigration'].forEach((m) => require(`../models/${m}`));
require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);
const { migrateBrand } = require('../services/brandMigration');

test('الاسم والشعار القديمان يُستبدلان مرة واحدة، وما يغيّره المدير بعدها يبقى', async () => {
  await M('Setting').create({ restaurantName: 'مطاعم ديار الأنباط', logo: '/uploads/old-logo.jpg', aboutText: 'أهلاً في ديار الانباط', invoiceSettings: { footerText: 'شكراً لزيارتكم ديار الأنباط', fontSize: 17 } });
  assert.equal(await migrateBrand(), 1);
  const s = await M('Setting').findOne().lean();
  assert.equal(s.restaurantName, 'البراق');
  assert.equal(s.logo, '', 'الشعار القديم يُزال فيُطبع شعار البراق المدمج');
  assert.equal(s.aboutText, 'أهلاً في البراق');
  assert.equal(s.invoiceSettings.footerText, 'شكراً لزيارتكم البراق');
  assert.equal(s.invoiceSettings.fontSize, 17);
  await M('Setting').updateOne({}, { $set: { restaurantName: 'ديار الأنباط' } });
  assert.equal(await migrateBrand(), 0, 'لا تكرار');
  assert.equal((await M('Setting').findOne().lean()).restaurantName, 'ديار الأنباط');
});
