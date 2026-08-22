// N3 dock icon verification v2: minimize via main-process evaluate, verify
// state synchronously, capture, restore.
import { _electron as electron } from 'playwright';
import { execSync } from 'child_process';
import { mkdirSync } from 'fs';

const SHOTS = '/var/folders/90/z_5cnf7j6zx_mdw41mxrp5000000gn/T/opencode/shots';
const USER_DATA = '/var/folders/90/z_5cnf7j6zx_mdw41mxrp5000000gn/T/opencode/ctxfence-userdata-n3';
mkdirSync(SHOTS, { recursive: true });

const app = await electron.launch({
  args: ['.'],
  cwd: '/Users/aditya/Documents/GitHub/mcp-firewall/electron',
  executablePath: '/Users/aditya/Documents/GitHub/mcp-firewall/electron/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  env: { ...process.env, CF_USER_DATA: USER_DATA },
});
app.process().stdout?.on('data', (d) => process.stdout.write(`[app] ${d}`));
const win = await app.firstWindow();
await win.waitForTimeout(4000);
console.log('url:', win.url());

const state = (tag) =>
  app.evaluate(({ BrowserWindow }) => {
    return BrowserWindow.getAllWindows().map((w) => ({
      min: w.isMinimized(),
      vis: w.isVisible(),
      bounds: w.getBounds(),
    }));
  }).then((s) => console.log(tag, JSON.stringify(s)));

await state('before:');
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()));
await win.waitForTimeout(1800);
await state('hidden:');
execSync('screencapture -x /tmp/gp13-dock-clean2.png');
console.log('dock captured');

await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.show()));
await win.waitForTimeout(1000);
await state('restored:');
await app.close();
