// A gateway that listens on a resolvable name is still unreachable when the
// firewall blocks the active network profile — the panel must say so instead
// of showing green, and offer the one-click allow. The verdict is a property
// of the host machine, so the status is stubbed here: what is under test is
// the panel's reading of it.
const { assert, assertEq } = require('../helpers');

module.exports = async ctx => {
  const doc = ctx.fixture('firewall-warn.md', [
    '# Firewall',
    '',
    '- [ ] Me (2026-09-01 10:00:00): **T** opening <!--thread-->',
    '',
  ].join('\n'));
  const page = await ctx.open(doc);

  let posted = 0;
  await page.route('**/api/firewall/allow*', route => {
    posted++;
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  // the document is shared and the gateway runs, but the firewall blocks
  let blocked = true;
  await page.route('**/api/gateway?**', async route => {
    const res = await route.fetch();
    const st = await res.json();
    Object.assign(st, {
      running: true, shared: true, port: 7444, host: 'bouke-hp.home',
      url: 'http://bouke-hp.home:7444/?t=x',
    });
    if (blocked) {
      Object.assign(st, {
        firewallBlocked: true, firewallProfiles: 'Private',
        firewallFix: "New-NetFirewallRule -DisplayName 'remark gateway'",
      });
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(st) });
  });

  await page.evaluate(() => document.getElementById('gatewayBtn').click());
  await page.waitForSelector('#gwpanel .gwfix', { timeout: 6000 });
  const st = await page.evaluate(() => ({
    text: document.querySelector('#gwpanel .gwstatus').textContent,
    warn: document.querySelector('#gwpanel .gwstatus').classList.contains('warn'),
    green: document.querySelector('#gwpanel .gwstatus').classList.contains('on'),
    buttons: [...document.querySelectorAll('#gwpanel .gwfix button')].map(b => b.textContent),
  }));
  assert(st.warn && !st.green, 'a blocked gateway is never shown as reachable: ' + JSON.stringify(st));
  assert(/firewall is blocking your Private network/.test(st.text), 'the block is named: ' + st.text);
  assertEq(st.buttons.join(' | '), 'Allow on this network | Copy command', 'both remedies offered');

  // the button asks the host to add the rule, then the panel refreshes clean
  blocked = false;
  await page.evaluate(() => [...document.querySelectorAll('#gwpanel .gwfix button')]
    .find(b => b.textContent === 'Allow on this network').click());
  await page.waitForTimeout(1200);
  assertEq(posted, 1, 'the allow button posted to /api/firewall/allow');
  const after = await page.evaluate(() => ({
    fix: !!document.querySelector('#gwpanel .gwfix'),
    green: document.querySelector('#gwpanel .gwstatus').classList.contains('on'),
  }));
  assert(!after.fix && after.green, 'once allowed the warning goes and green returns: ' + JSON.stringify(after));
  await page.close();
};
