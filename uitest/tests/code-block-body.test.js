// a comment whose body is only a fenced code block must be written as
// markdown anyone can read: the fence never sits inline after "Author:",
// opening and closing backticks share one indent, and a blank line
// separates the block from the prefix line
const { assert, assertEq, remarkExe } = require('../helpers');
const { execFileSync } = require('child_process');

// every fence in the file pairs up at a single indent
function fenceReport(md) {
  const bad = [];
  let open = null;
  md.split('\n').forEach((l, i) => {
    const m = l.match(/^(\s*)(```|~~~)/);
    if (!m) return;
    if (!open) { open = { no: i + 1, ind: m[1].length }; return; }
    if (m[1].length !== open.ind) bad.push('line ' + (i + 1) + ' closes line ' + open.no + ' at another indent');
    open = null;
  });
  if (open) bad.push('fence opened at line ' + open.no + ' never closes');
  return bad;
}

module.exports = async ctx => {
  const doc = ctx.fixture('code-block-body.md', [
    '# Code',
    '',
    '- [ ] Bob (2026-09-01 10:00:00): **Root** <!--thread-->',
    '  the root body',
    '',
    '  - Me (2026-09-01 10:05:00): plain for now.',
    '',
  ].join('\n'));
  const body = '```go\nfunc main() {}\n```';
  const page = await ctx.open(doc);

  // 1. reply to the root with nothing but a code block
  await page.focus('#r20260901100000 > .cfoot .replyseed');
  await page.waitForSelector('#r20260901100000 > .editor textarea', { timeout: 4000 });
  await page.fill('#r20260901100000 > .editor textarea', body);
  await page.click('#r20260901100000 > .editor button.send');
  await page.waitForTimeout(1500);
  let md = ctx.read(doc);
  assertEq(fenceReport(md).join('; '), '', 'fences pair up after the reply:\n' + md);
  assert(!/\):[ \t]*```/.test(md), 'the fence never sits inline after the prefix:\n' + md);
  assert(/\):[ \t]*(<!--[^>]*-->)?[ \t]*\n\n[ \t]*```go/.test(md),
    'a blank line separates the prefix from the block:\n' + md);

  // it is ONE comment holding the block, not a broken second item
  let seen = await page.evaluate(() => ({
    items: document.querySelectorAll('#doc .citem').length,
    code: [...document.querySelectorAll('#doc pre code')].map(c => c.textContent.trim()),
  }));
  assertEq(seen.items, 3, 'root, the old reply and the new one: ' + JSON.stringify(seen));
  assert(seen.code.some(c => c.includes('func main()')), 'the block renders as code: ' + JSON.stringify(seen.code));

  // 2. editing an existing comment down to only a code block does the same
  await page.evaluate(() => document.querySelector('#r20260901100500 [title="Edit your comment"]').click());
  await page.waitForSelector('.editor[data-key^="edit:"] textarea', { timeout: 4000 });
  await page.fill('.editor[data-key^="edit:"] textarea', body);
  await page.click('.editor[data-key^="edit:"] button.send');
  await page.waitForTimeout(1500);
  md = ctx.read(doc);
  assertEq(fenceReport(md).join('; '), '', 'fences still pair up after the edit:\n' + md);
  assert(!/\):[ \t]*```/.test(md), 'the edited fence is not inline either:\n' + md);

  // 3. the CLI verb writes the same shape
  execFileSync(remarkExe(), ['reply', doc, '2026-09-01 10:00:00', '-as', 'Bob', '-text', body]);
  md = ctx.read(doc);
  assertEq(fenceReport(md).join('; '), '', 'fences pair up after remark reply:\n' + md);
  assert(!/\):[ \t]*```/.test(md), 'remark reply does not inline the fence either:\n' + md);
  await page.close();
};
