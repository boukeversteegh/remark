// single-thread mode: a toolbar toggle shows one thread on the board while
// the outline keeps every row (others dimmed) and a single click switches
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('focus.md', [
    '# Focus',
    '',
    '## One',
    '',
    'Para one.',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **Alpha** <!--thread-->',
    '  the first thread',
    '',
    '## Two',
    '',
    'Para two.',
    '',
    '- [ ] Me (2026-09-01 11:00:00): **Beta** <!--thread-->',
    '  the second thread',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  const state = () => page.evaluate(() => ({
    alpha: !!document.getElementById('r20260901100000'),
    beta: !!document.getElementById('r20260901110000'),
    bar: !!document.querySelector('.focusback'),
    btnOn: document.getElementById('focusModeBtn').classList.contains('active'),
    rows: [...document.querySelectorAll('#outline .otrow')].map(r =>
      r.querySelector('.otxt').textContent +
      (r.classList.contains('dimfocus') ? ':dim' : r.classList.contains('focused') ? ':focused' : '')),
  }));

  // the toolbar toggle enters the mode on the current thread
  await page.evaluate(() => document.getElementById('focusModeBtn').click());
  await page.waitForTimeout(300);
  let s = await state();
  assert(s.alpha && !s.beta && s.bar && s.btnOn, 'one thread on the board, button lit');
  assert(s.rows.includes('Alpha:focused') && s.rows.includes('Beta:dim'),
    'the outline keeps every row: ' + JSON.stringify(s.rows));

  // a single click on another row switches the focus
  await page.evaluate(() => {
    [...document.querySelectorAll('#outline .otrow')]
      .find(r => r.querySelector('.otxt').textContent === 'Beta').click();
  });
  await page.waitForTimeout(300);
  s = await state();
  assert(s.beta && !s.alpha, 'a click switches the focused thread');
  assert(s.rows.includes('Beta:focused') && s.rows.includes('Alpha:dim'), 'the outline follows');

  // Esc leaves; the toggle leaves too
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  s = await state();
  assert(s.alpha && s.beta && !s.bar && !s.btnOn, 'Esc returns the whole document');
  await page.evaluate(() => document.getElementById('focusModeBtn').click());
  await page.waitForTimeout(200);
  await page.evaluate(() => document.getElementById('focusModeBtn').click());
  await page.waitForTimeout(300);
  s = await state();
  assert(s.alpha && s.beta && !s.btnOn, 'the toggle leaves the mode as well');
  await page.close();
};
