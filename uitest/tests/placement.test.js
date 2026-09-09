// replies render as replies even when a body ends in a list or is
// over-indented; genuinely nested list-notes still hang inside their items
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  // over-indented body (+6) ending in bullets, like hand-written files
  const doc = ctx.fixture('placement.md', [
    '# Placement',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **Design** opening <!--thread-->',
    '',
    '  - Me (2026-09-01 10:39:00): a question ending with a colon:',
    '',
    '      And there are two options:',
    '',
    '      - an instance',
    '      - an expression',
    '',
    '      - Bob (2026-09-01 10:40:00): a reply after the bullets.',
    '',
    '        Body of the reply.',
    '',
    '    - Me (2026-09-01 10:46:00): a follow-up at the right indent.',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  const order = await page.evaluate(() =>
    [...document.querySelectorAll('#r20260901103900 > .citem')].map(e => e.id));
  assertEq(order.join(','), 'r20260901104000,r20260901104600',
    'children render in file order at the right level');
  const swallowed = await page.evaluate(() =>
    !!document.querySelector('#r20260901103900 .cbody .licard'));
  assert(!swallowed, 'no reply swallowed into the body list');
  await page.close();

  // the legitimate shape: a note nested INSIDE a list item stays there
  const doc2 = ctx.fixture('placement2.md', [
    '# Placement Two',
    '',
    '- [ ] Me (2026-09-01 11:00:00): **Steps** the steps: <!--thread-->',
    '',
    '  1. step one',
    '  2. step two',
    '',
    '     - Bob (2026-09-01 11:01:00): about step two.',
    '',
    '  3. step three',
    '',
  ].join('\n'));
  const page2 = await ctx.open(doc2);
  const nested = await page2.evaluate(() => ({
    hung: !!document.getElementById('r20260901110100').closest('.licard'),
    spliced: (document.querySelector('#r20260901110000 .cbody ol') || { children: [] }).children.length,
  }));
  assert(nested.hung, 'list-note hangs inside its list item');
  assertEq(nested.spliced, 3, 'interrupted list splices back together');

  // collapsing a comment with interjections hides EVERYTHING under the
  // header — no leftover gaps or insert-comment affordances
  await page2.evaluate(() => document.querySelector('#r20260901110000 > .chead .twisty').click());
  await page2.waitForTimeout(300);
  const leak = await page2.evaluate(() => {
    const c = document.getElementById('r20260901110000');
    const visible = [...c.querySelectorAll(':scope > *')]
      .filter(x => getComputedStyle(x).display !== 'none')
      .map(x => x.className.split(' ')[0]);
    return { visible, h: Math.round(c.getBoundingClientRect().height) };
  });
  assert(!leak.visible.some(v => v === 'igap' || v === 'cfoot' || v === 'cbody'),
    'nothing but the head survives a collapse: ' + JSON.stringify(leak.visible));
  assert(leak.h < 90, 'the collapsed card is compact, got ' + leak.h + 'px');
  await page2.close();
};
