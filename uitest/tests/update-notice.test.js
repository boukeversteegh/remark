// the update notice offers Restart and Restart all, and a window acts on a
// restart asked for by another window without being clicked
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('update-notice.md', [
    '# Update',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **T** <!--thread--> <!--seen:Me-->',
    '  body',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);

  // the real server says "not updated"; stub the poll so the notice appears
  let restartCalls = 0, restartAllCalls = 0, pretendRestartAll = false;
  await page.route('**/api/update*', route => {
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ updated: true, stamp: 'build-2', gateway: false, restartAll: pretendRestartAll }),
    });
  });
  await page.route('**/api/restart?*', route => {
    restartCalls++;
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api/restartall*', route => {
    restartAllCalls++;
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.waitForSelector('#notices .notice[data-key="update"]', { timeout: 15000 });
  const buttons = await page.evaluate(() =>
    [...document.querySelectorAll('#notices .notice[data-key="update"] button')].map(b => b.textContent.trim()));
  assert(buttons.includes('Restart'), 'the notice still offers Restart: ' + JSON.stringify(buttons));
  assert(buttons.includes('Restart all'), 'and now Restart all: ' + JSON.stringify(buttons));
  assert(buttons.includes("What's new"), 'and the changelog: ' + JSON.stringify(buttons));

  // Restart all marks it for the others, then restarts this one too
  await page.evaluate(() => {
    [...document.querySelectorAll('#notices .notice[data-key="update"] button')]
      .find(b => b.textContent.trim() === 'Restart all').click();
  });
  await page.waitForTimeout(900);
  assertEq(restartAllCalls, 1, 'the mark was left for the other windows');
  assertEq(restartCalls, 1, 'and this window restarted itself');

  // a window that did not ask acts on the mark by itself
  const before = restartCalls;
  pretendRestartAll = true;
  await page.evaluate(() => { S.restartingAll = false; S.updateStamp = null; });
  await page.waitForTimeout(6000);
  assert(restartCalls > before, 'a window restarts on another window\'s request');
  const said = await page.evaluate(() =>
    (document.querySelector('#notices .notice[data-key="update"]') || {}).textContent || '');
  assert(/asked for from another window/.test(said), 'and says why: ' + JSON.stringify(said));
  await page.close();
};
