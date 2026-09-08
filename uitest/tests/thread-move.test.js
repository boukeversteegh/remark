// drag a thread row in the outline: within its group to reorder siblings,
// across the rule to move the thread to another anchor group — the whole
// block (replies included) relocates in the file
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('thread-move.md', [
    '# Move',
    '',
    '## One',
    '',
    'First paragraph.',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **A1** <!--thread-->',
    '  on the first paragraph',
    '',
    '  - Bob (2026-09-01 10:05:00): rides along with A1.',
    '',
    '- [ ] Me (2026-09-01 10:01:00): **A2** <!--thread-->',
    '  also on the first paragraph',
    '',
    'Second paragraph.',
    '',
    '- [ ] Me (2026-09-01 10:02:00): **B1** <!--thread-->',
    '  on the second paragraph',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);

  const seq = () => page.evaluate(() =>
    [...document.querySelectorAll('#outline .otrow, #outline .osep')].map(x =>
      x.classList.contains('osep') ? '|' : x.querySelector('.otxt').textContent).join(' '));
  assertEq(await seq(), 'A1 A2 | B1', 'the starting order');

  // reorder within the group, by the same op the drop handler sends
  await page.evaluate(() => {
    const row = t => [...document.querySelectorAll('#outline .otrow')]
      .find(r => r.querySelector('.otxt').textContent === t);
    const a1 = row('A1'), a2 = row('A2');
    submitOps([{ type: 'move', hash: a1.dataset.thHash, occ: +a1.dataset.thOcc,
      refHash: a2.dataset.thHash, refOcc: +a2.dataset.thOcc, before: false }]);
  });
  await page.waitForTimeout(1500);
  assertEq(await seq(), 'A2 A1 | B1', 'A1 dropped after its sibling');
  let md = ctx.read(doc);
  assert(md.indexOf('**A2**') < md.indexOf('**A1**'), 'the file reordered too');
  assert(md.indexOf('rides along') > md.indexOf('**A1**'), 'the reply went with its thread');

  // move across the rule into the other group, via a real drag: pick up A1,
  // hover the top edge of B1 (insert before it), drop
  await page.evaluate(() => {
    const nav = document.getElementById('outline');
    const row = t => [...nav.querySelectorAll('.otrow')]
      .find(r => r.querySelector('.otxt').textContent === t);
    const a1 = row('A1'), b1 = row('B1');
    const dt = new DataTransfer();
    a1.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const y = b1.getBoundingClientRect().top + 1;
    nav.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
    window.__ind = {
      before: b1.classList.contains('dropbefore'),
      group: [...nav.querySelectorAll('.dropgroup')].map(r => r.querySelector('.otxt').textContent),
    };
    nav.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    a1.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
  });
  const ind = await page.evaluate(() => window.__ind);
  assert(ind.before, 'the insertion line sat on B1\'s top edge');
  assertEq(ind.group.join(' '), 'B1', 'the destination group lit up: ' + JSON.stringify(ind.group));
  await page.waitForTimeout(1500);
  assertEq(await seq(), 'A2 | A1 B1', 'A1 lives in the second group now');
  md = ctx.read(doc);
  const second = md.indexOf('Second paragraph.');
  assert(md.indexOf('**A1**') > second && md.indexOf('**A1**') < md.indexOf('**B1**'),
    'the block sits after the second paragraph, before B1');
  assert(md.indexOf('rides along') > second, 'the reply moved with it');
  await page.close();
};
