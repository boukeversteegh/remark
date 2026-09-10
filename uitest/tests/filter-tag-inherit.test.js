// a thread started while a tag filter is on opens with that filter's tags
// already in the draft — plain text, caret above them — so it does not vanish
// from the view the moment it is sent, and deleting the token is enough to
// opt out. Replies are left alone.
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('filter-tag-inherit.md', [
    '# Inherit',
    '',
    'A paragraph.',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **Tagged** about #alpha work <!--thread-->',
    '',
    '- [ ] Me (2026-09-01 10:01:00): **Plain** nothing special here <!--thread-->',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);

  await page.evaluate(() => toggleTag('alpha'));
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('#doc .newthreadbtn').click());
  await page.waitForSelector('.editor[data-key^="new:"] textarea', { timeout: 4000 });
  await page.waitForTimeout(300);

  // the tag sits in the draft, on its own line, with the caret above it
  const seed = await page.evaluate(() => {
    const ta = document.querySelector('.editor[data-key^="new:"] textarea');
    return { value: ta.value, start: ta.selectionStart, focused: document.activeElement === ta };
  });
  assertEq(seed.value, '\n\n#alpha', 'the composer opens with the tag below an empty line');
  assert(seed.focused && seed.start === 0, 'the caret waits above the tag: ' + JSON.stringify(seed));

  // typing at the caret puts the text above the tag, and sending keeps both
  await page.keyboard.type('BORN-UNDER-FILTER');
  await page.waitForTimeout(150);
  const typed = await page.evaluate(() =>
    document.querySelector('.editor[data-key^="new:"] textarea').value);
  assertEq(typed, 'BORN-UNDER-FILTER\n\n#alpha', 'the text lands above the tag');
  await page.click('.editor[data-key^="new:"] button.send');
  await page.waitForTimeout(1500);

  const md = ctx.read(doc);
  assert(md.includes('BORN-UNDER-FILTER'), 'the thread was written');
  const block = md.slice(md.indexOf('BORN-UNDER-FILTER')).split('\n').slice(0, 4).join('\n');
  assert(/#alpha/.test(block), 'the new thread carries #alpha:\n' + block);

  // and it is still on screen: the filter is on and the thread matches it
  const shown = await page.evaluate(() =>
    [...document.querySelectorAll('#doc .thread')].map(t => t.textContent));
  assert(shown.some(t => t.includes('BORN-UNDER-FILTER')),
    'the thread it just wrote is still visible under the filter');

  // a reply composer gets no seed at all
  await page.focus('#r20260901100000 > .cfoot .replyseed');
  await page.waitForSelector('#r20260901100000 > .editor textarea', { timeout: 4000 });
  const replySeed = await page.evaluate(() =>
    document.querySelector('#r20260901100000 > .editor textarea').value);
  assertEq(replySeed, '', 'replies are not seeded with the filter tags');
  await page.close();
};
