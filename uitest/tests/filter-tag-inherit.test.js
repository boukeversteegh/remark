// a thread started while a tag filter is on carries that filter's tags —
// otherwise it vanishes from the view the moment it is sent — and the
// composer names them first, so nothing is written behind your back
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

  // the composer says which tags it will add, and stops saying it once the
  // text carries them already
  const hint = () => page.evaluate(() => {
    const h = document.querySelector('.editor[data-key^="new:"] .etaghint');
    return h && h.style.display !== 'none' ? h.textContent : '';
  });
  assert(/#alpha/.test(await hint()), 'the composer names the inherited tag: ' + JSON.stringify(await hint()));
  await page.fill('.editor[data-key^="new:"] textarea', 'already mine #alpha');
  await page.waitForTimeout(150);
  assertEq(await hint(), '', 'the note goes when you type the tag yourself');

  await page.fill('.editor[data-key^="new:"] textarea', 'BORN-UNDER-FILTER');
  await page.waitForTimeout(150);
  assert(/#alpha/.test(await hint()), 'and comes back when it is gone again');
  await page.click('.editor[data-key^="new:"] button.send');
  await page.waitForTimeout(1500);

  const md = ctx.read(doc);
  assert(md.includes('BORN-UNDER-FILTER'), 'the thread was written');
  const line = md.split('\n').find(l => l.includes('BORN-UNDER-FILTER')) || '';
  const block = md.slice(md.indexOf('BORN-UNDER-FILTER'));
  assert(/#alpha/.test(line) || /#alpha/.test(block.split('\n').slice(0, 4).join('\n')),
    'the new thread carries #alpha:\n' + block.split('\n').slice(0, 4).join('\n'));

  // and it stays in view: the filter is still on and the thread is on screen
  const seen = await page.evaluate(() => ({
    filtered: [...document.querySelectorAll('#doc .thread')].map(t => t.textContent),
    chips: [...document.querySelectorAll('#doc .tagchip')].map(c => c.textContent),
  }));
  assert(seen.filtered.some(t => t.includes('BORN-UNDER-FILTER')),
    'the thread it just wrote is still visible under the filter');

  // a REPLY under a filter is left alone — its thread already matches
  await page.evaluate(() => toggleTag('alpha')); // clear
  await page.waitForTimeout(200);
  await page.evaluate(() => toggleTag('alpha'));
  await page.waitForTimeout(300);
  await page.focus('#r20260901100000 > .cfoot .replyseed');
  await page.waitForSelector('#r20260901100000 > .editor textarea', { timeout: 4000 });
  const replyHint = await page.evaluate(() =>
    !!document.querySelector('#r20260901100000 > .editor .etaghint'));
  assert(!replyHint, 'replies get no inherited tags');
  await page.fill('#r20260901100000 > .editor textarea', 'PLAIN-REPLY');
  await page.click('#r20260901100000 > .editor button.send');
  await page.waitForTimeout(1500);
  const after = ctx.read(doc);
  const rline = after.split('\n').find(l => l.includes('PLAIN-REPLY')) || '';
  assert(!/#alpha/.test(rline), 'the reply text was not touched: ' + rline);
  await page.close();
};
