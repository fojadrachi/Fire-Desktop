// Minecraft-Server: RCON-Steuerung und Server-List-Ping (Status, Spieler, MOTD).
// Verbindung direkt oder durch einen SSH-Tunnel über einen der 24fire-Server (dann muss RCON nicht offen im Internet stehen).
const net = require('net');
const crypto = require('crypto');

const RCON = { AUTH: 3, COMMAND: 2, RESPONSE: 0 };

// ---------- Hilfen fürs Minecraft-Protokoll (Server List Ping) ----------
function varInt(n) {
  const out = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

function readVarInt(buf, offset) {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) return null;
    const b = buf[pos++];
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return { value, size: pos - offset };
    shift += 7;
    if (shift > 35) throw new Error('VarInt zu lang');
  }
}

const mcPacket = (id, payload = Buffer.alloc(0)) => {
  const body = Buffer.concat([varInt(id), payload]);
  return Buffer.concat([varInt(body.length), body]);
};

const mcString = (s) => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([varInt(b.length), b]);
};

// Chat-Komponente (MOTD) in Text mit §-Farbcodes umwandeln
const COLOR_CODES = {
  black: '0', dark_blue: '1', dark_green: '2', dark_aqua: '3', dark_red: '4', dark_purple: '5', gold: '6', gray: '7',
  dark_gray: '8', blue: '9', green: 'a', aqua: 'b', red: 'c', light_purple: 'd', yellow: 'e', white: 'f',
};
function chatToLegacy(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(chatToLegacy).join('');
  let s = '';
  if (c.color && COLOR_CODES[c.color]) s += `§${COLOR_CODES[c.color]}`;
  if (c.bold) s += '§l';
  if (c.italic) s += '§o';
  if (c.underlined) s += '§n';
  if (c.strikethrough) s += '§m';
  s += c.text || c.translate || '';
  if (c.extra) s += c.extra.map(chatToLegacy).join('');
  return s;
}

module.exports = function createMinecraft(d) {
  const rcons = new Map(); // mcId -> { sock, queue, nextId, pending, ready }
  const sshPool = new Map(); // kvmServerId -> Promise<conn>

  // ---------- Speicher ----------
  const list = () => d.loadStore().minecraft || [];
  const publicMc = (m) => ({
    id: m.id, name: m.name, host: m.host, gamePort: m.gamePort, rconPort: m.rconPort,
    via: m.via, sshServerId: m.sshServerId || null, passOk: d.decryptKey(m.rconPass) !== null,
  });

  function save(all) {
    const store = d.loadStore();
    store.minecraft = all;
    d.saveStore(store);
  }

  function normalize(input, existing = {}) {
    const m = { ...existing };
    m.name = String(input.name ?? existing.name ?? '').trim() || 'Minecraft';
    m.host = String(input.host ?? existing.host ?? '').trim();
    m.gamePort = Number(input.gamePort ?? existing.gamePort) || 25565;
    m.rconPort = Number(input.rconPort ?? existing.rconPort) || 25575;
    m.via = input.via === 'ssh' ? 'ssh' : (input.via === 'direct' ? 'direct' : (existing.via || 'direct'));
    m.sshServerId = m.via === 'ssh' ? (input.sshServerId ?? existing.sshServerId) : null;
    if (input.rconPass !== undefined && input.rconPass !== '') m.rconPass = d.encryptKey(String(input.rconPass));
    if (m.via === 'direct' && !m.host) throw new Error('Adresse fehlt');
    if (m.via === 'ssh' && !m.sshServerId) throw new Error('Kein 24fire-Server für den SSH-Tunnel gewählt');
    return m;
  }

  // ---------- Verbindungen (direkt oder durch SSH) ----------
  async function sshConn(kvmId) {
    if (!sshPool.has(kvmId)) {
      const p = (async () => {
        const s = d.loadStore().servers.find((x) => x.id === kvmId);
        if (!s) throw new Error('Der verknüpfte 24fire-Server existiert nicht mehr');
        const apiKey = d.decryptKey(s.key);
        if (apiKey === null) throw new Error(`API-Key von „${s.name}“ nicht lesbar – bitte neu eingeben`);
        const res = await d.request({ provider: s.provider, apiKey, env: s.env, method: 'GET', path: d.resolvePath(s, '/vm/:vmid/config') });
        if (!res.ok) throw new Error(res.error);
        const c = res.data?.config || {};
        const host = c.ipv4?.[0]?.ip_address;
        if (!host) throw new Error('Keine IP in der Server-Konfiguration');
        const r = await d.openSsh({ serverId: s.id, host, port: 22, username: c.username || 'root', password: c.password });
        if (!r.ok) throw new Error(`SSH-Tunnel: ${r.error}`);
        r.conn.on('close', () => sshPool.delete(kvmId));
        r.conn.on('error', () => {});
        return r.conn;
      })();
      sshPool.set(kvmId, p);
      p.catch(() => sshPool.delete(kvmId));
    }
    return sshPool.get(kvmId);
  }

  // Liefert einen Duplex-Stream zum Ziel-Port
  async function openStream(m, port, timeoutMs = 8000) {
    if (m.via === 'ssh') {
      const conn = await sshConn(m.sshServerId);
      return new Promise((resolve, reject) => {
        conn.forwardOut('127.0.0.1', 0, m.host && m.host !== 'localhost' ? m.host : '127.0.0.1', port, (err, stream) => {
          if (err) reject(new Error(`Port ${port} auf dem Server nicht erreichbar (${err.message})`));
          else resolve(stream);
        });
      });
    }
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: m.host, port });
      const timer = setTimeout(() => { sock.destroy(); reject(new Error(`Zeitüberschreitung bei ${m.host}:${port}`)); }, timeoutMs);
      sock.once('connect', () => { clearTimeout(timer); resolve(sock); });
      sock.once('error', (err) => {
        clearTimeout(timer);
        const msg = {
          ECONNREFUSED: `Verbindung abgelehnt (${m.host}:${port}) – läuft der Server bzw. ist der Port freigegeben?`,
          ENOTFOUND: `Adresse „${m.host}“ nicht gefunden`,
          EHOSTUNREACH: `${m.host} nicht erreichbar`,
        }[err.code] || err.message;
        reject(new Error(msg));
      });
    });
  }

  // ---------- Server List Ping ----------
  async function ping(m) {
    const started = Date.now();
    const sock = await openStream(m, m.gamePort);
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('Keine Status-Antwort (Zeitüberschreitung)')); }, 8000);
      const finish = (fn) => { clearTimeout(timer); sock.removeAllListeners('data'); sock.destroy?.(); sock.end?.(); fn(); };
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        try {
          const len = readVarInt(buf, 0);
          if (!len || buf.length < len.size + len.value) return;
          let pos = len.size;
          const id = readVarInt(buf, pos); pos += id.size;
          const strLen = readVarInt(buf, pos); pos += strLen.size;
          const json = JSON.parse(buf.subarray(pos, pos + strLen.value).toString('utf8'));
          finish(() => resolve({
            online: true,
            latency: Date.now() - started,
            version: json.version?.name || '?',
            protocol: json.version?.protocol,
            players: { online: json.players?.online ?? 0, max: json.players?.max ?? 0, sample: (json.players?.sample || []).map((p) => p.name) },
            motd: chatToLegacy(json.description),
            favicon: typeof json.favicon === 'string' && json.favicon.startsWith('data:image/') ? json.favicon : null,
          }));
        } catch (err) {
          finish(() => reject(new Error(`Ungültige Status-Antwort: ${err.message}`)));
        }
      });
      sock.on('error', (err) => finish(() => reject(err)));
      const handshake = mcPacket(0x00, Buffer.concat([
        varInt(767), mcString(m.via === 'ssh' ? '127.0.0.1' : m.host),
        Buffer.from([(m.gamePort >> 8) & 0xff, m.gamePort & 0xff]), varInt(1),
      ]));
      sock.write(Buffer.concat([handshake, mcPacket(0x00)]));
    });
  }

  // ---------- RCON ----------
  const rconPacket = (id, type, body) => {
    const b = Buffer.from(body, 'utf8');
    const p = Buffer.alloc(14 + b.length);
    p.writeInt32LE(10 + b.length, 0);
    p.writeInt32LE(id, 4);
    p.writeInt32LE(type, 8);
    b.copy(p, 12);
    return p; // die letzten zwei Bytes bleiben 0 (Null-Terminator + Padding)
  };

  async function rconConnect(m) {
    const pass = d.decryptKey(m.rconPass);
    if (pass === null) throw new Error('Gespeichertes RCON-Passwort nicht lesbar – bitte unter „Bearbeiten“ neu eingeben');
    if (!pass) throw new Error('Kein RCON-Passwort hinterlegt');
    const sock = await openStream(m, m.rconPort);
    const c = { sock, nextId: 1, pending: new Map(), buf: Buffer.alloc(0), queue: Promise.resolve(), closed: false };
    sock.on('data', (chunk) => {
      c.buf = Buffer.concat([c.buf, chunk]);
      while (c.buf.length >= 4) {
        const len = c.buf.readInt32LE(0);
        if (c.buf.length < 4 + len) break;
        const id = c.buf.readInt32LE(4);
        const type = c.buf.readInt32LE(8);
        const body = c.buf.subarray(12, 4 + len - 2).toString('utf8');
        c.buf = c.buf.subarray(4 + len);
        c.onPacket?.(id, type, body);
      }
    });
    const close = (err) => {
      if (c.closed) return;
      c.closed = true;
      rcons.delete(m.id);
      c.onClose?.(err || new Error('RCON-Verbindung getrennt'));
    };
    sock.on('close', () => close());
    sock.on('error', (err) => close(err));

    // Anmelden
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('RCON antwortet nicht (Zeitüberschreitung) – ist enable-rcon=true gesetzt?')), 8000);
      c.onClose = (err) => { clearTimeout(timer); reject(new Error(`RCON-Verbindung geschlossen: ${err.message}`)); };
      c.onPacket = (id, type) => {
        if (type !== 2) return; // Auth-Antwort hat Typ 2
        clearTimeout(timer);
        if (id === -1) reject(new Error('RCON-Passwort falsch'));
        else resolve();
      };
      sock.write(rconPacket(0, RCON.AUTH, pass));
    }).catch((err) => { sock.destroy?.(); sock.end?.(); throw err; });

    c.onPacket = null;
    c.onClose = null;
    rcons.set(m.id, c);
    return c;
  }

  async function rcon(m) {
    const c = rcons.get(m.id);
    if (c && !c.closed) return c;
    return rconConnect(m);
  }

  // Befehl senden; lange Antworten kommen in mehreren Paketen, daher ein Leer-Paket als Endmarke hinterher
  function runCommand(c, cmd) {
    return new Promise((resolve, reject) => {
      const id = c.nextId++;
      const endId = c.nextId++;
      let out = '';
      const timer = setTimeout(() => { c.onPacket = null; resolve(out || '(keine Antwort)'); }, 10000);
      c.onClose = (err) => { clearTimeout(timer); reject(err); };
      c.onPacket = (pid, _type, body) => {
        if (pid === id) out += body;
        else if (pid === endId) { clearTimeout(timer); c.onPacket = null; c.onClose = null; resolve(out); }
      };
      c.sock.write(rconPacket(id, RCON.COMMAND, cmd));
      c.sock.write(rconPacket(endId, RCON.RESPONSE, ''));
    });
  }

  async function command(mcId, cmd) {
    const m = list().find((x) => x.id === mcId);
    if (!m) throw new Error('Minecraft-Server nicht gefunden');
    const c = await rcon(m);
    // Befehle nacheinander abarbeiten, damit sich Antworten nicht vermischen
    const p = c.queue.then(() => runCommand(c, String(cmd).replace(/^\//, '')));
    c.queue = p.catch(() => {});
    return p;
  }

  function disconnect(mcId) {
    const c = rcons.get(mcId);
    if (c) { c.sock.destroy?.(); c.sock.end?.(); rcons.delete(mcId); }
  }

  return {
    list: () => list().map(publicMc),
    add(input) {
      const all = list();
      const m = normalize(input, { id: crypto.randomUUID(), createdAt: new Date().toISOString() });
      all.push(m);
      save(all);
      return publicMc(m);
    },
    update(id, input) {
      const all = list();
      const i = all.findIndex((x) => x.id === id);
      if (i < 0) throw new Error('Nicht gefunden');
      all[i] = normalize(input, all[i]);
      save(all);
      disconnect(id);
      return publicMc(all[i]);
    },
    remove(id) {
      disconnect(id);
      save(list().filter((x) => x.id !== id));
      return list().map(publicMc);
    },
    async status(id) {
      const m = list().find((x) => x.id === id);
      if (!m) throw new Error('Nicht gefunden');
      try { return await ping(m); } catch (err) { return { online: false, error: err.message }; }
    },
    command,
    rconConnected: (id) => !!rcons.get(id) && !rcons.get(id).closed,
    // Zugangsdaten vor dem Speichern prüfen
    async test(input, existingId) {
      // Beim Bearbeiten ohne neues Passwort das gespeicherte verwenden
      const existing = existingId ? list().find((x) => x.id === existingId) : null;
      const m = normalize(input, { ...(existing || {}), id: `test-${crypto.randomUUID()}` });
      const result = { status: null, rcon: null };
      try { result.status = await ping(m); } catch (err) { result.status = { online: false, error: err.message }; }
      try {
        const c = await rconConnect(m);
        const out = await runCommand(c, 'list');
        result.rcon = { ok: true, output: out };
        c.sock.destroy?.(); c.sock.end?.();
        rcons.delete(m.id);
      } catch (err) {
        result.rcon = { ok: false, error: err.message };
      }
      return result;
    },
    stop() {
      for (const id of [...rcons.keys()]) disconnect(id);
      for (const p of sshPool.values()) p.then((c) => c.end(), () => {});
    },
  };
};
