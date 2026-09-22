// Shared plumbing for the headless UI tests: a hidden `remark -serve` on an
// isolated config dir (your real prefs are never read or written), driven by
// the system's Edge in headless mode via playwright-core. Nothing ever takes
// the mouse or shows a window.
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 7461;
const TOKEN = 'uitest';

function edgePath() {
  if (process.env.EDGE_PATH) return process.env.EDGE_PATH;
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('no Edge/Chrome found — set EDGE_PATH');
}

function remarkExe() {
  if (process.env.REMARK_EXE) return process.env.REMARK_EXE;
  const local = path.join(__dirname, '..', process.platform === 'win32' ? 'remark.exe' : 'remark');
  if (fs.existsSync(local)) return local;
  throw new Error('no remark binary next to uitest/ — run `task build` first');
}

async function start() {
  // fresh temp area per run: fixtures live here, and the config dir env
  // vars point the server's prefs, presence and gateway files here too
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remark-uitest-'));
  const cfg = path.join(tmp, 'config');
  fs.mkdirSync(path.join(cfg, 'remark'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'remark', 'prefs.json'), '{"me":"Me"}');

  const seed = path.join(tmp, 'seed.md');
  fs.writeFileSync(seed, '# Seed\n\nempty seed document.\n');
  const server = spawn(remarkExe(), ['-serve', '-port', String(PORT), '-token', TOKEN, seed], {
    env: { ...process.env, APPDATA: cfg, XDG_CONFIG_HOME: cfg },
    stdio: 'ignore',
    detached: false,
  });

  // wait for the port
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/uiready?t=${TOKEN}`);
      if (r.status < 500) break;
    } catch (e) { /* not up yet */ }
    await new Promise(res => setTimeout(res, 250));
  }

  const browser = await chromium.launch({ headless: true, executablePath: edgePath() });

  return {
    tmp,
    browser,
    server,
    token: TOKEN,
    // write a fixture file; returns its absolute path
    fixture(name, content) {
      const p = path.join(tmp, name);
      fs.writeFileSync(p, content);
      return p;
    },
    read(p) { return fs.readFileSync(p, 'utf8'); },
    write(p, content) { fs.writeFileSync(p, content); },
    url(p) { return `http://127.0.0.1:${PORT}/?t=${TOKEN}&f=${encodeURIComponent(p)}`; },
    // a fresh page on a fixture, waited until comments render
    async open(p, opts) {
      const page = await browser.newPage({ viewportSize: { width: 1100, height: 800 } });
      page.errors = [];
      page.on('pageerror', e => page.errors.push(String(e.message)));
      await page.goto(this.url(p), { waitUntil: 'networkidle' });
      if (!opts || !opts.noComments) await page.waitForSelector('.citem', { timeout: 8000 });
      return page;
    },
    async stop() {
      // a gateway the suite started outlives the server that spawned it, and
      // three of them accumulated across runs are enough to fail sharepanel
      // for reasons that have nothing to do with the code under test. Ask
      // this run's own server to stop it — never search the machine for
      // "remark gateway", which would take down the one the human is using.
      try {
        await fetch(`http://127.0.0.1:${PORT}/api/gateway/stop?t=${TOKEN}`, { method: 'POST' });
      } catch (e) { /* no gateway, or the server is already gone */ }
      try { await browser.close(); } catch (e) { }
      try { server.kill(); } catch (e) { }
      // give the process a beat to let go of the tmp dir, then clean up
      await new Promise(res => setTimeout(res, 300));
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    },
  };
}

function assert(cond, msg) {
  if (!cond) throw new Error('assert failed: ' + msg);
}
function assertEq(got, want, msg) {
  if (got !== want) throw new Error(`${msg}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// The port a spawned gateway actually took. Windows reserves whole blocks of
// ports (Hyper-V and WSL, and the blocks move on every reboot), so a hard-coded
// port can become unbindable overnight — the gateway then picks a free one and
// records it. Read the record instead of assuming.
async function gatewayPort(cfgDir, hinted) {
  const rec = require('path').join(cfgDir, 'remark', 'gateway.json');
  const fs = require('fs');
  for (let i = 0; i < 80; i++) {
    try {
      const port = JSON.parse(fs.readFileSync(rec, 'utf8')).port;
      if (port) {
        // it is listening once it answers, not merely once it has written
        try { if ((await fetch(`http://127.0.0.1:${port}/`)).status) return port; } catch (e) { }
      }
    } catch (e) { }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('the gateway never came up (hinted port ' + hinted + ')');
}

module.exports = { start, assert, assertEq, remarkExe, gatewayPort };
