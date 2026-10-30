// Setzt das App-Icon in die entpackte Fire Desktop.exe.
// electron-builders eigenes rcedit ist abgeschaltet (signAndEditExecutable: false),
// weil dessen Download unter Windows ohne Admin-Rechte an Symlinks scheitert.
const path = require('path');
const rceditModule = require('rcedit');
const rcedit = rceditModule.rcedit || rceditModule.default || rceditModule;

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  await rcedit(exe, {
    icon: path.join(__dirname, 'icon.ico'),
    'version-string': {
      ProductName: 'Fire Desktop',
      FileDescription: 'Fire Desktop – 24fire Server-Verwaltung',
      CompanyName: 'Fojadrachi',
    },
    'file-version': context.packager.appInfo.version,
    'product-version': context.packager.appInfo.version,
  });
};
