// remark edit <sel> -title: sets the standalone title on a thread root,
// replacing inline titles and moving inline prose into the body
const { execFileSync } = require('child_process');
const { assert, assertEq, remarkExe } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('edit-title.md', [
    '# Edit Title',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **Old title** with prose after it <!--thread--> <!--seen:Bob-->',
    '',
    '  - Bob (2026-09-01 10:01:00): a reply.',
    '',
    '- [ ] Me (2026-09-01 11:00:00): an untitled thread about nothing <!--thread-->',
    '',
  ].join('\n'));

  execFileSync(remarkExe(), ['edit', doc, '10:00:00', '-title', 'Proper Title']);
  execFileSync(remarkExe(), ['edit', doc, '11:00:00', '-title', 'Second Title']);
  const md = ctx.read(doc);
  const lines = md.split(/\r?\n/);
  assertEq(lines[2], '- [ ] Me (2026-09-01 10:00:00): **Proper Title** <!--thread--> <!--seen:Bob-->',
    'title standalone, markers kept');
  assertEq(lines[3], '  with prose after it', 'inline prose moved into the body');
  assert(lines.some(l => l === '- [ ] Me (2026-09-01 11:00:00): **Second Title** <!--thread-->'),
    'untitled root gains a title');
  assert(lines.some(l => l === '  an untitled thread about nothing'), 'its text becomes body');

  // the window renders both as real title bars
  const page = await ctx.open(doc);
  const bars = await page.evaluate(() =>
    [...document.querySelectorAll('.ctitlebar')].map(x => x.textContent));
  assert(bars.includes('Proper Title') && bars.includes('Second Title'),
    'titles render as title bars: ' + JSON.stringify(bars));
  await page.close();
};
