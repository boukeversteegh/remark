// external updates never move the reading position: mid-page anchors to the
// element at the top of the view, the bottom keeps its distance to the end,
// the very top stays pinned
const { assert } = require('../helpers');

module.exports = async ctx => {
  const filler = n => Array.from({ length: n }, (_, i) => `Filler paragraph ${i} with enough words to take a rendered line.\n`).join('\n');
  const doc = ctx.fixture('anchor.md', [
    '# Anchor',
    '',
    'Intro paragraph.',
    '',
    '## One',
    '',
    filler(10),
    '- [ ] Me (2026-09-01 10:00:00): **T** thread <!--thread-->',
    '',
    '  - Bob (2026-09-01 10:05:00): a reply to anchor on.',
    '',
    '## Two',
    '',
    filler(25),
  ].join('\n'));
  const page = await ctx.open(doc);
  const grow = () => ctx.write(doc, ctx.read(doc).replace('Intro paragraph.',
    'Intro paragraph.\n\nInserted above the fold.\n\nAnd another paragraph.'));

  // mid-page: the anchored comment must not move
  await page.evaluate(() => { document.getElementById('main').scrollTop = 500; });
  await page.waitForTimeout(150);
  const before = await page.evaluate(() => document.getElementById('r20260901100500').getBoundingClientRect().top);
  grow();
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => document.getElementById('r20260901100500').getBoundingClientRect().top);
  assert(Math.abs(after - before) < 2, `mid-page drift ${(after - before).toFixed(1)}px`);

  // bottom: distance to the end holds
  await page.evaluate(() => { const m = document.getElementById('main'); m.scrollTop = m.scrollHeight; });
  await page.waitForTimeout(150);
  const d1 = await page.evaluate(() => { const m = document.getElementById('main'); return m.scrollHeight - m.scrollTop; });
  ctx.write(doc, ctx.read(doc).replace('Inserted above the fold.', 'Inserted above the fold, grown.\n\nWith one more paragraph.'));
  await page.waitForTimeout(1500);
  const d2 = await page.evaluate(() => { const m = document.getElementById('main'); return m.scrollHeight - m.scrollTop; });
  assert(Math.abs(d2 - d1) < 2, `bottom drift ${(d2 - d1).toFixed(1)}px`);

  // top: pinned stays pinned
  await page.evaluate(() => { document.getElementById('main').scrollTop = 0; });
  await page.waitForTimeout(150);
  ctx.write(doc, ctx.read(doc).replace('With one more paragraph.', 'With one more paragraph, edited.'));
  await page.waitForTimeout(1500);
  const top = await page.evaluate(() => document.getElementById('main').scrollTop);
  assert(top === 0, 'top stays pinned, got ' + top);
  await page.close();
};
