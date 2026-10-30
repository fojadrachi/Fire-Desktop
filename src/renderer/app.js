// ================== Zustand ==================
const state = {
  servers: [],
  activeId: null,
  tab: 'overview',
  status: {},        // serverId -> letzter Status
  config: null,      // Konfiguration des aktiven Servers
  traffic: null,     // Traffic des aktiven Servers
  range: 'hour',
  agg: 'avg',
  addProvider: '24fire',
  addEnv: 'live',
  probedKey: '',
  history: [],
  histIdx: -1,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const active = () => state.servers.find((s) => s.id === state.activeId);
const is24 = (s = active()) => s?.provider === '24fire';

// ================== Hilfsfunktionen ==================
function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function fmtUptime(sec) {
  if (!sec) return '–';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${sec % 60}s`;
}

function fmtBytes(b) {
  if (!Number.isFinite(b)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (Math.abs(b) >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '–' : d.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}

function fmtMinutes(min) {
  if (!min) return '0 min';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

function copyBtn(value) {
  return `<button class="copy" data-copy="${esc(value)}" title="Kopieren">⧉</button>`;
}

function serverSub(s) {
  if (s.provider === '24fire') return s.vmid ? `KVM ${s.vmid}` : '24fire KVM';
  return `VM ${s.sid}${s.env === 'sandbox' ? ' · Sandbox' : ''}`;
}

document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-copy]');
  if (c) { navigator.clipboard.writeText(c.dataset.copy); toast('In Zwischenablage kopiert', 'ok'); }
});

// API-Aufruf für den aktiven (oder angegebenen) Server; protokolliert in der API-Konsole
async function api(method, path, params, { serverId = state.activeId, quiet = false } = {}) {
  const res = await window.fire.call(serverId, method, path, params);
  if (!quiet) termLogRequest(method, path, params, res);
  return res;
}

// ================== Dialoge ==================
function dialog({ title, text = '', input = null, okText = 'OK', danger = false }) {
  return new Promise((resolve) => {
    $('#dialogTitle').textContent = title;
    $('#dialogText').textContent = text;
    const inp = $('#dialogInput');
    inp.classList.toggle('hidden', input === null);
    inp.value = input ?? '';
    const ok = $('#dialogOk');
    ok.textContent = okText;
    ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    $('#dialog').classList.remove('hidden');
    if (input !== null) setTimeout(() => { inp.focus(); inp.select(); }, 0);

    const done = (val) => {
      $('#dialog').classList.add('hidden');
      ok.onclick = $('#dialogCancel').onclick = inp.onkeydown = null;
      resolve(val);
    };
    ok.onclick = () => done(input !== null ? inp.value : true);
    $('#dialogCancel').onclick = () => done(null);
    inp.onkeydown = (e) => { if (e.key === 'Enter') ok.click(); if (e.key === 'Escape') done(null); };
  });
}

// ================== Seitenleiste ==================
function renderSidebar() {
  const ul = $('#serverList');
  ul.innerHTML = state.servers.map((s) => {
    const st = state.status[s.id];
    const cls = !st ? '' : st.error ? 'error' : st.task ? 'busy' : st.status === 'running' ? 'running' : 'stopped';
    return `<li class="server-item ${s.id === state.activeId && !state.activeMc ? 'active' : ''}" data-id="${s.id}" draggable="true" title="${esc(st?.error || '')}">
      <span class="dot ${cls}"></span>
      <div class="txt">
        <div class="name">${esc(s.name)}${s.env === 'sandbox' ? '<span class="env-tag">SANDBOX</span>' : ''}</div>
        <div class="sub">${esc(serverSub(s))}</div>
      </div>
    </li>`;
  }).join('');

  const running = state.servers.filter((s) => state.status[s.id]?.status === 'running').length;
  $('#sidebarFoot').textContent = state.servers.length
    ? `${state.servers.length} Server · ${running} online`
    : 'Keine Server';

  // Ist ein Minecraft-Server ausgewählt, bleibt dessen Ansicht sichtbar
  const mcActive = !!state.activeMc;
  $('#emptyState').classList.toggle('hidden', state.servers.length > 0 || mcActive);
  $('#serverView').classList.toggle('hidden', !state.servers.length || mcActive);
}

$('#serverList').addEventListener('click', (e) => {
  const li = e.target.closest('.server-item');
  if (li) selectServer(li.dataset.id);
});

// Drag & Drop zum Sortieren
let dragId = null;
$('#serverList').addEventListener('dragstart', (e) => { dragId = e.target.closest('.server-item')?.dataset.id; });
$('#serverList').addEventListener('dragover', (e) => {
  e.preventDefault();
  $$('.server-item').forEach((el) => el.classList.remove('drag-over'));
  e.target.closest('.server-item')?.classList.add('drag-over');
});
$('#serverList').addEventListener('drop', async (e) => {
  e.preventDefault();
  const target = e.target.closest('.server-item')?.dataset.id;
  if (!dragId || !target || dragId === target) return renderSidebar();
  const ids = state.servers.map((s) => s.id).filter((id) => id !== dragId);
  ids.splice(ids.indexOf(target), 0, dragId);
  state.servers = await window.fire.reorderServers(ids);
  renderSidebar();
});

// ================== Server auswählen ==================
async function selectServer(id) {
  if (state.activeMc) { deselectMc(); if (state.activeId === id) return renderSidebar(); }
  if (state.activeId === id) return;
  sshDisconnect();
  remoteReset();
  state.activeId = id;
  window.fire.discord.setActive(id);
  state.config = null;
  state.traffic = null;
  renderSidebar();
  renderHeader();
  clearOverview();
  termPrompt();
  $('#rangeSeg').classList.toggle('hidden', is24());
  $('#aggSeg').classList.toggle('hidden', is24());
  await refreshActive(true);
  fillSshForm();
  loadTab();
}

function renderHeader() {
  const s = active();
  if (!s) return;
  const st = state.status[s.id];
  $('#srvName').textContent = s.name;

  const pill = $('#srvStatus');
  if (!st) { pill.className = 'pill pill-muted'; pill.textContent = 'Lädt…'; }
  else if (st.error) { pill.className = 'pill pill-muted'; pill.textContent = 'Nicht erreichbar'; }
  else if (st.status === 'running') { pill.className = 'pill pill-ok'; pill.textContent = `Online · ${fmtUptime(st.uptime)}`; }
  else { pill.className = 'pill pill-bad'; pill.textContent = 'Offline'; }

  const task = $('#srvTask');
  task.classList.toggle('hidden', !st?.task);
  task.textContent = st?.task || '';

  const cfg = state.config;
  const ip = cfg?.config?.ipv4?.[0]?.ip_address;
  $('#srvMeta').textContent = [
    cfg?.identifier ? `KVM ${cfg.identifier}` : serverSub(s),
    ip,
    cfg?.config?.os?.displayname,
    s.provider === '24fire' ? '24fire API' : 'FireAPI',
    `Key ${s.keyHint}`,
  ].filter(Boolean).join('  ·  ');
}

// ================== Status / Übersicht ==================
async function fetchStatus(serverId, quiet = true) {
  const res = await api('GET', '/vm/:vmid/status', null, { serverId, quiet });
  state.status[serverId] = res.ok ? { ...res.data, at: Date.now() } : { error: res.error, at: Date.now() };
  return res;
}

let lastErrorToast = '';
async function refreshActive(withConfig = false) {
  const s = active();
  if (!s) return;
  const jobs = [fetchStatus(s.id)];
  if (withConfig || !state.config) {
    jobs.push(api('GET', '/vm/:vmid/config', null, { quiet: true }).then((r) => {
      if (r.ok && state.activeId === s.id) {
        state.config = r.data;
        if (r.data?.identifier && s.vmid !== r.data.identifier) { s.vmid = r.data.identifier; renderSidebar(); }
      }
    }));
    jobs.push(api('GET', '/vm/:vmid/traffic/current', null, { quiet: true }).then((r) => {
      if (state.activeId === s.id) state.traffic = r.ok ? r.data : null;
    }));
  }
  const [statusRes] = await Promise.all(jobs);
  if (state.activeId !== s.id) return;
  // Fehler nur einmal melden, nicht bei jedem Polling
  if (!statusRes.ok && lastErrorToast !== statusRes.error) toast(statusRes.error, 'err');
  lastErrorToast = statusRes.ok ? '' : statusRes.error;
  renderSidebar();
  renderHeader();
  renderOverview();
}

function clearOverview() {
  ['#statCpu', '#statMem', '#statDisk', '#statTraffic'].forEach((s) => ($(s).textContent = '–'));
  ['#barCpu', '#barMem', '#barDisk', '#barTraffic'].forEach((s) => ($(s).style.width = '0'));
  ['#cfgList', '#accessList', '#hostList', '#netList'].forEach((s) => ($(s).innerHTML = ''));
}

function renderOverview() {
  const st = state.status[state.activeId];
  const cfg = state.config;
  const c = cfg?.config;

  if (st && !st.error) {
    const u = st.usage || {};
    const cpu = parseFloat(u.cpu?.data) || 0;
    $('#statCpu').textContent = `${cpu.toFixed(1)} %`;
    $('#barCpu').style.width = `${Math.min(100, cpu)}%`;

    const mem = parseFloat(u.mem?.data) || 0;
    $('#statMem').textContent = `${mem.toFixed(2)} ${u.mem?.unit || ''}`;
    if (c?.mem) {
      // Konfig ist immer MB; die Doku-Beispiele liefern trotz Einheit "MB" teils GB-Werte
      const unit = (u.mem?.unit || 'MB').toUpperCase();
      const memMB = unit === 'GB' || mem < c.mem / 64 ? mem * 1024 : mem;
      $('#barMem').style.width = `${Math.min(100, (memMB / c.mem) * 100)}%`;
      $('#statMem').textContent = `${(memMB / 1024).toFixed(2)} / ${(c.mem / 1024).toFixed(c.mem % 1024 ? 1 : 0)} GB`;
    }

    const disk = parseFloat(u.nvme_storage?.data) || 0;
    $('#statDisk').textContent = `${disk} ${u.nvme_storage?.unit || 'GB'}${c?.disk ? ` / ${c.disk} GB` : ''}`;
    if (c?.disk) $('#barDisk').style.width = `${Math.min(100, (disk / c.disk) * 100)}%`;
  }

  const t = state.traffic;
  if (t?.usage) {
    const limit = (t.limit?.monthly || 0) + (t.limit?.additional || 0);
    $('#statTraffic').textContent = `${Number(t.usage.total).toFixed(1)}${limit ? ` / ${limit}` : ''} GB`;
    if (limit) $('#barTraffic').style.width = `${Math.min(100, (t.usage.total / limit) * 100)}%`;
  }

  if (!c) return;

  const kv = (rows) => rows.filter((r) => r[1] !== undefined && r[1] !== null && r[1] !== '')
    .map(([k, v, raw]) => `<dt>${esc(k)}</dt><dd>${raw ? v : esc(v)}</dd>`).join('');

  $('#cfgList').innerHTML = kv([
    ['Betriebssystem', c.os?.displayname],
    ['Hostname', c.hostname],
    ['CPU-Kerne', c.cores],
    ['Arbeitsspeicher', c.mem ? `${c.mem} MB` : null],
    ['NVMe', c.disk ? `${c.disk} GB` : null],
    ['Speicher', c.storage ? `${c.storage} GB` : null],
    ['Netzwerk', c.network_speed ? `${c.network_speed} Mbit/s` : null],
    ['Backup-Slots', c.backup_slots],
    ['ISO', c.iso?.attached ? c.iso.displayname : null],
    ['Monitoring', c.monitoring ? (c.monitoring.enabled ? `Aktiv (Port ${c.monitoring.port})` : 'Aus') : null],
    ['Traffic', t?.usage ? `↓ ${t.usage.in} GB  ↑ ${t.usage.out} GB${t.limit?.vm_status === 'throttled' ? ' – gedrosselt!' : ''}` : null],
    ['Abuse-Status', cfg.abuse_status],
    ['Preis', cfg.pricings?.monthly != null ? `${Number(cfg.pricings.monthly).toFixed(2)} € / Monat` : null],
  ]);

  const nets = [
    ...(c.ipv4 || []).map((ip) => ({ ...ip, v: 'IPv4' })),
    ...(c.ipv6 || []).map((ip) => ({ ...ip, v: 'IPv6' })),
  ];
  $('#netList').innerHTML = nets.length ? nets.map((n) => `
    <div class="net-row">
      <span class="tag">${n.v}</span>
      <span class="ip">${esc(n.ip_address)}</span>
      ${n.ddos_protection ? `<span class="tag" title="DDoS-Schutz">${esc(n.ddos_protection)}</span>` : ''}
      ${copyBtn(n.ip_address)}
    </div>`).join('') : '<span class="muted">Keine IP-Adressen</span>';

  $('#accessList').innerHTML = kv([
    ['Benutzer', c.username ? `<span class="mono">${esc(c.username)}</span>${copyBtn(c.username)}` : null, true],
    ['Passwort', c.password
      ? `<span class="mono" id="pwText">••••••••••</span>
         <button class="copy" id="pwToggle">Zeigen</button>${copyBtn(c.password)}`
      : null, true],
    ['SSH', c.ipv4?.[0] ? `<span class="mono">ssh ${esc(c.username || 'root')}@${esc(c.ipv4[0].ip_address)}</span>${copyBtn(`ssh ${c.username || 'root'}@${c.ipv4[0].ip_address}`)}` : null, true],
  ]);
  const pt = $('#pwToggle');
  if (pt) pt.onclick = () => {
    const shown = pt.textContent === 'Verbergen';
    $('#pwText').textContent = shown ? '••••••••••' : c.password;
    pt.textContent = shown ? 'Zeigen' : 'Verbergen';
  };

  const h = cfg.hostsystem || {};
  $('#hostList').innerHTML = kv([
    ['Rechenzentrum', h.datacenter?.name],
    ['Standort', [h.datacenter?.city, h.datacenter?.country].filter(Boolean).join(', ')],
    ['Node', h.node],
    ['Prozessor', h.processor],
    ['RAM', h.memory],
    ['SSDs', h.nvme_hard_drives],
  ]);
}

// ================== Power ==================
$$('[data-power]').forEach((b) => b.addEventListener('click', () => power(b.dataset.power)));

async function power(mode) {
  const s = active();
  if (!s) return;
  const label = { start: 'starten', stop: 'stoppen', restart: 'neu starten' }[mode];
  if (mode !== 'start') {
    const ok = await dialog({
      title: `Server ${label}?`,
      text: `„${s.name}“ wird ${mode === 'stop' ? 'hart gestoppt – laufende Prozesse werden beendet' : 'neu gestartet'}.`,
      okText: mode === 'stop' ? 'Stoppen' : 'Neu starten',
      danger: true,
    });
    if (!ok) return;
  }
  $$('[data-power]').forEach((b) => (b.disabled = true));
  const res = await api('POST', '/vm/:vmid/power', { mode });
  $$('[data-power]').forEach((b) => (b.disabled = false));
  if (res.ok) {
    toast({ start: 'Server wird gestartet…', stop: 'Server wird gestoppt…', restart: 'Server wird neu gestartet…' }[mode], 'ok');
    // ein paar schnelle Nachfragen, bis sich der Status ändert
    [1500, 4000, 8000, 15000].forEach((t) => setTimeout(() => refreshActive(), t));
  } else {
    toast(`Fehler: ${res.error}`, 'err');
  }
}

async function changeKey(s) {
  const inp = $('#dialogInput');
  inp.type = 'password';
  const key = await dialog({
    title: `API-Key für „${s.name}“ ändern`,
    text: s.provider === '24fire' ? 'Neuen Token aus cp.24fire.de → Kontoeinstellungen → API-Keys einfügen (Format {id}|cra_…). Er wird vor dem Speichern geprüft.' : 'Neuen FireAPI-Key einfügen. Er wird vor dem Speichern geprüft.',
    input: '',
    okText: 'Prüfen & speichern',
  });
  inp.type = 'text';
  if (!key) return;
  const res = await window.fire.setServerKey(s.id, key);
  if (!res.ok) return toast(`Key abgelehnt: ${res.error}`, 'err');
  state.servers = res.servers;
  lastErrorToast = '';
  toast('API-Key gespeichert', 'ok');
  renderSidebar();
  refreshActive(true);
}

// ================== Server-Menü ==================
$('#serverMenuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#serverMenu').classList.toggle('hidden');
});
document.addEventListener('click', () => $('#serverMenu').classList.add('hidden'));

$('#serverMenu').addEventListener('click', async (e) => {
  const action = e.target.dataset.action;
  const s = active();
  if (!s || !action) return;
  if (action === 'refresh') { await refreshActive(true); loadTab(); toast('Aktualisiert', 'ok'); }
  if (action === 'panel') window.fire.openExternal('https://cp.24fire.de/');
  if (action === 'key') changeKey(s);
  if (action === 'audit') openAudit(s.name);
  if (action === 'rename') {
    const name = await dialog({ title: 'Server umbenennen', input: s.name, okText: 'Speichern' });
    if (name) { state.servers = await window.fire.renameServer(s.id, name); renderSidebar(); renderHeader(); }
  }
  if (action === 'remove') {
    const ok = await dialog({
      title: 'Server entfernen?',
      text: `„${s.name}“ wird nur aus dieser App entfernt (inkl. gespeichertem API-Key). Der Server selbst bleibt unverändert.`,
      okText: 'Entfernen',
      danger: true,
    });
    if (!ok) return;
    sshDisconnect();
    state.servers = await window.fire.removeServer(s.id);
    delete state.status[s.id];
    state.activeId = null;
    renderSidebar();
    if (state.servers[0]) selectServer(state.servers[0].id);
  }
});

// ================== Tabs ==================
$('#tabs').addEventListener('click', (e) => {
  const t = e.target.dataset.tab;
  if (!t) return;
  showTab(t);
});

function showTab(t) {
  state.tab = t;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  $$('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== t));
  loadTab();
}

function loadTab() {
  if (state.tab === 'stats') loadStats();
  if (state.tab === 'backups') loadBackups();
  if (state.tab === 'files') loadFiles();
  if (state.tab === 'nginx') loadNginx();
  if (state.tab === 'terminal') setTimeout(() => $('#termInput').focus(), 0);
  if (state.tab === 'console') setTimeout(() => { fitTerm(); if (ssh.id) term.focus(); }, 0);
}

// ================== Konsole (SSH) ==================
const term = new Terminal({
  fontFamily: '"Cascadia Mono", Consolas, monospace',
  fontSize: 14,
  cursorBlink: true,
  scrollback: 5000,
  theme: {
    background: '#07080c', foreground: '#e8ebf2', cursor: '#ff6a2b', selectionBackground: '#ff6a2b55',
    black: '#151922', red: '#ff5468', green: '#3ddc84', yellow: '#ffc045', blue: '#5aa9ff',
    magenta: '#b49cff', cyan: '#5fd7e6', white: '#e8ebf2', brightBlack: '#5f677b',
  },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open($('#sshTerm'));
const ssh = { id: null, connecting: false };

function fitTerm() {
  if (state.tab !== 'console') return;
  try { fit.fit(); } catch { /* Tab nicht sichtbar */ }
  if (ssh.id) window.fire.ssh.resize(ssh.id, term.cols, term.rows);
}
new ResizeObserver(fitTerm).observe($('#sshTerm'));

term.onData((d) => { if (ssh.id) window.fire.ssh.write(ssh.id, d); });
// Strg+C mit Auswahl kopiert, Strg+V fügt ein
term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown') return true;
  if (e.ctrlKey && e.key === 'c' && term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); return false; }
  if (e.ctrlKey && e.key === 'v') { navigator.clipboard.readText().then((t) => ssh.id && window.fire.ssh.write(ssh.id, t)); return false; }
  return true;
});

window.fire.ssh.onData((id, data) => { if (id === ssh.id) term.write(data); });
window.fire.ssh.onClosed((id) => {
  if (id !== ssh.id) return;
  ssh.id = null;
  term.write('\r\n\x1b[90m── Verbindung getrennt ──\x1b[0m\r\n');
  renderSshState();
});

function fillSshForm() {
  const c = state.config?.config;
  $('#sshHost').value = c?.ipv4?.[0]?.ip_address || '';
  $('#sshPort').value = '22';
  $('#sshUser').value = c?.username || 'root';
  $('#sshPass').value = c?.password || '';
  // Die neue 24fire-API gibt das Root-Passwort nicht mehr aus → lokal gemerktes verwenden
  if (!c?.password && state.activeId) {
    const id = state.activeId;
    window.fire.savedSshPass(id).then((pw) => { if (id === state.activeId && pw) $('#sshPass').value = pw; });
  }
  renderSshState();
}

function renderSshState() {
  const el = $('#sshState');
  el.className = `ssh-state ${ssh.id ? 'on' : ssh.connecting ? 'busy' : ''}`;
  $('#sshStateText').textContent = ssh.id ? 'Verbunden' : ssh.connecting ? 'Verbinde…' : 'Nicht verbunden';
  const host = $('#sshHost').value;
  $('#sshTarget').textContent = host ? `${$('#sshUser').value}@${host}` : '';
  $('#sshConnect').classList.toggle('hidden', !!ssh.id);
  $('#sshConnect').disabled = ssh.connecting;
  $('#sshDisconnect').classList.toggle('hidden', !ssh.id);
}

async function sshConnect() {
  const s = active();
  const host = $('#sshHost').value.trim();
  if (!s || ssh.connecting) return;
  if (!host) { toast('Keine IP bekannt – trage sie unter „Zugangsdaten“ ein.', 'err'); $('#sshSettings').classList.remove('hidden'); return; }
  ssh.connecting = true;
  renderSshState();
  $('#sshPlaceholder').classList.add('hidden');
  term.reset();
  term.write(`\x1b[90mVerbinde mit ${$('#sshUser').value}@${host}:${$('#sshPort').value} …\x1b[0m\r\n`);
  const res = await window.fire.ssh.connect({
    serverId: s.id,
    host,
    port: $('#sshPort').value,
    username: $('#sshUser').value.trim(),
    password: $('#sshPass').value,
  });
  ssh.connecting = false;
  if (res.ok && state.activeId === s.id) {
    ssh.id = res.sessionId;
    fitTerm();
    term.focus();
  } else if (!res.ok) {
    term.write(`\x1b[31m${res.error}\x1b[0m\r\n`);
  }
  renderSshState();
}

function sshDisconnect() {
  if (ssh.id) window.fire.ssh.close(ssh.id);
  ssh.id = null;
  ssh.connecting = false;
  term.reset();
  $('#sshPlaceholder').classList.remove('hidden');
  renderSshState();
}

$('#sshConnect').addEventListener('click', sshConnect);
$('#sshDisconnect').addEventListener('click', sshDisconnect);
$('#sshSettingsBtn').addEventListener('click', () => $('#sshSettings').classList.toggle('hidden'));
['#sshHost', '#sshUser'].forEach((s) => $(s).addEventListener('input', renderSshState));
$('#sshForget').addEventListener('click', async () => {
  await window.fire.ssh.forgetHostKeys(state.activeId);
  toast('Host-Key vergessen – wird beim nächsten Verbinden neu gespeichert.', 'ok');
});

// NoVNC gibt es nur über die Reseller-FireAPI
async function getNovncUrl() {
  const res = await api('POST', '/vm/:vmid/novnc', { ui_title: active()?.name || 'Konsole', ui_language: 'de' });
  if (!res.ok || !res.data?.link) { toast(`NoVNC: ${res.error || 'Kein Link erhalten'}`, 'err'); return null; }
  return res.data.link;
}
$('#novncBtn').addEventListener('click', async () => {
  const url = await getNovncUrl();
  if (url) window.fire.openConsoleWindow(url, `${active()?.name} – NoVNC`);
});

// ================== Statistiken ==================
const charts = {
  cpu: new LineChart($('#chartCpu'), { format: (v) => `${v.toFixed(v < 10 ? 1 : 0)} %` }),
  mem: new LineChart($('#chartMem'), { format: (v) => fmtBytes(v) }),
  net: new LineChart($('#chartNet'), { format: (v) => `${fmtBytes(v)}/s` }),
  disk: new LineChart($('#chartDisk'), { format: (v) => `${fmtBytes(v)}/s` }),
};

$('#rangeSeg').addEventListener('click', (e) => {
  if (!e.target.dataset.range) return;
  state.range = e.target.dataset.range;
  $$('#rangeSeg button').forEach((b) => b.classList.toggle('active', b === e.target));
  loadStats();
});
$('#aggSeg').addEventListener('click', (e) => {
  if (!e.target.dataset.agg) return;
  state.agg = e.target.dataset.agg;
  $$('#aggSeg button').forEach((b) => b.classList.toggle('active', b === e.target));
  loadStats();
});

function loadStats(quiet = false) {
  const fire24 = is24();
  $('#diskCard').classList.toggle('hidden', fire24);
  $('#availCard').classList.toggle('hidden', !fire24);
  $('#chartNetTitle').textContent = fire24 ? 'Ping' : 'Netzwerk';
  $('#statsSource').textContent = fire24 ? 'Messung alle 10 Minuten · letzte 30 Tage' : '';
  return fire24 ? loadMonitoring(quiet) : loadMetrics(quiet);
}

function statsError(msg) {
  $('#statsInfo').textContent = msg;
  Object.values(charts).forEach((c) => c.setData([], []));
}

// 24fire: /monitoring/timings (CPU %, RAM GB, Ping ms) + /monitoring/incidences
async function loadMonitoring(quiet) {
  const id = state.activeId;
  $('#statsInfo').textContent = 'Lädt…';
  const [res, inc] = await Promise.all([
    api('GET', '/vm/:vmid/monitoring/timings', null, { quiet }),
    api('GET', '/vm/:vmid/monitoring/incidences', null, { quiet: true }),
  ]);
  if (id !== state.activeId) return;
  if (!res.ok) {
    statsError(res.error);
  } else {
    const rows = (res.data?.timings || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    const t = rows.map((r) => new Date(r.date).getTime() / 1000);
    charts.cpu.setData(t, [{ label: 'CPU', color: '#ff6a2b', values: rows.map((r) => parseFloat(r.cpu) || 0) }]);
    const memMax = state.config?.config?.mem ? state.config.config.mem * 1024 * 1024 : null;
    charts.mem.fixedMax = memMax;
    charts.mem.setData(t, [{ label: 'Belegt', color: '#5aa9ff', values: rows.map((r) => (parseFloat(r.mem) || 0) * 1024 ** 3) }]);
    charts.net.format = (v) => `${v.toFixed(0)} ms`;
    charts.net.setData(t, [{ label: 'Ping', color: '#3ddc84', values: rows.map((r) => r.ping || 0) }]);
    $('#statsInfo').textContent = `${rows.length} Messpunkte · ${new Date().toLocaleTimeString('de-DE')}`;
  }
  renderIncidents(inc);
}

function renderIncidents(inc) {
  if (!inc.ok) {
    $('#availGrid').innerHTML = `<span class="muted">${esc(inc.error)}</span>`;
    $('#incidentList').innerHTML = '';
    return;
  }
  const st = inc.data?.statistic || {};
  const labels = { LAST_24_HOURS: '24 Stunden', LAST_7_DAYS: '7 Tage', LAST_30_DAYS: '30 Tage' };
  $('#availGrid').innerHTML = Object.entries(labels).filter(([k]) => st[k]).map(([k, l]) => `
    <div class="avail">
      <div class="lbl">${l}</div>
      <div class="val">${Number(st[k].availability).toFixed(2)} %</div>
      <div class="sub">${st[k].incidences} Ausfälle · ${fmtMinutes(st[k].downtime)}</div>
    </div>`).join('');
  const list = (inc.data?.incidences || []).slice(0, 15);
  const types = { PING_TIMEOUT: 'Ping-Timeout', VM_STOPPED: 'VM gestoppt' };
  $('#incidentList').innerHTML = list.length ? list.map((i) => `
    <div class="incident">
      <span class="when">${fmtDate(i.start)}</span>
      <span class="pill ${i.end ? 'pill-muted' : 'pill-bad'}">${esc(types[i.type] || i.type)}</span>
      <span class="muted">${i.end ? fmtMinutes(i.downtime) : 'läuft noch'}</span>
    </div>`).join('') : '<span class="muted">Keine Ausfälle 🎉</span>';
}

// FireAPI: /metrics
async function loadMetrics(quiet) {
  const id = state.activeId;
  $('#statsInfo').textContent = 'Lädt…';
  const res = await api('POST', '/vm/:vmid/metrics', { range: state.range, aggregation: state.agg }, { quiet });
  if (id !== state.activeId) return;
  if (!res.ok) return statsError(res.error);
  const rows = res.data?.timings || [];
  const t = rows.map((r) => r.time);
  charts.cpu.setData(t, [{ label: 'CPU', color: '#ff6a2b', values: rows.map((r) => (r.cpu_usage || 0) * 100) }]);
  charts.mem.fixedMax = rows[0]?.mem_max || null;
  charts.mem.setData(t, [{ label: 'Belegt', color: '#5aa9ff', values: rows.map((r) => r.mem_usage || 0) }]);
  charts.net.format = (v) => `${fmtBytes(v)}/s`;
  charts.net.setData(t, [
    { label: 'Eingehend', color: '#3ddc84', values: rows.map((r) => r.net_in || 0) },
    { label: 'Ausgehend', color: '#ff9a3d', values: rows.map((r) => r.net_out || 0) },
  ]);
  charts.disk.setData(t, [
    { label: 'Lesen', color: '#b49cff', values: rows.map((r) => r.disk_read || 0) },
    { label: 'Schreiben', color: '#ffc045', values: rows.map((r) => r.disk_write || 0) },
  ]);
  $('#statsInfo').textContent = `${rows.length} Messpunkte · ${new Date().toLocaleTimeString('de-DE')}`;
}

// ================== Backups ==================
async function loadBackups() {
  const id = state.activeId;
  const tb = $('#backupRows');
  tb.innerHTML = '<tr><td colspan="6" class="empty-row">Lädt…</td></tr>';
  const res = await api('GET', '/vm/:vmid/backup/list', null, { quiet: true });
  if (id !== state.activeId) return;
  if (!res.ok) { tb.innerHTML = `<tr><td colspan="6" class="empty-row">${esc(res.error)}</td></tr>`; return; }
  const list = (res.data || []).slice().sort((a, b) => new Date(b.created) - new Date(a.created));
  if (!list.length) { tb.innerHTML = '<tr><td colspan="6" class="empty-row">Noch keine Backups</td></tr>'; return; }
  tb.innerHTML = list.map((b) => {
    const pill = b.status === 'finished' ? 'pill-ok' : b.status === 'failed' ? 'pill-bad' : 'pill-warn';
    const statusText = { finished: 'Fertig', failed: 'Fehlgeschlagen', running: 'Läuft', pending: 'Läuft' }[b.status] || b.status;
    return `<tr>
      <td>${fmtDate(b.created)}</td>
      <td>${esc(b.backup_description) || '<span class="muted">–</span>'}</td>
      <td class="mono">${esc(b.backup_os)}</td>
      <td>${b.size != null ? `${Number(b.size).toFixed(0)} MB` : '–'}</td>
      <td><span class="pill ${pill}">${esc(statusText)}</span></td>
      <td class="actions">
        <button class="btn btn-sm btn-ghost" data-restore="${esc(b.backup_id)}" ${b.status !== 'finished' ? 'disabled' : ''}>Wiederherstellen</button>
        <button class="btn btn-sm btn-danger" data-delete="${esc(b.backup_id)}">Löschen</button>
      </td>
    </tr>`;
  }).join('');
}

$('#backupRefresh').addEventListener('click', loadBackups);
$('#backupCreate').addEventListener('click', async () => {
  const description = $('#backupDesc').value.trim();
  const btn = $('#backupCreate');
  btn.disabled = true;
  const res = await api('POST', '/vm/:vmid/backup/create', { description });
  btn.disabled = false;
  if (res.ok) { toast('Backup wird erstellt…', 'ok'); $('#backupDesc').value = ''; loadBackups(); }
  else toast(`Backup: ${res.error}`, 'err');
});

$('#backupRows').addEventListener('click', async (e) => {
  const restore = e.target.dataset.restore;
  const del = e.target.dataset.delete;
  if (restore) {
    const ok = await dialog({
      title: 'Backup wiederherstellen?',
      text: 'Der aktuelle Stand des Servers wird durch dieses Backup ersetzt. Alle Änderungen seit dem Backup gehen verloren.',
      okText: 'Wiederherstellen',
      danger: true,
    });
    if (!ok) return;
    const res = await api('POST', '/vm/:vmid/backup/restore', { backup_id: restore });
    toast(res.ok ? 'Wiederherstellung gestartet' : `Fehler: ${res.error}`, res.ok ? 'ok' : 'err');
    if (res.ok) setTimeout(() => refreshActive(), 2000);
  }
  if (del) {
    const ok = await dialog({
      title: 'Backup löschen?',
      text: 'Ein gelöschtes Backup kann nicht wiederhergestellt werden.',
      okText: 'Endgültig löschen',
      danger: true,
    });
    if (!ok) return;
    const res = await api('DELETE', '/vm/:vmid/backup/delete', { backup_id: del });
    toast(res.ok ? 'Backup gelöscht' : `Fehler: ${res.error}`, res.ok ? 'ok' : 'err');
    loadBackups();
  }
});

// ================== API-Konsole ==================
const termOut = $('#termOut');

function termLine(text, cls = 'l-info') {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  termOut.appendChild(div);
  termOut.scrollTop = termOut.scrollHeight;
  return div;
}

function termHtml(html, cls) {
  const div = document.createElement('div');
  div.className = cls;
  div.innerHTML = html;
  termOut.appendChild(div);
  termOut.scrollTop = termOut.scrollHeight;
}

function highlightJson(obj) {
  const json = esc(JSON.stringify(obj, null, 2));
  return json.replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi, (m, str, colon, bool) => {
    if (str) return colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`;
    if (bool) return `<span class="b">${m}</span>`;
    return `<span class="n">${m}</span>`;
  });
}

function termLogRequest(method, path, params, res) {
  const time = new Date().toLocaleTimeString('de-DE');
  const p = params ? ' ' + Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' ') : '';
  termLine(`[${time}] ${method} ${path}${p}`, 'l-info');
  termLine(`  → ${res.ok ? 'OK' : 'FEHLER'} · HTTP ${res.httpStatus ?? '–'} · ${res.ms ?? '–'} ms${res.message ? ' · ' + res.message : ''}${!res.ok && res.error && res.error !== res.message ? ' · ' + res.error : ''}`, res.ok ? 'l-ok' : 'l-err');
}

function termPrompt() {
  const s = active();
  $('#termPrompt').textContent = s ? `${s.name}>` : 'fire>';
}

const HELP = `Befehle:
  status                 Status des Servers
  config                 Konfiguration anzeigen
  start | stop | restart Server steuern
  traffic                Traffic-Verbrauch des Monats
  monitoring             Letzte Messung (CPU, RAM, Ping)
  incidents              Verfügbarkeit & Ausfälle
  backups                Backups auflisten
  backup [beschreibung]  Neues Backup erstellen
  ssh                    SSH-Konsole öffnen und verbinden
  servers                Gespeicherte Server auflisten
  use <name>             Server wechseln
  GET|POST|PUT|DELETE <pfad> [key=wert …]
                         Beliebiger API-Aufruf. "/vm/:vmid/…" wird auf den
                         Server umgeschrieben, ":id" durch seine ID ersetzt.
                         z. B.  GET /vm/:vmid/traffic/current
                                GET /v1/account         (24fire)
  clear                  Ausgabe leeren
Pfeil hoch/runter: Verlauf`;

async function runCommand(line) {
  const [cmd, ...args] = line.trim().split(/\s+/);
  const lc = (cmd || '').toLowerCase();
  const s = active();
  const needServer = () => { if (!s) termLine('Kein Server ausgewählt.', 'l-err'); return !!s; };
  const show = (res) => { if (res.ok && res.data !== undefined) termHtml(highlightJson(res.data), 'l-json'); };

  switch (lc) {
    case '': return;
    case 'help': case '?': termLine(HELP); return;
    case 'clear': case 'cls': termOut.innerHTML = ''; return;
    case 'servers':
      state.servers.forEach((x) => termLine(`${x.id === state.activeId ? '*' : ' '} ${x.name}  (${serverSub(x)}, ${x.provider})`));
      if (!state.servers.length) termLine('Keine Server gespeichert.');
      return;
    case 'use': {
      const q = args.join(' ').toLowerCase();
      const hit = state.servers.find((x) => x.name.toLowerCase() === q || String(x.vmid) === q || x.sid === q)
        || state.servers.find((x) => x.name.toLowerCase().includes(q));
      if (!hit) return termLine(`Kein Server „${q}“ gefunden.`, 'l-err');
      await selectServer(hit.id);
      termLine(`Gewechselt zu ${hit.name}`, 'l-ok');
      return;
    }
    case 'status': if (needServer()) { const r = await fetchStatus(s.id, false); show(r); renderSidebar(); renderHeader(); renderOverview(); } return;
    case 'config': if (needServer()) show(await api('GET', '/vm/:vmid/config')); return;
    case 'traffic': if (needServer()) show(await api('GET', '/vm/:vmid/traffic/current')); return;
    case 'incidents': if (needServer()) show(await api('GET', '/vm/:vmid/monitoring/incidences')); return;
    case 'backups': if (needServer()) show(await api('GET', '/vm/:vmid/backup/list')); return;
    case 'backup': if (needServer()) show(await api('POST', '/vm/:vmid/backup/create', { description: args.join(' ') })); return;
    case 'start': case 'stop': case 'restart':
      if (needServer()) { const r = await api('POST', '/vm/:vmid/power', { mode: lc }); if (r.ok) [2000, 6000, 12000].forEach((t) => setTimeout(() => refreshActive(), t)); }
      return;
    case 'monitoring': case 'metrics': {
      if (!needServer()) return;
      if (is24()) {
        const r = await api('GET', '/vm/:vmid/monitoring/timings');
        const last = (r.data?.timings || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date)).at(-1);
        if (last) {
          termLine(`  Zeit:   ${fmtDate(last.date)}`);
          termLine(`  CPU:    ${last.cpu} %`);
          termLine(`  RAM:    ${last.mem} GB`);
          termLine(`  Ping:   ${last.ping} ms`);
        }
      } else {
        const r = await api('POST', '/vm/:vmid/metrics', { range: args[0] || 'hour', aggregation: args[1] || 'avg' });
        const last = r.data?.timings?.at(-1);
        if (last) {
          termLine(`  Zeit:   ${new Date(last.time * 1000).toLocaleString('de-DE')}`);
          termLine(`  CPU:    ${(last.cpu_usage * 100).toFixed(2)} %`);
          termLine(`  RAM:    ${fmtBytes(last.mem_usage)} / ${fmtBytes(last.mem_max)}`);
          termLine(`  Netz:   ↓ ${fmtBytes(last.net_in)}/s  ↑ ${fmtBytes(last.net_out)}/s`);
        }
      }
      return;
    }
    case 'ssh': case 'console':
      if (!needServer()) return;
      showTab('console');
      if (!ssh.id) sshConnect();
      return;
  }

  const method = cmd.toUpperCase();
  if (['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
    if (!needServer()) return;
    const path = args[0];
    if (!path || !path.startsWith('/')) return termLine('Pfad fehlt, z. B. GET /vm/:vmid/status', 'l-err');
    const params = {};
    for (const a of args.slice(1)) {
      const i = a.indexOf('=');
      if (i > 0) params[a.slice(0, i)] = a.slice(i + 1);
    }
    const r = await api(method, path, Object.keys(params).length ? params : null);
    if (r.raw !== undefined) termHtml(typeof r.raw === 'string' ? esc(r.raw) : highlightJson(r.raw), 'l-json');
    return;
  }

  termLine(`Unbekannter Befehl „${cmd}“ – „help“ zeigt alle Befehle.`, 'l-err');
}

$('#termForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#termInput');
  const line = input.value;
  input.value = '';
  if (line.trim()) { state.history.push(line); state.histIdx = state.history.length; }
  termLine(line, 'l-cmd');
  input.disabled = true;
  try { await runCommand(line); } catch (err) { termLine(String(err), 'l-err'); }
  input.disabled = false;
  input.focus();
});

$('#termInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' && state.histIdx > 0) {
    e.preventDefault();
    e.target.value = state.history[--state.histIdx];
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    state.histIdx = Math.min(state.history.length, state.histIdx + 1);
    e.target.value = state.history[state.histIdx] || '';
  }
});
$('#terminal').addEventListener('click', () => { if (!window.getSelection().toString()) $('#termInput').focus(); });

// ================== Server hinzufügen ==================
const PROVIDER_HINTS = {
  '24fire': 'Token erstellen: cp.24fire.de → Kontoeinstellungen → API-Keys (Format {id}|cra_…, wird nur einmal angezeigt). Scopes für Server, Power und Backups wählen. Bei einer IP-Allowlist muss deine aktuelle IP erlaubt sein.',
  fireapi: 'Nur für Reseller/Geschäftskunden mit FireAPI-Zugang (fireapi.de). Normale 24fire-Keys funktionieren hier nicht.',
};

function setProvider(p) {
  state.addProvider = p;
  $$('#providerSeg button').forEach((b) => b.classList.toggle('active', b.dataset.provider === p));
  $('#envField').classList.toggle('hidden', p !== 'fireapi');
  $('#providerHint').textContent = PROVIDER_HINTS[p];
  $('#manualSummary').textContent = p === '24fire' ? 'internal_id manuell eintragen' : 'VM-ID manuell eintragen';
  $('#manualVmid').placeholder = p === '24fire' ? 'internal_id (aus der Control-Panel-URL)' : 'z. B. 30071';
}

function openAdd() {
  $('#addKey').value = '';
  $('#addKey').type = 'password';
  $('#toggleKey').textContent = 'Zeigen';
  $('#addError').classList.add('hidden');
  $('#addError2').classList.add('hidden');
  $('#addStep1').classList.remove('hidden');
  $('#addStep2').classList.add('hidden');
  setProvider(state.addProvider);
  $('#addModal').classList.remove('hidden');
  setTimeout(() => $('#addKey').focus(), 0);
}
function closeAdd() { $('#addModal').classList.add('hidden'); state.probedKey = ''; }

$('#addServerBtn').addEventListener('click', openAdd);
$('#emptyAddBtn').addEventListener('click', openAdd);
$$('#addModal [data-close]').forEach((b) => b.addEventListener('click', closeAdd));
$('#toggleKey').addEventListener('click', () => {
  const k = $('#addKey');
  k.type = k.type === 'password' ? 'text' : 'password';
  $('#toggleKey').textContent = k.type === 'password' ? 'Zeigen' : 'Verbergen';
});
$('#providerSeg').addEventListener('click', (e) => { if (e.target.dataset.provider) setProvider(e.target.dataset.provider); });
$('#envSeg').addEventListener('click', (e) => {
  if (!e.target.dataset.env) return;
  state.addEnv = e.target.dataset.env;
  $$('#envSeg button').forEach((b) => b.classList.toggle('active', b === e.target));
});
$('#addKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#addProbe').click(); });

$('#addProbe').addEventListener('click', async () => {
  const key = $('#addKey').value.trim();
  const err = $('#addError');
  err.classList.add('hidden');
  if (!key) { err.textContent = 'Bitte API-Key eingeben.'; err.classList.remove('hidden'); return; }

  const btn = $('#addProbe');
  btn.disabled = true; btn.textContent = 'Prüfe…';
  const res = await window.fire.probeKey(key, state.addProvider, state.addEnv);
  btn.disabled = false; btn.textContent = 'Verbinden';

  // Ungültiger Key: gar nicht erst weiter, sonst landet ein toter Server in der Liste
  if (!res.ok && ['authorization_failed', 'unauthorized', 'ip_not_allowed', 'insufficient_scope'].includes(res.type)) {
    err.textContent = res.error;
    err.classList.remove('hidden');
    return;
  }

  state.probedKey = key;
  const list = res.ok ? res.list || [] : [];
  const known = new Set(state.servers.map((s) => `${s.provider}:${s.env}:${s.sid}`));

  if (!res.ok) {
    $('#vmFoundText').textContent = `Server konnten nicht abgerufen werden (${res.error}). Trage die ID manuell ein.`;
    $('#manualBox').open = true;
  } else if (!list.length) {
    $('#vmFoundText').textContent = 'Mit diesem Key wurden keine KVM-Server gefunden.';
    $('#manualBox').open = true;
  } else {
    $('#vmFoundText').textContent = `${list.length} Server gefunden – wähle aus, welche du hinzufügen willst:`;
    $('#manualBox').open = false;
  }

  $('#vmPick').innerHTML = list.map((vm, i) => {
    const exists = known.has(`${state.addProvider}:${state.addEnv}:${vm.sid}`);
    return `<li><label>
      <input type="checkbox" data-idx="${i}" ${exists ? 'disabled' : 'checked'}>
      <div>
        <div class="vm-id">${esc(vm.name)}${exists ? ' <span class="muted">· bereits hinzugefügt</span>' : ''}</div>
        <div class="vm-spec">${esc(vm.spec || vm.sid)}</div>
      </div>
      <input class="input" data-name-for="${i}" placeholder="Name" value="${esc(vm.name)}" ${exists ? 'disabled' : ''}>
    </label></li>`;
  }).join('');
  state.probedList = list;

  $('#manualVmid').value = '';
  $('#manualName').value = '';
  $('#addStep1').classList.add('hidden');
  $('#addStep2').classList.remove('hidden');
});

$('#vmPick').addEventListener('click', (e) => { if (e.target.matches('[data-name-for]')) e.preventDefault(); });

$('#addBack').addEventListener('click', () => {
  $('#addStep2').classList.add('hidden');
  $('#addStep1').classList.remove('hidden');
});

$('#addConfirm').addEventListener('click', async () => {
  const err = $('#addError2');
  err.classList.add('hidden');
  const picks = $$('#vmPick input[type=checkbox]:checked').map((cb) => ({
    sid: state.probedList[cb.dataset.idx].sid,
    name: $(`[data-name-for="${cb.dataset.idx}"]`).value,
  }));
  const mv = $('#manualVmid').value.trim();
  if (mv) {
    if (state.addProvider === 'fireapi' && !/^\d+$/.test(mv)) { err.textContent = 'Die VM-ID besteht nur aus Ziffern.'; err.classList.remove('hidden'); return; }
    picks.push({ sid: mv, name: $('#manualName').value });
  }
  if (!picks.length) { err.textContent = 'Wähle mindestens einen Server aus.'; err.classList.remove('hidden'); return; }

  let first = null;
  for (const p of picks) {
    const srv = await window.fire.addServer({ ...p, apiKey: state.probedKey, provider: state.addProvider, env: state.addEnv });
    first ??= srv;
  }
  state.servers = await window.fire.listServers();
  closeAdd();
  toast(`${picks.length} Server hinzugefügt`, 'ok');
  renderSidebar();
  pollAll();
  if (first) { state.activeId = null; selectServer(first.id); }
});

// ================== Polling ==================
async function pollAll() {
  await Promise.all(state.servers.filter((s) => s.id !== state.activeId).map((s) => fetchStatus(s.id)));
  renderSidebar();
}

setInterval(() => { if (!document.hidden && state.activeId) refreshActive(); }, 5000);
setInterval(() => { if (!document.hidden) pollAll(); }, 30000);
setInterval(() => { if (!document.hidden && state.tab === 'stats' && state.activeId) loadStats(true); }, 60000);

// ================== Start ==================
// Erst starten, wenn auch remote.js geladen ist
window.addEventListener('DOMContentLoaded', async function init() {
  state.servers = await window.fire.listServers();
  renderSidebar();
  termLine('Fire Desktop – API-Konsole. „help“ zeigt alle Befehle.');
  if (state.servers[0]) {
    selectServer(state.servers[0].id);
    pollAll();
  }
});

document.querySelectorAll('[data-legal]').forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault();
  window.fire.openLegal(a.dataset.legal);
}));
