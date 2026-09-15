// a tight toolbar must not deform: no label breaks in two, no control is
// crushed, nothing overflows. The search box is the one that gives — down to
// its magnifier — and takes its width back when you click into it.
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('toolbar-narrow.md', [
    '# Narrow',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **A thread** <!--thread--> <!--seen:Me-->',
    '  body',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  const measure = () => page.evaluate(() => {
    const bar = document.getElementById('topbar');
    const hr = document.getElementById('hideResolvedBtn');
    const seg = document.getElementById('modeSeg');
    const sb = document.querySelector('.searchbox');
    return {
      overflow: Math.round(bar.scrollWidth - bar.clientWidth),
      hrLines: hr.getClientRects().length,
      hrHeight: Math.round(hr.getBoundingClientRect().height),
      seg: Math.round(seg.getBoundingClientRect().width),
      search: Math.round(sb.getBoundingClientRect().width),
      labels: [...document.querySelectorAll('#modeSeg .lbl')]
        .filter(l => getComputedStyle(l).display !== 'none').length,
    };
  });

  for (const width of [1280, 1000, 860, 760]) {
    await page.setViewportSize({ width, height: 320 });
    await page.waitForTimeout(250);
    const m = await measure();
    assertEq(m.overflow, 0, 'nothing overflows the toolbar at ' + width + 'px: ' + JSON.stringify(m));
    assertEq(m.hrLines, 1, '"Show resolved" stays on one line at ' + width + 'px: ' + JSON.stringify(m));
    assert(m.hrHeight <= 32, 'and keeps its height at ' + width + 'px: ' + JSON.stringify(m));
    assert(m.seg >= 60, 'the mode switch is never crushed at ' + width + 'px: ' + JSON.stringify(m));
  }

  // wide: the words are there. narrow: icons only, and the search box has
  // shrunk to its magnifier rather than squeezing its neighbours
  await page.setViewportSize({ width: 1280, height: 320 });
  await page.waitForTimeout(250);
  let m = await measure();
  assertEq(m.labels, 2, 'a wide toolbar shows the mode labels');
  assert(m.search > 150, 'and the search box has room: ' + JSON.stringify(m));

  await page.setViewportSize({ width: 760, height: 320 });
  await page.waitForTimeout(250);
  m = await measure();
  assertEq(m.labels, 0, 'a tight toolbar drops the words, keeping the icons');
  assert(m.search < 120, 'the search box gives way first: ' + JSON.stringify(m));
  assert(m.search >= 90, 'but stays wide enough to click into and type: ' + JSON.stringify(m));

  // clicking into it takes the width back
  await page.focus('#searchInput');
  await page.waitForTimeout(250);
  m = await measure();
  assert(m.search > 150, 'focusing the search box expands it: ' + JSON.stringify(m));
  await page.close();
};
