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

  // UI: Delete lives inside the edit composer — open edit, confirm the box
  await page.evaluate(() => document.querySelector('#r20260901100100 [title="Edit your comment"]').click());
  await page.waitForSelector('.editor[data-key^="edit:"] .del', { timeout: 4000 });
  await page.click('.editor[data-key^="edit:"] .del');
  await page.waitForSelector('.delconfirm', { timeout: 3000 });
  await page.evaluate(() => {
    [...document.querySelectorAll('.delconfirm button')].find(b => b.textContent.startsWith('Delete')).click();
  });
  await page.waitForTimeout(1500);
  let md = ctx.read(doc);
  assert(!md.includes('my disposable reply'), 'own reply deleted through the composer');

  // the confirmation spells out replies by others before anything goes;
  // Keep leaves everything untouched
  await page.evaluate(() => document.querySelector('#r20260901110000 [title="Edit your comment"]').click());
  await page.waitForSelector('.editor[data-key^="edit:"] .del', { timeout: 4000 });
  await page.click('.editor[data-key^="edit:"] .del');
  await page.waitForSelector('.delconfirm', { timeout: 3000 });
  const box = await page.evaluate(() => document.querySelector('.delconfirm').textContent);
  assert(box.includes('Bob'), 'the box names the other author: ' + box);
  await page.evaluate(() => {
    [...document.querySelectorAll('.delconfirm button')].find(b => b.textContent === 'Keep').click();
  });
  await page.evaluate(() => {
    [...document.querySelectorAll('.editor .cancel')].find(b => b.textContent === 'Cancel').click();
  });
  await page.waitForTimeout(800);
  md = ctx.read(doc);
  assert(md.includes('an answer by someone else'), 'Keep leaves the thread untouched');
  assert(md.includes('**Guarded**'), 'the root survives');

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
