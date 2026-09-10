// the header and the padding around it are ONE control, in both states: a
// click anywhere in that band folds or unfolds the comment, and hovering it
// tints the whole comment — the same unit the gutter strip folds
const { assert } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('collapsed-click.md', [
    '# Collapse',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **Alpha** <!--thread-->',
    '  the body of the thread',
    '',
    '  - Bob (2026-09-01 10:05:00): a reply with some body text.',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  const reply = '#r20260901100500';

  const state = () => page.evaluate(sel => {
    const el = document.querySelector(sel);
    return { collapsed: el.classList.contains('collapsed'), hot: el.classList.contains('railhot') };
  }, reply);
  // a point inside the header band but outside its text and buttons: the
  // padding strip along the top of the card
  const bandPoint = () => page.evaluate(sel => {
    const r = document.querySelector(sel + ' > .chead').getBoundingClientRect();
    return { x: Math.round(r.left + r.width - 40), y: Math.round(r.top + 2) };
  }, reply);

  // hovering the band tints the whole comment
  let p = await bandPoint();
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(200);
  assert((await state()).hot, 'hovering the header band tints the comment');

  // clicking the padding folds it — this used to do nothing when expanded
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(400);
  assert((await state()).collapsed, 'a click in the padding folds the expanded comment');

  // and the same band unfolds it again
  p = await bandPoint();
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(200);
  assert((await state()).hot, 'the collapsed band highlights the same way');
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(400);
  assert(!(await state()).collapsed, 'and unfolds it from the same place');

  // a composer opened inside a folded comment unfolds it: an editor you
  // cannot see is worse than no editor
  await page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el.classList.contains('collapsed')) el.querySelector(':scope > .chead .twisty').click();
  }, reply);
  await page.waitForTimeout(300);
  assert((await state()).collapsed, 'folded again for the composer check');
  await page.evaluate(sel => document.querySelector(sel + ' .chead .replybtn, ' + sel + ' .replyseed')?.click(), reply);
  await page.evaluate(() => {
    const root = document.getElementById('r20260901100000');
    const gap = root.querySelector('.cbody .igap');
    if (gap) gap.click();
  });
  await page.waitForTimeout(400);
  const composer = await page.evaluate(() => {
    const ed = document.querySelector('.editor[data-key^="ipara:"] textarea');
    return ed ? ed.getBoundingClientRect().height > 0 : null;
  });
  if (composer !== null) assert(composer, 'an interjection composer is visible, not hidden in a folded comment');

  // the band covers the card's full width: the header stretches into the
  // padding rather than sitting inside it
  const spans = await page.evaluate(sel => {
    const el = document.querySelector(sel);
    const h = el.querySelector(':scope > .chead');
    const a = el.getBoundingClientRect(), b = h.getBoundingClientRect();
    return { left: Math.round(b.left - a.left), right: Math.round(a.right - b.right), top: Math.round(b.top - a.top) };
  }, reply);
  assert(Math.abs(spans.left) < 2 && Math.abs(spans.right) < 2 && Math.abs(spans.top) < 2,
    'the header reaches the card edges: ' + JSON.stringify(spans));
  await page.close();
};
