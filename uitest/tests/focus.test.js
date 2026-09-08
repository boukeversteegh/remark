// focus: one thread gets the stage (others dim), from the thread header,
// a double-click, or the outline menu; Esc or the bar gives it back
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
    label: (document.querySelector('.focuslabel') || {}).textContent,
    rows: [...document.querySelectorAll('#outline .otrow')].map(r =>
      r.querySelector('.otxt').textContent + (r.classList.contains('dimfocus') ? ':dim' : r.classList.contains('focused') ? ':focused' : '')),
  }));

  // focus from the thread header: the board shows only that thread, the
  // outline keeps every row with the others dimmed
  await page.evaluate(() => document.querySelector('#r20260901100000 .focusbtn').click());
  await page.waitForTimeout(300);
  let s = await state();
  assert(s.alpha && !s.beta && s.bar, 'the board shows only the focused thread');
  assertEq(s.label, 'Alpha', 'the bar names the thread');
  assert(s.rows.includes('Alpha:focused') && s.rows.includes('Beta:dim'),
    'the outline keeps every row, others dimmed: ' + JSON.stringify(s.rows));

  // Esc returns to the whole document
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  s = await state();
  assert(s.alpha && s.beta && !s.bar, 'the whole document is back');

  // double-click an OUTLINE row gives its thread the board; again gives
  // it back (cards themselves stay double-click-free for text selection)
  const dblRow = name => page.evaluate(n => {
    const r = [...document.querySelectorAll('#outline .otrow')]
      .find(x => x.querySelector('.otxt').textContent === n);
    r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  }, name);
  await dblRow('Beta');
  await page.waitForTimeout(300);
  s = await state();
  assert(s.beta && !s.alpha, 'outline double-click focuses the thread');
  await dblRow('Beta');
  await page.waitForTimeout(300);
  s = await state();
  assert(s.alpha && s.beta, 'outline double-click again unfocuses');

  // focus from the outline menu
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#outline .otrow')];
    const beta = rows.find(r => r.querySelector('.otxt').textContent === 'Beta');
    beta.querySelector('.omenu').click();
  });
  await page.waitForSelector('#omenupop', { timeout: 3000 });
  await page.evaluate(() => {
    [...document.querySelectorAll('#omenupop button')]
      .find(b => b.textContent === 'Focus this thread').click();
  });
  await page.waitForTimeout(300);
  s = await state();
  assert(s.beta && !s.alpha, 'the outline menu focuses its thread');

  // and the outline switches focus directly, without leaving focus mode
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#outline .otrow')];
    const alpha = rows.find(r => r.querySelector('.otxt').textContent === 'Alpha');
    alpha.querySelector('.omenu').click();
  });
  await page.waitForSelector('#omenupop', { timeout: 3000 });
  await page.evaluate(() => {
    [...document.querySelectorAll('#omenupop button')]
      .find(b => b.textContent === 'Focus this thread').click();
  });
  await page.waitForTimeout(300);
  s = await state();
  assert(s.alpha && !s.beta, 'the outline switches the focus');

  // the focused row's menu offers Unfocus
  await page.evaluate(() => {
    const r = [...document.querySelectorAll('#outline .otrow')]
      .find(x => x.querySelector('.otxt').textContent === 'Alpha');
    r.querySelector('.omenu').click();
  });
  await page.waitForSelector('#omenupop', { timeout: 3000 });
  await page.evaluate(() => {
    [...document.querySelectorAll('#omenupop button')]
      .find(b => b.textContent === 'Unfocus').click();
  });
  await page.waitForTimeout(300);
  s = await state();
  assert(s.alpha && s.beta && !s.bar, 'Unfocus from the menu returns the document');
  await page.close();
};
