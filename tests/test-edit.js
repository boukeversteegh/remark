// Edit op: rewrite an item's own body text in place, keeping form, author
// prefix (incl. timestamp), first-line markers and nested children.
const P = require('../ui/parser.js');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('ok   ' + name); }
  else { failed++; console.log('FAIL ' + name); }
}
function threads(text) {
  return P.parse(text).blocks.filter(b => b.type === 'thread');
}

// ---- 1. single-line plain reply ---------------------------------------
const t1 = [
  '- [ ] Bouke (2026-09-03 10:00): opener question <!--thread-->', '',
  '  - Claude (2026-09-03 10:01): old reply text',
].join('\n');
{
  const reply = threads(t1)[0].thread.children[0];
  ok(reply.rawBody === 'old reply text', 'rawBody of plain reply');
  const a = P.applyOps(t1, [{ type: 'edit', hash: reply.hash, occ: 0, text: 'new reply text' }]);
  ok(a.results[0].ok, 'edit ok');
  ok(a.text.split('\n')[2] === '  - Claude (2026-09-03 10:01): new reply text',
     'plain form, author and timestamp kept');
  const r1 = threads(a.text)[0].thread.children[0];
  ok(r1.author === 'Claude' && r1.time === '2026-09-03 10:01' && r1.resolvable === false,
     'edited reply reparses with same identity');
  ok(r1.bodyMd === 'new reply text', 'edited body text');
  ok(r1.hash !== reply.hash, 'content hash changed by the edit');
  // op targets the PRE-edit hash: applying it again must fail cleanly
  const again = P.applyOps(a.text, [{ type: 'edit', hash: reply.hash, occ: 0, text: 'x' }]);
  ok(!again.results[0].ok && again.text === a.text, 'old hash no longer resolves after edit');
}

// ---- 2. multi-line body with a bold title line ------------------------
const t2 = [
  '- [ ] Bouke (2026-09-03 09:00): **Old title** <!--thread-->', '',
  '  First body line.', '',
  '  Second paragraph.',
].join('\n');
{
  const root = threads(t2)[0].thread;
  ok(root.rawBody === '**Old title**\n\nFirst body line.\n\nSecond paragraph.',
     'rawBody keeps the title line (bodyMd strips it)');
  // keep the title by keeping the line — no magic
  const a = P.applyOps(t2, [{ type: 'edit', hash: root.hash, occ: 0,
    text: '**New title**\nRewritten body.\n\nStill two paragraphs.' }]);
  ok(a.results[0].ok, 'title edit ok');
  ok(a.text.split('\n')[0] === '- [ ] Bouke (2026-09-03 09:00): **New title** <!--thread-->',
     'first line: prefix + new title + marker');
  ok(a.text.split('\n')[1] === '  Rewritten body.', 'continuation indent 2 under root');
  const r2 = threads(a.text)[0].thread;
  ok(r2.title === 'New title', 'new title parsed');
  ok(r2.bodyMd === 'Rewritten body.\n\nStill two paragraphs.', 'new body parsed');
  // drop the title line: no title afterwards
  const b = P.applyOps(t2, [{ type: 'edit', hash: root.hash, occ: 0, text: 'plain text now' }]);
  const r3 = threads(b.text)[0].thread;
  ok(r3.title === null && r3.bodyMd === 'plain text now', 'removing the line removes the title');
}

// ---- 3. nested children preserved verbatim ----------------------------
const t3 = [
  '- [ ] Bouke (2026-09-03 11:00): root to edit <!--thread-->', '',
  '  - Claude (2026-09-03 11:01): first reply', '',
  '    with a continuation line', '',
  '    - [x] Bouke (2026-09-03 11:02): nested checkbox reply', '',
  '  - Claude (2026-09-03 11:03): second reply',
].join('\n');
{
  const root = threads(t3)[0].thread;
  const before = P.parse(t3).items.slice(1).map(i => [i.hash, i.author, i.bodyMd, i.checked]);
  const a = P.applyOps(t3, [{ type: 'edit', hash: root.hash, occ: 0, text: 'edited root\nsecond line' }]);
  ok(a.results[0].ok, 'edit with children ok');
  const r = threads(a.text)[0].thread;
  ok(r.bodyMd === 'edited root\nsecond line', 'root body replaced');
  ok(r.children.length === 2 && r.children[0].children.length === 1, 'child structure intact');
  ok(JSON.stringify(P.parse(a.text).items.slice(1).map(i => [i.hash, i.author, i.bodyMd, i.checked])) ===
     JSON.stringify(before), 'children identical (hashes, bodies, state)');
  ok(a.text.includes('  - Claude (2026-09-03 11:01): first reply') &&
     a.text.includes('    with a continuation line') &&
     a.text.includes('    - [x] Bouke (2026-09-03 11:02): nested checkbox reply'),
     'child lines verbatim');
}
// interjected child: new body becomes one block, child moves after it
const t3b = [
  '- [ ] Bouke (2026-09-03 11:10): para one <!--thread-->', '',
  '  - Claude (2026-09-03 11:11): interjection', '',
  '  para two after the interjection',
].join('\n');
{
  const root = threads(t3b)[0].thread;
  ok(root.rawBody === 'para one\n\npara two after the interjection', 'rawBody joins interleaved text');
  const a = P.applyOps(t3b, [{ type: 'edit', hash: root.hash, occ: 0, text: 'one\n\ntwo' }]);
  const lines = a.text.split('\n');
  ok(lines[0] === '- [ ] Bouke (2026-09-03 11:10): one <!--thread-->' &&
     lines[2] === '  two' &&
     lines[4] === '  - Claude (2026-09-03 11:11): interjection',
     'contiguous new body first, interjected child after it');
  const r = threads(a.text)[0].thread;
  ok(r.children.length === 1 && r.children[0].bodyMd === 'interjection', 'interjected child preserved');
}

// ---- 4. markers and checkbox state survive ----------------------------
const t4 = '- [x] Bouke (2026-09-03 12:00): settled text <!--thread--> <!--seen:Claude, Eve-->';
{
  const root = threads(t4)[0].thread;
  ok(root.rawBody === 'settled text', 'rawBody strips markers');
  const a = P.applyOps(t4, [{ type: 'edit', hash: root.hash, occ: 0, text: 'reworded but still settled' }]);
  ok(a.text === '- [x] Bouke (2026-09-03 12:00): reworded but still settled <!--thread--> <!--seen:Claude, Eve-->',
     'checkbox x, thread marker and seen marker all kept');
  const r = threads(a.text)[0].thread;
  ok(r.checked === true && r.resolvable === true, 'edited [x] root stays resolved');
  ok(JSON.stringify(r.seenBy) === '["Claude","Eve"]', 'seenBy survives the edit');
  ok(r.hasMarker === true, 'thread marker survives the edit');
}
// legacy <!--rv--> marker kept as written
{
  const t = '- [ ] Bouke (2026-09-03 12:30): legacy <!--rv-->';
  const root = threads(t)[0].thread;
  const a = P.applyOps(t, [{ type: 'edit', hash: root.hash, occ: 0, text: 'edited legacy' }]);
  ok(a.text === '- [ ] Bouke (2026-09-03 12:30): edited legacy <!--rv-->', 'legacy rv marker preserved');
}

// ---- 5. multi-line edit of a reply: continuation indent ---------------
{
  const reply = threads(t1)[0].thread.children[0];
  const a = P.applyOps(t1, [{ type: 'edit', hash: reply.hash, occ: 0, text: 'line one\nline two\n\nline four' }]);
  const lines = a.text.split('\n');
  ok(lines[2] === '  - Claude (2026-09-03 10:01): line one' &&
     lines[3] === '    line two' && lines[4] === '' && lines[5] === '    line four',
     'continuation lines at reply indent + 2, blanks kept');
  ok(threads(a.text)[0].thread.children[0].bodyMd === 'line one\nline two\n\nline four',
     'multi-line reply body round-trips');
}

// ---- 6. failed edit leaves text untouched -----------------------------
{
  const bad = P.applyOps(t1, [{ type: 'edit', hash: 'nope', occ: 0, text: 'x' }]);
  ok(!bad.results[0].ok && bad.text === t1, 'missing hash: no-op with reason');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
