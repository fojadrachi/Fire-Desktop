// Discord-Status: Einstellungen, Platzhalter und Live-Vorschau.

const dc = { status: null, saveTimer: null, previewTimer: null, lastField: null };
const DC_TYPE_LABEL = { 0: 'SPIELT', 2: 'HÖRT', 3: 'SCHAUT', 5: 'TRITT AN IN' };
const DC_FIELDS = {
  dcDetails: 'details',
  dcState: 'state',
  dcLargeImage: 'largeImage',
  dcLargeText: 'largeText',
  dcSmallImage: 'smallImage',
  dcSmallText: 'smallText',
};

async function dcRefresh() {
  dc.status = await window.fire.discord.status();
  dcRender(true);
}

function dcRenderStatus() {
  const st = dc.status;
  if (!st) return;
  const on = st.settings.enabled;
  const side = $('#discordState');
  side.textContent = !on ? 'Aus' : st.connected ? 'An' : 'Fehler';
  side.className = `claude-state ${on && st.connected ? 'on' : on ? 'err' : ''}`;

  const pill = $('#dcStatus');
  if (!on) { pill.className = 'pill pill-muted'; pill.textContent = 'Aus'; }
  else if (st.connected) { pill.className = 'pill pill-ok'; pill.textContent = `Verbunden${st.user ? ` als ${st.user}` : ''}`; }
  else { pill.className = 'pill pill-bad'; pill.textContent = st.error || 'Verbinde…'; }
  $('#dcEnabled').checked = on;
}

// Formular nur beim Öffnen befüllen, damit Tippen nicht überschrieben wird
function dcRender(fillForm) {
  dcRenderStatus();
  const s = dc.status.settings;
  if (!fillForm) return;
  for (const [id, key] of Object.entries(DC_FIELDS)) $(`#${id}`).value = s[key] || '';
  $('#dcType').value = String(s.type ?? 0);
  $('#dcTimer').value = s.timer;
  const b = s.buttons || [];
  $('#dcB1Label').value = b[0]?.label || '';
  $('#dcB1Url').value = b[0]?.url || '';
  $('#dcB2Label').value = b[1]?.label || '';
  $('#dcB2Url').value = b[1]?.url || '';

  $('#dcServer').innerHTML = [
    '<option value="active">Gerade ausgewählter Server</option>',
    '<option value="all">Alle Server (Übersicht)</option>',
    ...state.servers.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`),
  ].join('');
  $('#dcServer').value = s.server || 'active';

  const ph = dc.status.placeholders;
  $('#dcChips').innerHTML = Object.keys(ph).map((k) => `<button type="button" class="dc-chip" data-ph="${k}" title="${esc(ph[k])}">{${k}}</button>`).join('');
  dcPreview();
}

function dcCollect() {
  const patch = {
    server: $('#dcServer').value,
    type: Number($('#dcType').value),
    timer: $('#dcTimer').value,
    buttons: [
      { label: $('#dcB1Label').value.trim(), url: $('#dcB1Url').value.trim() },
      { label: $('#dcB2Label').value.trim(), url: $('#dcB2Url').value.trim() },
    ].filter((b) => b.label || b.url),
  };
  for (const [id, key] of Object.entries(DC_FIELDS)) patch[key] = $(`#${id}`).value;
  return patch;
}

// Änderungen kurz sammeln und dann speichern (Discord verträgt nicht zu viele Updates)
function dcScheduleSave() {
  clearTimeout(dc.saveTimer);
  dc.saveTimer = setTimeout(async () => {
    const patch = dcCollect();
    const bad = patch.buttons.find((b) => b.url && !/^https:\/\//.test(b.url));
    if (bad) toast('Button-Links müssen mit https:// beginnen', 'err');
    dc.status = await window.fire.discord.update(patch);
    dcRenderStatus();
    dcPreview();
  }, 700);
}

async function dcPreview() {
  const res = await window.fire.discord.preview();
  if (!res.ok) return;
  const a = res.activity;
  $('#dcPvType').textContent = DC_TYPE_LABEL[a.type] || 'SPIELT';
  $('#dcPvDetails').textContent = a.details || '';
  $('#dcPvState').textContent = a.state || '';
  const small = $('#dcPvSmall');
  small.classList.toggle('hidden', !a.assets?.small_image);
  small.title = a.assets?.small_text || '';
  const start = a.timestamps?.start;
  dc.previewStart = start || null;
  dcTick();
  $('#dcPvButtons').innerHTML = (a.buttons || []).map((b) => `<div class="dc-button">${esc(b.label)}</div>`).join('');
  $('#dcPlaceholders').innerHTML = Object.entries(res.vars).map(([k, v]) =>
    `<div class="dc-phrow"><span class="mono">{${esc(k)}}</span><span>${esc(v)}</span></div>`).join('');
}

function dcTick() {
  const start = dc.previewStart;
  if (!start) { $('#dcPvTime').textContent = ''; return; }
  const s = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  $('#dcPvTime').textContent = `${h ? `${h}:${pad(m)}` : m}:${pad(sec)} vergangen`;
}
setInterval(() => { if (!$('#discordModal').classList.contains('hidden')) dcTick(); }, 1000);

$('#discordBtn').addEventListener('click', async () => {
  await dcRefresh();
  $('#discordModal').classList.remove('hidden');
  clearInterval(dc.previewTimer);
  dc.previewTimer = setInterval(dcPreview, 15000);
});
$$('[data-close-discord]').forEach((b) => b.addEventListener('click', () => {
  $('#discordModal').classList.add('hidden');
  clearInterval(dc.previewTimer);
}));

$('#dcEnabled').addEventListener('change', async (e) => {
  clearTimeout(dc.saveTimer);
  dc.status = await window.fire.discord.update({ ...dcCollect(), enabled: e.target.checked });
  dcRenderStatus();
});

$('#discordModal').addEventListener('input', (e) => {
  if (e.target.matches('.dc-tpl, .dc-btn')) dcScheduleSave();
});
$('#discordModal').addEventListener('change', (e) => {
  if (e.target.matches('select')) dcScheduleSave();
});
$('#discordModal').addEventListener('focusin', (e) => {
  if (e.target.matches('.dc-tpl, .dc-btn')) dc.lastField = e.target;
});

// Platzhalter an der Cursor-Position einfügen
$('#dcChips').addEventListener('mousedown', (e) => e.preventDefault());
$('#dcChips').addEventListener('click', (e) => {
  const ph = e.target.dataset.ph;
  if (!ph) return;
  const f = dc.lastField || $('#dcState');
  f.focus();
  document.execCommand('insertText', false, `{${ph}}`);
});

$('#dcPortal').addEventListener('click', (e) => {
  e.preventDefault();
  window.fire.openExternal('https://discord.com/developers/applications');
});

window.fire.discord.onChanged((st) => {
  dc.status = st;
  dcRenderStatus();
});

dcRefresh();
