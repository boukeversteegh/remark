// a reply that is nothing but emoji is a REACTION on its parent, never a
// comment — the reader-tag shape. Chips carry a count, clicking toggles your
// own, and reactions share one bare reply with your tags
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('reactions.md', [
    '# Reactions',
    '',
    '- [ ] Bouke (2026-09-01 10:00:00): **Proposal** <!--thread--> <!--seen:Me-->',
    '  what do you think',
    '',
    '  - Codex (2026-09-01 10:01:00): 👍 <!--seen:Me-->',
    '',
    '  - Dana (2026-09-01 10:02:00): 👍 🎉 #important <!--seen:Me-->',
    '',
    '  - Erin (2026-09-01 10:03:00): a real reply, with a 👍 inside it. <!--seen:Me-->',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  const root = '#r20260901100000';

  const chips = () => page.evaluate(sel => [...document.querySelectorAll(sel + ' > .chead .reactchip')]
    .map(c => ({ text: c.textContent, mine: c.classList.contains('mine'), title: c.title })), root);
  const cards = () => page.evaluate(() =>
    [...document.querySelectorAll('#doc .citem')].map(c => c.id).filter(Boolean));

  // the two emoji-only replies became reactions; the prose one stayed a comment
  let c = await chips();
  assertEq(c.length, 2, 'one chip per distinct emoji: ' + JSON.stringify(c));
  assert(/👍\s*2/.test(c[0].text), '👍 counts both who gave it: ' + JSON.stringify(c[0].text));
  assert(/🎉\s*1/.test(c[1].text), 'and 🎉 stands alone: ' + JSON.stringify(c[1].text));
  assert(/Codex/.test(c[0].title) && /Dana/.test(c[0].title), 'the tooltip names them: ' + c[0].title);

  const ids = await cards();
  assert(!ids.includes('r20260901100100') && !ids.includes('r20260901100200'),
    'emoji-only replies are not comments: ' + JSON.stringify(ids));
  assert(ids.includes('r20260901100300'),
    'a reply with prose stays a comment even when it holds an emoji');

  // that same reply also carried a tag: reactions and tags compose
  const tags = await page.evaluate(sel =>
    [...document.querySelectorAll(sel + ' > .chead .tagchip')].map(t => t.textContent), root);
  assert(tags.some(t => t.startsWith('#important')), 'the tag on the emoji reply landed too: ' + JSON.stringify(tags));

  // clicking a chip joins it — written as my own bare reply
  await page.evaluate(sel => document.querySelector(sel + ' > .chead .reactchip').click(), root);
  await page.waitForTimeout(1200);
  c = await chips();
  assert(/👍\s*3/.test(c[0].text) && c[0].mine, 'joining a reaction counts me in: ' + JSON.stringify(c));
  let md = ctx.read(doc);
  assert(/- Me \(20\d\d-\d\d-\d\d \d\d:\d\d:\d\d\): 👍/.test(md), 'it is a plain bare reply:\n' + md);

  // clicking again takes it back, and the emptied reply goes with it
  await page.evaluate(sel => document.querySelector(sel + ' > .chead .reactchip').click(), root);
  await page.waitForTimeout(1200);
  c = await chips();
  assert(/👍\s*2/.test(c[0].text) && !c[0].mine, 'taking it back removes me: ' + JSON.stringify(c));
  md = ctx.read(doc);
  assert(!/- Me \(20\d\d-\d\d-\d\d \d\d:\d\d:\d\d\): 👍/.test(md), 'my emptied reply was removed:\n' + md);

  // the picker lives on an unfolded comment, beside the tag button
  await page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (el.classList.contains('collapsed')) el.querySelector(':scope > .chead .twisty').click();
  }, root);
  await page.waitForTimeout(400);
  await page.evaluate(sel => document.querySelector(sel + ' > .chead .reactadd').click(), root);
  await page.waitForSelector('.emojipick', { timeout: 4000 });
  const pick = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('.emojipick .elabel')].map(l => l.textContent),
    common: [...document.querySelectorAll('.emojipick .erow')]
      .find(r => r.querySelector('.elabel').textContent === 'Common')
      .querySelectorAll('.egrid button').length,
  }));
  assert(pick.rows.includes('Recent'), 'the recents row is there: ' + JSON.stringify(pick.rows));
  assert(pick.rows.includes('Common') && pick.common === 5, 'five common ones in a fixed order');
  assert(pick.rows.length > 3, 'and the category sets: ' + JSON.stringify(pick.rows));

  // picking one from the grid reacts with it
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.emojipick .erow')]
      .find(r => r.querySelector('.elabel').textContent === 'Common');
    [...row.querySelectorAll('.egrid button')].find(b => b.textContent === '🎉').click();
  });
  await page.waitForTimeout(1200);
  c = await chips();
  const party = c.find(x => x.text.startsWith('🎉'));
  assert(party && /🎉\s*2/.test(party.text) && party.mine, 'picked from the grid: ' + JSON.stringify(c));
  await page.close();
};
