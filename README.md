# Fire Desktop

Native Desktop-App (Rust + Slint) zur Verwaltung von 24fire-KVM-Servern über die [24fire REST API](https://docs.24fire.de). Inoffiziell, kein Produkt der 24fire GmbH.

## Download

Unter [Releases](https://github.com/fojadrachi/Fire-Desktop/releases) gibt es:

- `Fire-Desktop-Setup-x.y.z.exe`: Installer mit automatischen Updates (empfohlen)
- `Fire-Desktop-x.y.z-win-x64.exe`: portable Exe ohne Installation

## Funktionen

- **Server per API-Token hinzufügen:** Token aus `cp.24fire.de` → Kontoeinstellungen → API-Keys
- **Übersicht:** Live-Status, CPU/RAM/NVMe, Traffic, Konfiguration, IPs, Hostsystem
- **Konsole:** SSH-Terminal in der App, dazu noVNC im Browser
- **Dateien:** SFTP-Dateimanager mit Upload, Download, Editor und Fortschritt (Tempo, Restzeit, Abbrechen)
- **Nginx:** Sites verwalten und anlegen, jede Änderung wird vorher mit `nginx -t` geprüft
- **Statistiken, Backups, API-Konsole**
- **Minecraft:** Server per RCON steuern, direkt oder durch einen SSH-Tunnel
- **Claude-Zugriff:** lokaler MCP-Server für Claude Code mit Rechten pro Server, Bestätigung in der App und dauerhaftem Protokoll
- **Discord-Status:** Rich Presence mit Live-Stats
- **Updates:** prüft GitHub-Releases, lädt das Setup, kontrolliert die SHA-256-Prüfsumme und installiert still

Das Root-Passwort gibt die 24fire-API nicht heraus. Trage es einmal in der Konsole unter „Zugangsdaten“ ein, danach merkt sich die App es verschlüsselt.

## Entwickeln

```
cargo run
```

Release bauen: `.\build-release.ps1` (braucht Inno Setup 6) → `dist\`

## Sicherheit

Tokens und Passwörter liegen mit Windows-DPAPI verschlüsselt in `%APPDATA%\Fire Desktop\servers.json`. Daten der früheren Electron-Version werden übernommen.
