// a task list pasted into a comment body stays a task list: no comment
// cards, no auto-stamping — while an authored nested opener stays a comment
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('checklist.md', [
    '# Checklist',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **Tasks** my list: <!--thread-->',
    '',
    '  - [ ] `Some/Path/ — File.cs:35-37; writers A + B`',
    '  - [ ] plain task item',
    '  - [x] a done one',
    '',
    '  A paragraph after the list.',
    '',
    '  - Bob (2026-09-01 10:01:00): a real reply.',
    '',
    '    - [ ] Bob (2026-09-01 10:02:00): an authored nested opener.',
    '',
  ].join('\n'));
  const before = ctx.read(doc);
  const page = await ctx.open(doc);
  await page.waitForTimeout(3500); // past the auto-stamp window

  const r = await page.evaluate(() => ({
    comments: document.querySelectorAll('.citem').length,
    boxes: document.querySelectorAll('#r20260901100000 .cbody input[type=checkbox]').length,
    opener: !!document.getElementById('r20260901100200'),
  }));
  assertEq(r.comments, 3, 'root + reply + authored opener only');
  assertEq(r.boxes, 3, 'checklist renders as checkboxes in the body');
  assert(r.opener, 'authored nested opener is a comment');
  assertEq(ctx.read(doc), before, 'file untouched — nothing auto-stamped');
  await page.close();
};
