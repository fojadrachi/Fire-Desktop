//! App-Updates über GitHub-Releases: neueste Version prüfen, Setup laden, SHA-256 prüfen,
//! still installieren. Das Setup startet Fire Desktop danach neu.

use crate::fire;
use anyhow::{bail, Result};
use futures::StreamExt;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

const LATEST: &str = "https://api.github.com/repos/fojadrachi/Fire-Desktop/releases/latest";
const SETUP_PREFIX: &str = "Fire-Desktop-Setup-";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone, Debug, Default)]
pub struct UpdateInfo {
    pub available: bool,
    pub latest: String,
    pub notes: String,
    pub url: String,
    pub page: String,
    pub size: u64,
    pub sha256: Option<String>,
}

fn parse(v: &str) -> (u64, u64, u64) {
    let mut it = v.trim_start_matches(['v', 'V']).split(['.', '-', '+']).map(|p| p.parse().unwrap_or(0));
    (it.next().unwrap_or(0), it.next().unwrap_or(0), it.next().unwrap_or(0))
}

pub async fn check() -> Result<UpdateInfo> {
    let res = fire::client().get(LATEST).header("Accept", "application/vnd.github+json").send().await?;
    if res.status() == reqwest::StatusCode::NOT_FOUND { return Ok(UpdateInfo::default()); }
    let rel: serde_json::Value = res.error_for_status()?.json().await?;
    let tag = rel["tag_name"].as_str().unwrap_or_default().to_string();
    let asset = rel["assets"].as_array().into_iter().flatten().find(|a| {
        let n = a["name"].as_str().unwrap_or_default();
        n.starts_with(SETUP_PREFIX) && n.to_lowercase().ends_with(".exe")
    });
    Ok(UpdateInfo {
        available: parse(&tag) > parse(VERSION) && asset.is_some(),
        latest: tag.trim_start_matches(['v', 'V']).to_string(),
        notes: rel["body"].as_str().unwrap_or_default().to_string(),
        url: asset.and_then(|a| a["browser_download_url"].as_str()).unwrap_or_default().to_string(),
        page: rel["html_url"].as_str().unwrap_or_default().to_string(),
        size: asset.and_then(|a| a["size"].as_u64()).unwrap_or(0),
        sha256: asset.and_then(|a| a["digest"].as_str()).and_then(|d| d.strip_prefix("sha256:")).map(|s| s.to_lowercase()),
    })
}

/// Installiert läuft die App aus %LOCALAPPDATA%\Programs; sonst ist es die portable Exe.
pub fn is_installed() -> bool {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default().to_lowercase();
    std::env::current_exe().map(|p| p.to_string_lossy().to_lowercase().starts_with(&format!("{local}\\programs"))).unwrap_or(false)
}

/// Lädt das Setup, prüft es und startet die stille Installation. Danach muss sich die App beenden.
pub async fn install(info: &UpdateInfo, progress: impl Fn(u64, u64)) -> Result<()> {
    if !info.available || !info.url.starts_with("https://github.com/") { bail!("Kein gültiges Update verfügbar"); }
    let dir = std::env::temp_dir().join("fire-desktop-update");
    tokio::fs::create_dir_all(&dir).await?;
    let file = dir.join(format!("{SETUP_PREFIX}{}.exe", info.latest));
    let res = reqwest::Client::builder().user_agent("Fire-Desktop").build()?.get(&info.url).send().await?.error_for_status()?;
    let total = res.content_length().unwrap_or(info.size);
    let mut out = tokio::fs::File::create(&file).await?;
    let mut hash = Sha256::new();
    let mut done = 0;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        hash.update(&chunk);
        out.write_all(&chunk).await?;
        done += chunk.len() as u64;
        progress(done, total);
    }
    out.flush().await?;
    drop(out);
    if let Some(expected) = &info.sha256 {
        if &hex::encode(hash.finalize()) != expected {
            let _ = std::fs::remove_file(&file);
            bail!("Prüfsumme des Updates stimmt nicht – abgebrochen.");
        }
    }
    std::process::Command::new(&file).args(["/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS"]).spawn()?;
    Ok(())
}
