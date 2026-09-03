// Interleaved segments: parsing, rendering order, and afterPara reply anchor.
const P = require('../ui/parser.js');
const t = [
  'Intro paragraph.', '',
  '- [ ] 🤖 Claude (2026-09-02 23:29): **Long reply** <!--thread-->',
  '  First point of a long reply, quite detailed.', '',
  '  - [x] Me (2026-09-02 23:33): interjection about the first point',
  '',
  '    - [ ] 🤖 Claude (2026-09-02 23:34): answer to the interjection',
  '',
  '  Second point, continuing the original comment.', '',
  '  Third point at the end.',
].join('\n');

const d = P.parse(t);
const root = d.blocks.filter(b => b.type === 'thread')[0].thread;
console.log('title:', JSON.stringify(root.title));
console.log('segments:', root.segments.map(s => s.type === 'text' ? 'text:' + s.md.slice(0, 20) : 'ITEM:' + s.item.author).join(' | '));
console.log('children count:', root.children.length, '| interjection child answer:', root.children[0].children[0].author);
console.log('bodyMd merged:', JSON.stringify(root.bodyMd.slice(0, 60)));

// paragraphs of the root's own text
const paras = P.itemParagraphs(root);
console.log('paragraphs:', paras.map(p => p.text.slice(0, 18) + '@' + p.lastNo).join(' | '));

// afterPara reply: interject after "Second point"
const target = paras.find(p => p.text.startsWith('Second point'));
const out = P.applyOps(t, [{ type: 'reply', parentHash: root.hash, occ: 0, afterPara: target.hash, author: 'Me', text: 'mid-comment reply after the second point', time: '2026-09-02 23:40' }]);
console.log('afterPara reply ok:', out.results[0].ok);
const lines = out.text.split('\n');
const idx = lines.findIndex(l => l.includes('mid-comment reply'));
console.log('inserted after:', JSON.stringify(lines[idx - 2]), '| before:', JSON.stringify(lines[idx + 2]));
const d2 = P.parse(out.text);
const r2 = d2.blocks.filter(b => b.type === 'thread')[0].thread;
console.log('reparse segments:', r2.segments.map(s => s.type === 'text' ? 'T' : 'I:' + s.item.author).join(','));
console.log('reparse children:', r2.children.length, '(want 2)');

// regression: plain non-interleaved item still one text segment
const t2 = '- [ ] Alice: simple comment <!--thread-->\n\n  - [ ] Bob: reply';
const r3 = P.parse(t2).blocks.filter(b => b.type === 'thread')[0].thread;
console.log('plain: segments', r3.segments.map(s => s.type).join(','), '| body:', JSON.stringify(r3.bodyMd));
console.log('no-op stable:', P.applyOps(t, []).text === t);
