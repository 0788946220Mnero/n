/*
  ═══════════════════════════════════════════════════════════════
  أجهزة سحابة الصور: كل DiyarPOS يشغّل خدمة الصور ينضم للمجموعة، فتتزامن الصور فورياً بينها.

  • الانضمام (مدير النظام): الخادم يعطي الجهاز سرّ المزامنة وسرّ التوقيع ورمز النفق والرابط العام،
    وقائمة الأجهزة الأخرى وعناوينها على الشبكة المحلية — بلا نسخ رموز يدوياً.
  • النبض (كل دقيقة، أي مستخدم مسجّل على الجهاز): حالة الجهاز (عدد الصور، الملفات الناقصة،
    اتصاله بالأجهزة الأخرى) ← والرد: قائمة الأجهزة المحدّثة (جهاز جديد أو عنوان تغيّر).
  • الإشعار: مشكلة تستمر (ملفات ناقصة > دقيقتين، جهاز لا يتصل بآخر، جهاز اختفى) ← تنبيه لحظي
    لمدير النظام مرة واحدة، ثم «اكتملت المزامنة» عند زوالها.
  ═══════════════════════════════════════════════════════════════
*/
const crypto = require('crypto');
const ImageCloud = require('../models/ImageCloud');

const ID_RX = /^[A-Za-z0-9-]{2,64}$/;
const MISSING_GRACE_MS = Number(process.env.IMAGE_NODES_MISSING_GRACE_MS || 120000); // ملفات تُجلب الآن — لا إنذار فوراً
const OFFLINE_MS = Number(process.env.IMAGE_NODES_OFFLINE_MS || 5 * 60000);

const secret = () => crypto.randomBytes(36).toString('base64').replace(/[+/=]/g, (c) => ({ '+': 'A', '/': 'B', '=': '' }[c]));
const cleanUrl = (u) => String(u || '').trim().replace(/\/+$/, '').slice(0, 200);
const label = (n) => n.name || n.machine || n.nodeId;

async function doc() {
  let d = await ImageCloud.findOne({ key: 'main' }).select('+syncSecret +signingSecret +tunnelToken').lean();
  if (!d) { await ImageCloud.updateOne({ key: 'main' }, { $set: { key: 'main' } }, { upsert: true }); d = { key: 'main', nodes: [] }; }
  d.nodes = d.nodes || [];
  return d;
}

const peersFor = (nodes, selfId) => nodes.filter((n) => n.nodeId !== selfId && n.lanUrl).map((n) => ({ nodeId: n.nodeId, url: n.lanUrl }));

/** مشكلة الجهاز الآن (نص عربي) أو '' — تُحسب عند العرض وعند كل نبض. */
function issueOf(n, all, now = Date.now()) {
  const seen = n.lastSeen ? new Date(n.lastSeen).getTime() : 0;
  if (!seen || now - seen > OFFLINE_MS) return seen ? `جهاز ${label(n)} لا يرسل حالته منذ ${Math.round((now - seen) / 60000)} دقيقة — مطفأ أو بلا إنترنت` : '';
  if (!n.running) return `خدمة الصور متوقفة على جهاز ${label(n)}`;
  if (n.missingFiles > 0 && n.missingSince && now - new Date(n.missingSince).getTime() > MISSING_GRACE_MS) {
    return `جهاز ${label(n)} ينقصه ${n.missingFiles} ملف صورة من الأجهزة الأخرى`;
  }
  const alive = new Set(all.filter((x) => x.lastSeen && now - new Date(x.lastSeen).getTime() < OFFLINE_MS).map((x) => x.nodeId));
  const down = (n.peers || []).filter((p) => alive.has(p.nodeId) && !p.connected);
  if (down.length) return `جهاز ${label(n)} لا يتصل بـ ${down.map((p) => label(all.find((x) => x.nodeId === p.nodeId) || p)).join('، ')} — تحقق من الشبكة المحلية والجدار الناري (المنفذ 7443)`;
  return '';
}

/** الانضمام أو التحديث (مدير النظام). يرجع ما يلزم الجهاز ليتزامن. */
async function join(user, body) {
  const nodeId = String((body && body.nodeId) || '');
  if (!ID_RX.test(nodeId)) throw Object.assign(new Error('معرّف الجهاز غير صالح'), { status: 400 });
  const d = await doc();
  const $set = {};
  if (!d.syncSecret) $set.syncSecret = d.syncSecret = secret();
  // سرّ التوقيع: أول جهاز يحدده (روابط الصور الخاصة الموقّعة تعمل على كل الأجهزة)
  if (!d.signingSecret) $set.signingSecret = d.signingSecret = (body.signingSecret && String(body.signingSecret).length >= 32) ? String(body.signingSecret) : secret();
  if (!d.tunnelToken && body.tunnelToken) $set.tunnelToken = d.tunnelToken = String(body.tunnelToken).slice(0, 4000);
  if (!d.baseUrl && body.publicUrl) $set.baseUrl = d.baseUrl = cleanUrl(body.publicUrl);
  const node = {
    nodeId, name: String(body.name || '').slice(0, 60), machine: String(body.machine || '').slice(0, 60),
    lanUrl: cleanUrl(body.lanUrl), joinedBy: (user && (user.name || user.username)) || '', lastSeen: new Date(), running: true,
  };
  const nodes = d.nodes.filter((n) => n.nodeId !== nodeId);
  const prev = d.nodes.find((n) => n.nodeId === nodeId);
  nodes.push({ ...(prev || {}), ...node, joinedAt: (prev && prev.joinedAt) || new Date() });
  $set.nodes = nodes;
  await ImageCloud.updateOne({ key: 'main' }, { $set }, { upsert: true });
  return {
    nodeId, syncSecret: d.syncSecret, signingSecret: d.signingSecret, tunnelToken: d.tunnelToken || '',
    publicUrl: d.baseUrl || '', projectId: d.projectId || 'diyar', peers: peersFor(nodes, nodeId),
  };
}

/** نبض الجهاز: يحدّث حالته ويرجع الأجهزة الأخرى. لا أسرار في الرد. */
async function heartbeat(body, notify) {
  const nodeId = String((body && body.nodeId) || '');
  const d = await doc();
  const idx = d.nodes.findIndex((n) => n.nodeId === nodeId);
  if (idx < 0) throw Object.assign(new Error('هذا الجهاز لم ينضم للمزامنة بعد — انضم من DiyarPOS ← سحابة الصور بحساب مدير النظام'), { status: 404 });
  const n = { ...d.nodes[idx] };
  const L = body.local || {};
  const now = new Date();
  n.lastSeen = now;
  n.running = body.running !== false;
  if (body.lanUrl) n.lanUrl = cleanUrl(body.lanUrl);
  if (body.name) n.name = String(body.name).slice(0, 60);
  n.images = Number(L.images) || 0;
  const missing = Number(L.missingFiles) || 0;
  n.missingSince = missing > 0 ? (n.missingFiles > 0 && n.missingSince ? n.missingSince : now) : null;
  n.missingFiles = missing;
  n.peers = Array.isArray(L.peers) ? L.peers.slice(0, 20).map((p) => ({ nodeId: String(p.nodeId || ''), connected: !!p.connected, pendingEvents: Number(p.pendingEvents) || 0, lastError: String(p.lastError || '').slice(0, 200) })) : [];
  const nodes = d.nodes.slice(); nodes[idx] = n;

  // إشعار: عند تغيّر حال المشكلة فقط (لا تكرار كل دقيقة) — لكل الأجهزة، فجهاز اختفى
  // يُكتشف من نبض جهاز آخر
  const t = Date.now();
  nodes.forEach((x, i) => {
    const issue = issueOf(x, nodes, t);
    if (issue === (x.issue || '')) return;
    if (issue) notify && notify('imagecloud.alert', { level: 'warn', nodeId: x.nodeId, message: issue });
    else notify && notify('imagecloud.alert', { level: 'ok', nodeId: x.nodeId, message: `✓ جهاز ${label(x)}: المزامنة سليمة ولا ملفات ناقصة` });
    nodes[i] = { ...x, issue };
  });
  await ImageCloud.updateOne({ key: 'main' }, { $set: { nodes } });
  return { peers: peersFor(nodes, nodeId), issue: nodes[idx].issue || '' };
}

async function remove(nodeId) {
  const d = await doc();
  await ImageCloud.updateOne({ key: 'main' }, { $set: { nodes: d.nodes.filter((n) => n.nodeId !== nodeId) } });
}

/** للعرض في اللوحة: الأجهزة وحالة كل منها. */
function view(nodes) {
  const now = Date.now();
  return (nodes || []).map((n) => ({
    nodeId: n.nodeId, name: n.name, machine: n.machine, lanUrl: n.lanUrl, joinedAt: n.joinedAt, lastSeen: n.lastSeen,
    online: !!(n.lastSeen && now - new Date(n.lastSeen).getTime() < OFFLINE_MS), running: !!n.running,
    images: n.images || 0, missingFiles: n.missingFiles || 0,
    peers: (n.peers || []).map((p) => ({ nodeId: p.nodeId, connected: !!p.connected, pendingEvents: p.pendingEvents || 0 })),
    issue: issueOf(n, nodes, now),
  }));
}

module.exports = { join, heartbeat, remove, view, issueOf, peersFor, ID_RX };
