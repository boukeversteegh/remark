// the search bar turns the board into a result page: threads without the
// term drop out, nothing inside a surviving thread is hidden, matches are
// marked, and opening a fold that hides matches opens the way down to them
// — an expansion that outlives the search
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('search.md', [
    '# Search',
    '',
    'A paragraph.',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **Alpha** <!--thread--> <!--seen:Me-->',
    '  nothing to find in the root',
    '',
    '  - Bob (2026-09-01 10:05:00): a plain reply, also nothing. <!--seen:Me-->',
    '',
    '    - Bob (2026-09-01 10:06:00): deep down here lives a PLATYPUS. <!--seen:Me-->',
    '',
    '- [ ] Me (2026-09-01 11:00:00): **Beta** <!--thread--> <!--seen:Me-->',
    '  this root mentions a platypus itself',
    '',
    '  - Bob (2026-09-01 11:05:00): unrelated chatter. <!--seen:Me-->',
    '',
    '- [ ] Me (2026-09-01 12:00:00): **Gamma** <!--thread--> <!--seen:Me-->',
    '  no animals at all',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);

  const search = async term => {
    await page.fill('#searchInput', term);
    await page.waitForTimeout(450);
  };
  const state = () => page.evaluate(() => ({
    threads: [...document.querySelectorAll('#doc .thread')].map(t => {
      const h = t.querySelector('.ctitle, .chead');
      return (h ? h.textContent : '').replace(/\s+/g, ' ').trim().slice(0, 12);
    }),
    outline: [...document.querySelectorAll('#outline .otrow .otxt')].map(t => t.textContent),
    bar: (document.querySelector('#doc .tagbar .tagn') || {}).textContent || '',
    hit: [...document.querySelectorAll('#doc .citem.hit')].map(c => c.dataset.ikey.slice(0, 6)).length,
    deep: [...document.querySelectorAll('#doc .citem.hitdeep')].length,
    chip: !!document.querySelector('#doc .tagbar .findchip'),
  }));

  await search('platypus');
  let s = await state();
  assertEq(s.threads.length, 2, 'only the threads containing it survive: ' + JSON.stringify(s.threads));
  assert(!s.outline.includes('Gamma'), 'the outline narrows with the board: ' + JSON.stringify(s.outline));
  assert(s.chip, 'the term shows as a chip in the filter bar');
  assert(/2 matches in 2 threads/.test(s.bar), 'the bar counts matches and threads: ' + s.bar);

  // the term is marked where it sits in the text, matching however it was cased
  const marks = await page.evaluate(() =>
    [...document.querySelectorAll('#doc .cbody mark.searchhit')].map(m => m.textContent));
  assert(marks.length > 0, 'the words themselves are highlighted');
  assert(marks.some(m => m === 'platypus') && marks.some(m => m === 'PLATYPUS'),
    'each match keeps its own casing: ' + JSON.stringify(marks));
  const intact = await page.evaluate(() =>
    document.querySelector('#r20260901110000 .cbody').textContent.trim());
  assertEq(intact, 'this root mentions a platypus itself', 'the text around it is untouched');

  // Ctrl+F puts the cursor in the box
  await page.evaluate(() => document.getElementById('searchInput').blur());
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(200);
  assertEq(await page.evaluate(() => document.activeElement.id), 'searchInput',
    'Ctrl+F focuses the search box');

  // nothing inside a surviving thread is hidden: Beta's unrelated reply stays
  const betaReply = await page.evaluate(() => !!document.getElementById('r20260901110500'));
  assert(betaReply, 'a non-matching comment in a matching thread is not hidden');

  // Beta's own body holds the term and Beta is folded: the fold must say so,
  // or a result with no visible reason for being there
  const beta = await page.evaluate(() => {
    const el = document.getElementById('r20260901110000');
    return {
      collapsed: el.classList.contains('collapsed'),
      hit: el.classList.contains('hit'),
      chip: (el.querySelector('.chead .hitchip') || {}).textContent || '',
    };
  });
  assert(beta.collapsed && beta.hit, 'the matching root is marked: ' + JSON.stringify(beta));
  assert(/1 match/.test(beta.chip),
    'a folded comment that matches in its own body says so: ' + JSON.stringify(beta.chip));

  // Alpha's match is buried: the fold says how many and wears the marker
  let alpha = await page.evaluate(() => {
    const el = document.getElementById('r20260901100000');
    return {
      collapsed: el.classList.contains('collapsed'),
      deepMark: el.classList.contains('hitdeep'),
      chip: (el.querySelector('.chead .hitchip') || {}).textContent || '',
      deepVisible: (e => !!e && e.getBoundingClientRect().height > 0)(document.getElementById('r20260901100600')),
    };
  });
  assert(alpha.collapsed, 'the search left the fold state alone');
  assert(alpha.deepMark, 'a fold hiding a match is marked');
  assert(/1 match/.test(alpha.chip), 'and says how many: ' + JSON.stringify(alpha.chip));
  assert(!alpha.deepVisible, 'the buried match is not on screen yet');

  // opening it opens the whole way down to the match — but not its
  // non-matching sibling branch
  await page.evaluate(() => document.querySelector('#r20260901100000 > .chead .twisty').click());
  await page.waitForTimeout(400);
  alpha = await page.evaluate(() => ({
    deepVisible: (e => !!e && e.getBoundingClientRect().height > 0)(document.getElementById('r20260901100600')),
    midOpen: !document.getElementById('r20260901100500').classList.contains('collapsed'),
    hitMark: document.getElementById('r20260901100600').classList.contains('hit'),
  }));
  assert(alpha.deepVisible && alpha.midOpen, 'expanding reached the buried match: ' + JSON.stringify(alpha));
  assert(alpha.hitMark, 'the matching comment itself is marked');

  // ‹ › walk the matching COMMENTS in document order, so running off the end
  // of one thread lands on the first match in the next, and it wraps
  const nav = await page.evaluate(() => ({
    prev: !document.getElementById('searchPrev').hidden,
    next: !document.getElementById('searchNext').hidden,
  }));
  assert(nav.prev && nav.next, 'the walk buttons appear with a query');
  const landed = () => page.evaluate(() => {
    const at = searchMatches()[searchCursor];
    return at ? at.time : null;
  });
  const step = async dir => {
    await page.evaluate(d => document.getElementById(d > 0 ? 'searchNext' : 'searchPrev').click(), dir);
    await page.waitForTimeout(600);
  };
  await step(1);
  assertEq(await landed(), '2026-09-01 10:06:00', 'the first match is the buried one in Alpha');
  await step(1);
  assertEq(await landed(), '2026-09-01 11:00:00', 'then across to the next thread that matched');
  await step(1);
  assertEq(await landed(), '2026-09-01 10:06:00', 'and it wraps round');
  await step(-1);
  assertEq(await landed(), '2026-09-01 11:00:00', 'the other bracket walks backwards');

  // clearing the search keeps that expansion — it was a real one
  await page.evaluate(() => document.getElementById('searchClear').click());
  await page.waitForTimeout(400);
  s = await state();
  assertEq(s.threads.length, 3, 'every thread is back: ' + JSON.stringify(s.threads));
  const kept = await page.evaluate(() => ({
    deepVisible: (e => !!e && e.getBoundingClientRect().height > 0)(document.getElementById('r20260901100600')),
    marks: document.querySelectorAll('#doc .citem.hit, #doc .citem.hitdeep').length,
    box: document.getElementById('searchInput').value,
  }));
  assert(kept.deepVisible, 'the expansion outlived the search');
  assertEq(kept.marks, 0, 'the magenta markers went with the search');
  assertEq(kept.box, '', 'and the box is empty');

  // a term nobody wrote says so plainly
  await search('zzz-nothing-here');
  s = await state();
  assertEq(s.threads.length, 0, 'no thread survives');
  assert(/nothing contains that/.test(s.bar), 'the bar says why the page is empty: ' + s.bar);
  await page.close();
};
