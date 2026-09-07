// happy flow: starting a new thread on a paragraph writes a checkbox root
// with the thread marker under that paragraph
const { assert } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('happy-new.md', [
    '# New Thread',
    '',
    'The paragraph under discussion.',
    '',
    'Another paragraph.',
    '',
  ].join('\n'));
  const page = await ctx.open(doc, { noComments: true });
  await page.waitForSelector('.addbtn', { timeout: 8000 });
  await page.evaluate(() => document.querySelector('.addbtn').click());
  await page.waitForSelector('.editor[data-key^="new:"] textarea', { timeout: 4000 });
  await page.fill('.editor[data-key^="new:"] textarea', 'A brand new thread body.');
  await page.click('.editor[data-key^="new:"] button.send');
  await page.waitForTimeout(1500);
  const md = ctx.read(doc);
  const line = md.split(/\r?\n/).find(l => l.includes('A brand new thread body'));
  assert(line, 'thread reached the file');
  assert(/^- \[ \] Me \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\): A brand new thread body\. <!--thread-->/.test(line),
    'checkbox root, signed, stamped, marked: ' + JSON.stringify(line));
  const card = await page.evaluate(() => document.querySelectorAll('.citem').length);
  assert(card >= 1, 'new thread renders');
  await page.close();
};
