/**
 * البث اللحظي لشركة البراق على /brq/ws (نفس منفذ خادم ديار — يُسجَّل عبر realtimeService.onUpgrade):
 *   wss://<الخادم>/brq/ws?token=<توكن>  — الدور من التوكن نفسه.
 *   • staff  : مستخدمو الإدارة. brq:manage يستقبل كل شيء (السائقين والطلبات والمتاجر)، brq:center تحديثات الكول سنتر
 *   • store  : تحديثات طلباته فقط   • driver : عروضه وتوصيلاته فقط
 */
const { WebSocketServer } = require('ws');
const { resolvePrincipal } = require('./auth');

const WS_PATH = '/brq/ws';
const clients = new Set();
const wss = new WebSocketServer({ noServer: true });
let pinger = null;

function send(c, payload) {
  if (c.ws.readyState === 1) { try { c.ws.send(payload); } catch (_) {} }
}

/** يُمرَّر لـ realtimeService.onUpgrade(WS_PATH, handleUpgrade) في خادم ديار. */
async function handleUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://localhost');
  const p = await resolvePrincipal(url.searchParams.get('token')).catch(() => null);
  if (!p || p.replaced) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const perms = p.perms || [];
    const client = {
      ws, role: p.role, id: p.id, sid: p.sid || '', alive: true,
      admin: !!p.admin, operator: !!p.operator,
      chatMonitor: perms.includes('brq:monitor'),
      chatParty: perms.includes('brq:monitor') || perms.includes('brq:chat'),
      name: p.doc && p.doc.name,
    };
    clients.add(client);
    ws.on('pong', () => { client.alive = true; });
    const drop = () => clients.delete(client);
    ws.on('close', drop);
    ws.on('error', drop);
    ws.send(JSON.stringify({ type: 'hello', role: p.role, at: new Date() }));
  });
  startPinger();
}

function startPinger() {
  if (pinger) return;
  pinger = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { try { c.ws.terminate(); } catch (_) {} clients.delete(c); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch (_) {}
    }
  }, 30000);
  pinger.unref();
}

function toAdmins(message) {
  const payload = JSON.stringify(message);
  for (const c of clients) if (c.admin) send(c, payload);
}
function toStore(storeId, message) {
  const payload = JSON.stringify(message);
  for (const c of clients) if (c.role === 'store' && c.id === String(storeId)) send(c, payload);
}
function toDriver(driverId, message) {
  const payload = JSON.stringify(message);
  for (const c of clients) if (c.role === 'driver' && c.id === String(driverId)) send(c, payload);
}
function toOperators(message) {
  const payload = JSON.stringify(message);
  // من يملك اللوحة يستلمها من toAdmins — لا تكرار
  for (const c of clients) if (c.operator && !c.admin) send(c, payload);
}
function countDriverConnections(driverId) {
  let n = 0;
  for (const c of clients) if (c.role === 'driver' && c.id === String(driverId)) n++;
  return n;
}
function toDriversWhere(filter, message) {
  const payload = JSON.stringify(message);
  for (const c of clients) if (c.role === 'driver' && filter(c.id)) send(c, payload);
}
function toWhere(pred, message) {
  const payload = JSON.stringify(message);
  for (const c of clients) { try { if (pred(c)) send(c, payload); } catch (_) {} }
}
/** جلسة واحدة لكل مستخدم (كما في ديار): دخول جديد يغلق اتصالات أجهزته السابقة. */
function endOtherSessions(userId, keepSid) {
  for (const c of clients) {
    if (c.role !== 'staff' || c.id !== String(userId) || c.sid === keepSid) continue;
    try { c.ws.send(JSON.stringify({ type: 'session.replaced' })); c.ws.close(4001, 'session replaced'); } catch (_) {}
    clients.delete(c);
  }
}

module.exports = {
  WS_PATH, handleUpgrade,
  toAdmins, toStore, toDriver, toOperators, toDriversWhere, toWhere, countDriverConnections, endOtherSessions,
};
