//! SSH auf Basis von russh: Verbindung mit Host-Key-Prüfung, Befehle, Shell, Tunnel und SFTP.

use crate::{fire, mc::BoxStream, store};
use anyhow::{anyhow, bail, Result};
use russh::client::{self, Handle, Msg};
use russh::keys::{ssh_key, HashAlg};
use russh::{Channel, ChannelMsg, Disconnect};
use russh_sftp::client::SftpSession;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub struct Client {
    server_id: String,
    target: String,
    host_error: Arc<Mutex<Option<String>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    // Host-Key beim ersten Verbinden merken, bei Änderung abbrechen
    async fn check_server_key(&mut self, key: &ssh_key::PublicKey) -> Result<bool, Self::Error> {
        let fp = key.fingerprint(HashAlg::Sha256).to_string().trim_start_matches("SHA256:").to_string();
        let known = store::server(&self.server_id).and_then(|s| s.host_keys.get(&self.target).cloned());
        match known {
            // Electron speicherte mit Base64-Füllzeichen
            Some(k) if k.trim_end_matches('=') != fp => {
                *self.host_error.lock().unwrap() = Some(format!("Host-Key von {} hat sich geändert! Erwartet SHA256:{k}, erhalten SHA256:{fp}. Verbindung abgebrochen. Nach einer Neuinstallation unter „Zugangsdaten“ den Host-Key vergessen.", self.target));
                Ok(false)
            }
            Some(_) => Ok(true),
            None => {
                let (id, target) = (self.server_id.clone(), self.target.clone());
                store::update(|st| {
                    if let Some(s) = st.servers.iter_mut().find(|s| s.id == id) { s.host_keys.insert(target, fp); }
                });
                Ok(true)
            }
        }
    }
}

pub struct Conn {
    handle: Handle<Client>,
    pub user: String,
}

/// Übersetzt Netzwerkfehler in verständliches Deutsch mit wahrscheinlicher Ursache.
fn explain(e: &russh::Error, host: &str, port: u16) -> String {
    let t = format!("{host}:{port}");
    if let russh::Error::IO(io) = e {
        use std::io::ErrorKind::*;
        return match io.kind() {
            ConnectionRefused => format!("Verbindung abgelehnt: {t} ist erreichbar, aber dort läuft kein SSH. Der SSH-Dienst ist gestoppt (systemctl start ssh) oder läuft auf einem anderen Port."),
            TimedOut => timeout_text(&t, port),
            ConnectionReset | ConnectionAborted => format!("Verbindung von {t} getrennt. Häufig durch eine Firewall oder fail2ban (zu viele Fehlversuche)."),
            _ => format!("Verbindung zu {t} fehlgeschlagen: {io}"),
        };
    }
    format!("SSH-Fehler: {e}")
}

fn timeout_text(t: &str, port: u16) -> String {
    format!("Zeitüberschreitung: {t} antwortet nicht. Wahrscheinlich ist der Server gestoppt, startet gerade oder eine Firewall blockt Port {port}. Über die noVNC-Konsole kommst du trotzdem auf den Server.")
}

pub async fn connect(server_id: &str, host: &str, port: u16, user: &str, password: &str) -> Result<Conn> {
    let saved = store::server(server_id).and_then(|s| s.saved_ssh());
    let pass = if password.is_empty() { saved.clone().unwrap_or_default() } else { password.to_string() };
    if pass.is_empty() {
        bail!("Kein SSH-Passwort bekannt. Die neue 24fire-API gibt das Root-Passwort nicht mehr heraus: Trage es einmal unter „Zugangsdaten“ ein, danach merkt sich die App es verschlüsselt.");
    }
    let target = format!("{host}:{port}");
    let host_error = Arc::new(Mutex::new(None));
    let cfg = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(20)),
        ..Default::default()
    });
    let handler = Client { server_id: server_id.to_string(), target: target.clone(), host_error: host_error.clone() };
    let fut = client::connect(cfg, (host, port), handler);
    let mut handle = match tokio::time::timeout(Duration::from_secs(15), fut).await {
        Err(_) => bail!(timeout_text(&target, port)),
        Ok(Err(e)) => {
            if let Some(h) = host_error.lock().unwrap().take() { bail!(h); }
            bail!(explain(&e, host, port));
        }
        Ok(Ok(h)) => h,
    };
    let auth = handle.authenticate_password(user, &pass).await.map_err(|e| anyhow!(explain(&e, host, port)))?;
    if !auth.success() {
        bail!("Anmeldung abgelehnt: Benutzer oder Passwort stimmen nicht. Nach einer Neuinstallation ändert sich das Passwort; manche Server erlauben auch keinen Passwort-Login für root.");
    }
    if saved.as_deref() != Some(pass.as_str()) {
        let id = server_id.to_string();
        store::update(|st| {
            if let Some(s) = st.servers.iter_mut().find(|s| s.id == id) { s.ssh_pass = Some(store::Secret::new(&pass)); }
        });
    }
    Ok(Conn { handle, user: user.to_string() })
}

/// Verbindet mit den Daten aus der Server-Konfiguration (für Tunnel und Claude).
pub async fn connect_server(s: &store::Server) -> Result<Conn> {
    let cfg = fire::config(s).await?;
    let host = cfg.ipv4.first().cloned().ok_or_else(|| anyhow!("Keine IPv4-Adresse in der Server-Konfiguration"))?;
    connect(&s.id, &host, 22, &cfg.username, &cfg.password).await
}

pub struct ExecResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub fn shq(s: &str) -> String { format!("'{}'", s.replace('\'', "'\\''")) }

impl Conn {
    pub fn alive(&self) -> bool { !self.handle.is_closed() }

    pub async fn exec(&self, cmd: &str, secs: u64) -> Result<ExecResult> {
        let full = if self.user == "root" { cmd.to_string() } else { format!("sudo -n sh -c {}", shq(cmd)) };
        let mut ch = self.handle.channel_open_session().await?;
        ch.exec(true, format!("export PATH=\"$PATH:/usr/sbin:/sbin\"; {full}")).await?;
        let (mut out, mut err, mut code) = (Vec::new(), Vec::new(), -1);
        let run = async {
            while let Some(m) = ch.wait().await {
                match m {
                    ChannelMsg::Data { data } => out.extend_from_slice(&data),
                    ChannelMsg::ExtendedData { data, .. } => err.extend_from_slice(&data),
                    ChannelMsg::ExitStatus { exit_status } => code = exit_status as i32,
                    _ => {}
                }
            }
        };
        if tokio::time::timeout(Duration::from_secs(secs), run).await.is_err() { bail!("Befehl läuft zu lange (Zeitlimit {secs} s)"); }
        Ok(ExecResult { code, stdout: String::from_utf8_lossy(&out).into_owned(), stderr: String::from_utf8_lossy(&err).into_owned() })
    }

    pub async fn shell(&self, cols: u32, rows: u32) -> Result<Channel<Msg>> {
        let ch = self.handle.channel_open_session().await?;
        ch.request_pty(true, "xterm-256color", cols, rows, 0, 0, &[]).await?;
        ch.request_shell(true).await?;
        Ok(ch)
    }

    pub async fn sftp(&self) -> Result<Arc<SftpSession>> {
        let ch = self.handle.channel_open_session().await?;
        ch.request_subsystem(true, "sftp").await?;
        Ok(Arc::new(SftpSession::new(ch.into_stream()).await.map_err(|e| anyhow!("SFTP nicht verfügbar: {e}"))?))
    }

    pub async fn tunnel(&self, host: &str, port: u16) -> Result<BoxStream> {
        let ch = self.handle.channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0).await
            .map_err(|e| anyhow!("Port {port} auf dem Server nicht erreichbar ({e})"))?;
        Ok(Box::new(ch.into_stream()))
    }

    pub async fn close(&self) {
        let _ = self.handle.disconnect(Disconnect::ByApplication, "", "de").await;
    }
}

// ---------- SFTP ----------

#[derive(Clone, Debug)]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
    pub is_link: bool,
    pub size: u64,
    pub mtime: i64,
    pub perms: String,
    pub mode: u32,
}

fn perm_string(mode: u32, is_dir: bool, is_link: bool) -> String {
    let mut s = String::from(if is_dir { "d" } else if is_link { "l" } else { "-" });
    for i in (0..9).rev() {
        s.push(if mode & (1 << i) != 0 { ['x', 'w', 'r'][i % 3] } else { '-' });
    }
    s
}

pub fn join(dir: &str, name: &str) -> String { format!("{}/{}", dir.trim_end_matches('/'), name) }
pub fn parent(p: &str) -> String {
    match p.trim_end_matches('/').rsplit_once('/') { Some(("", _)) | None => "/".into(), Some((a, _)) => a.to_string() }
}

pub async fn list(sftp: &SftpSession, dir: &str) -> Result<(String, Vec<Entry>)> {
    let path = sftp.canonicalize(dir).await?;
    let mut out = Vec::new();
    for e in sftp.read_dir(&path).await? {
        let name = e.file_name();
        if name == "." || name == ".." { continue; }
        let m = e.metadata();
        let is_link = m.is_symlink();
        let mut is_dir = m.is_dir();
        if is_link {
            if let Ok(t) = sftp.metadata(join(&path, &name)).await { is_dir = t.is_dir(); }
        }
        let mode = m.permissions.unwrap_or(0) & 0o7777;
        out.push(Entry { name, is_dir, is_link, size: m.size.unwrap_or(0), mtime: m.mtime.unwrap_or(0) as i64, perms: perm_string(mode, is_dir && !is_link, is_link), mode });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok((path, out))
}

pub async fn chmod(sftp: &SftpSession, path: &str, mode: u32) -> Result<()> {
    let mut m = sftp.metadata(path).await?;
    m.permissions = Some((m.permissions.unwrap_or(0) & !0o7777) | mode);
    sftp.set_metadata(path, m).await?;
    Ok(())
}

// ---------- Übertragungen ----------

pub struct Job {
    pub done: AtomicU64,
    pub total: AtomicU64,
    pub files: AtomicU64,
    pub files_done: AtomicU64,
    pub cancel: AtomicBool,
    pub name: Mutex<String>,
}

impl Job {
    pub fn new() -> Arc<Job> {
        Arc::new(Job { done: 0.into(), total: 0.into(), files: 0.into(), files_done: 0.into(), cancel: false.into(), name: Mutex::new(String::new()) })
    }
}

const CHUNK: usize = 256 * 1024;

fn scan_local(local: &Path, remote: &str, files: &mut Vec<(PathBuf, String, u64)>, dirs: &mut Vec<String>) -> Result<()> {
    let name = local.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let target = join(remote, &name);
    let m = std::fs::metadata(local)?;
    if m.is_dir() {
        dirs.push(target.clone());
        for e in std::fs::read_dir(local)? { scan_local(&e?.path(), &target, files, dirs)?; }
    } else {
        files.push((local.to_path_buf(), target, m.len()));
    }
    Ok(())
}

/// Lädt Dateien/Ordner hoch; liefert die Anzahl fertiger Dateien.
pub async fn upload(sftp: Arc<SftpSession>, locals: Vec<PathBuf>, remote_dir: String, job: Arc<Job>) -> Result<u64> {
    let (mut files, mut dirs) = (Vec::new(), Vec::new());
    for l in &locals { scan_local(l, &remote_dir, &mut files, &mut dirs)?; }
    job.files.store(files.len() as u64, Ordering::Relaxed);
    job.total.store(files.iter().map(|f| f.2).sum(), Ordering::Relaxed);
    for d in dirs { let _ = sftp.create_dir(d).await; }
    let mut buf = vec![0u8; CHUNK];
    for (local, remote, _) in files {
        *job.name.lock().unwrap() = local.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let mut src = tokio::fs::File::open(&local).await?;
        let mut dst = sftp.create(remote.clone()).await?;
        loop {
            if job.cancel.load(Ordering::Relaxed) {
                drop(dst);
                let _ = sftp.remove_file(remote).await;
                bail!("Abgebrochen");
            }
            let n = src.read(&mut buf).await?;
            if n == 0 { break; }
            dst.write_all(&buf[..n]).await?;
            job.done.fetch_add(n as u64, Ordering::Relaxed);
        }
        dst.shutdown().await?;
        job.files_done.fetch_add(1, Ordering::Relaxed);
    }
    Ok(job.files_done.load(Ordering::Relaxed))
}

async fn scan_remote(sftp: &SftpSession, remote: String, local: PathBuf, files: &mut Vec<(String, PathBuf, u64)>, dirs: &mut Vec<PathBuf>) -> Result<()> {
    let mut stack = vec![(remote, local)];
    while let Some((r, l)) = stack.pop() {
        let m = sftp.metadata(r.clone()).await?;
        if m.is_dir() {
            dirs.push(l.clone());
            for e in sftp.read_dir(r.clone()).await? {
                let n = e.file_name();
                if n != "." && n != ".." { stack.push((join(&r, &n), l.join(&n))); }
            }
        } else {
            files.push((r, l, m.size.unwrap_or(0)));
        }
    }
    Ok(())
}

pub async fn download(sftp: Arc<SftpSession>, pairs: Vec<(String, PathBuf)>, job: Arc<Job>) -> Result<u64> {
    let (mut files, mut dirs) = (Vec::new(), Vec::new());
    for (r, l) in pairs { scan_remote(&sftp, r, l, &mut files, &mut dirs).await?; }
    job.files.store(files.len() as u64, Ordering::Relaxed);
    job.total.store(files.iter().map(|f| f.2).sum(), Ordering::Relaxed);
    for d in dirs { tokio::fs::create_dir_all(d).await?; }
    let mut buf = vec![0u8; CHUNK];
    for (remote, local, _) in files {
        *job.name.lock().unwrap() = remote.rsplit('/').next().unwrap_or("").to_string();
        if let Some(p) = local.parent() { tokio::fs::create_dir_all(p).await?; }
        let mut src = sftp.open(remote).await?;
        let mut dst = tokio::fs::File::create(&local).await?;
        loop {
            if job.cancel.load(Ordering::Relaxed) {
                drop(dst);
                let _ = tokio::fs::remove_file(&local).await;
                bail!("Abgebrochen");
            }
            let n = src.read(&mut buf).await?;
            if n == 0 { break; }
            dst.write_all(&buf[..n]).await?;
            job.done.fetch_add(n as u64, Ordering::Relaxed);
        }
        dst.flush().await?;
        job.files_done.fetch_add(1, Ordering::Relaxed);
    }
    Ok(job.files_done.load(Ordering::Relaxed))
}
