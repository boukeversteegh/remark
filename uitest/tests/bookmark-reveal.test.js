// opening a bookmark must land on its thread even when the toolbar filter
// hides it: a resolved thread is listed in the outline whatever the filter
// says, so the jump has to reach the board too
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('bookmark-reveal.md', [
    '# Bookmarks',
    '',
    'A paragraph.',
    '',
    '- [x] Me (2026-09-01 10:00:00): **Settled** <!--thread--> <!--seen:Me-->',
    '  the body of a finished thread',
    '',
    '- [ ] Me (2026-09-01 11:00:00): **Live** <!--thread--> <!--seen:Me-->',
    '  still going',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);

  // bookmark the thread while it is still in view, the way you would
  await page.evaluate(() => document.querySelector('#r20260901100000 .chead .bmbtn').click());
  await page.waitForTimeout(300);

  // now hide resolved threads: the settled one leaves the board
  await page.evaluate(() => document.getElementById('hideResolvedBtn').click());
  await page.waitForTimeout(300);
  const onBoard = await page.evaluate(() =>
    [...document.querySelectorAll('#doc .thread')].map(t => t.textContent));
  assert(!onBoard.some(t => t.includes('Settled')), 'the resolved thread is hidden: ' + JSON.stringify(onBoard));
  const row = await page.evaluate(() =>
    [...document.querySelectorAll('#outline .otrow')].some(r => r.querySelector('.otxt').textContent === 'Settled'));
  assert(row, 'the bookmarked thread is listed in the outline');

  // opening it from the outline must show it on the board and land on it
  await page.evaluate(() => {
    [...document.querySelectorAll('#outline .otrow')]
      .find(r => r.querySelector('.otxt').textContent === 'Settled').click();
  });
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => {
    const card = document.getElementById('r20260901100000');
    return {
      threads: [...document.querySelectorAll('#doc .thread')].map(t => t.textContent.slice(0, 40)),
      present: !!card,
      collapsed: card ? card.classList.contains('collapsed') : null,
      stillHiding: document.getElementById('hideResolvedBtn').classList.contains('active') === false,
    };
  });
  assert(after.present, 'the bookmarked thread is on the board: ' + JSON.stringify(after));
  assert(!after.collapsed, 'and it is open, not folded shut');
  assert(after.threads.some(t => t.includes('Live')), 'the rest of the document is unchanged');
  assert(after.stillHiding, 'the filter itself is untouched — only this thread is exempt');

  // toggling the filter clears the exemption again
  await page.evaluate(() => document.getElementById('hideResolvedBtn').click());
  await page.waitForTimeout(200);
  await page.evaluate(() => document.getElementById('hideResolvedBtn').click());
  await page.waitForTimeout(300);
  const reset = await page.evaluate(() => !!document.getElementById('r20260901100000'));
  assert(!reset, 'after re-hiding, the resolved thread is out of view again');

  // hideResolved is a PERSISTED pref and the run shares one config: leave it
  // the way it was found, or later tests resolve threads that then vanish
  await page.evaluate(() => {
    if (S.hideResolved) document.getElementById('hideResolvedBtn').click();
  });
  await page.waitForTimeout(200);
  assertEq(await page.evaluate(() => !!S.hideResolved), false, 'the pref is restored for the rest of the run');
  await page.close();
};
