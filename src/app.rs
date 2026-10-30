//! Steuerung: verbindet die Slint-Oberfläche mit API, SSH, Minecraft, Claude und Discord.

use crate::{discord, fire, mc, mcp, ssh, store, updater};
use crate::{AppWindow, AuditItem, AccessItem, AvailItem, BackupItem, FileItem, FoundItem, IncidentItem, KV, LineItem, RuleItem, SideItem, SiteItem, TermRow, TermRun, ToastItem, TransferItem, S};
use anyhow::{anyhow, bail, Result};
use russh_sftp::client::SftpSession;
use serde_json::Value;
use slint::{Color, ComponentHandle, Model, ModelRc, SharedString, VecModel, Weak};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Mutex as AsyncMutex};

// ---------- Grundgerüst ----------

static WINDOW: OnceLock<Weak<AppWindow>> = OnceLock::new();
static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

fn rt() -> &'static tokio::runtime::Runtime {
    RT.get_or_init(|| tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("Tokio"))
}

fn spawn(f: impl std::future::Future<Output = ()> + Send + 'static) { rt().spawn(f); }

/// Führt `f` im UI-Thread aus.
fn ui(f: impl FnOnce(&AppWindow, S<'_>) + Send + 'static) {
    let Some(w) = WINDOW.get().cloned() else { return };
    let _ = slint::invoke_from_event_loop(move || {
        if let Some(app) = w.upgrade() {
            let s = app.global::<S>();
            f(&app, s);
        }
    });
}

fn model<T: Clone + 'static>(v: Vec<T>) -> ModelRc<T> { ModelRc::new(VecModel::from(v)) }
fn ss(s: impl AsRef<str>) -> SharedString { s.as_ref().into() }
fn line(text: impl AsRef<str>, kind: &str) -> LineItem { LineItem { text: ss(text), kind: ss(kind) } }

fn toast(text: impl Into<String>, kind: &'static str) {
    let text = text.into();
    ui(move |_, s| {
        let mut v: Vec<ToastItem> = s.get_toasts().iter().collect();
        v.push(ToastItem { text: ss(&text), kind: ss(kind) });
        if v.len() > 4 { v.remove(0); }
        s.set_toasts(model(v));
    });
    spawn(async {
        tokio::time::sleep(Duration::from_secs(5)).await;
        ui(|_, s| {
            let mut v: Vec<ToastItem> = s.get_toasts().iter().collect();
            if !v.is_empty() { v.remove(0); }
            s.set_toasts(model(v));
        });
    });
}

type DlgFn = Box<dyn FnOnce(Option<String>) + Send>;
static DLG: Mutex<Option<DlgFn>> = Mutex::new(None);

fn dialog(title: &str, text: &str, input: Option<&str>, ok: &str, danger: bool, f: impl FnOnce(Option<String>) + Send + 'static) {
    *DLG.lock().unwrap() = Some(Box::new(f));
    let (title, text, ok, input) = (title.to_string(), text.to_string(), ok.to_string(), input.map(String::from));
    ui(move |_, s| {
        s.set_dlg_title(ss(title));
        s.set_dlg_text(ss(text));
        s.set_dlg_ok(ss(ok));
        s.set_dlg_danger(danger);
        s.set_dlg_input(input.is_some());
        s.set_dlg_secret(false);
        s.set_dlg_value(ss(input.unwrap_or_default()));
        s.set_dlg_open(true);
    });
}

fn confirm(title: &str, text: &str, ok: &str, f: impl FnOnce() + Send + 'static) {
    dialog(title, text, None, ok, true, move |r| { if r.is_some() { f(); } });
}

// ---------- Zustand ----------

#[derive(Default)]
struct App {
    active: String,
    cfg: Option<fire::Config>,
    traffic: Option<fire::Traffic>,
    status: HashMap<String, std::result::Result<fire::Status, String>>,
    entries: Vec<ssh::Entry>,
    selected: HashSet<String>,
    cwd: String,
    home: String,
    filter: String,
    ed_original: String,
    ed_previous: Option<String>,
    ngx_debian: bool,
}

static STATE: OnceLock<Mutex<App>> = OnceLock::new();
const LIVE_POINTS: usize = 120; // bei 10 Sekunden Abstand rund 20 Minuten
static LIVE: OnceLock<Mutex<HashMap<String, VecDeque<(f64, f64, u64)>>>> = OnceLock::new();
fn st() -> std::sync::MutexGuard<'static, App> { STATE.get_or_init(|| Mutex::new(App::default())).lock().unwrap() }
fn active() -> Option<store::Server> { store::server(&st().active) }

#[derive(Clone)]
struct Remote {
    server: String,
    conn: Arc<ssh::Conn>,
    sftp: Arc<SftpSession>,
}
static REMOTE: Mutex<Option<Remote>> = Mutex::new(None);

fn remote_now() -> Option<Remote> { REMOTE.lock().unwrap().clone().filter(|r| r.conn.alive()) }

fn creds() -> (String, u16, String, String) {
    static_creds().lock().unwrap().clone()
}
fn static_creds() -> &'static Mutex<(String, u16, String, String)> {
    static C: OnceLock<Mutex<(String, u16, String, String)>> = OnceLock::new();
    C.get_or_init(|| Mutex::new((String::new(), 22, "root".into(), String::new())))
}

fn sync_creds(s: &S<'_>) {
    *static_creds().lock().unwrap() = (s.get_ssh_host().to_string(), s.get_ssh_port().parse().unwrap_or(22), s.get_ssh_user().to_string(), s.get_ssh_pass().to_string());
}

async fn ensure_remote() -> Result<Remote> {
    let id = st().active.clone();
    if let Some(r) = remote_now().filter(|r| r.server == id) { return Ok(r); }
    let (host, port, user, pass) = creds();
    if host.is_empty() { bail!("Keine IP bekannt – im Konsole-Tab unter „Zugangsdaten“ eintragen."); }
    let conn = Arc::new(ssh::connect(&id, &host, port, &user, &pass).await?);
    let sftp = conn.sftp().await?;
    let home = sftp.canonicalize(".").await.unwrap_or_else(|_| "/".into());
    st().home = home;
    let r = Remote { server: id, conn, sftp };
    *REMOTE.lock().unwrap() = Some(r.clone());
    ui(|_, s| { s.set_remote_on(true); s.set_remote_error("".into()); });
    Ok(r)
}

fn remote_failed(e: anyhow::Error) {
    let msg = e.to_string();
    ui(move |_, s| { s.set_remote_on(false); s.set_remote_error(ss(msg)); });
}

// ---------- Anzeige ----------

fn uptime(sec: u64) -> String { discord::uptime_text(sec) }

fn bytes(b: f64) -> String {
    let u = ["B", "KB", "MB", "GB", "TB"];
    let (mut v, mut i) = (b, 0);
    while v.abs() >= 1024.0 && i < u.len() - 1 { v /= 1024.0; i += 1; }
    format!("{v:.prec$} {}", u[i], prec = if v >= 100.0 || i == 0 { 0 } else { 1 })
}

fn side_servers(s: &S<'_>) {
    let a = st();
    let data = store::read();
    let rows: Vec<SideItem> = data.servers.iter().map(|x| {
        let dot = match a.status.get(&x.id) {
            None => "",
            Some(Err(_)) => "error",
            Some(Ok(t)) if !t.task.is_empty() => "busy",
            Some(Ok(t)) if t.running => "running",
            _ => "stopped",
        };
        SideItem { id: ss(&x.id), name: ss(&x.name), sub: ss(if x.provider == "fireapi" { format!("VM {}", x.sid) } else { "24fire KVM".to_string() }), dot: ss(dot) }
    }).collect();
    let online = a.status.values().filter(|x| matches!(x, Ok(t) if t.running)).count();
    s.set_foot(ss(if rows.is_empty() { "Keine Server".into() } else { format!("{} Server · {online} online", rows.len()) }));
    s.set_servers(model(rows));
}

fn render_server(s: &S<'_>) {
    let a = st();
    let Some(srv) = store::server(&a.active) else { return };
    s.set_srv_name(ss(&srv.name));
    let cfg = a.cfg.clone().unwrap_or_default();
    // Die 24fire-API liefert das Passwort nicht; dann das zuletzt funktionierende anzeigen
    s.set_srv_pass(ss(if cfg.password.is_empty() { srv.saved_ssh().unwrap_or_default() } else { cfg.password.clone() }));
    match a.status.get(&a.active) {
        None => { s.set_srv_pill("Lädt…".into()); s.set_srv_pill_kind("".into()); }
        Some(Err(e)) => {
            s.set_srv_pill("Nicht erreichbar".into());
            s.set_srv_pill_kind("warn".into());
            s.set_cpu("–".into());
            s.set_srv_meta(ss(e));
        }
        Some(Ok(t)) => {
            s.set_srv_pill(ss(if t.running { format!("Online · {}", uptime(t.uptime)) } else { "Offline".into() }));
            s.set_srv_pill_kind(if t.running { "good".into() } else { "warn".into() });
            s.set_srv_task(ss(&t.task));
            s.set_cpu(ss(format!("{:.1} %", t.cpu)));
            s.set_cpu_v((t.cpu / 100.0) as f32);
            let mem = t.mem_gb(cfg.mem_mb);
            let max = cfg.mem_mb / 1024.0;
            s.set_ram(ss(if max > 0.0 { format!("{mem:.2} / {max:.0} GB") } else { format!("{mem:.2} GB") }));
            s.set_ram_v(if max > 0.0 { (mem / max) as f32 } else { 0.0 });
            s.set_disk(ss(if cfg.disk_gb > 0.0 { format!("{:.1} / {:.0} GB", t.disk, cfg.disk_gb) } else { format!("{:.1} GB", t.disk) }));
            s.set_disk_v(if cfg.disk_gb > 0.0 { (t.disk / cfg.disk_gb) as f32 } else { 0.0 });
            s.set_srv_meta(ss([if cfg.identifier.is_empty() { String::new() } else { format!("KVM {}", cfg.identifier) }, cfg.ipv4.first().cloned().unwrap_or_default(), cfg.os.clone(), format!("Key {}", srv.key_hint)].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join("  ·  ")));
        }
    }
    if let Some(t) = &a.traffic {
        s.set_traffic(ss(if t.limit > 0.0 { format!("{:.1} / {:.0} GB", t.total, t.limit) } else { format!("{:.1} GB", t.total) }));
        s.set_traffic_v(if t.limit > 0.0 { (t.total / t.limit) as f32 } else { 0.0 });
    }
    let kv = |k: &str, v: String| KV { k: ss(k), v: ss(v) };
    let keep = |r: Vec<KV>| r.into_iter().filter(|x| !x.v.is_empty() && x.v != "0").collect::<Vec<_>>();
    s.set_cfg(model(keep(vec![
        kv("Betriebssystem", cfg.os.clone()), kv("Hostname", cfg.hostname.clone()), kv("CPU-Kerne", cfg.cores.to_string()),
        kv("Arbeitsspeicher", if cfg.mem_mb > 0.0 { format!("{} MB", cfg.mem_mb) } else { String::new() }),
        kv("NVMe", if cfg.disk_gb > 0.0 { format!("{} GB", cfg.disk_gb) } else { String::new() }),
        kv("Netzwerk", if cfg.network_speed > 0 { format!("{} Mbit/s", cfg.network_speed) } else { String::new() }),
        kv("Backup-Slots", cfg.backup_slots.to_string()), kv("Abuse-Status", cfg.abuse.clone()),
    ])));
    let mut net: Vec<KV> = cfg.ipv4.iter().map(|i| kv("IPv4", i.clone())).collect();
    net.extend(cfg.ipv6.iter().map(|i| kv("IPv6", i.clone())));
    net.push(kv("DDoS-Schutz", cfg.ddos.clone()));
    net.push(kv("Benutzer", cfg.username.clone()));
    if let Some(ip) = cfg.ipv4.first() { net.push(kv("SSH", format!("ssh {}@{ip}", cfg.username))); }
    s.set_net(model(keep(net)));
    s.set_host(model(keep(vec![kv("Rechenzentrum", cfg.dc.clone()), kv("Standort", cfg.location.clone()), kv("Node", cfg.node.clone()), kv("Prozessor", cfg.cpu_model.clone())])));
}

async fn refresh(with_config: bool) {
    let Some(srv) = active() else { return };
    let id = srv.id.clone();
    let res = fire::status(&srv).await.map_err(|e| e.to_string());
    if let Err(e) = &res {
        let first = !matches!(st().status.get(&id), Some(Err(_)));
        if first { toast(e.clone(), "err"); }
    }
    let cfg = if with_config || st().cfg.is_none() { fire::config(&srv).await.ok() } else { None };
    let tr = if with_config { fire::traffic(&srv).await.ok() } else { None };
    {
        let mut a = st();
        if a.active != id { return; }
        a.status.insert(id, res);
        if cfg.is_some() { a.cfg = cfg.clone(); }
        if tr.is_some() { a.traffic = tr; }
        if let Some(Ok(t)) = a.status.get(&srv.id) {
            let (cpu, mem) = if t.running { (t.cpu, t.mem_gb(a.cfg.as_ref().map(|c| c.mem_mb).unwrap_or(0.0))) } else { (0.0, 0.0) };
            let mut live = LIVE.get_or_init(Default::default).lock().unwrap();
            let v = live.entry(srv.id.clone()).or_default();
            // 24fire erneuert /status nur etwa alle 10 Sekunden, doppelte Abrufe nicht aufzeichnen
            if !t.running || v.back().map(|x| x.2) != Some(t.uptime) {
                v.push_back((cpu, mem, t.uptime));
                if v.len() > LIVE_POINTS { v.pop_front(); }
            }
        }
    }
    if let Some(c) = cfg {
        let saved = srv.saved_ssh().unwrap_or_default();
        ui(move |_, s| {
            s.set_ssh_host(ss(c.ipv4.first().cloned().unwrap_or_default()));
            s.set_ssh_user(ss(&c.username));
            s.set_ssh_pass(ss(if c.password.is_empty() { saved } else { c.password.clone() }));
            sync_creds(&s);
        });
    }
    ui(|_, s| { side_servers(&s); render_server(&s); render_live(&s); });
}

fn select_server(id: String) {
    term_stop();
    if let Some(r) = REMOTE.lock().unwrap().take() { spawn(async move { r.conn.close().await; }); }
    {
        let mut a = st();
        a.active = id.clone();
        a.cfg = None;
        a.traffic = None;
        a.cwd.clear();
        a.entries.clear();
        a.selected.clear();
    }
    *discord::ACTIVE.lock().unwrap() = id.clone();
    ui(move |_, s| {
        s.set_active_mc("".into());
        s.set_active_id(ss(id));
        s.set_remote_on(false);
        s.set_remote_error("".into());
        s.set_srv_pass_show(false);
        s.set_ssh_pass_show(false);
        s.set_files(model(vec![]));
        s.set_term(model(vec![]));
        s.set_srv_task("".into());
        s.set_cfg(model(vec![]));
        s.set_net(model(vec![]));
        s.set_host(model(vec![]));
        for f in [S::set_cpu, S::set_ram, S::set_disk, S::set_traffic] { f(&s, "–".into()); }
        render_server(&s);
        render_live(&s);
        load_tab(s.get_tab());
    });
    spawn(refresh(true));
}

fn load_tab(tab: i32) {
    match tab {
        2 => spawn(load_files(None)),
        3 => spawn(load_nginx()),
        4 => spawn(load_stats()),
        5 => spawn(load_backups()),
        _ => {}
    }
}

// ---------- Terminal ----------

enum TermMsg { Input(Vec<u8>), Resize(u32, u32), Close }
static TERM_TX: Mutex<Option<mpsc::UnboundedSender<TermMsg>>> = Mutex::new(None);
static PARSER: Mutex<Option<vt100::Parser>> = Mutex::new(None);
static TERM_SIZE: Mutex<(u16, u16)> = Mutex::new((32, 120));
static SEL: Mutex<Option<((u16, u16), (u16, u16))>> = Mutex::new(None);
static CELL_W: Mutex<f32> = Mutex::new(7.6);

/// Auswahl von oben links nach unten rechts sortiert.
fn sel_range() -> Option<((u16, u16), (u16, u16))> {
    let (a, b) = (*SEL.lock().unwrap())?;
    if a == b { return None; }
    Some(if a <= b { (a, b) } else { (b, a) })
}

fn sel_text() -> Option<String> {
    let ((r1, c1), (r2, c2)) = sel_range()?;
    PARSER.lock().unwrap().as_ref().map(|p| p.screen().contents_between(r1, c1, r2, c2 + 1))
}

fn term_stop() {
    if let Some(tx) = TERM_TX.lock().unwrap().take() { let _ = tx.send(TermMsg::Close); }
}

fn vt_color(c: vt100::Color, fallback: Color) -> Color {
    const BASE: [(u8, u8, u8); 16] = [(21, 25, 34), (255, 84, 104), (61, 220, 132), (255, 192, 69), (90, 169, 255), (180, 156, 255), (95, 215, 230), (232, 235, 242), (95, 103, 123), (255, 120, 135), (110, 235, 160), (255, 210, 110), (130, 190, 255), (205, 185, 255), (135, 230, 240), (255, 255, 255)];
    match c {
        vt100::Color::Default => fallback,
        vt100::Color::Rgb(r, g, b) => Color::from_rgb_u8(r, g, b),
        vt100::Color::Idx(i) if i < 16 => { let (r, g, b) = BASE[i as usize]; Color::from_rgb_u8(r, g, b) }
        vt100::Color::Idx(i) if i >= 232 => { let v = 8 + (i - 232) * 10; Color::from_rgb_u8(v, v, v) }
        vt100::Color::Idx(i) => {
            let i = i - 16;
            let f = |x: u8| if x == 0 { 0 } else { 55 + x * 40 };
            Color::from_rgb_u8(f(i / 36), f((i / 6) % 6), f(i % 6))
        }
    }
}

/// Bildschirm des Emulators als Zeilen mit einheitlich formatierten Abschnitten.
fn term_rows(p: &vt100::Parser) -> Vec<(Vec<(String, Color, Color, bool)>,)> {
    let sc = p.screen();
    let (rows, cols) = sc.size();
    let (cur_r, cur_c) = sc.cursor_position();
    let (fg0, bg0) = (Color::from_rgb_u8(232, 235, 242), Color::from_argb_u8(0, 0, 0, 0));
    let sel = sel_range();
    (0..rows).map(|r| {
        let mut runs: Vec<(String, Color, Color, bool)> = Vec::new();
        for c in 0..cols {
            let Some(cell) = sc.cell(r, c) else { continue };
            if cell.is_wide_continuation() { continue; }
            let mut fg = vt_color(cell.fgcolor(), fg0);
            let mut bg = vt_color(cell.bgcolor(), bg0);
            if cell.inverse() { std::mem::swap(&mut fg, &mut bg); if bg == bg0 { bg = fg0; } if fg == bg0 { fg = Color::from_rgb_u8(7, 8, 12); } }
            if sel.is_some_and(|(a, b)| (r, c) >= a && (r, c) <= b) { bg = Color::from_rgb_u8(150, 62, 26); }
            if r == cur_r && c == cur_c && !sc.hide_cursor() { fg = Color::from_rgb_u8(7, 8, 12); bg = Color::from_rgb_u8(255, 106, 43); }
            let t = cell.contents();
            let t = if t.is_empty() { " " } else { t.as_str() };
            match runs.last_mut() {
                Some(l) if l.1 == fg && l.2 == bg && l.3 == cell.bold() => l.0.push_str(t),
                _ => runs.push((t.to_string(), fg, bg, cell.bold())),
            }
        }
        (runs,)
    }).collect()
}

fn term_render() {
    let rows = { let g = PARSER.lock().unwrap(); match g.as_ref() { Some(p) => term_rows(p), None => return } };
    ui(move |_, s| {
        let v: Vec<TermRow> = rows.into_iter().map(|(r,)| TermRow {
            runs: model(r.into_iter().map(|(text, fg, bg, bold)| TermRun { text: ss(text), fg, bg, bold }).collect()),
        }).collect();
        s.set_term(model(v));
    });
}

fn term_write(text: &str) {
    if let Some(p) = PARSER.lock().unwrap().as_mut() { p.process(text.as_bytes()); }
    term_render();
}

fn ssh_connect() {
    let id = st().active.clone();
    let (rows, cols) = *TERM_SIZE.lock().unwrap();
    *PARSER.lock().unwrap() = Some(vt100::Parser::new(rows, cols, 2000));
    let (host, port, user, pass) = creds();
    ui(|_, s| { s.set_ssh_busy(true); s.set_ssh_state("Verbinde…".into()); });
    term_write(&format!("\x1b[90mVerbinde mit {user}@{host}:{port} …\x1b[0m\r\n"));
    spawn(async move {
        let run = async {
            if host.is_empty() { bail!("Keine IP bekannt – unter „Zugangsdaten“ eintragen."); }
            let conn = ssh::connect(&id, &host, port, &user, &pass).await?;
            let ch = conn.shell(cols as u32, rows as u32).await?;
            Ok::<_, anyhow::Error>((conn, ch))
        };
        let (conn, mut ch) = match run.await {
            Ok(x) => x,
            Err(e) => {
                term_write(&format!("\x1b[31m{e}\x1b[0m\r\n"));
                ui(|_, s| { s.set_ssh_busy(false); s.set_ssh_state("Nicht verbunden".into()); });
                return;
            }
        };
        let (tx, mut rx) = mpsc::unbounded_channel();
        *TERM_TX.lock().unwrap() = Some(tx);
        ui(|_, s| { s.set_ssh_busy(false); s.set_ssh_on(true); s.set_ssh_state("Verbunden".into()); });
        let mut last = Instant::now() - Duration::from_secs(1);
        loop {
            tokio::select! {
                msg = ch.wait() => match msg {
                    Some(russh::ChannelMsg::Data { data }) | Some(russh::ChannelMsg::ExtendedData { data, .. }) => {
                        if let Some(p) = PARSER.lock().unwrap().as_mut() { p.process(&data); }
                        if last.elapsed() > Duration::from_millis(25) { last = Instant::now(); term_render(); }
                    }
                    Some(russh::ChannelMsg::Eof) | Some(russh::ChannelMsg::Close) | None => break,
                    _ => {}
                },
                m = rx.recv() => match m {
                    Some(TermMsg::Input(b)) => { if ch.data(&b[..]).await.is_err() { break; } }
                    Some(TermMsg::Resize(c, r)) => { let _ = ch.window_change(c, r, 0, 0).await; }
                    Some(TermMsg::Close) | None => break,
                },
                _ = tokio::time::sleep(Duration::from_millis(40)) => { term_render(); }
            }
        }
        conn.close().await;
        *TERM_TX.lock().unwrap() = None;
        term_write("\r\n\x1b[90m── Verbindung getrennt ──\x1b[0m\r\n");
        ui(|_, s| { s.set_ssh_on(false); s.set_ssh_state("Nicht verbunden".into()); });
    });
}

fn key_bytes(text: &str, ctrl: bool, alt: bool) -> Vec<u8> {
    let mut chars = text.chars();
    let (Some(c), None) = (chars.next(), chars.next()) else { return text.as_bytes().to_vec() };
    let seq: &[u8] = match c as u32 {
        0xF700 => b"\x1b[A", 0xF701 => b"\x1b[B", 0xF703 => b"\x1b[C", 0xF702 => b"\x1b[D",
        0xF729 => b"\x1b[H", 0xF72B => b"\x1b[F", 0xF72C => b"\x1b[5~", 0xF72D => b"\x1b[6~",
        0xF727 => b"\x1b[2~", 0x7F => b"\x1b[3~",
        0x08 => b"\x7f", 0x0A | 0x0D => b"\r", 0x09 => b"\t", 0x19 => b"\x1b[Z", 0x1B => b"\x1b",
        0xF704..=0xF73F | 0xF000..=0xF0FF => b"",
        _ => {
            if ctrl && c.is_ascii_alphabetic() { return vec![(c.to_ascii_uppercase() as u8) & 0x1f]; }
            let mut out = if alt { vec![0x1b] } else { vec![] };
            out.extend_from_slice(c.to_string().as_bytes());
            return out;
        }
    };
    seq.to_vec()
}

// ---------- Dateien ----------

fn render_files(s: &S<'_>) {
    let a = st();
    let f = a.filter.to_lowercase();
    let rows: Vec<FileItem> = a.entries.iter().filter(|e| f.is_empty() || e.name.to_lowercase().contains(&f)).map(|e| FileItem {
        name: ss(&e.name),
        is_dir: e.is_dir,
        is_link: e.is_link,
        size: ss(if e.is_dir { "–".to_string() } else { bytes(e.size as f64) }),
        date: ss(chrono::DateTime::from_timestamp(e.mtime, 0).map(|t| t.with_timezone(&chrono::Local).format("%d.%m.%y %H:%M").to_string()).unwrap_or_default()),
        perms: ss(&e.perms),
        selected: a.selected.contains(&e.name),
    }).collect();
    s.set_fm_path(ss(&a.cwd));
    s.set_fm_selected(a.selected.len() as i32);
    s.set_files(model(rows));
}

async fn load_files(path: Option<String>) {
    let r = match ensure_remote().await { Ok(r) => r, Err(e) => return remote_failed(e) };
    let target = path.unwrap_or_else(|| { let a = st(); if a.cwd.is_empty() { a.home.clone() } else { a.cwd.clone() } });
    match ssh::list(&r.sftp, &target).await {
        Ok((p, list)) => {
            {
                let mut a = st();
                if a.cwd != p { a.selected.clear(); }
                a.cwd = p;
                a.entries = list;
            }
            ui(|_, s| render_files(&s));
        }
        Err(e) => toast(format!("{target}: {e}"), "err"),
    }
}

fn selected_paths(name: &str) -> Vec<String> {
    let a = st();
    if name.is_empty() { a.selected.iter().map(|n| ssh::join(&a.cwd, n)).collect() } else { vec![ssh::join(&a.cwd, name)] }
}

// ---------- Drag & Drop ----------

static DROPPED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// Windows meldet jede Datei einzeln; kurz sammeln und dann gemeinsam hochladen.
fn on_drop(path: PathBuf) {
    let first = { let mut g = DROPPED.lock().unwrap(); g.push(path); g.len() == 1 };
    if !first { return; }
    spawn(async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let paths = std::mem::take(&mut *DROPPED.lock().unwrap());
        start_upload(paths).await;
    });
}

async fn start_upload(paths: Vec<PathBuf>) {
    if paths.is_empty() { return; }
    let r = match ensure_remote().await { Ok(r) => r, Err(e) => return toast(e.to_string(), "err") };
    if st().cwd.is_empty() { load_files(None).await; }
    let dir = st().cwd.clone();
    let name = paths[0].file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let (id, job) = transfer_start(true, if paths.len() == 1 { format!("{name} → {dir}") } else { format!("{} Elemente → {dir}", paths.len()) });
    let res = ssh::upload(r.sftp.clone(), paths, dir, job).await;
    transfer_end(&id, res);
    load_files(None).await;
}

// ---------- Taskleiste ----------

mod taskbar {
    use slint::winit_030::{winit::raw_window_handle::{HasWindowHandle, RawWindowHandle}, WinitWindowAccessor};
    use std::cell::RefCell;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::Shell::{ITaskbarList3, TaskbarList, TBPF_NOPROGRESS, TBPF_NORMAL};

    thread_local! { static LIST: RefCell<Option<ITaskbarList3>> = const { RefCell::new(None) }; }

    /// `part` None blendet den Fortschritt aus. Läuft im UI-Thread.
    pub fn set(window: &slint::Window, part: Option<f32>) {
        let Some(Some(hwnd)) = window.with_winit_window(|w| match w.window_handle().ok()?.as_raw() {
            RawWindowHandle::Win32(h) => Some(HWND(h.hwnd.get() as *mut _)),
            _ => None,
        }) else { return };
        LIST.with(|l| unsafe {
            let mut g = l.borrow_mut();
            if g.is_none() {
                if let Ok(t) = CoCreateInstance::<_, ITaskbarList3>(&TaskbarList, None, CLSCTX_INPROC_SERVER) {
                    if t.HrInit().is_ok() { *g = Some(t); }
                }
            }
            let Some(t) = g.as_ref() else { return };
            match part {
                Some(p) => {
                    let _ = t.SetProgressState(hwnd, TBPF_NORMAL);
                    let _ = t.SetProgressValue(hwnd, (p.clamp(0.0, 1.0) * 1000.0) as u64, 1000);
                }
                None => { let _ = t.SetProgressState(hwnd, TBPF_NOPROGRESS); }
            }
        });
    }
}

// ---------- Übertragungen ----------

struct Transfer {
    id: String,
    up: bool,
    label: String,
    job: Arc<ssh::Job>,
    samples: Vec<(Instant, u64)>,
    end: Option<(Instant, String, &'static str)>,
}
static TRANSFERS: Mutex<Vec<Transfer>> = Mutex::new(Vec::new());

fn transfer_start(up: bool, label: String) -> (String, Arc<ssh::Job>) {
    let id = uuid::Uuid::new_v4().to_string();
    let job = ssh::Job::new();
    TRANSFERS.lock().unwrap().push(Transfer { id: id.clone(), up, label, job: job.clone(), samples: Vec::new(), end: None });
    (id, job)
}

fn transfer_end(id: &str, res: Result<u64>) {
    let mut g = TRANSFERS.lock().unwrap();
    if let Some(t) = g.iter_mut().find(|t| t.id == id) {
        t.end = Some(match res {
            Ok(n) => (Instant::now(), format!("Fertig · {n} Datei(en), {}", bytes(t.job.total.load(Ordering::Relaxed) as f64)), "ok"),
            Err(e) if e.to_string() == "Abgebrochen" => (Instant::now(), "Abgebrochen".into(), "warn"),
            Err(e) => (Instant::now(), format!("Fehler: {e}"), "err"),
        });
    }
}

fn transfers_tick() {
    let mut g = TRANSFERS.lock().unwrap();
    g.retain(|t| t.end.as_ref().map(|e| e.0.elapsed() < Duration::from_secs(if e.2 == "ok" { 4 } else { 9 })).unwrap_or(true));
    let rows: Vec<TransferItem> = g.iter_mut().map(|t| {
        let (done, total) = (t.job.done.load(Ordering::Relaxed), t.job.total.load(Ordering::Relaxed));
        let (files, fdone) = (t.job.files.load(Ordering::Relaxed), t.job.files_done.load(Ordering::Relaxed));
        let pct = if total > 0 { done as f32 / total as f32 } else { 0.0 };
        let now = Instant::now();
        t.samples.push((now, done));
        t.samples.retain(|s| now.duration_since(s.0) < Duration::from_secs(3));
        let (t0, d0) = t.samples[0];
        let secs = now.duration_since(t0).as_secs_f64();
        let speed = if secs > 0.2 { (done - d0) as f64 / secs } else { 0.0 };
        let file = t.job.name.lock().unwrap().clone();
        match &t.end {
            Some((_, text, kind)) => TransferItem { id: ss(&t.id), up: t.up, label: ss(&t.label), pct: if *kind == "ok" { 1.0 } else { pct }, info: ss(text), file: "".into(), speed: "".into(), state: ss(*kind) },
            None => TransferItem {
                id: ss(&t.id), up: t.up, label: ss(&t.label), pct,
                info: ss(if total == 0 { "Vorbereiten…".to_string() } else { format!("{:.0} % · {} / {}", pct * 100.0, bytes(done as f64), bytes(total as f64)) }),
                file: ss(if files > 1 { format!("Datei {}/{files}: {file}", (fdone + 1).min(files)) } else { file }),
                speed: ss(if speed > 0.0 { format!("{}/s · noch {:.0} s", bytes(speed), (total - done) as f64 / speed) } else { String::new() }),
                state: "run".into(),
            },
        }
    }).collect();
    let running: Vec<(u64, u64)> = g.iter().filter(|t| t.end.is_none()).map(|t| (t.job.done.load(Ordering::Relaxed), t.job.total.load(Ordering::Relaxed))).collect();
    let part = if running.is_empty() { None } else {
        let (d, t) = running.iter().fold((0, 0), |a, b| (a.0 + b.0, a.1 + b.1));
        Some(if t > 0 { d as f32 / t as f32 } else { 0.0 })
    };
    ui(move |app, s| {
        s.set_transfers(model(rows));
        taskbar::set(app.window(), part);
    });
}

// ---------- Editor ----------

async fn edit_file(path: String, nginx: bool) {
    let r = match ensure_remote().await { Ok(r) => r, Err(e) => return toast(e.to_string(), "err") };
    let meta = r.sftp.metadata(path.clone()).await;
    if meta.as_ref().map(|m| m.size.unwrap_or(0) > 5 * 1024 * 1024).unwrap_or(false) {
        return toast("Datei ist zu groß zum Bearbeiten (max. 5 MB) – bitte herunterladen.", "err");
    }
    let data = match r.sftp.read(path.clone()).await { Ok(d) => d, Err(e) => return toast(e.to_string(), "err") };
    if data.iter().take(8000).any(|b| *b == 0) { return toast("Binärdatei – bitte herunterladen statt bearbeiten.", "err"); }
    let text = String::from_utf8_lossy(&data).into_owned();
    { let mut a = st(); a.ed_original = text.clone(); a.ed_previous = None; }
    ui(move |_, s| {
        s.set_ed_path(ss(path));
        s.set_ed_gutter(ss(gutter(&text)));
        s.set_ed_text(ss(text));
        s.set_ed_msg("".into());
        s.set_ed_nginx(nginx);
        s.set_ed_revert(false);
        s.set_ed_open(true);
    });
}

fn gutter(text: &str) -> String {
    (1..=text.split('\n').count()).map(|n| n.to_string()).collect::<Vec<_>>().join("\n")
}

async fn test_and_reload(r: &Remote) -> (bool, String) {
    let t = match r.conn.exec("nginx -t 2>&1", 60).await { Ok(t) => t, Err(e) => return (false, e.to_string()) };
    let out = format!("{}{}", t.stdout, t.stderr).trim().to_string();
    if t.code != 0 { return (false, out); }
    match r.conn.exec("systemctl reload nginx 2>&1 || nginx -s reload 2>&1", 60).await {
        Ok(x) => (x.code == 0, format!("{out}\n{}{}", x.stdout, x.stderr).trim().to_string()),
        Err(e) => (false, e.to_string()),
    }
}

// ---------- Nginx ----------

const NGX: &str = "/etc/nginx";

async fn load_nginx() {
    let r = match ensure_remote().await { Ok(r) => r, Err(e) => return remote_failed(e) };
    let script = format!(concat!(
        "echo \"@@inst\"; command -v nginx; echo \"@@ver\"; nginx -v 2>&1; echo \"@@active\"; systemctl is-active nginx 2>/dev/null; ",
        "echo \"@@layout\"; [ -d {n}/sites-available ] && echo debian; echo \"@@avail\"; ls -1A {n}/sites-available 2>/dev/null; ",
        "echo \"@@enabled\"; for f in {n}/sites-enabled/*; do [ -e \"$f\" ] && readlink -f \"$f\"; done 2>/dev/null; ",
        "echo \"@@confd\"; ls -1A {n}/conf.d 2>/dev/null; ",
        "echo \"@@grep\"; grep -HE '^[[:space:]]*(server_name|listen)[[:space:]]' {n}/sites-available/* {n}/conf.d/* 2>/dev/null; true"), n = NGX);
    let res = match r.conn.exec(&script, 30).await { Ok(x) => x, Err(e) => return toast(e.to_string(), "err") };
    let mut sec: HashMap<String, Vec<String>> = HashMap::new();
    let mut cur = String::new();
    for l in res.stdout.lines() {
        if let Some(n) = l.strip_prefix("@@") { cur = n.trim().to_string(); sec.entry(cur.clone()).or_default(); }
        else if !l.trim().is_empty() && !cur.is_empty() { sec.entry(cur.clone()).or_default().push(l.trim().to_string()); }
    }
    let get = |k: &str| sec.get(k).cloned().unwrap_or_default();
    let mut meta: HashMap<String, (Vec<String>, Vec<String>)> = HashMap::new();
    for l in get("grep") {
        let Some((file, rest)) = l.split_once(':') else { continue };
        let rest = rest.trim().trim_end_matches(';').trim();
        let e = meta.entry(file.to_string()).or_default();
        if let Some(n) = rest.strip_prefix("server_name") { e.0.extend(n.split_whitespace().filter(|x| *x != "_").map(String::from)); }
        else if let Some(n) = rest.strip_prefix("listen") { if let Some(p) = n.split_whitespace().next() { e.1.push(p.to_string()); } }
    }
    let line_of = |f: &str| match meta.get(f) {
        None => "kein server-Block gefunden".to_string(),
        Some((n, p)) => format!("{}{}", if n.is_empty() { "Standard-Server".to_string() } else { n.join(", ") }, if p.is_empty() { String::new() } else { format!(" · Port {}", p.join(", ")) }),
    };
    let debian = get("layout").iter().any(|x| x == "debian");
    let enabled: HashSet<String> = get("enabled").into_iter().collect();
    let mk = |file: String, label: String, en: bool, toggle: bool| SiteRow { names: line_of(&file), file, label, enabled: en, toggle };
    let mut other = vec![mk(format!("{NGX}/nginx.conf"), "nginx.conf".into(), false, false)];
    let sites: Vec<SiteRow> = if debian {
        other.extend(get("confd").into_iter().map(|n| mk(format!("{NGX}/conf.d/{n}"), format!("conf.d/{n}"), false, false)));
        get("avail").into_iter().map(|n| { let f = format!("{NGX}/sites-available/{n}"); let e = enabled.contains(&f); mk(f, n, e, true) }).collect()
    } else {
        get("confd").into_iter().map(|n| { let e = n.ends_with(".conf"); mk(format!("{NGX}/conf.d/{n}"), n.trim_end_matches(".disabled").to_string(), e, true) }).collect()
    };
    st().ngx_debian = debian;
    let installed = !get("inst").is_empty();
    let active_state = get("active").first().cloned().unwrap_or_default();
    let version = get("ver").join(" ").replace("nginx version: ", "");
    ui(move |_, s| {
        s.set_ngx_installed(installed);
        s.set_ngx_version(ss(version));
        let (t, k) = if !installed { ("Nicht installiert", "") } else if active_state == "active" { ("Läuft", "good") } else { ("Gestoppt", "warn") };
        s.set_ngx_status(ss(t));
        s.set_ngx_status_kind(ss(k));
        s.set_sites(model(sites.into_iter().map(SiteRow::item).collect()));
        s.set_ngx_other(model(other.into_iter().map(SiteRow::item).collect()));
    });
}

struct SiteRow { file: String, label: String, names: String, enabled: bool, toggle: bool }
impl SiteRow {
    fn item(self) -> SiteItem { SiteItem { file: ss(self.file), label: ss(self.label), names: ss(self.names), enabled: self.enabled, toggle: self.toggle } }
}

fn ngx_out(title: &str, text: String, ok: bool) {
    let title = title.to_string();
    ui(move |_, s| {
        s.set_ngx_output_title(ss(title));
        s.set_ngx_output(ss(if text.trim().is_empty() { "(keine Ausgabe)".to_string() } else { text.trim().to_string() }));
        s.set_ngx_output_ok(ok);
    });
}

async fn ngx_toggle(file: String, on: bool) {
    let r = match ensure_remote().await { Ok(r) => r, Err(e) => return toast(e.to_string(), "err") };
    let name = file.rsplit('/').next().unwrap_or("").to_string();
    let debian = st().ngx_debian;
    let q = ssh::shq(&file);
    let (enable, disable) = if debian {
        (format!("ln -sf {q} {}", ssh::shq(&format!("{NGX}/sites-enabled/{name}"))),
         format!("for f in {NGX}/sites-enabled/*; do [ \"$(readlink -f \"$f\")\" = {q} ] && rm -f \"$f\"; done; true"))
    } else {
        let base = file.trim_end_matches(".disabled").to_string();
        (format!("mv {q} {}", ssh::shq(&base)), format!("mv {q} {}", ssh::shq(&format!("{base}.disabled"))))
    };
    let (run, undo) = if on { (&enable, &disable) } else { (&disable, &enable) };
    if let Err(e) = r.conn.exec(run, 30).await { toast(e.to_string(), "err"); return; }
    let (ok, out) = test_and_reload(&r).await;
    if ok { toast(format!("{name} {} – Nginx neu geladen", if on { "aktiviert" } else { "deaktiviert" }), "ok"); }
    else {
        if debian { let _ = r.conn.exec(undo, 30).await; }
        ngx_out(&format!("{name} – Test fehlgeschlagen, Änderung zurückgenommen"), out, false);
    }
    load_nginx().await;
}

fn site_config(domains: &[String], kind: i32, upstream: &str, root: &str, ws: bool) -> String {
    let head = format!("server {{\n    listen 80;\n    listen [::]:80;\n    server_name {};\n", domains.join(" "));
    match kind {
        0 => format!("{head}\n    client_max_body_size 50m;\n\n    location / {{\n        proxy_pass {upstream};\n        proxy_http_version 1.1;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n{}        proxy_read_timeout 300s;\n    }}\n}}\n",
            if ws { "        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection \"upgrade\";\n" } else { "" }),
        1 => format!("{head}\n    root {root};\n    index index.html index.htm;\n\n    location / {{\n        try_files $uri $uri/ =404;\n    }}\n}}\n"),
        _ => format!("{head}\n    root {root};\n    index index.php index.html;\n\n    location / {{\n        try_files $uri $uri/ /index.php?$query_string;\n    }}\n\n    location ~ \\.php$ {{\n        include snippets/fastcgi-php.conf;\n        fastcgi_pass unix:/run/php/php-fpm.sock;\n    }}\n\n    location ~ /\\.ht {{\n        deny all;\n    }}\n}}\n"),
    }
}

// ---------- Statistiken & Backups ----------

fn chart(values: &[f64], max: f64) -> String {
    if values.len() < 2 || max <= 0.0 { return String::new(); }
    let n = (values.len() - 1) as f64;
    values.iter().enumerate().map(|(i, v)| format!("{} {:.1} {:.1}", if i == 0 { "M" } else { "L" }, i as f64 / n * 1000.0, 195.0 - (v / max).clamp(0.0, 1.0) * 190.0)).collect::<Vec<_>>().join(" ")
}

/// Live-Kurve: der neueste Wert steht rechts, ältere wandern nach links aus dem Bild.
fn chart_live(values: &[f64], max: f64) -> String {
    if values.len() < 2 || max <= 0.0 { return String::new(); }
    let n = values.len();
    values.iter().enumerate().map(|(i, v)| format!("{} {:.1} {:.1}", if i == 0 { "M" } else { "L" }, 1000.0 - (n - 1 - i) as f64 / (LIVE_POINTS - 1) as f64 * 1000.0, 195.0 - (v / max).clamp(0.0, 1.0) * 190.0)).collect::<Vec<_>>().join(" ")
}

fn render_live(s: &S<'_>) {
    let active = st().active.clone();
    let (cpu, mem): (Vec<f64>, Vec<f64>) = LIVE.get_or_init(Default::default).lock().unwrap().get(&active).map(|v| v.iter().map(|x| (x.0, x.1)).unzip()).unwrap_or_default();
    let top = |v: &[f64]| v.iter().cloned().fold(0.0, f64::max);
    s.set_live_cpu(ss(chart_live(&cpu, top(&cpu).max(10.0) * 1.1)));
    s.set_live_mem(ss(chart_live(&mem, top(&mem).max(1.0) * 1.1)));
    s.set_live_cpu_now(ss(cpu.last().map(|v| format!("{v:.1} %")).unwrap_or_default()));
    s.set_live_mem_now(ss(mem.last().map(|v| format!("{v:.2} GB")).unwrap_or_default()));
}

async fn load_stats() {
    let Some(srv) = active() else { return };
    let m = match fire::monitoring(&srv).await {
        Ok(m) => m,
        Err(e) => { let t = e.to_string(); return ui(move |_, s| s.set_stats_info(ss(t))); }
    };
    let cpu: Vec<f64> = m.timings.iter().map(|t| t.cpu).collect();
    let mem: Vec<f64> = m.timings.iter().map(|t| t.mem_gb).collect();
    let ping: Vec<f64> = m.timings.iter().map(|t| t.ping).collect();
    let top = |v: &[f64]| v.iter().cloned().fold(0.0, f64::max);
    let (cm, mm, pm) = (top(&cpu).max(10.0) * 1.1, top(&mem).max(1.0) * 1.1, top(&ping).max(10.0) * 1.1);
    let (cp, mp, pp) = (chart(&cpu, cm), chart(&mem, mm), chart(&ping, pm));
    let info = format!("Live etwa alle 10 Sekunden · Verlauf: {} Messpunkte, 24fire misst alle 10 Minuten · geladen {}", m.timings.len(), chrono::Local::now().format("%H:%M:%S"));
    ui(move |_, s| {
        s.set_chart_cpu(ss(cp)); s.set_chart_mem(ss(mp)); s.set_chart_ping(ss(pp));
        s.set_chart_cpu_max(ss(format!("max. {cm:.0} %"))); s.set_chart_mem_max(ss(format!("max. {mm:.1} GB"))); s.set_chart_ping_max(ss(format!("max. {pm:.0} ms")));
        s.set_stats_info(ss(info));
        s.set_avail(model(m.avail.iter().map(|a| AvailItem { label: ss(&a.0), value: ss(format!("{:.2} %", a.1)), sub: ss(format!("{} Ausfälle · {} min", a.2, a.3)) }).collect()));
        s.set_incidents(model(m.incidents.iter().take(5).map(|i| IncidentItem { start: ss(&i.0), kind: ss(&i.1), duration: ss(&i.2) }).collect()));
    });
}

async fn load_backups() {
    let Some(srv) = active() else { return };
    match fire::backups(&srv).await {
        Ok(b) => ui(move |_, s| {
            s.set_backups_info(ss(if b.is_empty() { "Noch keine Backups." } else { "" }));
            s.set_backups(model(b.iter().map(|x| BackupItem {
                id: ss(&x.id), created: ss(&x.created), description: ss(&x.description), os: ss(&x.os),
                size: ss(format!("{:.0} MB", x.size_mb)), status: ss(if x.status == "finished" { "Fertig" } else { "Läuft" }), ready: x.status == "finished",
            }).collect()));
        }),
        Err(e) => { let t = e.to_string(); ui(move |_, s| { s.set_backups(model(vec![])); s.set_backups_info(ss(t)); }); }
    }
}

// ---------- Minecraft ----------

static RCONS: OnceLock<AsyncMutex<HashMap<String, Arc<AsyncMutex<mc::Rcon>>>>> = OnceLock::new();
static TUNNELS: OnceLock<AsyncMutex<HashMap<String, Arc<ssh::Conn>>>> = OnceLock::new();
static MC_INFO: Mutex<Option<HashMap<String, std::result::Result<mc::Ping, String>>>> = Mutex::new(None);

fn mc_get(id: &str) -> Option<store::Minecraft> { store::read().minecraft.into_iter().find(|m| m.id == id) }

async fn mc_stream(m: &store::Minecraft, port: u16) -> Result<mc::BoxStream> {
    if m.via == "ssh" {
        let sid = m.ssh_server_id.clone().ok_or_else(|| anyhow!("Kein Server für den SSH-Tunnel gewählt"))?;
        let mut g = TUNNELS.get_or_init(|| AsyncMutex::new(HashMap::new())).lock().await;
        let conn = match g.get(&sid).filter(|c| c.alive()) {
            Some(c) => c.clone(),
            None => {
                let s = store::server(&sid).ok_or_else(|| anyhow!("Der verknüpfte 24fire-Server existiert nicht mehr"))?;
                let c = Arc::new(ssh::connect_server(&s).await?);
                g.insert(sid, c.clone());
                c
            }
        };
        return conn.tunnel("127.0.0.1", port).await;
    }
    let f = tokio::net::TcpStream::connect((m.host.as_str(), port));
    let s = tokio::time::timeout(Duration::from_secs(8), f).await.map_err(|_| anyhow!("Zeitüberschreitung bei {}:{port}", m.host))?
        .map_err(|e| anyhow!("{}:{port} nicht erreichbar ({e})", m.host))?;
    Ok(Box::new(s))
}

async fn mc_ping(m: &store::Minecraft) -> Result<mc::Ping> {
    let s = mc_stream(m, m.game_port).await?;
    mc::ping(s, if m.via == "ssh" { "127.0.0.1" } else { &m.host }, m.game_port).await
}

async fn mc_rcon_login(m: &store::Minecraft) -> Result<mc::Rcon> {
    let pass = m.rcon_pass.as_ref().and_then(|p| p.reveal()).ok_or_else(|| anyhow!("Kein lesbares RCON-Passwort hinterlegt – unter „Bearbeiten“ eintragen"))?;
    mc::Rcon::login(mc_stream(m, m.rcon_port).await?, &pass).await
}

async fn mc_command(id: &str, cmd: &str) -> Result<String> {
    let m = mc_get(id).ok_or_else(|| anyhow!("Minecraft-Server nicht gefunden"))?;
    let pool = RCONS.get_or_init(|| AsyncMutex::new(HashMap::new()));
    for attempt in 0..2 {
        let c = {
            let mut g = pool.lock().await;
            match g.get(id) {
                Some(c) => c.clone(),
                None => { let c = Arc::new(AsyncMutex::new(mc_rcon_login(&m).await?)); g.insert(id.to_string(), c.clone()); c }
            }
        };
        let res = c.lock().await.command(cmd).await;
        match res {
            Ok(o) => return Ok(o),
            Err(e) => { pool.lock().await.remove(id); if attempt == 1 { return Err(e); } }
        }
    }
    bail!("RCON nicht verfügbar")
}

fn side_mcs(s: &S<'_>) {
    let info = MC_INFO.lock().unwrap().clone().unwrap_or_default();
    s.set_mcs(model(store::read().minecraft.iter().map(|m| {
        let i = info.get(&m.id);
        SideItem {
            id: ss(&m.id), name: ss(&m.name),
            sub: ss(match i { Some(Ok(p)) => format!("{}/{} Spieler", p.online, p.max), _ if m.via == "ssh" => "über SSH-Tunnel".to_string(), _ => format!("{}:{}", m.host, m.game_port) }),
            dot: ss(match i { None => "", Some(Ok(_)) => "running", Some(Err(_)) => "stopped" }),
        }
    }).collect()));
}

fn runs(row: Vec<(String, (u8, u8, u8), bool)>) -> ModelRc<TermRun> {
    let bg = Color::from_argb_u8(0, 0, 0, 0);
    model(row.into_iter().map(|(t, (r, g, b), bold)| TermRun { text: ss(t), fg: Color::from_rgb_u8(r, g, b), bg, bold }).collect())
}

fn mc_icon(bytes: &[u8]) -> Option<slint::Image> {
    let img = image::load_from_memory(bytes).ok()?.to_rgba8();
    let buf = slint::SharedPixelBuffer::<slint::Rgba8Pixel>::clone_from_slice(img.as_raw(), img.width(), img.height());
    Some(slint::Image::from_rgba8(buf))
}

fn render_mc(s: &S<'_>) {
    let id = s.get_active_mc().to_string();
    let Some(m) = mc_get(&id) else { return };
    let info = MC_INFO.lock().unwrap().clone().unwrap_or_default();
    s.set_mc_name(ss(&m.name));
    match info.get(&id) {
        None => { s.set_mc_pill("Prüfe…".into()); s.set_mc_pill_kind("".into()); }
        Some(Ok(p)) => {
            s.set_mc_pill(ss(format!("Online · {}/{} Spieler", p.online, p.max)));
            s.set_mc_pill_kind("good".into());
            let row: Vec<_> = mc::styled(&p.motd.replace('\n', " "), (170, 170, 170), 400).into_iter().flatten().collect();
            s.set_mc_motd_runs(runs(row));
            match p.favicon.as_deref().and_then(mc_icon) {
                Some(i) => { s.set_mc_icon(i); s.set_mc_has_icon(true); }
                None => s.set_mc_has_icon(false),
            }
            s.set_mc_meta(ss(format!("{}  ·  {} ms  ·  {}", p.version, p.latency, if m.via == "ssh" { "SSH-Tunnel".to_string() } else { format!("{}:{}", m.host, m.game_port) })));
        }
        Some(Err(e)) => {
            s.set_mc_pill("Offline".into());
            s.set_mc_pill_kind("warn".into());
            s.set_mc_has_icon(false);
            s.set_mc_motd_runs(runs(vec![(e.clone(), (255, 107, 107), false)]));
            s.set_mc_meta("".into());
        }
    }
}

async fn mc_refresh(id: String) {
    let Some(m) = mc_get(&id) else { return };
    let r = mc_ping(&m).await.map_err(|e| e.to_string());
    MC_INFO.lock().unwrap().get_or_insert_with(HashMap::new).insert(id, r);
    ui(|_, s| { side_mcs(&s); render_mc(&s); });
}

fn mc_log(text: impl AsRef<str>, kind: &str) {
    let base = match kind { "cmd" => (85, 255, 85), "err" => (255, 107, 107), "info" => (139, 147, 167), _ => (224, 224, 224) };
    let rows = mc::styled(text.as_ref(), base, 150);
    ui(move |_, s| {
        let mut v: Vec<TermRow> = s.get_mc_rows().iter().collect();
        v.extend(rows.into_iter().map(|r| TermRow { runs: runs(r) }));
        if v.len() > 1500 { v.drain(0..300); }
        s.set_mc_rows(model(v));
    });
}

fn mc_run(cmd: String, echo: bool) {
    let id = WINDOW.get().and_then(|w| w.upgrade()).map(|a| a.global::<S>().get_active_mc().to_string()).unwrap_or_default();
    spawn(async move {
        if echo { mc_log(format!("/{cmd}"), "cmd"); }
        match mc_command(&id, &cmd).await {
            Ok(o) if echo => mc_log(if o.is_empty() { "(keine Ausgabe)" } else { &o }, ""),
            Ok(o) => toast(if o.is_empty() { format!("/{cmd} ausgeführt") } else { mc::strip(&o) }, "ok"),
            Err(e) if echo => mc_log(e.to_string(), "err"),
            Err(e) => toast(e.to_string(), "err"),
        }
    });
}

const RULES: [(&str, &str); 8] = [("keepInventory", "Inventar behalten beim Tod"), ("doDaylightCycle", "Tag/Nacht-Wechsel"), ("doWeatherCycle", "Wetterwechsel"), ("mobGriefing", "Mobs zerstören Blöcke"), ("doFireTick", "Feuer breitet sich aus"), ("doMobSpawning", "Mobs spawnen"), ("doInsomnia", "Phantome"), ("naturalRegeneration", "Natürliche Regeneration")];

async fn mc_load(id: String, tab: i32) {
    if tab == 1 {
        let list = mc_command(&id, "list").await;
        let wl = mc_command(&id, "whitelist list").await.unwrap_or_default();
        let bl = mc_command(&id, "banlist players").await.unwrap_or_default();
        let names = |t: &str| -> Vec<SharedString> {
            let t = mc::strip(t);
            if t.contains("no whitelisted") { return vec![]; }
            t.split_once(':').map(|x| x.1).unwrap_or("").split(',').map(|x| x.trim()).filter(|x| !x.is_empty()).map(ss).collect()
        };
        let banned: Vec<SharedString> = mc::strip(&bl).lines().filter_map(|l| l.split_once(" was banned by").map(|x| ss(x.0))).collect();
        let wl = names(&wl);
        match list {
            Ok(o) => {
                let l = mc::parse_list(&o);
                ui(move |_, s| {
                    s.set_mc_online(ss(format!("ONLINE ({}/{})", l.online, l.max)));
                    s.set_mc_players(model(l.names.iter().map(ss).collect()));
                    s.set_mc_whitelist(model(wl));
                    s.set_mc_banned(model(banned));
                });
            }
            Err(e) => { let t = e.to_string(); ui(move |_, s| s.set_mc_online(ss(t))); }
        }
    }
    if tab == 2 {
        let mut rows = Vec::new();
        for (k, label) in RULES {
            match mc_command(&id, &format!("gamerule {k}")).await {
                Ok(o) => {
                    let t = mc::strip(&o);
                    let t = t.trim();
                    if t.ends_with("true") || t.ends_with("false") { rows.push(RuleItem { key: ss(k), label: ss(label), on: t.ends_with("true") }); }
                }
                Err(e) => { toast(e.to_string(), "err"); break; }
            }
        }
        let rows: Vec<(String, String, bool)> = rows.into_iter().map(|r| (r.key.to_string(), r.label.to_string(), r.on)).collect();
        ui(move |_, s| s.set_mc_rules(model(rows.into_iter().map(|r| RuleItem { key: ss(r.0), label: ss(r.1), on: r.2 }).collect())));
    }
}

fn mc_form(s: &S<'_>) -> Result<store::Minecraft> {
    let via = if s.get_mf_via() == 0 { "ssh" } else { "direct" };
    let all = store::read().servers;
    let name = s.get_mf_name().trim().to_string();
    if name.is_empty() { bail!("Bitte einen Namen eingeben."); }
    let host = s.get_mf_host().trim().to_string();
    if via == "direct" && host.is_empty() { bail!("Adresse fehlt"); }
    let ssh_server_id = if via == "ssh" { Some(all.get(s.get_mf_server() as usize).ok_or_else(|| anyhow!("Kein 24fire-Server vorhanden"))?.id.clone()) } else { None };
    let old = mc_get(&s.get_active_mc()).filter(|_| s.get_mf_edit());
    let pass = s.get_mf_pass().to_string();
    let rcon_pass = if pass.is_empty() { old.as_ref().and_then(|o| o.rcon_pass.clone()) } else { Some(store::Secret::new(&pass)) };
    if rcon_pass.is_none() { bail!("Bitte das RCON-Passwort eingeben."); }
    Ok(store::Minecraft {
        id: old.map(|o| o.id).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        name, host, via: via.into(), ssh_server_id, rcon_pass,
        game_port: s.get_mf_game().parse().unwrap_or(25565),
        rcon_port: s.get_mf_rcon().parse().unwrap_or(25575),
    })
}

// ---------- Claude / Discord / Update ----------

fn render_claude(s: &S<'_>) {
    let c = store::read().claude;
    let running = mcp::RUNNING.load(Ordering::Relaxed);
    let err = mcp::ERROR.lock().unwrap().clone();
    s.set_cl_enabled(c.enabled);
    s.set_cl_confirm(c.confirm);
    s.set_cl_side(ss(if running { "An" } else if !err.is_empty() { "Fehler" } else { "Aus" }));
    s.set_cl_status(ss(if running { format!("Aktiv · Port {}", c.port) } else if !err.is_empty() { err } else { "Aus".into() }));
    s.set_cl_status_kind(ss(if running { "good" } else { "" }));
    s.set_cl_url(ss(format!("http://127.0.0.1:{}/mcp", c.port)));
    if !s.get_cl_open() { s.set_cl_port(ss(c.port.to_string())); }
    s.set_cl_access(model(store::read().servers.iter().map(|x| AccessItem {
        id: ss(&x.id), name: ss(&x.name),
        level: ["none", "read", "control", "full"].iter().position(|l| c.access.get(&x.id).map(String::as_str) == Some(*l)).unwrap_or(0) as i32,
    }).collect()));
}

fn audit_load(s: &S<'_>) {
    let names: Vec<SharedString> = std::iter::once(ss("Alle Server")).chain(store::read().servers.iter().map(|x| ss(&x.name))).collect();
    let idx = (s.get_au_server().max(0) as usize).min(names.len() - 1);
    let server = if idx == 0 { String::new() } else { names[idx].to_string() };
    s.set_au_servers(model(names));
    s.set_au_server(idx as i32);
    let list = mcp::audit(&s.get_au_search(), &server, s.get_au_changes());
    let changes = ["run_command", "write_file", "delete_path", "power_server", "create_backup", "nginx_test_and_reload"];
    let n = list.iter().filter(|e| changes.contains(&e["tool"].as_str().unwrap_or(""))).count();
    s.set_au_stats(ss(format!("{} Einträge · davon {n} Änderungen am Server", list.len())));
    s.set_audit(model(list.iter().map(audit_item).collect()));
}

fn audit_item(e: &Value) -> AuditItem {
    let res = e["result"].as_str().unwrap_or("");
    let g = |k: &str| e[k].as_str().unwrap_or("").to_string();
    let cmd = e["args"]["command"].as_str().unwrap_or("");
    let mut d = String::new();
    if let Some(x) = e["decision"].as_str() { d += &format!("Bestätigung: {x}\n"); }
    if let Some(x) = e["client"].as_str() { d += &format!("Client: {x}\n"); }
    if let Some(x) = e["durationMs"].as_u64() { d += &format!("Dauer: {x} ms\n"); }
    if !cmd.is_empty() { d += &format!("Befehl:\n{cmd}\n"); }
    if let Some(x) = e["args"]["path"].as_str() { d += &format!("Pfad: {x}\n"); }
    if let Some(x) = e["args"]["content"].as_str() { d += &format!("Inhalt:\n{x}\n"); }
    if let Some(x) = e["output"].as_str() { d += &format!("Ausgabe:\n{x}\n"); }
    if !res.starts_with("ok") && res != "abgelehnt" { d += &format!("Ergebnis: {res}\n"); }
    let time = chrono::DateTime::from_timestamp_millis(e["time"].as_i64().unwrap_or(0)).map(|t| t.with_timezone(&chrono::Local).format("%d.%m.%y %H:%M:%S").to_string()).unwrap_or_default();
    AuditItem {
        time: ss(time), tool: ss(g("tool")), server: ss(g("server")),
        summary: ss(if cmd.is_empty() { g("summary") } else { cmd.lines().next().unwrap_or("").to_string() }),
        result: ss(if res.starts_with("ok") { "ok" } else if res == "abgelehnt" { "abgelehnt" } else { "Fehler" }),
        kind: ss(if res.starts_with("ok") { "good" } else { "warn" }),
        change: ["run_command", "write_file", "delete_path", "power_server", "create_backup", "nginx_test_and_reload"].contains(&e["tool"].as_str().unwrap_or("")),
        details: ss(d), open: false,
    }
}

static UPDATE: Mutex<Option<updater::UpdateInfo>> = Mutex::new(None);

async fn check_update(manual: bool) {
    match updater::check().await {
        Ok(i) => {
            let avail = i.available;
            let (latest, notes) = (i.latest.clone(), i.notes.clone());
            *UPDATE.lock().unwrap() = Some(i);
            ui(move |_, s| {
                s.set_up_available(avail);
                s.set_up_latest(ss(latest));
                s.set_up_notes(ss(notes));
                if manual && avail { s.set_up_open(true); }
            });
            if manual && !avail { toast(format!("Fire Desktop ist aktuell (Version {})", updater::VERSION), "ok"); }
        }
        Err(e) => if manual { toast(format!("Update-Prüfung: {e}"), "err"); },
    }
}

const PRIVACY: &str = include_str!("../assets/legal/datenschutz.html");
const TERMS: &str = include_str!("../assets/legal/nutzungsbedingungen.html");

// ---------- Verdrahtung ----------

pub fn run(app: &AppWindow) {
    let _ = WINDOW.set(app.as_weak());
    let s = app.global::<S>();
    s.set_version(updater::VERSION.into());

    // Dialoge
    s.on_dlg_answer(|ok| {
        let cb = DLG.lock().unwrap().take();
        ui(move |_, s| {
            let v = s.get_dlg_value().to_string();
            s.set_dlg_open(false);
            if let Some(f) = cb { f(ok.then_some(v)); }
        });
    });
    s.on_copy(|t| { if let Ok(mut c) = arboard::Clipboard::new() { let _ = c.set_text(t.to_string()); toast("In Zwischenablage kopiert", "ok"); } });
    s.on_open_legal(|k| {
        let (name, text) = if k == "datenschutz" { ("datenschutz.html", PRIVACY) } else { ("nutzungsbedingungen.html", TERMS) };
        let p = std::env::temp_dir().join(name);
        if std::fs::write(&p, text).is_ok() { let _ = open::that(p); }
    });

    // Navigation
    s.on_server_select(|id| select_server(id.to_string()));
    s.on_tab_changed(load_tab);
    s.on_power(|mode| {
        let mode = mode.to_string();
        let Some(srv) = active() else { return };
        let go = {
            let (mode, srv) = (mode.clone(), srv.clone());
            move || spawn(async move {
                match fire::power(&srv, &mode).await {
                    Ok(_) => {
                        toast("Befehl gesendet", "ok");
                        for d in [2, 5, 10, 15] { tokio::time::sleep(Duration::from_secs(d)).await; refresh(false).await; }
                    }
                    Err(e) => toast(e.to_string(), "err"),
                }
            })
        };
        if mode == "start" { go(); return; }
        let t = if mode == "stop" { "wird hart gestoppt – laufende Prozesse werden beendet" } else { "wird neu gestartet" };
        confirm(&format!("Server {}?", if mode == "stop" { "stoppen" } else { "neu starten" }), &format!("„{}“ {t}.", srv.name), if mode == "stop" { "Stoppen" } else { "Neu starten" }, go);
    });
    s.on_menu(|what| {
        let Some(srv) = active() else { return };
        match what.as_str() {
            "rename" => {
                let id = srv.id.clone();
                dialog("Server umbenennen", "", Some(&srv.name), "Speichern", false, move |r| {
                    if let Some(n) = r.filter(|n| !n.trim().is_empty()) {
                        store::update(|st| { if let Some(x) = st.servers.iter_mut().find(|x| x.id == id) { x.name = n.trim().to_string(); } });
                        ui(|_, s| { side_servers(&s); render_server(&s); });
                    }
                });
            }
            "key" => {
                let id = srv.id.clone();
                dialog("API-Token ändern", "Neuen Token aus cp.24fire.de → Kontoeinstellungen → API-Keys einfügen. Er wird vor dem Speichern geprüft.", Some(""), "Prüfen & speichern", false, move |r| {
                    let Some(key) = r.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) else { return };
                    spawn(async move {
                        let Some(srv) = store::server(&id) else { return };
                        match fire::list_servers(&srv.provider, &srv.env, &key).await {
                            Err(e) => toast(format!("Token abgelehnt: {e}"), "err"),
                            Ok(_) => {
                                let secret = store::Secret::new(&key);
                                store::update(|st| { if let Some(x) = st.servers.iter_mut().find(|x| x.id == id) { x.key = Some(secret); x.key_hint = store::key_hint(&key); } });
                                toast("API-Token gespeichert", "ok");
                                st().status.remove(&id);
                                refresh(true).await;
                            }
                        }
                    });
                });
                ui(|_, s| s.set_dlg_secret(true));
            }
            "remove" => {
                let id = srv.id.clone();
                confirm("Server entfernen?", &format!("„{}“ wird nur aus dieser App entfernt (inkl. API-Token). Der Server selbst bleibt unverändert.", srv.name), "Entfernen", move || {
                    store::update(|st| st.servers.retain(|x| x.id != id));
                    let next = store::read().servers.first().map(|x| x.id.clone());
                    st().status.remove(&id);
                    ui(|_, s| side_servers(&s));
                    if let Some(n) = next { select_server(n); } else { st().active.clear(); ui(|_, s| s.set_active_id("".into())); }
                });
            }
            _ => {}
        }
    });

    // Server hinzufügen
    s.on_add_probe(|| {
        ui(|_, s| {
            let (key, prov, env) = (s.get_add_key().trim().to_string(), s.get_add_provider(), s.get_add_env());
            if key.is_empty() { s.set_add_error("Bitte API-Token eingeben.".into()); return; }
            s.set_add_busy(true);
            s.set_add_error("".into());
            spawn(async move {
                let (p, e) = (if prov == 0 { "24fire" } else { "fireapi" }, if env == 0 { "live" } else { "sandbox" });
                let res = fire::list_servers(p, e, &key).await;
                ui(move |_, s| {
                    s.set_add_busy(false);
                    match res {
                        Err(e) => s.set_add_error(ss(e.to_string())),
                        Ok(list) => {
                            let known: Vec<String> = store::read().servers.iter().map(|x| x.sid.clone()).collect();
                            s.set_add_info(ss(if list.is_empty() { "Mit diesem Token wurden keine KVM-Server gefunden.".to_string() } else { format!("{} Server gefunden – antippen zum Aus- oder Abwählen:", list.len()) }));
                            s.set_found(model(list.iter().map(|f| FoundItem { sid: ss(&f.sid), name: ss(&f.name), spec: ss(&f.spec), checked: !known.contains(&f.sid) }).collect()));
                            s.set_add_manual("".into());
                            s.set_add_step(1);
                        }
                    }
                });
            });
        });
    });
    s.on_add_confirm(|| ui(|_, s| {
        let key = s.get_add_key().trim().to_string();
        let (provider, env) = (if s.get_add_provider() == 0 { "24fire" } else { "fireapi" }, if s.get_add_env() == 0 { "live" } else { "sandbox" });
        let mut picks: Vec<(String, String)> = s.get_found().iter().filter(|f| f.checked).map(|f| (f.sid.to_string(), f.name.to_string())).collect();
        let manual = s.get_add_manual().trim().to_string();
        if !manual.is_empty() { picks.push((manual, "KVM".into())); }
        if picks.is_empty() { s.set_add_error("Wähle mindestens einen Server aus.".into()); return; }
        let mut first = None;
        store::update(|st| for (sid, name) in &picks {
            let id = uuid::Uuid::new_v4().to_string();
            first.get_or_insert(id.clone());
            st.servers.push(store::Server { id, name: name.clone(), provider: provider.into(), sid: sid.clone(), env: env.into(), key: Some(store::Secret::new(&key)), key_hint: store::key_hint(&key), created_at: chrono::Local::now().to_rfc3339(), ..Default::default() });
        });
        s.set_add_key("".into());
        s.set_add_open(false);
        side_servers(&s);
        toast(format!("{} Server hinzugefügt", picks.len()), "ok");
        if let Some(id) = first { select_server(id); }
    }));

    // Konsole
    s.on_ssh_connect(|| ui(|_, s| { sync_creds(&s); ssh_connect(); }));
    s.on_ssh_disconnect(term_stop);
    s.on_ssh_forget(|| {
        let id = st().active.clone();
        store::update(|s| if let Some(x) = s.servers.iter_mut().find(|x| x.id == id) { x.host_keys.clear(); });
        toast("Host-Key vergessen – wird beim nächsten Verbinden neu gespeichert.", "ok");
    });
    s.on_open_novnc(|| {
        let Some(srv) = active() else { return };
        spawn(async move {
            match fire::console_url(&srv).await { Ok(u) => { let _ = open::that(u); } Err(e) => toast(format!("noVNC: {e}"), "err") }
        });
    });
    s.on_term_sel(|x, y, start| {
        let (rows, cols) = *TERM_SIZE.lock().unwrap();
        let cell = *CELL_W.lock().unwrap();
        let pos = (((y - 10.0) / 18.0).clamp(0.0, rows as f32 - 1.0) as u16, ((x - 10.0) / cell).clamp(0.0, cols as f32 - 1.0) as u16);
        {
            let mut g = SEL.lock().unwrap();
            match (*g, start) {
                (Some((a, _)), false) => *g = Some((a, pos)),
                _ => *g = Some((pos, pos)),
            }
        }
        term_render();
    });
    s.on_term_key(|t, ctrl, alt| {
        let first = t.chars().next().unwrap_or(' ');
        // Strg+C kopiert eine Auswahl, sonst geht es als Abbruch an den Server
        if ctrl && matches!(first, 'c' | 'C' | '\u{3}') {
            if let Some(text) = sel_text() {
                if let Ok(mut c) = arboard::Clipboard::new() { let _ = c.set_text(text); toast("Auswahl kopiert", "ok"); }
                *SEL.lock().unwrap() = None;
                term_render();
                return;
            }
        }
        *SEL.lock().unwrap() = None;
        if let Some(tx) = TERM_TX.lock().unwrap().as_ref() {
            let b = key_bytes(&t, ctrl, alt);
            if !b.is_empty() { let _ = tx.send(TermMsg::Input(b)); }
        }
    });
    s.on_term_paste(|| {
        if let (Ok(mut c), Some(tx)) = (arboard::Clipboard::new(), TERM_TX.lock().unwrap().as_ref()) {
            if let Ok(t) = c.get_text() { let _ = tx.send(TermMsg::Input(t.into_bytes())); }
        }
    });
    s.on_term_copy(|| {
        let text = sel_text().or_else(|| PARSER.lock().unwrap().as_ref().map(|p| p.screen().contents())).unwrap_or_default();
        if let Ok(mut c) = arboard::Clipboard::new() { let _ = c.set_text(text); toast("Bildschirminhalt kopiert", "ok"); }
    });
    s.on_term_resize(|w, h, cell| {
        let cell = if cell > 1.0 { cell } else { 7.6 };
        *CELL_W.lock().unwrap() = cell;
        let (cols, rows) = (((w - 20.0) / cell).max(20.0) as u16, ((h - 20.0) / 18.0).max(5.0) as u16);
        *TERM_SIZE.lock().unwrap() = (rows, cols);
        if let Some(p) = PARSER.lock().unwrap().as_mut() { p.set_size(rows, cols); }
        if let Some(tx) = TERM_TX.lock().unwrap().as_ref() { let _ = tx.send(TermMsg::Resize(cols as u32, rows as u32)); }
        term_render();
    });

    // Dateien
    s.on_remote_connect(|| ui(|_, s| { sync_creds(&s); load_tab(s.get_tab()); }));
    s.on_fm_go(|p| spawn(load_files(Some(p.to_string()))));
    s.on_fm_up(|| { let p = ssh::parent(&st().cwd); spawn(load_files(Some(p))); });
    s.on_fm_refresh(|| spawn(load_files(None)));
    s.on_fm_filter_changed(|t| { st().filter = t.to_string(); ui(|_, s| render_files(&s)); });
    s.on_fm_toggle(|n| {
        { let mut a = st(); let n = n.to_string(); if !a.selected.remove(&n) { a.selected.insert(n); } }
        ui(|_, s| render_files(&s));
    });
    s.on_fm_open(|n| {
        let (dir, path) = { let a = st(); (a.entries.iter().find(|e| e.name == n.as_str()).map(|e| e.is_dir).unwrap_or(false), ssh::join(&a.cwd, &n)) };
        if dir { spawn(load_files(Some(path))); } else { spawn(edit_file(path, false)); }
    });
    s.on_fm_new_folder(|| dialog("Neuer Ordner", "", Some(""), "Anlegen", false, |r| {
        let Some(n) = r.filter(|x| !x.is_empty()) else { return };
        spawn(async move {
            let Ok(r) = ensure_remote().await else { return };
            let p = ssh::join(&st().cwd.clone(), &n);
            if let Err(e) = r.sftp.create_dir(p).await { toast(e.to_string(), "err"); }
            load_files(None).await;
        });
    }));
    s.on_fm_new_file(|| dialog("Neue Datei", "", Some(""), "Anlegen", false, |r| {
        let Some(n) = r.filter(|x| !x.is_empty()) else { return };
        spawn(async move {
            let Ok(r) = ensure_remote().await else { return };
            let p = ssh::join(&st().cwd.clone(), &n);
            if let Err(e) = r.sftp.write(p.clone(), b"").await { return toast(e.to_string(), "err"); }
            load_files(None).await;
            edit_file(p, false).await;
        });
    }));
    s.on_fm_upload(|dirs| {
        spawn(async move {
            let d = rfd::AsyncFileDialog::new();
            let picked: Vec<PathBuf> = if dirs { d.pick_folders().await } else { d.pick_files().await }.unwrap_or_default().iter().map(|f| f.path().to_path_buf()).collect();
            start_upload(picked).await;
        });
    });
    {
        use slint::winit_030::{winit::event::WindowEvent, EventResult, WinitWindowAccessor};
        app.window().on_winit_window_event(|_, e| {
            match e {
                WindowEvent::HoveredFile(_) => ui(|_, s| { if s.get_tab() == 2 && s.get_active_mc().is_empty() { s.set_drop_hover(true); } }),
                WindowEvent::HoveredFileCancelled => ui(|_, s| s.set_drop_hover(false)),
                WindowEvent::DroppedFile(p) => {
                    let p = p.clone();
                    ui(move |_, s| {
                        s.set_drop_hover(false);
                        if s.get_tab() == 2 && s.get_active_mc().is_empty() { on_drop(p); }
                        else { toast("Zum Hochladen zuerst den Tab „Dateien“ öffnen.", "info"); }
                    });
                }
                _ => {}
            }
            EventResult::Propagate
        });
    }
    s.on_fm_download(|n| {
        let paths = selected_paths(&n);
        if paths.is_empty() { return; }
        spawn(async move {
            let base = if paths.len() == 1 && !st().entries.iter().find(|e| paths[0].ends_with(&format!("/{}", e.name))).map(|e| e.is_dir).unwrap_or(false) {
                let name = paths[0].rsplit('/').next().unwrap_or("download").to_string();
                match rfd::AsyncFileDialog::new().set_file_name(&name).save_file().await { Some(f) => vec![(paths[0].clone(), f.path().to_path_buf())], None => return }
            } else {
                let Some(d) = rfd::AsyncFileDialog::new().pick_folder().await else { return };
                paths.iter().map(|p| (p.clone(), d.path().join(p.rsplit('/').next().unwrap_or("x")))).collect()
            };
            let r = match ensure_remote().await { Ok(r) => r, Err(e) => return toast(e.to_string(), "err") };
            let label = if base.len() == 1 { base[0].0.rsplit('/').next().unwrap_or("").to_string() } else { format!("{} Elemente", base.len()) };
            let (id, job) = transfer_start(false, label);
            let res = ssh::download(r.sftp.clone(), base, job).await;
            transfer_end(&id, res);
        });
    });
    s.on_fm_rename(|n| {
        let n = n.to_string();
        dialog("Umbenennen", "", Some(&n.clone()), "Umbenennen", false, move |r| {
            let Some(new) = r.filter(|x| !x.is_empty() && *x != n && !x.contains('/')) else { return };
            spawn(async move {
                let Ok(r) = ensure_remote().await else { return };
                let cwd = st().cwd.clone();
                if let Err(e) = r.sftp.rename(ssh::join(&cwd, &n), ssh::join(&cwd, &new)).await { toast(e.to_string(), "err"); }
                load_files(None).await;
            });
        });
    });
    s.on_fm_chmod(|n| {
        let n = n.to_string();
        let mode = st().entries.iter().find(|e| e.name == n).map(|e| format!("{:o}", e.mode)).unwrap_or_default();
        dialog(&format!("Rechte von „{n}“"), "Oktal, z. B. 644 für Dateien oder 755 für Ordner und Skripte.", Some(&mode), "Setzen", false, move |r| {
            let Some(m) = r.and_then(|x| u32::from_str_radix(&x, 8).ok()).filter(|m| *m <= 0o7777) else { return };
            spawn(async move {
                let Ok(r) = ensure_remote().await else { return };
                let p = ssh::join(&st().cwd.clone(), &n);
                if let Err(e) = ssh::chmod(&r.sftp, &p, m).await { toast(e.to_string(), "err"); }
                load_files(None).await;
            });
        });
    });
    s.on_fm_delete(|n| {
        let paths = selected_paths(&n);
        if paths.is_empty() { return; }
        let title = if paths.len() == 1 { format!("„{}“ löschen?", paths[0].rsplit('/').next().unwrap_or("")) } else { format!("{} Einträge löschen?", paths.len()) };
        confirm(&title, "Ordner werden mit ihrem Inhalt gelöscht. Das kann nicht rückgängig gemacht werden.", "Endgültig löschen", move || spawn(async move {
            let Ok(r) = ensure_remote().await else { return };
            if paths.iter().any(|p| p.trim_end_matches('/').is_empty() || !p.starts_with('/')) { return toast("Ungültiger Pfad", "err"); }
            let cmd = format!("rm -rf -- {}", paths.iter().map(|p| ssh::shq(p)).collect::<Vec<_>>().join(" "));
            match r.conn.exec(&cmd, 120).await {
                Ok(x) if x.code == 0 => toast("Gelöscht", "ok"),
                Ok(x) => toast(x.stderr, "err"),
                Err(e) => toast(e.to_string(), "err"),
            }
            st().selected.clear();
            load_files(None).await;
        }));
    });
    s.on_transfer_cancel(|id| {
        if let Some(t) = TRANSFERS.lock().unwrap().iter().find(|t| t.id == id.as_str()) { t.job.cancel.store(true, Ordering::Relaxed); }
    });

    // Editor
    s.on_ed_edited(|| ui(|_, s| s.set_ed_gutter(ss(gutter(&s.get_ed_text())))));
    s.on_ed_close(|| ui(|_, s| {
        if s.get_ed_text().as_str() == st().ed_original { s.set_ed_open(false); return; }
        confirm("Ungespeicherte Änderungen verwerfen?", "", "Verwerfen", || ui(|_, s| s.set_ed_open(false)));
    }));
    s.on_ed_save(|| ui(|_, s| {
        let (path, text, nginx) = (s.get_ed_path().to_string(), s.get_ed_text().to_string(), s.get_ed_nginx());
        spawn(async move {
            let r = match ensure_remote().await { Ok(r) => r, Err(e) => return toast(e.to_string(), "err") };
            if let Err(e) = r.sftp.write(path, text.as_bytes()).await {
                let m = format!("Speichern fehlgeschlagen: {e}");
                return ui(move |_, s| { s.set_ed_msg(ss(m)); s.set_ed_msg_ok(false); });
            }
            let before = std::mem::replace(&mut st().ed_original, text);
            if !nginx { toast("Gespeichert", "ok"); load_files(None).await; return; }
            let (ok, out) = test_and_reload(&r).await;
            if !ok { st().ed_previous = Some(before); }
            ui(move |_, s| {
                s.set_ed_msg_ok(ok);
                s.set_ed_revert(!ok);
                s.set_ed_msg(ss(if ok { format!("Gespeichert, Test erfolgreich, Nginx neu geladen.\n{out}") } else { format!("Gespeichert, aber nginx -t meldet Fehler – Nginx wurde NICHT neu geladen:\n{out}") }));
            });
            load_nginx().await;
        });
    }));
    s.on_ed_undo(|| ui(|_, s| {
        let path = s.get_ed_path().to_string();
        let Some(prev) = st().ed_previous.take() else { return };
        spawn(async move {
            let Ok(r) = ensure_remote().await else { return };
            if let Err(e) = r.sftp.write(path, prev.as_bytes()).await { return toast(e.to_string(), "err"); }
            st().ed_original = prev;
            let t = r.conn.exec("nginx -t 2>&1", 60).await;
            let (ok, out) = t.map(|x| (x.code == 0, x.stdout)).unwrap_or((false, String::new()));
            ui(move |_, s| { s.set_ed_revert(false); s.set_ed_msg_ok(ok); s.set_ed_msg(ss(format!("Alte Version wiederhergestellt. Deine Änderung ist noch im Editor.\n{out}"))); });
        });
    }));

    // Nginx
    s.on_ngx_action(|a| {
        let a = a.to_string();
        let ask = a2(&a);
        let run = move || spawn(async move {
            let r = match ensure_remote().await { Ok(r) => r, Err(e) => return toast(e.to_string(), "err") };
            let (title, cmd, secs) = match a.as_str() {
                "test" => ("nginx -t", "nginx -t 2>&1", 60),
                "reload" => ("Neu laden", "nginx -t 2>&1 && (systemctl reload nginx 2>&1 || nginx -s reload 2>&1) && echo 'Nginx neu geladen.'", 60),
                "restart" => ("Neustart", "nginx -t 2>&1 && systemctl restart nginx 2>&1 && echo 'Nginx neu gestartet.'", 60),
                "logs" => ("error.log (letzte 150 Zeilen)", "tail -n 150 /var/log/nginx/error.log 2>&1", 30),
                _ => ("Installation", "export DEBIAN_FRONTEND=noninteractive; apt-get update -q 2>&1 && apt-get install -y -q nginx 2>&1", 600),
            };
            match r.conn.exec(cmd, secs).await {
                Ok(x) => ngx_out(title, format!("{}{}", x.stdout, x.stderr), x.code == 0),
                Err(e) => ngx_out(title, e.to_string(), false),
            }
            load_nginx().await;
        });
        match ask {
            Some((t, x, ok)) => confirm(t, x, ok, run),
            None => run(),
        }
    });
    s.on_ngx_toggle(|f, on| spawn(ngx_toggle(f.to_string(), on)));
    s.on_ngx_edit(|f| spawn(edit_file(f.to_string(), true)));
    s.on_ngx_delete(|f| {
        let f = f.to_string();
        confirm(&format!("Site „{}“ löschen?", f.rsplit('/').next().unwrap_or("")), "Die Konfigurationsdatei wird gelöscht und Nginx neu geladen.", "Löschen", move || spawn(async move {
            let Ok(r) = ensure_remote().await else { return };
            let q = ssh::shq(&f);
            let _ = r.conn.exec(&format!("for x in {NGX}/sites-enabled/*; do [ \"$(readlink -f \"$x\")\" = {q} ] && rm -f \"$x\"; done; rm -f -- {q}"), 30).await;
            let (ok, out) = test_and_reload(&r).await;
            if ok { toast("Site gelöscht", "ok"); } else { ngx_out("Gelöscht, aber nginx -t meldet Fehler", out, false); }
            load_nginx().await;
        }));
    });
    s.on_ngx_create(|| ui(|_, s| {
        let domains: Vec<String> = s.get_ns_domains().split_whitespace().map(String::from).collect();
        let valid = |d: &String| d.contains('.') && d.chars().all(|c| c.is_ascii_alphanumeric() || "-.*".contains(c));
        let kind = s.get_ns_type();
        let upstream = s.get_ns_upstream().trim().to_string();
        if domains.is_empty() || !domains.iter().all(valid) { s.set_ns_error("Bitte gültige Domains eintragen.".into()); return; }
        if kind == 0 && !(upstream.starts_with("http://") || upstream.starts_with("https://")) { s.set_ns_error("„Weiterleiten an“ muss mit http:// oder https:// beginnen.".into()); return; }
        let root = { let r = s.get_ns_root().trim().to_string(); if r.is_empty() { format!("/var/www/{}", domains[0]) } else { r } };
        if kind != 0 && (!root.starts_with('/') || root.contains([' ', ';'])) { s.set_ns_error("Webroot muss ein absoluter Pfad ohne Leerzeichen sein.".into()); return; }
        let text = site_config(&domains, kind, &upstream, &root, s.get_ns_ws());
        let enable = s.get_ns_enable();
        let debian = st().ngx_debian;
        let file = if debian { format!("{NGX}/sites-available/{}", domains[0]) } else { format!("{NGX}/conf.d/{}.conf", domains[0]) };
        s.set_ns_error("".into());
        spawn(async move {
            let r = match ensure_remote().await { Ok(r) => r, Err(e) => return toast(e.to_string(), "err") };
            if r.conn.exec(&format!("test -e {}", ssh::shq(&file)), 20).await.map(|x| x.code == 0).unwrap_or(false) {
                return ui(move |_, s| s.set_ns_error(ss(format!("{file} existiert bereits."))));
            }
            if kind != 0 { let _ = r.conn.exec(&format!("mkdir -p {}", ssh::shq(&root)), 20).await; }
            if let Err(e) = r.sftp.write(file.clone(), text.as_bytes()).await { let m = e.to_string(); return ui(move |_, s| s.set_ns_error(ss(m))); }
            ui(|_, s| s.set_ns_open(false));
            if enable && debian { ngx_toggle(file, true).await; return; }
            if !debian {
                let (ok, out) = test_and_reload(&r).await;
                if !ok { let _ = r.conn.exec(&format!("mv {0} {0}.disabled", ssh::shq(&file)), 20).await; ngx_out("Test fehlgeschlagen – Site deaktiviert", out, false); }
            }
            toast("Site angelegt", "ok");
            load_nginx().await;
        });
    }));

    // Backups
    s.on_backup_refresh(|| spawn(load_backups()));
    s.on_backup_create(|| ui(|_, s| {
        let d: String = s.get_backup_desc().chars().take(24).collect();
        s.set_backup_desc("".into());
        let Some(srv) = active() else { return };
        spawn(async move {
            match fire::backup_create(&srv, &d).await { Ok(_) => toast("Backup wird erstellt…", "ok"), Err(e) => toast(e.to_string(), "err") }
            load_backups().await;
        });
    }));
    s.on_backup_restore(|id| {
        let id = id.to_string();
        confirm("Backup wiederherstellen?", "Der aktuelle Stand des Servers wird durch dieses Backup ersetzt. Alle Änderungen seit dem Backup gehen verloren.", "Wiederherstellen", move || {
            let Some(srv) = active() else { return };
            spawn(async move { match fire::backup_restore(&srv, &id).await { Ok(_) => toast("Wiederherstellung gestartet", "ok"), Err(e) => toast(e.to_string(), "err") } });
        });
    });
    s.on_backup_delete(|id| {
        let id = id.to_string();
        confirm("Backup löschen?", "Ein gelöschtes Backup kann nicht wiederhergestellt werden.", "Endgültig löschen", move || {
            let Some(srv) = active() else { return };
            spawn(async move {
                match fire::backup_delete(&srv, &id).await { Ok(_) => toast("Backup gelöscht", "ok"), Err(e) => toast(e.to_string(), "err") }
                load_backups().await;
            });
        });
    });

    // API-Konsole
    s.on_api_run(|| ui(|_, s| {
        let input = s.get_api_input().trim().to_string();
        s.set_api_input("".into());
        let Some(srv) = active() else { return };
        let log = |l: LineItem, s: &S<'_>| { let mut v: Vec<LineItem> = s.get_api_lines().iter().collect(); v.push(l); s.set_api_lines(model(v)); };
        log(line(&input, "cmd"), &s);
        let mut it = input.split_whitespace();
        let (m, p) = (it.next().unwrap_or("").to_uppercase(), it.next().unwrap_or("").to_string());
        if !["GET", "POST", "PUT", "PATCH", "DELETE"].contains(&m.as_str()) || !p.starts_with('/') {
            log(line("Format: GET /v1/account oder POST /v1/servers/<id>/power mode=restart", "err"), &s);
            return;
        }
        let form: Vec<(String, String)> = it.filter_map(|a| a.split_once('=')).map(|(k, v)| (k.to_string(), v.to_string())).collect();
        spawn(async move {
            let path = p.replace(":id", &srv.sid);
            let f: Vec<(&str, String)> = form.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
            let key = srv.api_key().unwrap_or_default();
            let (text, kind) = match fire::raw(&srv.provider, &srv.env, &key, &m, &path, &f).await {
                Ok(r) => (serde_json::from_str::<Value>(&r.raw).ok().and_then(|v| serde_json::to_string_pretty(&v).ok()).unwrap_or(r.raw), ""),
                Err(e) => (e.to_string(), "err"),
            };
            ui(move |_, s| { let mut v: Vec<LineItem> = s.get_api_lines().iter().collect(); v.push(line(text, kind)); s.set_api_lines(model(v)); });
        });
    }));

    // Minecraft
    s.on_mc_select(|id| {
        let id = id.to_string();
        let first = ui_active_mc() != id;
        ui(move |_, s| {
            s.set_active_mc(ss(&id));
            if first {
                s.set_mc_rows(model(vec![]));
                mc_log("RCON-Konsole. Befehle ohne „/“ eingeben.", "info");
            }
            render_mc(&s);
            let tab = s.get_mc_tab();
            spawn(mc_refresh(id.clone()));
            spawn(mc_load(id.clone(), tab));
        });
    });
    s.on_mc_tab_changed(|t| { let id = ui_active_mc(); spawn(mc_load(id, t)); });
    s.on_mc_load(|| ui(|_, s| { let (id, t) = (s.get_active_mc().to_string(), s.get_mc_tab()); spawn(mc_load(id, t)); }));
    s.on_mc_send(|| ui(|_, s| {
        let c = s.get_mc_input().trim().trim_start_matches('/').to_string();
        s.set_mc_input("".into());
        if c.is_empty() { return; }
        if c == "stop" { confirm("Server stoppen?", "Der Minecraft-Server fährt herunter.", "Stoppen", move || mc_run(c, true)); } else { mc_run(c, true); }
    }));
    s.on_mc_cmd(|c| { let echo = ui_mc_tab() == 0; mc_run(c.to_string(), echo); });
    s.on_mc_stop(|| confirm("Minecraft-Server stoppen?", "Speichert die Welt und fährt den Server herunter. Starten musst du ihn danach über AMP bzw. dein Panel.", "Stoppen", || { mc_run("save-all".into(), true); mc_run("stop".into(), true); }));
    s.on_mc_player(|a, n| ui(move |_, s| {
        let n = n.trim().to_string();
        if n.is_empty() { return; }
        let cmd = match a.as_str() {
            "op" | "deop" | "kick" | "ban" | "pardon" => format!("{a} {n}"),
            "say" => { s.set_mc_say("".into()); format!("say {n}") }
            "whitelist-add" => { s.set_mc_wl_name("".into()); format!("whitelist add {n}") }
            "whitelist-remove" => format!("whitelist remove {n}"),
            _ => format!("gamemode {a} {n}"),
        };
        s.set_mc_ban_name("".into());
        mc_run(cmd, false);
        let (id, t) = (s.get_active_mc().to_string(), s.get_mc_tab());
        spawn(async move { tokio::time::sleep(Duration::from_millis(400)).await; mc_load(id, t).await; });
    }));
    s.on_mc_rule(|k, v| mc_run(format!("gamerule {k} {v}"), false));
    s.on_mc_edit(|| ui(|_, s| {
        let Some(m) = mc_get(&s.get_active_mc()) else { return };
        let servers = store::read().servers;
        s.set_mf_servers(model(servers.iter().map(|x| ss(&x.name)).collect()));
        s.set_mf_server(servers.iter().position(|x| Some(&x.id) == m.ssh_server_id.as_ref()).unwrap_or(0) as i32);
        s.set_mf_name(ss(&m.name)); s.set_mf_host(ss(&m.host)); s.set_mf_via(if m.via == "ssh" { 0 } else { 1 });
        s.set_mf_game(ss(m.game_port.to_string())); s.set_mf_rcon(ss(m.rcon_port.to_string())); s.set_mf_pass("".into());
        s.set_mf_test("".into()); s.set_mf_error("".into()); s.set_mf_edit(true); s.set_mf_open(true);
    }));
    s.on_mf_new(|| ui(|_, s| {
        s.set_mf_servers(model(store::read().servers.iter().map(|x| ss(&x.name)).collect()));
        s.set_mf_server(0); s.set_mf_name("".into()); s.set_mf_host("".into()); s.set_mf_pass("".into());
        s.set_mf_via(if store::read().servers.is_empty() { 1 } else { 0 });
        s.set_mf_test("".into()); s.set_mf_error("".into()); s.set_mf_edit(false); s.set_mf_open(true);
    }));
    s.on_mf_try(|| ui(|_, s| {
        match mc_form(&s) {
            Err(e) => s.set_mf_error(ss(e.to_string())),
            Ok(m) => {
                s.set_mf_error("".into());
                s.set_mf_test("Teste Verbindung…".into());
                spawn(async move {
                    let a = match mc_ping(&m).await { Ok(p) => format!("✓ Server online – {}, {}/{} Spieler", p.version, p.online, p.max), Err(e) => format!("✕ Status: {e}") };
                    let b = match mc_rcon_login(&m).await {
                        Ok(mut r) => match r.command("list").await { Ok(o) => format!("✓ RCON verbunden – {}", mc::strip(&o)), Err(e) => format!("✕ RCON: {e}") },
                        Err(e) => format!("✕ RCON: {e}"),
                    };
                    ui(move |_, s| s.set_mf_test(ss(format!("{a}\n{b}"))));
                });
            }
        }
    }));
    s.on_mf_save(|| ui(|_, s| {
        match mc_form(&s) {
            Err(e) => s.set_mf_error(ss(e.to_string())),
            Ok(m) => {
                let id = m.id.clone();
                store::update(|st| match st.minecraft.iter_mut().find(|x| x.id == m.id) { Some(x) => *x = m, None => st.minecraft.push(m) });
                spawn({ let id = id.clone(); async move { if let Some(p) = RCONS.get() { p.lock().await.remove(&id); } } });
                s.set_mf_open(false);
                side_mcs(&s);
                s.invoke_mc_select(ss(id));
            }
        }
    }));
    s.on_mc_remove(|| {
        let id = ui_active_mc();
        confirm("Minecraft-Server entfernen?", "Wird nur aus Fire Desktop entfernt. Der Server selbst bleibt unverändert.", "Entfernen", move || {
            store::update(|st| st.minecraft.retain(|m| m.id != id));
            ui(|_, s| { s.set_active_mc("".into()); side_mcs(&s); });
        });
    });

    // Claude
    s.on_cl_set_enabled(|v| { store::update(|s| s.claude.enabled = v); if v { mcp::ensure_token(); } ui(|_, s| render_claude(&s)); });
    s.on_cl_set_confirm(|v| {
        if v { store::update(|s| s.claude.confirm = true); ui(|_, s| render_claude(&s)); return; }
        ui(|_, s| render_claude(&s));
        confirm("Bestätigungen abschalten?", "Claude kann dann Server stoppen, Dateien löschen und Befehle ausführen, ohne dass du gefragt wirst.", "Abschalten", || { store::update(|s| s.claude.confirm = false); ui(|_, s| render_claude(&s)); });
    });
    s.on_cl_set_port(|p| { if let Ok(n) = p.parse::<u16>() { if n >= 1024 { store::update(|s| s.claude.port = n); } } ui(|_, s| render_claude(&s)); });
    s.on_cl_level(|id, i| {
        let (id, level) = (id.to_string(), ["none", "read", "control", "full"][i.clamp(0, 3) as usize]);
        let set = move || { store::update(|s| { s.claude.access.insert(id, level.to_string()); }); ui(|_, s| render_claude(&s)); };
        if level == "full" {
            ui(|_, s| render_claude(&s));
            confirm("Vollzugriff geben?", "Claude darf dann per SSH als root Befehle ausführen sowie Dateien lesen und schreiben. Mit aktivierter Bestätigung musst du jede riskante Aktion freigeben.", "Vollzugriff geben", set);
        } else { set(); }
    });
    s.on_cl_regen(|| confirm("Neues Token erzeugen?", "Verbundene Clients verlieren den Zugriff, bis sie neu eingetragen sind.", "Neu erzeugen", || {
        mcp::regenerate();
        if store::read().claude.registered { let _ = mcp::register_code(); }
        toast("Neues Token erzeugt", "ok");
    }));
    s.on_cl_register(|| spawn(async {
        let r = mcp::register_code();
        let msg = match r { Ok(_) => "In Claude Code eingetragen – Claude Code neu starten.".to_string(), Err(e) => format!("Eintragen fehlgeschlagen: {e}") };
        ui(move |_, s| s.set_cl_msg(ss(msg)));
    }));
    s.on_cl_copy(|what| {
        let c = store::read().claude;
        let t = if what == "url" { format!("http://127.0.0.1:{}/mcp", c.port) } else { mcp::ensure_token() };
        if let Ok(mut cb) = arboard::Clipboard::new() { let _ = cb.set_text(t); toast("In Zwischenablage kopiert", "ok"); }
    });
    s.on_au_load(|| ui(|_, s| audit_load(&s)));
    s.on_au_toggle(|i| ui(move |_, s| {
        let m = s.get_audit();
        if let Some(mut e) = m.row_data(i as usize) { e.open = !e.open; m.set_row_data(i as usize, e); }
    }));
    s.on_au_export(|| spawn(async {
        let Some(f) = rfd::AsyncFileDialog::new().set_file_name("claude-protokoll.txt").save_file().await else { return };
        match std::fs::write(f.path(), mcp::audit_text()) { Ok(_) => toast("Protokoll exportiert", "ok"), Err(e) => toast(e.to_string(), "err") }
    }));
    s.on_au_clear(|| confirm("Claude-Protokoll leeren?", "Alle gespeicherten Einträge werden gelöscht.", "Leeren", || { mcp::audit_clear(); ui(|_, s| audit_load(&s)); }));
    static ASK_ID: Mutex<String> = Mutex::new(String::new());
    let _ = mcp::ON_ASK.set(Box::new(|a| {
        // Nur Tests: automatisch antworten (Löschen wird abgelehnt)
        #[cfg(debug_assertions)]
        if std::env::var("FIRE_AUTO_ALLOW").is_ok() {
            let ok = !a.summary.contains("LÖSCHEN");
            let id = a.id.clone();
            spawn(async move { tokio::time::sleep(Duration::from_millis(100)).await; mcp::answer(&id, ok); });
            return;
        }
        *ASK_ID.lock().unwrap() = a.id;
        ui(move |app, s| {
            s.set_ask_server(ss(format!("{} · {}", a.server, a.tool)));
            s.set_ask_summary(ss(a.summary));
            s.set_ask_details(ss(a.details));
            s.set_ask_open(true);
            let _ = app.window().show();
        });
    }));
    let _ = mcp::ON_ASK_END.set(Box::new(|id| { if *ASK_ID.lock().unwrap() == id { ui(|_, s| s.set_ask_open(false)); } }));
    let _ = mcp::ON_LOG.set(Box::new(|| ui(|_, s| { if s.get_au_open() { audit_load(&s); } })));
    s.on_ask_answer(|ok| {
        let id = ASK_ID.lock().unwrap().clone();
        mcp::answer(&id, ok);
        ui(|_, s| s.set_ask_open(false));
    });

    // Discord
    let d = store::read().discord;
    s.set_dc_enabled(d.enabled);
    s.set_dc_details(ss(&d.details));
    s.set_dc_state(ss(&d.state));
    s.set_dc_large(ss(&d.large_image));
    s.set_dc_large_text(ss(&d.large_text));
    s.set_dc_small(ss(&d.small_image));
    s.set_dc_small_text(ss(&d.small_text));
    s.set_dc_type(match d.kind { 3 => 1, 2 => 2, 5 => 3, _ => 0 });
    s.set_dc_timer(match d.timer.as_str() { "app" => 1, "none" => 2, _ => 0 });
    let btn = |i: usize| d.buttons.get(i).cloned().unwrap_or_default();
    s.set_dc_b1l(ss(btn(0).label)); s.set_dc_b1u(ss(btn(0).url));
    s.set_dc_b2l(ss(btn(1).label)); s.set_dc_b2u(ss(btn(1).url));
    s.on_dc_init(|| ui(|_, s| {
        let d = store::read();
        let mut names = vec![ss("Gerade ausgewählter Server"), ss("Alle Server (Übersicht)")];
        names.extend(d.servers.iter().map(|x| ss(&x.name)));
        s.set_dc_servers(model(names));
        s.set_dc_server(match d.discord.server.as_str() {
            "active" => 0,
            "all" => 1,
            id => d.servers.iter().position(|x| x.id == id).map(|i| i as i32 + 2).unwrap_or(0),
        });
    }));
    s.on_dc_set_enabled(|v| { store::update(|s| s.discord.enabled = v); ui(move |_, s| s.set_dc_enabled(v)); });
    s.on_dc_save(|| ui(|_, s| {
        let (a, b, c, e) = (s.get_dc_details().to_string(), s.get_dc_state().to_string(), s.get_dc_large().to_string(), s.get_dc_large_text().to_string());
        let (small, small_text) = (s.get_dc_small().to_string(), s.get_dc_small_text().to_string());
        let kind = [0u8, 3, 2, 5][s.get_dc_type().clamp(0, 3) as usize];
        let timer = ["uptime", "app", "none"][s.get_dc_timer().clamp(0, 2) as usize].to_string();
        let idx = s.get_dc_server();
        let buttons: Vec<store::Button> = [(s.get_dc_b1l(), s.get_dc_b1u()), (s.get_dc_b2l(), s.get_dc_b2u())].into_iter()
            .filter(|(l, u)| !l.is_empty() || !u.is_empty())
            .map(|(l, u)| store::Button { label: l.trim().to_string(), url: u.trim().to_string() }).collect();
        if buttons.iter().any(|b| !b.url.starts_with("https://")) { toast("Button-Links müssen mit https:// beginnen", "err"); }
        store::update(|st| {
            st.discord.server = match idx { 0 | -1 => "active".into(), 1 => "all".into(), i => st.servers.get(i as usize - 2).map(|x| x.id.clone()).unwrap_or_else(|| "active".into()) };
            st.discord.details = a; st.discord.state = b; st.discord.large_image = c; st.discord.large_text = e;
            st.discord.small_image = small; st.discord.small_text = small_text;
            st.discord.kind = kind; st.discord.timer = timer; st.discord.buttons = buttons;
        });
    }));
    s.on_dc_portal(|| { let _ = open::that("https://discord.com/developers/applications"); });

    // Update
    s.on_up_check(|| spawn(check_update(true)));
    s.on_up_install(|| {
        let Some(info) = UPDATE.lock().unwrap().clone() else { return };
        if !updater::is_installed() { let _ = open::that(&info.page); return; }
        ui(|_, s| { s.set_up_progress(0.0); s.set_up_status("Lade Update…".into()); });
        spawn(async move {
            let res = updater::install(&info, |d, t| {
                let p = if t > 0 { d as f32 / t as f32 } else { 0.0 };
                ui(move |_, s| { s.set_up_progress(p); s.set_up_status(ss(format!("Lade Update… {:.0} %", p * 100.0))); });
            }).await;
            match res {
                Ok(_) => { let _ = slint::invoke_from_event_loop(|| { let _ = slint::quit_event_loop(); }); }
                Err(e) => { let t = e.to_string(); ui(move |_, s| { s.set_up_progress(-2.0); s.set_up_status(ss(t)); }); }
            }
        });
    });

    // Hintergrund
    spawn(mcp::run());
    spawn(discord::run());
    spawn(async {
        tokio::time::sleep(Duration::from_secs(4)).await;
        check_update(false).await;
    });
    spawn(async {
        let mut tick = 0u64;
        loop {
            tokio::time::sleep(Duration::from_millis(300)).await;
            tick += 1;
            transfers_tick();
            if tick % 3 == 0 {
                let d = discord::state();
                ui(move |_, s| {
                    render_claude(&s);
                    s.set_dc_side(ss(if !s.get_dc_enabled() { "Aus" } else if d.connected { "An" } else { "Fehler" }));
                    s.set_dc_status(ss(if !s.get_dc_enabled() { "Aus".to_string() } else if d.connected { format!("Verbunden{}", if d.user.is_empty() { String::new() } else { format!(" als {}", d.user) }) } else { d.error.clone() }));
                    s.set_dc_status_kind(ss(if d.connected { "good" } else { "" }));
                    s.set_dc_pv_details(ss(d.details));
                    s.set_dc_pv_state(ss(d.state));
                });
            }
            if tick % 17 == 0 { refresh(false).await; }
            if tick % 200 == 0 { ui(|_, s| if s.get_tab() == 4 && s.get_active_mc().is_empty() { spawn(load_stats()); }); }
            if tick % 50 == 0 { let t = ui_active_mc(); if !t.is_empty() { mc_refresh(t).await; } }
            if tick % 100 == 1 {
                let data = store::read();
                let current = st().active.clone();
                for x in data.servers.iter().filter(|x| x.id != current) {
                    let r = fire::status(x).await.map_err(|e| e.to_string());
                    st().status.insert(x.id.clone(), r);
                }
                for m in &data.minecraft { mc_refresh(m.id.clone()).await; }
                ui(|_, s| side_servers(&s));
            }
        }
    });

    #[cfg(debug_assertions)]
    if let Ok(dir) = std::env::var("FIRE_SHOT_DIR") { spawn(tour(dir)); }

    // Start
    side_servers(&s);
    side_mcs(&s);
    render_claude(&s);
    if let Some(first) = store::read().servers.first() { select_server(first.id.clone()); }
}

fn a2(a: &str) -> Option<(&'static str, &'static str, &'static str)> {
    match a {
        "restart" => Some(("Nginx neu starten?", "Laufende Verbindungen werden kurz unterbrochen. Vorher wird die Konfiguration getestet.", "Neu starten")),
        "install" => Some(("Nginx installieren?", "Führt apt-get update und apt-get install -y nginx auf dem Server aus.", "Installieren")),
        _ => None,
    }
}

fn ui_active_mc() -> String {
    WINDOW.get().and_then(|w| w.upgrade()).map(|a| a.global::<S>().get_active_mc().to_string()).unwrap_or_default()
}

fn ui_mc_tab() -> i32 {
    WINDOW.get().and_then(|w| w.upgrade()).map(|a| a.global::<S>().get_mc_tab()).unwrap_or(0)
}


// Nur Debug-Build: Rundgang mit Bildschirmfotos für Tests
#[cfg(debug_assertions)]
async fn tour(dir: String) {
    let wait = |ms| tokio::time::sleep(Duration::from_millis(ms));
    let shot = |name: &'static str, dir: String| ui(move |app, _| {
        if let Ok(b) = app.window().take_snapshot() {
            let _ = image::save_buffer(format!("{dir}/{name}.png"), b.as_bytes(), b.width(), b.height(), image::ColorType::Rgba8);
        }
    });
    wait(3000).await;
    shot("r1-overview", dir.clone());
    // Gegen die echte API: nur lesen, kein SSH
    if std::env::var("FIRE_READONLY").is_ok() {
        ui(|_, s| { s.set_tab(4); s.invoke_tab_changed(4); });
        wait(45_000).await;
        ui(|_, s| println!("TEST live: {} {} | {}", s.get_live_cpu_now(), s.get_live_mem_now(), s.get_stats_info()));
        shot("r5c-real", dir.clone());
        wait(500).await;
        std::process::exit(0);
    }
    ui(|_, s| { s.set_srv_pass_show(true); });
    wait(100).await;
    ui(|_, s| { s.set_tab(1); });
    wait(400).await;
    ui(|_, s| { s.set_ssh_pass("test123".into()); s.invoke_ssh_connect(); });
    wait(2500).await;
    if let Some(tx) = TERM_TX.lock().unwrap().as_ref() { let _ = tx.send(TermMsg::Input(b"ls --color\r".to_vec())); }
    wait(800).await;
    println!("TEST terminal: {:?}", PARSER.lock().unwrap().as_ref().map(|p| p.screen().contents()));
    ui(|_, s| { s.invoke_term_sel(30.0, 62.0, true); s.invoke_term_sel(150.0, 62.0, false); });
    wait(300).await;
    println!("TEST auswahl: {:?}", sel_text());
    shot("r2b-select", dir.clone());
    if let Some(tx) = TERM_TX.lock().unwrap().as_ref() { let _ = tx.send(TermMsg::Input(Vec::new())); }
    println!("TEST spalten: {:?}", TERM_SIZE.lock().unwrap());
    shot("r2-console", dir.clone());
    ui(|_, s| { s.set_tab(0); });
    wait(500).await;
    ui(|_, s| println!("TEST passwort: {:?}", s.get_srv_pass()));
    shot("r1b-password", dir.clone());
    ui(|_, s| { s.set_tab(1); });
    wait(300).await;
    if std::env::var("FIRE_STATS").is_ok() {
        ui(|_, s| { s.set_tab(4); s.invoke_tab_changed(4); });
        wait(130_000).await;
        ui(|_, s| println!("TEST live: {} {} | {}", s.get_live_cpu_now(), s.get_live_mem_now(), s.get_stats_info()));
        shot("r5b-live", dir.clone());
        wait(500).await;
    }
    for (i, name) in [(2, "r3-files"), (3, "r4-nginx"), (4, "r5-stats"), (5, "r6-backups")] {
        ui(move |_, s| { s.set_tab(i); s.invoke_tab_changed(i); });
        wait(2500).await;
        shot(name, dir.clone());
    }
    ui(|_, s| { s.set_tab(2); s.invoke_tab_changed(2); });
    wait(1000).await;
    ui(|_, s| s.invoke_fm_open("notes.txt".into()));
    wait(1000).await;
    shot("r7-editor", dir.clone());
    ui(|_, s| s.set_ed_open(false));
    if let Ok(f) = std::env::var("FIRE_DROP") {
        on_drop(PathBuf::from(f));
        wait(1200).await;
        println!("TEST drop: {:?}", st().entries.iter().map(|e| e.name.clone()).collect::<Vec<_>>());
    }
    if let Ok(big) = std::env::var("FIRE_BIG") {
        if let Ok(r) = ensure_remote().await {
            let (id, job) = transfer_start(true, "bigfile.bin → /root".into());
            let j2 = job.clone();
            let cwd = st().cwd.clone();
            let h = rt().spawn(ssh::upload(r.sftp.clone(), vec![PathBuf::from(big)], cwd, job));
            wait(350).await;
            shot("r8-transfer", dir.clone());
            println!("TEST upload {} von {}", j2.done.load(Ordering::Relaxed), j2.total.load(Ordering::Relaxed));
            j2.cancel.store(true, Ordering::Relaxed);
            let res = h.await.unwrap();
            println!("TEST abbruch: {:?}", res.as_ref().map_err(|e| e.to_string()));
            transfer_end(&id, res);
        }
    }
    let first_mc = store::read().minecraft.first().map(|m| m.id.clone());
    if let Some(id) = first_mc {
        ui(move |_, s| s.invoke_mc_select(ss(id)));
        wait(1500).await;
        ui(|_, s| { s.set_mc_input("list".into()); s.invoke_mc_send(); });
        wait(800).await;
        shot("r9-mc", dir.clone());
        ui(|_, s| { s.set_mc_tab(1); s.invoke_mc_tab_changed(1); });
        wait(1500).await;
        shot("r10-mcplayers", dir.clone());
        if let Some(m) = store::read().minecraft.get(1).cloned() {
            let t = mc_command(&m.id, "list").await;
            println!("TEST tunnel: {:?}", t.map_err(|e| e.to_string()));
            println!("TEST tunnel-ping: {:?}", mc_ping(&m).await.map(|p| p.version).map_err(|e| e.to_string()));
        }
    }
    ui(|_, s| s.set_active_mc("".into()));
    ui(|_, s| s.set_cl_open(true));
    wait(800).await;
    shot("r11-claude", dir.clone());
    ui(|_, s| { s.set_cl_open(false); s.invoke_dc_init(); s.set_dc_open(true); });
    wait(800).await;
    shot("r12-discord", dir.clone());
    ui(|_, s| {
        s.set_dc_type(1); s.set_dc_timer(2); s.set_dc_b1l("Zum Server".into()); s.set_dc_b1u("https://example.de".into());
        s.invoke_dc_save(); s.set_dc_open(false);
    });
    wait(1500).await;
    let d = store::read().discord;
    println!("TEST discord: kind={} timer={} buttons={}", d.kind, d.timer, d.buttons.len());
    ui(|_, s| { s.set_au_server(1); s.invoke_au_load(); s.set_au_open(true); });
    wait(1500).await;
    shot("r13-audit", dir.clone());
    ui(|_, s| s.set_au_open(false));
    if std::env::var("FIRE_STAY").is_ok() { return; }
    wait(500).await;
    let _ = slint::invoke_from_event_loop(|| { let _ = slint::quit_event_loop(); });
}
