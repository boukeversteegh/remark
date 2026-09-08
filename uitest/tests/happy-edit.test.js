// happy flow: editing your own comment rewrites its body in the file
const { assert } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('happy-edit.md', [
    '# Edit',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **Mine** the original text <!--thread-->',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  // a lone, fully-read thread starts collapsed — expand it first
  await page.evaluate(() => {
    const root = document.getElementById('r20260901100000');
    if (root.classList.contains('collapsed')) root.querySelector('.chead .twisty').click();
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => document.querySelector('#r20260901100000 [title="Edit your comment"]').click());
  await page.waitForSelector('.editor[data-key^="edit:"] textarea', { timeout: 4000 });
  // the edit composer replaces the body: it sits at the text column, not
  // at the reply inset — no phantom nesting while editing
  const align = await page.evaluate(() => {
    const ta = document.querySelector('.editor[data-key^="edit:"] textarea');
    const card = document.getElementById('r20260901100000');
    return Math.round(ta.getBoundingClientRect().left - card.getBoundingClientRect().left);
  });
  const { assert: assert2 } = require('../helpers');
  assert2(align < 20, 'the edit composer aligns with the body, inset ' + align + 'px');
  const pre = await page.inputValue('.editor[data-key^="edit:"] textarea');
  assert(pre.includes('the original text'), 'composer prefilled with the body');
  await page.fill('.editor[data-key^="edit:"] textarea', pre.replace('the original text', 'the corrected text'));
  await page.click('.editor[data-key^="edit:"] button.send');
  await page.waitForTimeout(1500);
  const md = ctx.read(doc);
  assert(md.includes('the corrected text'), 'edited body reached the file');
  assert(!md.includes('the original text'), 'old body gone');
  assert(md.includes('Me (2026-09-01 10:00:00):'), 'stamp survives the edit');
  await page.close();
};
