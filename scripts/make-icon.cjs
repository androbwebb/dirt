// Renders the app icon (brutalist yellow tile with a big "D") using the app's own
// Archivo font, then builds build/icon.icns. Run: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'build');
const FONT = path.join(ROOT, 'node_modules/@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2');

// Full-bleed square: macOS 26 applies its own rounded mask. Icons with their own
// transparent margins/corners get boxed into a gray tile, so fill edge to edge.
const html = `<!doctype html><html><head><style>
@font-face { font-family: 'Archivo'; src: url('file://${FONT}') format('woff2'); font-weight: 100 900; font-stretch: 62% 125%; }
html, body { margin: 0; width: 1024px; height: 1024px; overflow: hidden; background: #ffd60a; }
.tile { position: absolute; inset: 0; background: #ffd60a; display: flex; align-items: center; justify-content: center; }
.stripe {
  position: absolute; left: 0; right: 0; bottom: 0; height: 170px;
  border-top: 34px solid #0d0d0d;
  background: repeating-linear-gradient(-45deg, #0d0d0d 0 36px, #ffd60a 36px 80px);
}
.d {
  font-family: 'Archivo'; font-weight: 900; font-stretch: 62%;
  font-size: 860px; line-height: 1; color: #0d0d0d;
  transform: translate(-6px, -78px);
  text-shadow: 22px 22px 0 rgba(13, 13, 13, 0.18);
}
</style></head><body>
<div class="tile"><div class="d">D</div><div class="stripe"></div></div>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    backgroundColor: '#ffd60a',
    webPreferences: { offscreen: true },
  });
  const tmp = path.join(app.getPath('temp'), 'dirt-icon.html');
  fs.writeFileSync(tmp, html);
  await win.loadFile(tmp);
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => document.fonts.check("900 100px Archivo"))');
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const png = img.resize({ width: 1024, height: 1024 }).toPNG();

  fs.mkdirSync(OUT, { recursive: true });
  const master = path.join(OUT, 'icon.png');
  fs.writeFileSync(master, png);

  // Build the .iconset and .icns with macOS tools.
  const set = path.join(app.getPath('temp'), 'dirt.iconset');
  fs.rmSync(set, { recursive: true, force: true });
  fs.mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    execFileSync('sips', ['-z', String(s), String(s), master, '--out', path.join(set, `icon_${s}x${s}.png`)], { stdio: 'ignore' });
    execFileSync('sips', ['-z', String(s * 2), String(s * 2), master, '--out', path.join(set, `icon_${s}x${s}@2x.png`)], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(OUT, 'icon.icns')]);
  console.log('wrote build/icon.png and build/icon.icns');
  app.quit();
});
