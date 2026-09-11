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

  // the outline has no filter of its own: what the board shows, it lists.
  // Before, it hid resolved threads whatever the toolbar said.
  const listed = () => page.evaluate(() =>
    [...document.querySelectorAll('#outline .otrow .otxt')].map(t => t.textContent));
  const boardCount = () => page.evaluate(() =>
    [...document.querySelectorAll('#doc .thread')].length);
  assert((await listed()).includes('Settled'), 'with Show resolved on, the outline lists it');
  assertEq(await boardCount(), 2, 'and the board shows both threads');
  await page.evaluate(() => document.getElementById('hideResolvedBtn').click());
  await page.waitForTimeout(300);
  assert(!(await listed()).includes('Settled'), 'hiding resolved hides it in the outline too');
  assertEq(await boardCount(), 1, 'and on the board');
  await page.evaluate(() => document.getElementById('hideResolvedBtn').click());
  await page.waitForTimeout(300);
  assert((await listed()).includes('Settled'), 'and it comes back in both at once');

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

  // single-thread mode still shows exactly one thread: a revealed thread is
  // exempt from the resolved filter, never from focus
  await page.evaluate(() => { S.focusThread = '2026-09-01 11:00:00'; render(); });
  await page.waitForTimeout(300);
  const focused = await page.evaluate(() => ({
    count: document.querySelectorAll('#doc .thread').length,
    revealed: !!document.getElementById('r20260901100000'),
    live: !!document.getElementById('r20260901110000'),
  }));
  assert(focused.count === 1 && !focused.revealed && focused.live,
    'focus mode is not widened by a revealed thread: ' + JSON.stringify(focused));
  await page.evaluate(() => { S.focusThread = null; render(); });
  await page.waitForTimeout(200);

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
