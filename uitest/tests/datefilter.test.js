// the date filter keeps threads with activity in a window, and composes:
// it narrows what the tag filter leaves rather than replacing it, in the
// board and the outline alike
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  // stamps are relative to today, so the presets mean the same thing whenever
  // this runs
  const day = n => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    const p = x => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  };
  const doc = ctx.fixture('datefilter.md', [
    '# Dates',
    '',
    'A paragraph.',
    '',
    '- [ ] Me (' + day(0) + ' 09:00:00): **Fresh** <!--thread--> <!--seen:Me-->',
    '  written today, tagged #alpha',
    '',
    '- [ ] Me (' + day(3) + ' 09:00:00): **Stale** <!--thread--> <!--seen:Me-->',
    '  three days old, tagged #alpha',
    '',
    '- [ ] Me (' + day(40) + ' 09:00:00): **Ancient** <!--thread--> <!--seen:Me-->',
    '  long ago, no tag',
    '',
    '  - Bob (' + day(0) + ' 10:00:00): but answered today. <!--seen:Me-->',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  const titles = () => page.evaluate(() =>
    [...document.querySelectorAll('#outline .otrow .otxt')].map(t => t.textContent));
  const onBoard = () => page.evaluate(() =>
    [...document.querySelectorAll('#doc .thread')].map(t => {
      const el = t.querySelector('.ctitle, .chead .snippet, .chead');
      return (el ? el.textContent : '').trim().slice(0, 30);
    }));

  assertEq((await titles()).length, 3, 'all three threads to begin with');

  // "Today" keeps the fresh thread and the ancient one that was answered today
  await page.evaluate(() => document.getElementById('dateFilterBtn').click());
  await page.waitForSelector('.datemenu', { timeout: 4000 });
  await page.evaluate(() => [...document.querySelectorAll('.datemenu button')]
    .find(b => b.textContent === 'Today').click());
  await page.waitForTimeout(500);
  let t = await titles();
  assert(t.includes('Fresh') && t.includes('Ancient') && !t.includes('Stale'),
    'activity today, not the age of the root: ' + JSON.stringify(t));
  const board = await onBoard();
  assertEq(board.length, 2, 'the board agrees with the outline: ' + JSON.stringify(board));

  // the bar names the window and offers a way out
  const bar = await page.evaluate(() => {
    const c = document.querySelector('#doc .tagbar .datechip');
    return c ? c.textContent : null;
  });
  assert(bar && /today/.test(bar), 'the filter bar names the window: ' + bar);

  // composing: #alpha AND today leaves only Fresh (Ancient has no tag)
  await page.evaluate(() => toggleTag('alpha'));
  await page.waitForTimeout(500);
  t = await titles();
  assertEq(t.join(','), 'Fresh', 'the two filters narrow each other: ' + JSON.stringify(t));
  const chips = await page.evaluate(() =>
    [...document.querySelectorAll('#doc .tagbar .tagchip')].map(c => c.textContent.replace('×', '').trim()));
  assert(chips.some(c => c.startsWith('#alpha')) && chips.some(c => /today/.test(c)),
    'both filters are named in one bar: ' + JSON.stringify(chips));

  // dropping the date leaves the tag filter standing
  await page.evaluate(() => {
    document.querySelector('#doc .tagbar .datechip').click();
  });
  await page.waitForTimeout(500);
  t = await titles();
  assert(t.includes('Fresh') && t.includes('Stale') && !t.includes('Ancient'),
    'only the date filter was dropped: ' + JSON.stringify(t));

  // a custom range: the three-day-old thread only
  await page.evaluate(() => toggleTag('alpha'));
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('dateFilterBtn').click());
  await page.waitForSelector('.datemenu', { timeout: 4000 });
  await page.evaluate(d => {
    const ins = document.querySelectorAll('.datemenu .dmrange input');
    ins[0].value = d.from;
    ins[1].value = d.to;
    document.querySelector('.datemenu .dmgo').click();
  }, { from: day(4), to: day(2) });
  await page.waitForTimeout(500);
  t = await titles();
  assertEq(t.join(','), 'Stale', 'a typed range picks its window: ' + JSON.stringify(t));
  await page.close();
};
