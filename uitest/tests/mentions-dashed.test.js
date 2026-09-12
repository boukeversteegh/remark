// regression: a mention chip must cover the whole name. A name that
// continues into a dash is a different name, so @Bob-B is a mention of
// Bob-B, and @Bob-Unknown is nobody — never a chip on @Bob with the rest
// left as loose text.
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('mentions-dashed.md', [
    '# Dashed',
    '',
    '- [ ] Bob (2026-09-01 10:00:00): **Ping** <!--thread-->',
    '  hello',
    '',
    '  - Bob-B (2026-09-01 10:01:00): here',
    '',
    '  - agent-1 (2026-09-01 10:02:00): also here',
    '',
    '  - Me (2026-09-01 10:03:00): @Bob-B and @agent-1 and @Bob, but @Bob-Unknown is nobody',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  const r = await page.evaluate(() => {
    const el = document.getElementById('r20260901100300');
    return {
      chips: [...el.querySelectorAll('.mention')].map(m => m.textContent),
      body: el.querySelector('.cbody').textContent,
    };
  });

  assert(r.chips.includes('@Bob-B'), 'the dashed name is one chip, whole: ' + JSON.stringify(r.chips));
  assert(r.chips.includes('@agent-1'), 'a dashed name that starts lowercase works too: ' + JSON.stringify(r.chips));
  assert(r.chips.includes('@Bob'), 'the plain name is still a chip: ' + JSON.stringify(r.chips));
  assertEq(r.chips.length, 3, 'exactly three chips, so @Bob-Unknown made none: ' + JSON.stringify(r.chips));
  assert(r.body.includes('@Bob-Unknown'), 'an unknown dashed name stays plain text in full');
  await page.close();
};
