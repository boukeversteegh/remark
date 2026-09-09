// an interjection placed right after a fenced code block with EMPTY lines
// inside lands after the closing fence, never inside the block: the file
// side splits paragraphs fence-aware, exactly like the renderer does
const { assert } = require('../helpers');

module.exports = async ctx => {
  const long = 'x'.repeat(450); // one fence piece longer than the 400-char
  // normalize window: pre-fix, its hash collided with the whole-fence chunk
  const doc = ctx.fixture('interject-fence.md', [
    '# Fence',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **Code** <!--thread-->',
    '  intro line',
    '',
    '  ```',
    '  ' + long,
    '',
    '  second piece',
    '  ```',
    '',
    '  after the code',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);

  // the gap AFTER the code block (gaps sit between chunks: intro|fence,
  // fence|after) opens the interjection editor
  await page.evaluate(() => {
    document.querySelectorAll('#r20260901100000 .cbody .igap')[1].click();
  });
  await page.waitForSelector('.editor[data-key^="ipara:"] textarea', { timeout: 4000 });
  await page.fill('.editor[data-key^="ipara:"] textarea', 'INTERJECT-HERE');
  await page.click('.editor[data-key^="ipara:"] button.send');
  await page.waitForTimeout(1500);

  const md = ctx.read(doc);
  const at = md.indexOf('INTERJECT-HERE');
  assert(at !== -1, 'the interjection was written');
  const fenceClose = md.lastIndexOf('```');
  assert(at > fenceClose, 'it sits AFTER the closing fence, not inside the block');
  assert(at < md.indexOf('after the code'), 'and before the text that follows the block');
  const block = md.slice(md.indexOf('```'), fenceClose);
  assert(!block.includes('- Me (2026-09'), 'the code block itself stayed contiguous');
  await page.close();
};
