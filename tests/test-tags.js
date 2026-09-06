// Tags: "#word" in a comment's text; a reply that is nothing but tags is a
// reader tag on its parent (bare) and never a comment of its own.
const P = require('../ui/parser.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- extraction ----------------------------------------------------------
ok(same(P.extractTags('this is #important and #ui-fix, also #Important again'), ['important', 'ui-fix']),
   'tags are found, deduped, lower-cased; trailing punctuation dropped');
ok(same(P.extractTags('issue #123 and #r20260903221807 and a#b and &#39;'), []),
   'numbers, comment refs, mid-word and entities are not tags');
ok(same(P.extractTags('see `#code` and http://x.y/#anchor and\n```\n#fenced\n```\n#real'), ['real']),
   'code spans, URLs and fences are skipped');
ok(same(P.extractTags('# Heading\n#tag_1 #a-'), ['tag_1', 'a']), 'heading is not a tag; trailing dash trimmed');
ok(P.isBareTags('#important #ui') && P.isBareTags('  #x  ') && !P.isBareTags('#x and more') &&
   !P.isBareTags('') && !P.isBareTags('#123') && !P.isBareTags('#r20260903221807'), 'bare-tag detection');

// ---- items --------------------------------------------------------------
const t = [
  '- [ ] Bouke (2026-09-06 10:00): **Batch size** <!--thread-->',
  '  Why 512? #question', '',
  '  - Agent (2026-09-06 10:01): measured, thinly #bench', '',
  '    - Bouke (2026-09-06 10:02): #important #ui', '',
  '  - Bouke (2026-09-06 10:03): #important', '',
  '  - Alice (2026-09-06 10:04): #important', '',
  '  - Bob (2026-09-06 10:05): plain reply, no tags',
].join('\n');
const root = P.parse(t).blocks.filter(b => b.type === 'thread')[0].thread;
ok(same(root.ownTags, ['question']) && !root.bare, 'root owns its text tags');
const agent = root.children[0];
ok(same(agent.ownTags, ['bench']), 'reply owns its tags');
ok(agent.children[0].bare && same(agent.children[0].bareTags, ['important', 'ui']), 'bare-tag reply detected');
ok(same(agent.tags.map(e => e.tag), ['bench', 'important', 'ui']), 'effective tags: own first, then reader tags');
ok(agent.tags[0].authored && agent.tags[0].by.length === 0, 'authored tag has no reader');
ok(!agent.tags[1].authored && same(agent.tags[1].by, ['Bouke']), 'reader tag names its tagger');
ok(same(root.tags.map(e => e.tag), ['question', 'important']) && same(root.tags[1].by, ['Bouke', 'Alice']),
   'two readers on one tag merge into one chip');
ok(root.children[3].tags.length === 0 && !root.children[3].bare, 'untagged reply');
// a root that is only tags is a comment, not a bare tag
const r2 = P.parse('- Bouke (2026-09-06 11:00): #solo <!--thread-->').blocks[0].thread;
ok(!r2.bare && same(r2.ownTags, ['solo']), 'a tags-only root is not bare');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
