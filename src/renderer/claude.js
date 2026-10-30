// Claude-Zugriff: Einstellungen des MCP-Servers, Rechte pro Server, Bestätigungen und Protokoll.

const cm = { status: null, showToken: false };
const CM_LEVELS = [
  ['none', 'Kein'],
  ['read', 'Lesen'],
  ['control', 'Steuern'],
  ['full', 'Voll (SSH)'],
];

async function cmRefresh() {
  cm.status = await window.fire.claude.status();
  cmRender();
}

function cmCommand(st) {
  return `claude mcp add --transport http --scope user fire-desktop ${st.url} --header "Authorization: Bearer ${st.token || '<token>'}"`;
}

function cmRender() {
  const st = cm.status;
  if (!st) return;

  // Seitenleiste
  const side = $('#claudeState');
  side.textContent = st.running ? 'An' : st.error ? 'Fehler' : 'Aus';
  side.className = `claude-state ${st.running ? 'on' : st.error ? 'err' : ''}`;

  const pill = $('#cmStatus');
  if (st.running) { pill.className = 'pill pill-ok'; pill.textContent = `Aktiv · Port ${st.port}`; }
  else if (st.error) { pill.className = 'pill pill-bad'; pill.textContent = st.error; }
  else { pill.className = 'pill pill-muted'; pill.textContent = 'Aus'; }

  const notice = [st.error && st.enabled ? `MCP-Server läuft nicht: ${st.error}` : '', st.notice].filter(Boolean).join(' ');
  $('#cmNotice').textContent = notice;
  $('#cmNotice').classList.toggle('hidden', !notice);
  $('#cmNotice').classList.toggle('bad', !!(st.error && st.enabled));

  $('#cmEnabled').checked = st.enabled;
  $('#cmConfirm').checked = st.confirm;
  $('#cmUrl').textContent = st.url;
  $('#cmToken').textContent = st.token ? (cm.showToken ? st.token : '•'.repeat(16)) : '(wird beim Einschalten erzeugt)';
  $('#cmShowToken').textContent = cm.showToken ? 'Verbergen' : 'Zeigen';
  if (document.activeElement !== $('#cmPort')) $('#cmPort').value = st.port;
  $('#cmCmd').textContent = cm.showToken ? cmCommand(st) : cmCommand({ ...st, token: '•••' });
  $('#cmRegister').disabled = !st.token;

  $('#cmServers').innerHTML = state.servers.length ? state.servers.map((s) => {
    const lvl = st.access[s.id] || 'none';
    return `<div class="cm-server" data-id="${s.id}">
      <div class="cm-sname">${esc(s.name)}<div class="muted">${esc(serverSub(s))}</div></div>
      <div class="seg cm-seg">${CM_LEVELS.map(([v, l]) => `<button data-level="${v}" class="${lvl === v ? 'active' : ''} ${v === 'full' ? 'lvl-full' : ''}">${l}</button>`).join('')}</div>
    </div>`;
  }).join('') : '<span class="muted">Noch keine Server hinzugefügt.</span>';

  cmRenderLog();
}

function cmRenderLog() {
  const log = cm.status?.log || [];
  $('#cmLog').innerHTML = log.length ? log.map((e) => {
    const ok = e.result === 'ok';
    const denied = e.result === 'abgelehnt';
    return `<div class="cm-entry">
      <span class="cm-time">${new Date(e.time).toLocaleTimeString('de-DE')}</span>
      <span class="pill ${ok ? 'pill-ok' : denied ? 'pill-warn' : 'pill-bad'}">${esc(ok ? 'ok' : denied ? 'abgelehnt' : 'Fehler')}</span>
      <span class="cm-what"><b>${esc(e.tool)}</b> ${e.server !== '–' ? `· ${esc(e.server)}` : ''}<br><span class="muted">${esc(ok || denied ? e.summary : e.result)}</span></span>
    </div>`;
  }).join('') : '<span class="muted">Noch keine Zugriffe.</span>';
}

$('#claudeBtn').addEventListener('click', () => {
  cm.showToken = false;
  $('#cmError').classList.add('hidden');
  cmRefresh();
  $('#claudeModal').classList.remove('hidden');
});
$$('[data-close-claude]').forEach((b) => b.addEventListener('click', () => $('#claudeModal').classList.add('hidden')));

$('#cmEnabled').addEventListener('change', async (e) => {
  cm.status = await window.fire.claude.update({ enabled: e.target.checked });
  cmRender();
  if (cm.status.running) toast('Claude-Zugriff aktiv', 'ok');
});
$('#cmConfirm').addEventListener('change', async (e) => {
  if (!e.target.checked) {
    const ok = await dialog({
      title: 'Bestätigungen abschalten?',
      text: 'Claude kann dann Server stoppen, Dateien löschen und Befehle ausführen, ohne dass du gefragt wirst.',
      okText: 'Abschalten',
      danger: true,
    });
    if (!ok) { e.target.checked = true; return; }
  }
  cm.status = await window.fire.claude.update({ confirm: e.target.checked });
  cmRender();
});
$('#cmPort').addEventListener('change', async (e) => {
  const port = Number(e.target.value);
  if (!(port >= 1024 && port <= 65535)) { toast('Port muss zwischen 1024 und 65535 liegen', 'err'); return cmRender(); }
  cm.status = await window.fire.claude.update({ port });
  cmRender();
});
$('#cmServers').addEventListener('click', async (e) => {
  const level = e.target.dataset.level;
  if (!level) return;
  const id = e.target.closest('.cm-server').dataset.id;
  if (level === 'full' && cm.status.access[id] !== 'full') {
    const s = state.servers.find((x) => x.id === id);
    const ok = await dialog({
      title: `Vollzugriff für „${s?.name}“?`,
      text: 'Claude darf dann per SSH als root Befehle ausführen sowie Dateien lesen und schreiben. Mit aktivierter Bestätigung musst du jede riskante Aktion freigeben.',
      okText: 'Vollzugriff geben',
    });
    if (!ok) return;
  }
  cm.status = await window.fire.claude.update({ access: { [id]: level } });
  cmRender();
});
$('#cmShowToken').addEventListener('click', () => { cm.showToken = !cm.showToken; cmRender(); });
$('#cmRegen').addEventListener('click', async () => {
  const ok = await dialog({
    title: 'Neues Token erzeugen?',
    text: 'Bereits verbundene Clients verlieren den Zugriff, bis sie mit dem neuen Token eingetragen werden.',
    okText: 'Neu erzeugen',
    danger: true,
  });
  if (!ok) return;
  cm.status = await window.fire.claude.regenToken();
  cmRender();
  toast('Neues Token erzeugt – Claude Code neu eintragen', 'ok');
});
document.querySelector('#claudeModal').addEventListener('click', (e) => {
  const what = e.target.dataset.cmCopy;
  if (!what || !cm.status) return;
  const val = { url: cm.status.url, token: cm.status.token, cmd: cmCommand(cm.status) }[what];
  if (!val) return;
  navigator.clipboard.writeText(val);
  toast('In Zwischenablage kopiert', 'ok');
});
$('#cmRegister').addEventListener('click', async () => {
  const btn = $('#cmRegister');
  btn.disabled = true;
  btn.textContent = 'Trage ein…';
  const res = await window.fire.claude.registerCode();
  btn.disabled = false;
  btn.textContent = 'Automatisch in Claude Code eintragen';
  const err = $('#cmError');
  if (res.ok) {
    err.classList.add('hidden');
    cmRefresh();
    toast('In Claude Code eingetragen – Claude Code neu starten', 'ok');
    if (!cm.status.enabled) toast('Hinweis: Der MCP-Server ist noch ausgeschaltet.', 'info');
  } else {
    err.textContent = `${res.error} Kopiere den Befehl oben und führe ihn im Terminal aus.`;
    err.classList.remove('hidden');
  }
});

window.fire.claude.onActivity((entry) => {
  if (!cm.status) return;
  cm.status.log = [entry, ...(cm.status.log || [])].slice(0, 200);
  if (!$('#claudeModal').classList.contains('hidden')) cmRenderLog();
});

// ---- Bestätigungen (Warteschlange, eine nach der anderen) ----
const ccQueue = [];
let ccCurrent = null;
let ccTimer = null;

window.fire.claude.onConfirm((req) => { ccQueue.push(req); ccNext(); });
window.fire.claude.onConfirmTimeout((id) => {
  const i = ccQueue.findIndex((r) => r.id === id);
  if (i >= 0) ccQueue.splice(i, 1);
  if (ccCurrent?.id === id) { toast('Claude-Anfrage abgelaufen (nicht bestätigt)', 'err'); ccClose(); }
});

function ccNext() {
  if (ccCurrent || !ccQueue.length) return;
  ccCurrent = ccQueue.shift();
  $('#ccServer').textContent = `Server: ${ccCurrent.server} · Tool: ${ccCurrent.tool}`;
  $('#ccSummary').textContent = ccCurrent.summary;
  const det = $('#ccDetails');
  det.textContent = ccCurrent.details || '';
  det.classList.toggle('hidden', !ccCurrent.details);
  let left = 120;
  $('#ccTimer').textContent = `Wird in ${left} s automatisch abgelehnt.`;
  clearInterval(ccTimer);
  ccTimer = setInterval(() => {
    left -= 1;
    $('#ccTimer').textContent = `Wird in ${left} s automatisch abgelehnt.`;
    if (left <= 0) clearInterval(ccTimer);
  }, 1000);
  $('#claudeConfirm').classList.remove('hidden');
  $('#ccDeny').focus();
}

function ccClose() {
  clearInterval(ccTimer);
  ccCurrent = null;
  $('#claudeConfirm').classList.add('hidden');
  setTimeout(ccNext, 150);
}

function ccAnswer(ok) {
  if (!ccCurrent) return;
  window.fire.claude.reply(ccCurrent.id, ok);
  ccClose();
}
$('#ccAllow').addEventListener('click', () => ccAnswer(true));
$('#ccDeny').addEventListener('click', () => ccAnswer(false));

cmRefresh();

// Status kann sich auch ohne Klick ändern (z. B. Port beim Start belegt)
window.fire.claude.onChanged((st) => { cm.status = { ...st, log: cm.status?.log || st.log }; cmRender(); });


// ---- Vollständiges Protokoll ----
const AU_TOOL_LABEL = {
  run_command: 'Befehl ausgeführt',
  write_file: 'Datei geschrieben',
  delete_path: 'Gelöscht',
  power_server: 'Power-Aktion',
  create_backup: 'Backup erstellt',
  nginx_test_and_reload: 'Nginx',
  read_file: 'Datei gelesen',
  list_directory: 'Ordner gelesen',
  get_server: 'Server-Infos',
  get_monitoring: 'Monitoring',
  list_backups: 'Backups gelesen',
  list_servers: 'Server aufgelistet',
  verbunden: 'Client verbunden',
  abgewiesen: 'Zugriff abgewiesen',
};
const AU_CHANGES = ['run_command', 'write_file', 'delete_path', 'power_server', 'create_backup', 'nginx_test_and_reload'];
let auTimer = null;

async function openAudit(serverName = '') {
  $('#auServer').innerHTML = '<option value="">Alle Server</option>'
    + state.servers.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('');
  $('#auServer').value = serverName;
  $('#auditModal').classList.remove('hidden');
  await loadAudit();
}

async function loadAudit() {
  const list = await window.fire.claude.auditList({
    search: $('#auSearch').value.trim(),
    server: $('#auServer').value,
    onlyChanges: $('#auChanges').checked,
  });
  const changes = list.filter((e) => AU_CHANGES.includes(e.tool)).length;
  $('#auStats').textContent = `${list.length} Einträge${list.length === 500 ? ' (neueste 500)' : ''} · davon ${changes} Änderungen am Server`;
  $('#auList').innerHTML = list.length ? list.map(auditRow).join('') : '<div class="empty-row muted">Keine Einträge.</div>';
}

function auditRow(e) {
  const isChange = AU_CHANGES.includes(e.tool);
  const res = String(e.result || '');
  const kind = res.startsWith('ok') ? (res === 'ok' ? 'ok' : 'warn') : res === 'abgelehnt' ? 'warn' : 'bad';
  const label = res.startsWith('ok') ? (e.exitCode ? `Exit ${e.exitCode}` : 'ok') : res === 'abgelehnt' ? 'abgelehnt' : 'Fehler';
  const cmd = e.args?.command;
  const details = [
    e.decision ? `<div class="au-kv"><span>Bestätigung</span><span>${esc(e.decision)}</span></div>` : '',
    e.client ? `<div class="au-kv"><span>Client</span><span>${esc(e.client)}</span></div>` : '',
    e.durationMs !== undefined ? `<div class="au-kv"><span>Dauer</span><span>${e.durationMs} ms</span></div>` : '',
    !res.startsWith('ok') && res !== 'abgelehnt' ? `<div class="au-kv"><span>Ergebnis</span><span class="bad">${esc(res)}</span></div>` : '',
    cmd ? `<div class="au-block"><div class="au-cap">Befehl</div><pre class="au-cmd">${esc(cmd)}</pre></div>` : '',
    e.args?.path ? `<div class="au-kv"><span>Pfad</span><span class="mono">${esc(e.args.path)}</span></div>` : '',
    e.args?.content !== undefined ? `<div class="au-block"><div class="au-cap">Geschriebener Inhalt</div><pre>${esc(e.args.content)}</pre></div>` : '',
    e.args?.action ? `<div class="au-kv"><span>Aktion</span><span>${esc(e.args.action)}</span></div>` : '',
    e.output ? `<div class="au-block"><div class="au-cap">Ausgabe</div><pre>${esc(e.output)}</pre></div>` : '',
  ].join('');
  return `<details class="au-item ${isChange ? 'change' : ''}">
    <summary>
      <span class="au-time">${new Date(e.time).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'medium' })}</span>
      <span class="pill pill-${kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : 'bad'}">${esc(label)}</span>
      <span class="au-tool">${esc(AU_TOOL_LABEL[e.tool] || e.tool)}</span>
      <span class="au-server">${esc(e.server || '–')}</span>
      <span class="au-sum">${esc(cmd ? cmd.split('\n')[0] : e.summary || '')}</span>
    </summary>
    <div class="au-body">${details || '<span class="muted">Keine weiteren Details.</span>'}</div>
  </details>`;
}

$('#cmOpenAudit').addEventListener('click', () => openAudit());
$$('[data-close-audit]').forEach((b) => b.addEventListener('click', () => $('#auditModal').classList.add('hidden')));
$('#auSearch').addEventListener('input', () => { clearTimeout(auTimer); auTimer = setTimeout(loadAudit, 250); });
$('#auServer').addEventListener('change', loadAudit);
$('#auChanges').addEventListener('change', loadAudit);
$('#auExport').addEventListener('click', async () => {
  const r = await window.fire.claude.auditExport();
  if (r.ok) toast('Protokoll exportiert', 'ok');
});
$('#auClear').addEventListener('click', async () => {
  const ok = await dialog({ title: 'Claude-Protokoll leeren?', text: 'Alle gespeicherten Einträge werden gelöscht. Tipp: vorher exportieren.', okText: 'Leeren', danger: true });
  if (!ok) return;
  await window.fire.claude.auditClear();
  loadAudit();
  cmRefresh();
});

// Neue Einträge live nachladen, wenn das Protokoll offen ist
window.fire.claude.onActivity(() => {
  if (!$('#auditModal').classList.contains('hidden')) { clearTimeout(auTimer); auTimer = setTimeout(loadAudit, 300); }
});
