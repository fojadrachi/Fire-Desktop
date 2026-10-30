// App-Updates: prüft beim Start und alle 6 Stunden, zeigt den Hinweis in der Seitenleiste.

let upInfo = null;
let upBusy = false;

function upShowBar() {
  const bar = $('#updateBar');
  bar.classList.toggle('hidden', !upInfo?.available);
  if (upInfo?.available) bar.textContent = `Update ${upInfo.latest} verfügbar`;
}

async function upCheck(manual = false) {
  const res = await window.fire.update.check();
  if (!res.ok) {
    if (manual) toast(`Update-Prüfung: ${res.error}`, 'err');
    return;
  }
  upInfo = res.data;
  upShowBar();
  if (manual) {
    if (upInfo.available) upOpen();
    else toast(`Fire Desktop ist aktuell (Version ${upInfo.current})`, 'ok');
  }
}

function upOpen() {
  if (!upInfo?.available) return;
  $('#upTitle').textContent = `Update auf Version ${upInfo.latest}`;
  $('#upInfo').textContent = upInfo.portable
    ? `Du nutzt die portable Version ${upInfo.current}. Sie lässt sich nicht selbst ersetzen – lade die neue Version von GitHub.`
    : `Installiert ist Version ${upInfo.current}. Fire Desktop startet nach dem Update automatisch neu.`;
  $('#upNotes').textContent = upInfo.notes || '';
  $('#upNotes').classList.toggle('hidden', !upInfo.notes);
  $('#upBar').classList.add('hidden');
  $('#upStatus').textContent = '';
  $('#upError').classList.add('hidden');
  $('#upInstall').textContent = upInfo.portable ? 'Download-Seite öffnen' : 'Jetzt aktualisieren';
  $('#upInstall').disabled = false;
  $('#updateModal').classList.remove('hidden');
}

$('#updateBar').addEventListener('click', upOpen);
$('#updateCheck').addEventListener('click', (e) => { e.preventDefault(); upCheck(true); });
$$('[data-close-update]').forEach((b) => b.addEventListener('click', () => { if (!upBusy) $('#updateModal').classList.add('hidden'); }));

$('#upInstall').addEventListener('click', async () => {
  if (upInfo.portable) { window.fire.openExternal(upInfo.page); return; }
  upBusy = true;
  $('#upInstall').disabled = true;
  $('#upError').classList.add('hidden');
  $('#upBar').classList.remove('hidden');
  $('#upStatus').textContent = 'Lade Update…';
  const res = await window.fire.update.install();
  upBusy = false;
  if (res.ok) {
    $('#upStatus').textContent = 'Installiere – Fire Desktop startet gleich neu…';
    return;
  }
  $('#upInstall').disabled = false;
  $('#upError').textContent = res.error;
  $('#upError').classList.remove('hidden');
  $('#upStatus').textContent = '';
});

window.fire.update.onProgress(({ done, total }) => {
  const pct = total ? (done / total) * 100 : 0;
  $('#upBar span').style.width = `${pct}%`;
  $('#upStatus').textContent = `Lade Update… ${pct.toFixed(0)} % · ${fmtBytes(done)} / ${fmtBytes(total)}`;
});

window.addEventListener('DOMContentLoaded', async () => {
  $('#appVersion').textContent = `Version ${await window.fire.update.version()}`;
  setTimeout(() => upCheck(), 4000);
  setInterval(() => upCheck(), 6 * 3600 * 1000);
});
