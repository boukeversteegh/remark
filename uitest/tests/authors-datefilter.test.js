// the Authors panel follows the date filter: an offline author with nothing
// inside the window is not part of what you are looking at. Online names and
// your own row stay regardless, and the list says what it dropped.
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const day = n => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    const p = x => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  };
  const doc = ctx.fixture('authors-datefilter.md', [
    '# Authors',
    '',
    'A paragraph.',
    '',
    '- [ ] Me (' + day(0) + ' 09:00:00): **Fresh** <!--thread--> <!--seen:Me-->',
    '  written today',
    '',
    '  - Bob (' + day(0) + ' 10:00:00): still around. <!--seen:Me-->',
    '',
    '    - Dave (' + day(0) + ' 10:05:00): 👍',
    '',
    '- [ ] Carol (' + day(40) + ' 09:00:00): **Ancient** <!--thread--> <!--seen:Me-->',
    '  long gone',
    '',
    '  - Erin (' + day(40) + ' 09:30:00): and so am I. <!--seen:Me-->',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  const names = () => page.evaluate(() =>
    [...document.querySelectorAll('#outline .presence .prow:not(.pnote) .pname')]
      .map(n => n.textContent.replace(' (you)', '').trim()));
  const note = () => page.evaluate(() => {
    const n = document.querySelector('#outline .presence .pnote');
    return n ? n.textContent : null;
  });

  let who = await names();
  for (const n of ['Bob', 'Dave', 'Carol', 'Erin']) {
    assert(who.includes(n), n + ' is in the list to begin with: ' + JSON.stringify(who));
  }
  assertEq(await note(), null, 'nothing is hidden without a filter');

  // "Today": Carol and Erin wrote nothing inside it
  await page.evaluate(() => document.getElementById('dateFilterBtn').click());
  await page.waitForSelector('.datemenu', { timeout: 4000 });
  await page.evaluate(() => [...document.querySelectorAll('.datemenu button')]
    .find(b => b.textContent === 'Today').click());
  await page.waitForTimeout(500);

  who = await names();
  assert(who.includes('Bob'), 'Bob wrote today: ' + JSON.stringify(who));
  // a bare emoji reply is a reaction, not a comment — but it is still a sign
  // of life, and the walk has to reach it
  assert(who.includes('Dave'), 'Dave reacted today: ' + JSON.stringify(who));
  assert(!who.includes('Carol') && !who.includes('Erin'),
    'the forty-day-old thread takes its authors with it: ' + JSON.stringify(who));

  const n = await note();
  assert(n && /^2 authors outside/.test(n), 'the panel says what it dropped: ' + n);

  // the line is the way back
  await page.evaluate(() => document.querySelector('#outline .presence .pnote').click());
  await page.waitForTimeout(500);
  who = await names();
  assert(who.includes('Carol') && who.includes('Erin'),
    'clicking the note clears the filter: ' + JSON.stringify(who));
  assertEq(await note(), null, 'and the note goes with it');

  // a window that contains only the old thread keeps only its authors
  await page.evaluate(() => document.getElementById('dateFilterBtn').click());
  await page.waitForSelector('.datemenu', { timeout: 4000 });
  await page.evaluate(d => {
    const ins = document.querySelectorAll('.datemenu .dmrange input');
    ins[0].value = d.from;
    ins[1].value = d.to;
    document.querySelector('.datemenu .dmgo').click();
  }, { from: day(41), to: day(39) });
  await page.waitForTimeout(500);
  who = await names();
  assert(who.includes('Carol') && who.includes('Erin'),
    'a past window is a window like any other: ' + JSON.stringify(who));
  assert(!who.includes('Bob') && !who.includes('Dave'),
    "today's authors are outside it: " + JSON.stringify(who));
  await page.close();
};
