// happy flow: a #tag in a comment shows as a chip on its header
const { assert } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('happy-tags.md', [
    '# Tags',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **Tagged** this one is #important <!--thread-->',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  const chip = await page.evaluate(() => {
    const el = [...document.querySelectorAll('#r20260901100000 .tagchip, #r20260901100000 .tag, #r20260901100000 a')]
      .find(e => e.textContent.replace('#', '') === 'important');
    return !!el;
  });
  assert(chip, 'the #important tag renders as a chip or link on the comment');
  await page.close();
};
