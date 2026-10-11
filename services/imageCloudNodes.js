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

const HEX64 = /^[a-f0-9]{64}$/;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sameHash = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === 64 && b.length === 64 &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const nameOf = (u) => (u && (u.name || u.username)) || '';
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
    lanUrl: cleanUrl(body.lanUrl), joinedBy: nameOf(user), lastSeen: new Date(), running: true,
  };
  if (HEX64.test(String(body.proofHash || ''))) node.proofHash = String(body.proofHash);
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
  const out = { peers: peersFor(nodes, nodeId), issue: nodes[idx].issue || '' };
  // جهاز أثبت هويته بسرّه: يستلم الرابط العام ورمز النفق كما ضبطهما المدير من اللوحة
  if (body.proof && sameHash(sha(body.proof), n.proofHash)) out.config = { publicUrl: d.baseUrl || '', tunnelToken: d.tunnelToken || '' };
  return out;
}

/* ═══ الربط التلقائي: طلب ← موافقة ← استلام ═══ */

/**
 * DiyarPOS يطلب الربط عند تشغيله (بأي حساب مسجّل). يرسل بصمة سرٍّ يبقى عنده؛ الأسرار لا تُسلَّم
 * إلا لمن يملك السر بعد موافقة المدير. حساب يملك صلاحية «سحابة الصور» يُوافَق عليه فوراً.
 * يُستدعى دورياً — فهو أيضاً سؤال «هل وافق المدير؟».
 */
async function request(user, body, { canApprove = false, onNew } = {}) {
  const nodeId = String((body && body.nodeId) || '');
  if (!ID_RX.test(nodeId)) throw Object.assign(new Error('معرّف الجهاز غير صالح'), { status: 400 });
  const proofHash = String(body.proofHash || '').toLowerCase();
  if (!HEX64.test(proofHash)) throw Object.assign(new Error('بصمة الجهاز غير صالحة'), { status: 400 });
  const d = await doc();
  const node = d.nodes.find((n) => n.nodeId === nodeId);
  if (node && sameHash(node.proofHash, proofHash)) return { status: 'joined' };

  const all = d.requests || [];
  const prev = all.find((r) => r.nodeId === nodeId);
  const now = new Date();
  const fresh = !prev || prev.proofHash !== proofHash; // جهاز أعيد تثبيته = طلب جديد
  const r = fresh
    ? { nodeId, proofHash, requestedBy: nameOf(user), requestedAt: now, status: 'pending', approvedBy: '', approvedAt: null }
    : { ...prev };
  Object.assign(r, {
    name: String(body.name || r.name || '').slice(0, 60), machine: String(body.machine || r.machine || '').slice(0, 60),
    lanUrl: cleanUrl(body.lanUrl || r.lanUrl), publicUrl: cleanUrl(body.publicUrl || r.publicUrl), lastSeen: now,
  });
  if (r.status !== 'approved' && canApprove) Object.assign(r, { status: 'approved', approvedBy: nameOf(user), approvedAt: now });
  const requests = all.filter((x) => x.nodeId !== nodeId).concat(r).slice(-20);
  await ImageCloud.updateOne({ key: 'main' }, { $set: { requests } }, { upsert: true });
  if (fresh && r.status === 'pending' && onNew) onNew(r);
  return { status: r.status, approvedBy: r.approvedBy || '' };
}

/** موافقة المدير أو رفضه. */
async function decide(user, nodeId, approve) {
  const d = await doc();
  const all = d.requests || [];
  const r = all.find((x) => x.nodeId === nodeId);
  if (!r) throw Object.assign(new Error('لا يوجد طلب ربط من هذا الجهاز'), { status: 404 });
  Object.assign(r, approve
    ? { status: 'approved', approvedBy: nameOf(user), approvedAt: new Date() }
    : { status: 'rejected', approvedBy: nameOf(user), approvedAt: new Date() });
  await ImageCloud.updateOne({ key: 'main' }, { $set: { requests: all } });
  return r;
}

/**
 * الجهاز المُوافَق عليه يستلم: يثبت أنه صاحب الطلب بالسر نفسه، فينضم للمزامنة
 * (الأسرار وقائمة الأجهزة) ويُحذف طلبه.
 */
async function claim(body) {
  const nodeId = String((body && body.nodeId) || '');
  const d = await doc();
  const all = d.requests || [];
  const r = all.find((x) => x.nodeId === nodeId);
  if (!r || !body.proof || !sameHash(sha(body.proof), r.proofHash)) {
    throw Object.assign(new Error('هذا الجهاز لم يطلب الربط أو تغيّر — أعد تشغيل DiyarPOS'), { status: 403 });
  }
  if (r.status !== 'approved') {
    throw Object.assign(new Error(r.status === 'rejected' ? 'رفض مدير النظام ربط هذا الجهاز' : 'بانتظار موافقة مدير النظام'), { status: 409 });
  }
  const out = await join({ name: r.approvedBy }, { ...body, proofHash: r.proofHash, name: body.name || r.name, machine: body.machine || r.machine });
  await ImageCloud.updateOne({ key: 'main' }, { $pull: { requests: { nodeId } } });
  return { ...out, approvedBy: r.approvedBy, request: r };
}

/** الجهاز المنضم الذي أثبت هويته بسرّه — أو null. */
async function proven(nodeId, proof) {
  const d = await doc();
  const n = d.nodes.find((x) => x.nodeId === String(nodeId || ''));
  return n && proof && sameHash(sha(proof), n.proofHash) ? n : null;
}

/** الطلبات للعرض في اللوحة (المنتظرة والمرفوضة). */
const requestsView = (requests) => (requests || []).filter((r) => r.status !== 'approved').map((r) => ({
  nodeId: r.nodeId, name: r.name, machine: r.machine, requestedBy: r.requestedBy, requestedAt: r.requestedAt,
  lastSeen: r.lastSeen, status: r.status,
}));

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

module.exports = { join, heartbeat, remove, view, issueOf, peersFor, request, decide, claim, requestsView, proven, sha, ID_RX };
