// New comment model: plain (non-resolvable) items, seenBy markers, resolve op.
const P = require('../ui/parser.js');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('ok   ' + name); }
  else { failed++; console.log('FAIL ' + name); }
}
function threads(text) {
  return P.parse(text).blocks.filter(b => b.type === 'thread');
}

// ---- 1. plain-item replies parsed as comments -------------------------
const t1 = [
  '- [ ] Bouke (2026-09-03 10:00): opener question <!--thread-->', '',
  '  - Claude (2026-09-03 10:01): plain reply, not resolvable', '',
  '    - [x] Bouke (2026-09-03 10:02): nested checkbox reply', '',
  '  - Claude (2026-09-03 10:03): second plain reply', '',
  '  - Homepage: an untimestamped body bullet, NOT a comment',
].join('\n');
{
  const th = threads(t1);
  ok(th.length === 1, 'plain replies: one thread');
  const r = th[0].thread;
  ok(r.resolvable === true, 'root is resolvable');
  ok(r.checked === false, 'root unresolved');
  ok(r.children.length === 2, 'root has 2 replies');
  ok(r.children[0].resolvable === false, 'plain reply resolvable=false');
  ok(r.children[0].checked === false, 'plain reply checked=false');
  ok(r.children[0].author === 'Claude', 'plain reply author parsed');
  ok(r.children[0].bodyMd === 'plain reply, not resolvable', 'plain reply body');
  ok(r.children[0].children.length === 1, 'plain reply has nested checkbox child');
  ok(r.children[0].children[0].resolvable === true && r.children[0].children[0].checked === true,
     'nested checkbox reply resolvable+checked');
  ok(r.children[1].author === 'Claude' && r.children[1].resolvable === false,
     'second plain reply is a comment');
  ok(!r.children.some(c => c.author === 'Homepage') && /Homepage/.test(r.rawBody || ''),
     'untimestamped "Word:" bullet stays body content, not a comment');
  ok(P.parse(t1).items.every(i => Array.isArray(i.seenBy) && i.seenBy.length === 0),
     'seenBy defaults to [] everywhere');
}

// ---- 2. plain authored root with marker -------------------------------
const t2 = [
  'Intro prose.', '',
  '- Bouke (2026-09-03 11:00): a plain-dash thread root <!--thread-->', '',
  '  - [ ] Claude: checkbox reply under plain root',
].join('\n');
{
  const th = threads(t2);
  ok(th.length === 1, 'plain root: recognised as thread');
  const r = th[0].thread;
  ok(r.resolvable === false, 'plain root resolvable=false');
  ok(r.author === 'Bouke' && r.time === '2026-09-03 11:00', 'plain root author/time');
  ok(r.bodyMd === 'a plain-dash thread root', 'plain root body (marker stripped)');
  ok(r.hasMarker === true, 'plain root hasMarker');
  ok(r.children.length === 1 && r.children[0].resolvable === true,
     'checkbox reply under plain root');
}
// plain authored root WITHOUT marker (strict heuristic; replies need the
// timestamped prefix to count as comments)
{
  const th = threads('- Bouke: hand-written plain root\n\n  - Claude (2026-09-03 11:01): reply');
  ok(th.length === 1 && th[0].thread.children.length === 1,
     'plain root via author heuristic (no marker)');
}

// ---- 3. unauthored plain list lines stay body content -----------------
const t3 = [
  '- [ ] Bouke (2026-09-03 12:00): list follows <!--thread-->', '',
  '  - first ordinary bullet',
  '  - second ordinary bullet', '',
  '  - Claude (2026-09-03 12:01): actual plain reply',
].join('\n');
{
  const r = threads(t3)[0].thread;
  ok(r.children.length === 1, 'unauthored bullets are not replies');
  ok(r.children[0].author === 'Claude', 'authored plain item still a reply');
  ok(r.bodyMd.includes('- first ordinary bullet') && r.bodyMd.includes('- second ordinary bullet'),
     'bullets kept in root body');
}
// ordinary top-level list without authors stays prose
{
  const d = P.parse('Para.\n\n- apples\n- pears\n- a fairly long note without colon');
  ok(d.blocks.filter(b => b.type === 'thread').length === 0, 'ordinary list stays prose');
}

// ---- 4. seenBy parsing + seen op + hash stability ---------------------
const t4 = [
  '- [ ] Bouke (2026-09-03 13:00): root text <!--thread--> <!--seen:Claude, Bouke-->', '',
  '  - Claude (2026-09-03 13:01): reply text',
].join('\n');
{
  const r = threads(t4)[0].thread;
  ok(JSON.stringify(r.seenBy) === '["Claude","Bouke"]', 'seenBy parsed (trimmed)');
  ok(r.bodyMd === 'root text', 'seen marker stripped from bodyMd');
  ok(r.children[0].seenBy.length === 0, 'reply seenBy empty');

  // hash stability: same item without any seen marker hashes identically
  const bare = threads('- [ ] Bouke (2026-09-03 13:00): root text <!--thread-->')[0].thread;
  ok(bare.hash === r.hash, 'hash unaffected by seen marker');

  const reply = r.children[0];
  // add a reader to the reply (no marker yet -> created at line end)
  const a1 = P.applyOps(t4, [{ type: 'seen', hash: reply.hash, occ: 0, reader: 'Bouke', on: true }]);
  ok(a1.results[0].ok, 'seen add ok');
  const r1 = threads(a1.text)[0].thread.children[0];
  ok(JSON.stringify(r1.seenBy) === '["Bouke"]', 'seen add creates marker');
  ok(r1.hash === reply.hash, 'hash stable after seen add');
  // idempotent add
  const a2 = P.applyOps(a1.text, [{ type: 'seen', hash: reply.hash, occ: 0, reader: 'Bouke', on: true }]);
  ok(a2.text === a1.text, 'seen add idempotent');
  // second reader appended
  const a3 = P.applyOps(a2.text, [{ type: 'seen', hash: reply.hash, occ: 0, reader: 'Eve', on: true }]);
  ok(JSON.stringify(threads(a3.text)[0].thread.children[0].seenBy) === '["Bouke","Eve"]',
     'second reader appended to list');
  // remove one reader
  const a4 = P.applyOps(a3.text, [{ type: 'seen', hash: reply.hash, occ: 0, reader: 'Bouke', on: false }]);
  ok(JSON.stringify(threads(a4.text)[0].thread.children[0].seenBy) === '["Eve"]',
     'reader removed from list');
  // removing the last reader removes the whole marker
  const a5 = P.applyOps(a4.text, [{ type: 'seen', hash: reply.hash, occ: 0, reader: 'Eve', on: false }]);
  ok((a5.text.match(/<!--\s*seen:/g) || []).length === 1 &&
     a5.text.split('\n')[0].includes('<!--seen:Claude, Bouke-->') &&
     !a5.text.split('\n')[2].includes('seen'),
     'last-reader removal drops marker (only root marker remains)');
  ok(a5.text === t4, 'seen add+remove round-trips to original text');
  // idempotent remove (no marker present)
  const a6 = P.applyOps(a5.text, [{ type: 'seen', hash: reply.hash, occ: 0, reader: 'Eve', on: false }]);
  ok(a6.text === a5.text && a6.results[0].ok, 'seen remove idempotent when absent');
}

// ---- 5. resolve op ----------------------------------------------------
{
  const r = threads(t1)[0].thread;
  const plain = r.children[0];
  const res = P.applyOps(t1, [{ type: 'resolve', hash: r.hash, occ: 0, resolved: true }]);
  ok(res.results[0].ok, 'resolve on resolvable ok');
  ok(threads(res.text)[0].thread.checked === true, 'resolve sets checked');
  const un = P.applyOps(res.text, [{ type: 'resolve', hash: r.hash, occ: 0, resolved: false }]);
  ok(un.text === t1, 'unresolve round-trips');
  const bad = P.applyOps(t1, [{ type: 'resolve', hash: plain.hash, occ: 0, resolved: true }]);
  ok(!bad.results[0].ok && /resolvable/.test(bad.results[0].reason), 'resolve fails on plain item with reason');
  ok(bad.text === t1, 'failed resolve leaves text untouched');
  // toggle alias still works and also refuses plain items
  const tg = P.applyOps(t1, [{ type: 'toggle', hash: r.hash, occ: 0, checked: true }]);
  ok(tg.results[0].ok && threads(tg.text)[0].thread.checked === true, 'toggle alias works');
  const tgBad = P.applyOps(t1, [{ type: 'toggle', hash: plain.hash, occ: 0, checked: true }]);
  ok(!tgBad.results[0].ok, 'toggle refuses plain item');
}

// ---- 6. reply op: plain vs opener forms; add op opener default --------
{
  const r = threads(t1)[0].thread;
  const p1 = P.applyOps(t1, [{ type: 'reply', parentHash: r.hash, occ: 0, author: 'Claude', text: 'plain form reply', time: '2026-09-03 14:00' }]);
  ok(p1.text.includes('  - Claude (2026-09-03 14:00): plain form reply'), 'reply default writes plain item');
  ok(!p1.text.includes('[ ] Claude (2026-09-03 14:00)'), 'plain reply has no checkbox');
  const rp = threads(p1.text)[0].thread;
  ok(rp.children.length === 3 && rp.children[2].resolvable === false, 'plain reply reparses as comment');

  const p2 = P.applyOps(t1, [{ type: 'reply', parentHash: r.hash, occ: 0, opener: true, author: 'Claude', text: 'opener reply', time: '2026-09-03 14:01' }]);
  ok(p2.text.includes('  - [ ] Claude (2026-09-03 14:01): opener reply'), 'reply opener=true writes checkbox');
  ok(threads(p2.text)[0].thread.children[2].resolvable === true, 'opener reply reparses resolvable');

  // add: default opener TRUE
  const ad = P.applyOps('Some paragraph here.', [{ type: 'add', atEnd: true, author: 'Bouke', text: 'new thread', time: '2026-09-03 14:02' }]);
  ok(ad.text.includes('- [ ] Bouke (2026-09-03 14:02): new thread <!--thread-->'), 'add defaults to checkbox root');
  const ad2 = P.applyOps('Some paragraph here.', [{ type: 'add', atEnd: true, opener: false, author: 'Bouke', text: 'plain thread', time: '2026-09-03 14:03' }]);
  ok(ad2.text.includes('- Bouke (2026-09-03 14:03): plain thread <!--thread-->') &&
     !ad2.text.includes('[ ] Bouke (2026-09-03 14:03)'), 'add opener=false writes plain root');
  ok(threads(ad2.text).length === 1, 'plain added root reparses as thread');

  // stamp on a plain item (an untimestamped hand-written root)
  const su = '- Bouke: hand-written plain root <!--thread-->';
  const suh = P.parse(su).items[0].hash;
  const st = P.applyOps(su, [{ type: 'stamp', hash: suh, occ: 0, time: '2026-09-03 14:04' }]);
  ok(st.results[0].ok && st.text.includes('- Bouke (2026-09-03 14:04): hand-written plain root'),
     'stamp handles plain items');
}

// ---- 7. round-trip stability ------------------------------------------
{
  ok(P.applyOps(t1, []).text === t1, 'no-op stable t1');
  ok(P.applyOps(t2, []).text === t2, 'no-op stable t2');
  ok(P.applyOps(t3, []).text === t3, 'no-op stable t3');
  ok(P.applyOps(t4, []).text === t4, 'no-op stable t4 (seen marker preserved)');
  // parse -> reparse structural stability for a mixed doc
  const mixed = [t2, '', '## Section', '', t3].join('\n');
  const d1 = P.parse(mixed);
  const d2 = P.parse(P.applyOps(mixed, []).text);
  ok(JSON.stringify(d1.items.map(i => [i.hash, i.resolvable, i.checked, i.seenBy])) ===
     JSON.stringify(d2.items.map(i => [i.hash, i.resolvable, i.checked, i.seenBy])),
     'mixed doc items stable across round-trip');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
