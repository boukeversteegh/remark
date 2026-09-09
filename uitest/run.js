// Headless UI regression suite. Run with `task test:ui` (or `node uitest/run.js`).
// Every test drives the real app — the built binary's embedded UI in headless
// Edge against an isolated config — completely hidden: no window, no mouse.
//
//   node uitest/run.js            run everything
//   node uitest/run.js rail       run only tests whose name contains "rail"
const fs = require('fs');
const path = require('path');
const { start } = require('./helpers');

(async () => {
  const filter = process.argv[2] || '';
  const dir = path.join(__dirname, 'tests');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js') && f.includes(filter)).sort();
  if (!files.length) {
    console.error('no tests match', JSON.stringify(filter));
    process.exit(2);
  }
  const ctx = await start();
  let failed = 0;
  const t0 = Date.now();
  for (const f of files) {
    const name = f.replace(/\.test\.js$/, '');
    const test = require(path.join(dir, f));
    process.stdout.write(name.padEnd(24));
    try {
      await test(ctx);
      console.log('ok');
    } catch (e) {
      failed++;
      console.log('FAIL');
      console.log('  ' + String(e.message || e).split('\n').join('\n  '));
    }
  }
  await ctx.stop();
  console.log(`\n${files.length - failed}/${files.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('runner failed:', e); process.exit(2); });
