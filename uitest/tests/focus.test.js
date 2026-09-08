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
    '  - Bob (2026-09-01 10:05:00): unread in alpha.',
    '',
    '## Two',
    '',
    'Para two.',
    '',
    '- [ ] Me (2026-09-01 11:00:00): **Beta** <!--thread-->',
    '  the second thread',
    '',
    '  - Bob (2026-09-01 11:05:00): unread in beta.',
    '',
    '- [x] Me (2026-09-01 12:00:00): **Settled** resolved and quiet <!--thread--> <!--seen:Me-->',
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

  const pill = () => page.evaluate(() => document.getElementById('unreadBtn').textContent.trim());
  assertEq(await pill(), '2 unread', 'the pill counts everything before focusing');

  // the toolbar toggle enters the mode on the current thread
  await page.evaluate(() => document.getElementById('focusModeBtn').click());
  await page.waitForTimeout(300);
  let s = await state();
  assert(s.alpha && !s.beta && s.bar && s.btnOn, 'one thread on the board, button lit');
  assertEq(await pill(), '1 unread', 'the pill counts only the visible thread');
  assert(s.rows.includes('Alpha:focused') && s.rows.includes('Beta:dim'),
    'the outline keeps its visible rows: ' + JSON.stringify(s.rows));
  assert(!s.rows.some(r => r.startsWith('Settled')),
    'focus never reveals rows the filters hide: ' + JSON.stringify(s.rows));

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

  // creating a thread while focused moves the focus onto it
  await page.evaluate(() => document.getElementById('focusModeBtn').click());
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('#outline .onew').click());
  await page.waitForSelector('.editor[data-key^="new:"] textarea', { timeout: 4000 });
  await page.fill('.editor[data-key^="new:"] textarea', 'BORN-IN-FOCUS');
  await page.click('.editor[data-key^="new:"] button.send');
  await page.waitForTimeout(1500);
  const born = await page.evaluate(() => ({
    threads: document.querySelectorAll('#doc .thread').length,
    text: [...document.querySelectorAll('#doc .thread')].some(t => t.textContent.includes('BORN-IN-FOCUS')),
    bar: !!document.querySelector('.focusback'),
  }));
  assert(born.threads === 1 && born.text && born.bar,
    'the new thread takes the focus: ' + JSON.stringify(born));
  await page.close();
};
