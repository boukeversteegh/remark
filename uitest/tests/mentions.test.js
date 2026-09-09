// "@Name" of a known author renders as a mention chip; your own name gets
// the accent; unknown names and code spans stay plain text
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('mentions.md', [
    '# Mentions',
    '',
    '- [ ] Bob (2026-09-01 10:00:00): **Ping** <!--thread-->',
    '  ping @Me and @Bob but not @Nobody, not `@Bob` in code,',
    '  and mail@Bob.example stays an address',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  const r = await page.evaluate(() => {
    const card = document.getElementById('r20260901100000');
    const chips = [...card.querySelectorAll('.mention')].map(m => ({
      text: m.textContent, me: m.classList.contains('me'),
    }));
    return { chips, body: card.querySelector('.cbody').textContent };
  });
  assertEq(r.chips.length, 2, 'exactly the two known authors are chips: ' + JSON.stringify(r.chips));
  assert(r.chips.some(c => c.text === '@Me' && c.me), 'your own mention wears the accent');
  assert(r.chips.some(c => c.text === '@Bob' && !c.me), 'the other author is a plain chip');
  assert(r.body.includes('@Nobody'), 'unknown names stay text');
  await page.close();
};
