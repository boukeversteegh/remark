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

  // focus from the thread header: everything stays, the others dim
  await page.evaluate(() => document.querySelector('#r20260901100000 .focusbtn').click());
  await page.waitForTimeout(300);
  const dimmed = () => page.evaluate(() => ({
    threads: document.querySelectorAll('#doc .thread').length,
    alphaDim: !!document.getElementById('r20260901100000').closest('.dimfocus'),
    betaDim: !!document.getElementById('r20260901110000').closest('.dimfocus'),
    bar: !!document.querySelector('.focusback'),
    label: (document.querySelector('.focuslabel') || {}).textContent,
  }));
  let state = await dimmed();
  assertEq(state.threads, 2, 'both threads stay on screen');
  assert(!state.alphaDim && state.betaDim && state.bar, 'the other thread dims, the way back shows');
  assertEq(state.label, 'Alpha', 'the bar names the thread');

  // Esc returns to the whole document
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  state = await dimmed();
  assert(!state.betaDim && !state.bar, 'nothing dimmed, the bar is gone');

  // double-click a thread card gives it the stage; again gives it back
  const dbl = () => page.evaluate(() => {
    const card = document.getElementById('r20260901110000').closest('#doc .twrap') ||
      document.getElementById('r20260901110000').closest('.thread');
    card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await dbl();
  await page.waitForTimeout(300);
  state = await dimmed();
  assert(state.alphaDim && !state.betaDim, 'double-click focuses the thread');
  await dbl();
  await page.waitForTimeout(300);
  state = await dimmed();
  assert(!state.alphaDim, 'double-click again unfocuses');

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
  state = await dimmed();
  assert(state.alphaDim && !state.betaDim, 'the outline menu focuses its thread');
  await page.close();
};
