// happy flow: opening a document renders its content, its threads and the outline
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('happy-open.md', [
    '# My Document',
    '',
    'An intro paragraph.',
    '',
    '## Section A',
    '',
    'Some content in section A.',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **First thread** <!--thread-->',
    '  a question about section A.',
    '',
    '  - Bob (2026-09-01 10:01:00): an answer.',
    '',
    '## Section B',
    '',
    'More content.',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);
  const r = await page.evaluate(() => ({
    h1: !!document.querySelector('#doc h1'),
    sections: [...document.querySelectorAll('#outline [data-spy]')].length,
    threadTitle: (document.querySelector('.thread .ctitlebar') || {}).textContent,
    cards: document.querySelectorAll('.citem').length,
    pill: !!document.querySelector('.thread .rstat'),
  }));
  assert(r.h1, 'heading rendered');
  assert(r.sections >= 2, 'outline lists the sections, got ' + r.sections);
  assert(String(r.threadTitle).includes('First thread'), 'thread title shown');
  assertEq(r.cards, 2, 'root and reply render as cards');
  assert(r.pill, 'resolution pill present');
  assertEq(page.errors.length, 0, 'no page errors: ' + page.errors.join(' | '));
  await page.close();
};
