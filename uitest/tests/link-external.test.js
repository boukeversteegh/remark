// the window never navigates: a link out of remark goes to the system
// browser however you click it — plain, middle-click or Ctrl-click — and
// wears the open-in glyph so the behaviour is visible before you click
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('link-external.md', [
    '# Links',
    '',
    'Prose with [a site](https://example.com/one) in it.',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **Links** <!--thread-->',
    '  see [the docs](https://example.com/two) and [#r20260901100000](#r20260901100000)',
    '  and `[not a link](https://example.com/code)` in code',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  // an all-read thread of your own opens folded: unfold it to reach the links
  await page.evaluate(() => {
    const c = document.getElementById('r20260901100000');
    if (c.classList.contains('collapsed')) c.querySelector('.chead .twisty').click();
  });
  await page.waitForTimeout(300);

  // every link that leaves remark is marked; in-document anchors are not
  const marks = await page.evaluate(() => {
    const out = [];
    for (const a of document.querySelectorAll('#doc a[href]')) {
      out.push({ href: a.getAttribute('href'), icon: !!a.querySelector('.extlink') });
    }
    return out;
  });
  const ext = marks.filter(m => /^https?:/.test(m.href));
  assert(ext.length >= 2, 'both external links rendered: ' + JSON.stringify(marks));
  assert(ext.every(m => m.icon), 'every external link wears the glyph: ' + JSON.stringify(marks));
  const anchor = marks.find(m => m.href.startsWith('#'));
  assert(anchor && !anchor.icon, 'an in-document anchor is not marked: ' + JSON.stringify(anchor));

  // the requests the host would receive, captured instead of performed
  await page.route('**/api/openurl*', route => {
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  const asked = [];
  page.on('request', r => {
    if (r.url().includes('/api/openurl')) asked.push(decodeURIComponent(r.url().split('u=')[1].split('&')[0]));
  });

  const link = '#r20260901100000 a[href="https://example.com/two"]';
  await page.click(link);
  await page.waitForTimeout(400);
  assertEq(asked.length, 1, 'a plain click asks the host to open it');
  assertEq(asked[0], 'https://example.com/two', 'with the right url');

  // middle-click: the browsing habit that used to spawn a remark window
  await page.click(link, { button: 'middle' });
  await page.waitForTimeout(400);
  assertEq(asked.length, 2, 'a middle click goes the same way: ' + JSON.stringify(asked));
  assertEq(asked[1], 'https://example.com/two', 'and carries the same url');

  // ctrl-click too
  await page.click(link, { modifiers: ['Control'] });
  await page.waitForTimeout(400);
  assertEq(asked.length, 3, 'a ctrl click goes the same way: ' + JSON.stringify(asked));

  // and nothing ever navigated this window or opened another
  const pages = page.context().pages().length;
  assertEq(pages, 1, 'no second window was opened');
  assert(page.url().includes('f='), 'the window itself stayed on the document');
  await page.close();
};
