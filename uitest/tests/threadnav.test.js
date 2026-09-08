// the thread gutter has both jumps: to the top, and to the last message
const { assert } = require('../helpers');

module.exports = async ctx => {
  const filler = Array.from({ length: 14 }, (_, i) =>
    `  - Bob (2026-09-01 10:${String(10 + i).padStart(2, '0')}:00): reply number ${i} with a body long enough to take real vertical space on the page.\n`).join('\n');
  const doc = ctx.fixture('threadnav.md', [
    '# Thread Nav',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **Long** opening <!--thread-->',
    '',
    filler,
  ].join('\n'));
  const page = await ctx.open(doc);
  const btns = await page.evaluate(() => ({
    top: !!document.querySelector('.tsticky .ttop:not(.tend)'),
    end: !!document.querySelector('.tsticky .tend'),
  }));
  assert(btns.top && btns.end, 'both gutter jumps exist');

  await page.evaluate(() => document.querySelector('.tsticky .tend').click());
  await page.waitForTimeout(800);
  const afterEnd = await page.evaluate(() => {
    const m = document.getElementById('main');
    const last = document.getElementById('r20260901102300');
    return { scrolled: m.scrollTop > 100, lastTop: Math.round(last.getBoundingClientRect().top) };
  });
  assert(afterEnd.scrolled, 'end jump scrolls down');
  assert(afterEnd.lastTop > 0 && afterEnd.lastTop < 200, 'last message lands near the top, got ' + afterEnd.lastTop);

  await page.evaluate(() => document.querySelector('.tsticky .ttop:not(.tend)').click());
  await page.waitForTimeout(800);
  const backUp = await page.evaluate(() => document.getElementById('main').scrollTop);
  assert(backUp < 120, 'top jump returns to the thread head, got ' + backUp);
  await page.close();
};
