// a UTF-8 BOM must not glue itself to the first "# Header": the window and
// the CLI both parse past it, and every write puts it back untouched
const { assert, assertEq, remarkExe } = require('../helpers');
const { execFileSync } = require('child_process');

module.exports = async ctx => {
  const doc = ctx.fixture('bom.md', '\uFEFF' + [
    '# Bom',
    '',
    'A paragraph.',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **Alpha** <!--thread-->',
    '  the thread body',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);

  const heads = await page.evaluate(() =>
    [...document.querySelectorAll('#doc h1')].map(h => h.textContent.trim()));
  assert(heads.includes('Bom'), 'the first heading renders despite the BOM: ' + JSON.stringify(heads));

  // a CLI write keeps the signature (writeWithRetry restores it)
  execFileSync(remarkExe(), ['reply', doc, '2026-09-01 10:00:00', '-as', 'Bob', '-text', 'via cli']);
  let md = ctx.read(doc);
  assertEq(md.charCodeAt(0), 0xfeff, 'the BOM survives a CLI reply');
  assert(md.includes('via cli'), 'the reply landed');

  // a window write keeps it too (denormEol restores it on save)
  await page.waitForTimeout(1800); // let the live reload bring the reply in
  // the unread CLI reply arms a confirm on the first click; the second acts
  await page.evaluate(() => document.querySelector('#r20260901100000 .chead .rstat').click());
  await page.waitForTimeout(200);
  await page.evaluate(() => document.querySelector('#r20260901100000 .chead .rstat').click());
  await page.waitForTimeout(1500);
  md = ctx.read(doc);
  assertEq(md.charCodeAt(0), 0xfeff, 'the BOM survives a window save');
  assert(md.includes('- [x] Me (2026-09-01 10:00:00)'),
    'the toggle wrote through: ' + JSON.stringify(md.slice(0, 220)));
  assert(md.slice(1).startsWith('# Bom'), 'the header still opens line one, right after the BOM');
  await page.close();
};
