// Bodies that cannot sit inline after "Author:": fences, lists, blank first
// lines. The writer shunts them to continuation lines ("Author (ts):" ends
// the item line); the parser accepts that form for timestamped prefixes.
const P = require('../ui/parser.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

const doc = `# Doc

Some paragraph.

- [ ] Me (2026-09-03 09:19): **Root** <!--thread-->

  - 🤖 Claude (2026-09-03 09:55): status reply

    - Me (2026-09-03 09:46): <!--seen:claude-->
      \`\`\`
      $ gh repo create foo --push
      X Unable to add remote "origin"
      \`\`\`

      - 🤖 Claude (2026-09-03 10:16): nested under the fence comment

  - Me (2026-09-03 09:43): a later sibling
`;

const d = P.parse(doc);
const root = d.blocks.find(b => b.type === 'thread').thread;
ok(root.children.length === 2, 'root has both children');
const status = root.children[0];
ok(status.children.length === 1, 'status reply has the fence comment as child');
const fence = status.children[0];
ok(fence.author === 'Me' && fence.time === '2026-09-03 09:46', 'empty-rest item parsed with author+time');
ok((fence.seenBy || []).indexOf('claude') !== -1, 'seen marker on the first line parsed');
ok(/gh repo create/.test(fence.rawBody || ''), 'fence body belongs to the item');
ok(fence.children.length === 1 && /nested under/.test(fence.children[0].rawBody), 'reply nested under fence comment');
ok(/later sibling/.test(root.children[1].rawBody), 'sibling after the fence comment survives');

// guard: empty rest WITHOUT a timestamp is not an author line
const d2 = P.parse('- [ ] X (2026-01-01 00:00): **T** <!--thread-->\n\n  - Note:\n    body\n');
const r2 = d2.blocks.find(b => b.type === 'thread').thread;
ok(!r2.children.some(c => c.author === 'Note'), 'untimestamped "Word:" line is not a comment');

// writer: fence-opening reply is shunted to continuation lines
const base = '- [ ] Me (2026-09-03 09:19): **Root** <!--thread-->\n';
const rootHash = P.parse(base).items[0].hash;
const res = P.applyOps(base, [{ type: 'reply', parentHash: rootHash, occ: 0, author: 'Me',
  time: '2026-09-03 09:46', text: '```\ncode line\n```' }]);
ok(res.results[0].ok, 'fence reply applied');
const lines = res.text.split('\n');
const itemLine = lines.find(l => /- Me \(2026-09-03 09:46\):/.test(l));
ok(/\):$/.test(itemLine), 'item line ends at the colon (body shunted)');
const rd = P.parse(res.text);
const reply = rd.items.find(i => i.author === 'Me' && i.time === '2026-09-03 09:46');
ok(reply && /code line/.test(reply.rawBody), 'shunted fence body round-trips');

// writer: list-opening reply is shunted too
const res2 = P.applyOps(base, [{ type: 'reply', parentHash: rootHash, occ: 0, author: 'Me',
  time: '2026-09-03 09:47', text: '- first\n- second' }]);
const itemLine2 = res2.text.split('\n').find(l => /- Me \(2026-09-03 09:47\):/.test(l));
ok(/\):$/.test(itemLine2), 'list body shunted');
const reply2 = P.parse(res2.text).items.find(i => i.time === '2026-09-03 09:47');
ok(reply2 && /first/.test(reply2.rawBody) && /second/.test(reply2.rawBody), 'list body round-trips');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
