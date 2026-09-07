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
  assert(rows[0] === 'Myself', 'first toggle is Myself, got ' + JSON.stringify(rows));
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

  // management is a fold of its own
  await page.evaluate(() => {
    const folds = [...document.querySelectorAll('#gwpanel .gwmore')];
    folds.find(f => f.textContent.includes('Groups')).click();
  });
  await page.waitForSelector('#gwpanel .ggroup', { timeout: 4000 });
  const managed = await page.evaluate(() =>
    [...document.querySelectorAll('#gwpanel .ggroup .ghead b')].map(x => x.textContent));
  assert(managed.includes('Panelists'), 'the Groups fold lists the group, got ' + JSON.stringify(managed));
  assertEq(page.errors.length, 0, 'no page errors: ' + page.errors.join(' | '));
  await page.close();
};
