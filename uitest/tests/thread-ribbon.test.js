// the thread's left edge carries its state: blue with unread, amber while
// open and read, green once settled, neutral when it has no resolution at all
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('thread-ribbon.md', [
    '# Ribbons',
    '',
    '- [x] Me (2026-09-01 10:00:00): **Settled** <!--thread--> <!--seen:Me-->',
    '  finished and read',
    '',
    '- [ ] Me (2026-09-01 11:00:00): **Open** <!--thread--> <!--seen:Me-->',
    '  still going, nothing unread',
    '',
    '- [ ] Me (2026-09-01 12:00:00): **Unread** <!--thread--> <!--seen:Me-->',
    '  has an unread reply',
    '',
    '  - Bob (2026-09-01 12:05:00): unread by me.',
    '',
    '- Me (2026-09-01 13:00:00): **Plain** <!--thread--> <!--seen:Me-->',
    '  no checkbox, so no resolution state',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  // resolved threads are hidden by default in some setups: make sure not
  await page.evaluate(() => { if (S.hideResolved) document.getElementById('hideResolvedBtn').click(); });
  await page.waitForTimeout(300);

  const cls = id => page.evaluate(i => {
    const card = document.getElementById(i).closest('.thread');
    const edge = getComputedStyle(card, '::before').backgroundColor;
    return { cls: card.className, edge };
  }, id);

  const settled = await cls('r20260901100000');
  assert(/is-resolved/.test(settled.cls), 'a settled thread wears the resolved edge: ' + settled.cls);
  assert(!/is-open|has-unread/.test(settled.cls), 'and nothing else: ' + settled.cls);

  const open = await cls('r20260901110000');
  assert(/is-open/.test(open.cls) && !/is-resolved/.test(open.cls), 'an open thread stays amber: ' + open.cls);

  const unread = await cls('r20260901120000');
  assert(/has-unread/.test(unread.cls) && !/is-resolved/.test(unread.cls),
    'unread outranks resolution: ' + unread.cls);

  const plain = await cls('r20260901130000');
  assert(!/is-resolved|is-open|has-unread/.test(plain.cls),
    'a thread without a checkbox carries no state edge: ' + plain.cls);

  // the settled edge is actually green, not merely classed
  assert(settled.edge !== open.edge && settled.edge !== plain.edge,
    'the resolved edge is its own colour: ' + JSON.stringify([settled.edge, open.edge, plain.edge]));
  const m = settled.edge.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  assert(m && +m[2] > +m[1] && +m[2] > +m[3], 'and that colour is green: ' + settled.edge);
  await page.close();
};
