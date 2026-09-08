// the Phone panel: flat share toggles for Myself and each group above the
// fold, group management behind its own fold
const fs = require('fs');
const path = require('path');
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('sharepanel.md', [
    '# Share Panel',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **T** opening <!--thread-->',
    '',
  ].join('\n'));
  await fetch(`http://127.0.0.1:7461/api/groups/new?t=${ctx.token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Panelists' }),
  });
  const page = await ctx.open(doc);
  await page.evaluate(() => document.getElementById('gatewayBtn').click());
  await page.waitForSelector('#gwpanel .gwshare', { timeout: 6000 });
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('#gwpanel .gwshare .gwlabel')].map(x => x.textContent));
  assert(rows[0] === 'My devices', 'first toggle is My devices, got ' + JSON.stringify(rows));
  assert(rows.includes('Panelists'), 'each group has its own toggle');

  // flipping the group toggle registers the document with the group
  await page.evaluate(() => {
    const rows2 = [...document.querySelectorAll('#gwpanel .gwshare')];
    const target = rows2.find(r => r.querySelector('.gwlabel').textContent === 'Panelists');
    target.querySelector('input').click();
  });
  await page.waitForTimeout(1200);
  const cfg = path.join(ctx.tmp, 'config');
  const groups = JSON.parse(fs.readFileSync(path.join(cfg, 'remark', 'gateway-groups.json'), 'utf8'));
  const grp = groups.find(g => g.name === 'Panelists');
  assert(grp.docs.some(d => d.toLowerCase() === doc.toLowerCase()), 'toggle put the document in the group');

  // flipping the switch on also started the gateway: the button goes green
  const green = await page.evaluate(() => ({
    on: document.getElementById('gatewayBtn').classList.contains('on'),
    head: document.querySelector('#gwpanel .gwhead b').textContent,
  }));
  assert(green.on, 'shared + running gateway shows green');
  assert(green.head === 'Sharing', 'the panel is called Sharing, got ' + green.head);

  // stop the gateway while the document stays shared: the button turns red
  await fetch(`http://127.0.0.1:7461/api/gateway/stop?t=${ctx.token}`, { method: 'POST' });
  await page.waitForTimeout(400);
  await page.evaluate(() => document.getElementById('gatewayBtn').click()); // close…
  await page.evaluate(() => document.getElementById('gatewayBtn').click()); // …reopen, fresh state
  await page.waitForSelector('#gwpanel .gwshare', { timeout: 6000 });
  await page.waitForTimeout(300);
  const red = await page.evaluate(() => {
    const b = document.getElementById('gatewayBtn');
    return { warn: b.classList.contains('warn'), on: b.classList.contains('on') };
  });
  assert(red.warn && !red.on, 'shared + stopped gateway shows the red state');

  // management is a fold of its own
  await page.evaluate(() => {
    const folds = [...document.querySelectorAll('#gwpanel .gwmore')];
    folds.find(f => f.textContent.includes('Groups')).click();
  });
  await page.waitForSelector('#gwpanel .ggroup', { timeout: 4000 });
  const managed = await page.evaluate(() =>
    [...document.querySelectorAll('#gwpanel .ggroup .ghead b')].map(x => x.textContent));
  assert(managed.includes('Panelists'), 'the Groups fold lists the group, got ' + JSON.stringify(managed));

  // with every fold and group open, the panel never grows past the screen —
  // its body scrolls instead of clipping, zoom included (the cap is
  // computed in px because 100vh misbehaves inside a zoomed body)
  await page.setViewportSize({ width: 1100, height: 420 });
  await page.evaluate(() => {
    setZoom(1.5);
    document.getElementById('gatewayBtn').click(); // close…
    document.getElementById('gatewayBtn').click(); // …reopen at the new zoom
  });
  await page.waitForSelector('#gwpanel .gwshare', { timeout: 4000 });
  await page.evaluate(() => {
    for (const f of document.querySelectorAll('#gwpanel .gwmore')) if (f.querySelector('.ic.closed')) f.click();
    const gh = document.querySelector('#gwpanel .ggroup .ghead');
    if (gh) gh.click();
  });
  await page.waitForTimeout(400);
  const cap = await page.evaluate(() => {
    const panel = document.getElementById('gwpanel');
    const body2 = panel.querySelector('.gwbody');
    return {
      bottom: Math.round(panel.getBoundingClientRect().bottom),
      vh: innerHeight,
      scrolls: body2.scrollHeight > body2.clientHeight + 1,
    };
  });
  assert(cap.bottom <= cap.vh, `panel fits the screen (bottom ${cap.bottom} vs ${cap.vh})`);
  assert(cap.scrolls, 'the body scrolls the overflow');
  assertEq(page.errors.length, 0, 'no page errors: ' + page.errors.join(' | '));
  await page.close();
};
