// a group member's landing refreshes itself when the owner shares a new
// document — it appears without the member touching anything
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { assert, remarkExe } = require('../helpers');

const GW_PORT = 7463;

module.exports = async ctx => {
  const cfg = path.join(ctx.tmp, 'config');
  const doc = ctx.fixture('landing-refresh.md', '# Fresh Document\n\ncontent.\n');
  const gw = spawn(remarkExe(), ['gateway'], {
    env: { ...process.env, APPDATA: cfg, XDG_CONFIG_HOME: cfg, REMARK_GATEWAY_PORT: String(GW_PORT) },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(`http://127.0.0.1:${GW_PORT}/`)).status) break; } catch (e) { }
      await new Promise(r => setTimeout(r, 250));
    }
    const mk = await (await fetch(`http://127.0.0.1:7461/api/groups/new?t=${ctx.token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Watchers' }),
    })).json();
    const groups = JSON.parse(fs.readFileSync(path.join(cfg, 'remark', 'gateway-groups.json'), 'utf8'));
    const g = groups.find(x => x.id === mk.id);
    const gtok = g.id + '.' + g.key;
    await fetch(`http://127.0.0.1:${GW_PORT}/api/group/join?t=${gtok}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Anna' }),
    });
    const page = await ctx.browser.newPage({ viewportSize: { width: 1100, height: 800 } });
    await page.addInitScript(([id]) => {
      localStorage.setItem('remark:prefs:group:' + id, JSON.stringify({ me: 'Anna' }));
    }, [g.id]);
    await page.goto(`http://127.0.0.1:${GW_PORT}/?t=${gtok}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#recent h3', { timeout: 8000 });
    const empty = await page.evaluate(() => document.querySelectorAll('#recent a').length);
    assert(empty === 0, 'nothing shared yet');

    // the owner shares a document; the member's landing picks it up alone
    await fetch(`http://127.0.0.1:7461/api/groups/doc?t=${ctx.token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: g.id, path: doc, on: true }),
    });
    await page.waitForSelector('#recent a', { timeout: 12000 });
    const name = await page.evaluate(() => document.querySelector('#recent a .rname').textContent);
    assert(name.length > 0, 'the new document appeared by itself: ' + name);
    await page.close();
  } finally {
    try { gw.kill(); } catch (e) { }
  }
};
