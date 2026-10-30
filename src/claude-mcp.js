// Claude-Integration: lokaler MCP-Server (Streamable HTTP, JSON-Antworten) für Claude Code & andere Agenten.
// Läuft nur auf 127.0.0.1, braucht ein Bearer-Token und prüft pro Server die freigegebene Zugriffsstufe.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LEVELS = ['none', 'read', 'control', 'full'];
const LEVEL_LABEL = { none: 'kein Zugriff', read: 'nur lesen', control: 'steuern', full: 'voll (SSH)' };
const MAX_OUTPUT = 50000;
const MAX_READ = 200 * 1024;

module.exports = function createClaudeMcp(d) {
  let server = null;
  let running = false;
  let lastError = '';
  let notice = '';
  const log = [];
  const pending = new Map(); // Bestätigungen: id -> resolve
  const sshPool = new Map(); // serverId -> Promise<{ conn, sftp }>

  // ---------- Einstellungen ----------
  function settings() {
    const store = d.loadStore();
    const c = store.claude || {};
    return {
      enabled: !!c.enabled,
      port: Number(c.port) || 39731,
      confirm: c.confirm !== false,
      access: c.access || {},
      // null, falls nicht (mehr) entschlüsselbar – dann wird ein neues erzeugt
      token: c.token ? d.decryptKey(c.token) : null,
      tokenBroken: !!c.token && d.decryptKey(c.token) === null,
      registered: !!c.registered,
    };
  }

  function saveSettings(patch) {
    const store = d.loadStore();
    const c = store.claude || {};
    if (patch.enabled !== undefined) c.enabled = !!patch.enabled;
    if (patch.port !== undefined) c.port = Number(patch.port) || 39731;
    if (patch.confirm !== undefined) c.confirm = !!patch.confirm;
    if (patch.access) c.access = { ...(c.access || {}), ...patch.access };
    if (patch.token) c.token = d.encryptKey(patch.token);
    if (patch.registered !== undefined) c.registered = !!patch.registered;
    store.claude = c;
    d.saveStore(store);
  }

  function ensureToken() {
    const s = settings();
    if (s.token) return s.token;
    const token = crypto.randomBytes(24).toString('base64url');
    saveSettings({ token });
    return token;
  }

  const levelOf = (serverId) => settings().access[serverId] || 'none';

  // ---------- Protokoll (dauerhaft in claude-protokoll.jsonl) ----------
  const MAX_FIELD = 20000;
  const MAX_FILE = 20 * 1024 * 1024;
  let lastClient = '';
  let logLoaded = false;

  const clipField = (v) => {
    if (typeof v !== 'string') return v;
    return v.length > MAX_FIELD ? `${v.slice(0, MAX_FIELD)}\n… (gekürzt, ${v.length} Zeichen)` : v;
  };

  function loadLog() {
    if (logLoaded) return;
    logLoaded = true;
    try {
      const lines = fs.readFileSync(d.logFile(), 'utf8').trim().split('\n').slice(-1000);
      for (const l of lines) { try { log.unshift(JSON.parse(l)); } catch { /* defekte Zeile */ } }
    } catch { /* noch keine Datei */ }
  }

  function addLog(entry) {
    loadLog();
    const e = { id: crypto.randomUUID(), time: Date.now(), client: lastClient || undefined, ...entry };
    if (e.args) e.args = Object.fromEntries(Object.entries(e.args).map(([k, v]) => [k, clipField(v)]));
    if (e.output) e.output = clipField(e.output);
    log.unshift(e);
    log.length = Math.min(log.length, 1000);
    try {
      const file = d.logFile();
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_FILE) fs.renameSync(file, `${file}.alt`);
      fs.appendFileSync(file, `${JSON.stringify(e)}\n`);
    } catch (err) {
      console.error('Claude-Protokoll konnte nicht geschrieben werden:', err.message);
    }
    // Für die Kurzliste ohne lange Ausgaben schicken
    d.send('claude:activity', { ...e, output: undefined, args: undefined });
  }

  function auditList({ search = '', server = '', onlyChanges = false, limit = 500 } = {}) {
    loadLog();
    const q = search.toLowerCase();
    return log.filter((e) => {
      if (server && e.server !== server) return false;
      if (onlyChanges && !['run_command', 'write_file', 'delete_path', 'power_server', 'create_backup', 'nginx_test_and_reload'].includes(e.tool)) return false;
      if (!q) return true;
      return JSON.stringify([e.tool, e.server, e.summary, e.args, e.result, e.output]).toLowerCase().includes(q);
    }).slice(0, limit);
  }

  function auditClear() {
    log.length = 0;
    try { fs.rmSync(d.logFile(), { force: true }); fs.rmSync(`${d.logFile()}.alt`, { force: true }); } catch { /* egal */ }
  }

  function auditText() {
    loadLog();
    return log.slice().reverse().map((e) => {
      const lines = [
        `[${new Date(e.time).toLocaleString('de-DE')}] ${e.tool} · ${e.server}${e.client ? ` · ${e.client}` : ''}`,
        `  Aktion:      ${e.summary}`,
      ];
      if (e.decision) lines.push(`  Bestätigung: ${e.decision}`);
      lines.push(`  Ergebnis:    ${e.result}${e.exitCode !== undefined ? ` (Exit-Code ${e.exitCode})` : ''}${e.durationMs !== undefined ? ` · ${e.durationMs} ms` : ''}`);
      if (e.args?.command) lines.push('  Befehl:', ...String(e.args.command).split('\n').map((l) => `    ${l}`));
      if (e.args?.path) lines.push(`  Pfad:        ${e.args.path}`);
      if (e.args?.content) lines.push('  Inhalt:', ...String(e.args.content).split('\n').map((l) => `    ${l}`));
      if (e.output) lines.push('  Ausgabe:', ...String(e.output).split('\n').map((l) => `    ${l}`));
      return lines.join('\n');
    }).join('\n\n');
  }

  // ---------- Bestätigung in der App ----------
  // Liefert true/false; ohne Bestätigungspflicht immer true
  function confirm(info) {
    if (!settings().confirm) return Promise.resolve(true);
    const win = d.getWindow();
    if (!win) return Promise.resolve(false);
    const id = crypto.randomUUID();
    if (win.isMinimized()) win.restore();
    win.flashFrame(true);
    win.show();
    d.send('claude:confirm', { id, ...info });
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); d.send('claude:confirmTimeout', id); resolve(false); }, 120000);
      pending.set(id, (ok) => { clearTimeout(timer); win.flashFrame(false); resolve(ok); });
    });
  }

  function answer(id, ok) {
    const fn = pending.get(id);
    pending.delete(id);
    if (fn) fn(!!ok);
  }

  // ---------- Server & API ----------
  function findServer(ref, need) {
    const servers = d.loadStore().servers;
    const q = String(ref ?? '').trim().toLowerCase();
    const s = servers.find((x) => x.id === ref)
      || servers.find((x) => x.name.toLowerCase() === q)
      || servers.find((x) => String(x.sid).toLowerCase() === q)
      || servers.find((x) => x.name.toLowerCase().includes(q) && q);
    if (!s) throw new Error(`Server „${ref}“ nicht gefunden. Nutze list_servers.`);
    const lvl = levelOf(s.id);
    if (LEVELS.indexOf(lvl) < LEVELS.indexOf(need)) {
      throw new Error(`Kein Zugriff: „${s.name}“ ist für Claude auf „${LEVEL_LABEL[lvl]}“ gestellt, nötig ist „${LEVEL_LABEL[need]}“. Der Nutzer kann das in Fire Desktop unter „Claude-Zugriff“ ändern.`);
    }
    return s;
  }

  async function api(s, method, apiPath, params) {
    const apiKey = d.decryptKey(s.key);
    if (apiKey === null) throw new Error(`Der API-Key von „${s.name}“ ist in Fire Desktop nicht mehr lesbar. Der Nutzer muss ihn dort über ⋯ → „API-Key ändern“ neu eingeben.`);
    const res = await d.request({
      provider: s.provider,
      apiKey,
      env: s.env,
      method,
      path: d.resolvePath(s, apiPath),
      params,
    });
    if (!res.ok) throw new Error(res.error || `HTTP ${res.httpStatus}`);
    return res.data;
  }

  // SSH/SFTP-Verbindung pro Server, Zugangsdaten aus der Server-Konfiguration
  async function ssh(s) {
    if (!sshPool.has(s.id)) {
      const p = (async () => {
        const cfg = await api(s, 'GET', '/vm/:vmid/config');
        const host = cfg?.config?.ipv4?.[0]?.ip_address;
        if (!host) throw new Error('Keine IPv4-Adresse in der Server-Konfiguration');
        const res = await d.openSsh({ serverId: s.id, host, port: 22, username: cfg.config.username || 'root', password: cfg.config.password });
        if (!res.ok) throw new Error(`SSH: ${res.error}`);
        const sftp = await new Promise((ok, fail) => res.conn.sftp((err, x) => (err ? fail(err) : ok(x))));
        res.conn.on('close', () => sshPool.delete(s.id));
        return { conn: res.conn, sftp, user: cfg.config.username || 'root' };
      })();
      sshPool.set(s.id, p);
      p.catch(() => sshPool.delete(s.id));
    }
    return sshPool.get(s.id);
  }

  async function run(s, cmd, timeoutMs = 120000) {
    const { conn, user } = await ssh(s);
    const full = user === 'root' ? cmd : `sudo -n sh -c ${d.shq(cmd)}`;
    return d.execCmd(conn, `export PATH="$PATH:/usr/sbin:/sbin"; ${full}`, timeoutMs);
  }

  const clip = (t) => (t.length > MAX_OUTPUT ? `${t.slice(0, MAX_OUTPUT)}\n… (gekürzt, ${t.length} Zeichen insgesamt)` : t);
  const absPath = (p) => {
    if (typeof p !== 'string' || !p.startsWith('/')) throw new Error('Pfad muss absolut sein (mit / beginnen)');
    return p;
  };

  // ---------- Tools ----------
  const S = { type: 'string', description: 'Servername oder ID (siehe list_servers)' };
  const TOOLS = [
    {
      name: 'list_servers',
      level: 'none',
      description: 'Listet alle 24fire-Server, auf die Claude in Fire Desktop Zugriff hat, mit Zugriffsstufe und Online-Status.',
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const servers = d.loadStore().servers.filter((s) => levelOf(s.id) !== 'none');
        const rows = await Promise.all(servers.map(async (s) => {
          let status = 'unbekannt';
          try { const st = await api(s, 'GET', '/vm/:vmid/status'); status = st.task ? `${st.status} (${st.task})` : st.status; } catch (e) { status = `Fehler: ${e.message}`; }
          return { name: s.name, id: s.id, access: LEVEL_LABEL[levelOf(s.id)], status };
        }));
        return rows.length ? rows : 'Keine Server freigegeben. Der Nutzer muss in Fire Desktop unter „Claude-Zugriff“ Server freigeben.';
      },
    },
    {
      name: 'get_server',
      level: 'read',
      description: 'Status (CPU, RAM, Laufzeit), Konfiguration (OS, Kerne, RAM, Disk, IPs, Hostsystem) und Traffic eines Servers.',
      inputSchema: { type: 'object', properties: { server: S }, required: ['server'] },
      async run({ server }, s) {
        const [status, cfg, traffic] = await Promise.all([
          api(s, 'GET', '/vm/:vmid/status'),
          api(s, 'GET', '/vm/:vmid/config'),
          api(s, 'GET', '/vm/:vmid/traffic/current').catch((e) => ({ error: e.message })),
        ]);
        // Passwort nie an Claude geben
        if (cfg?.config) delete cfg.config.password;
        return { name: s.name, status, config: cfg, traffic };
      },
    },
    {
      name: 'get_monitoring',
      level: 'read',
      description: 'Monitoring-Werte (CPU, RAM, Ping bzw. Netzwerk) der letzten Zeit und Verfügbarkeit/Ausfälle.',
      inputSchema: { type: 'object', properties: { server: S }, required: ['server'] },
      async run(_a, s) {
        if (s.provider === 'fireapi') {
          const m = await api(s, 'POST', '/vm/:vmid/metrics', { range: 'hour', aggregation: 'avg' });
          return { timings: (m?.timings || []).slice(-20) };
        }
        const [t, inc] = await Promise.all([
          api(s, 'GET', '/vm/:vmid/monitoring/timings'),
          api(s, 'GET', '/vm/:vmid/monitoring/incidences').catch((e) => ({ error: e.message })),
        ]);
        const timings = (t?.timings || []).sort((a, b) => new Date(a.date) - new Date(b.date)).slice(-24);
        return { hinweis: 'cpu in %, mem in GB, ping in ms, Messung alle 10 Minuten', timings, verfuegbarkeit: inc?.statistic, ausfaelle: (inc?.incidences || []).slice(0, 10) };
      },
    },
    {
      name: 'power_server',
      level: 'control',
      description: 'Server starten, stoppen (hart) oder neu starten. Stop/Neustart muss der Nutzer in der App bestätigen.',
      inputSchema: { type: 'object', properties: { server: S, action: { type: 'string', enum: ['start', 'stop', 'restart'] } }, required: ['server', 'action'] },
      confirm: ({ action }) => action !== 'start',
      summary: ({ action }) => ({ start: 'Server starten', stop: 'Server HART STOPPEN', restart: 'Server neu starten' }[action]),
      async run({ action }, s) {
        if (!['start', 'stop', 'restart'].includes(action)) throw new Error('action muss start, stop oder restart sein');
        await api(s, 'POST', '/vm/:vmid/power', { mode: action });
        return `Aktion „${action}“ für ${s.name} ausgelöst. Status mit get_server prüfen.`;
      },
    },
    {
      name: 'list_backups',
      level: 'read',
      description: 'Listet die Backups eines Servers.',
      inputSchema: { type: 'object', properties: { server: S }, required: ['server'] },
      async run(_a, s) { return api(s, 'GET', '/vm/:vmid/backup/list'); },
    },
    {
      name: 'create_backup',
      level: 'control',
      description: 'Erstellt ein neues Backup (belegt einen Backup-Slot). Muss bestätigt werden.',
      inputSchema: { type: 'object', properties: { server: S, description: { type: 'string', description: 'max. 24 Zeichen' } }, required: ['server'] },
      confirm: () => true,
      summary: ({ description }) => `Backup erstellen${description ? ` („${description}“)` : ''}`,
      async run({ description }, s) { return api(s, 'POST', '/vm/:vmid/backup/create', { description: (description || '').slice(0, 24) }); },
    },
    {
      name: 'run_command',
      level: 'full',
      description: 'Führt einen Shell-Befehl per SSH auf dem Server aus (als root) und gibt stdout, stderr und Exit-Code zurück. Muss bestätigt werden.',
      inputSchema: {
        type: 'object',
        properties: { server: S, command: { type: 'string' }, timeout_seconds: { type: 'number', description: 'Standard 120, max. 900' } },
        required: ['server', 'command'],
      },
      confirm: () => true,
      summary: () => 'Shell-Befehl ausführen',
      details: ({ command }) => command,
      async run({ command, timeout_seconds }, s) {
        const t = Math.min(900, Math.max(5, Number(timeout_seconds) || 120)) * 1000;
        const r = await run(s, command, t);
        return `exit_code: ${r.code}\n--- stdout ---\n${clip(r.stdout)}${r.stderr ? `\n--- stderr ---\n${clip(r.stderr)}` : ''}`;
      },
    },
    {
      name: 'list_directory',
      level: 'full',
      description: 'Listet einen Ordner auf dem Server (Name, Typ, Größe, Rechte, Änderungsdatum).',
      inputSchema: { type: 'object', properties: { server: S, path: { type: 'string', description: 'absoluter Pfad, z. B. /etc/nginx' } }, required: ['server', 'path'] },
      async run({ path }, s) {
        const { sftp } = await ssh(s);
        const p = absPath(path);
        const list = await d.sftpCall(sftp, 'readdir', p);
        return list.map((it) => ({
          name: it.filename,
          type: d.typeOf(it.attrs.mode),
          size: it.attrs.size,
          perms: d.permString(it.attrs.mode),
          modified: new Date(it.attrs.mtime * 1000).toISOString(),
        })).sort((a, b) => a.name.localeCompare(b.name));
      },
    },
    {
      name: 'read_file',
      level: 'full',
      description: 'Liest eine Textdatei vom Server (max. 200 KB pro Aufruf; mit offset weiterlesen).',
      inputSchema: { type: 'object', properties: { server: S, path: { type: 'string' }, offset: { type: 'number', description: 'Byte-Offset, Standard 0' } }, required: ['server', 'path'] },
      async run({ path, offset }, s) {
        const { sftp } = await ssh(s);
        const p = absPath(path);
        const st = await d.sftpCall(sftp, 'stat', p);
        if (d.typeOf(st.mode) === 'dir') throw new Error('Das ist ein Ordner – list_directory benutzen');
        const start = Math.max(0, Number(offset) || 0);
        const len = Math.min(MAX_READ, Math.max(0, st.size - start));
        const handle = await d.sftpCall(sftp, 'open', p, 'r');
        const buf = Buffer.alloc(len);
        let read = 0;
        while (read < len) {
          const n = await new Promise((ok, fail) => sftp.read(handle, buf, read, len - read, start + read, (err, bytes) => (err ? fail(err) : ok(bytes))));
          if (!n) break;
          read += n;
        }
        await d.sftpCall(sftp, 'close', handle);
        if (buf.subarray(0, Math.min(read, 8000)).includes(0)) throw new Error('Binärdatei – kann nicht als Text gelesen werden');
        const more = start + read < st.size ? `\n\n[… ${st.size - start - read} weitere Bytes, weiterlesen mit offset=${start + read}]` : '';
        return buf.subarray(0, read).toString('utf8') + more;
      },
    },
    {
      name: 'write_file',
      level: 'full',
      description: 'Schreibt (überschreibt) eine Textdatei auf dem Server. Muss bestätigt werden. Für Nginx danach nginx_test_and_reload aufrufen.',
      inputSchema: { type: 'object', properties: { server: S, path: { type: 'string' }, content: { type: 'string' } }, required: ['server', 'path', 'content'] },
      confirm: () => true,
      summary: ({ path }) => `Datei schreiben: ${path}`,
      details: ({ content }) => (content.length > 4000 ? `${content.slice(0, 4000)}\n… (${content.length} Zeichen)` : content),
      async run({ path, content }, s) {
        const { sftp } = await ssh(s);
        await d.sftpCall(sftp, 'writeFile', absPath(path), Buffer.from(String(content), 'utf8'));
        return `${path} geschrieben (${Buffer.byteLength(String(content))} Bytes).`;
      },
    },
    {
      name: 'delete_path',
      level: 'full',
      description: 'Löscht eine Datei oder einen Ordner (rekursiv) auf dem Server. Muss bestätigt werden.',
      inputSchema: { type: 'object', properties: { server: S, path: { type: 'string' } }, required: ['server', 'path'] },
      confirm: () => true,
      summary: ({ path }) => `LÖSCHEN (rekursiv): ${path}`,
      validate({ path }) {
        const p = absPath(path).replace(/\/+$/, '');
        if (!p || p.split('/').filter(Boolean).length < 2) throw new Error('Aus Sicherheitsgründen nicht erlaubt (zu nah an /)');
      },
      async run({ path }, s) {
        const p = absPath(path).replace(/\/+$/, '');
        const r = await run(s, `rm -rf -- ${d.shq(p)}`);
        if (r.code !== 0) throw new Error(r.stderr || `rm Exit-Code ${r.code}`);
        return `${p} gelöscht.`;
      },
    },
    {
      name: 'nginx_test_and_reload',
      level: 'full',
      description: 'Testet die Nginx-Konfiguration (nginx -t). Mit reload=true wird Nginx bei erfolgreichem Test neu geladen (muss bestätigt werden).',
      inputSchema: { type: 'object', properties: { server: S, reload: { type: 'boolean' } }, required: ['server'] },
      confirm: ({ reload }) => !!reload,
      summary: () => 'Nginx testen und neu laden',
      async run({ reload }, s) {
        const t = await run(s, 'nginx -t 2>&1');
        const out = `${t.stdout}${t.stderr}`.trim();
        if (t.code !== 0) return `TEST FEHLGESCHLAGEN – nicht neu geladen:\n${out}`;
        if (!reload) return `Test erfolgreich:\n${out}`;
        const r = await run(s, 'systemctl reload nginx 2>&1 || nginx -s reload 2>&1');
        return r.code === 0 ? `Test erfolgreich, Nginx neu geladen.\n${out}` : `Test ok, Reload fehlgeschlagen:\n${r.stdout}${r.stderr}`;
      },
    },
  ];

  async function callTool(name, args = {}) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) throw Object.assign(new Error(`Unbekanntes Tool: ${name}`), { rpc: -32602 });
    const started = Date.now();
    let s = null;
    try {
      if (tool.level !== 'none') s = findServer(args.server, tool.level);
      // Offensichtlich unzulässige Aufrufe gar nicht erst zur Bestätigung vorlegen
      tool.validate?.(args);
    } catch (err) {
      // Als Tool-Fehler zurückgeben, damit Claude den Hinweis lesen kann
      addLog({ tool: name, server: String(args.server ?? '–'), summary: name, args, decision: 'nicht ausgeführt', result: `Fehler: ${err.message}` });
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
    const entry = { tool: name, server: s?.name || '–', summary: tool.summary ? tool.summary(args) : (args.path || name), args };

    let decision = 'nicht nötig';
    if (tool.confirm && tool.confirm(args)) {
      const needsAsk = settings().confirm;
      const ok = await confirm({ tool: name, server: s.name, summary: entry.summary, details: tool.details ? tool.details(args) : (args.path || '') });
      decision = !needsAsk ? 'ohne Rückfrage (Bestätigung ausgeschaltet)' : ok ? 'von dir erlaubt' : 'von dir abgelehnt / Zeit abgelaufen';
      if (!ok) {
        addLog({ ...entry, decision, result: 'abgelehnt' });
        return { content: [{ type: 'text', text: 'Der Nutzer hat diese Aktion in Fire Desktop abgelehnt (oder nicht innerhalb von 2 Minuten bestätigt). Nicht erneut ohne Rückfrage versuchen.' }], isError: true };
      }
    }
    try {
      const out = await tool.run(args, s);
      const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
      const exit = /^exit_code: (-?\d+)/.exec(text);
      addLog({
        ...entry,
        decision,
        result: exit && exit[1] !== '0' ? 'ok (Befehl mit Fehlercode)' : 'ok',
        exitCode: exit ? Number(exit[1]) : undefined,
        durationMs: Date.now() - started,
        output: text,
      });
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      addLog({ ...entry, decision, result: `Fehler: ${err.message}`, durationMs: Date.now() - started });
      return { content: [{ type: 'text', text: `Fehler: ${err.message}` }], isError: true };
    }
  }

  // ---------- JSON-RPC ----------
  async function handleRpc(msg) {
    const { id, method, params } = msg || {};
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const error = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return error(-32600, 'Invalid Request');
    const isNotification = id === undefined;

    try {
      switch (method) {
        case 'initialize': {
          const v = PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0];
          lastClient = `${params?.clientInfo?.name || 'Client'} ${params?.clientInfo?.version || ''}`.trim();
          addLog({ tool: 'verbunden', server: '–', summary: lastClient, result: 'ok' });
          return reply({
            protocolVersion: v,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'fire-desktop', title: 'Fire Desktop (24fire)', version: d.version },
            instructions: 'Verwaltet 24fire-KVM-Server des Nutzers. Zuerst list_servers aufrufen. Riskante Aktionen (Stop, Schreiben, Löschen, Shell) muss der Nutzer in der App bestätigen; abgelehnte Aktionen nicht ungefragt wiederholen. Für Nginx: Datei mit write_file ändern, dann nginx_test_and_reload.',
          });
        }
        case 'ping': return isNotification ? null : reply({});
        case 'tools/list':
          return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        case 'tools/call':
          return reply(await callTool(params?.name, params?.arguments || {}));
        default:
          if (isNotification) return null;
          return error(-32601, `Method not found: ${method}`);
      }
    } catch (err) {
      return error(err.rpc || -32603, err.message);
    }
  }

  function tokenOk(header) {
    const token = settings().token;
    const m = /^Bearer\s+(.+)$/i.exec(header || '');
    if (!token || !m) return false;
    const a = Buffer.from(m[1].trim());
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function handleHttp(req, res) {
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    // Schutz gegen DNS-Rebinding / Webseiten im Browser
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return send(403, { error: 'forbidden host' });
    if (req.headers.origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.origin)) return send(403, { error: 'forbidden origin' });
    if (!req.url.startsWith('/mcp')) return send(404, { error: 'not found' });
    if (!tokenOk(req.headers.authorization)) {
      addLog({ tool: 'abgewiesen', server: '–', summary: 'Anfrage mit falschem oder fehlendem Token', result: 'abgelehnt' });
      return send(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    }
    if (req.method !== 'POST') return send(405, { error: 'method not allowed' }, { Allow: 'POST' });

    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on('end', async () => {
      let msg;
      try { msg = JSON.parse(body); } catch { return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      const batch = Array.isArray(msg);
      const results = (await Promise.all((batch ? msg : [msg]).map(handleRpc))).filter(Boolean);
      if (!results.length) { res.writeHead(202); return res.end(); }
      send(200, batch ? results : results[0]);
    });
  }

  // ---------- Start/Stop ----------
  function stop() {
    return new Promise((resolve) => {
      for (const p of sshPool.values()) p.then((x) => x.conn.end(), () => {});
      sshPool.clear();
      if (!server) { running = false; return resolve(); }
      server.close(() => resolve());
      server.closeAllConnections?.();
      server = null;
      running = false;
    });
  }

  async function listenOnce(port) {
    return new Promise((resolve) => {
      const srv = http.createServer(handleHttp);
      srv.once('error', (err) => resolve({ ok: false, err }));
      srv.listen(port, '127.0.0.1', () => resolve({ ok: true, srv }));
    });
  }

  async function start() {
    await stop();
    lastError = '';
    try {
      let s = settings();
      if (!s.enabled) return;

      // Token nicht mehr lesbar → neues erzeugen und, falls schon eingetragen, Claude Code aktualisieren
      if (s.tokenBroken) {
        saveSettings({ token: crypto.randomBytes(24).toString('base64url') });
        notice = 'Das alte Token war nicht mehr lesbar und wurde ersetzt.';
        if (s.registered || alreadyInClaudeCode()) {
          const r = await registerClaudeCode();
          notice += r.ok ? ' Claude Code wurde automatisch aktualisiert – Claude Code neu starten.' : ' Bitte „In Claude Code eintragen“ erneut klicken.';
        }
        s = settings();
      }
      ensureToken();

      // Beim Start kann eine alte Instanz den Port noch kurz belegen → mehrfach versuchen
      for (let attempt = 0; attempt < 8; attempt++) {
        const r = await listenOnce(s.port);
        if (r.ok) {
          server = r.srv;
          running = true;
          lastError = '';
          return;
        }
        lastError = r.err.code === 'EADDRINUSE' ? `Port ${s.port} ist belegt (anderes Programm oder zweite Fire-Desktop-Instanz)` : r.err.message;
        if (r.err.code !== 'EADDRINUSE') break;
        await new Promise((ok) => setTimeout(ok, 1500));
      }
    } catch (err) {
      lastError = `Start fehlgeschlagen: ${err.message}`;
    }
    running = false;
    d.send('claude:changed', status());
  }

  function status() {
    const s = settings();
    return {
      enabled: s.enabled,
      running,
      error: lastError,
      notice,
      registered: s.registered,
      port: s.port,
      url: `http://127.0.0.1:${s.port}/mcp`,
      token: s.token,
      confirm: s.confirm,
      access: s.access,
      tools: TOOLS.map((t) => ({ name: t.name, level: t.level })),
      log: (loadLog(), log.slice(0, 200).map((e) => ({ ...e, output: undefined, args: undefined }))),
    };
  }

  // claude.exe liegt oft nicht im PATH (z. B. %USERPROFILE%\.local\bin)
  function findClaudeCli() {
    const home = os.homedir();
    const candidates = [
      path.join(home, '.local', 'bin', 'claude.exe'),
      path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude', 'claude.exe'),
    ];
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      candidates.push(path.join(dir, 'claude.exe'), path.join(dir, 'claude.cmd'));
    }
    return candidates.find((c) => c && fs.existsSync(c)) || null;
  }

  const runCli = (cli, args) => new Promise((resolve) => {
    execFile(cli, args, { windowsHide: true, timeout: 30000, shell: /\.cmd$/i.test(cli) }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`.trim(), err });
    });
  });

  function alreadyInClaudeCode() {
    try {
      return !!JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).mcpServers?.['fire-desktop'];
    } catch {
      return false;
    }
  }

  // Fallback: direkt in ~/.claude.json (Benutzer-Scope von Claude Code) eintragen
  function writeClaudeJson(url, token) {
    const file = path.join(os.homedir(), '.claude.json');
    let json = {};
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8');
      json = JSON.parse(text);
      fs.writeFileSync(`${file}.fire-desktop-backup`, text);
    }
    json.mcpServers = json.mcpServers || {};
    json.mcpServers['fire-desktop'] = { type: 'http', url, headers: { Authorization: `Bearer ${token}` } };
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(json, null, 2));
    fs.renameSync(tmp, file);
  }

  // Trägt den Server in Claude Code ein (Benutzer-Scope)
  async function registerClaudeCode() {
    const s = settings();
    const token = ensureToken();
    const url = `http://127.0.0.1:${s.port}/mcp`;
    const cli = findClaudeCli();
    if (cli) {
      await runCli(cli, ['mcp', 'remove', 'fire-desktop', '--scope', 'user']);
      const r = await runCli(cli, ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'fire-desktop', url, '--header', `Authorization: Bearer ${token}`]);
      if (r.ok) { saveSettings({ registered: true }); return { ok: true, output: r.out, via: 'cli' }; }
    }
    try {
      writeClaudeJson(url, token);
      saveSettings({ registered: true });
      return { ok: true, via: 'json' };
    } catch (err) {
      return { ok: false, error: `Eintragen fehlgeschlagen: ${err.message}` };
    }
  }

  return {
    start,
    stop,
    status,
    answer,
    registerClaudeCode,
    auditList,
    auditClear,
    auditText,
    levels: LEVELS,
    async update(patch) {
      saveSettings(patch);
      // Rechte gelten sofort; neu starten nur bei An/Aus oder Portwechsel
      if (patch.enabled !== undefined || patch.port !== undefined) await start();
      return status();
    },
    async regenerateToken() {
      saveSettings({ token: crypto.randomBytes(24).toString('base64url') });
      // Bereits eingetragenes Claude Code direkt mit dem neuen Token versorgen
      if (settings().registered) await registerClaudeCode();
      return status();
    },
  };
};
