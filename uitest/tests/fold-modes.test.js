// the fold button carries three depths: the click folds thread roots as it
// always did, and the popover adds every level, and every level with
// nothing unread below it.
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('fold-modes.md', [
    '# Folding',
    '',
    '- [ ] Bob (2026-09-01 10:00:00): **Read one** all of it read <!--thread--> <!--seen:Me-->',
    '',
    '  - Bob (2026-09-01 10:01:00): an old reply. <!--seen:Me-->',
    '',
    '- [ ] Bob (2026-09-01 11:00:00): **Unread one** something new <!--thread--> <!--seen:Me-->',
    '',
    '  - Bob (2026-09-01 11:01:00): a reply nobody read yet.',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  const state = () => page.evaluate(() => {
    const g = id => {
      const el = document.getElementById(id);
      return el ? el.classList.contains('collapsed') : null;
    };
    return { readRoot: g('r20260901100000'), readKid: g('r20260901100100'),
             newRoot: g('r20260901110000'), newKid: g('r20260901110100') };
  });

  const pick = async mode => {
    await page.evaluate(() => { document.querySelectorAll('.citem').forEach(e => e.classList.remove('collapsed')); });
    await page.evaluate(m => foldAll(m), mode);
    await page.waitForTimeout(250);
    return state();
  };

  const threads = await pick('threads');
  assertEq(threads.readRoot, true, 'roots fold');
  assertEq(threads.newRoot, true, 'both roots fold');

  const all = await pick('all');
  assertEq(all.readKid, true, 'every level folds');
  assertEq(all.newKid, true, 'the unread reply folds too under "all"');

  const read = await pick('read');
  assertEq(read.readRoot, true, 'a thread with nothing unread folds');
  assertEq(read.newRoot, false, 'a thread holding an unread comment stays open');
  assertEq(read.newKid, false, 'and so does the unread comment itself');

  // the popover: hover opens it, and it names the three depths
  await page.hover('#collapseAll');
  await page.waitForSelector('.foldmenu', { timeout: 3000 });
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('.foldmenu .foldopt')].map(b => b.textContent.trim()));
  assertEq(labels.length, 3, 'three options: ' + JSON.stringify(labels));
  assert(labels.some(l => l.startsWith('Fold read comments')), 'the read option is named: ' + JSON.stringify(labels));

  // and it floats: the toolbar keeps its shape
  const moved = await page.evaluate(() => {
    const b = document.getElementById('expandAll').getBoundingClientRect();
    return { x: Math.round(b.left), y: Math.round(b.top) };
  });
  await page.evaluate(() => { document.querySelector('.foldmenu [data-mode="read"]').click(); });
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => {
    const b = document.getElementById('expandAll').getBoundingClientRect();
    return { x: Math.round(b.left), y: Math.round(b.top) };
  });
  assertEq(JSON.stringify(after), JSON.stringify(moved), 'the neighbouring button never moved');
  await page.close();
};
