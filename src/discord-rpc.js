// Discord Rich Presence über die lokale IPC-Pipe des Discord-Clients (ohne externe Bibliothek).
// Zeigt frei konfigurierbare Live-Stats eines 24fire-Servers im Discord-Profil.
const net = require('net');
const crypto = require('crypto');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const UPDATE_MS = 15000; // Discord erlaubt max. 5 Updates pro 20 s
const CACHE_MS = 5 * 60000;

// Eigene Discord-Application von Fire Desktop (öffentliche ID, kein Geheimnis; ein Client-Secret wird für RPC nicht gebraucht)
const CLIENT_ID = '1563152980948156436';

const DEFAULTS = {
  enabled: false,
  server: 'active', // 'active' | 'all' | Server-ID
  type: 0, // 0 Spielt, 2 Hört, 3 Schaut, 5 Tritt an
  details: '{name} · {status}',
  state: 'CPU {cpu} · RAM {ram}/{ram_max}',
  largeImage: 'fire_desktop',
  largeText: 'Fire Desktop · 24fire',
  smallImage: '',
  smallText: '{status} · {uptime}',
  timer: 'uptime', // 'uptime' | 'app' | 'none'
  buttons: [],
};

const PLACEHOLDERS = {
  name: 'Servername',
  status: 'Online / Offline',
  cpu: 'CPU-Last',
  ram: 'RAM belegt',
  ram_max: 'RAM gesamt',
  ram_pct: 'RAM in %',
  disk: 'Speicher belegt',
  disk_max: 'Speicher gesamt',
  uptime: 'Laufzeit',
  traffic: 'Traffic im Monat',
  traffic_max: 'Traffic-Limit',
  cores: 'CPU-Kerne',
  os: 'Betriebssystem',
  servers: 'Anzahl Server',
  online: 'Server online',
};

function fmtUptime(sec) {
  if (!sec) return '–';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

const gb = (v) => `${Number(v).toFixed(v >= 100 ? 0 : 1).replace(/\.0$/, '')} GB`;

module.exports = function createDiscordRpc(d) {
  let sock = null;
  let ready = false;
  let user = null;
  let lastError = '';
  let buffer = Buffer.alloc(0);
  let updateTimer = null;
  let reconnectTimer = null;
  let lastActivityJson = '';
  let activeServerId = null;
  const appStart = Date.now();
  const cache = new Map(); // `${id}:${what}` -> { at, data }

  // ---------- Einstellungen ----------
  function settings() {
    const c = d.loadStore().discord || {};
    return { ...DEFAULTS, ...c, buttons: Array.isArray(c.buttons) ? c.buttons : [] };
  }

  function saveSettings(patch) {
    const store = d.loadStore();
    store.discord = { ...(store.discord || {}), ...patch };
    d.saveStore(store);
  }

  // ---------- Pipe-Protokoll ----------
  function send(op, payload) {
    if (!sock) return;
    const data = Buffer.from(JSON.stringify(payload));
    const header = Buffer.alloc(8);
    header.writeUInt32LE(op, 0);
    header.writeUInt32LE(data.length, 4);
    sock.write(Buffer.concat([header, data]));
  }

  function onData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 8) {
      const op = buffer.readUInt32LE(0);
      const len = buffer.readUInt32LE(4);
      if (buffer.length < 8 + len) return;
      let msg = null;
      try { msg = JSON.parse(buffer.subarray(8, 8 + len).toString('utf8')); } catch { /* ignorieren */ }
      buffer = buffer.subarray(8 + len);
      handle(op, msg);
    }
  }

  function handle(op, msg) {
    if (op === OP.PING) return send(OP.PONG, msg);
    if (op === OP.CLOSE) {
      lastError = msg?.message || 'Discord hat die Verbindung geschlossen';
      return disconnect(false);
    }
    if (op !== OP.FRAME || !msg) return;
    if (msg.evt === 'READY') {
      ready = true;
      lastError = '';
      user = msg.data?.user ? (msg.data.user.global_name || msg.data.user.username) : null;
      lastActivityJson = '';
      notify();
      update();
    } else if (msg.evt === 'ERROR') {
      lastError = msg.data?.message || 'Fehler von Discord';
      notify();
    }
  }

  function tryPipe(i) {
    return new Promise((resolve) => {
      const s = net.createConnection(`\\\\?\\pipe\\discord-ipc-${i}`);
      s.once('connect', () => resolve(s));
      s.once('error', () => resolve(null));
    });
  }

  async function connect() {
    const st = settings();
    if (!st.enabled || sock) return;
    let s = null;
    for (let i = 0; i < 10 && !s; i++) s = await tryPipe(i);
    if (!s) {
      lastError = 'Discord läuft nicht (Desktop-App starten)';
      notify();
      scheduleReconnect();
      return;
    }
    sock = s;
    buffer = Buffer.alloc(0);
    sock.on('data', onData);
    sock.on('close', () => disconnect(true));
    sock.on('error', () => {});
    send(OP.HANDSHAKE, { v: 1, client_id: CLIENT_ID });
  }

  function disconnect(reconnect) {
    if (sock) { sock.removeAllListeners('close'); sock.destroy(); }
    sock = null;
    ready = false;
    user = null;
    notify();
    if (reconnect) scheduleReconnect();
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    if (settings().enabled) reconnectTimer = setTimeout(connect, 20000);
  }

  // ---------- Stats ----------
  async function cached(s, what, fn) {
    const k = `${s.id}:${what}`;
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
    const data = await fn().catch(() => hit?.data ?? null);
    cache.set(k, { at: Date.now(), data });
    return data;
  }

  async function api(s, apiPath) {
    const apiKey = d.decryptKey(s.key);
    if (apiKey === null) throw new Error('key');
    const res = await d.request({ provider: s.provider, apiKey, env: s.env, method: 'GET', path: d.resolvePath(s, apiPath) });
    if (!res.ok) throw new Error(res.error);
    return res.data;
  }

  async function serverVars(s) {
    const [status, cfg, traffic] = await Promise.all([
      api(s, '/vm/:vmid/status').catch(() => null),
      cached(s, 'config', () => api(s, '/vm/:vmid/config')),
      cached(s, 'traffic', () => api(s, '/vm/:vmid/traffic/current')),
    ]);
    const c = cfg?.config || {};
    const u = status?.usage || {};
    const memRaw = parseFloat(u.mem?.data) || 0;
    // Konfig in MB; Status-RAM je nach Host in MB oder GB (siehe Übersicht)
    const memGB = (u.mem?.unit || '').toUpperCase() === 'GB' || (c.mem && memRaw < c.mem / 64) ? memRaw : memRaw / 1024;
    const memMaxGB = c.mem ? c.mem / 1024 : 0;
    const online = status?.status === 'running';
    const limit = (traffic?.limit?.monthly || 0) + (traffic?.limit?.additional || 0);
    return {
      vars: {
        name: s.name,
        status: !status ? 'Unbekannt' : online ? 'Online' : 'Offline',
        cpu: `${(parseFloat(u.cpu?.data) || 0).toFixed(1)}%`,
        ram: gb(memGB),
        ram_max: memMaxGB ? gb(memMaxGB) : '?',
        ram_pct: memMaxGB ? `${Math.round((memGB / memMaxGB) * 100)}%` : '?',
        disk: gb(parseFloat(u.nvme_storage?.data) || 0),
        disk_max: c.disk ? gb(c.disk) : '?',
        uptime: online ? fmtUptime(status.uptime) : '–',
        traffic: traffic?.usage ? gb(traffic.usage.total) : '?',
        traffic_max: limit ? gb(limit) : '∞',
        cores: String(c.cores ?? '?'),
        os: c.os?.displayname || '?',
      },
      online,
      uptime: online ? status.uptime : 0,
    };
  }

  async function collect() {
    const st = settings();
    const servers = d.loadStore().servers;
    const statuses = await Promise.all(servers.map((s) => api(s, '/vm/:vmid/status').catch(() => null)));
    const onlineCount = statuses.filter((x) => x?.status === 'running').length;
    const base = { servers: String(servers.length), online: String(onlineCount) };

    const id = st.server === 'active' ? activeServerId : st.server;
    const s = st.server === 'all' ? null
      : (servers.find((x) => x.id === id) || servers.find((x) => d.decryptKey(x.key) !== null) || servers[0]);
    if (!s) return { vars: { ...base, name: `${servers.length} Server`, status: `${onlineCount}/${servers.length} online` }, uptime: 0 };
    const r = await serverVars(s);
    return { vars: { ...base, ...r.vars }, uptime: r.uptime };
  }

  const fill = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)).trim();
  // Discord verlangt 2–128 Zeichen
  const field = (t) => (t.length === 0 ? undefined : (t.length < 2 ? `${t} ` : t.slice(0, 128)));

  async function buildActivity() {
    const st = settings();
    const { vars, uptime } = await collect();
    const activity = {
      type: [0, 2, 3, 5].includes(Number(st.type)) ? Number(st.type) : 0,
      details: field(fill(st.details, vars)),
      state: field(fill(st.state, vars)),
      assets: {},
    };
    if (st.largeImage) { activity.assets.large_image = st.largeImage.trim(); activity.assets.large_text = field(fill(st.largeText, vars)); }
    if (st.smallImage) { activity.assets.small_image = st.smallImage.trim(); activity.assets.small_text = field(fill(st.smallText, vars)); }
    if (!Object.keys(activity.assets).length) delete activity.assets;
    if (st.timer === 'uptime' && uptime) activity.timestamps = { start: Date.now() - uptime * 1000 };
    if (st.timer === 'app') activity.timestamps = { start: appStart };
    const buttons = st.buttons.filter((b) => b?.label && /^https:\/\//.test(b.url || '')).slice(0, 2)
      .map((b) => ({ label: fill(b.label, vars).slice(0, 32), url: b.url }));
    if (buttons.length) activity.buttons = buttons;
    return { activity, vars };
  }

  async function update() {
    if (!ready) return;
    try {
      const { activity } = await buildActivity();
      // Laufzeit-Timer nicht jedes Mal neu setzen (Sekunden-Jitter), nur bei echten Änderungen
      const cmp = JSON.stringify({ ...activity, timestamps: activity.timestamps ? Math.round(activity.timestamps.start / 60000) : null });
      if (cmp === lastActivityJson) return;
      lastActivityJson = cmp;
      send(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity }, nonce: crypto.randomUUID() });
    } catch (err) {
      lastError = err.message;
      notify();
    }
  }

  function clearActivity() {
    if (ready) send(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid }, nonce: crypto.randomUUID() });
  }

  function status() {
    const st = settings();
    return {
      settings: st,
      connected: ready,
      user,
      error: lastError,
      placeholders: PLACEHOLDERS,
    };
  }

  function notify() { d.send('discord:changed', status()); }

  async function start() {
    clearInterval(updateTimer);
    clearTimeout(reconnectTimer);
    const st = settings();
    if (!st.enabled) {
      clearActivity();
      disconnect(false);
      lastError = '';
      notify();
      return;
    }
    if (!sock) await connect();
    else { lastActivityJson = ''; update(); }
    updateTimer = setInterval(update, UPDATE_MS);
  }

  return {
    start,
    status,
    async update(patch) {
      saveSettings(patch);
      lastActivityJson = '';
      await start();
      return status();
    },
    setActiveServer(id) {
      if (id === activeServerId) return;
      activeServerId = id;
      lastActivityJson = '';
      update();
    },
    async preview() {
      try { return { ok: true, ...(await buildActivity()) }; } catch (err) { return { ok: false, error: err.message }; }
    },
    stop() { clearActivity(); disconnect(false); clearInterval(updateTimer); clearTimeout(reconnectTimer); },
  };
};
