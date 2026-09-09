// happy flow: a #tag in a comment shows as a chip on its header
const { assert } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('happy-tags.md', [
    '# Tags',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **Tagged** this one is #important, see [jump](#section-two) and glued#not-a-tag <!--thread-->',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  const chip = await page.evaluate(() => {
    const el = [...document.querySelectorAll('#r20260901100000 .tagchip')]
      .find(e => e.textContent.startsWith('#important'));
    return !!el;
  });
  assert(chip, 'the #important tag renders as a chip on the comment');
  const stray = await page.evaluate(() =>
    [...document.querySelectorAll('#r20260901100000 .tagchip')].map(e => e.textContent));
  assert(!stray.some(t => t.includes('section') || t.includes('not-a-tag')),
    'link anchors and glued hashes are not tags: ' + JSON.stringify(stray));

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
