const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('newthread-seams.md', [
    '# Seams', '', 'A paragraph.', '',
    '- [ ] Me (2026-09-01 10:00:00): FIRST #alpha <!--thread-->', '',
    '- [ ] Me (2026-09-01 11:00:00): SECOND #alpha <!--thread-->', '',
    '- [ ] Me (2026-09-01 12:00:00): THIRD #alpha <!--thread-->', '',
  ].join('\n'));
  const page = await ctx.open(doc);
  const editors = page.locator('.editor[data-key^="new:"]');
  await page.locator('.igap.tgap').nth(0).click();
  assertEq(await editors.count(), 1, 'one seam opens one composer');
  await editors.nth(0).locator('textarea').fill('FIRST-SEAM-DRAFT');
  await page.locator('.igap.tgap').nth(1).click();
  assertEq(await editors.count(), 2, 'second seam has its own composer');
  assertEq(await editors.nth(1).locator('textarea').inputValue(), '', 'drafts are independent');
  await editors.nth(1).locator('textarea').fill('SECOND-SEAM-DRAFT');
  await page.evaluate(() => toggleTag('alpha'));
  await page.getByRole('button', { name: 'New thread at the end of the document', exact: true }).click();
  assertEq(await editors.count(), 3, 'filtered end composer is independent of seams');
  assertEq(await editors.nth(0).locator('textarea').inputValue(), 'FIRST-SEAM-DRAFT', 'first draft survives render');
  assertEq(await editors.nth(1).locator('textarea').inputValue(), 'SECOND-SEAM-DRAFT', 'second draft survives render');
  // a composer opened under a tag filter is seeded with that filter's tags
  // (you type above them) — what matters here is that it carries no OTHER
  // composer's draft
  assertEq(await editors.nth(2).locator('textarea').inputValue(), '\n\n#alpha', 'end composer has no seam draft');
  await page.evaluate(() => toggleTag('alpha'));
  await editors.nth(0).locator('button.send').click();
  await page.waitForFunction(() => document.querySelector('#doc').innerText.includes('FIRST-SEAM-DRAFT') &&
    !S.saving && !S.queue.length &&
    ![...document.querySelectorAll('.editor textarea')].some(e => e.value === 'FIRST-SEAM-DRAFT'));
  const md = ctx.read(doc);
  assert(md.indexOf('FIRST #alpha') < md.indexOf('FIRST-SEAM-DRAFT') &&
    md.indexOf('FIRST-SEAM-DRAFT') < md.indexOf('SECOND #alpha'), 'new thread lands at the selected seam: ' + md);
  assert(!md.includes('SECOND-SEAM-DRAFT'), 'other draft is not sent');
  await page.close();
};
