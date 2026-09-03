const P = require('../ui/parser.js');
const F = '```';
const t = [
  'Para.', '',
  '- [ ] Bouke (2026-09-02 22:12): question <!--rv-->', '',
  '  - [ ] C (2026-09-02 22:13): example: <!--rv-->', '',
  '    ' + F + 'markdown',
  '    - [ ] **Title here** — Alice (2026-09-02 10:00): body <!--rv-->', '',
  '      - [x] Bob: a reply',
  '    ' + F, '',
  '    after the fence.', '',
  '  - [ ] Real (2026-09-02 22:14): second real reply',
].join('\n');
const d = P.parse(t);
const th = d.blocks.filter(b => b.type === 'thread');
console.log('threads:', th.length);
const r = th[0].thread;
console.log('root children:', r.children.length, '(want 2)');
console.log('child1 grandchildren:', r.children[0].children.length, '(want 0 — fence lines are not replies)');
console.log('child1 body keeps fence + example:', r.children[0].bodyMd.includes(F) && r.children[0].bodyMd.includes('**Title here**') && r.children[0].bodyMd.includes('after the fence.'));
console.log('child2 author:', JSON.stringify(r.children[1].author), 'time:', r.children[1].time);
// round-trip: applying a no-op leaves the fence intact
console.log('no-op stable:', P.applyOps(t, []).text === t);
// reply insertion goes AFTER the fenced child subtree
const out = P.applyOps(t, [{ type: 'reply', parentHash: r.hash, occ: 0, author: 'X', text: 'tail', time: '2026-09-02 22:15' }]);
const lines = out.text.split('\n');
console.log('new reply after last child:', lines.indexOf(lines.find(l => l.includes('X (2026-09-02 22:15)'))) > lines.indexOf(lines.find(l => l.includes('second real reply'))));
