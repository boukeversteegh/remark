// regression: the What's new panel always fits the window, so its header —
// which carries Restart and the close button — is reachable. It used to be
// capped in vh, and CSS zoom multiplies vh, so at 150%+ the panel grew
// taller than the screen and its header sat above the top edge.
const { assert } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('whatsnew-fits.md', [
    '# Panel',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **Anchor** a comment <!--thread-->',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  await page.setViewportSize({ width: 900, height: 640 });

  // a long changelog, whatever this machine's build knows: the layout is
  // what is under test, not the entry source
  await page.evaluate(() => {
    const entries = [];
    for (let i = 0; i < 40; i++) {
      entries.push({
        date: '2026-09-' + String(1 + (i % 9)).padStart(2, '0'),
        title: 'Entry number ' + i + ' with a reasonably long headline',
        body: 'A paragraph of the kind the changelog actually carries, long enough to wrap over two or three lines in the panel body.',
      });
    }
    const orig = window.fetch;
    window.fetch = (u, o) => String(u).includes('/api/whatsnew')
      ? Promise.resolve({ json: () => Promise.resolve({ ok: true, entries }) })
      : orig(u, o);
  });

  const measure = async zoom => {
    await page.evaluate(z => {
      const p = document.getElementById('whatsnew');
      if (p) p.remove();
      setZoom(z);
      showWhatsNew();
    }, zoom);
    await page.waitForSelector('#whatsnew .wnentry, #whatsnew .wnnote', { timeout: 8000 });
    await page.waitForTimeout(150);
    return page.evaluate(() => {
      const p = document.getElementById('whatsnew');
      const c = p.querySelector('.wnclose');
      const r = p.getBoundingClientRect();
      const cr = c.getBoundingClientRect();
      const hit = document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2);
      return {
        top: Math.round(r.top), bottom: Math.round(r.bottom),
        closeTop: Math.round(cr.top), closeBottom: Math.round(cr.bottom),
        vh: window.innerHeight,
        reachable: !!hit && !!hit.closest('.wnclose'),
        scrolls: p.querySelector('.wnbody').scrollHeight > p.querySelector('.wnbody').clientHeight + 1,
      };
    });
  };

  for (const zoom of [1, 1.3, 1.7, 2.5]) {
    const m = await measure(zoom);
    const at = ' at ' + Math.round(zoom * 100) + '%';
    assert(m.top >= -1, 'panel top on screen' + at + ' (top ' + m.top + ', window ' + m.vh + ')');
    assert(m.bottom <= m.vh + 1, 'panel bottom on screen' + at + ' (bottom ' + m.bottom + ', window ' + m.vh + ')');
    assert(m.closeTop >= -1 && m.closeBottom <= m.vh + 1, 'close button on screen' + at + ' (' + m.closeTop + '-' + m.closeBottom + ')');
    assert(m.reachable, 'close button is clickable, nothing over it' + at);
    assert(m.scrolls, 'the entry list scrolls inside the panel' + at);
  }

  // and it really closes
  await page.click('#whatsnew .wnclose');
  await page.waitForTimeout(100);
  const gone = await page.evaluate(() => !document.getElementById('whatsnew'));
  assert(gone, 'clicking the close button dismisses the panel');
  await page.close();
};
