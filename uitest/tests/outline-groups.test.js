// the outline separates anchor groups: threads on the same paragraph are
// siblings (no rule between them), a rule marks the change of anchor
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('outline-groups.md', [
    '# Groups',
    '',
    '## One',
    '',
    'First paragraph.',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **A1** <!--thread-->',
    '  on the first paragraph',
    '',
    '- [ ] Me (2026-09-01 10:01:00): **A2** <!--thread-->',
    '  also on the first paragraph',
    '',
    'Second paragraph.',
    '',
    '- [ ] Me (2026-09-01 10:02:00): **B1** <!--thread-->',
    '  on the second paragraph',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  const r = await page.evaluate(() => {
    const nav = document.getElementById('outline');
    const seq = [...nav.querySelectorAll('.otrow, .osep')].map(x =>
      x.classList.contains('osep') ? '|' : x.querySelector('.otxt').textContent);
    return { seq, seps: nav.querySelectorAll('.osep').length };
  });
  assertEq(r.seps, 1, 'one rule between the two anchor groups');
  assertEq(r.seq.join(' '), 'A1 A2 | B1', 'siblings stay together, the rule marks the anchor change');
  await page.close();
};
