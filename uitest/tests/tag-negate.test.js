// -#tag: removing a tag you do not own writes a "-#tag" bare reply that
// negates it for everyone — the author's text is never edited — and the
// negator's × (restore) takes the reply away again
const { assert } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('tag-negate.md', [
    '# Negate',
    '',
    '- [ ] Bob (2026-09-01 10:00:00): **Alpha** this is #urgent stuff <!--thread-->',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);

  const chipState = () => page.evaluate(() => {
    const el = [...document.querySelectorAll('#r20260901100000 .tagchip')]
      .find(e => e.textContent.startsWith('#urgent'));
    return el && {
      negated: el.classList.contains('negated'),
      hasX: !!el.querySelector('.tagx'),
      title: el.title,
    };
  });

  // someone else's authored tag now carries a × too
  let s = await chipState();
  assert(s && !s.negated && s.hasX, 'the × shows on a tag you do not own: ' + JSON.stringify(s));

  // clicking it writes a -#urgent bare reply instead of touching Bob's text
  await page.evaluate(() => {
    [...document.querySelectorAll('#r20260901100000 .tagchip')]
      .find(e => e.textContent.startsWith('#urgent')).querySelector('.tagx').click();
  });
  await page.waitForTimeout(1500);
  let md = ctx.read(doc);
  assert(md.includes('this is #urgent stuff'), 'the author\'s text is untouched');
  assert(md.includes('- Me (') && md.includes('-#urgent'), 'the removal is a -#urgent bare reply: ' + md);

  s = await chipState();
  assert(s && s.negated, 'the chip is struck through: ' + JSON.stringify(s));
  assert(s.title.includes('Me'), 'the tooltip names the remover: ' + s.title);
  const gone = await page.evaluate(() => ({
    cards: document.querySelectorAll('#r20260901100000 .citem').length,
    listed: [...document.querySelectorAll('#taglist option')].map(o => o.value),
  }));
  assert(gone.cards === 0, 'the -#tag reply is not a comment card');
  assert(!gone.listed.includes('urgent'), 'a negated tag leaves the tag list: ' + JSON.stringify(gone.listed));

  // the remover's × restores: the bare reply goes away with it
  await page.evaluate(() => {
    [...document.querySelectorAll('#r20260901100000 .tagchip')]
      .find(e => e.textContent.startsWith('#urgent')).querySelector('.tagx').click();
  });
  await page.waitForTimeout(1500);
  md = ctx.read(doc);
  assert(!md.includes('-#urgent'), 'restoring deletes the emptied bare reply');
  s = await chipState();
  assert(s && !s.negated, 'the tag is effective again: ' + JSON.stringify(s));
  await page.close();
};
