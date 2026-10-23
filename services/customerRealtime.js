/**
 * الاتصال اللحظي لزبائن المنصة: /ws/customer?token=<رمز الزبون>
 *  • ردود فريق العمل و«يكتب الآن…» وعلامات القراءة تصل فوراً بلا انتظار التحديث الدوري.
 *  • الدردشة العامة: الرسائل الجديدة والحذف وعدد المتصلين لمن فتحها (community.join).
 * منفصل تماماً عن /ws الطاقم: رمز الزبون (type:'customer') لا يفتح اتصال الطاقم ولا العكس.
 */
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const url = require('url');
const mongoose = require('mongoose');

const SECRET = () => process.env.CUSTOMER_JWT_SECRET || process.env.JWT_SECRET;
const clients = new Set(); // { socket, phoneUserId, community, threadId, lastTyping }
let wss = null;
let onlineTimer = null;

const send = (c, payload) => {
  if (!c || !c.socket || c.socket.readyState !== 1) return false;
  try { c.socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload)); return true; } catch (_) { return false; }
};

/** لكل اتصالات زبون (قد يفتح المنصة على أكثر من جهاز). */
function sendToCustomer(phoneUserId, payload) {
  const id = String(phoneUserId); const msg = JSON.stringify(payload); let n = 0;
  clients.forEach((c) => { if (c.phoneUserId === id && send(c, msg)) n++; });
  return n;
}
/** لكل من فتح الدردشة العامة. */
function broadcastCommunity(payload) {
  const msg = JSON.stringify(payload); let n = 0;
  clients.forEach((c) => { if (c.community && send(c, msg)) n++; });
  return n;
}
const communityOnline = () => new Set([...clients].filter((c) => c.community && c.socket.readyState === 1).map((c) => c.phoneUserId)).size;
function announceOnline() {
  clearTimeout(onlineTimer);
  onlineTimer = setTimeout(() => {
    const count = communityOnline();
    broadcastCommunity({ type: 'community.online', count });
    try { require('../controllers/communityController')._notifyModerators({ type: 'community.online', count }); } catch (_) { /* */ }
  }, 1200);
  if (onlineTimer.unref) onlineTimer.unref();
}

async function threadIdOf(c) {
  if (c.threadId) return c.threadId;
  const SupportThread = require('../models/SupportThread');
  const t = await SupportThread.findOne({ phoneUser: c.phoneUserId }).select('_id').lean();
  if (t) c.threadId = String(t._id);
  return c.threadId || null;
}

async function onMessage(c, raw) {
  const s = String(raw);
  if (s.length > 2048) return;
  let m; try { m = JSON.parse(s); } catch (_) { return; }
  if (!m || typeof m.type !== 'string') return;
  if (m.type === 'ping') return send(c, { type: 'pong' });
  if (m.type === 'community.join') { c.community = true; announceOnline(); return send(c, { type: 'community.online', count: communityOnline() }); }
  if (m.type === 'community.leave') { c.community = false; return announceOnline(); }
  if (m.type === 'support.typing') {
    if (Date.now() - (c.lastTyping || 0) < 1500) return;
    c.lastTyping = Date.now();
    const threadId = await threadIdOf(c);
    if (threadId) require('../controllers/supportController')._notifyStaff('support.typing', { threadId, who: 'customer' });
  }
}

async function onConnection(socket, req) {
  const { query } = url.parse(req.url, true);
  let decoded = null;
  try { decoded = jwt.verify(String(query.token || ''), SECRET()); } catch (_) { decoded = null; }
  if (!decoded || decoded.type !== 'customer' || !mongoose.isValidObjectId(decoded.id)) { socket.close(4001, 'unauthorized'); return; }
  try {
    const PhoneUser = require('../models/PhoneUser');
    if (!(await PhoneUser.findById(decoded.id).select('_id').lean())) { socket.close(4002, 'unknown'); return; }
  } catch (_) { socket.close(1011, 'error'); return; }
  if (socket.readyState !== 1) return;
  const c = { socket, phoneUserId: String(decoded.id), community: false, threadId: null, lastTyping: 0 };
  clients.add(c);
  send(c, { type: 'connected' });
  socket.on('message', (raw) => { onMessage(c, raw).catch(() => {}); });
  const gone = () => { if (clients.delete(c) && c.community) announceOnline(); };
  socket.on('close', gone);
  socket.on('error', gone);
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
}

/** يُستدعى من server.js بعد realtimeService.init — يسجّل المسار على نفس خادم HTTP. */
function start() {
  if (wss) return;
  wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  require('./realtimeService').onUpgrade('/ws/customer', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => { onConnection(ws, req).catch(() => { try { ws.close(1011); } catch (_) { /* */ } }); });
  });
  const iv = setInterval(() => {
    wss.clients.forEach((s) => { if (s.isAlive === false) return s.terminate(); s.isAlive = false; try { s.ping(); } catch (_) { /* */ } });
  }, 30000);
  if (iv.unref) iv.unref();
  console.log('🔌 الاتصال اللحظي لزبائن المنصة جاهز على /ws/customer');
}

/** من اتصال الطاقم (/ws): «الطاقم يكتب…» يصل لصاحب المحادثة. */
async function onStaffSocket(staffClient, m) {
  if (!m || m.type !== 'support.typing' || !mongoose.isValidObjectId(m.threadId)) return;
  if (!(staffClient.perms || []).includes('support:reply')) return;
  const SupportThread = require('../models/SupportThread');
  const t = await SupportThread.findById(m.threadId).select('phoneUser').lean();
  if (t) module.exports.sendToCustomer(t.phoneUser, { type: 'support.typing' });
}

module.exports = { start, sendToCustomer, broadcastCommunity, communityOnline, onStaffSocket, _clients: clients };
