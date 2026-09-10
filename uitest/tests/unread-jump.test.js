// jumping to an unread comment lands on its TOP, not its middle; and in
// single-thread mode an outline row is the toolbar pill: first click selects
// the thread and goes to its first unread, each further click steps on
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const filler = Array.from({ length: 14 }, (_, i) => '  line ' + i + ' of a long body').join('\n');
  const doc = ctx.fixture('unread-jump.md', [
    '# Jump',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **Alpha** <!--thread--> <!--seen:Me-->',
    '  a thread with a tall body',
    filler,
    '',
    '  - Bob (2026-09-01 10:05:00): first unread here.',
    filler,
    '',
    '  - Bob (2026-09-01 10:06:00): second unread here.',
    filler,
    '',
    '- [ ] Me (2026-09-01 11:00:00): **Beta** <!--thread--> <!--seen:Me-->',
    '  another thread',
    filler,
    '',
    '  - Bob (2026-09-01 11:05:00): unread in beta.',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.waitForTimeout(300);

  // where the comment's top sits relative to the viewport top. A comment near
  // the end of a short document cannot reach the top — the scroller runs out
  // — so that counts as landed too.
  const topOf = id => page.evaluate(i => {
    const el = document.getElementById(i);
    if (!el) return null;
    const m = document.getElementById('main') || document.scrollingElement;
    const atEnd = m.scrollTop + m.clientHeight >= m.scrollHeight - 4;
    return { top: Math.round(el.getBoundingClientRect().top), atEnd };
  }, id);
  const landed = r => r && (r.atEnd || (r.top >= 0 && r.top < 120));

  await page.evaluate(() => document.getElementById('unreadBtn').click());
  await page.waitForTimeout(900);
  let at = await topOf('r20260901100500');
  assert(at, 'the first unread is on the board');
  assert(at.top >= 0 && at.top < 120,
    'the pill lands on the TOP of the comment, under the toolbar — got ' + JSON.stringify(at));

  // focus mode: an outline row behaves like the pill
  await page.evaluate(() => document.getElementById('focusModeBtn').click());
  await page.waitForTimeout(400);
  const row = name => page.evaluate(n => {
    [...document.querySelectorAll('#outline .otrow')]
      .find(r => r.querySelector('.otxt').textContent === n).click();
  }, name);

  await row('Beta');
  await page.waitForTimeout(900);
  let st = await page.evaluate(() => ({
    focus: S.focusThread,
    beta: !!document.getElementById('r20260901110500'),
  }));
  assertEq(st.focus, '2026-09-01 11:00:00', 'the row switched the focus');
  assert(st.beta, 'and its unread comment is on the board');
  at = await topOf('r20260901110500');
  assert(landed(at), 'landing on the first unread of the newly selected thread — got ' + JSON.stringify(at));

  // back to Alpha: first click gives its FIRST unread, second click the next
  await row('Alpha');
  await page.waitForTimeout(900);
  at = await topOf('r20260901100500');
  assert(landed(at), 'a freshly selected thread starts at its first unread — got ' + JSON.stringify(at));
  const cursorAt = () => page.evaluate(() => {
    const u = visibleUnread();
    return u.length ? (u[unreadCursor] || {}).time : null;
  });
  assertEq(await cursorAt(), '2026-09-01 10:05:00', 'the first click sits on the first unread');
  await row('Alpha');
  await page.waitForTimeout(900);
  at = await topOf('r20260901100600');
  assert(landed(at), 'clicking again steps to the next unread — got ' + JSON.stringify(at));
  assertEq(await cursorAt(), '2026-09-01 10:06:00', 'and the cursor really moved on');
  // which is exactly where the toolbar pill would be: same function, same
  // cursor, so the two controls cannot drift apart
  await page.evaluate(() => document.getElementById('unreadBtn').click());
  await page.waitForTimeout(700);
  assertEq(await cursorAt(), '2026-09-01 10:05:00', 'the pill continues the same cycle');
  await page.close();
};
