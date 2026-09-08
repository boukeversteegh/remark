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
  assert(rowH < 72, 'a compact headline + path entry, got ' + rowH + 'px');
  await page.close();

  // the edge Codex asked about: a long title and a deep path just above
  // the breakpoint — the title ellipsizes, the badge stays on screen
  const longDoc = ctx.fixture('landing-long.md',
    '# A Considerably Long Document Title That Keeps Going Well Past Reasonable Length\n\ncontent.\n\n' +
    '- [ ] Alice (2026-09-01 10:00:00): **Q** open one <!--thread-->\n');
  await fetch(`http://127.0.0.1:7461/api/prefs?t=${ctx.token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recents: [longDoc] }),
  });
  const p2 = await ctx.browser.newPage({ viewportSize: { width: 990, height: 600 } });
  await p2.goto(`http://127.0.0.1:7461/?t=${ctx.token}`, { waitUntil: 'networkidle' });
  await p2.waitForSelector('#recent a .rbadge', { timeout: 8000 });
  const edge = await p2.evaluate(() => {
    const a = document.querySelector('#recent a');
    const name = a.querySelector('.rname');
    const badge = a.querySelector('.rbadge').getBoundingClientRect();
    const line = a.querySelector('.rline').getBoundingClientRect();
    const pathEl = a.querySelector('.rfile').getBoundingClientRect();
    const landing = document.getElementById('landing');
    return {
      ellipsized: name.scrollWidth > name.clientWidth,
      nameW: Math.round(name.getBoundingClientRect().width),
      badgeOn: badge.width > 0 && badge.right <= innerWidth,
      pathBelow: pathEl.top >= line.bottom - 2,
      // the landing scrolls in its own fixed container: measure THERE,
      // not on the document, or overflow hides from the assertion
      hOverflow: landing.scrollWidth > landing.clientWidth + 1,
    };
  });
  assert(edge.badgeOn, 'the badge stays on screen beside a long title');
  assert(edge.ellipsized && edge.nameW > 150, 'the long title ellipsizes but stays readable, got ' + edge.nameW + 'px');
  assert(edge.pathBelow, 'the path sits on its own line below the headline');
  assert(!edge.hOverflow, 'no horizontal overflow at the breakpoint');

  // small windows: nothing clips, everything ellipsizes
  await p2.setViewportSize({ width: 500, height: 600 });
  await p2.waitForTimeout(200);
  const small = await p2.evaluate(() => ({
    hOverflow: (l => l.scrollWidth > l.clientWidth + 1)(document.getElementById('landing')),
    badgeOn: (b => b.width > 0 && b.right <= innerWidth)(document.querySelector('#recent a .rbadge').getBoundingClientRect()),
  }));
  assert(!small.hOverflow, 'no horizontal overflow in a small window');
  assert(small.badgeOn, 'the badge stays on screen in a small window');
  await p2.close();
};
