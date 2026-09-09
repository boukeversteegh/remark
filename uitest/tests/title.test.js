// the document's first heading names the tab and the toolbar, filename after
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('title.md', [
    '# Sample Document',
    '',
    'A paragraph.',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **T** a thread <!--thread-->',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  const title = await page.title();
  assert(title.includes('Sample Document — title.md'), 'tab title is title-first: ' + title);
  const fn = await page.evaluate(() => document.getElementById('filename').textContent);
  assertEq(fn, 'Sample Document — title.md', 'toolbar shows title first');
  assertEq(page.errors.length, 0, 'no page errors: ' + page.errors.join(' | '));
  await page.close();
};
