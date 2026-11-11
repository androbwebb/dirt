// README screenshot capture. Only runs when DIRT_SCREENSHOTS=<dir> is set:
// drives the real UI (home → /Applications scan → What is this? → Ask → Settings)
// and saves PNGs. Uses generic locations so no personal project names appear.
import fsp from 'node:fs/promises';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function captureScreens(win, outDir, app) {
  await fsp.mkdir(outDir, { recursive: true });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const waitFor = async (sel, ms = 60_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await js(`!!document.querySelector(${JSON.stringify(sel)})`)) return true;
      await sleep(300);
    }
    throw new Error(`Timed out waiting for ${sel}`);
  };
  const click = (sel) => js(`document.querySelector(${JSON.stringify(sel)})?.click(); true`);
  const shot = async (name) => {
    await sleep(900);
    const img = await win.webContents.capturePage();
    await fsp.writeFile(path.join(outDir, name), img.toPNG());
    console.log('captured', name);
  };

  const only = process.env.DIRT_SCREENSHOTS_ONLY;
  try {
    // DIRT reopens the last scan at launch; start from home.
    await waitFor('#logo');
    await sleep(800);
    await click('#logo');
    await waitFor('.vol-grid');
    if (only === 'settings') {
      await click('#settings-btn');
      await waitFor('.fam', 30_000);
      await js(`(() => { const k = document.querySelector('.key-saved-val'); if (k) k.textContent = 'sk-or-••••••••••••••••'; return true; })()`);
      await shot('settings.png');
      return;
    }
    await js('window.scrollTo(0, 0); true');
    await shot('home.png');

    // Scan /Applications (or open its cached result).
    await click('[data-scan="/Applications"], [data-goto="/Applications"]');
    await waitFor('.results .arc', 180_000);
    await sleep(1500);
    await js(`(() => { const r = document.querySelectorAll('#rows .row')[0]; r?.dispatchEvent(new PointerEvent('pointerenter')); return true; })()`);
    await shot('results.png');
    await js(`(() => { const r = document.querySelectorAll('#rows .row')[0]; r?.dispatchEvent(new PointerEvent('pointerleave')); return true; })()`);

    // "What is this?" on the biggest app.
    await click('#rows .row [data-act="ask"]');
    await waitFor('.verdict, .ai-error', 90_000);
    await shot('what-is-this.png');
    await click('.ai-x');

    // Ask DIRT agent with a generic question.
    await click('#ask-btn');
    await waitFor('#ask-input');
    await js(`(() => { const i = document.getElementById('ask-input'); i.value = 'Which apps in /Applications are biggest, and which have I not opened in 6 months?'; document.getElementById('ask-form').requestSubmit(); return true; })()`);
    await waitFor('.rp, .turn-err', 240_000);
    await js(`document.querySelector('.rp')?.scrollIntoView({ block: 'start' }); true`);
    await shot('ask.png');

    // Settings.
    await click('#settings-btn');
    await waitFor('.fam', 30_000);
    // Never show any part of the API key in screenshots.
    await js(`(() => { const k = document.querySelector('.key-saved-val'); if (k) k.textContent = 'sk-or-••••••••••••••••'; return true; })()`);
    await shot('settings.png');
  } catch (e) {
    console.error('screenshot run failed:', e.message);
  } finally {
    app.quit();
  }
}
