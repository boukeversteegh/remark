// filtering by tag keeps a way to start a new thread (at the document end)
const { assert } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('tagfilter.md', [
    '# Tag Filter',
    '',
    'A paragraph.',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **Tagged** about #alpha <!--thread-->',
    '',
    '- [ ] Me (2026-09-01 11:00:00): **Plain** untagged thread <!--thread-->',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  await page.evaluate(() => toggleTag('alpha'));
  await page.waitForTimeout(300);
  const filtered = await page.evaluate(() => ({
    threads: document.querySelectorAll('#doc .thread').length,
    btn: !!document.querySelector('#doc .newthreadbtn'),
  }));
  assert(filtered.threads === 1, 'filter shows only the tagged thread');
  assert(filtered.btn, 'a new-thread button survives the filter');

  await page.evaluate(() => document.querySelector('#doc .newthreadbtn').click());
  await page.waitForSelector('.editor[data-key^="new:"] textarea', { timeout: 4000 });
  await page.fill('.editor[data-key^="new:"] textarea', 'BORN-UNDER-FILTER');
  await page.click('.editor[data-key^="new:"] button.send');
  await page.waitForTimeout(1500);
  const md = ctx.read(doc);
  const line = md.split(/\r?\n/).find(l => l.includes('BORN-UNDER-FILTER'));
  assert(line && /^- \[ \] Me \(\d{4}/.test(line), 'thread written while filtered: ' + JSON.stringify(line));
  await page.close();
};
