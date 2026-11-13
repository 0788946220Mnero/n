/*
  ديون الشركة والمؤسسون — التركيب على الخادم.
    app: /api/founders (واجهة المؤسسين المستقلة + أقسام اللوحة)
    ws:  /founders/ws (بث لحظي ومكالمات المؤسسين — جلسة منفصلة عن /ws)
*/
const hub = require('./hub');

function mount(app, { realtime } = {}) {
  app.use('/api/founders', require('./routes').router());
  if (realtime && realtime.onUpgrade) realtime.onUpgrade(hub.WS_PATH, hub.handleUpgrade);
}

module.exports = { mount, hub };
