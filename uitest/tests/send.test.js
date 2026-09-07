// sending a reply through the composer writes it to the file at the right
// place, signed and uniquely stamped
const { assert } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('send.md', [
    '# Send',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **T** opening <!--thread-->',
    '',
    '  - Bob (2026-09-01 10:01:00): a reply.',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  await page.focus('#r20260901100000 > .cfoot .replyseed');
  await page.waitForSelector('#r20260901100000 > .editor textarea', { timeout: 4000 });
  await page.fill('#r20260901100000 > .editor textarea', 'REPLY-FROM-TEST');
  await page.click('#r20260901100000 > .editor button.send');
  await page.waitForTimeout(1500);
  const md = ctx.read(doc);
  const line = md.split(/\r?\n/).find(l => l.includes('REPLY-FROM-TEST'));
  assert(line, 'reply reached the file');
  assert(/^  - Me \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\): REPLY-FROM-TEST/.test(line),
    'signed, seconds-stamped, at child indent: ' + JSON.stringify(line));
  await page.close();
};
