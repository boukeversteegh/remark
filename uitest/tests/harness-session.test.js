// An agent row shows which harness started it, and what resuming that
// session would take. The card is there to be CHECKED — a wrong config
// directory produces a Claude that starts fine and is the wrong one.
const fs = require('fs');
const path = require('path');
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('harness-session.md', [
    '# Harness',
    '',
    'A paragraph.',
    '',
    '- [ ] Me (2026-09-20 09:00:00): **T** opening <!--thread--> <!--seen:Me-->',
    '',
    '  - 🤖 Claude (2026-09-20 10:00:00): here. <!--seen:Me-->',
    '',
  ].join('\n'));

  // a presence record as a monitor started by Claude Code writes one: the
  // session, the directory, and each override with its set/unset state
  const pdir = path.join(ctx.tmp, 'config', 'remark', 'presence');
  fs.mkdirSync(pdir, { recursive: true });
  const norm = p => p.replace(/\\/g, '/').toLowerCase();
  fs.writeFileSync(path.join(pdir, 'agent.json'), JSON.stringify({
    name: '🤖 Claude', kind: 'agent', pid: process.pid, sid: 'aa11',
    started: '2026-09-20 09:55', files: [norm(doc)], cwd: 'D:/remark',
    harness: {
      tool: 'claude-code', version: '2.1.220',
      session: 'fdf52044-da39-4066-bb67-568807c13bd0',
      pid: 999999, pidStart: '1', cwd: 'D:/remark',
      env: [
        { name: 'CLAUDE_CONFIG_DIR', set: true, value: 'D:/alt-config' },
        { name: 'ANTHROPIC_API_KEY', set: true, secret: true },
        { name: 'ANTHROPIC_BASE_URL', set: false },
      ],
    },
  }));

  const page = await ctx.open(doc);
  await page.waitForSelector('#outline .presence .prow', { timeout: 6000 });
  await page.waitForTimeout(900);

  const badge = page.locator('#outline .presence .pharness').first();
  assertEq(await badge.count(), 1, 'the agent row carries a harness badge');
  await badge.click();
  await page.waitForSelector('#outline .presence .hcard', { timeout: 4000 });

  const card = await page.evaluate(() => {
    const c = document.querySelector('#outline .presence .hcard');
    const lines = {};
    for (const l of c.querySelectorAll('.hline')) {
      lines[l.querySelector('.hkey').textContent] = l.querySelector('.hval').textContent;
    }
    return {
      head: c.querySelector('.pmhead').textContent,
      lines,
      note: (c.querySelector('.hnote') || {}).textContent || '',
      cmd: (c.querySelector('.hcmd') || {}).textContent || '',
      html: c.innerHTML,
    };
  });

  assert(card.head.includes('2.1.220'), 'the harness names its version: ' + card.head);
  assertEq(card.lines.session, 'fdf52044-da39-4066-bb67-568807c13bd0', 'the session id is shown');
  assertEq(card.lines.directory, 'D:/remark', 'and the directory it ran in');
  assert(card.cmd === 'claude --resume fdf52044-da39-4066-bb67-568807c13bd0',
    'the resume command is spelled out: ' + card.cmd);

  // pid 999999 with a recorded start time of "1" is not running — a live pid
  // whose start time disagrees is a different program, and the row must not
  // call that a running session
  assert(/exited/.test(card.lines['claude process']),
    'a process that is gone reads as gone: ' + card.lines['claude process']);

  // the override that decides whether a resume is correct
  assertEq(card.lines.CLAUDE_CONFIG_DIR, 'D:/alt-config', 'a set override shows its value');
  // …and an unset one is a state of its own, not an omission
  assert(/1 unset, and must stay unset/.test(card.note), 'unset is recorded: ' + card.note);

  // a credential is present but never valued
  assert(/withheld/.test(card.lines.ANTHROPIC_API_KEY),
    'a secret is shown as withheld: ' + card.lines.ANTHROPIC_API_KEY);

  // and nothing anywhere in the delivered payload carries a secret value
  const api = await page.evaluate(async () =>
    JSON.stringify(await (await fetch('/api/presence?path=' + encodeURIComponent(S.path) + '&t=' + TOKEN)).json()));
  assert(!/sk-ant|bearer-/i.test(api), 'no credential value reaches the window');
  assert(/"secret":true/.test(api), 'but the fact one is set does');

  // a human row has no harness card to open
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('#outline .presence .prow')].map(r => ({
      name: (r.querySelector('.pname') || {}).textContent || '',
      harness: !!r.querySelector('.pharness'),
    })));
  const me = rows.find(x => /\(you\)/.test(x.name));
  assert(me && !me.harness, 'your own row claims no session: ' + JSON.stringify(rows));

  assertEq(page.errors.length, 0, 'no page errors: ' + page.errors.join(' | '));
  await page.close();
};
