// Dateimanager (SFTP), Nginx-Verwaltung und Editor.
// Nutzt die Hilfsfunktionen aus app.js ($, $$, esc, toast, dialog, active, state, fmtBytes, fmtDate).

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const joinPath = (dir, name) => (dir === '/' ? '' : dir.replace(/\/$/, '')) + '/' + name;
const parentPath = (p) => (p.replace(/\/[^/]+\/?$/, '') || '/');

// ================== Gemeinsame SSH/SFTP-Verbindung ==================
const rs = { rid: null, serverId: null, home: '/', pending: null, user: 'root', error: '' };

function remoteReset() {
  if (rs.rid) window.fire.remote.close(rs.rid);
  Object.assign(rs, { rid: null, serverId: null, home: '/', pending: null, error: '' });
  fm.cwd = null;
  fm.entries = [];
  fm.sel.clear();
  ngx.info = null;
  $('#fmRows').innerHTML = '';
  setGate(false);
}

function setGate(connected) {
  $$('[data-gate]').forEach((g) => g.closest('.tab').classList.toggle('disconnected', !connected));
}

async function ensureRemote({ silent = false } = {}) {
  const s = active();
  if (!s) return null;
  if (rs.rid && rs.serverId === s.id && await window.fire.remote.alive(rs.rid)) return rs.rid;
  if (rs.pending) return rs.pending;

  const host = $('#sshHost').value.trim();
  if (!host) {
    setGate(false);
    if (!silent) toast('Keine IP bekannt – im Konsole-Tab unter „Zugangsdaten“ eintragen.', 'err');
    return null;
  }
  rs.pending = (async () => {
    $$('[data-remote-connect]').forEach((b) => { b.disabled = true; b.textContent = 'Verbinde…'; });
    const res = await window.fire.remote.open({
      serverId: s.id,
      host,
      port: $('#sshPort').value,
      username: $('#sshUser').value.trim(),
      password: $('#sshPass').value,
    });
    $$('[data-remote-connect]').forEach((b) => { b.disabled = false; b.textContent = 'Verbinden'; });
    rs.pending = null;
    if (state.activeId !== s.id) { if (res.ok) window.fire.remote.close(res.rid); return null; }
    if (!res.ok) {
      rs.error = res.error;
      setGate(false);
      toast(`Verbindung: ${res.error}`, 'err');
      return null;
    }
    Object.assign(rs, { rid: res.rid, serverId: s.id, home: res.home || '/', user: $('#sshUser').value.trim(), error: '' });
    setGate(true);
    return rs.rid;
  })();
  return rs.pending;
}

$$('[data-remote-connect]').forEach((b) => b.addEventListener('click', () => {
  if (state.tab === 'files') loadFiles(fm.cwd);
  if (state.tab === 'nginx') loadNginx();
}));

// Befehl ausführen; als Nicht-root mit sudo
async function run(cmd, timeout) {
  const rid = await ensureRemote();
  if (!rid) return { ok: false, code: -1, stdout: '', stderr: 'Nicht verbunden' };
  const full = rs.user === 'root' ? cmd : `sudo -n sh -c ${shq(cmd)}`;
  const res = await window.fire.remote.exec(rid, `export PATH="$PATH:/usr/sbin:/sbin"; ${full}`, timeout);
  if (!res.ok) return { ok: false, code: -1, stdout: '', stderr: res.error };
  return { ...res, ok: res.code === 0 };
}

// ================== Dateimanager ==================
const fm = { cwd: null, entries: [], sel: new Set(), sort: { key: 'name', desc: false }, filter: '' };

const ICONS = {
  dir: '<svg class="ic dir" viewBox="0 0 24 24"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  file: '<svg class="ic file" viewBox="0 0 24 24"><path d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V9h5.5z"/></svg>',
  link: '<svg class="ic link" viewBox="0 0 24 24"><path d="M10.6 13.4a1 1 0 0 1 0-1.4l3.5-3.5a3 3 0 1 1 4.2 4.2l-2 2-1.4-1.4 2-2a1 1 0 1 0-1.4-1.4L12 13.4a1 1 0 0 1-1.4 0zM13.4 10.6a1 1 0 0 1 0 1.4l-3.5 3.5a3 3 0 1 1-4.2-4.2l2-2 1.4 1.4-2 2a1 1 0 1 0 1.4 1.4L12 10.6a1 1 0 0 1 1.4 0z"/></svg>',
};
const isDir = (e) => e.type === 'dir' || e.type === 'linkdir';

async function loadFiles(path) {
  const rid = await ensureRemote({ silent: true });
  if (!rid) return;
  const target = path || fm.cwd || rs.home;
  const res = await window.fire.fs.list(rid, target);
  if (!res.ok) {
    toast(`${target}: ${res.error}`, 'err');
    if (!fm.cwd && target !== '/') return loadFiles('/');
    return;
  }
  if (res.path !== fm.cwd) { fm.sel.clear(); fm.filter = ''; $('#fmFilter').value = ''; }
  fm.cwd = res.path;
  fm.entries = res.entries;
  renderFiles();
}

function renderCrumbs() {
  const parts = fm.cwd.split('/').filter(Boolean);
  let acc = '';
  $('#fmCrumbs').innerHTML = `<button data-go="/">/</button>` + parts.map((p, i) => {
    acc += '/' + p;
    return `${i ? '<span class="sep">/</span>' : ''}<button data-go="${esc(acc)}">${esc(p)}</button>`;
  }).join('');
  $('#fmCrumbs').scrollLeft = 99999;
}

function sortedEntries() {
  const { key, desc } = fm.sort;
  const f = fm.filter.toLowerCase();
  return fm.entries
    .filter((e) => !f || e.name.toLowerCase().includes(f))
    .sort((a, b) => {
      if (isDir(a) !== isDir(b)) return isDir(a) ? -1 : 1;
      const v = key === 'name' ? a.name.localeCompare(b.name, 'de', { numeric: true }) : (a[key] - b[key]);
      return desc ? -v : v;
    });
}

function renderFiles() {
  renderCrumbs();
  const rows = sortedEntries();
  $$('.fm-table th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === fm.sort.key);
    th.classList.toggle('desc', th.dataset.sort === fm.sort.key && fm.sort.desc);
  });
  $('#fmRows').innerHTML = rows.length ? rows.map((e) => {
    const icon = e.type === 'dir' ? ICONS.dir : e.type.startsWith('link') ? ICONS.link : ICONS.file;
    const sel = fm.sel.has(e.name);
    return `<tr class="${sel ? 'sel' : ''}" data-name="${esc(e.name)}">
      <td class="fm-check"><input type="checkbox" data-check ${sel ? 'checked' : ''}></td>
      <td><div class="fm-name">${icon}<a data-open>${esc(e.name)}</a>${e.target ? `<span class="lt">→ ${esc(e.target)}</span>` : ''}</div></td>
      <td class="num">${isDir(e) ? '<span class="muted">–</span>' : fmtBytes(e.size)}</td>
      <td class="fm-date">${fmtDate(e.mtime)}</td>
      <td class="fm-perm" title="${e.mode}">${e.perms}</td>
      <td class="fm-actions">
        ${isDir(e) ? '' : '<button data-act="edit">Bearbeiten</button>'}
        <button data-act="download">Laden</button>
        <button data-act="rename">Umbenennen</button>
        <button data-act="chmod">Rechte</button>
        <button data-act="delete" class="del">Löschen</button>
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="6" class="empty-row">${fm.filter ? 'Keine Treffer' : 'Ordner ist leer'}</td></tr>`;
  $('#fmCheckAll').checked = rows.length > 0 && rows.every((e) => fm.sel.has(e.name));
  renderSelBar();
}

function renderSelBar() {
  const n = fm.sel.size;
  $('#fmSelBar').classList.toggle('hidden', !n);
  $('#fmSelCount').textContent = `${n} ausgewählt`;
}

const entryOf = (name) => fm.entries.find((e) => e.name === name);

$('#fmRows').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-name]');
  if (!tr) return;
  const name = tr.dataset.name;
  const entry = entryOf(name);
  const full = joinPath(fm.cwd, name);

  if (e.target.matches('[data-check]')) {
    e.target.checked ? fm.sel.add(name) : fm.sel.delete(name);
    tr.classList.toggle('sel', e.target.checked);
    renderSelBar();
    return;
  }
  if (e.target.closest('[data-open]')) return openEntry(entry);

  const act = e.target.dataset.act;
  if (act === 'edit') return editFile(full);
  if (act === 'download') return download([full]);
  if (act === 'delete') return deletePaths([full]);
  if (act === 'rename') {
    const nn = await dialog({ title: 'Umbenennen', input: name, okText: 'Umbenennen' });
    if (!nn || nn === name) return;
    if (nn.includes('/')) return toast('Name darf keinen Schrägstrich enthalten', 'err');
    const res = await window.fire.fs.rename(rs.rid, full, joinPath(fm.cwd, nn));
    res.ok ? loadFiles() : toast(res.error, 'err');
  }
  if (act === 'chmod') {
    const mode = await dialog({ title: `Rechte von „${name}“`, text: 'Oktal, z. B. 644 für Dateien oder 755 für Ordner/Skripte.', input: entry.mode.padStart(3, '0'), okText: 'Setzen' });
    if (!mode) return;
    if (!/^[0-7]{3,4}$/.test(mode)) return toast('Ungültige Rechte – 3 oder 4 Ziffern von 0–7', 'err');
    const res = await window.fire.fs.chmod(rs.rid, full, mode);
    res.ok ? loadFiles() : toast(res.error, 'err');
  }
});

$('#fmRows').addEventListener('dblclick', (e) => {
  const tr = e.target.closest('tr[data-name]');
  if (tr && !e.target.closest('button, input')) openEntry(entryOf(tr.dataset.name));
});

function openEntry(entry) {
  if (!entry) return;
  if (isDir(entry)) return loadFiles(joinPath(fm.cwd, entry.name));
  editFile(joinPath(fm.cwd, entry.name));
}

$('#fmCheckAll').addEventListener('change', (e) => {
  sortedEntries().forEach((en) => (e.target.checked ? fm.sel.add(en.name) : fm.sel.delete(en.name)));
  renderFiles();
});
$$('.fm-table th[data-sort]').forEach((th) => th.addEventListener('click', () => {
  fm.sort = { key: th.dataset.sort, desc: fm.sort.key === th.dataset.sort ? !fm.sort.desc : false };
  renderFiles();
}));
$('#fmFilter').addEventListener('input', (e) => { fm.filter = e.target.value; renderFiles(); });
$('#fmUp').addEventListener('click', () => fm.cwd && loadFiles(parentPath(fm.cwd)));
$('#fmHome').addEventListener('click', () => loadFiles(rs.home));
$('#fmRefresh').addEventListener('click', () => loadFiles());

// Pfadleiste: Klick auf Teil navigiert, Klick daneben macht sie editierbar
$('#fmCrumbs').addEventListener('click', (e) => {
  const go = e.target.dataset.go;
  if (go) return loadFiles(go);
  $('#fmCrumbs').classList.add('hidden');
  const p = $('#fmPath');
  p.classList.remove('hidden');
  p.value = fm.cwd || '/';
  p.focus();
  p.select();
});
$('#fmPath').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { loadFiles(e.target.value.trim() || '/'); e.target.blur(); }
  if (e.key === 'Escape') e.target.blur();
});
$('#fmPath').addEventListener('blur', () => { $('#fmPath').classList.add('hidden'); $('#fmCrumbs').classList.remove('hidden'); });

$('#fmNewFolder').addEventListener('click', async () => {
  const name = await dialog({ title: 'Neuer Ordner', input: '', okText: 'Anlegen' });
  if (!name) return;
  const res = await window.fire.fs.mkdir(rs.rid, joinPath(fm.cwd, name));
  res.ok ? loadFiles() : toast(res.error, 'err');
});
$('#fmNewFile').addEventListener('click', async () => {
  const name = await dialog({ title: 'Neue Datei', input: '', okText: 'Anlegen' });
  if (!name) return;
  const full = joinPath(fm.cwd, name);
  const res = await window.fire.fs.touch(rs.rid, full);
  if (!res.ok) return toast(res.error, 'err');
  await loadFiles();
  editFile(full);
});

// Mehrfachauswahl
$('#fmSelClear').addEventListener('click', () => { fm.sel.clear(); renderFiles(); });
$('#fmSelDownload').addEventListener('click', () => download([...fm.sel].map((n) => joinPath(fm.cwd, n))));
$('#fmSelDelete').addEventListener('click', () => deletePaths([...fm.sel].map((n) => joinPath(fm.cwd, n))));

async function deletePaths(paths) {
  const names = paths.map((p) => p.split('/').pop());
  const hasDir = paths.some((p) => isDir(entryOf(p.split('/').pop()) || {}));
  const ok = await dialog({
    title: paths.length === 1 ? `„${names[0]}“ löschen?` : `${paths.length} Einträge löschen?`,
    text: `${hasDir ? 'Ordner werden mit ihrem gesamten Inhalt gelöscht. ' : ''}Das kann nicht rückgängig gemacht werden.${paths.length > 1 ? '\n' + names.slice(0, 8).join(', ') + (names.length > 8 ? ' …' : '') : ''}`,
    okText: 'Endgültig löschen',
    danger: true,
  });
  if (!ok) return;
  const res = await window.fire.fs.remove(rs.rid, paths);
  if (!res.ok) toast(res.error, 'err');
  else toast(paths.length === 1 ? 'Gelöscht' : `${paths.length} Einträge gelöscht`, 'ok');
  paths.forEach((p) => fm.sel.delete(p.split('/').pop()));
  loadFiles();
}

// ---- Übertragungen (Panel unten links, in allen Tabs sichtbar) ----
const transfers = new Map(); // tid -> { el, samples, label }
let tidCounter = 0;

function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '–';
  if (sec < 60) return `${Math.ceil(sec)} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s`;
  return `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`;
}

function renderTransferPanel() {
  $('#transferPanel').classList.toggle('hidden', transfers.size === 0);
  $('#tpCount').textContent = transfers.size === 1 ? '1 Übertragung' : `${transfers.size} Übertragungen`;
}

function transferStart(direction, label) {
  const tid = `t${Date.now()}-${++tidCounter}`;
  const el = document.createElement('div');
  el.className = `tp-item ${direction}`;
  el.innerHTML = `
    <div class="tp-row">
      <span class="tp-dir">${direction === 'up' ? '↑' : '↓'}</span>
      <span class="tp-label" title="${esc(label)}">${esc(label)}</span>
      <button class="tp-cancel" title="Abbrechen">✕</button>
    </div>
    <div class="tp-bar"><span></span></div>
    <div class="tp-row tp-meta">
      <span class="tp-pct">Vorbereiten…</span>
      <span class="tp-file"></span>
      <span class="tp-speed"></span>
    </div>`;
  el.querySelector('.tp-cancel').addEventListener('click', async () => {
    el.querySelector('.tp-cancel').disabled = true;
    el.querySelector('.tp-pct').textContent = 'Breche ab…';
    await window.fire.fs.cancel(tid);
  });
  $('#tpList').prepend(el);
  transfers.set(tid, { el, samples: [], label });
  $('#transferPanel').classList.remove('collapsed');
  renderTransferPanel();
  return tid;
}

function transferEnd(tid, text, kind = 'ok') {
  const t = transfers.get(tid);
  if (!t) return;
  t.el.classList.add(kind);
  t.el.querySelector('.tp-cancel')?.remove();
  t.el.querySelector('.tp-pct').textContent = text;
  t.el.querySelector('.tp-speed').textContent = '';
  t.el.querySelector('.tp-file').textContent = '';
  if (kind === 'ok') t.el.querySelector('.tp-bar span').style.width = '100%';
  setTimeout(() => { t.el.remove(); transfers.delete(tid); renderTransferPanel(); }, kind === 'ok' ? 4000 : 9000);
}

window.fire.fs.onProgress(({ tid, phase, name, done, total, files, filesDone }) => {
  const t = transfers.get(tid);
  if (!t) return;
  const q = (sel) => t.el.querySelector(sel);
  if (phase === 'scan') {
    q('.tp-pct').textContent = `Ermittle Dateien… ${files || ''}`;
    return;
  }
  if (phase === 'cancel') return;
  const pct = total ? Math.min(100, (done / total) * 100) : 100;
  q('.tp-bar span').style.width = `${pct}%`;
  q('.tp-pct').textContent = `${pct.toFixed(pct < 10 ? 1 : 0)} % · ${fmtBytes(done)} / ${fmtBytes(total)}`;
  q('.tp-file').textContent = files > 1 ? `Datei ${Math.min(filesDone + 1, files)}/${files}: ${name}` : name;

  // Tempo über die letzten ~3 s glätten
  const now = Date.now();
  t.samples.push([now, done]);
  while (t.samples.length > 2 && now - t.samples[0][0] > 3000) t.samples.shift();
  const [t0, d0] = t.samples[0];
  const speed = now > t0 ? ((done - d0) / (now - t0)) * 1000 : 0;
  if (speed > 0 && done < total) q('.tp-speed').textContent = `${fmtBytes(speed)}/s · noch ${fmtDuration((total - done) / speed)}`;
});

$('#tpToggle').addEventListener('click', () => $('#transferPanel').classList.toggle('collapsed'));

async function upload(localPaths) {
  if (!localPaths.length || !fm.cwd) return;
  const dir = fm.cwd;
  const first = localPaths[0].split(/[\\/]/).pop();
  const tid = transferStart('up', localPaths.length === 1 ? `${first} → ${dir}` : `${localPaths.length} Elemente → ${dir}`);
  const res = await window.fire.fs.upload(rs.rid, dir, localPaths, tid);
  if (res.ok && res.canceled) transferEnd(tid, `Abgebrochen (${res.count} Datei(en) fertig)`, 'warn');
  else if (res.ok) transferEnd(tid, `Fertig · ${res.count} Datei(en), ${fmtBytes(res.bytes)}`);
  else { transferEnd(tid, `Fehler: ${res.error}`, 'err'); toast(`Upload: ${res.error}`, 'err'); }
  if (fm.cwd === dir) loadFiles();
}

async function download(paths) {
  if (!paths.length) return;
  const tid = transferStart('down', paths.length === 1 ? paths[0].split('/').pop() : `${paths.length} Elemente`);
  const res = await window.fire.fs.download(rs.rid, paths, tid);
  if (res.ok && res.canceled) {
    if (res.dialog) {
      transfers.get(tid)?.el.remove();
      transfers.delete(tid);
      renderTransferPanel();
      return;
    }
    return transferEnd(tid, `Abgebrochen (${res.count} Datei(en) fertig)`, 'warn');
  }
  if (!res.ok) { transferEnd(tid, `Fehler: ${res.error}`, 'err'); return toast(`Download: ${res.error}`, 'err'); }
  transferEnd(tid, `Fertig · ${res.count} Datei(en), ${fmtBytes(res.bytes)}`);
  window.fire.fs.showItem(res.target);
}

$('#fmUpload').addEventListener('click', (e) => { e.stopPropagation(); $('#fmUploadMenu').classList.toggle('hidden'); });
document.addEventListener('click', () => $('#fmUploadMenu').classList.add('hidden'));
$('#fmUploadMenu').addEventListener('click', async (e) => {
  const kind = e.target.dataset.upload;
  if (!kind) return;
  upload(await window.fire.fs.pickUpload(kind));
});

// Drag & Drop aus dem Explorer
let dragDepth = 0;
const dropZone = $('#fmDrop');
dropZone.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; $('#fmDropHint').classList.remove('hidden'); } });
dropZone.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#fmDropHint').classList.add('hidden'); } });
dropZone.addEventListener('dragover', (e) => e.preventDefault());
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#fmDropHint').classList.add('hidden');
  const paths = [...e.dataTransfer.files].map((f) => window.fire.fs.pathForFile(f)).filter(Boolean);
  upload(paths);
});

// ================== Editor ==================
const ed = { path: null, original: '', kind: 'file', saving: false };

async function editFile(path, kind = 'file') {
  const rid = await ensureRemote();
  if (!rid) return;
  const res = await window.fire.fs.read(rid, path);
  if (!res.ok) {
    if (/Binärdatei|zu groß/.test(res.error)) {
      const ok = await dialog({ title: 'Nicht bearbeitbar', text: `${res.error}.`, okText: 'Herunterladen' });
      if (ok) download([path]);
    } else toast(res.error, 'err');
    return;
  }
  openEditor(path, res.text, kind);
}

function openEditor(path, text, kind) {
  Object.assign(ed, { path, original: text, kind });
  $('#edPath').textContent = path;
  $('#edText').value = text;
  $('#edError').classList.add('hidden');
  $('#edRevert').classList.add('hidden');
  $('#edSave').textContent = kind === 'nginx' ? 'Speichern & testen' : 'Speichern';
  updateEditorMeta();
  $('#editor').classList.remove('hidden');
  const ta = $('#edText');
  ta.focus();
  ta.setSelectionRange(0, 0);
  ta.scrollTop = 0;
}

function updateEditorMeta() {
  const ta = $('#edText');
  const lines = ta.value.split('\n').length;
  $('#edGutter').textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
  $('#edGutter').scrollTop = ta.scrollTop;
  $('#edDirty').classList.toggle('hidden', ta.value === ed.original);
  $('#edInfo').textContent = `${lines} Zeilen · ${fmtBytes(new Blob([ta.value]).size)}`;
}

$('#edText').addEventListener('input', updateEditorMeta);
$('#edText').addEventListener('scroll', (e) => { $('#edGutter').scrollTop = e.target.scrollTop; });
$('#edText').addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    document.execCommand('insertText', false, '    ');
  }
  if (e.key === 's' && e.ctrlKey) { e.preventDefault(); saveEditor(); }
  if (e.key === 'Escape') closeEditor();
});

async function closeEditor() {
  if ($('#edText').value !== ed.original) {
    const ok = await dialog({ title: 'Ungespeicherte Änderungen verwerfen?', okText: 'Verwerfen', danger: true });
    if (!ok) return;
  }
  $('#editor').classList.add('hidden');
}

function editorMessage(text, ok) {
  const el = $('#edError');
  el.textContent = text;
  el.classList.toggle('ok', ok);
  el.classList.remove('hidden');
}

async function saveEditor() {
  if (ed.saving) return;
  ed.saving = true;
  $('#edSave').disabled = true;
  const text = $('#edText').value;
  const before = ed.original;
  const res = await window.fire.fs.write(rs.rid, ed.path, text);
  if (!res.ok) {
    editorMessage(`Speichern fehlgeschlagen: ${res.error}`, false);
  } else {
    ed.original = text;
    if (ed.kind === 'nginx') {
      const t = await nginxTestAndReload();
      if (t.ok) {
        editorMessage(`Gespeichert, Test erfolgreich, Nginx neu geladen.\n${t.output}`, true);
        ed.previous = null;
        $('#edRevert').classList.add('hidden');
      } else {
        editorMessage(`Gespeichert, aber nginx -t meldet Fehler – Nginx wurde NICHT neu geladen:\n${t.output}`, false);
        ed.previous = before;
        $('#edRevert').classList.remove('hidden');
      }
      loadNginx();
    } else {
      toast('Gespeichert', 'ok');
      if (fm.cwd && parentPath(ed.path) === fm.cwd) loadFiles();
    }
  }
  updateEditorMeta();
  ed.saving = false;
  $('#edSave').disabled = false;
}

$('#edSave').addEventListener('click', saveEditor);
$('#edClose').addEventListener('click', closeEditor);
$('#edRevert').addEventListener('click', async () => {
  if (ed.previous == null) return;
  const res = await window.fire.fs.write(rs.rid, ed.path, ed.previous);
  if (!res.ok) return editorMessage(`Zurücknehmen fehlgeschlagen: ${res.error}`, false);
  ed.original = ed.previous;
  ed.previous = null;
  $('#edRevert').classList.add('hidden');
  const t = await run('nginx -t 2>&1');
  editorMessage(`Alte Version wiederhergestellt. Deine Änderung ist noch im Editor.\n${t.stdout}${t.stderr}`, t.ok);
  updateEditorMeta();
});

// ================== Nginx ==================
const ngx = { info: null, type: 'proxy' };
const NGX = '/etc/nginx';

async function loadNginx() {
  const rid = await ensureRemote({ silent: true });
  if (!rid) return;
  const script = [
    `echo "@@inst"; command -v nginx`,
    `echo "@@ver"; nginx -v 2>&1`,
    `echo "@@active"; systemctl is-active nginx 2>/dev/null`,
    `echo "@@layout"; [ -d ${NGX}/sites-available ] && echo debian`,
    `echo "@@avail"; ls -1A ${NGX}/sites-available 2>/dev/null`,
    `echo "@@enabled"; for f in ${NGX}/sites-enabled/*; do [ -e "$f" ] && readlink -f "$f"; done 2>/dev/null`,
    `echo "@@confd"; ls -1A ${NGX}/conf.d 2>/dev/null`,
    `echo "@@grep"; grep -HE '^[[:space:]]*(server_name|listen)[[:space:]]' ${NGX}/sites-available/* ${NGX}/conf.d/* 2>/dev/null`,
    'true',
  ].join('; ');
  const r = await run(script);
  const sec = {};
  let cur = null;
  for (const line of (r.stdout || '').split('\n')) {
    if (line.startsWith('@@')) { cur = line.slice(2).trim(); sec[cur] = []; } else if (cur && line.trim()) sec[cur].push(line.trim());
  }
  if (!sec.inst) {
    // sudo ohne Passwort nicht erlaubt o. Ä.
    showNgxOutput('Fehler', r.stderr || 'Keine Antwort vom Server', false);
    return;
  }

  const meta = {};
  for (const l of sec.grep || []) {
    const m = l.match(/^([^:]+):\s*(server_name|listen)\s+(.+?);?\s*(#.*)?$/);
    if (!m) continue;
    const f = (meta[m[1]] ||= { names: new Set(), listen: new Set() });
    if (m[2] === 'server_name') m[3].split(/\s+/).forEach((n) => n && f.names.add(n));
    else f.listen.add(m[3].split(/\s+/)[0]);
  }

  ngx.info = {
    installed: (sec.inst || []).length > 0,
    version: (sec.ver || []).join(' ').replace(/^nginx version:\s*/, ''),
    active: (sec.active || [])[0] || 'unknown',
    debian: (sec.layout || []).includes('debian'),
    avail: sec.avail || [],
    enabled: new Set(sec.enabled || []),
    confd: sec.confd || [],
    meta,
  };
  renderNginx();
}

function renderNginx() {
  const i = ngx.info;
  const pill = $('#ngxStatus');
  if (!i.installed) { pill.className = 'pill pill-muted'; pill.textContent = 'Nicht installiert'; }
  else if (i.active === 'active') { pill.className = 'pill pill-ok'; pill.textContent = 'Läuft'; }
  else { pill.className = 'pill pill-bad'; pill.textContent = i.active === 'inactive' ? 'Gestoppt' : i.active; }
  $('#ngxVersion').textContent = i.version;
  $('#ngxMissing').classList.toggle('hidden', i.installed);
  $('#ngxContent').classList.toggle('hidden', !i.installed);
  ['#ngxTest', '#ngxReload', '#ngxRestart', '#ngxLogs', '#ngxNew'].forEach((s) => ($(s).disabled = !i.installed));
  if (!i.installed) return;

  const metaLine = (file) => {
    const m = i.meta[file];
    if (!m) return '<span class="muted">kein server-Block gefunden</span>';
    const names = [...m.names].filter((n) => n !== '_');
    return `${esc(names.join(', ') || 'Standard-Server')}${m.listen.size ? ` · Port ${esc([...m.listen].join(', '))}` : ''}`;
  };

  const item = ({ file, label, enabled, toggle }) => `
    <div class="ngx-item" data-file="${esc(file)}">
      ${toggle ? `<label class="toggle" title="${enabled ? 'Aktiv – klicken zum Deaktivieren' : 'Inaktiv – klicken zum Aktivieren'}">
        <input type="checkbox" data-toggle ${enabled ? 'checked' : ''}><span></span></label>` : ''}
      <div class="info">
        <div class="fname">${esc(label)}</div>
        <div class="names">${metaLine(file)}</div>
      </div>
      <div class="acts">
        <button class="btn btn-sm btn-ghost" data-ngx-edit>Bearbeiten</button>
        ${toggle ? '<button class="btn btn-sm btn-danger" data-ngx-del>Löschen</button>' : ''}
      </div>
    </div>`;

  let sites;
  let other = [{ file: `${NGX}/nginx.conf`, label: 'nginx.conf' }];
  if (i.debian) {
    $('#ngxSitesTitle').textContent = 'Sites (sites-available)';
    sites = i.avail.map((n) => ({ file: `${NGX}/sites-available/${n}`, label: n, enabled: i.enabled.has(`${NGX}/sites-available/${n}`), toggle: true }));
    other = other.concat(i.confd.map((n) => ({ file: `${NGX}/conf.d/${n}`, label: `conf.d/${n}` })));
  } else {
    $('#ngxSitesTitle').textContent = 'Sites (conf.d)';
    sites = i.confd.map((n) => ({
      file: `${NGX}/conf.d/${n}`,
      label: n.replace(/\.disabled$/, ''),
      enabled: n.endsWith('.conf'),
      toggle: true,
    }));
  }
  $('#ngxSites').innerHTML = sites.length ? sites.map(item).join('') : '<span class="muted">Noch keine Sites – lege mit „Neue Site“ eine an.</span>';
  $('#ngxOther').innerHTML = other.map(item).join('');
}

function showNgxOutput(title, text, ok) {
  const card = $('#ngxOutputCard');
  $('#ngxOutputTitle').textContent = title;
  $('#ngxOutput').textContent = text.trim() || '(keine Ausgabe)';
  card.classList.remove('hidden', 'ok', 'err');
  if (ok !== undefined) card.classList.add(ok ? 'ok' : 'err');
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
$('#ngxOutputClose').addEventListener('click', () => $('#ngxOutputCard').classList.add('hidden'));

async function nginxTestAndReload() {
  const t = await run('nginx -t 2>&1');
  const output = `${t.stdout}${t.stderr}`.trim();
  if (!t.ok) return { ok: false, output };
  const r = await run('systemctl reload nginx 2>&1 || nginx -s reload 2>&1');
  return { ok: r.ok, output: `${output}\n${r.stdout}${r.stderr}`.trim() };
}

async function ngxAction(title, cmd) {
  const btns = ['#ngxTest', '#ngxReload', '#ngxRestart'].map((s) => $(s));
  btns.forEach((b) => (b.disabled = true));
  const r = await run(cmd);
  btns.forEach((b) => (b.disabled = false));
  showNgxOutput(title, `${r.stdout}${r.stderr}` || (r.ok ? 'OK' : `Fehlgeschlagen (Code ${r.code})`), r.ok);
  loadNginx();
}

$('#ngxTest').addEventListener('click', () => ngxAction('nginx -t', 'nginx -t 2>&1'));
$('#ngxReload').addEventListener('click', () => ngxAction('Neu laden', 'nginx -t 2>&1 && (systemctl reload nginx 2>&1 || nginx -s reload 2>&1) && echo "Nginx neu geladen."'));
$('#ngxRestart').addEventListener('click', async () => {
  const ok = await dialog({ title: 'Nginx neu starten?', text: 'Laufende Verbindungen werden kurz unterbrochen. Vorher wird die Konfiguration getestet.', okText: 'Neu starten' });
  if (ok) ngxAction('Neustart', 'nginx -t 2>&1 && systemctl restart nginx 2>&1 && echo "Nginx neu gestartet."');
});
$('#ngxLogs').addEventListener('click', async () => {
  const r = await run(`tail -n 150 /var/log/nginx/error.log 2>&1`);
  showNgxOutput('error.log (letzte 150 Zeilen)', `${r.stdout}${r.stderr}`);
});
$('#ngxInstall').addEventListener('click', async () => {
  const ok = await dialog({ title: 'Nginx installieren?', text: 'Führt „apt-get update && apt-get install -y nginx“ auf dem Server aus. Das kann 1–2 Minuten dauern.', okText: 'Installieren' });
  if (!ok) return;
  const btn = $('#ngxInstall');
  btn.disabled = true; btn.textContent = 'Installiere…';
  const r = await run('export DEBIAN_FRONTEND=noninteractive; apt-get update -q 2>&1 && apt-get install -y -q nginx 2>&1', 600000);
  btn.disabled = false; btn.textContent = 'Nginx installieren';
  showNgxOutput('Installation', (r.stdout + r.stderr).split('\n').slice(-40).join('\n'), r.ok);
  loadNginx();
});

// Site aktivieren/deaktivieren, mit Test und Rücknahme bei Fehler
async function setSiteEnabled(file, enable) {
  const name = file.split('/').pop();
  let on, off;
  if (ngx.info.debian) {
    on = `ln -sf ${shq(file)} ${shq(`${NGX}/sites-enabled/${name}`)}`;
    off = `for f in ${NGX}/sites-enabled/*; do [ "$(readlink -f "$f")" = ${shq(file)} ] && rm -f "$f"; done; true`;
  } else {
    const base = file.replace(/\.disabled$/, '');
    on = `mv ${shq(file)} ${shq(base)}`;
    off = `mv ${shq(file)} ${shq(`${base}.disabled`)}`;
  }
  const r1 = await run(enable ? on : off);
  if (!r1.ok) { showNgxOutput('Fehler', r1.stderr || r1.stdout, false); return loadNginx(); }
  const t = await nginxTestAndReload();
  if (!t.ok) {
    // Zustand zurückdrehen
    if (ngx.info.debian) await run(enable ? off : on);
    else {
      const base = file.replace(/\.disabled$/, '');
      await run(enable ? `mv ${shq(base)} ${shq(`${base}.disabled`)}` : `mv ${shq(`${base}.disabled`)} ${shq(base)}`);
    }
    showNgxOutput(`${name} – Test fehlgeschlagen, Änderung zurückgenommen`, t.output, false);
  } else {
    toast(`${name} ${enable ? 'aktiviert' : 'deaktiviert'} – Nginx neu geladen`, 'ok');
  }
  loadNginx();
}

$('#ngxContent').addEventListener('click', async (e) => {
  const item = e.target.closest('.ngx-item');
  if (!item) return;
  const file = item.dataset.file;
  if (e.target.closest('[data-ngx-edit]')) return editFile(file, 'nginx');
  if (e.target.closest('[data-ngx-del]')) {
    const name = file.split('/').pop();
    const ok = await dialog({ title: `Site „${name}“ löschen?`, text: 'Die Konfigurationsdatei wird gelöscht und Nginx neu geladen.', okText: 'Löschen', danger: true });
    if (!ok) return;
    if (ngx.info.debian) await run(`for f in ${NGX}/sites-enabled/*; do [ "$(readlink -f "$f")" = ${shq(file)} ] && rm -f "$f"; done; true`);
    const r = await run(`rm -f -- ${shq(file)}`);
    if (!r.ok) return showNgxOutput('Fehler', r.stderr, false);
    const t = await nginxTestAndReload();
    t.ok ? toast(`${name} gelöscht`, 'ok') : showNgxOutput('Gelöscht, aber nginx -t meldet Fehler', t.output, false);
    loadNginx();
  }
});
$('#ngxContent').addEventListener('change', (e) => {
  if (!e.target.matches('[data-toggle]')) return;
  e.target.disabled = true;
  setSiteEnabled(e.target.closest('.ngx-item').dataset.file, e.target.checked);
});

// ---- Neue Site ----
function ngxTargetFile() {
  const first = $('#nsDomains').value.trim().split(/\s+/)[0] || 'example.de';
  return ngx.info?.debian ? `${NGX}/sites-available/${first}` : `${NGX}/conf.d/${first}.conf`;
}

function setNsType(type) {
  ngx.type = type;
  $$('#nsType button').forEach((b) => b.classList.toggle('active', b.dataset.type === type));
  $('#nsUpstreamField').classList.toggle('hidden', type !== 'proxy');
  $('#nsWebsocket').closest('.check').classList.toggle('hidden', type !== 'proxy');
  $('#nsRootField').classList.toggle('hidden', type === 'proxy');
}

$('#ngxNew').addEventListener('click', () => {
  $('#nsDomains').value = '';
  $('#nsRoot').value = '';
  $('#nsError').classList.add('hidden');
  setNsType('proxy');
  $('#nsTarget').textContent = ngxTargetFile();
  $('#ngxNewModal').classList.remove('hidden');
  setTimeout(() => $('#nsDomains').focus(), 0);
});
$$('[data-close-ngx]').forEach((b) => b.addEventListener('click', () => $('#ngxNewModal').classList.add('hidden')));
$('#nsType').addEventListener('click', (e) => e.target.dataset.type && setNsType(e.target.dataset.type));
$('#nsDomains').addEventListener('input', () => {
  $('#nsTarget').textContent = ngxTargetFile();
  const first = $('#nsDomains').value.trim().split(/\s+/)[0];
  $('#nsRoot').placeholder = `/var/www/${first || 'example.de'}`;
});

function buildSiteConfig({ domains, type, upstream, root, websocket }) {
  const head = `server {\n    listen 80;\n    listen [::]:80;\n    server_name ${domains.join(' ')};\n`;
  if (type === 'proxy') {
    return `${head}
    client_max_body_size 50m;

    location / {
        proxy_pass ${upstream};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;${websocket ? `
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";` : ''}
        proxy_read_timeout 300s;
    }
}
`;
  }
  if (type === 'static') {
    return `${head}
    root ${root};
    index index.html index.htm;

    location / {
        try_files $uri $uri/ =404;
    }
}
`;
  }
  return `${head}
    root ${root};
    index index.php index.html;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php-fpm.sock;
    }

    location ~ /\\.ht {
        deny all;
    }
}
`;
}

$('#nsCreate').addEventListener('click', async () => {
  const err = $('#nsError');
  err.classList.add('hidden');
  const fail = (msg) => { err.textContent = msg; err.classList.remove('hidden'); };
  const domains = $('#nsDomains').value.trim().split(/\s+/).filter(Boolean);
  if (!domains.length) return fail('Bitte mindestens eine Domain eintragen.');
  if (!domains.every((d) => /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d))) return fail('Ungültige Domain – nur Buchstaben, Ziffern, Punkte und Bindestriche.');
  const type = ngx.type;
  const upstream = $('#nsUpstream').value.trim();
  if (type === 'proxy' && !/^https?:\/\/[^\s;]+$/.test(upstream)) return fail('„Weiterleiten an“ muss mit http:// oder https:// beginnen, z. B. http://127.0.0.1:3000');
  const root = $('#nsRoot').value.trim() || `/var/www/${domains[0]}`;
  if (type !== 'proxy' && !/^\/[^\s;]*$/.test(root)) return fail('Webroot muss ein absoluter Pfad ohne Leerzeichen sein.');

  const file = ngxTargetFile();
  const btn = $('#nsCreate');
  btn.disabled = true;
  try {
    const exists = await run(`test -e ${shq(file)}`);
    if (exists.ok) return fail(`${file} existiert bereits.`);
    if (type !== 'proxy') await run(`mkdir -p ${shq(root)}`);
    const res = await window.fire.fs.write(rs.rid, file, buildSiteConfig({ domains, type, upstream, root, websocket: $('#nsWebsocket').checked }));
    if (!res.ok) return fail(`Datei konnte nicht geschrieben werden: ${res.error}`);
    $('#ngxNewModal').classList.add('hidden');
    await loadNginx();
    if ($('#nsEnable').checked) {
      if (ngx.info.debian) await setSiteEnabled(file, true);
      else {
        const t = await nginxTestAndReload();
        if (!t.ok) { await run(`mv ${shq(file)} ${shq(`${file}.disabled`)}`); showNgxOutput('Test fehlgeschlagen – Site deaktiviert', t.output, false); }
        else toast('Site angelegt und Nginx neu geladen', 'ok');
        loadNginx();
      }
    } else {
      toast('Site angelegt (noch nicht aktiv)', 'ok');
    }
  } finally {
    btn.disabled = false;
  }
});
