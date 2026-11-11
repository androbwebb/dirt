// Dev runner: Vite dev server + Electron pointed at it, with HMR for the UI.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electronPath from 'electron';

const vite = await createServer({ server: { port: 5199, strictPort: true } });
await vite.listen();
const url = vite.resolvedUrls.local[0];
console.log(`\n  DIRT dev ▸ ${url}\n`);

const child = spawn(electronPath, ['.'], { stdio: 'inherit', env: { ...process.env, DIRT_DEV_URL: url } });
child.on('exit', async (code) => {
  await vite.close();
  process.exit(code ?? 0);
});
