// fenced code renders with syntax colors: the fence's language tag wins,
// and document prose gets the same treatment as comment bodies
const { assert } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('syntax.md', [
    '# Syntax',
    '',
    '```python',
    'def hello():',
    '    return "world"',
    '```',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **Code** <!--thread-->',
    '',
    '  ```go',
    '  func main() { fmt.Println("hi") }',
    '  ```',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  const r = await page.evaluate(() => {
    const prose = document.querySelector('#doc .block pre code');
    const card = document.querySelector('#r20260901100000 .cbody pre code');
    return {
      proseHl: prose && prose.classList.contains('hljs'),
      proseKw: !!(prose && prose.querySelector('.hljs-keyword')),
      cardHl: card && card.classList.contains('hljs'),
      cardKw: !!(card && card.querySelector('.hljs-keyword')),
      cardStr: !!(card && card.querySelector('.hljs-string')),
    };
  });
  assert(r.proseHl && r.proseKw, 'document prose code is highlighted: ' + JSON.stringify(r));
  assert(r.cardHl && r.cardKw && r.cardStr, 'comment-body code is highlighted: ' + JSON.stringify(r));
  await page.close();
};
