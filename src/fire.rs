//! 24fire REST API v1 (api.24fire.de) und Reseller-FireAPI.
//! Die App arbeitet mit einheitlichen Daten; die Unterschiede der APIs werden hier abgefangen.

use crate::store::Server;
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::{sync::OnceLock, time::Duration};

pub fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("Fire-Desktop/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .expect("HTTP-Client")
    })
}

#[derive(Debug, Clone)]
pub struct Reply {
    pub data: Value,
    pub meta: Value,
    pub status: u16,
    pub raw: String,
}

fn base(provider: &str, env: &str) -> String {
    // Nur für lokale Tests: andere API-Adresse
    #[cfg(debug_assertions)]
    if let Ok(b) = std::env::var("FIRE_API_BASE") { return b; }
    match (provider, env) {
        ("fireapi", "sandbox") => "https://sandbox.fireapi.de",
        ("fireapi", _) => "https://live.fireapi.de",
        _ => "https://api.24fire.de",
    }.to_string()
}

fn friendly(provider: &str, kind: &str, message: &str, status: u16) -> String {
    if provider != "fireapi" {
        match kind {
            "unauthorized" => return "Token ungültig oder abgelaufen. Seit der 24fire-Umstellung gelten alte API-Keys nicht mehr: Unter cp.24fire.de → Kontoeinstellungen → API-Keys einen neuen Token erstellen und hier über „API-Key ändern“ eintragen.".into(),
            "insufficient_scope" => return "Dem Token fehlt die nötige Berechtigung (Scope). Bitte einen Token mit den passenden Scopes erstellen.".into(),
            "ip_not_allowed" => return "Deine aktuelle IP ist für diesen Token nicht freigegeben (IP-Allowlist des Tokens prüfen).".into(),
            "too_many_requests" => return "Zu viele Anfragen – bitte kurz warten.".into(),
            "upstream_error" => return "24fire meldet einen Fehler im Hintergrundsystem. Bitte später erneut versuchen.".into(),
            _ => {}
        }
    } else if kind == "authorization_failed" {
        return "FireAPI-Key ungültig. Für normale 24fire-Kunden „24fire Kundenkonto“ wählen.".into();
    }
    if message.is_empty() { format!("HTTP {status}") } else { message.to_string() }
}

/// Roher Aufruf. `path` ist absolut (/v1/…), `form` wird als Formular gesendet (bei GET als Query).
pub async fn raw(provider: &str, env: &str, key: &str, method: &str, path: &str, form: &[(&str, String)]) -> Result<Reply> {
    let url = format!("{}{}", base(provider, env), path);
    let m = reqwest::Method::from_bytes(method.as_bytes())?;
    let mut req = client().request(m, url).header("Accept", "application/json");
    req = if provider == "fireapi" { req.header("X-FIRE-APIKEY", key) } else { req.bearer_auth(key) };
    if !form.is_empty() {
        req = if method == "GET" { req.query(form) } else { req.form(form) };
    }
    let res = req.send().await.map_err(|e| anyhow!("Netzwerkfehler: {e}"))?;
    let status = res.status().as_u16();
    let ok = res.status().is_success();
    let text = res.text().await.unwrap_or_default();
    let json: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !ok || (json.is_object() && json["status"] != "success") {
        bail!(friendly(provider, json["type"].as_str().unwrap_or(""), json["message"].as_str().unwrap_or(""), status));
    }
    Ok(Reply { data: json["data"].clone(), meta: json["meta"].clone(), status, raw: text })
}

async fn call(s: &Server, method: &str, tail: &str, form: &[(&str, String)]) -> Result<Reply> {
    let key = s.api_key().ok_or_else(|| anyhow!("Der gespeicherte API-Key kann nicht mehr entschlüsselt werden. Bitte über „API-Key ändern“ neu eingeben."))?;
    let prefix = if s.provider == "fireapi" { format!("/vm/{}", s.sid) } else { format!("/v1/servers/{}", s.sid) };
    raw(&s.provider, &s.env, &key, method, &format!("{prefix}{tail}"), form).await
}

fn str_of(v: &Value) -> String {
    match v { Value::String(s) => s.clone(), Value::Null => String::new(), o => o.to_string() }
}

fn num(v: &Value) -> f64 {
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).unwrap_or(0.0)
}

// ---------- Liste ----------

#[derive(Clone, Debug)]
pub struct Found {
    pub sid: String,
    pub name: String,
    pub spec: String,
}

pub async fn list_servers(provider: &str, env: &str, key: &str) -> Result<Vec<Found>> {
    if provider == "fireapi" {
        let r = raw(provider, env, key, "GET", "/vm/list", &[]).await?;
        return Ok(r.data["list"].as_array().into_iter().flatten().map(|v| Found {
            sid: str_of(&v["vmid"]),
            name: format!("VM {}", str_of(&v["vmid"])),
            spec: format!("{} Kerne · {} MB RAM · {} GB", str_of(&v["config"]["cores"]), str_of(&v["config"]["mem"]), str_of(&v["config"]["disk"])),
        }).collect());
    }
    let mut out = Vec::new();
    let mut page = 1;
    loop {
        let r = raw(provider, env, key, "GET", "/v1/servers", &[("page", page.to_string())]).await?;
        for v in r.data.as_array().into_iter().flatten() {
            out.push(Found {
                sid: str_of(&v["id"]),
                name: v["name"].as_str().unwrap_or("KVM").to_string(),
                spec: v["type"].as_str().unwrap_or("").to_string(),
            });
        }
        if page >= r.meta["last_page"].as_i64().unwrap_or(1) { break; }
        page += 1;
    }
    Ok(out)
}

// ---------- Status ----------

#[derive(Clone, Debug, Default)]
pub struct Status {
    pub running: bool,
    pub state: String,
    pub uptime: u64,
    pub task: String,
    pub cpu: f64,
    pub mem: f64,
    pub mem_unit: String,
    pub disk: f64,
}

pub async fn status(s: &Server) -> Result<Status> {
    let d = call(s, "GET", "/status", &[]).await?.data;
    let state = d["status"].as_str().or(d["state"].as_str()).or(d["power_state"].as_str()).unwrap_or("").to_string();
    Ok(Status {
        running: state == "running",
        uptime: d["uptime"].as_u64().unwrap_or(0),
        task: d["task"].as_str().unwrap_or("").to_string(),
        cpu: num(&d["usage"]["cpu"]["data"]),
        mem: num(&d["usage"]["mem"]["data"]),
        mem_unit: d["usage"]["mem"]["unit"].as_str().unwrap_or("").to_string(),
        disk: num(&d["usage"]["nvme_storage"]["data"]),
        state,
    })
}

impl Status {
    /// RAM in GB. Die API meldet je nach Host GB, teils trotz Einheit „MB“.
    pub fn mem_gb(&self, total_mb: f64) -> f64 {
        if self.mem_unit.eq_ignore_ascii_case("GB") || (total_mb > 0.0 && self.mem < total_mb / 64.0) { self.mem } else { self.mem / 1024.0 }
    }
}

// ---------- Konfiguration ----------

#[derive(Clone, Debug, Default)]
pub struct Config {
    pub identifier: String,
    pub cores: i64,
    pub mem_mb: f64,
    pub disk_gb: f64,
    pub os: String,
    pub hostname: String,
    pub username: String,
    pub password: String,
    pub network_speed: i64,
    pub backup_slots: i64,
    pub ipv4: Vec<String>,
    pub ipv6: Vec<String>,
    pub ddos: String,
    pub abuse: String,
    pub dc: String,
    pub location: String,
    pub node: String,
    pub cpu_model: String,
    pub raw: Value,
}

pub async fn config(s: &Server) -> Result<Config> {
    let d = call(s, "GET", "/config", &[]).await?.data;
    // Neue API kann die Felder flach liefern
    let c = if d["config"].is_object() { d["config"].clone() } else { d.clone() };
    let h = &d["hostsystem"];
    let ips = |k: &str| -> Vec<String> {
        c[k].as_array().into_iter().flatten().map(|v| v["ip_address"].as_str().map(String::from).unwrap_or_else(|| str_of(v))).collect()
    };
    Ok(Config {
        identifier: str_of(if d["identifier"].is_null() { &d["id"] } else { &d["identifier"] }),
        cores: c["cores"].as_i64().unwrap_or(0),
        mem_mb: num(&c["mem"]),
        disk_gb: num(&c["disk"]),
        os: c["os"]["displayname"].as_str().map(String::from).unwrap_or_else(|| str_of(&c["os"])),
        hostname: str_of(&c["hostname"]),
        username: c["username"].as_str().unwrap_or("root").to_string(),
        password: str_of(&c["password"]),
        network_speed: c["network_speed"].as_i64().unwrap_or(0),
        backup_slots: c["backup_slots"].as_i64().unwrap_or(0),
        ipv4: ips("ipv4"),
        ipv6: ips("ipv6"),
        ddos: str_of(&c["ipv4"][0]["ddos_protection"]),
        abuse: str_of(&d["abuse_status"]),
        dc: str_of(&h["datacenter"]["name"]),
        location: [str_of(&h["datacenter"]["city"]), str_of(&h["datacenter"]["country"])].iter().filter(|x| !x.is_empty()).cloned().collect::<Vec<_>>().join(", "),
        node: str_of(&h["node"]),
        cpu_model: str_of(&h["processor"]),
        raw: d,
    })
}

#[derive(Clone, Debug, Default)]
pub struct Traffic {
    pub total: f64,
    pub incoming: f64,
    pub outgoing: f64,
    pub limit: f64,
}

pub async fn traffic(s: &Server) -> Result<Traffic> {
    let tail = if s.provider == "fireapi" { "/traffic/current" } else { "/traffic" };
    let d = call(s, "GET", tail, &[]).await?.data;
    Ok(Traffic {
        total: num(&d["usage"]["total"]),
        incoming: num(&d["usage"]["in"]),
        outgoing: num(&d["usage"]["out"]),
        limit: num(&d["limit"]["monthly"]) + num(&d["limit"]["additional"]),
    })
}

pub async fn power(s: &Server, mode: &str) -> Result<()> {
    call(s, "POST", "/power", &[("mode", mode.to_string())]).await.map(|_| ())
}

pub async fn console_url(s: &Server) -> Result<String> {
    let tail = if s.provider == "fireapi" { "/novnc" } else { "/console" };
    let d = call(s, "POST", tail, &[]).await?.data;
    ["link", "url", "console_url"].iter().find_map(|k| d[*k].as_str().map(String::from)).ok_or_else(|| anyhow!("Kein Konsolen-Link erhalten"))
}

// ---------- Monitoring ----------

#[derive(Clone, Debug, Default)]
pub struct Timing {
    pub time: i64,
    pub cpu: f64,
    pub mem_gb: f64,
    pub ping: f64,
}

#[derive(Clone, Debug, Default)]
pub struct Monitoring {
    pub timings: Vec<Timing>,
    pub avail: Vec<(String, f64, i64, i64)>, // Zeitraum, %, Ausfälle, Minuten
    pub incidents: Vec<(String, String, String)>, // Start, Typ, Dauer
}

pub async fn monitoring(s: &Server) -> Result<Monitoring> {
    if s.provider == "fireapi" {
        let d = call(s, "POST", "/metrics", &[("range", "day".to_string()), ("aggregation", "avg".to_string())]).await?.data;
        let timings = d["timings"].as_array().into_iter().flatten().map(|t| Timing {
            time: t["time"].as_i64().unwrap_or(0),
            cpu: num(&t["cpu_usage"]) * 100.0,
            mem_gb: num(&t["mem_usage"]) / 1024f64.powi(3),
            ping: 0.0,
        }).collect();
        return Ok(Monitoring { timings, ..Default::default() });
    }
    let d = call(s, "GET", "/monitoring", &[]).await?.data;
    let list = if d.is_array() { &d } else if d["timings"].is_array() { &d["timings"] } else { &d["measurements"] };
    let mut timings: Vec<Timing> = list.as_array().into_iter().flatten().map(|t| Timing {
        time: chrono::DateTime::parse_from_rfc3339(t["date"].as_str().unwrap_or("")).map(|x| x.timestamp()).unwrap_or(0),
        cpu: num(&t["cpu"]),
        mem_gb: num(&t["mem"]),
        ping: num(&t["ping"]),
    }).collect();
    timings.sort_by_key(|t| t.time);
    let st = if d["statistic"].is_object() { &d["statistic"] } else { &d["statistics"] };
    let avail = [("LAST_24_HOURS", "24 Stunden"), ("LAST_7_DAYS", "7 Tage"), ("LAST_30_DAYS", "30 Tage")].iter().filter(|(k, _)| st[*k].is_object()).map(|(k, l)| {
        (l.to_string(), num(&st[*k]["availability"]), st[*k]["incidences"].as_i64().unwrap_or(0), st[*k]["downtime"].as_i64().unwrap_or(0))
    }).collect();
    let inc = if d["incidences"].is_array() { &d["incidences"] } else { &d["incidents"] };
    let incidents = inc.as_array().into_iter().flatten().take(15).map(|i| {
        let dur = if i["end"].is_null() { "läuft noch".to_string() } else { format!("{} min", i["downtime"].as_i64().unwrap_or(0)) };
        (short_date(i["start"].as_str().unwrap_or("")), str_of(&i["type"]), dur)
    }).collect();
    Ok(Monitoring { timings, avail, incidents })
}

pub fn short_date(iso: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(iso)
        .map(|d| d.with_timezone(&chrono::Local).format("%d.%m.%y %H:%M").to_string())
        .unwrap_or_else(|_| iso.to_string())
}

// ---------- Backups ----------

#[derive(Clone, Debug, Default)]
pub struct Backup {
    pub id: String,
    pub created: String,
    pub description: String,
    pub os: String,
    pub size_mb: f64,
    pub status: String,
}

pub async fn backups(s: &Server) -> Result<Vec<Backup>> {
    let tail = if s.provider == "fireapi" { "/backup/list" } else { "/backups" };
    let d = call(s, "GET", tail, &[]).await?.data;
    let list = if d.is_array() { d.clone() } else if d["backups"].is_array() { d["backups"].clone() } else { d["list"].clone() };
    let mut rows: Vec<(String, Backup)> = list.as_array().into_iter().flatten().map(|b| {
        let created = b["created"].as_str().or(b["created_at"].as_str()).unwrap_or("").to_string();
        (created.clone(), Backup {
            id: str_of(if b["backup_id"].is_null() { &b["id"] } else { &b["backup_id"] }),
            created: short_date(&created),
            description: b["backup_description"].as_str().or(b["description"].as_str()).unwrap_or("").to_string(),
            os: b["backup_os"].as_str().or(b["os"].as_str()).unwrap_or("").to_string(),
            size_mb: num(&b["size"]),
            status: str_of(&b["status"]),
        })
    }).collect();
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(rows.into_iter().map(|r| r.1).collect())
}

pub async fn backup_create(s: &Server, description: &str) -> Result<()> {
    let tail = if s.provider == "fireapi" { "/backup/create" } else { "/backups" };
    call(s, "POST", tail, &[("description", description.to_string())]).await.map(|_| ())
}

pub async fn backup_restore(s: &Server, id: &str) -> Result<()> {
    if s.provider == "fireapi" {
        return call(s, "POST", "/backup/restore", &[("backup_id", id.to_string())]).await.map(|_| ());
    }
    call(s, "POST", &format!("/backups/{id}/restore"), &[]).await.map(|_| ())
}

pub async fn backup_delete(s: &Server, id: &str) -> Result<()> {
    if s.provider == "fireapi" {
        return call(s, "DELETE", "/backup/delete", &[("backup_id", id.to_string())]).await.map(|_| ());
    }
    call(s, "DELETE", &format!("/backups/{id}"), &[]).await.map(|_| ())
}

/// Für Claude: Server-Infos ohne Passwörter.
pub async fn summary(s: &Server) -> Result<Value> {
    let (st, cfg, tr) = tokio::join!(status(s), config(s), traffic(s));
    let st = st?;
    let mut raw = cfg?.raw;
    if raw["config"].is_object() { raw["config"].as_object_mut().unwrap().remove("password"); }
    if let Some(o) = raw.as_object_mut() { o.remove("password"); }
    let tr = tr.ok();
    Ok(json!({
        "name": s.name,
        "status": { "status": st.state, "uptime": st.uptime, "task": st.task, "cpu_percent": st.cpu, "mem": st.mem, "mem_unit": st.mem_unit, "disk_gb": st.disk },
        "config": raw,
        "traffic_gb": tr.map(|t| json!({ "total": t.total, "in": t.incoming, "out": t.outgoing, "limit": t.limit })),
    }))
}
