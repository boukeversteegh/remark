// the sidebar resizes by dragging its right edge, and the width persists
const { assert } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('sidebar.md', [
    '# Sidebar',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **A thread with a fairly long title** <!--thread-->',
    '  body',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  await page.waitForSelector('#outlineDrag', { timeout: 4000 });
  await page.evaluate(() => setZoom(1)); // another test may have left a zoom behind
  await page.waitForTimeout(300);
  const before = await page.evaluate(() =>
    Math.round(document.getElementById('outline').getBoundingClientRect().width));
  await page.evaluate(() => {
    const h = document.getElementById('outlineDrag');
    h.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 268, bubbles: true }));
    h.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 400, bubbles: true }));
    h.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 400, bubbles: true }));
  });
  await page.waitForTimeout(600);
  const after = await page.evaluate(() =>
    Math.round(document.getElementById('outline').getBoundingClientRect().width));
  assert(after > before + 100, `dragging widens the sidebar (${before} -> ${after})`);
  const saved = await (await fetch(`http://127.0.0.1:7461/api/prefs?t=${ctx.token}`)).json();
  assert(saved.outlineW >= 380 && saved.outlineW <= 420, 'the width persists, got ' + saved.outlineW);
  await page.close();
};
