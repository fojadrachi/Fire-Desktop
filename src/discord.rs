//! Discord Rich Presence über die lokale IPC-Pipe des Discord-Clients.

use crate::{fire, store};
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};

// Öffentliche ID der Discord-Application; ein Client-Secret wird für RPC nicht gebraucht
const CLIENT_ID: &str = "1563152980948156436";

#[derive(Clone, Debug, Default)]
pub struct State {
    pub connected: bool,
    pub user: String,
    pub error: String,
    pub details: String,
    pub state: String,
}

pub static STATE: Mutex<Option<State>> = Mutex::new(None);
pub static ACTIVE: Mutex<String> = Mutex::new(String::new());

pub fn state() -> State { STATE.lock().unwrap().clone().unwrap_or_default() }
fn set(f: impl FnOnce(&mut State)) {
    let mut g = STATE.lock().unwrap();
    f(g.get_or_insert_with(State::default));
}

async fn send(p: &mut NamedPipeClient, op: u32, v: &Value) -> Result<()> {
    let data = serde_json::to_vec(v)?;
    let mut buf = Vec::with_capacity(8 + data.len());
    buf.extend_from_slice(&op.to_le_bytes());
    buf.extend_from_slice(&(data.len() as u32).to_le_bytes());
    buf.extend(data);
    p.write_all(&buf).await?;
    Ok(())
}

async fn recv(p: &mut NamedPipeClient) -> Result<(u32, Value)> {
    let op = p.read_u32_le().await?;
    let len = p.read_u32_le().await? as usize;
    if len > 1 << 20 { bail!("Discord-Antwort zu groß"); }
    let mut buf = vec![0u8; len];
    p.read_exact(&mut buf).await?;
    Ok((op, serde_json::from_slice(&buf).unwrap_or(Value::Null)))
}

async fn connect() -> Result<NamedPipeClient> {
    let mut pipe = None;
    for i in 0..10 {
        if let Ok(c) = ClientOptions::new().open(format!(r"\\?\pipe\discord-ipc-{i}")) {
            pipe = Some(c);
            break;
        }
    }
    let mut p = pipe.ok_or_else(|| anyhow!("Discord läuft nicht (Desktop-App starten)"))?;
    send(&mut p, 0, &json!({ "v": 1, "client_id": CLIENT_ID })).await?;
    let (op, msg) = recv(&mut p).await?;
    if op == 2 { bail!("{}", msg["message"].as_str().unwrap_or("Discord hat die Verbindung geschlossen")); }
    let u = &msg["data"]["user"];
    let user = u["global_name"].as_str().or(u["username"].as_str()).unwrap_or("").to_string();
    set(|s| { s.connected = true; s.user = user; s.error.clear(); });
    Ok(p)
}

fn gb(v: f64) -> String {
    let s = format!("{v:.prec$}", prec = if v >= 100.0 { 0 } else { 1 });
    format!("{} GB", s.trim_end_matches(".0"))
}

pub fn uptime_text(sec: u64) -> String {
    let (d, h, m) = (sec / 86400, (sec % 86400) / 3600, (sec % 3600) / 60);
    if sec == 0 { "–".into() } else if d > 0 { format!("{d}d {h}h") } else if h > 0 { format!("{h}h {m}m") } else { format!("{m}m") }
}

/// Platzhalter-Werte für die Status-Texte.
pub async fn vars() -> (HashMap<&'static str, String>, u64) {
    let st = store::read();
    let mut v = HashMap::new();
    let mut online = 0;
    let mut current = None;
    let active = ACTIVE.lock().unwrap().clone();
    let target = if st.discord.server == "active" { active } else { st.discord.server.clone() };
    for s in &st.servers {
        let r = fire::status(s).await.ok();
        if r.as_ref().is_some_and(|x| x.running) { online += 1; }
        if s.id == target { current = Some((s.clone(), r)); }
    }
    if current.is_none() && st.discord.server != "all" {
        if let Some(s) = st.servers.iter().find(|s| s.api_key().is_some()) {
            current = Some((s.clone(), fire::status(s).await.ok()));
        }
    }
    v.insert("servers", st.servers.len().to_string());
    v.insert("online", online.to_string());
    let Some((s, status)) = current else {
        v.insert("name", format!("{} Server", st.servers.len()));
        v.insert("status", format!("{online}/{} online", st.servers.len()));
        return (v, 0);
    };
    let (cfg, tr) = tokio::join!(fire::config(&s), fire::traffic(&s));
    let cfg = cfg.unwrap_or_default();
    let tr = tr.unwrap_or_default();
    let st0 = status.clone().unwrap_or_default();
    let mem = st0.mem_gb(cfg.mem_mb);
    let mem_max = cfg.mem_mb / 1024.0;
    v.insert("name", s.name.clone());
    v.insert("status", match &status { None => "Unbekannt".into(), Some(x) if x.running => "Online".into(), _ => "Offline".to_string() });
    v.insert("cpu", format!("{:.1}%", st0.cpu));
    v.insert("ram", gb(mem));
    v.insert("ram_max", if mem_max > 0.0 { gb(mem_max) } else { "?".into() });
    v.insert("ram_pct", if mem_max > 0.0 { format!("{:.0}%", mem / mem_max * 100.0) } else { "?".into() });
    v.insert("disk", gb(st0.disk));
    v.insert("disk_max", if cfg.disk_gb > 0.0 { gb(cfg.disk_gb) } else { "?".into() });
    v.insert("uptime", uptime_text(if st0.running { st0.uptime } else { 0 }));
    v.insert("traffic", gb(tr.total));
    v.insert("traffic_max", if tr.limit > 0.0 { gb(tr.limit) } else { "∞".into() });
    v.insert("cores", cfg.cores.to_string());
    v.insert("os", cfg.os);
    (v, if st0.running { st0.uptime } else { 0 })
}

pub fn fill(tpl: &str, v: &HashMap<&str, String>) -> String {
    let mut out = tpl.to_string();
    for (k, val) in v { out = out.replace(&format!("{{{k}}}"), val); }
    out.trim().to_string()
}

// Discord verlangt 2–128 Zeichen
fn field(t: String) -> Option<String> {
    let n = t.chars().count();
    if n == 0 { None } else if n < 2 { Some(format!("{t} ")) } else { Some(t.chars().take(128).collect()) }
}

async fn activity(started: i64) -> Value {
    let d = store::read().discord;
    let (v, uptime) = vars().await;
    let (details, state) = (fill(&d.details, &v), fill(&d.state, &v));
    set(|s| { s.details = details.clone(); s.state = state.clone(); });
    let mut a = json!({ "type": if [0, 2, 3, 5].contains(&d.kind) { d.kind } else { 0 } });
    if let Some(x) = field(details) { a["details"] = json!(x); }
    if let Some(x) = field(state) { a["state"] = json!(x); }
    let mut assets = json!({});
    if !d.large_image.is_empty() {
        assets["large_image"] = json!(d.large_image.trim());
        if let Some(x) = field(fill(&d.large_text, &v)) { assets["large_text"] = json!(x); }
    }
    if !d.small_image.is_empty() {
        assets["small_image"] = json!(d.small_image.trim());
        if let Some(x) = field(fill(&d.small_text, &v)) { assets["small_text"] = json!(x); }
    }
    if assets.as_object().is_some_and(|o| !o.is_empty()) { a["assets"] = assets; }
    let now = chrono::Local::now().timestamp_millis();
    match d.timer.as_str() {
        "uptime" if uptime > 0 => a["timestamps"] = json!({ "start": now - uptime as i64 * 1000 }),
        "app" => a["timestamps"] = json!({ "start": started }),
        _ => {}
    }
    let buttons: Vec<Value> = d.buttons.iter().filter(|b| !b.label.is_empty() && b.url.starts_with("https://")).take(2)
        .map(|b| json!({ "label": fill(&b.label, &v).chars().take(32).collect::<String>(), "url": b.url })).collect();
    if !buttons.is_empty() { a["buttons"] = json!(buttons); }
    a
}

/// Hintergrund-Schleife: hält die Verbindung und aktualisiert alle 15 s (Discord erlaubt 5 Updates in 20 s).
pub async fn run() {
    let started = chrono::Local::now().timestamp_millis();
    let mut pipe: Option<NamedPipeClient> = None;
    let mut nonce = 0u64;
    loop {
        if !store::read().discord.enabled {
            pipe = None;
            set(|s| { s.connected = false; s.error.clear(); });
            tokio::time::sleep(Duration::from_secs(2)).await;
            continue;
        }
        if pipe.is_none() {
            match connect().await {
                Ok(p) => pipe = Some(p),
                Err(e) => set(|s| { s.connected = false; s.error = e.to_string(); }),
            }
        }
        if let Some(p) = pipe.as_mut() {
            let a = activity(started).await;
            nonce += 1;
            let msg = json!({ "cmd": "SET_ACTIVITY", "args": { "pid": std::process::id(), "activity": a }, "nonce": nonce.to_string() });
            let sent = send(p, 1, &msg).await;
            let ok = sent.is_ok() && matches!(tokio::time::timeout(Duration::from_secs(5), recv(p)).await, Ok(Ok((1, _))));
            if !ok {
                pipe = None;
                set(|s| { s.connected = false; s.error = "Verbindung zu Discord getrennt".into(); });
            }
        }
        tokio::time::sleep(Duration::from_secs(if pipe.is_some() { 15 } else { 20 })).await;
    }
}
