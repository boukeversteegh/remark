// regression: an edit composer opens at the edited comment's own text
// column, for the root AND for a nested reply (the nested one used to
// inherit the reply-slot inset; a root once jumped to the card edge)
const { assert } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('edit-nested-indent.md', [
    '# Edit indent',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **Mine** root text <!--thread-->',
    '  - Alice (2026-09-01 10:01:00): a reply',
    '    - Me (2026-09-01 10:02:00): my nested reply',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  await page.evaluate(() => {
    const root = document.getElementById('r20260901100000');
    if (root.classList.contains('collapsed')) root.querySelector('.chead .twisty').click();
  });
  await page.waitForTimeout(200);
  const measure = async id => {
    await page.evaluate(i => document.querySelector('#' + i + ' > .chead [title="Edit your comment"]').click(), id);
    await page.waitForSelector('#' + id + ' > .editor textarea', { timeout: 4000 });
    const d = await page.evaluate(i => {
      const el = document.getElementById(i);
      const ta = el.querySelector(':scope > .editor textarea');
      return { ta: ta.getBoundingClientRect().left, item: el.getBoundingClientRect().left };
    }, id);
    await page.evaluate(i => { const b = document.querySelector('#' + i + ' > .editor button.cancel'); if (b) b.click(); }, id);
    await page.waitForTimeout(150);
    return Math.round(d.ta - d.item);
  };
  const root = await measure('r20260901100000');
  assert(Math.abs(root - 41) <= 3, 'root edit composer at the text column: ' + root + 'px from the card edge');
  const nested = await measure('r20260901100200');
  assert(Math.abs(nested - 41) <= 3, 'nested edit composer at its own text column: ' + nested + 'px from its edge');
  await page.close();
};
