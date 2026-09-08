// the landing page: compact branding row, the file list in columns when
// the screen is wide, and a generous recents history
const { assert } = require('../helpers');

module.exports = async ctx => {
  const docs = [];
  for (let i = 0; i < 14; i++) {
    docs.push(ctx.fixture(`landing-${i}.md`, `# Doc ${i}\n\ncontent ${i}.\n`));
  }
  await fetch(`http://127.0.0.1:7461/api/prefs?t=${ctx.token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recents: docs }),
  });
  const page = await ctx.browser.newPage({ viewportSize: { width: 1280, height: 800 } });
  await page.goto(`http://127.0.0.1:7461/?t=${ctx.token}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#recent a', { timeout: 8000 });
  const r = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#recent a')];
    const cols = new Set(items.map(a => Math.round(a.getBoundingClientRect().left)));
    const side = document.querySelector('.lside').getBoundingClientRect();
    const list = document.getElementById('recent').getBoundingClientRect();
    return {
      entries: items.length,
      columns: cols.size,
      sideBySide: list.left >= side.right,
    };
  });
  assert(r.entries === 14, 'all recents listed, got ' + r.entries);
  assert(r.columns === 1, 'the list keeps one vertical reading order, got ' + r.columns);
  assert(r.sideBySide, 'branding sits beside the list on wide screens');
  const rowH = await page.evaluate(() =>
    Math.round(document.querySelector('#recent a').getBoundingClientRect().height));
  assert(rowH < 44, 'one row per entry, got ' + rowH + 'px');
  await page.close();
};
