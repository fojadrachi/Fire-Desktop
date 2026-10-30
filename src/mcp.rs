//! Claude-Zugriff: lokaler MCP-Server (Streamable HTTP, JSON-Antworten) auf 127.0.0.1 mit Bearer-Token.
//! Rechte pro Server, Bestätigung in der App und dauerhaftes Protokoll (claude-protokoll.jsonl).

use crate::{fire, ssh, store};
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

const LEVELS: [&str; 4] = ["none", "read", "control", "full"];
const CHANGES: [&str; 6] = ["run_command", "write_file", "delete_path", "power_server", "create_backup", "nginx_test_and_reload"];
const MAX_FIELD: usize = 20000;

fn level_label(l: &str) -> &'static str {
    match l { "read" => "nur lesen", "control" => "steuern", "full" => "voll (SSH)", _ => "kein Zugriff" }
}

// ---------- Protokoll ----------

fn log_file() -> std::path::PathBuf { store::root().join("claude-protokoll.jsonl") }

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max { return s.to_string(); }
    let head: String = s.chars().take(max).collect();
    format!("{head}\n… (gekürzt, {} Zeichen)", s.chars().count())
}

static CLIENT: Mutex<String> = Mutex::new(String::new());

fn add_log(mut e: Value) {
    e["id"] = json!(uuid::Uuid::new_v4().to_string());
    e["time"] = json!(chrono::Local::now().timestamp_millis());
    let client = CLIENT.lock().unwrap().clone();
    if !client.is_empty() { e["client"] = json!(client); }
    if let Some(o) = e["output"].as_str().map(|s| clip(s, MAX_FIELD)) { e["output"] = json!(o); }
    if let Some(args) = e["args"].as_object_mut() {
        for v in args.values_mut() {
            if let Some(s) = v.as_str() { *v = json!(clip(s, MAX_FIELD)); }
        }
    }
    let file = log_file();
    if std::fs::metadata(&file).map(|m| m.len() > 20 * 1024 * 1024).unwrap_or(false) {
        let _ = std::fs::rename(&file, file.with_extension("jsonl.alt"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&file) {
        let _ = writeln!(f, "{e}");
    }
    if let Some(cb) = ON_LOG.get() { cb(); }
}

/// Neueste Einträge zuerst.
pub fn audit(search: &str, server: &str, only_changes: bool) -> Vec<Value> {
    let text = std::fs::read_to_string(log_file()).unwrap_or_default();
    let q = search.to_lowercase();
    text.lines().rev().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(|e| {
        if !server.is_empty() && e["server"] != server { return false; }
        if only_changes && !CHANGES.contains(&e["tool"].as_str().unwrap_or("")) { return false; }
        q.is_empty() || e.to_string().to_lowercase().contains(&q)
    }).take(500).collect()
}

pub fn audit_clear() {
    let _ = std::fs::remove_file(log_file());
    let _ = std::fs::remove_file(log_file().with_extension("jsonl.alt"));
}

pub fn audit_text() -> String {
    audit("", "", false).iter().rev().map(|e| {
        let time = chrono::DateTime::from_timestamp_millis(e["time"].as_i64().unwrap_or(0)).map(|t| t.with_timezone(&chrono::Local).format("%d.%m.%Y %H:%M:%S").to_string()).unwrap_or_default();
        let mut s = format!("[{time}] {} · {}\n  Aktion:      {}\n", e["tool"].as_str().unwrap_or(""), e["server"].as_str().unwrap_or(""), e["summary"].as_str().unwrap_or(""));
        if let Some(d) = e["decision"].as_str() { s += &format!("  Bestätigung: {d}\n"); }
        s += &format!("  Ergebnis:    {}\n", e["result"].as_str().unwrap_or(""));
        if let Some(c) = e["args"]["command"].as_str() { s += &format!("  Befehl:      {c}\n"); }
        if let Some(c) = e["args"]["path"].as_str() { s += &format!("  Pfad:        {c}\n"); }
        if let Some(c) = e["output"].as_str() { s += &format!("  Ausgabe:\n{c}\n"); }
        s
    }).collect::<Vec<_>>().join("\n")
}

// ---------- Bestätigung ----------

#[derive(Clone, Debug)]
pub struct Ask {
    pub id: String,
    pub tool: String,
    pub server: String,
    pub summary: String,
    pub details: String,
}

pub static ON_ASK: OnceLock<Box<dyn Fn(Ask) + Send + Sync>> = OnceLock::new();
pub static ON_ASK_END: OnceLock<Box<dyn Fn(String) + Send + Sync>> = OnceLock::new();
pub static ON_LOG: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();
static PENDING: Mutex<Option<HashMap<String, oneshot::Sender<bool>>>> = Mutex::new(None);

pub fn answer(id: &str, ok: bool) {
    if let Some(tx) = PENDING.lock().unwrap().get_or_insert_with(HashMap::new).remove(id) { let _ = tx.send(ok); }
}

async fn ask(tool: &str, server: &str, summary: &str, details: &str) -> bool {
    let Some(cb) = ON_ASK.get() else { return false };
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    PENDING.lock().unwrap().get_or_insert_with(HashMap::new).insert(id.clone(), tx);
    cb(Ask { id: id.clone(), tool: tool.into(), server: server.into(), summary: summary.into(), details: details.into() });
    let ok = matches!(tokio::time::timeout(Duration::from_secs(120), rx).await, Ok(Ok(true)));
    PENDING.lock().unwrap().get_or_insert_with(HashMap::new).remove(&id);
    if let Some(end) = ON_ASK_END.get() { end(id); }
    ok
}

// ---------- SSH-Verbindungen der Tools ----------

static POOL: OnceLock<AsyncMutex<HashMap<String, Arc<ssh::Conn>>>> = OnceLock::new();

async fn conn(s: &store::Server) -> Result<Arc<ssh::Conn>> {
    let pool = POOL.get_or_init(|| AsyncMutex::new(HashMap::new()));
    let mut g = pool.lock().await;
    if let Some(c) = g.get(&s.id) {
        if c.alive() { return Ok(c.clone()); }
    }
    let c = Arc::new(ssh::connect_server(s).await?);
    g.insert(s.id.clone(), c.clone());
    Ok(c)
}

// ---------- Tools ----------

fn tools() -> Value {
    let srv = json!({ "type": "string", "description": "Servername oder ID (siehe list_servers)" });
    let t = |name: &str, desc: &str, props: Value, req: Vec<&str>| json!({ "name": name, "description": desc, "inputSchema": { "type": "object", "properties": props, "required": req } });
    json!([
        t("list_servers", "Listet alle 24fire-Server, auf die Claude in Fire Desktop Zugriff hat, mit Zugriffsstufe und Online-Status.", json!({}), vec![]),
        t("get_server", "Status (CPU, RAM, Laufzeit), Konfiguration und Traffic eines Servers.", json!({ "server": srv }), vec!["server"]),
        t("get_monitoring", "Monitoring-Werte (CPU, RAM, Ping) der letzten Zeit und Verfügbarkeit/Ausfälle.", json!({ "server": srv }), vec!["server"]),
        t("power_server", "Server starten, stoppen (hart) oder neu starten. Stop/Neustart muss der Nutzer in der App bestätigen.", json!({ "server": srv, "action": { "type": "string", "enum": ["start", "stop", "restart"] } }), vec!["server", "action"]),
        t("list_backups", "Listet die Backups eines Servers.", json!({ "server": srv }), vec!["server"]),
        t("create_backup", "Erstellt ein neues Backup. Muss bestätigt werden.", json!({ "server": srv, "description": { "type": "string" } }), vec!["server"]),
        t("run_command", "Führt einen Shell-Befehl per SSH aus und gibt stdout, stderr und Exit-Code zurück. Muss bestätigt werden.", json!({ "server": srv, "command": { "type": "string" }, "timeout_seconds": { "type": "number" } }), vec!["server", "command"]),
        t("list_directory", "Listet einen Ordner auf dem Server.", json!({ "server": srv, "path": { "type": "string" } }), vec!["server", "path"]),
        t("read_file", "Liest eine Textdatei vom Server (max. 200 KB).", json!({ "server": srv, "path": { "type": "string" } }), vec!["server", "path"]),
        t("write_file", "Schreibt eine Textdatei auf dem Server. Muss bestätigt werden.", json!({ "server": srv, "path": { "type": "string" }, "content": { "type": "string" } }), vec!["server", "path", "content"]),
        t("delete_path", "Löscht eine Datei oder einen Ordner rekursiv. Muss bestätigt werden.", json!({ "server": srv, "path": { "type": "string" } }), vec!["server", "path"]),
        t("nginx_test_and_reload", "Testet die Nginx-Konfiguration; mit reload=true wird bei Erfolg neu geladen (muss bestätigt werden).", json!({ "server": srv, "reload": { "type": "boolean" } }), vec!["server"]),
    ])
}

fn level_of(id: &str) -> String { store::read().claude.access.get(id).cloned().unwrap_or_else(|| "none".into()) }

fn find(reference: &str, need: &str) -> Result<store::Server> {
    let q = reference.trim().to_lowercase();
    let all = store::read().servers;
    let s = all.iter().find(|x| x.id == reference)
        .or_else(|| all.iter().find(|x| x.name.to_lowercase() == q))
        .or_else(|| all.iter().find(|x| !q.is_empty() && x.name.to_lowercase().contains(&q)))
        .ok_or_else(|| anyhow!("Server „{reference}“ nicht gefunden. Nutze list_servers."))?;
    let lvl = level_of(&s.id);
    let rank = |l: &str| LEVELS.iter().position(|x| *x == l).unwrap_or(0);
    if rank(&lvl) < rank(need) {
        bail!("Kein Zugriff: „{}“ ist für Claude auf „{}“ gestellt, nötig ist „{}“. Der Nutzer kann das in Fire Desktop unter „Claude-Zugriff“ ändern.", s.name, level_label(&lvl), level_label(need));
    }
    Ok(s.clone())
}

fn abs(p: &str) -> Result<&str> {
    if p.starts_with('/') { Ok(p) } else { bail!("Pfad muss absolut sein (mit / beginnen)") }
}

async fn run_tool(name: &str, a: &Value, s: Option<&store::Server>) -> Result<String> {
    let path = a["path"].as_str().unwrap_or("");
    let srv = || s.ok_or_else(|| anyhow!("Server fehlt"));
    Ok(match name {
        "list_servers" => {
            let mut rows = Vec::new();
            for x in store::read().servers.iter().filter(|x| level_of(&x.id) != "none") {
                let st = fire::status(x).await.map(|t| t.state).unwrap_or_else(|e| format!("Fehler: {e}"));
                rows.push(json!({ "name": x.name, "id": x.id, "access": level_label(&level_of(&x.id)), "status": st }));
            }
            if rows.is_empty() { "Keine Server freigegeben.".to_string() } else { serde_json::to_string_pretty(&rows)? }
        }
        "get_server" => serde_json::to_string_pretty(&fire::summary(srv()?).await?)?,
        "get_monitoring" => {
            let m = fire::monitoring(srv()?).await?;
            let rows: Vec<Value> = m.timings.iter().rev().take(24).rev().map(|t| json!({ "time": t.time, "cpu": t.cpu, "mem_gb": t.mem_gb, "ping_ms": t.ping })).collect();
            serde_json::to_string_pretty(&json!({ "timings": rows, "verfuegbarkeit": m.avail, "ausfaelle": m.incidents }))?
        }
        "power_server" => {
            let action = a["action"].as_str().unwrap_or("");
            if !["start", "stop", "restart"].contains(&action) { bail!("action muss start, stop oder restart sein"); }
            fire::power(srv()?, action).await?;
            format!("Aktion „{action}“ ausgelöst. Status mit get_server prüfen.")
        }
        "list_backups" => {
            let b = fire::backups(srv()?).await?;
            serde_json::to_string_pretty(&b.iter().map(|x| json!({ "id": x.id, "created": x.created, "description": x.description, "size_mb": x.size_mb, "status": x.status })).collect::<Vec<_>>())?
        }
        "create_backup" => { fire::backup_create(srv()?, a["description"].as_str().unwrap_or("")).await?; "Backup gestartet.".into() }
        "run_command" => {
            let secs = a["timeout_seconds"].as_u64().unwrap_or(120).clamp(5, 900);
            let r = conn(srv()?).await?.exec(a["command"].as_str().unwrap_or(""), secs).await?;
            let mut t = format!("exit_code: {}\n--- stdout ---\n{}", r.code, clip(&r.stdout, 50000));
            if !r.stderr.is_empty() { t += &format!("\n--- stderr ---\n{}", clip(&r.stderr, 50000)); }
            t
        }
        "list_directory" => {
            let sftp = conn(srv()?).await?.sftp().await?;
            let (_, list) = ssh::list(&sftp, abs(path)?).await?;
            serde_json::to_string_pretty(&list.iter().map(|e| json!({ "name": e.name, "type": if e.is_dir { "dir" } else { "file" }, "size": e.size, "perms": e.perms })).collect::<Vec<_>>())?
        }
        "read_file" => {
            let sftp = conn(srv()?).await?.sftp().await?;
            let data = sftp.read(abs(path)?).await?;
            if data.iter().take(8000).any(|b| *b == 0) { bail!("Binärdatei – kann nicht als Text gelesen werden"); }
            let cut = data.len().min(200 * 1024);
            let mut t = String::from_utf8_lossy(&data[..cut]).into_owned();
            if cut < data.len() { t += &format!("\n\n[… {} weitere Bytes]", data.len() - cut); }
            t
        }
        "write_file" => {
            let sftp = conn(srv()?).await?.sftp().await?;
            let c = a["content"].as_str().unwrap_or("");
            sftp.write(abs(path)?, c.as_bytes()).await.map_err(|e| anyhow!("{e}"))?;
            format!("{path} geschrieben ({} Bytes).", c.len())
        }
        "delete_path" => {
            let r = conn(srv()?).await?.exec(&format!("rm -rf -- {}", ssh::shq(path.trim_end_matches('/'))), 120).await?;
            if r.code != 0 { bail!("{}", r.stderr); }
            format!("{path} gelöscht.")
        }
        "nginx_test_and_reload" => {
            let c = conn(srv()?).await?;
            let t = c.exec("nginx -t 2>&1", 60).await?;
            let out = format!("{}{}", t.stdout, t.stderr);
            if t.code != 0 { format!("TEST FEHLGESCHLAGEN – nicht neu geladen:\n{out}") }
            else if a["reload"] != true { format!("Test erfolgreich:\n{out}") }
            else {
                let r = c.exec("systemctl reload nginx 2>&1 || nginx -s reload 2>&1", 60).await?;
                if r.code == 0 { format!("Test erfolgreich, Nginx neu geladen.\n{out}") } else { format!("Test ok, Reload fehlgeschlagen:\n{}{}", r.stdout, r.stderr) }
            }
        }
        _ => bail!("Unbekanntes Tool: {name}"),
    })
}

async fn call_tool(name: &str, a: &Value) -> Value {
    let need = match name {
        "list_servers" => "none",
        "get_server" | "get_monitoring" | "list_backups" => "read",
        "power_server" | "create_backup" => "control",
        _ => "full",
    };
    let started = Instant::now();
    let path = a["path"].as_str().unwrap_or("");
    let fail = |text: String| json!({ "content": [{ "type": "text", "text": text }], "isError": true });

    let checked = (|| -> Result<Option<store::Server>> {
        let s = if need == "none" { None } else { Some(find(a["server"].as_str().unwrap_or(""), need)?) };
        if name == "delete_path" {
            abs(path)?;
            if path.trim_matches('/').split('/').filter(|x| !x.is_empty()).count() < 2 { bail!("Aus Sicherheitsgründen nicht erlaubt (zu nah an /)"); }
        }
        Ok(s)
    })();
    let s = match checked {
        Ok(s) => s,
        Err(e) => {
            add_log(json!({ "tool": name, "server": a["server"], "summary": name, "args": a, "decision": "nicht ausgeführt", "result": format!("Fehler: {e}") }));
            return fail(e.to_string());
        }
    };
    let server_name = s.as_ref().map(|x| x.name.clone()).unwrap_or_else(|| "–".into());
    let action = a["action"].as_str().unwrap_or("");
    let summary = match name {
        "power_server" => match action { "stop" => "Server HART STOPPEN".to_string(), "restart" => "Server neu starten".into(), _ => "Server starten".into() },
        "create_backup" => "Backup erstellen".into(),
        "run_command" => "Shell-Befehl ausführen".into(),
        "write_file" => format!("Datei schreiben: {path}"),
        "delete_path" => format!("LÖSCHEN (rekursiv): {path}"),
        "nginx_test_and_reload" => "Nginx testen und neu laden".into(),
        _ => if path.is_empty() { name.to_string() } else { path.to_string() },
    };
    let needs_ok = match name {
        "power_server" => action != "start",
        "create_backup" | "run_command" | "write_file" | "delete_path" => true,
        "nginx_test_and_reload" => a["reload"] == true,
        _ => false,
    };
    let mut decision = "nicht nötig";
    if needs_ok {
        let details = a["command"].as_str().or(a["content"].as_str()).or(a["path"].as_str()).unwrap_or("");
        if store::read().claude.confirm {
            let ok = ask(name, &server_name, &summary, &clip(details, 4000)).await;
            decision = if ok { "von dir erlaubt" } else { "von dir abgelehnt / Zeit abgelaufen" };
            if !ok {
                add_log(json!({ "tool": name, "server": server_name, "summary": summary, "args": a, "decision": decision, "result": "abgelehnt" }));
                return fail("Der Nutzer hat diese Aktion in Fire Desktop abgelehnt (oder nicht innerhalb von 2 Minuten bestätigt). Nicht erneut ohne Rückfrage versuchen.".into());
            }
        } else {
            decision = "ohne Rückfrage (Bestätigung ausgeschaltet)";
        }
    }
    match run_tool(name, a, s.as_ref()).await {
        Ok(text) => {
            let exit = text.strip_prefix("exit_code: ").and_then(|t| t.split('\n').next()).and_then(|t| t.parse::<i32>().ok());
            add_log(json!({ "tool": name, "server": server_name, "summary": summary, "args": a, "decision": decision, "result": if exit.unwrap_or(0) == 0 { "ok" } else { "ok (Befehl mit Fehlercode)" }, "exitCode": exit, "durationMs": started.elapsed().as_millis() as u64, "output": text }));
            json!({ "content": [{ "type": "text", "text": text }] })
        }
        Err(e) => {
            add_log(json!({ "tool": name, "server": server_name, "summary": summary, "args": a, "decision": decision, "result": format!("Fehler: {e}"), "durationMs": started.elapsed().as_millis() as u64 }));
            fail(format!("Fehler: {e}"))
        }
    }
}

// ---------- JSON-RPC über HTTP ----------

async fn rpc(msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg["method"].as_str().unwrap_or("");
    let p = &msg["params"];
    let reply = |r: Value| Some(json!({ "jsonrpc": "2.0", "id": id, "result": r }));
    match method {
        "initialize" => {
            let client = format!("{} {}", p["clientInfo"]["name"].as_str().unwrap_or("Client"), p["clientInfo"]["version"].as_str().unwrap_or("")).trim().to_string();
            *CLIENT.lock().unwrap() = client.clone();
            add_log(json!({ "tool": "verbunden", "server": "–", "summary": client, "result": "ok" }));
            let v = p["protocolVersion"].as_str().filter(|v| ["2025-06-18", "2025-03-26", "2024-11-05"].contains(v)).unwrap_or("2025-06-18");
            reply(json!({
                "protocolVersion": v,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "fire-desktop", "title": "Fire Desktop (24fire)", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "Verwaltet 24fire-KVM-Server des Nutzers. Zuerst list_servers aufrufen. Riskante Aktionen (Stop, Schreiben, Löschen, Shell) muss der Nutzer in der App bestätigen; abgelehnte Aktionen nicht ungefragt wiederholen.",
            }))
        }
        "ping" => reply(json!({})),
        "tools/list" => reply(json!({ "tools": tools() })),
        "tools/call" => reply(call_tool(p["name"].as_str().unwrap_or(""), &p["arguments"]).await),
        _ if id.is_none() => None,
        _ => Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("Method not found: {method}") } })),
    }
}

fn token_ok(header: &str) -> bool {
    let Some(tok) = store::read().claude.token.and_then(|t| t.reveal()) else { return false };
    let got = header.strip_prefix("Bearer ").or(header.strip_prefix("bearer ")).unwrap_or("").trim();
    got.len() == tok.len() && got.bytes().zip(tok.bytes()).fold(0u8, |a, (x, y)| a | (x ^ y)) == 0
}

async fn respond(s: &mut TcpStream, code: &str, body: &str) {
    let head = format!("HTTP/1.1 {code}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    let _ = s.write_all(head.as_bytes()).await;
    let _ = s.write_all(body.as_bytes()).await;
}

async fn handle(mut s: TcpStream) {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    let head_end = loop {
        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") { break p; }
        match tokio::time::timeout(Duration::from_secs(10), s.read(&mut tmp)).await {
            Ok(Ok(n)) if n > 0 => buf.extend_from_slice(&tmp[..n]),
            _ => return,
        }
        if buf.len() > 65536 { return; }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap_or("").to_string();
    let hdr: HashMap<String, String> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string())).collect();
    let g = |k: &str| hdr.get(k).cloned().unwrap_or_default();

    // Schutz gegen DNS-Rebinding und Webseiten im Browser
    let host = g("host");
    let host = host.rsplit_once(':').map(|x| x.0).unwrap_or(&host);
    if !["127.0.0.1", "localhost", "[::1]"].contains(&host) { return respond(&mut s, "403 Forbidden", r#"{"error":"forbidden host"}"#).await; }
    let origin = g("origin");
    if !origin.is_empty() && !["http://127.0.0.1", "http://localhost", "https://127.0.0.1", "https://localhost"].iter().any(|o| origin.starts_with(o)) {
        return respond(&mut s, "403 Forbidden", r#"{"error":"forbidden origin"}"#).await;
    }
    let mut parts = first.split(' ');
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    if !target.starts_with("/mcp") { return respond(&mut s, "404 Not Found", r#"{"error":"not found"}"#).await; }
    if !token_ok(&g("authorization")) {
        add_log(json!({ "tool": "abgewiesen", "server": "–", "summary": "Anfrage mit falschem oder fehlendem Token", "result": "abgelehnt" }));
        return respond(&mut s, "401 Unauthorized", r#"{"error":"unauthorized"}"#).await;
    }
    if method != "POST" { return respond(&mut s, "405 Method Not Allowed", r#"{"error":"method not allowed"}"#).await; }
    let len: usize = g("content-length").parse().unwrap_or(0);
    if len > 5_000_000 { return; }
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < len {
        match s.read(&mut tmp).await { Ok(n) if n > 0 => body.extend_from_slice(&tmp[..n]), _ => return }
    }
    let Ok(msg) = serde_json::from_slice::<Value>(&body) else {
        return respond(&mut s, "400 Bad Request", r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}"#).await;
    };
    let out = if let Some(batch) = msg.as_array() {
        let mut res = Vec::new();
        for m in batch { if let Some(r) = rpc(m).await { res.push(r); } }
        if res.is_empty() { None } else { Some(Value::Array(res)) }
    } else {
        rpc(&msg).await
    };
    match out {
        Some(v) => respond(&mut s, "200 OK", &v.to_string()).await,
        None => respond(&mut s, "202 Accepted", "").await,
    }
}

// ---------- Start/Stop ----------

pub static RUNNING: AtomicBool = AtomicBool::new(false);
pub static ERROR: Mutex<String> = Mutex::new(String::new());

pub fn ensure_token() -> String {
    if let Some(t) = store::read().claude.token.and_then(|t| t.reveal()) { return t; }
    regenerate()
}

pub fn regenerate() -> String {
    let t = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let secret = store::Secret::new(&t);
    store::update(|s| s.claude.token = Some(secret));
    t
}

/// Hält den Server passend zu den Einstellungen am Laufen.
pub async fn run() {
    loop {
        let c = store::read().claude;
        if !c.enabled {
            RUNNING.store(false, Ordering::Relaxed);
            ERROR.lock().unwrap().clear();
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        }
        ensure_token();
        let port = c.port;
        let listener = match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => l,
            Err(e) => {
                *ERROR.lock().unwrap() = format!("Port {port} ist belegt ({e})");
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
        };
        ERROR.lock().unwrap().clear();
        RUNNING.store(true, Ordering::Relaxed);
        loop {
            let next = tokio::time::timeout(Duration::from_secs(1), listener.accept()).await;
            if let Ok(Ok((sock, _))) = next { tokio::spawn(handle(sock)); }
            let now = store::read().claude;
            if !now.enabled || now.port != port { break; }
        }
    }
}

fn claude_cli() -> Option<std::path::PathBuf> {
    let home = std::path::PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default());
    let mut c = vec![home.join(".local").join("bin").join("claude.exe")];
    for d in std::env::split_paths(&std::env::var("PATH").unwrap_or_default()) { c.push(d.join("claude.exe")); }
    c.into_iter().find(|p| p.exists())
}

/// Trägt den Server in Claude Code ein (per CLI, sonst direkt in ~/.claude.json).
pub fn register_code() -> Result<()> {
    use std::os::windows::process::CommandExt;
    let c = store::read().claude;
    let token = ensure_token();
    let url = format!("http://127.0.0.1:{}/mcp", c.port);
    if let Some(cli) = claude_cli() {
        let run = |args: &[&str]| std::process::Command::new(&cli).args(args).creation_flags(0x0800_0000).output();
        let _ = run(&["mcp", "remove", "fire-desktop", "--scope", "user"]);
        let hdr = format!("Authorization: Bearer {token}");
        if run(&["mcp", "add", "--transport", "http", "--scope", "user", "fire-desktop", &url, "--header", &hdr]).map(|o| o.status.success()).unwrap_or(false) {
            store::update(|s| s.claude.registered = true);
            return Ok(());
        }
    }
    let file = std::path::PathBuf::from(std::env::var("USERPROFILE")?).join(".claude.json");
    let mut j: Value = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}));
    if file.exists() { std::fs::copy(&file, file.with_extension("json.fire-desktop-backup"))?; }
    j["mcpServers"]["fire-desktop"] = json!({ "type": "http", "url": url, "headers": { "Authorization": format!("Bearer {token}") } });
    std::fs::write(&file, serde_json::to_string_pretty(&j)?)?;
    store::update(|s| s.claude.registered = true);
    Ok(())
}
