// happy flow: a comment written to the file from outside appears in the
// page on its own, and carries its author
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('happy-live.md', [
    '# Live',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **T** opening <!--thread-->',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  ctx.write(doc, ctx.read(doc).replace(
    '- [ ] Me (2026-09-01 10:00:00): **T** opening <!--thread-->\n',
    '- [ ] Me (2026-09-01 10:00:00): **T** opening <!--thread-->\n\n  - Bob (2026-09-01 10:09:00): LIVE-ARRIVAL.\n'));
  await page.waitForSelector('#r20260901100900', { timeout: 5000 });
  const author = await page.evaluate(() =>
    document.querySelector('#r20260901100900 .chead .author').textContent);
  assertEq(author, 'Bob', 'arrived with its author');
  await page.close();
};
