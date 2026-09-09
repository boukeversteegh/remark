// happy flow: resolving your own thread ticks its box; reopening unticks it
const { assert } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('happy-resolve.md', [
    '# Resolve',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **Mine** my own thread, nothing unread <!--thread-->',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  await page.evaluate(() => document.querySelector('#r20260901100000 .chead .rstat').click());
  await page.waitForTimeout(1500);
  assert(ctx.read(doc).includes('- [x] Me (2026-09-01 10:00:00):'), 'resolve ticks the box');
  await page.evaluate(() => document.querySelector('#r20260901100000 .chead .rstat').click());
  await page.waitForTimeout(1500);
  assert(ctx.read(doc).includes('- [ ] Me (2026-09-01 10:00:00):'), 'reopen unticks it');
  await page.close();
};
