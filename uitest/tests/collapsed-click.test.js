// a collapsed comment expands from anywhere between the dividers — the
// padding around the compact head included, not just the head's own strip
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

  // collapse the reply via its header, then click the card ITSELF (the
  // padding band, not the head) to expand it again
  await page.evaluate(sel => {
    document.querySelector(sel + ' > .chead').click();
  }, reply);
  await page.waitForTimeout(300);
  let s = await page.evaluate(sel => ({
    collapsed: document.querySelector(sel).classList.contains('collapsed'),
  }), reply);
  assert(s.collapsed, 'the header click collapsed the reply');

  await page.evaluate(sel => {
    const el = document.querySelector(sel);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, reply);
  await page.waitForTimeout(300);
  s = await page.evaluate(sel => ({
    collapsed: document.querySelector(sel).classList.contains('collapsed'),
  }), reply);
  assert(!s.collapsed, 'a click on the band itself expands it');
  await page.close();
};
