const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('fire', {
  listServers: () => ipcRenderer.invoke('servers:list'),
  probeKey: (apiKey, provider, env) => ipcRenderer.invoke('servers:probe', { apiKey, provider, env }),
  addServer: (data) => ipcRenderer.invoke('servers:add', data),
  renameServer: (id, name) => ipcRenderer.invoke('servers:rename', { id, name }),
  removeServer: (id) => ipcRenderer.invoke('servers:remove', id),
  setServerKey: (id, apiKey) => ipcRenderer.invoke('servers:setKey', { id, apiKey }),
  savedSshPass: (id) => ipcRenderer.invoke('servers:sshPass', id),
  reorderServers: (ids) => ipcRenderer.invoke('servers:reorder', ids),
  call: (serverId, method, path, params) =>
    ipcRenderer.invoke('api:call', { serverId, method, path, params }),
  openConsoleWindow: (url, title) => ipcRenderer.invoke('console:open', { url, title }),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  openLegal: (page) => ipcRenderer.invoke('legal:open', page),

  ssh: {
    connect: (opts) => ipcRenderer.invoke('ssh:connect', opts),
    write: (sessionId, data) => ipcRenderer.send('ssh:write', sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send('ssh:resize', sessionId, cols, rows),
    close: (sessionId) => ipcRenderer.send('ssh:close', sessionId),
    forgetHostKeys: (serverId) => ipcRenderer.invoke('ssh:forgetHostKeys', serverId),
    onData: (cb) => ipcRenderer.on('ssh:data', (_e, sessionId, data) => cb(sessionId, data)),
    onClosed: (cb) => ipcRenderer.on('ssh:closed', (_e, sessionId) => cb(sessionId)),
  },

  // Claude-Integration (MCP-Server)
  claude: {
    status: () => ipcRenderer.invoke('claude:status'),
    update: (patch) => ipcRenderer.invoke('claude:update', patch),
    regenToken: () => ipcRenderer.invoke('claude:regenToken'),
    registerCode: () => ipcRenderer.invoke('claude:registerCode'),
    reply: (id, ok) => ipcRenderer.send('claude:confirmReply', id, ok),
    onConfirm: (cb) => ipcRenderer.on('claude:confirm', (_e, req) => cb(req)),
    onConfirmTimeout: (cb) => ipcRenderer.on('claude:confirmTimeout', (_e, id) => cb(id)),
    onActivity: (cb) => ipcRenderer.on('claude:activity', (_e, entry) => cb(entry)),
    onChanged: (cb) => ipcRenderer.on('claude:changed', (_e, st) => cb(st)),
    auditList: (filter) => ipcRenderer.invoke('claude:auditList', filter),
    auditClear: () => ipcRenderer.invoke('claude:auditClear'),
    auditExport: () => ipcRenderer.invoke('claude:auditExport'),
  },

  // App-Updates
  update: {
    version: () => ipcRenderer.invoke('app:version'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onProgress: (cb) => ipcRenderer.on('update:progress', (_e, p) => cb(p)),
  },

  // Minecraft-Server (RCON)
  mc: {
    list: () => ipcRenderer.invoke('mc:list'),
    add: (input) => ipcRenderer.invoke('mc:add', input),
    update: (id, input) => ipcRenderer.invoke('mc:update', id, input),
    remove: (id) => ipcRenderer.invoke('mc:remove', id),
    status: (id) => ipcRenderer.invoke('mc:status', id),
    command: (id, cmd) => ipcRenderer.invoke('mc:command', id, cmd),
    test: (input, existingId) => ipcRenderer.invoke('mc:test', input, existingId),
    connected: (id) => ipcRenderer.invoke('mc:connected', id),
  },

  // Discord Rich Presence
  discord: {
    status: () => ipcRenderer.invoke('discord:status'),
    update: (patch) => ipcRenderer.invoke('discord:update', patch),
    preview: () => ipcRenderer.invoke('discord:preview'),
    setActive: (id) => ipcRenderer.send('discord:active', id),
    onChanged: (cb) => ipcRenderer.on('discord:changed', (_e, st) => cb(st)),
  },

  // SFTP + Befehle (Dateimanager, Nginx)
  remote: {
    open: (opts) => ipcRenderer.invoke('remote:open', opts),
    close: (rid) => ipcRenderer.invoke('remote:close', rid),
    alive: (rid) => ipcRenderer.invoke('remote:alive', rid),
    exec: (rid, cmd, timeout = 120000) => ipcRenderer.invoke('remote:exec', rid, cmd, timeout),
  },
  fs: {
    list: (rid, dir) => ipcRenderer.invoke('fs:list', rid, dir),
    read: (rid, file) => ipcRenderer.invoke('fs:read', rid, file),
    write: (rid, file, text) => ipcRenderer.invoke('fs:write', rid, file, text),
    mkdir: (rid, dir) => ipcRenderer.invoke('fs:mkdir', rid, dir),
    touch: (rid, file) => ipcRenderer.invoke('fs:touch', rid, file),
    rename: (rid, from, to) => ipcRenderer.invoke('fs:rename', rid, from, to),
    chmod: (rid, file, mode) => ipcRenderer.invoke('fs:chmod', rid, file, mode),
    remove: (rid, paths) => ipcRenderer.invoke('fs:delete', rid, paths),
    upload: (rid, dir, localPaths, tid) => ipcRenderer.invoke('fs:upload', rid, dir, localPaths, tid),
    pickUpload: (kind) => ipcRenderer.invoke('fs:pickUpload', kind),
    download: (rid, paths, tid) => ipcRenderer.invoke('fs:download', rid, paths, tid),
    cancel: (tid) => ipcRenderer.invoke('fs:cancel', tid),
    showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
    pathForFile: (file) => webUtils.getPathForFile(file),
    onProgress: (cb) => ipcRenderer.on('fs:progress', (_e, p) => cb(p)),
  },
});
