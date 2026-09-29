// a titled thread folds in two places: the title bar puts the whole thread
// away, the handle beside the opening post puts away only its text. They are
// independent, and folding the thread does not forget the other.
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('fold-opening-post.md', [
    '# Folding',
    '',
    'A paragraph.',
    '',
    '- [ ] Me (2026-09-20 09:00:00): **A long opening post** <!--thread--> <!--seen:Me-->',
    '  the first line of a body that goes on and on',
    '',
    '  and a second paragraph of it as well.',
    '',
    '  - Bob (2026-09-20 10:00:00): a reply that stays visible.',
    '',
    '- [ ] Me (2026-09-20 11:00:00): no title here <!--thread--> <!--seen:Me-->',
    '  an untitled thread keeps its single handle',
    '',
    '  - Bob (2026-09-20 11:30:00): another reply. <!--seen:Me-->',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);

  // each thread card sits in its own wrapper, so they are not siblings
  const card = i => page.locator('#doc .thread').nth(i);
  const state = (i = 0) => page.evaluate(n => {
    const root = document.querySelectorAll('#doc .thread')[n].querySelector('.citem');
    const body = root.querySelector(':scope > .cbody');
    const vis = el => !!(el && el.offsetParent !== null);
    return {
      collapsed: root.classList.contains('collapsed'),
      bodyfold: root.classList.contains('bodyfold'),
      bodyVisible: vis(body),
      replyVisible: vis(root.querySelector(':scope > .citem')),
      titleVisible: vis(root.querySelector(':scope > .ctitlebar')),
      snippet: (root.querySelector(':scope > .chead .snippet') || {}).textContent || '',
    };
  }, i);

  let s = await state();
  assert(s.bodyVisible && s.replyVisible, 'everything is open to begin with: ' + JSON.stringify(s));

  // the handle in the header row: the post's own text, nothing else
  await card(0).locator('.citem > .chead .twisty').first().click();
  await page.waitForTimeout(300);
  s = await state();
  assert(!s.bodyVisible, 'the opening post is folded: ' + JSON.stringify(s));
  assert(s.replyVisible, 'the reply is untouched — that is the whole point');
  assert(s.titleVisible && !s.collapsed, 'the thread itself is still open');
  assert(s.snippet.length > 0, 'a folded post says what is behind it: ' + JSON.stringify(s));

  // the title bar's own handle: the whole thread
  await card(0).locator('.ctitlebar .tfold').first().click();
  await page.waitForTimeout(300);
  s = await state();
  assert(s.collapsed && !s.replyVisible, 'the thread is folded: ' + JSON.stringify(s));

  // and opening it again gives the opening post back the way it was left
  await card(0).locator('.ctitlebar .tfold').first().click();
  await page.waitForTimeout(300);
  s = await state();
  assert(!s.collapsed && s.replyVisible, 'the thread is open again: ' + JSON.stringify(s));
  assert(!s.bodyVisible && s.bodyfold, 'the opening post stayed folded: ' + JSON.stringify(s));

  // the same handle brings it back
  await card(0).locator('.citem > .chead .twisty').first().click();
  await page.waitForTimeout(300);
  s = await state();
  assert(s.bodyVisible, 'and folds back open: ' + JSON.stringify(s));

  // an untitled thread has no header row to hang a second handle on: its
  // one handle still folds the whole thread
  const was = await state(1);
  await card(1).locator('.citem > .chead .twisty').first().click();
  await page.waitForTimeout(300);
  const p = await state(1);
  assert(p.collapsed === !was.collapsed, 'an untitled thread folds whole: ' + JSON.stringify(p));
  assert(!p.bodyfold && p.bodyVisible === !p.collapsed,
    'and has no second state of its own: ' + JSON.stringify(p));

  // Reported by Bouke, 2026-09-22: the toggle did nothing on his board.
  // revealItem marks a thread's ROOT for a jump to ANY comment in it and the
  // mark lasts the session, so on a board navigated by jumping every opening
  // post was pinned open — the click saved a state the render ignored.
  // Being sent somewhere keeps the post open until you say otherwise; asking
  // wins from then on.
  await page.evaluate(() => {
    const root = S.parsed.items.find(i => i.title && !i.parent);
    revealItem(root.children.find(c => c.time) || root);
  });
  await page.waitForTimeout(400);
  s = await state();
  assert(s.bodyVisible, 'a jump opens the post it sent you to: ' + JSON.stringify(s));
  await card(0).locator('.citem > .chead .twisty').first().click();
  await page.waitForTimeout(300);
  s = await state();
  assert(s.bodyfold && !s.bodyVisible, 'and folding it afterwards still works: ' + JSON.stringify(s));

  // the same for a search match. Drop the session's choice but keep what
  // was persisted — the state a reopened window starts from, where a post
  // folded yesterday must still open for today's search.
  await page.evaluate(() => {
    for (const k of [...S.collapsed.keys()]) if (k.startsWith('body:')) S.collapsed.delete(k);
    S.reveal.clear(); // a window that has not jumped anywhere yet
    render();
  });
  await page.waitForTimeout(300);
  s = await state();
  assert(!s.bodyVisible, 'the fold was persisted, not just remembered: ' + JSON.stringify(s));
  await page.evaluate(() => setSearch('opening'));
  await page.waitForTimeout(400);
  s = await state();
  assert(s.bodyVisible, 'a match in the post opens it: ' + JSON.stringify(s));
  await card(0).locator('.citem > .chead .twisty').first().click();
  await page.waitForTimeout(300);
  s = await state();
  assert(s.bodyfold && !s.bodyVisible, 'and it can still be folded over a match: ' + JSON.stringify(s));
  await page.evaluate(() => setSearch(''));
  await page.waitForTimeout(300);
  await card(0).locator('.citem > .chead .twisty').first().click();
  await page.waitForTimeout(300);

  // "fold read" on a thread held open by an unread reply: the opening post
  // is read, so it folds; the reply you have not seen stays where it was.
  // Before this, such a thread stayed open at full height and the fold
  // bought nothing.
  await page.evaluate(() => foldAll('read'));
  await page.waitForTimeout(400);
  s = await state();
  assert(!s.collapsed && s.replyVisible, 'the unread reply holds its thread open: ' + JSON.stringify(s));
  assert(s.bodyfold && !s.bodyVisible, 'and the read opening post folds: ' + JSON.stringify(s));
  await page.close();
};
