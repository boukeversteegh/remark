// regression: a reply typed in the window lands under the comment the
// window chose, at that comment's level plus one. The verb the window now
// calls has its own sibling rule for the CLI, which would put a reply to a
// nested comment one level too high.
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('reply-nesting.md', [
    '# Nesting',
    '',
    '- [ ] Bob (2026-09-01 10:00:00): **Topic** the opening <!--thread-->',
    '',
    '  - Bob (2026-09-01 10:01:00): a reply at the first level.',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  const indentOf = (md, needle) => {
    const line = md.split('\n').find(l => l.includes(needle));
    return line === undefined ? -1 : line.length - line.replace(/^ +/, '').length;
  };

  // typed in the leaf's header: it belongs UNDER that comment
  await page.evaluate(() => document.querySelector('#r20260901100100 .replybtn').click());
  await page.waitForSelector('#r20260901100100 > .editor textarea', { timeout: 6000 });
  await page.fill('#r20260901100100 > .editor textarea', 'NESTED-UNDER-THE-LEAF');
  await page.click('#r20260901100100 > .editor button.send');
  await page.waitForTimeout(1500);
  let md = ctx.read(doc);
  assert(md.includes('NESTED-UNDER-THE-LEAF'), 'the reply reached the file');
  assertEq(indentOf(md, 'NESTED-UNDER-THE-LEAF'), indentOf(md, 'a reply at the first level') + 2,
    'a reply typed in a comment header sits one level under it');

  // typed in the thread's bottom slot: it belongs under the ROOT, flat
  await page.focus('#r20260901100000 > .cfoot .replyseed');
  await page.waitForSelector('#r20260901100000 > .editor textarea', { timeout: 6000 });
  await page.fill('#r20260901100000 > .editor textarea', 'FLAT-UNDER-THE-ROOT');
  await page.click('#r20260901100000 > .editor button.send');
  await page.waitForTimeout(1500);
  md = ctx.read(doc);
  assert(md.includes('FLAT-UNDER-THE-ROOT'), 'the flat reply reached the file');
  assertEq(indentOf(md, 'FLAT-UNDER-THE-ROOT'), indentOf(md, 'a reply at the first level'),
    'a reply typed in the thread slot sits at the first level, under the root');
  await page.close();
};
