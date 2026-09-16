// opening a notification (or any jump) while single-thread mode holds another
// thread must switch the focus and unfold the way down to the comment — it
// used to do nothing at all, because the board was showing a different thread
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('notify-focus.md', [
    '# Focus jumps',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **Alpha** <!--thread--> <!--seen:Me-->',
    '  the thread in focus',
    '',
    '- [ ] Me (2026-09-01 11:00:00): **Beta** <!--thread--> <!--seen:Me-->',
    '  another thread',
    '',
    '  - Bob (2026-09-01 11:05:00): a reply nobody read.',
    '',
    '    - Bob (2026-09-01 11:06:00): and a deeper one, also unread.',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);

  // focus Alpha, so Beta is off the board entirely
  await page.evaluate(() => { S.focusThread = '2026-09-01 10:00:00'; render(); });
  await page.waitForTimeout(300);
  let st = await page.evaluate(() => ({
    threads: document.querySelectorAll('#doc .thread').length,
    deep: !!document.getElementById('r20260901110600'),
  }));
  assertEq(st.threads, 1, 'single-thread mode shows one thread');
  assert(!st.deep, 'the other thread is not on the board');

  // the notifications panel lists what is unread: click the deepest one, the
  // way you would
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.nlist .nrow')].map(r => r.textContent));
  assert(rows.some(r => r.includes('deeper one')),
    'the notification is listed while focused elsewhere: ' + JSON.stringify(rows));
  await page.evaluate(() => {
    [...document.querySelectorAll('.nlist .nrow')]
      .find(r => r.textContent.includes('deeper one')).click();
  });
  await page.waitForTimeout(800);

  st = await page.evaluate(() => ({
    focus: S.focusThread,
    threads: document.querySelectorAll('#doc .thread').length,
    deep: !!document.getElementById('r20260901110600'),
    parentFolded: (() => {
      const p = document.getElementById('r20260901110500');
      return p ? p.classList.contains('collapsed') : null;
    })(),
    alphaGone: !document.getElementById('r20260901100000'),
  }));
  assertEq(st.focus, '2026-09-01 11:00:00', 'the focus moved to the comment\'s thread');
  assertEq(st.threads, 1, 'and single-thread mode still shows exactly one');
  assert(st.deep, 'the comment itself is on the board: ' + JSON.stringify(st));
  assert(st.parentFolded === false, 'its parent was unfolded so it can be seen');
  assert(st.alphaGone, 'the thread we left is no longer shown');
  await page.close();
};
