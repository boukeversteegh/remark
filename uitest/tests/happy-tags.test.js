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
    const el = [...document.querySelectorAll('#r20260901100000 .tagchip')]
      .find(e => e.textContent.startsWith('#important'));
    return !!el;
  });
  assert(chip, 'the #important tag renders as a chip on the comment');

  // your own authored tag carries a × that edits it out of your text
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('#r20260901100000 .tagchip')]
      .find(e => e.textContent.startsWith('#important'));
    el.querySelector('.tagx').click();
  });
  await page.waitForTimeout(1500);
  const md = ctx.read(doc);
  assert(!md.includes('#important'), 'removing the tag edits it out of the text');
  assert(md.includes('this one is'), 'the rest of the text survives');
  await page.close();
};
