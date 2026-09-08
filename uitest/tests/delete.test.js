// deleting your own comment: allowed with only your own replies under it,
// refused when others replied — in the UI and through the CLI alike
const { execFileSync } = require('child_process');
const { assert } = require('../helpers');
const { remarkExe } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('delete.md', [
    '# Delete',
    '',
    '- [ ] Bob (2026-09-01 10:00:00): **Bobs** opening <!--thread-->',
    '',
    '  - Me (2026-09-01 10:01:00): my disposable reply.',
    '',
    '- [ ] Me (2026-09-01 11:00:00): **Guarded** mine, but answered <!--thread-->',
    '',
    '  - Bob (2026-09-01 11:01:00): an answer by someone else.',
    '',
    '- [ ] Me (2026-09-01 12:00:00): **Own** my own little thread <!--thread-->',
    '',
    '  - Me (2026-09-01 12:01:00): my own follow-up.',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  page.on('dialog', d => d.accept());

  // UI: my reply under Bob's root goes after the confirm
  await page.evaluate(() => document.querySelector('#r20260901100100 .delbtn').click());
  await page.waitForTimeout(1500);
  let md = ctx.read(doc);
  assert(!md.includes('my disposable reply'), 'own reply deleted from the file');

  // UI guard: my root with Bob's answer stays, with a warning
  await page.evaluate(() => document.querySelector('#r20260901110000 .delbtn').click());
  await page.waitForTimeout(800);
  md = ctx.read(doc);
  assert(md.includes('an answer by someone else'), 'a thread with replies by others survives');
  assert(md.includes('**Guarded**'), 'the guarded root survives');

  // CLI: my own thread with my own reply goes; Bob's comment is refused
  execFileSync(remarkExe(), ['delete', doc, '12:00:00', '-as', 'Me']);
  md = ctx.read(doc);
  assert(!md.includes('my own little thread') && !md.includes('my own follow-up'),
    'CLI deletes an own subtree');
  let refused = false;
  try {
    execFileSync(remarkExe(), ['delete', doc, '10:00:00', '-as', 'Me'], { stdio: 'pipe' });
  } catch (e) { refused = true; }
  assert(refused, 'CLI refuses to delete someone else\'s comment');
  assert(ctx.read(doc).includes('**Bobs**'), 'the refused comment is untouched');
  await page.close();
};
