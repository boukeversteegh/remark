// regression: on a phone the composer's buttons must stay on screen. The
// footer was one flex row that never wrapped, so Send ran off the right
// edge. Preview, Discard and Send wrap as one group.
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('composer-buttons-fit.md', [
    '# Composer',
    '',
    '- [ ] Bob (2026-09-01 10:00:00): **Ping** <!--thread-->',
    '  hello',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);

  const openComposer = async () => {
    await page.evaluate(() => {
      const root = document.getElementById('r20260901100000');
      if (root.classList.contains('collapsed')) root.querySelector('.chead .twisty').click();
    });
    await page.waitForTimeout(150);
    await page.focus('#r20260901100000 > .cfoot .replyseed');
    await page.waitForSelector('#r20260901100000 > .editor .ebar button.send', { timeout: 6000 });
    await page.waitForTimeout(150);
  };

  const measure = () => page.evaluate(() => {
    const bar = document.querySelector('#r20260901100000 > .editor .ebar');
    const btn = sel => {
      const b = bar.querySelector(sel);
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), mid: Math.round(r.top + r.height / 2), w: Math.round(r.width) };
    };
    return {
      send: btn('button.send'),
      discard: btn('button.cancel:not(.del)'),
      preview: btn('button'),
      vw: document.documentElement.clientWidth,
      barRight: Math.round(bar.getBoundingClientRect().right),
    };
  });

  await page.setViewportSize({ width: 390, height: 740 });
  await page.waitForTimeout(200);
  await openComposer();
  const m = await measure();

  assert(m.send, 'the send button exists');
  assert(m.send.right <= m.vw, 'Send is on screen: right ' + m.send.right + ' of ' + m.vw);
  assert(m.send.left >= 0, 'Send starts on screen: left ' + m.send.left);
  assert(m.send.w > 40, 'Send is not squeezed to nothing: ' + m.send.w + 'px');
  assert(m.preview.right <= m.vw && m.discard.right <= m.vw, 'Preview and Discard are on screen too');
  // wrapping together means one row for the three of them; they differ in
  // height, so compare the line they sit on, not their top edge
  const sameLine = (a, b) => Math.abs(a.mid - b.mid) <= 4;
  assert(sameLine(m.send, m.discard), 'Send and Discard share a line: ' + m.send.mid + ' vs ' + m.discard.mid);
  assert(sameLine(m.send, m.preview), 'Preview joins them on that line: ' + m.preview.mid);

  // a wide window keeps the old single-line footer
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.waitForTimeout(200);
  const wide = await measure();
  assert(wide.send.right <= wide.vw, 'Send stays on screen when wide');
  assert(Math.abs(wide.send.mid - wide.preview.mid) <= 4, 'one line when there is room');
  await page.close();
};
