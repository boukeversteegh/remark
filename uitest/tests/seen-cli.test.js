// remark seen: writes your read-marker at once; your own comments refuse
const { execFileSync } = require('child_process');
const { assert } = require('../helpers');
const { remarkExe } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('seen-cli.md', [
    '# Seen',
    '',
    '- [ ] Bob (2026-09-01 10:00:00): **From Bob** read me <!--thread-->',
    '',
    '- [ ] Me (2026-09-01 11:00:00): **Mine** my own <!--thread-->',
    '',
  ].join('\n'));
  execFileSync(remarkExe(), ['seen', doc, '10:00:00', '-as', 'Me']);
  const md = ctx.read(doc);
  assert(/From Bob.*<!--seen:Me-->/.test(md.split(/\r?\n/).find(l => l.includes('From Bob'))),
    'the read-marker landed on the first line');
  let refused = false;
  try {
    execFileSync(remarkExe(), ['seen', doc, '11:00:00', '-as', 'Me'], { stdio: 'pipe' });
  } catch (e) { refused = true; }
  assert(refused, 'marking your own comment is refused');
};
