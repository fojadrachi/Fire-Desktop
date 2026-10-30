// Minecraft-Server: Seitenleiste, Status, RCON-Konsole, Spieler & Steuerung.

const mc = { list: [], status: {}, tab: 'console', history: [], histIdx: -1, editId: null, via: 'ssh', pollTimer: null };
state.activeMc = null;
const activeMc = () => mc.list.find((m) => m.id === state.activeMc);

// ---------- Minecraft-Formatcodes (§) → HTML ----------
const MC_COLORS = {
  0: '#000000', 1: '#0000aa', 2: '#00aa00', 3: '#00aaaa', 4: '#aa0000', 5: '#aa00aa', 6: '#ffaa00', 7: '#aaaaaa',
  8: '#555555', 9: '#5555ff', a: '#55ff55', b: '#55ffff', c: '#ff5555', d: '#ff55ff', e: '#ffff55', f: '#ffffff',
};
function mcFormat(text) {
  let html = '';
  let style = {};
  const open = () => {
    const css = [
      style.color && `color:${style.color}`, style.bold && 'font-weight:700', style.italic && 'font-style:italic',
      (style.underline || style.strike) && `text-decoration:${[style.underline && 'underline', style.strike && 'line-through'].filter(Boolean).join(' ')}`,
    ].filter(Boolean).join(';');
    return css ? `<span style="${css}">` : '<span>';
  };
  for (const part of String(text).split(/(§[0-9a-fk-or])/i)) {
    const m = /^§([0-9a-fk-or])$/i.exec(part);
    if (!m) { if (part) html += `${open()}${esc(part)}</span>`; continue; }
    const c = m[1].toLowerCase();
    if (MC_COLORS[c]) style = { color: MC_COLORS[c] };
    else if (c === 'l') style.bold = true;
    else if (c === 'o') style.italic = true;
    else if (c === 'n') style.underline = true;
    else if (c === 'm') style.strike = true;
    else if (c === 'r') style = {};
  }
  return html;
}
const stripCodes = (t) => String(t || '').replace(/§[0-9a-fk-or]/gi, '');

// ---------- Seitenleiste ----------
async function mcLoad() {
  mc.list = await window.fire.mc.list();
  mcRenderSidebar();
}

function mcRenderSidebar() {
  $('#mcList').innerHTML = mc.list.map((m) => {
    const st = mc.status[m.id];
    const cls = !st ? '' : st.online ? 'running' : 'stopped';
    const sub = st?.online ? `${st.players.online}/${st.players.max} Spieler` : (m.via === 'ssh' ? 'über SSH-Tunnel' : `${m.host}:${m.gamePort}`);
    return `<li class="server-item ${m.id === state.activeMc ? 'active' : ''}" data-mc="${m.id}" title="${esc(st?.error || '')}">
      <span class="dot ${cls}"></span>
      <div class="txt"><div class="name">${esc(m.name)}</div><div class="sub">${esc(sub)}</div></div>
    </li>`;
  }).join('');
  $('#mcEmptyHint').classList.toggle('hidden', mc.list.length > 0);
}

$('#mcList').addEventListener('click', (e) => {
  const li = e.target.closest('[data-mc]');
  if (li) selectMc(li.dataset.mc);
});

function selectMc(id) {
  if (state.activeMc !== id) {
    $('#mcOut').innerHTML = '';
    mc.history = [];
  }
  state.activeMc = id;
  $('#serverView').classList.add('hidden');
  $('#emptyState').classList.add('hidden');
  $('#mcView').classList.remove('hidden');
  renderSidebar();
  mcRenderSidebar();
  mcRenderHeader();
  mcRefresh();
  mcLoadTab();
  clearInterval(mc.pollTimer);
  mc.pollTimer = setInterval(() => { if (!document.hidden) mcRefresh(); }, 15000);
  if (!$('#mcOut').childElementCount) mcLine(`Verbunden mit „${activeMc()?.name}“ über RCON. Befehle ohne „/“ eingeben.`, 'l-info');
}

function deselectMc() {
  state.activeMc = null;
  clearInterval(mc.pollTimer);
  $('#mcView').classList.add('hidden');
  mcRenderSidebar();
}

// ---------- Status ----------
async function mcRefresh(id = state.activeMc) {
  if (!id) return;
  const res = await window.fire.mc.status(id);
  mc.status[id] = res.ok ? res.data : { online: false, error: res.error };
  mcRenderSidebar();
  if (id === state.activeMc) mcRenderHeader();
}

async function mcPollAll() {
  await Promise.all(mc.list.filter((m) => m.id !== state.activeMc).map((m) => mcRefresh(m.id)));
}

function mcRenderHeader() {
  const m = activeMc();
  if (!m) return;
  const st = mc.status[m.id];
  $('#mcName').textContent = m.name;
  const pill = $('#mcStatusPill');
  if (!st) { pill.className = 'pill pill-muted'; pill.textContent = 'Prüfe…'; }
  else if (st.online) { pill.className = 'pill pill-ok'; pill.textContent = `Online · ${st.players.online}/${st.players.max} Spieler`; }
  else { pill.className = 'pill pill-bad'; pill.textContent = 'Offline'; }
  $('#mcMotd').innerHTML = st?.online ? mcFormat(st.motd) : esc(st?.error || '');
  $('#mcFavicon').src = st?.favicon || '../../build/icon.png';
  $('#mcFavicon').classList.toggle('placeholder', !st?.favicon);
  $('#mcMeta').textContent = [
    st?.online ? st.version : null,
    st?.online ? `${st.latency} ms` : null,
    m.via === 'ssh' ? `über SSH-Tunnel (${state.servers.find((s) => s.id === m.sshServerId)?.name || '?'})` : `${m.host}:${m.gamePort}`,
    `RCON-Port ${m.rconPort}`,
  ].filter(Boolean).join('  ·  ');
}

// ---------- Tabs ----------
$('#mcTabs').addEventListener('click', (e) => {
  const t = e.target.dataset.mctab;
  if (!t) return;
  mc.tab = t;
  $$('#mcTabs button').forEach((b) => b.classList.toggle('active', b.dataset.mctab === t));
  $$('[data-mcpanel]').forEach((p) => p.classList.toggle('hidden', p.dataset.mcpanel !== t));
  mcLoadTab();
});

function mcLoadTab() {
  if (mc.tab === 'console') setTimeout(() => $('#mcInput').focus(), 0);
  if (mc.tab === 'players') mcLoadPlayers();
  if (mc.tab === 'control') mcLoadRules();
}

// ---------- RCON ----------
function mcLine(text, cls = 'l-mc', html = false) {
  const div = document.createElement('div');
  div.className = cls;
  if (html) div.innerHTML = text; else div.textContent = text;
  $('#mcOut').appendChild(div);
  $('#mcOut').scrollTop = $('#mcOut').scrollHeight;
}

// Befehl senden; mit echo=true erscheint er auch in der Konsole
async function mcCmd(cmd, { echo = true, quiet = false } = {}) {
  const id = state.activeMc;
  if (!id) return null;
  if (echo) mcLine(`/${cmd}`, 'l-cmd mc-cmd');
  const res = await window.fire.mc.command(id, cmd);
  if (!res.ok) {
    if (echo || !quiet) mcLine(res.error, 'l-err');
    if (!quiet && !echo) toast(res.error, 'err');
    return null;
  }
  if (echo) mcLine(res.data ? mcFormat(res.data) : '<span class="muted">(keine Ausgabe)</span>', 'l-mc', true);
  return res.data;
}

const MC_COMMANDS = ['list', 'say', 'tell', 'msg', 'kick', 'ban', 'ban-ip', 'pardon', 'pardon-ip', 'banlist', 'op', 'deop', 'whitelist', 'gamemode',
  'gamerule', 'difficulty', 'time', 'weather', 'tp', 'teleport', 'give', 'clear', 'effect', 'enchant', 'xp', 'experience', 'kill', 'summon',
  'setworldspawn', 'spawnpoint', 'worldborder', 'save-all', 'save-on', 'save-off', 'stop', 'seed', 'locate', 'title', 'tellraw', 'scoreboard',
  'team', 'help', 'tps', 'plugins', 'version', 'reload', 'execute', 'fill', 'setblock', 'difficulty', 'defaultgamemode', 'whitelist add', 'whitelist remove'];

$('#mcForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#mcInput');
  const cmd = input.value.trim().replace(/^\//, '');
  if (!cmd) return;
  input.value = '';
  mc.history.push(cmd);
  mc.histIdx = mc.history.length;
  if (/^stop\b/.test(cmd)) {
    const ok = await dialog({ title: 'Server stoppen?', text: 'Der Minecraft-Server fährt herunter. Wieder starten musst du ihn über AMP bzw. dein Panel.', okText: 'Stoppen', danger: true });
    if (!ok) return;
  }
  input.disabled = true;
  await mcCmd(cmd);
  input.disabled = false;
  input.focus();
});

$('#mcInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' && mc.histIdx > 0) { e.preventDefault(); e.target.value = mc.history[--mc.histIdx]; }
  else if (e.key === 'ArrowDown') { e.preventDefault(); mc.histIdx = Math.min(mc.history.length, mc.histIdx + 1); e.target.value = mc.history[mc.histIdx] || ''; }
  else if (e.key === 'Tab') {
    e.preventDefault();
    const v = e.target.value;
    const hits = [...new Set(MC_COMMANDS)].filter((c) => c.startsWith(v) && c !== v);
    // Spielernamen ergänzen, wenn schon ein Befehl dasteht
    const parts = v.split(' ');
    if (parts.length > 1) {
      const names = mc.status[state.activeMc]?.players?.sample || [];
      const hit = names.find((n) => n.toLowerCase().startsWith(parts.at(-1).toLowerCase()));
      if (hit) { parts[parts.length - 1] = hit; e.target.value = `${parts.join(' ')} `; }
    } else if (hits.length === 1) e.target.value = `${hits[0]} `;
    else if (hits.length > 1) mcLine(hits.join('   '), 'l-info');
  }
});

$('#mcChips').addEventListener('click', (e) => { const c = e.target.dataset.cmd; if (c) mcCmd(c); });
$('.mc-terminal').addEventListener('click', () => { if (!window.getSelection().toString()) $('#mcInput').focus(); });

$('#mcSave').addEventListener('click', async () => {
  const out = await mcCmd('save-all', { echo: false });
  if (out !== null) toast('Welt gespeichert', 'ok');
});
$('#mcStop').addEventListener('click', async () => {
  const m = activeMc();
  const ok = await dialog({ title: `„${m?.name}“ stoppen?`, text: 'Speichert die Welt und fährt den Minecraft-Server herunter. Starten musst du ihn danach über AMP bzw. dein Panel.', okText: 'Stoppen', danger: true });
  if (!ok) return;
  await mcCmd('save-all', { echo: true });
  await mcCmd('stop', { echo: true });
  setTimeout(() => mcRefresh(), 5000);
});

// ---------- Spieler ----------
function parseList(out) {
  const text = stripCodes(out);
  const m = /There are (\d+)(?: of a max of| out of maximum) (\d+) players online/i.exec(text);
  let names = [];
  const colon = text.split('\n').map((l) => l.trim()).filter(Boolean);
  // Vanilla: "…online: a, b"   Paper: weitere Zeilen "default: a, b"
  for (const line of colon) {
    const idx = line.lastIndexOf(':');
    if (idx >= 0) names.push(...line.slice(idx + 1).split(',').map((s) => s.trim()).filter(Boolean));
  }
  names = names.filter((n) => /^[A-Za-z0-9_.]{2,16}$/.test(n.replace(/^\[.*?\]\s*/, '')));
  return { online: m ? Number(m[1]) : names.length, max: m ? Number(m[2]) : null, names: [...new Set(names)] };
}

const namesAfterColon = (out) => {
  const t = stripCodes(out);
  const i = t.indexOf(':');
  if (i < 0 || /no whitelisted|no bans/i.test(t)) return [];
  return t.slice(i + 1).split(/[,\n]/).map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_]{2,16}$/.test(s));
};

async function mcLoadPlayers() {
  const out = await mcCmd('list', { echo: false, quiet: true });
  if (out === null) {
    $('#mcPlayers').innerHTML = '<span class="muted">RCON nicht verbunden – siehe Konsole.</span>';
  } else {
    const l = parseList(out);
    $('#mcOnlineTitle').textContent = `Online (${l.online}${l.max ? `/${l.max}` : ''})`;
    $('#mcPlayers').innerHTML = l.names.length ? l.names.map((n) => `
      <div class="mc-player" data-name="${esc(n)}">
        <span class="mc-avatar">${esc(n.slice(0, 1).toUpperCase())}</span>
        <span class="mc-pname">${esc(n)}</span>
        <select class="input mc-gm" title="Spielmodus">
          <option value="">Modus…</option><option value="survival">Überleben</option><option value="creative">Kreativ</option>
          <option value="adventure">Abenteuer</option><option value="spectator">Zuschauer</option>
        </select>
        <button class="btn btn-sm btn-ghost" data-pact="op">OP</button>
        <button class="btn btn-sm btn-ghost" data-pact="deop">DeOP</button>
        <button class="btn btn-sm btn-ghost" data-pact="kick">Kicken</button>
        <button class="btn btn-sm btn-danger" data-pact="ban">Bannen</button>
      </div>`).join('') : '<span class="muted">Niemand online.</span>';
  }
  const wl = await mcCmd('whitelist list', { echo: false, quiet: true });
  $('#mcWhitelist').innerHTML = wl === null ? '' : (namesAfterColon(wl).map((n) => `<span class="mc-name">${esc(n)}<button data-unwl="${esc(n)}" title="Entfernen">✕</button></span>`).join('') || '<span class="muted">Leer</span>');
  const bl = await mcCmd('banlist players', { echo: false, quiet: true });
  const banned = bl === null ? [] : [...stripCodes(bl).matchAll(/^(\w{2,16}) was banned by/gm)].map((x) => x[1]);
  $('#mcBanlist').innerHTML = banned.map((n) => `<span class="mc-name ban">${esc(n)}<button data-pardon="${esc(n)}" title="Entbannen">✕</button></span>`).join('') || '<span class="muted">Niemand gebannt</span>';
}

$('#mcPlayersRefresh').addEventListener('click', mcLoadPlayers);

$('#mcPlayers').addEventListener('click', async (e) => {
  const act = e.target.dataset.pact;
  const name = e.target.closest('[data-name]')?.dataset.name;
  if (!act || !name) return;
  if (act === 'kick' || act === 'ban') {
    const reason = await dialog({ title: `${name} ${act === 'kick' ? 'kicken' : 'bannen'}?`, text: 'Grund (optional):', input: '', okText: act === 'kick' ? 'Kicken' : 'Bannen', danger: true });
    if (reason === null) return;
    await mcAction(`${act} ${name}${reason ? ` ${reason}` : ''}`);
  } else {
    await mcAction(`${act} ${name}`);
  }
  mcLoadPlayers();
});
$('#mcPlayers').addEventListener('change', async (e) => {
  if (!e.target.matches('.mc-gm') || !e.target.value) return;
  const name = e.target.closest('[data-name]').dataset.name;
  await mcAction(`gamemode ${e.target.value} ${name}`);
  e.target.value = '';
});

// Aktion ausführen und Antwort als Hinweis zeigen
async function mcAction(cmd) {
  const out = await mcCmd(cmd, { echo: false });
  if (out !== null) toast(stripCodes(out) || `/${cmd} ausgeführt`, /unknown|error|incorrect|no player/i.test(out) ? 'err' : 'ok');
  return out;
}

$('#mcWlForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const n = $('#mcWlName').value.trim();
  if (!n) return;
  await mcAction(`whitelist add ${n}`);
  $('#mcWlName').value = '';
  mcLoadPlayers();
});
$('#mcBanForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const n = $('#mcBanName').value.trim();
  if (!n) return;
  const r = $('#mcBanReason').value.trim();
  await mcAction(`ban ${n}${r ? ` ${r}` : ''}`);
  $('#mcBanName').value = '';
  $('#mcBanReason').value = '';
  mcLoadPlayers();
});
$('#mcWhitelist').addEventListener('click', async (e) => { const n = e.target.dataset.unwl; if (n) { await mcAction(`whitelist remove ${n}`); mcLoadPlayers(); } });
$('#mcBanlist').addEventListener('click', async (e) => { const n = e.target.dataset.pardon; if (n) { await mcAction(`pardon ${n}`); mcLoadPlayers(); } });
$$('[data-wl]').forEach((b) => b.addEventListener('click', async () => { await mcAction(`whitelist ${b.dataset.wl}`); }));

// ---------- Steuerung ----------
const MC_RULES = [
  ['keepInventory', 'Inventar behalten beim Tod'],
  ['doDaylightCycle', 'Tag/Nacht-Wechsel'],
  ['doWeatherCycle', 'Wetterwechsel'],
  ['mobGriefing', 'Mobs zerstören Blöcke'],
  ['doFireTick', 'Feuer breitet sich aus'],
  ['doMobSpawning', 'Mobs spawnen'],
  ['doInsomnia', 'Phantome'],
  ['announceAdvancements', 'Fortschritte im Chat'],
  ['showDeathMessages', 'Todesnachrichten'],
  ['naturalRegeneration', 'Natürliche Regeneration'],
  ['doImmediateRespawn', 'Sofortiger Respawn'],
  ['pvp', 'PvP (ab 1.21.9)'],
];

async function mcLoadRules() {
  const box = $('#mcRules');
  box.innerHTML = '<span class="muted">Lädt…</span>';
  const rows = [];
  for (const [rule, label] of MC_RULES) {
    const out = await mcCmd(`gamerule ${rule}`, { echo: false, quiet: true });
    if (out === null) { box.innerHTML = '<span class="muted">RCON nicht verbunden.</span>'; return; }
    const m = /(true|false)\s*$/i.exec(stripCodes(out).trim());
    if (!m) continue; // Regel gibt es in dieser Version nicht
    rows.push(`<label class="mc-rule"><span>${esc(label)}<small class="mono">${rule}</small></span>
      <span class="toggle"><input type="checkbox" data-rule="${rule}" ${m[1].toLowerCase() === 'true' ? 'checked' : ''}><span></span></span></label>`);
  }
  box.innerHTML = rows.join('') || '<span class="muted">Keine Spielregeln gefunden.</span>';
}

$('#mcRules').addEventListener('change', async (e) => {
  const rule = e.target.dataset.rule;
  if (!rule) return;
  await mcAction(`gamerule ${rule} ${e.target.checked}`);
});
$('#mcRulesRefresh').addEventListener('click', mcLoadRules);
$('[data-mcpanel="control"]').addEventListener('click', (e) => {
  const c = e.target.closest('.mc-btns [data-cmd]')?.dataset.cmd;
  if (c) mcAction(c);
});
$('#mcSayForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const t = $('#mcSay').value.trim();
  if (!t) return;
  await mcAction(`say ${t}`);
  $('#mcSay').value = '';
});

// ---------- Menü ----------
$('#mcMenuBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#mcMenu').classList.toggle('hidden'); });
document.addEventListener('click', () => $('#mcMenu').classList.add('hidden'));
$('#mcMenu').addEventListener('click', async (e) => {
  const a = e.target.dataset.mcAction;
  const m = activeMc();
  if (!a || !m) return;
  if (a === 'refresh') { await mcRefresh(); mcLoadTab(); }
  if (a === 'edit') openMcModal(m);
  if (a === 'remove') {
    const ok = await dialog({ title: `„${m.name}“ entfernen?`, text: 'Wird nur aus Fire Desktop entfernt. Der Minecraft-Server selbst bleibt unverändert.', okText: 'Entfernen', danger: true });
    if (!ok) return;
    mc.list = await window.fire.mc.remove(m.id);
    delete mc.status[m.id];
    deselectMc();
    if (state.activeId) { $('#serverView').classList.remove('hidden'); renderSidebar(); } else renderSidebar();
  }
});

// ---------- Hinzufügen / Bearbeiten ----------
function setVia(v) {
  mc.via = v;
  $$('#mcfVia button').forEach((b) => b.classList.toggle('active', b.dataset.via === v));
  $('#mcfSshField').classList.toggle('hidden', v !== 'ssh');
  $('#mcfHostField').classList.toggle('hidden', v !== 'direct');
  $('#mcfHint').innerHTML = v === 'ssh'
    ? 'Fire Desktop verbindet sich per SSH mit deinem 24fire-Server und erreicht RCON dort über <span class="mono">127.0.0.1</span>. '
      + 'So muss der RCON-Port <b>nicht</b> offen im Internet stehen – in der Firewall kann er geschlossen bleiben.'
    : 'Direkte Verbindung: Der RCON-Port muss von deinem PC erreichbar sein. RCON ist unverschlüsselt – nach Möglichkeit den SSH-Tunnel nutzen.';
}

function openMcModal(m = null) {
  mc.editId = m?.id || null;
  $('#mcModalTitle').textContent = m ? `„${m.name}“ bearbeiten` : 'Minecraft-Server hinzufügen';
  $('#mcfSsh').innerHTML = state.servers.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')
    || '<option value="">(kein 24fire-Server vorhanden)</option>';
  $('#mcfName').value = m?.name || '';
  $('#mcfHost').value = m?.via === 'direct' ? m.host : '';
  $('#mcfGame').value = m?.gamePort || 25565;
  $('#mcfRcon').value = m?.rconPort || 25575;
  $('#mcfPass').value = '';
  $('#mcfPass').placeholder = m ? 'leer lassen = unverändert' : 'rcon.password aus server.properties';
  if (m?.sshServerId) $('#mcfSsh').value = m.sshServerId;
  setVia(m?.via || (state.servers.length ? 'ssh' : 'direct'));
  $('#mcfError').classList.add('hidden');
  $('#mcfTest').classList.add('hidden');
  $('#mcModal').classList.remove('hidden');
  setTimeout(() => $('#mcfName').focus(), 0);
}

const mcFormInput = () => ({
  name: $('#mcfName').value.trim(),
  via: mc.via,
  sshServerId: mc.via === 'ssh' ? $('#mcfSsh').value : null,
  host: mc.via === 'direct' ? $('#mcfHost').value.trim() : '127.0.0.1',
  gamePort: Number($('#mcfGame').value) || 25565,
  rconPort: Number($('#mcfRcon').value) || 25575,
  rconPass: $('#mcfPass').value,
});

$('#mcAddBtn').addEventListener('click', () => openMcModal());
$$('[data-close-mc]').forEach((b) => b.addEventListener('click', () => $('#mcModal').classList.add('hidden')));
$('#mcfVia').addEventListener('click', (e) => e.target.dataset.via && setVia(e.target.dataset.via));

$('#mcfTestBtn').addEventListener('click', async () => {
  const box = $('#mcfTest');
  box.classList.remove('hidden');
  box.innerHTML = '<span class="muted">Teste Verbindung…</span>';
  const res = await window.fire.mc.test(mcFormInput(), mc.editId);
  if (!res.ok) { box.innerHTML = `<div class="bad">✕ ${esc(res.error)}</div>`; return; }
  const { status, rcon } = res.data;
  box.innerHTML = `
    <div class="${status.online ? 'good' : 'bad'}">${status.online
      ? `✓ Server online – ${esc(status.version)}, ${status.players.online}/${status.players.max} Spieler`
      : `✕ Status nicht abrufbar: ${esc(status.error)}`}</div>
    <div class="${rcon.ok ? 'good' : 'bad'}">${rcon.ok ? `✓ RCON verbunden – ${esc(stripCodes(rcon.output))}` : `✕ RCON: ${esc(rcon.error)}`}</div>`;
});

$('#mcfSave').addEventListener('click', async () => {
  const input = mcFormInput();
  const err = $('#mcfError');
  err.classList.add('hidden');
  if (!input.name) { err.textContent = 'Bitte einen Namen eingeben.'; err.classList.remove('hidden'); return; }
  if (!mc.editId && !input.rconPass) { err.textContent = 'Bitte das RCON-Passwort eingeben.'; err.classList.remove('hidden'); return; }
  const res = mc.editId ? await window.fire.mc.update(mc.editId, input) : await window.fire.mc.add(input);
  if (!res.ok) { err.textContent = res.error; err.classList.remove('hidden'); return; }
  $('#mcModal').classList.add('hidden');
  await mcLoad();
  toast(mc.editId ? 'Gespeichert' : 'Minecraft-Server hinzugefügt', 'ok');
  selectMc(res.data.id);
});

// ---------- Start ----------
window.addEventListener('DOMContentLoaded', async () => {
  await mcLoad();
  mcPollAll();
  setInterval(() => { if (!document.hidden) mcPollAll(); }, 60000);
});
