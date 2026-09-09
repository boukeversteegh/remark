// happy flow: the read dot writes a seen-marker for you, and takes it back
const { assert } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('happy-read.md', [
    '# Read',
    '',
    '- [ ] Bob (2026-09-01 10:00:00): **From Bob** something to read <!--thread-->',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  await page.evaluate(() => document.querySelector('#r20260901100000 .rdot').click());
  await page.waitForTimeout(1500);
  assert(/<!--seen:[^>]*\bMe\b[^>]*-->/.test(ctx.read(doc)), 'seen-marker written');
  await page.evaluate(() => document.querySelector('#r20260901100000 .rdot').click());
  await page.waitForTimeout(1500);
  assert(!/<!--seen:[^>]*\bMe\b[^>]*-->/.test(ctx.read(doc)), 'seen-marker withdrawn');
  await page.close();
};
