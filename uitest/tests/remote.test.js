// remote (group) viewers: pasting images is allowed within the group's
// documents, everything else stays fenced, the Phone button is a green
// connection light, and external links open in the reader's own browser
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { assert, assertEq, remarkExe } = require('../helpers');

const GW_PORT = 7462;

module.exports = async ctx => {
  const cfg = path.join(ctx.tmp, 'config');
  const doc = ctx.fixture('remote.md', [
    '# Remote',
    '',
    'Visit [the site](https://example.com/page) for more.',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **T** opening <!--thread-->',
    '',
  ].join('\n'));

  const gw = spawn(remarkExe(), ['gateway'], {
    env: { ...process.env, APPDATA: cfg, XDG_CONFIG_HOME: cfg, REMARK_GATEWAY_PORT: String(GW_PORT) },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(`http://127.0.0.1:${GW_PORT}/`)).status) break; } catch (e) { }
      await new Promise(r => setTimeout(r, 250));
    }
    // a group with the fixture doc, created through the serve API (shared config)
    const mk = await (await fetch(`http://127.0.0.1:7461/api/groups/new?t=${ctx.token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Testers' }),
    })).json();
    await fetch(`http://127.0.0.1:7461/api/groups/doc?t=${ctx.token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: mk.id, path: doc, on: true }),
    });
    const groups = JSON.parse(fs.readFileSync(path.join(cfg, 'remark', 'gateway-groups.json'), 'utf8'));
    const grp = groups.find(g => g.id === mk.id); // other tests add groups too
    const gtok = grp.id + '.' + grp.key;
    const gu = p => `http://127.0.0.1:${GW_PORT}${p}${p.includes('?') ? '&' : '?'}t=${gtok}`;

    // image paste is allowed within the group's documents
    const img = await fetch(gu('/api/image?path=' + encodeURIComponent(doc) + '&ext=png'), {
      method: 'POST', body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    assertEq(img.status, 200, 'image paste allowed for group members');

    // the fences hold
    assertEq((await fetch(gu('/api/prefs'), { method: 'POST', body: '{}' })).status, 403, 'prefs stay read-only');
    assertEq((await fetch(gu('/api/openwith?path=' + encodeURIComponent(doc)), { method: 'POST' })).status, 403, 'openwith refused remotely');
    assertEq((await fetch(gu('/api/file?path=' + encodeURIComponent(path.join(ctx.tmp, 'seed.md'))))).status, 403, 'foreign docs refused');

    // in the browser: connection light on, external links open locally
    await fetch(gu('/api/group/join'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Edwin' }),
    });
    const page = await ctx.browser.newPage({ viewportSize: { width: 1100, height: 800 } });
    await page.addInitScript(([id]) => {
      localStorage.setItem('remark:prefs:group:' + id, JSON.stringify({ me: 'Edwin' }));
      window.__opened = [];
      window.open = u => { window.__opened.push(u); return null; };
    }, [grp.id]);
    await page.goto(`http://127.0.0.1:${GW_PORT}/?t=${gtok}&f=${encodeURIComponent(doc)}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.citem', { timeout: 8000 });
    const badge = await page.evaluate(() => {
      const b = document.getElementById('gatewayBtn');
      return { remote: b && b.classList.contains('remote'), title: b && b.title };
    });
    assert(badge.remote, 'Phone button is the remote connection light');
    await page.evaluate(() => document.querySelector('#doc a[href^="https:"]').click());
    const opened = await page.evaluate(() => window.__opened);
    assertEq(opened[0], 'https://example.com/page', 'external link opens in the reader\'s browser');
    await page.close();
  } finally {
    try { gw.kill(); } catch (e) { }
  }
};
