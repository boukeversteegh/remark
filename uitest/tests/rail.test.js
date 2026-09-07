// the collapse rail folds exactly the comment whose gutter it is; the caret
// and the strip are one control; the strip beside the reply box is inert
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('rail.md', [
    '# Rail',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **Thread** opening <!--thread-->',
    '',
    '  - Bob (2026-09-01 10:01:00): flat reply one.',
    '',
    '  - Bob (2026-09-01 10:02:00): flat reply two.',
    '',
    '    - Me (2026-09-01 10:03:00): nested under two.',
    '',
    '  - Bob (2026-09-01 10:04:00): flat reply three.',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);

  // hovering a flat reply's rail marks only that reply
  const hov = await page.evaluate(() => {
    const rep = document.getElementById('r20260901100400');
    rep.querySelector(':scope > .crail').dispatchEvent(new MouseEvent('mouseenter'));
    return {
      reply: rep.classList.contains('railhot'),
      root: document.getElementById('r20260901100000').classList.contains('railhot'),
    };
  });
  assert(hov.reply && !hov.root, 'flat reply rail marks only itself');

  // caret hover marks the same fold
  const caret = await page.evaluate(() => {
    const rep = document.getElementById('r20260901100200');
    rep.querySelector(':scope > .chead .twisty').dispatchEvent(new MouseEvent('mouseenter'));
    return rep.classList.contains('railhot');
  });
  assert(caret, 'caret hover marks the comment');

  // clicking a subtree parent's rail folds the subtree, not the root
  await page.evaluate(() => document.getElementById('r20260901100200').querySelector(':scope > .crail').click());
  await page.waitForTimeout(200);
  const folded = await page.evaluate(() => ({
    parent: document.getElementById('r20260901100200').classList.contains('collapsed'),
    root: document.getElementById('r20260901100000').classList.contains('collapsed'),
  }));
  assert(folded.parent && !folded.root, 'subtree folds, root stays');

  // the strip beside the root's reply seed hits the foot, never the rail
  const footHit = await page.evaluate(() => {
    const foot = document.querySelector('#r20260901100000 > .cfoot');
    const r = foot.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + 10, r.top + r.height / 2);
    return hit && hit.classList.contains('crail');
  });
  assert(!footHit, 'gutter beside the reply box is inert');
  assertEq(page.errors.length, 0, 'no page errors: ' + page.errors.join(' | '));
  await page.close();
};
