//! Einstellungen und Geheimnisse in %APPDATA%\Fire Desktop\servers.json.
//! Gleiche Datei wie die Electron-Version; deren `safeStorage`-Werte werden beim Lesen entschlüsselt
//! und beim nächsten Speichern als reines Windows-DPAPI abgelegt.

use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, sync::{Mutex, OnceLock}};
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};

pub fn root() -> PathBuf {
    let base = std::env::var("FIRE_DATA_DIR").or_else(|_| std::env::var("APPDATA")).unwrap_or_else(|_| ".".into());
    if std::env::var("FIRE_DATA_DIR").is_ok() { PathBuf::from(base) } else { PathBuf::from(base).join("Fire Desktop") }
}

fn file() -> PathBuf { root().join("servers.json") }

// ---------- Geheimnisse ----------

/// `alg` fehlt bei Werten der Electron-Version.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Secret {
    #[serde(default)]
    pub enc: bool,
    #[serde(default)]
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alg: Option<String>,
}

fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 }
}

fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
    unsafe { LocalFree(out.pbData as _) };
    v
}

fn protect(data: &[u8]) -> Option<Vec<u8>> {
    let input = blob(data);
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe { CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut out) };
    (ok != 0).then(|| take(out))
}

fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
    let input = blob(data);
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe { CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut out) };
    (ok != 0).then(|| take(out))
}

/// Schlüssel von Electrons safeStorage: liegt DPAPI-verschlüsselt in "Local State".
fn chromium_key() -> Option<Vec<u8>> {
    let text = std::fs::read_to_string(root().join("Local State")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let raw = B64.decode(json["os_crypt"]["encrypted_key"].as_str()?).ok()?;
    unprotect(raw.strip_prefix(b"DPAPI")?)
}

fn chromium_decrypt(data: &[u8]) -> Option<String> {
    let body = data.strip_prefix(b"v10")?;
    if body.len() < 12 + 16 { return None; }
    let key = chromium_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).ok()?;
    let plain = cipher.decrypt(Nonce::from_slice(&body[..12]), &body[12..]).ok()?;
    String::from_utf8(plain).ok()
}

impl Secret {
    pub fn new(plain: &str) -> Secret {
        match protect(plain.as_bytes()) {
            Some(b) => Secret { enc: true, value: B64.encode(b), alg: Some("dpapi".into()) },
            None => Secret { enc: false, value: plain.into(), alg: None },
        }
    }

    /// None, wenn der Wert nicht (mehr) entschlüsselt werden kann.
    pub fn reveal(&self) -> Option<String> {
        if !self.enc { return Some(self.value.clone()); }
        let raw = B64.decode(&self.value).ok()?;
        if self.alg.as_deref() == Some("dpapi") {
            return unprotect(&raw).and_then(|b| String::from_utf8(b).ok());
        }
        chromium_decrypt(&raw)
    }
}

// ---------- Daten ----------

fn default_provider() -> String { "24fire".into() }
fn default_env() -> String { "live".into() }

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Server {
    pub id: String,
    pub name: String,
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default)]
    pub sid: String,
    #[serde(default = "default_env")]
    pub env: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<Secret>,
    #[serde(default, rename = "keyHint")]
    pub key_hint: String,
    #[serde(default, rename = "sshPass", skip_serializing_if = "Option::is_none")]
    pub ssh_pass: Option<Secret>,
    #[serde(default, rename = "hostKeys", skip_serializing_if = "HashMap::is_empty")]
    pub host_keys: HashMap<String, String>,
    #[serde(default, rename = "createdAt")]
    pub created_at: String,
}

impl Server {
    pub fn api_key(&self) -> Option<String> { self.key.as_ref()?.reveal() }
    pub fn saved_ssh(&self) -> Option<String> { self.ssh_pass.as_ref()?.reveal() }
}

fn p25565() -> u16 { 25565 }
fn p25575() -> u16 { 25575 }
fn direct() -> String { "direct".into() }

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Minecraft {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub host: String,
    #[serde(default = "p25565", rename = "gamePort")]
    pub game_port: u16,
    #[serde(default = "p25575", rename = "rconPort")]
    pub rcon_port: u16,
    #[serde(default = "direct")]
    pub via: String,
    #[serde(default, rename = "sshServerId", skip_serializing_if = "Option::is_none")]
    pub ssh_server_id: Option<String>,
    #[serde(default, rename = "rconPass", skip_serializing_if = "Option::is_none")]
    pub rcon_pass: Option<Secret>,
}

fn port_mcp() -> u16 { 39731 }
fn yes() -> bool { true }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Claude {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "port_mcp")]
    pub port: u16,
    #[serde(default = "yes")]
    pub confirm: bool,
    #[serde(default)]
    pub access: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<Secret>,
    #[serde(default)]
    pub registered: bool,
}

impl Default for Claude {
    fn default() -> Self {
        Claude { enabled: false, port: port_mcp(), confirm: true, access: HashMap::new(), token: None, registered: false }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Button {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub url: String,
}

fn d_server() -> String { "active".into() }
fn d_details() -> String { "{name} · {status}".into() }
fn d_state() -> String { "CPU {cpu} · RAM {ram}/{ram_max}".into() }
fn d_large() -> String { "fire_desktop".into() }
fn d_large_text() -> String { "Fire Desktop · 24fire".into() }
fn d_small_text() -> String { "{status} · {uptime}".into() }
fn d_timer() -> String { "uptime".into() }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Discord {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "d_server")]
    pub server: String,
    #[serde(default, rename = "type")]
    pub kind: u8,
    #[serde(default = "d_details")]
    pub details: String,
    #[serde(default = "d_state")]
    pub state: String,
    #[serde(default = "d_large", rename = "largeImage")]
    pub large_image: String,
    #[serde(default = "d_large_text", rename = "largeText")]
    pub large_text: String,
    #[serde(default, rename = "smallImage")]
    pub small_image: String,
    #[serde(default = "d_small_text", rename = "smallText")]
    pub small_text: String,
    #[serde(default = "d_timer")]
    pub timer: String,
    #[serde(default)]
    pub buttons: Vec<Button>,
}

impl Default for Discord {
    fn default() -> Self { serde_json::from_str("{}").unwrap() }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Store {
    #[serde(default)]
    pub servers: Vec<Server>,
    #[serde(default)]
    pub minecraft: Vec<Minecraft>,
    #[serde(default)]
    pub claude: Claude,
    #[serde(default)]
    pub discord: Discord,
}

static STORE: OnceLock<Mutex<Store>> = OnceLock::new();

fn cell() -> &'static Mutex<Store> {
    STORE.get_or_init(|| {
        let mut s: Store = std::fs::read_to_string(file()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        for srv in &mut s.servers {
            if srv.sid.is_empty() { srv.sid = srv.id.clone(); }
        }
        Mutex::new(s)
    })
}

pub fn read() -> Store { cell().lock().unwrap().clone() }

/// Ändert die Daten und schreibt sie atomar auf die Platte.
pub fn update<R>(f: impl FnOnce(&mut Store) -> R) -> R {
    let mut guard = cell().lock().unwrap();
    let out = f(&mut guard);
    let _ = std::fs::create_dir_all(root());
    if let Ok(text) = serde_json::to_string_pretty(&*guard) {
        let tmp = file().with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, file());
        }
    }
    out
}

pub fn server(id: &str) -> Option<Server> { read().servers.into_iter().find(|s| s.id == id) }

pub fn key_hint(key: &str) -> String {
    let n = key.chars().count();
    if n > 8 {
        let head: String = key.chars().take(4).collect();
        let tail: String = key.chars().skip(n - 4).collect();
        format!("{head}…{tail}")
    } else {
        "••••".into()
    }
}
