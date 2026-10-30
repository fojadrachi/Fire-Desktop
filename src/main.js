const { app, BrowserWindow, ipcMain, safeStorage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Client: SshClient } = require('ssh2');

// Zwei APIs: die 24fire-Kunden-API (Key aus dem Control Panel) und die Reseller-FireAPI
const PROVIDERS = {
  '24fire': {
    base: () => 'https://api.24fire.de',
    prefix: (sid) => `/v1/servers/${encodeURIComponent(sid)}`,
    listPath: '/v1/servers',
  },
  fireapi: {
    base: (env) => (env === 'sandbox' ? 'https://sandbox.fireapi.de' : 'https://live.fireapi.de'),
    prefix: (sid) => `/vm/${encodeURIComponent(sid)}`,
    listPath: '/vm/list',
  },
};

const storeFile = () => path.join(app.getPath('userData'), 'servers.json');

// ---------- Speicher (API-Keys werden mit Windows-DPAPI verschlüsselt) ----------

function encryptKey(key) {
  if (safeStorage.isEncryptionAvailable()) {
    return { enc: true, value: safeStorage.encryptString(key).toString('base64') };
  }
  return { enc: false, value: key };
}

// Liefert null, wenn der Wert nicht mehr entschlüsselt werden kann (z. B. geänderter Windows-Schlüssel)
function decryptKey(stored) {
  if (!stored) return '';
  if (!stored.enc) return stored.value;
  try {
    return safeStorage.decryptString(Buffer.from(stored.value, 'base64'));
  } catch (err) {
    console.error('Entschlüsseln fehlgeschlagen:', err.message);
    return null;
  }
}

const KEY_BROKEN = 'Der gespeicherte API-Key kann nicht mehr entschlüsselt werden. Bitte über ⋯ → „API-Key ändern“ neu eingeben.';

// Ältere Einträge (nur FireAPI, mit vmid) auf das neue Format bringen
function normalize(s) {
  if (!s.provider) s.provider = 'fireapi';
  if (s.sid === undefined) s.sid = String(s.vmid);
  return s;
}

function loadStore() {
  try {
    const store = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    store.servers = (store.servers || []).map(normalize);
    return store;
  } catch {
    return { servers: [] };
  }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  fs.writeFileSync(storeFile(), JSON.stringify(store, null, 2));
}

// Renderer bekommt die Server ohne API-Key
function publicServer(s) {
  return {
    id: s.id,
    name: s.name,
    provider: s.provider,
    sid: s.sid,
    env: s.env,
    keyHint: s.keyHint,
    keyOk: decryptKey(s.key) !== null,
    hasSshPass: !!s.sshPass && decryptKey(s.sshPass) !== null,
    createdAt: s.createdAt,
  };
}

// ---------- 24fire REST API v1 (seit 29.10.2026) ----------

// Die App spricht intern die bisherigen Pfade; hier werden sie auf die neuen Endpunkte abgebildet
function map24fire(method, apiPath, params) {
  const m = /^(\/v1\/servers\/[^/]+)\/(.+)$/.exec(apiPath);
  if (!m) return { method, path: apiPath, params };
  const [, base, rest] = m;
  const backup = encodeURIComponent(params?.backup_id ?? '');
  switch (rest) {
    case 'traffic/current': return { method, path: `${base}/traffic`, params, kind: 'traffic' };
    case 'novnc': return { method: 'POST', path: `${base}/console`, kind: 'console' };
    case 'monitoring/timings': return { method: 'GET', path: `${base}/monitoring`, kind: 'timings' };
    case 'monitoring/incidences': return { method: 'GET', path: `${base}/monitoring`, kind: 'incidences' };
    case 'backup/list': return { method: 'GET', path: `${base}/backups`, kind: 'backups' };
    case 'backup/create': return { method: 'POST', path: `${base}/backups`, params };
    case 'backup/restore': return { method: 'POST', path: `${base}/backups/${backup}/restore` };
    case 'backup/delete': return { method: 'DELETE', path: `${base}/backups/${backup}` };
    case 'status': return { method, path: apiPath, params, kind: 'status' };
    case 'config': return { method, path: apiPath, params, kind: 'config' };
    default: return { method, path: apiPath, params };
  }
}

// Bringt die Antworten in die Form, mit der Oberfläche und Claude-Tools arbeiten
function normalize24fire(kind, d) {
  if (d == null || typeof d !== 'object') return d;
  switch (kind) {
    case 'status':
      return { ...d, status: d.status ?? d.state ?? d.power_state, uptime: d.uptime ?? 0, task: d.task ?? null };
    case 'config':
      return d.config ? d : { identifier: d.identifier ?? d.id, hostsystem: d.hostsystem, max_config: d.max_config, abuse_status: d.abuse_status, config: d };
    case 'timings':
      return { timings: d.timings ?? d.measurements ?? (Array.isArray(d) ? d : []) };
    case 'incidences':
      return { statistic: d.statistic ?? d.statistics, incidences: d.incidences ?? d.incidents ?? [] };
    case 'backups':
      return (Array.isArray(d) ? d : d.backups ?? d.list ?? []).map((b) => ({
        ...b,
        backup_id: b.backup_id ?? b.id,
        backup_description: b.backup_description ?? b.description ?? '',
        backup_os: b.backup_os ?? b.os,
        created: b.created ?? b.created_at,
      }));
    case 'console':
      return { ...d, link: d.link ?? d.url ?? d.console_url };
    default:
      return d;
  }
}

const FIRE_ERRORS = {
  unauthorized: 'Token ungültig oder abgelaufen. Seit der 24fire-Umstellung gelten alte API-Keys nicht mehr: unter cp.24fire.de → Kontoeinstellungen → API-Keys einen neuen Token erstellen und in Fire Desktop über ⋯ → „API-Key ändern“ eintragen.',
  insufficient_scope: 'Dem Token fehlt die nötige Berechtigung (Scope). Bitte in den 24fire-Kontoeinstellungen einen Token mit den passenden Scopes erstellen.',
  ip_not_allowed: 'Deine aktuelle IP ist für diesen Token nicht freigegeben (IP-Allowlist des Tokens prüfen).',
  too_many_requests: 'Zu viele Anfragen – bitte kurz warten.',
  upstream_error: '24fire meldet einen Fehler im Hintergrundsystem. Bitte später erneut versuchen.',
};

// ---------- HTTP ----------

async function request({ provider, apiKey, env, method, path: apiPath, params }) {
  const p = PROVIDERS[provider] || PROVIDERS['24fire'];
  const fire = provider !== 'fireapi';
  const mapped = fire ? map24fire(method, apiPath, params) : { method, path: apiPath, params };
  ({ method, params } = mapped);
  const url = new URL(mapped.path, p.base(env));
  const init = {
    method,
    headers: fire
      ? { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
      : { 'X-FIRE-APIKEY': apiKey, Accept: 'application/json' },
  };
  if (params && Object.keys(params).length) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') body.append(k, String(v));
    }
    if (method === 'GET') {
      url.search = body.toString();
    } else {
      init.body = body.toString();
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }

  const started = Date.now();
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    return { ok: false, httpStatus: 0, ms: Date.now() - started, error: `Netzwerkfehler: ${err.message}` };
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keine JSON-Antwort */ }

  const ok = res.ok && (!json || json.status === 'success');
  let error = null;
  if (!ok) {
    error = (json && (json.message || json.error)) || `HTTP ${res.status}`;
    if (fire && FIRE_ERRORS[json?.type]) error = FIRE_ERRORS[json.type];
    if (!fire && json?.type === 'authorization_failed') error = 'FireAPI-Key ungültig. Für normale 24fire-Kunden „24fire Kundenkonto“ wählen.';
  }
  return {
    ok,
    httpStatus: res.status,
    ms: Date.now() - started,
    url: url.toString(),
    data: json ? (fire ? normalize24fire(mapped.kind, json.data) : json.data) : null,
    meta: json ? json.meta : null,
    message: json ? json.message : null,
    type: json ? json.type : null,
    raw: json ?? text,
    error,
  };
}

function getServer(id) {
  const s = loadStore().servers.find((x) => x.id === id);
  if (!s) throw new Error('Server nicht gefunden');
  return s;
}

// "/vm/:vmid/xyz" → Pfad des jeweiligen Anbieters, ":id" → Server-ID
function resolvePath(s, apiPath) {
  const prefix = PROVIDERS[s.provider].prefix(s.sid);
  return apiPath
    .replace(/^\/vm\/:vmid/, prefix)
    .replace(/:vmid|:id|:internal_id/g, encodeURIComponent(s.sid));
}

// ---------- IPC: Server ----------

ipcMain.handle('servers:list', () => loadStore().servers.map(publicServer));

// Prüft einen Key und liefert die damit erreichbaren KVM-Server
ipcMain.handle('servers:probe', async (_e, { apiKey, provider, env }) => {
  const res = await request({ provider, apiKey: apiKey.trim(), env, method: 'GET', path: PROVIDERS[provider].listPath });
  if (!res.ok) return res;
  let list;
  if (provider === '24fire') {
    const rows = [...(res.data || [])];
    for (let page = 2; page <= (res.meta?.last_page || 1); page++) {
      const more = await request({ provider, apiKey: apiKey.trim(), env, method: 'GET', path: PROVIDERS[provider].listPath, params: { page } });
      if (!more.ok) return more;
      rows.push(...(more.data || []));
    }
    list = rows.map((k) => ({
      sid: k.id,
      name: k.name || 'KVM',
      spec: [k.type, k.renew_date ? `verlängert sich am ${new Date(k.renew_date).toLocaleDateString('de-DE')}` : ''].filter(Boolean).join(' · '),
    }));
  } else {
    list = (res.data?.list || []).map((vm) => ({
      sid: String(vm.vmid),
      name: `VM ${vm.vmid}`,
      spec: `${vm.config?.cores ?? '?'} Kerne · ${vm.config?.mem ?? '?'} MB RAM · ${vm.config?.disk ?? '?'} GB · ${vm.node || ''}`,
    }));
  }
  return { ...res, list };
});

ipcMain.handle('servers:add', (_e, { name, apiKey, provider, env, sid }) => {
  const store = loadStore();
  const key = apiKey.trim();
  const server = {
    id: crypto.randomUUID(),
    name: name?.trim() || 'KVM',
    provider: provider === 'fireapi' ? 'fireapi' : '24fire',
    sid: String(sid).trim(),
    env: env === 'sandbox' ? 'sandbox' : 'live',
    key: encryptKey(key),
    keyHint: key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '••••',
    createdAt: new Date().toISOString(),
  };
  store.servers.push(server);
  saveStore(store);
  return publicServer(server);
});

ipcMain.handle('servers:rename', (_e, { id, name }) => {
  const store = loadStore();
  const s = store.servers.find((x) => x.id === id);
  if (s) { s.name = name.trim() || s.name; saveStore(store); }
  return store.servers.map(publicServer);
});

ipcMain.handle('servers:remove', (_e, id) => {
  const store = loadStore();
  store.servers = store.servers.filter((x) => x.id !== id);
  saveStore(store);
  return store.servers.map(publicServer);
});

ipcMain.handle('servers:reorder', (_e, ids) => {
  const store = loadStore();
  store.servers.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  saveStore(store);
  return store.servers.map(publicServer);
});

ipcMain.handle('api:call', async (_e, { serverId, method, path: apiPath, params }) => {
  let s;
  try { s = getServer(serverId); } catch (err) { return { ok: false, error: err.message }; }
  const apiKey = decryptKey(s.key);
  if (apiKey === null) return { ok: false, type: 'key_broken', error: KEY_BROKEN };
  return request({
    provider: s.provider,
    apiKey,
    env: s.env,
    method,
    path: resolvePath(s, apiPath),
    params,
  });
});

// Gespeichertes SSH-Passwort für das Formular der Konsole
ipcMain.handle('servers:sshPass', (_e, id) => {
  const s = loadStore().servers.find((x) => x.id === id);
  return s?.sshPass ? decryptKey(s.sshPass) || '' : '';
});

// API-Key eines Servers ersetzen (wird vorher gegen die API geprüft)
ipcMain.handle('servers:setKey', async (_e, { id, apiKey }) => {
  const store = loadStore();
  const s = store.servers.find((x) => x.id === id);
  if (!s) return { ok: false, error: 'Server nicht gefunden' };
  const key = String(apiKey || '').trim();
  const test = await request({ provider: s.provider, apiKey: key, env: s.env, method: 'GET', path: resolvePath(s, '/vm/:vmid/status') });
  if (!test.ok) return { ok: false, error: test.error };
  s.key = encryptKey(key);
  s.keyHint = key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '••••';
  saveStore(store);
  return { ok: true, servers: store.servers.map(publicServer) };
});

// ---------- IPC: NoVNC (nur FireAPI) ----------

ipcMain.handle('console:open', (_e, { url, title }) => {
  if (!/^https:\/\//.test(url)) return false;
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: title || 'Konsole',
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.loadURL(url);
  return true;
});

// Datenschutz / Nutzungsbedingungen (lokal mitgeliefert)
ipcMain.handle('legal:open', (_e, page) => {
  const file = { datenschutz: 'datenschutz.html', nutzung: 'nutzungsbedingungen.html' }[page];
  if (!file) return;
  const win = new BrowserWindow({
    width: 860,
    height: 820,
    title: page === 'datenschutz' ? 'Datenschutzerklärung' : 'Nutzungsbedingungen',
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'legal', file));
  // Links (Discord-Bedingungen usw.) im Browser öffnen
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (/^(https|mailto):/.test(url)) { e.preventDefault(); shell.openExternal(url); } });
});

ipcMain.handle('shell:openExternal', (_e, url) => {
  if (/^https:\/\//.test(url)) shell.openExternal(url);
});

// ---------- SSH-Verbindungen ----------

// Übersetzt SSH-/Netzwerkfehler in verständliches Deutsch mit wahrscheinlicher Ursache
function sshErrorText(err, host, port) {
  const target = `${host}:${port}`;
  const msg = String(err?.message || err || '');
  if (err?.level === 'client-authentication' || /authentication methods failed/i.test(msg)) {
    return 'Anmeldung abgelehnt: Benutzer oder Passwort stimmen nicht. '
      + 'Prüfe die Zugangsdaten (Konsole → „Zugangsdaten“) – nach einer Neuinstallation oder Passwortänderung im Control Panel ändern sie sich. '
      + 'Manche Server erlauben außerdem keinen Passwort-Login für root (PermitRootLogin / PasswordAuthentication in sshd_config).';
  }
  if (err?.level === 'client-timeout' || /Timed out while waiting for handshake/i.test(msg) || err?.code === 'ETIMEDOUT') {
    return `Zeitüberschreitung: ${target} antwortet nicht. `
      + 'Wahrscheinlich ist der Server gestoppt, startet gerade oder wird neu installiert (Status oben prüfen), '
      + 'oder eine Firewall (ufw/iptables) blockt Port ' + port + '. '
      + 'Über die VNC-Konsole im 24fire Control Panel kommst du trotzdem auf den Server.';
  }
  switch (err?.code) {
    case 'ECONNREFUSED':
      return `Verbindung abgelehnt: ${target} ist erreichbar, aber auf Port ${port} läuft kein SSH. `
        + 'Der SSH-Dienst ist gestoppt (systemctl start ssh) oder läuft auf einem anderen Port – den kannst du unter „Zugangsdaten“ eintragen.';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `Netzwerk nicht erreichbar: Kein Weg zu ${host}. Prüfe deine Internetverbindung oder ob die IP-Adresse stimmt.`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Adresse nicht gefunden: „${host}“ lässt sich nicht auflösen. Prüfe die IP/den Hostnamen unter „Zugangsdaten“.`;
    case 'ECONNRESET':
      return `Verbindung von ${target} getrennt. Häufig durch eine Firewall, fail2ban (zu viele Fehlversuche – IP gesperrt) oder einen überlasteten Server. Kurz warten und erneut versuchen.`;
    default:
      break;
  }
  if (/Connection lost before handshake/i.test(msg)) {
    return `Verbindung zu ${target} vor der Anmeldung abgebrochen. Möglicherweise ist deine IP durch fail2ban gesperrt oder der SSH-Dienst startet gerade neu.`;
  }
  return `SSH-Fehler: ${msg}`;
}

// Baut eine SSH-Verbindung auf; Host-Key wird beim ersten Mal gemerkt, bei Änderung abgebrochen
function openSsh({ serverId, host, port, username, password }) {
  const conn = new SshClient();
  port = Number(port) || 22;
  // Die 24fire-API liefert kein Root-Passwort mehr → das zuletzt funktionierende lokal (verschlüsselt) nutzen
  const known = loadStore().servers.find((x) => x.id === serverId);
  const saved = known?.sshPass ? decryptKey(known.sshPass) : null;
  password = password || saved || undefined;
  if (!password) {
    return Promise.resolve({ ok: false, error: 'Kein SSH-Passwort bekannt. Die neue 24fire-API gibt das Root-Passwort nicht mehr heraus: Trage es einmal in der Konsole unter „Zugangsdaten“ ein, danach merkt sich die App es verschlüsselt.' });
  }
  return new Promise((resolve) => {
    let settled = false;
    let hostKeyError = null;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };

    conn.on('ready', () => {
      if (known && password !== saved) {
        const store = loadStore();
        const s = store.servers.find((x) => x.id === serverId);
        if (s) { s.sshPass = encryptKey(password); saveStore(store); }
      }
      finish({ ok: true, conn });
    });
    conn.on('error', (err) => {
      finish({
        ok: false,
        error: hostKeyError || sshErrorText(err, host, port),
      });
    });
    conn.on('close', () => finish({ ok: false, error: 'Verbindung geschlossen' }));

    conn.connect({
      host,
      port,
      username,
      password,
      readyTimeout: 15000,
      keepaliveInterval: 20000,
      hostVerifier: (key) => {
        const fp = crypto.createHash('sha256').update(key).digest('base64');
        const store = loadStore();
        const s = store.servers.find((x) => x.id === serverId);
        if (!s) return true;
        s.hostKeys = s.hostKeys || {};
        const known = s.hostKeys[`${host}:${port}`];
        if (known && known !== fp) {
          hostKeyError = `Host-Key von ${host} hat sich geändert! Erwartet SHA256:${known}, erhalten SHA256:${fp}. Verbindung abgebrochen.`;
          return false;
        }
        if (!known) { s.hostKeys[`${host}:${port}`] = fp; saveStore(store); }
        return true;
      },
    });
  });
}

// ---------- IPC: SSH-Konsole ----------

const sshSessions = new Map();

ipcMain.handle('ssh:connect', async (e, opts) => {
  const sender = e.sender;
  const sessionId = crypto.randomUUID();
  const send = (ch, ...args) => { if (!sender.isDestroyed()) sender.send(ch, sessionId, ...args); };

  const res = await openSsh(opts);
  if (!res.ok) return res;
  const { conn } = res;
  return new Promise((resolve) => {
    conn.shell({ term: 'xterm-256color', cols: 120, rows: 32 }, (err, stream) => {
      if (err) { conn.end(); return resolve({ ok: false, error: err.message }); }
      sshSessions.set(sessionId, { conn, stream });
      stream.on('data', (d) => send('ssh:data', d.toString('utf8')));
      stream.stderr.on('data', (d) => send('ssh:data', d.toString('utf8')));
      stream.on('close', () => conn.end());
      conn.on('error', (er) => send('ssh:data', `\r\n\x1b[31m${sshErrorText(er, opts.host, opts.port || 22)}\x1b[0m\r\n`));
      conn.on('close', () => { sshSessions.delete(sessionId); send('ssh:closed'); });
      resolve({ ok: true, sessionId });
    });
  });
});

ipcMain.on('ssh:write', (_e, sessionId, data) => sshSessions.get(sessionId)?.stream.write(data));
ipcMain.on('ssh:resize', (_e, sessionId, cols, rows) => sshSessions.get(sessionId)?.stream.setWindow(rows, cols, 0, 0));
ipcMain.on('ssh:close', (_e, sessionId) => sshSessions.get(sessionId)?.conn.end());

// ---------- IPC: Remote (SFTP + Befehle) für Dateimanager und Nginx ----------

const remotes = new Map(); // rid -> { conn, sftp }

// Shell-sicheres Quoting für Pfade in Befehlen
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function remote(rid) {
  const r = remotes.get(rid);
  if (!r) throw new Error('Keine Verbindung – bitte neu verbinden');
  return r;
}

// Wandelt Callback-Methoden von ssh2-SFTP in Promises
const sftpCall = (sftp, method, ...args) =>
  new Promise((resolve, reject) => sftp[method](...args, (err, val) => (err ? reject(err) : resolve(val))));

function execCmd(conn, cmd, timeoutMs = 120000) {
  return new Promise((resolve) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return resolve({ code: -1, stdout: '', stderr: err.message });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { stream.close(); }, timeoutMs);
      stream.on('data', (d) => { stdout += d; });
      stream.stderr.on('data', (d) => { stderr += d; });
      stream.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
    });
  });
}

// Fehler einheitlich als { ok:false, error } zurückgeben
// Event wird als letztes Argument angehängt (für Dialoge und Fortschritt)
const safe = (fn) => async (e, ...args) => {
  try { return { ok: true, ...(await fn(...args, e)) }; } catch (err) { return { ok: false, error: sftpError(err) }; }
};

function sftpError(err) {
  const map = { 2: 'Datei oder Ordner nicht gefunden', 3: 'Keine Berechtigung', 4: 'Vorgang fehlgeschlagen' };
  return map[err?.code] ? `${map[err.code]}${err.message && !/^(No such|Permission|Failure)/.test(err.message) ? ` (${err.message})` : ''}` : (err?.message || String(err));
}

ipcMain.handle('remote:open', async (_e, opts) => {
  const res = await openSsh(opts);
  if (!res.ok) return res;
  const { conn } = res;
  try {
    const sftp = await new Promise((resolve, reject) => conn.sftp((err, s) => (err ? reject(err) : resolve(s))));
    const rid = crypto.randomUUID();
    remotes.set(rid, { conn, sftp });
    conn.on('close', () => remotes.delete(rid));
    const home = await sftpCall(sftp, 'realpath', '.').catch(() => '/');
    return { ok: true, rid, home };
  } catch (err) {
    conn.end();
    return { ok: false, error: `SFTP nicht verfügbar: ${err.message}` };
  }
});

ipcMain.handle('remote:close', (_e, rid) => { remotes.get(rid)?.conn.end(); remotes.delete(rid); });
ipcMain.handle('remote:alive', (_e, rid) => remotes.has(rid));

ipcMain.handle('remote:exec', safe(async (rid, cmd, timeout) => execCmd(remote(rid).conn, cmd, Number(timeout) || 120000)));

const S_IFMT = 0o170000;
const typeOf = (mode) => ({ 0o040000: 'dir', 0o120000: 'link', 0o100000: 'file' }[mode & S_IFMT] || 'other');
function permString(mode) {
  const t = { dir: 'd', link: 'l', file: '-' }[typeOf(mode)] || '?';
  let s = '';
  for (let i = 8; i >= 0; i--) s += (mode & (1 << i)) ? 'rwx'[(8 - i) % 3] : '-';
  return t + s;
}

ipcMain.handle('fs:list', safe(async (rid, dir) => {
  const { sftp } = remote(rid);
  const path = await sftpCall(sftp, 'realpath', dir);
  const list = await sftpCall(sftp, 'readdir', path);
  const entries = await Promise.all(list.map(async (it) => {
    let type = typeOf(it.attrs.mode);
    let target = null;
    if (type === 'link') {
      const full = path.replace(/\/$/, '') + '/' + it.filename;
      target = await sftpCall(sftp, 'readlink', full).catch(() => null);
      const st = await sftpCall(sftp, 'stat', full).catch(() => null);
      type = st ? (typeOf(st.mode) === 'dir' ? 'linkdir' : 'link') : 'link';
    }
    return {
      name: it.filename,
      type,
      target,
      size: it.attrs.size,
      mtime: it.attrs.mtime * 1000,
      perms: permString(it.attrs.mode),
      mode: (it.attrs.mode & 0o7777).toString(8),
      uid: it.attrs.uid,
    };
  }));
  return { path, entries };
}));

const MAX_EDIT = 5 * 1024 * 1024;
ipcMain.handle('fs:read', safe(async (rid, file) => {
  const { sftp } = remote(rid);
  const st = await sftpCall(sftp, 'stat', file);
  if (st.size > MAX_EDIT) throw new Error(`Datei ist zu groß zum Bearbeiten (${(st.size / 1048576).toFixed(1)} MB, max. 5 MB)`);
  const buf = await sftpCall(sftp, 'readFile', file);
  // Binärdateien erkennen: Nullbytes im Anfang
  if (buf.subarray(0, 8000).includes(0)) throw new Error('Binärdatei – bitte herunterladen statt bearbeiten');
  return { text: buf.toString('utf8'), size: st.size };
}));

ipcMain.handle('fs:write', safe(async (rid, file, text) => {
  await sftpCall(remote(rid).sftp, 'writeFile', file, Buffer.from(text, 'utf8'));
  return {};
}));

ipcMain.handle('fs:mkdir', safe(async (rid, dir) => { await sftpCall(remote(rid).sftp, 'mkdir', dir); return {}; }));
ipcMain.handle('fs:touch', safe(async (rid, file) => {
  const { sftp } = remote(rid);
  const exists = await sftpCall(sftp, 'stat', file).then(() => true, () => false);
  if (exists) throw new Error('Datei existiert bereits');
  await sftpCall(sftp, 'writeFile', file, Buffer.alloc(0));
  return {};
}));
ipcMain.handle('fs:rename', safe(async (rid, from, to) => { await sftpCall(remote(rid).sftp, 'rename', from, to); return {}; }));
ipcMain.handle('fs:chmod', safe(async (rid, file, mode) => { await sftpCall(remote(rid).sftp, 'chmod', file, parseInt(mode, 8)); return {}; }));

ipcMain.handle('fs:delete', safe(async (rid, paths) => {
  if (paths.some((p) => !p || p === '/' || !p.startsWith('/'))) throw new Error('Ungültiger Pfad');
  const r = await execCmd(remote(rid).conn, `rm -rf -- ${paths.map(shq).join(' ')}`);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `rm beendet mit Code ${r.code}`);
  return {};
}));

// ---- Übertragungen (mit Gesamtfortschritt, Abbrechen und Taskleisten-Anzeige) ----

const jobs = new Map(); // tid -> Job

function updateTaskbar() {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!win) return;
  const active = [...jobs.values()].filter((j) => j.phase === 'transfer' && j.total > 0);
  if (!active.length) return win.setProgressBar(-1);
  const done = active.reduce((n, j) => n + j.done, 0);
  const total = active.reduce((n, j) => n + j.total, 0);
  win.setProgressBar(Math.min(1, done / total));
}

function createJob(e, tid, direction) {
  const job = {
    tid, direction, sender: e.sender, phase: 'scan', name: '', done: 0, total: 0,
    files: 0, filesDone: 0, canceled: false, current: null, last: 0,
  };
  job.emit = (force) => {
    const now = Date.now();
    if (!force && now - job.last < 150) return;
    job.last = now;
    if (!job.sender.isDestroyed()) {
      job.sender.send('fs:progress', {
        tid, direction, phase: job.phase, name: job.name, done: job.done, total: job.total,
        files: job.files, filesDone: job.filesDone,
      });
    }
    updateTaskbar();
  };
  jobs.set(tid, job);
  return job;
}

function endJob(job) {
  jobs.delete(job.tid);
  updateTaskbar();
}

const canceledError = () => Object.assign(new Error('Abgebrochen'), { canceled: true });

// Lokale Dateien (rekursiv) einsammeln: [{ local, remote, size }]
function scanLocal(local, remoteDir, out, dirs) {
  const name = path.basename(local);
  const target = remoteDir.replace(/\/$/, '') + '/' + name;
  const st = fs.statSync(local);
  if (st.isDirectory()) {
    dirs.push(target);
    for (const child of fs.readdirSync(local)) scanLocal(path.join(local, child), target, out, dirs);
  } else {
    out.push({ local, remote: target, size: st.size });
  }
}

// Entfernte Dateien (rekursiv) einsammeln
async function scanRemote(sftp, remotePath, localTarget, out, dirs, job) {
  if (job.canceled) throw canceledError();
  const st = await sftpCall(sftp, 'stat', remotePath);
  if (typeOf(st.mode) === 'dir') {
    dirs.push(localTarget);
    for (const it of await sftpCall(sftp, 'readdir', remotePath)) {
      await scanRemote(sftp, remotePath.replace(/\/$/, '') + '/' + it.filename, path.join(localTarget, it.filename), out, dirs, job);
    }
  } else {
    out.push({ remote: remotePath, local: localTarget, size: st.size });
    job.files = out.length;
    job.emit();
  }
}

// Eine Datei übertragen; Fortschritt fließt in den Gesamtwert ein
async function transferFile(r, job, file, method) {
  if (job.canceled) throw canceledError();
  job.name = path.basename(file.local);
  const base = job.done;
  job.current = file;
  const [from, to] = method === 'fastPut' ? [file.local, file.remote] : [file.remote, file.local];
  // fastPut/fastGet melden sich nicht zurück, wenn der Kanal geschlossen wird → beim Abbrechen selbst beenden
  await new Promise((resolve, reject) => {
    job.abort = () => reject(canceledError());
    sftpCall(r.sftp, method, from, to, {
      step: (transferred) => { job.done = base + transferred; job.emit(); },
    }).then(resolve, reject);
  });
  job.abort = null;
  job.done = base + file.size;
  job.filesDone += 1;
  job.current = null;
  job.emit();
}

// Beim Abbrechen den SFTP-Kanal schließen (bricht fastPut/fastGet sofort ab) und neu öffnen
async function abortTransfer(rid) {
  const r = remotes.get(rid);
  if (!r) return;
  try { r.sftp.end(); } catch { /* schon zu */ }
  r.sftp = await new Promise((ok, fail) => r.conn.sftp((err, s) => (err ? fail(err) : ok(s)))).catch(() => r.sftp);
}

ipcMain.handle('fs:cancel', async (_e, tid) => {
  const job = jobs.get(tid);
  if (!job || job.canceled) return false;
  job.canceled = true;
  job.phase = 'cancel';
  job.emit(true);
  if (job.current) {
    await abortTransfer(job.rid);
    job.abort?.();
  }
  return true;
});

ipcMain.handle('fs:upload', safe(async (rid, remoteDir, localPaths, tid, e) => {
  const r = remote(rid);
  const job = createJob(e, tid, 'up');
  job.rid = rid;
  try {
    const files = [];
    const dirs = [];
    for (const p of localPaths) scanLocal(p, remoteDir, files, dirs);
    job.files = files.length;
    job.total = files.reduce((n, f) => n + f.size, 0);
    job.phase = 'transfer';
    job.emit(true);
    for (const d of dirs) await sftpCall(r.sftp, 'mkdir', d).catch(() => {});
    for (const f of files) await transferFile(remote(rid), job, f, 'fastPut');
    job.phase = 'done';
    job.emit(true);
    return { count: files.length, bytes: job.total };
  } catch (err) {
    if (job.canceled) {
      // halb hochgeladene Datei entfernen (kurz warten, bis der alte Kanal die Datei freigibt)
      if (job.current) {
        await new Promise((ok) => setTimeout(ok, 300));
        await sftpCall(remote(rid).sftp, 'unlink', job.current.remote).catch(() => {});
      }
      return { canceled: true, count: job.filesDone };
    }
    throw err;
  } finally {
    endJob(job);
  }
}));

ipcMain.handle('fs:pickUpload', async (e, kind) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, {
    title: kind === 'dir' ? 'Ordner hochladen' : 'Dateien hochladen',
    properties: kind === 'dir' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('fs:download', safe(async (rid, remotePaths, tid, e) => {
  const r = remote(rid);
  const win = BrowserWindow.fromWebContents(e.sender);
  let targets;
  if (remotePaths.length === 1) {
    const st = await sftpCall(r.sftp, 'stat', remotePaths[0]);
    const name = path.posix.basename(remotePaths[0]);
    if (typeOf(st.mode) !== 'dir') {
      const d = await dialog.showSaveDialog(win, { title: 'Datei speichern', defaultPath: path.join(app.getPath('downloads'), name) });
      if (d.canceled) return { canceled: true, dialog: true };
      targets = [d.filePath];
    }
  }
  if (!targets) {
    const d = await dialog.showOpenDialog(win, { title: 'Zielordner wählen', defaultPath: app.getPath('downloads'), properties: ['openDirectory', 'createDirectory'] });
    if (d.canceled) return { canceled: true, dialog: true };
    targets = remotePaths.map((p) => path.join(d.filePaths[0], path.posix.basename(p)));
  }

  const job = createJob(e, tid, 'down');
  job.rid = rid;
  try {
    const files = [];
    const dirs = [];
    for (let i = 0; i < remotePaths.length; i++) await scanRemote(r.sftp, remotePaths[i], targets[i], files, dirs, job);
    job.files = files.length;
    job.total = files.reduce((n, f) => n + f.size, 0);
    job.phase = 'transfer';
    job.emit(true);
    for (const d of dirs) fs.mkdirSync(d, { recursive: true });
    for (const f of files) await transferFile(remote(rid), job, f, 'fastGet');
    job.phase = 'done';
    job.emit(true);
    return { target: remotePaths.length === 1 ? targets[0] : path.dirname(targets[0]), count: files.length, bytes: job.total };
  } catch (err) {
    if (job.canceled) {
      if (job.current) {
        await new Promise((ok) => setTimeout(ok, 300));
        try { fs.rmSync(job.current.local, { force: true }); } catch { /* evtl. noch gesperrt */ }
      }
      return { canceled: true, count: job.filesDone };
    }
    throw err;
  } finally {
    endJob(job);
  }
}));

ipcMain.handle('shell:showItem', (_e, p) => shell.showItemInFolder(p));

// Host-Key eines Servers vergessen (z. B. nach Neuinstallation)
ipcMain.handle('ssh:forgetHostKeys', (_e, serverId) => {
  const store = loadStore();
  const s = store.servers.find((x) => x.id === serverId);
  if (s) { delete s.hostKeys; saveStore(store); }
  return true;
});

// ---------- Claude-Integration (MCP) ----------

let mainWindow = null;
const claude = require('./claude-mcp')({
  loadStore,
  saveStore,
  encryptKey,
  decryptKey,
  request,
  resolvePath,
  openSsh,
  execCmd,
  sftpCall,
  typeOf,
  permString,
  shq,
  version: require('../package.json').version,
  logFile: () => path.join(app.getPath('userData'), 'claude-protokoll.jsonl'),
  getWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
  send: (ch, data) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, data); },
});

ipcMain.handle('claude:status', () => claude.status());
ipcMain.handle('claude:update', (_e, patch) => claude.update(patch));
ipcMain.handle('claude:regenToken', () => claude.regenerateToken());
ipcMain.handle('claude:registerCode', () => claude.registerClaudeCode());
ipcMain.on('claude:confirmReply', (_e, id, ok) => claude.answer(id, ok));
ipcMain.handle('claude:auditList', (_e, filter) => claude.auditList(filter));
ipcMain.handle('claude:auditClear', () => { claude.auditClear(); return true; });
ipcMain.handle('claude:auditExport', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const stamp = new Date().toISOString().slice(0, 10);
  const r = await dialog.showSaveDialog(win, {
    title: 'Claude-Protokoll exportieren',
    defaultPath: path.join(app.getPath('documents'), `claude-protokoll-${stamp}.txt`),
    filters: [{ name: 'Text', extensions: ['txt'] }],
  });
  if (r.canceled) return { canceled: true };
  fs.writeFileSync(r.filePath, claude.auditText() || '(leer)');
  shell.showItemInFolder(r.filePath);
  return { ok: true, file: r.filePath };
});

// ---------- Minecraft (RCON + Status) ----------

const minecraft = require('./minecraft')({ loadStore, saveStore, encryptKey, decryptKey, request, resolvePath, openSsh });
const mcSafe = (fn) => async (_e, ...args) => {
  try { return { ok: true, data: await fn(...args) }; } catch (err) { return { ok: false, error: err.message }; }
};
ipcMain.handle('mc:list', () => minecraft.list());
ipcMain.handle('mc:add', mcSafe((input) => minecraft.add(input)));
ipcMain.handle('mc:update', mcSafe((id, input) => minecraft.update(id, input)));
ipcMain.handle('mc:remove', (_e, id) => minecraft.remove(id));
ipcMain.handle('mc:status', mcSafe((id) => minecraft.status(id)));
ipcMain.handle('mc:command', mcSafe((id, cmd) => minecraft.command(id, cmd)));
ipcMain.handle('mc:test', mcSafe((input, existingId) => minecraft.test(input, existingId)));
ipcMain.handle('mc:connected', (_e, id) => minecraft.rconConnected(id));

// ---------- Discord Rich Presence ----------

const discord = require('./discord-rpc')({
  loadStore,
  saveStore,
  decryptKey,
  request,
  resolvePath,
  send: (ch, data) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, data); },
});

ipcMain.handle('discord:status', () => discord.status());
ipcMain.handle('discord:update', (_e, patch) => discord.update(patch));
ipcMain.handle('discord:preview', () => discord.preview());
ipcMain.on('discord:active', (_e, id) => discord.setActiveServer(id));

// ---------- App-Updates ----------

const updater = require('./updater')({
  version: require('../package.json').version,
  send: (ch, data) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, data); },
  quit: () => app.quit(),
});
const updSafe = (fn) => async () => {
  try { return { ok: true, data: await fn() }; } catch (err) { return { ok: false, error: err.message }; }
};
ipcMain.handle('update:check', updSafe(() => updater.check()));
ipcMain.handle('update:install', updSafe(() => updater.install()));
ipcMain.handle('app:version', () => require('../package.json').version);

// ---------- Fenster ----------

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'Fire Desktop',
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow = win;

  // Externe Links im Standardbrowser öffnen
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  claude.start();
  discord.start();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const { conn } of [...sshSessions.values(), ...remotes.values()]) conn.end();
  claude.stop();
  discord.stop();
  minecraft.stop();
  if (process.platform !== 'darwin') app.quit();
});
