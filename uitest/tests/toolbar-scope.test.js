// Collapse/Expand all act on what is ON SCREEN, the date filter is
// remembered per document across a restart, and code blocks carry a copy
// button that does not fold the comment under it
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const day = n => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    const p = x => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  };
  const doc = ctx.fixture('toolbar-scope.md', [
    '# Scope',
    '',
    '- [ ] Me (' + day(0) + ' 09:00:00): **Fresh** <!--thread--> <!--seen:Me-->',
    '  today, and it holds code',
    '',
    '  ```go',
    '  func main() { fmt.Println("copy me") }',
    '  ```',
    '',
    '  - Bob (' + day(0) + ' 09:30:00): a reply today. <!--seen:Me-->',
    '',
    '- [ ] Me (' + day(9) + ' 09:00:00): **Stale** <!--thread--> <!--seen:Me-->',
    '  nine days back',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  const fold = id => page.evaluate(i => {
    const el = document.getElementById(i);
    return el ? el.classList.contains('collapsed') : null;
  }, id);

  // with "Today" on, only Fresh is on the board
  await page.evaluate(() => document.getElementById('dateFilterBtn').click());
  await page.waitForSelector('.datemenu', { timeout: 4000 });
  await page.evaluate(() => [...document.querySelectorAll('.datemenu button')]
    .find(b => b.textContent === 'Today').click());
  await page.waitForTimeout(500);
  let shown = await page.evaluate(() => document.querySelectorAll('#doc .thread').length);
  assertEq(shown, 1, 'the date filter leaves one thread');

  // Expand all must not touch the thread it cannot see
  await page.evaluate(() => { S.collapsed.set(S.parsed.items[0].key, true); render(); });
  await page.evaluate(() => document.getElementById('expandAll').click());
  await page.waitForTimeout(400);
  assertEq(await fold('r' + day(0).replace(/-/g, '') + '090000'), false, 'the visible thread unfolded');
  let hiddenState = await page.evaluate(k => S.collapsedSaved[k], await page.evaluate(() => {
    const th = S.parsed.blocks.filter(b => b.type === 'thread').map(b => b.thread)
      .find(t => t.title === 'Stale');
    return th.key;
  }));
  assert(hiddenState === undefined, 'the filtered-out thread was left alone: ' + JSON.stringify(hiddenState));

  // Collapse all, same scope
  await page.evaluate(() => document.getElementById('collapseAll').click());
  await page.waitForTimeout(400);
  assertEq(await fold('r' + day(0).replace(/-/g, '') + '090000'), true, 'the visible thread folded');

  // the date filter survives a reload, and a preset stays relative
  await page.reload();
  await page.waitForSelector('#doc .thread', { timeout: 6000 });
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => ({
    threads: document.querySelectorAll('#doc .thread').length,
    preset: S.datePreset,
    chip: (document.querySelector('#doc .tagbar .datechip') || {}).textContent || '',
    from: S.dateFrom,
    todayStart: (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })(),
  }));
  assertEq(after.threads, 1, 'the filter came back with the document');
  assertEq(after.preset, 0, 'and it came back as the preset, not a frozen instant');
  assertEq(after.from, after.todayStart, '"today" still means today after a restart');
  assert(/today/.test(after.chip), 'the chip names it: ' + after.chip);

  // the code block carries a copy button, and using it does not fold anything
  await page.evaluate(() => document.getElementById('expandAll').click());
  await page.waitForTimeout(400);
  const copy = await page.evaluate(() => {
    const b = document.querySelector('#doc .cbody pre > .codecopy');
    if (!b) return null;
    const card = b.closest('.citem');
    b.click();
    return { clicked: true, folded: card.classList.contains('collapsed') };
  });
  assert(copy && copy.clicked, 'a code block has a copy button');
  assert(!copy.folded, 'copying does not fold the comment it sits in');
  await page.waitForTimeout(300);
  const copied = await page.evaluate(async () => {
    const b = document.querySelector('#doc .cbody pre > .codecopy');
    let text = null;
    try { text = await navigator.clipboard.readText(); } catch (e) { text = 'unreadable'; }
    return { done: b.classList.contains('done'), text };
  });
  assert(copied.done, 'the button confirms the copy');
  if (copied.text !== 'unreadable') {
    assert(/copy me/.test(copied.text), 'the clipboard holds the code: ' + JSON.stringify(copied.text));
  }
  await page.close();
};
