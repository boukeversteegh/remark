// regression: Escape closes the image popout and nothing else. It used to
// travel on to focus mode, so dismissing a picture also left the thread.
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('lightbox-escape.md', [
    '# Pictures',
    '',
    '- [ ] Bob (2026-09-01 10:00:00): **Shot** look at this <!--thread-->',
    '',
    '  ![a picture](pic.png)',
    '',
  ].join('\n'));
  const fs = require('fs');
  const path = require('path');
  fs.writeFileSync(path.join(ctx.tmp, 'pic.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  const page = await ctx.open(doc);

  // focus a thread first: that is the handler Escape used to reach
  await page.evaluate(() => { S.focusThread = '2026-09-01 10:00:00'; render(); });
  await page.waitForTimeout(200);
  const focused = await page.evaluate(() => !!S.focusThread);
  assert(focused, 'a thread is focused before the picture opens');

  await page.evaluate(() => document.querySelector('#doc img, .cbody img').click());
  await page.waitForSelector('#lightbox', { timeout: 4000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => ({
    box: !!document.getElementById('lightbox'),
    focus: !!S.focusThread,
  }));
  assertEq(after.box, false, 'Escape closed the picture');
  assertEq(after.focus, true, 'and left focus mode alone');
  await page.close();
};
