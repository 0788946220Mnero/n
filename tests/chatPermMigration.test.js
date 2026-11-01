/**
 * ترحيل صلاحيات الدردشة: من له «صلاحيات مخصّصة» قديمة يحصل عليها مرة واحدة،
 * ثم يتحكم مدير النظام بها، ولا يُعاد الترحيل بعد قراره.
 *   node --test tests/chatPermMigration.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
['User', 'ChatConversation', 'ChatMessage', 'ChatMedia', 'ChatSetting'].forEach((m) => require(`../models/${m}`));
require('./helpers/memoryDb').installAll();
const M = (n) => require('mongoose').model(n);
const { effectivePermissionsFor } = require('../utils/permissions');
const chat = require('../services/chatService');

const mk = (username, role, permissions) =>
  M('User').create({ name: username, username, password: 'secret123', role, permissions, isActive: true });
const raw = async (username) => (await M('User').findOne({ username }).lean());
const eff = async (username) => effectivePermissionsFor(await raw(username));

test('المستخدم بصلاحيات مخصّصة قديمة يحصل على الدردشة والمكالمات مرة واحدة', async () => {
  await mk('ahmad', 'cashier', ['orders:view']); // قديمة: بلا دردشة
  await mk('nour', 'employee', ['orders:view', 'chat:use', 'chat:calls']); // تملكها أصلاً
  await mk('watcher', 'observer', ['stats:view']); // مراقب بيانات بصلاحيات مخصّصة
  await mk('dlv', 'delivery', ['orders:view']); // مندوب: بلا دخول
  await mk('sara', 'employee', []); // يرث دوره (وفيه الدردشة)
  await mk('boss', 'admin', []);
  assert.equal((await eff('ahmad')).includes('chat:use'), false, 'قبل الترحيل: لا دردشة');

  assert.equal(await chat.migratePersonalPermissions(), 2, 'ahmad و watcher فقط');
  const a = await eff('ahmad');
  assert.ok(a.includes('chat:use') && a.includes('chat:calls') && a.includes('orders:view'), 'أُضيفت الدردشة وبقيت صلاحياته');
  const w = await eff('watcher');
  assert.ok(w.includes('chat:use') && w.includes('chat:calls') && w.includes('stats:view'), 'مراقب البيانات: دردشة مع عرضه');
  assert.deepEqual((await raw('dlv')).permissions, ['orders:view'], 'المندوب لا يُمس');
  assert.deepEqual((await raw('nour')).permissions, ['orders:view', 'chat:use', 'chat:calls'], 'من يملكها لا يُكتب عليه');
  assert.deepEqual((await raw('sara')).permissions, [], 'من يرث دوره لا يُكتب عليه');
  assert.equal((await M('ChatSetting').findOne({ key: 'settings' }).lean()).personalPermsMigrated, true, 'العلامة محفوظة');
});

test('لا يُعاد الترحيل بعد أن يسحب المدير الدردشة من أحد', async () => {
  assert.equal(await chat.migratePersonalPermissions(), 0, 'مرة واحدة فقط');
  await M('User').updateOne({ username: 'ahmad' }, { $set: { permissions: ['orders:view', 'chat:calls'] } }); // المدير يسحب chat:use
  assert.equal(await chat.migratePersonalPermissions(), 0, 'العلامة تمنع إعادة الإضافة');
  assert.equal((await eff('ahmad')).includes('chat:use'), false, 'قرار المدير يبقى');
});
