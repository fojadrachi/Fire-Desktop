// App-Updates über GitHub-Releases: neueste Version prüfen, Setup laden, SHA-256 prüfen, still installieren.
// Das Setup startet Fire Desktop danach neu. Gleiches Vorgehen wie beim NNN Launcher.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const LATEST = 'https://api.github.com/repos/fojadrachi/Fire-Desktop/releases/latest';
const SETUP_PREFIX = 'Fire-Desktop-Setup-';

const parse = (v) => {
  const p = String(v).replace(/^[vV]/, '').split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  return [p[0] || 0, p[1] || 0, p[2] || 0];
};

function isNewer(tag, current) {
  const [a, b] = [parse(tag), parse(current)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

module.exports = function createUpdater({ version, send, quit }) {
  let info = null;

  // Portable Version: läuft aus dem Temp-Ordner, dort gibt es nichts zu ersetzen
  const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_FILE;

  async function check() {
    const res = await fetch(LATEST, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Fire-Desktop/${version}` },
    });
    if (res.status === 404) {
      info = { available: false, current: version };
      return info;
    }
    if (!res.ok) throw new Error(`GitHub antwortet mit HTTP ${res.status}`);
    const rel = await res.json();
    const asset = (rel.assets || []).find((a) => a.name.startsWith(SETUP_PREFIX) && a.name.toLowerCase().endsWith('.exe'));
    info = {
      available: isNewer(rel.tag_name, version) && !!asset,
      current: version,
      latest: String(rel.tag_name || '').replace(/^[vV]/, ''),
      notes: rel.body || '',
      url: asset?.browser_download_url || '',
      page: rel.html_url || '',
      size: asset?.size || 0,
      sha256: asset?.digest?.startsWith('sha256:') ? asset.digest.slice(7).toLowerCase() : null,
      portable: isPortable(),
    };
    return info;
  }

  // Lädt das Setup mit Fortschritt und prüft die Prüfsumme; gibt den Dateipfad zurück
  async function download() {
    if (!info?.available || !info.url.startsWith('https://github.com/')) throw new Error('Kein gültiges Update verfügbar');
    const dir = path.join(os.tmpdir(), 'fire-desktop-update');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${SETUP_PREFIX}${info.latest}.exe`);
    fs.rmSync(file, { force: true });

    const res = await fetch(info.url, { headers: { 'User-Agent': `Fire-Desktop/${version}` } });
    if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (HTTP ${res.status})`);
    const total = Number(res.headers.get('content-length')) || info.size;
    const hash = crypto.createHash('sha256');
    let done = 0;
    let last = 0;
    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => {
      hash.update(chunk);
      done += chunk.length;
      if (Date.now() - last > 150) { last = Date.now(); send('update:progress', { done, total }); }
    });
    await pipeline(body, fs.createWriteStream(file));
    send('update:progress', { done: total, total });

    if (info.sha256 && hash.digest('hex') !== info.sha256) {
      fs.rmSync(file, { force: true });
      throw new Error('Prüfsumme des Updates stimmt nicht – abgebrochen.');
    }
    return file;
  }

  async function install() {
    const file = await download();
    // /S = still, --updated = Verknüpfungen behalten, --force-run = danach neu starten
    spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(quit, 300);
    return true;
  }

  return { check, download, install, isPortable };
};
