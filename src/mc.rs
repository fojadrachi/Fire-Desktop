//! Minecraft: Server List Ping (Status) und RCON – über TCP oder einen beliebigen Stream (SSH-Tunnel).

use anyhow::{anyhow, bail, Result};
use serde_json::Value;
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::time::timeout;

pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}
pub type BoxStream = Box<dyn Stream>;

// ---------- Server List Ping ----------

#[derive(Clone, Debug, Default)]
pub struct Ping {
    pub version: String,
    pub online: i64,
    pub max: i64,
    pub sample: Vec<String>,
    pub motd: String,
    pub latency: u128,
    pub favicon: Option<Vec<u8>>,
}

fn var_int(mut v: u32, out: &mut Vec<u8>) {
    loop {
        let mut b = (v & 0x7f) as u8;
        v >>= 7;
        if v != 0 { b |= 0x80; }
        out.push(b);
        if v == 0 { break; }
    }
}

async fn read_var_int(s: &mut BoxStream) -> Result<u32> {
    let (mut value, mut shift) = (0u32, 0);
    loop {
        let b = s.read_u8().await?;
        value |= ((b & 0x7f) as u32) << shift;
        if b & 0x80 == 0 { return Ok(value); }
        shift += 7;
        if shift > 28 { bail!("Ungültige Status-Antwort"); }
    }
}

fn packet(id: u32, payload: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    var_int(id, &mut body);
    body.extend_from_slice(payload);
    let mut out = Vec::new();
    var_int(body.len() as u32, &mut out);
    out.extend(body);
    out
}

const COLORS: &[(&str, char)] = &[("black", '0'), ("dark_blue", '1'), ("dark_green", '2'), ("dark_aqua", '3'), ("dark_red", '4'), ("dark_purple", '5'), ("gold", '6'), ("gray", '7'), ("dark_gray", '8'), ("blue", '9'), ("green", 'a'), ("aqua", 'b'), ("red", 'c'), ("light_purple", 'd'), ("yellow", 'e'), ("white", 'f')];

/// Chat-Komponente in Text mit §-Codes.
fn chat(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(chat).collect(),
        Value::Object(_) => {
            let mut s = String::new();
            if let Some((_, c)) = COLORS.iter().find(|(n, _)| v["color"].as_str() == Some(n)) {
                s.push('§');
                s.push(*c);
            }
            if v["bold"] == true { s.push_str("§l"); }
            s.push_str(v["text"].as_str().or(v["translate"].as_str()).unwrap_or(""));
            if let Some(e) = v["extra"].as_array() { s.extend(e.iter().map(chat)); }
            s
        }
        _ => String::new(),
    }
}

pub async fn ping(mut s: BoxStream, host: &str, port: u16) -> Result<Ping> {
    let started = Instant::now();
    timeout(Duration::from_secs(8), async {
        let mut hs = Vec::new();
        var_int(767, &mut hs);
        var_int(host.len() as u32, &mut hs);
        hs.extend_from_slice(host.as_bytes());
        hs.extend_from_slice(&port.to_be_bytes());
        var_int(1, &mut hs);
        s.write_all(&packet(0, &hs)).await?;
        s.write_all(&packet(0, &[])).await?;
        s.flush().await?;
        read_var_int(&mut s).await?;
        read_var_int(&mut s).await?;
        let len = read_var_int(&mut s).await? as usize;
        if len > 1 << 22 { bail!("Status-Antwort zu groß"); }
        let mut buf = vec![0u8; len];
        s.read_exact(&mut buf).await?;
        let j: Value = serde_json::from_slice(&buf)?;
        Ok(Ping {
            version: j["version"]["name"].as_str().unwrap_or("?").to_string(),
            online: j["players"]["online"].as_i64().unwrap_or(0),
            max: j["players"]["max"].as_i64().unwrap_or(0),
            sample: j["players"]["sample"].as_array().into_iter().flatten().filter_map(|p| p["name"].as_str().map(String::from)).collect(),
            motd: chat(&j["description"]),
            latency: started.elapsed().as_millis(),
            favicon: j["favicon"].as_str().and_then(|f| f.split_once(',')).and_then(|(_, b)| {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD.decode(b.trim()).ok()
            }),
        })
    }).await.map_err(|_| anyhow!("Keine Status-Antwort (Zeitüberschreitung)"))?
}

// ---------- RCON ----------

const AUTH: i32 = 3;
const COMMAND: i32 = 2;

pub struct Rcon {
    s: BoxStream,
    next: i32,
}

impl Rcon {
    async fn send(&mut self, id: i32, kind: i32, body: &str) -> Result<()> {
        let mut p = Vec::with_capacity(14 + body.len());
        p.extend_from_slice(&((10 + body.len()) as i32).to_le_bytes());
        p.extend_from_slice(&id.to_le_bytes());
        p.extend_from_slice(&kind.to_le_bytes());
        p.extend_from_slice(body.as_bytes());
        p.extend_from_slice(&[0, 0]);
        self.s.write_all(&p).await?;
        self.s.flush().await?;
        Ok(())
    }

    async fn recv(&mut self) -> Result<(i32, i32, String)> {
        let len = self.s.read_i32_le().await?;
        if !(10..=(1 << 20)).contains(&len) { bail!("Ungültiges RCON-Paket"); }
        let mut buf = vec![0u8; len as usize];
        self.s.read_exact(&mut buf).await?;
        let id = i32::from_le_bytes(buf[0..4].try_into()?);
        let kind = i32::from_le_bytes(buf[4..8].try_into()?);
        Ok((id, kind, String::from_utf8_lossy(&buf[8..buf.len() - 2]).into_owned()))
    }

    pub async fn login(s: BoxStream, password: &str) -> Result<Rcon> {
        let mut r = Rcon { s, next: 1 };
        timeout(Duration::from_secs(8), async {
            r.send(0, AUTH, password).await?;
            loop {
                let (id, kind, _) = r.recv().await?;
                if kind == 2 {
                    if id == -1 { bail!("RCON-Passwort falsch"); }
                    return Ok(());
                }
            }
        }).await.map_err(|_| anyhow!("RCON antwortet nicht (Zeitüberschreitung) – ist enable-rcon=true gesetzt?"))??;
        Ok(r)
    }

    /// Lange Antworten kommen in mehreren Paketen, daher ein Leer-Paket als Endmarke hinterher.
    pub async fn command(&mut self, cmd: &str) -> Result<String> {
        let (id, end) = (self.next, self.next + 1);
        self.next += 2;
        self.send(id, COMMAND, cmd.trim_start_matches('/')).await?;
        self.send(end, 0, "").await?;
        let mut out = String::new();
        timeout(Duration::from_secs(10), async {
            loop {
                let (pid, _, body) = self.recv().await?;
                if pid == id { out.push_str(&body); }
                if pid == end { return Ok::<_, anyhow::Error>(()); }
            }
        }).await.map_err(|_| anyhow!("RCON-Antwort blieb aus"))??;
        Ok(out)
    }
}

/// Entfernt §-Formatcodes.
pub fn strip(t: &str) -> String {
    let mut out = String::with_capacity(t.len());
    let mut it = t.chars();
    while let Some(c) = it.next() {
        if c == '§' { it.next(); } else { out.push(c); }
    }
    out
}

pub struct ListResult {
    pub online: i64,
    pub max: i64,
    pub names: Vec<String>,
}

/// Wertet die Ausgabe von `list` aus (Vanilla und Paper).
pub fn parse_list(out: &str) -> ListResult {
    let text = strip(out);
    let nums: Vec<i64> = text.split(|c: char| !c.is_ascii_digit()).filter_map(|x| x.parse().ok()).collect();
    let mut names = Vec::new();
    for line in text.lines() {
        if let Some((_, rest)) = line.rsplit_once(':') {
            for n in rest.split(',') {
                let n = n.trim();
                if (2..=16).contains(&n.len()) && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !names.iter().any(|x| x == n) {
                    names.push(n.to_string());
                }
            }
        }
    }
    ListResult { online: nums.first().copied().unwrap_or(names.len() as i64), max: nums.get(1).copied().unwrap_or(0), names }
}

/// Text mit §-Codes in formatierte Zeilen: je Zeile Abschnitte (Text, Farbe, fett). Lange Zeilen werden umbrochen.
pub fn styled(text: &str, base: (u8, u8, u8), wrap: usize) -> Vec<Vec<(String, (u8, u8, u8), bool)>> {
    const C: [(u8, u8, u8); 16] = [(0, 0, 0), (0, 0, 170), (0, 170, 0), (0, 170, 170), (170, 0, 0), (170, 0, 170), (255, 170, 0), (170, 170, 170), (85, 85, 85), (85, 85, 255), (85, 255, 85), (85, 255, 255), (255, 85, 85), (255, 85, 255), (255, 255, 85), (255, 255, 255)];
    let (mut color, mut bold) = (base, false);
    let mut out = Vec::new();
    for l in text.split('\n') {
        let mut row: Vec<(String, (u8, u8, u8), bool)> = Vec::new();
        let mut n = 0;
        let mut it = l.chars();
        while let Some(c) = it.next() {
            if c == '§' {
                match it.next().map(|x| x.to_ascii_lowercase()) {
                    Some(h) if h.is_ascii_hexdigit() => { color = C[h.to_digit(16).unwrap_or(15) as usize]; bold = false; }
                    Some('l') => bold = true,
                    Some('r') => { color = base; bold = false; }
                    _ => {}
                }
                continue;
            }
            if n >= wrap { out.push(std::mem::take(&mut row)); n = 0; }
            match row.last_mut() {
                Some(r) if r.1 == color && r.2 == bold => r.0.push(c),
                _ => row.push((c.to_string(), color, bold)),
            }
            n += 1;
        }
        out.push(row);
    }
    out
}
