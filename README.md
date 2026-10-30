# Fire Desktop

Desktop-App (Electron) zur Verwaltung von 24fire-KVM-Servern über die [24fire REST API](https://docs.24fire.de). Inoffiziell, kein Produkt der 24fire GmbH.

## Download

Unter [Releases](https://github.com/fojadrachi/Fire-Desktop/releases) gibt es:

- `Fire-Desktop-Setup-x.y.z.exe`: Installer mit automatischen Updates (empfohlen)
- `Fire-Desktop-Portable-x.y.z.exe`: ohne Installation, ohne Selbst-Update

## Funktionen

- **Server per API-Token hinzufügen:** Token aus `cp.24fire.de` → Kontoeinstellungen → API-Keys. Die App listet deine KVM-Server, du wählst aus.
- **Übersicht:** Live-Status, CPU/RAM/NVMe, Traffic, Konfiguration, IPs, Hostsystem
- **Konsole:** SSH-Terminal direkt in der App, dazu noVNC im eigenen Fenster
- **Dateien:** SFTP-Dateimanager mit Upload, Download, Editor und Fortschrittsanzeige (Tempo, Restzeit, Abbrechen)
- **Nginx:** Sites verwalten und anlegen, jede Änderung wird vorher mit `nginx -t` geprüft
- **Statistiken und Backups**
- **Minecraft:** Server per RCON steuern, direkt oder durch einen SSH-Tunnel
- **Claude-Zugriff:** lokaler MCP-Server für Claude Code mit Rechten pro Server, Bestätigung in der App und dauerhaftem Protokoll
- **Discord-Status:** Rich Presence mit eigenen Live-Stats
- **Updates:** prüft GitHub-Releases, lädt das Setup, kontrolliert die SHA-256-Prüfsumme und installiert still

Das Root-Passwort gibt die neue 24fire-API nicht mehr heraus. Trage es einmal in der Konsole unter „Zugangsdaten“ ein, danach merkt sich die App es verschlüsselt.

## Entwickeln

```
npm install
npm start
```

Bauen: `npm run dist` → `dist/` (Setup und portable Version).

## Sicherheit

API-Tokens und Passwörter werden mit Windows-DPAPI (Electron `safeStorage`) verschlüsselt in `%APPDATA%\Fire Desktop\servers.json` gespeichert. Nur der Hauptprozess schickt sie an die API, die Oberfläche sieht sie nicht.
