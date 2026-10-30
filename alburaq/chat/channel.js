/**
 * قنوات الدردشة (منطق نقي بلا قاعدة بيانات).
 * الأطراف: 'admin' (الإدارة كطرف واحد) · 'd.<id>' سائق · 's.<id>' متجر
 *   'all'           ← السائقون والإدارة (كل السائقين)
 *   'stores'        ← المتاجر والإدارة (كل المتاجر)
 *   'dm:<a>|<b>'    ← محادثة خاصة بين طرفين (مرتّبان فلا تتكرر): سائق/متجر/الإدارة بأي تركيب
 * مدير النظام (chat:monitor) مشرف: يقرأ كل المحادثات الخاصة ويحذف أي رسالة.
 */
const GROUPS = {
  all: { name: 'السائقون والإدارة', members: 'driver' },
  stores: { name: 'المتاجر والإدارة', members: 'store' },
};
const KEY_RE = /^(admin|d\.[a-f0-9]{24}|s\.[a-f0-9]{24})$/;

const keyOf = (kind, id) => (kind === 'admin' ? 'admin' : `${kind === 'driver' ? 'd' : 's'}.${String(id)}`);

function dmChannel(a, b) {
  const [x, y] = [String(a), String(b)].sort();
  return `dm:${x}|${y}`;
}

/** ['d.x','s.y'] أو null */
function dmParts(channel) {
  const m = /^dm:([^|]+)\|([^|]+)$/.exec(String(channel || ''));
  if (!m || m[1] === m[2] || !KEY_RE.test(m[1]) || !KEY_RE.test(m[2])) return null;
  return [m[1], m[2]];
}

const partOf = (key) => (key === 'admin' ? { kind: 'admin', id: null } : { kind: key[0] === 'd' ? 'driver' : 'store', id: key.slice(2) });

/** party: { key, kind: 'driver'|'store'|'admin', admin: bool, monitor: bool } */
function canRead(party, channel) {
  if (GROUPS[channel]) return party.admin || GROUPS[channel].members === party.kind;
  const parts = dmParts(channel);
  if (!parts) return false;
  return parts.includes(party.key) || (party.admin && parts.includes('admin')) || !!party.monitor;
}

function canWrite(party, channel) {
  if (GROUPS[channel]) return party.admin || GROUPS[channel].members === party.kind;
  const parts = dmParts(channel);
  if (!parts) return false;
  return parts.includes(party.key) || (party.admin && parts.includes('admin'));
}

module.exports = { GROUPS, KEY_RE, keyOf, dmChannel, dmParts, partOf, canRead, canWrite };
