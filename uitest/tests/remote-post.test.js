// A remote reader must be able to write, not only read: joining a group,
// typing a reply and pressing Send has to reach the file on the PC.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { assert, assertEq, remarkExe } = require('../helpers');

const GW_PORT = 7463;

module.exports = async ctx => {
  const cfg = path.join(ctx.tmp, 'config');
  const doc = ctx.fixture('remote-post.md', [
    '# Remote post',
    '',
    '- [ ] Bouke (2026-09-01 10:00:00): **Ping** <!--thread-->',
    '  is anyone out there',
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
    const mk = await (await fetch(`http://127.0.0.1:7461/api/groups/new?t=${ctx.token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Posters' }),
    })).json();
    await fetch(`http://127.0.0.1:7461/api/groups/doc?t=${ctx.token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: mk.id, path: doc, on: true }),
    });
    const groups = JSON.parse(fs.readFileSync(path.join(cfg, 'remark', 'gateway-groups.json'), 'utf8'));
    const grp = groups.find(g => g.id === mk.id);
    const gtok = grp.id + '.' + grp.key;
    const gu = p => `http://127.0.0.1:${GW_PORT}${p}${p.includes('?') ? '&' : '?'}t=${gtok}`;
    await fetch(gu('/api/group/join'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Edwin' }),
    });

    // the API a save goes through: read, change, write back with the hash
    const got = await (await fetch(gu('/api/file?path=' + encodeURIComponent(doc)))).json();
    const written = got.content.replace('is anyone out there', 'is anyone out there\n\n  - Edwin (2026-09-01 10:05:00): yes, over here');
    const save = await fetch(gu('/api/file'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: doc, baseHash: got.hash, content: written }),
    });
    assertEq(save.status, 200, 'a group member may write the shared document');
    assert(ctx.read(doc).includes('yes, over here'), 'the write reached the file on disk');

    // and the same thing through the UI, which is what a person does
    const page = await ctx.browser.newPage({ viewportSize: { width: 1100, height: 800 } });
    page.errors = [];
    page.on('pageerror', e => page.errors.push(String(e.message)));
    await page.addInitScript(([id]) => {
      localStorage.setItem('remark:prefs:group:' + id, JSON.stringify({ me: 'Edwin' }));
    }, [grp.id]);
    // what a post costs: the verbs send the operation, never the document
    const posts = [];
    page.on('request', q => {
      if (q.method() !== 'POST') return;
      const body = q.postData() || '';
      posts.push({ url: q.url().split('?')[0].replace(/^https?:\/\/[^/]+/, ''), bytes: body.length });
    });
    await page.goto(`http://127.0.0.1:${GW_PORT}/?t=${gtok}&f=${encodeURIComponent(doc)}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.citem', { timeout: 8000 });
    await page.evaluate(() => {
      const root = document.getElementById('r20260901100000');
      if (root.classList.contains('collapsed')) root.querySelector('.chead .twisty').click();
    });
    await page.waitForTimeout(150);
    await page.focus('#r20260901100000 > .cfoot .replyseed');
    await page.waitForSelector('#r20260901100000 > .editor textarea', { timeout: 6000 });
    await page.fill('#r20260901100000 > .editor textarea', 'POSTED-FROM-REMOTE');
    await page.click('#r20260901100000 > .editor button.send');
    await page.waitForTimeout(2000);

    const md = ctx.read(doc);
    const status = await page.evaluate(() => {
      const s = document.getElementById('status');
      return s ? s.textContent.trim() : '';
    });
    assert(md.includes('POSTED-FROM-REMOTE'),
      'a reply typed remotely reached the file (status said "' + status + '", page errors: ' + JSON.stringify(page.errors) + ')');

    const whole = posts.filter(p => p.url === '/api/file');
    const verb = posts.filter(p => p.url === '/api/reply');
    assertEq(whole.length, 0, 'no copy of the document was uploaded: ' + JSON.stringify(posts));
    assertEq(verb.length, 1, 'the reply went as one operation: ' + JSON.stringify(posts));
    assert(verb[0].bytes < 2048, 'the operation is small: ' + verb[0].bytes + ' bytes');

    // marking somebody else's comment read is a write too, and the most
    // frequent one: it must cost its own size, not the document's
    posts.length = 0;
    const markedBefore = ctx.read(doc).includes('seen:Edwin');
    const hasDot = await page.evaluate(() => {
      const dot = document.querySelector('#r20260901100000 > .chead .rdot');
      if (dot) dot.click();
      return !!dot;
    });
    assert(hasDot, 'the comment carries a read-marker control');
    await page.waitForTimeout(1500);
    assertEq(ctx.read(doc).includes('seen:Edwin'), !markedBefore,
      'clicking the marker flipped it in the file');
    assertEq(posts.filter(p => p.url === '/api/file').length, 0,
      'no copy of the document for a read-marker: ' + JSON.stringify(posts));
    assertEq(posts.filter(p => p.url === '/api/seen').length, 1,
      'the read-marker went as one operation: ' + JSON.stringify(posts));
    await page.close();
  } finally {
    gw.kill();
  }
};
