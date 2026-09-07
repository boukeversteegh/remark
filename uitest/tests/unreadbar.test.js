// the thread's unread edge bar paints above the (positioned) comment cards
const { assert } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('unreadbar.md', [
    '# Unread',
    '',
    '- [ ] Bob (2026-09-01 10:00:00): **T** opening by someone else <!--thread-->',
    '',
    '  - Bob (2026-09-01 10:01:00): an unread reply.',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  const r = await page.evaluate(() => {
    const th = document.querySelector('.thread');
    const card = document.querySelector('.citem.unread') || document.querySelector('.citem');
    const cr = card.getBoundingClientRect();
    const hit = document.elementFromPoint(th.getBoundingClientRect().left + 1, cr.top + cr.height / 2);
    return { onTop: hit === th, unread: !!document.querySelector('.citem.unread') };
  });
  assert(r.unread, 'someone else\'s comment is unread');
  assert(r.onTop, 'the edge bar is the topmost paint over the card');
  await page.close();
};
