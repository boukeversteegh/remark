'use strict';

// ---------------------------------------------------------------------------
// remark app: renders the document, keeps comment drafts and pending
// operations in memory, and saves via compare-and-swap with retry so external
// writers (the reviewing agent) never clobber or get clobbered.
// ---------------------------------------------------------------------------

const qs = new URLSearchParams(location.search);
const TOKEN = qs.get('t') || '';
const PATH = qs.get('f') || '';

const S = {
  path: PATH,
  eol: '\n',
  doc: null,              // { content (raw), hash }  — server truth
  parsed: null,
  me: 'Me',
  mode: 'inline',
  queue: [],              // pending ops not yet confirmed written
  conflicts: [],          // ops whose anchor vanished; kept for the user
  saving: false,
  drafts: {},             // editorKey -> text (also mirrored to localStorage)
  editorsOpen: new Set(), // editor keys currently open
  collapsed: new Map(),   // thread root key -> bool (manual override)
  optimistic: new Map(),  // item key -> desired checked state
  known: null,            // Set of item keys seen in previous render
  focusMemo: null,
};

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

marked.use({ gfm: true });
function md(text) { return DOMPurify.sanitize(marked.parse(text)); }
function mdInline(text) { return DOMPurify.sanitize(marked.parseInline(text)); }

function normEol(s) { return s.replace(/\r\n/g, '\n'); }
function denormEol(s) { return S.eol === '\r\n' ? s.replace(/\n/g, '\r\n') : s; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// local-time stamp embedded into new comments as plain text: "2026-09-02 14:32"
function nowStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

async function api(method, path, body) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(path + sep + 't=' + TOKEN, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* empty body */ }
  return { status: res.status, json };
}

// ---------------------------------------------------------------------------
// prefs: stored server-side in the OS config dir so every remark window
// (one process per file) shares author name, mode, recents and drafts.
// ---------------------------------------------------------------------------
let PREFS = {};
async function loadPrefs() {
  const r = await api('GET', '/api/prefs');
  PREFS = r.json || {};
}
function setPref(k, v) {
  if (v === undefined) v = null;
  PREFS[k] = v;
  api('POST', '/api/prefs', { [k]: v });
}

// ---------------------------------------------------------------------------
// avatars: deterministic pastel per author; emoji-led names use the emoji
// ---------------------------------------------------------------------------
const AVATAR_HUES = [212, 262, 165, 25, 340, 190, 95, 45];
const darkTheme = matchMedia('(prefers-color-scheme: dark)');
function avatarEl(name) {
  const el = document.createElement('span');
  const m = (name || '').match(/^\p{Extended_Pictographic}/u);
  if (m) {
    el.className = 'avatar emoji';
    el.textContent = m[0];
    return el;
  }
  el.className = 'avatar';
  let h = 0;
  for (const c of (name || '?')) h = ((h * 31) + c.codePointAt(0)) >>> 0;
  const hue = AVATAR_HUES[h % AVATAR_HUES.length];
  if (darkTheme.matches) {
    el.style.background = 'hsl(' + hue + ' 45% 27%)';
    el.style.color = 'hsl(' + hue + ' 75% 82%)';
  } else {
    el.style.background = 'hsl(' + hue + ' 72% 90%)';
    el.style.color = 'hsl(' + hue + ' 62% 33%)';
  }
  el.textContent = ((name || '?').trim()[0] || '?').toUpperCase();
  return el;
}
darkTheme.addEventListener('change', () => { if (S.parsed) render(); });

// ---------------------------------------------------------------------------
// status chip
// ---------------------------------------------------------------------------
function setStatus(kind, text) {
  const el = $('#status');
  el.className = 'statuschip status-' + kind;
  const ic = { ok: 'check', busy: 'loader-circle', warn: 'triangle-alert' }[kind] || 'check';
  el.innerHTML = iconHTML(ic, kind === 'busy' ? 'spin' : '');
  el.appendChild(document.createTextNode(text));
}
function idleStatus() {
  if (S.conflicts.length) setStatus('warn', S.conflicts.length + ' comment(s) need re-anchoring');
  else setStatus('ok', 'saved');
}

// ---------------------------------------------------------------------------
// drafts
// ---------------------------------------------------------------------------
const draftsKey = () => 'drafts:' + S.path;
function loadDrafts() {
  S.drafts = Object.assign({}, PREFS[draftsKey()] || {});
  Object.keys(S.drafts).forEach(k => S.editorsOpen.add(k));
}
function persistDrafts() {
  const nonEmpty = {};
  for (const k of Object.keys(S.drafts)) if (S.drafts[k]) nonEmpty[k] = S.drafts[k];
  setPref(draftsKey(), Object.keys(nonEmpty).length ? nonEmpty : null);
}

// ---------------------------------------------------------------------------
// occurrence-annotated views of the parse
// ---------------------------------------------------------------------------
function annotate(parsed) {
  parsed.blocks.forEach(b => {
    if (b.type !== 'thread') return;
    b.thread.parent = null;
    (function link(it) {
      it.children.forEach(c => { c.parent = it; link(c); });
    })(b.thread);
  });
  const seenI = {};
  parsed.items.forEach(it => {
    it.occ = seenI[it.hash] || 0;
    seenI[it.hash] = it.occ + 1;
    it.key = it.hash + ':' + it.occ;
  });
  const seenB = {};
  parsed.blocks.forEach(b => {
    if (b.type === 'thread') return;
    b.occ = seenB[b.hash] || 0;
    seenB[b.hash] = b.occ + 1;
    b.key = b.hash + ':' + b.occ;
  });
}

function isMe(author) {
  return (author || '').toLowerCase() === S.me.toLowerCase();
}
function effChecked(item) {
  return S.optimistic.has(item.key) ? S.optimistic.get(item.key) : item.checked;
}
function isUnread(item) { return !effChecked(item) && !isMe(item.author); }

function threadStats(root) {
  let count = 0, unread = 0;
  (function walk(it) {
    count++;
    if (isUnread(it)) unread++;
    it.children.forEach(walk);
  })(root);
  return { count, unread };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------
const railEntries = []; // [{card, anchorEl}] in doc order, for margin layout

function render() {
  const parsed = RvParser.parse(normEol(S.doc.content));
  annotate(parsed);
  S.parsed = parsed;

  // clean confirmed optimistic toggles
  for (const it of parsed.items) {
    if (S.optimistic.has(it.key) && S.optimistic.get(it.key) === it.checked) {
      S.optimistic.delete(it.key);
    }
  }

  // remember focus inside an editor across the rebuild
  const ae = document.activeElement;
  if (ae && ae.tagName === 'TEXTAREA' && ae.closest('.editor')) {
    S.focusMemo = {
      key: ae.closest('.editor').dataset.key,
      selStart: ae.selectionStart, selEnd: ae.selectionEnd,
    };
  } else S.focusMemo = null;
  const scrollY = window.scrollY;

  // comments that arrived since the last render: expand the path to any
  // unread one so it is visible, and flash its card below
  const fresh = S.known ? parsed.items.filter(i => !S.known.has(i.key)) : [];
  for (const it of fresh) {
    if (isUnread(it)) {
      for (let p = it; p; p = p.parent) S.collapsed.set(p.key, false);
    }
  }

  const doc = $('#doc');
  const rail = $('#rail');
  doc.innerHTML = '';
  rail.innerHTML = '';
  railEntries.length = 0;

  let lastBlockEl = null;

  for (const block of parsed.blocks) {
    if (block.type === 'thread') {
      const card = buildThread(block);
      if (S.mode === 'margin') {
        rail.appendChild(card);
        railEntries.push({ card, anchorEl: lastBlockEl, root: block.thread });
        if (lastBlockEl) markAnchor(lastBlockEl, block.thread, card);
      } else {
        doc.appendChild(card);
      }
      continue;
    }
    const el = document.createElement('div');
    el.className = 'block';
    el.dataset.key = block.key;
    el.innerHTML = md(block.text);
    const btn = document.createElement('button');
    btn.className = 'addbtn';
    btn.title = 'Comment on this part';
    btn.innerHTML = iconHTML('message-square-plus');
    btn.addEventListener('click', () => toggleEditor('new:' + block.key));
    el.appendChild(btn);
    doc.appendChild(el);
    lastBlockEl = el;

    // mount an open new-comment editor for this block
    if (S.editorsOpen.has('new:' + block.key)) {
      doc.appendChild(buildEditor('new:' + block.key, block));
    }
  }

  renderConflicts();
  updateUnreadUI();
  buildOutline();

  // flash newly arrived comments
  for (const it of fresh) {
    const el = $('[data-ikey="' + CSS.escape(it.key) + '"]');
    const card = el && el.closest('.thread');
    if (card) {
      card.classList.remove('flash');
      void card.offsetWidth;
      card.classList.add('flash');
    }
  }
  S.known = new Set(parsed.items.map(i => i.key));

  window.scrollTo(0, scrollY);
  if (S.focusMemo) {
    const ed = $('.editor[data-key="' + CSS.escape(S.focusMemo.key) + '"] textarea');
    if (ed) {
      ed.focus();
      try { ed.setSelectionRange(S.focusMemo.selStart, S.focusMemo.selEnd); } catch (e) {}
    }
  }

  if (S.mode === 'margin') requestAnimationFrame(layoutRail);
}

function markAnchor(blockEl, root, card) {
  blockEl.classList.add('has-comments');
  const st = threadStats(root);
  let chip = $('.cchip', blockEl);
  if (!chip) {
    chip = document.createElement('span');
    chip.className = 'cchip';
    blockEl.appendChild(chip);
  }
  chip.innerHTML = iconHTML('message-square');
  chip.appendChild(document.createTextNode(String(st.count)));
  chip.classList.toggle('has-unread', st.unread > 0);
  chip.title = st.count + ' comment(s)' + (st.unread ? ', ' + st.unread + ' unread' : '');
  chip.addEventListener('click', () => {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
  });
  card.addEventListener('mouseenter', () => blockEl.classList.add('anchor-hl'));
  card.addEventListener('mouseleave', () => blockEl.classList.remove('anchor-hl'));
}

function buildThread(block) {
  const root = block.thread;
  const card = document.createElement('div');
  card.className = 'thread' + (threadStats(root).unread ? ' has-unread' : '');
  card.dataset.rootKey = root.key;
  card.appendChild(buildItem(root));
  return card;
}

// Whether this item starts out folded: roots fold by default once their
// whole subtree is read; replies stay open. Manual toggles win.
function isCollapsed(item) {
  const manual = S.collapsed.get(item.key);
  if (manual !== undefined) return manual;
  return !item.parent && threadStats(item).unread === 0;
}

function buildItem(item) {
  const st = threadStats(item);
  const collapsed = isCollapsed(item);
  const el = document.createElement('div');
  el.className = 'citem' +
    (isUnread(item) ? ' unread' : '') +
    (collapsed ? ' collapsed' : '') +
    (isMe(item.author) ? ' mine' : '');
  el.dataset.ikey = item.key;

  const head = document.createElement('div');
  head.className = 'chead';

  const tw = document.createElement('button');
  tw.className = 'twisty';
  tw.innerHTML = iconHTML('chevron-down');
  tw.title = collapsed ? 'Expand' : 'Collapse';
  tw.addEventListener('click', () => {
    S.collapsed.set(item.key, !collapsed);
    render();
  });
  head.appendChild(tw);

  if (isUnread(item)) {
    const dot = document.createElement('span');
    dot.className = 'udot';
    dot.title = 'Unread';
    head.appendChild(dot);
  }

  head.appendChild(avatarEl(item.author));

  const author = document.createElement('span');
  author.className = 'author';
  let dispName = item.author || '—';
  const em = dispName.match(/^\p{Extended_Pictographic}️?\s*/u);
  if (em && dispName.length > em[0].length) dispName = dispName.slice(em[0].length);
  author.textContent = dispName;
  head.appendChild(author);

  if (item.time) {
    const time = document.createElement('span');
    time.className = 'ctime';
    time.textContent = item.time;
    time.title = 'Written ' + item.time;
    head.appendChild(time);
  }

  if (collapsed) {
    const snip = document.createElement('span');
    snip.className = 'snippet';
    snip.textContent = item.bodyMd.split('\n')[0].replace(/[#*_`>\[\]]/g, '').slice(0, 80);
    head.appendChild(snip);
  }

  const sp = document.createElement('span');
  sp.className = 'spacer';
  head.appendChild(sp);

  if (collapsed && st.count > 1) {
    const rc = document.createElement('span');
    rc.className = 'rcount';
    rc.innerHTML = iconHTML('message-square');
    rc.appendChild(document.createTextNode(' ' + (st.count - 1) + (st.count === 2 ? ' reply' : ' replies')));
    head.appendChild(rc);
  }
  if (collapsed && st.unread > 0) {
    const nc = document.createElement('span');
    nc.className = 'newchip';
    nc.innerHTML = iconHTML('bell-dot');
    nc.appendChild(document.createTextNode(st.unread + ' new'));
    head.appendChild(nc);
  }

  // read-status pill: makes the checkbox convention explicit. For the other
  // side's comments it is your read-marker; for your own it shows whether
  // the other side has processed (ticked) your comment.
  const pill = document.createElement('button');
  const checked = effChecked(item);
  pill.className = 'rstat ' + (checked ? 'is-read' : 'is-new');
  let pillIcon, pillLabel;
  if (isMe(item.author)) {
    pillIcon = checked ? 'check-check' : 'clock';
    pillLabel = checked ? 'Processed' : 'Pending';
    pill.title = checked
      ? 'The other side ticked your comment — it has been processed. Click to untick.'
      : 'Waiting for the other side to process this comment (they tick its checkbox).';
  } else {
    pillIcon = checked ? 'check-check' : 'check';
    pillLabel = checked ? 'Read' : 'Mark read';
    pill.title = checked
      ? 'You marked this as read — click to mark unread'
      : 'Mark as read (ticks the comment’s checkbox in the file)';
  }
  pill.innerHTML = iconHTML(pillIcon);
  pill.appendChild(document.createTextNode(pillLabel));
  pill.addEventListener('click', () => {
    S.optimistic.set(item.key, !checked);
    submitOps([{ type: 'toggle', hash: item.hash, occ: item.occ, checked: !checked }]);
    render();
  });
  head.appendChild(pill);

  if (!collapsed) {
    const reply = document.createElement('button');
    reply.className = 'replybtn';
    reply.innerHTML = iconHTML('reply');
    reply.appendChild(document.createTextNode('Reply'));
    reply.addEventListener('click', () => toggleEditor('reply:' + item.key));
    head.appendChild(reply);
  }

  el.appendChild(head);

  const body = document.createElement('div');
  body.className = 'cbody';
  body.innerHTML = md(item.bodyMd);
  el.appendChild(body);

  for (const c of item.children) el.appendChild(buildItem(c));

  if (S.editorsOpen.has('reply:' + item.key)) {
    el.appendChild(buildEditor('reply:' + item.key, item));
  }
  return el;
}

// ---------------------------------------------------------------------------
// editors
// ---------------------------------------------------------------------------
function toggleEditor(key) {
  if (S.editorsOpen.has(key) && !S.drafts[key]) S.editorsOpen.delete(key);
  else S.editorsOpen.add(key);
  render();
}

function buildEditor(key, target) {
  const isReply = key.startsWith('reply:');
  const wrap = document.createElement('div');
  wrap.className = 'editor' + (isReply ? '' : ' newthread');
  wrap.dataset.key = key;

  const ta = document.createElement('textarea');
  ta.placeholder = isReply ? 'Reply… (markdown, Ctrl+Enter to send)' : 'New comment… (markdown, Ctrl+Enter to send)';
  ta.value = S.drafts[key] || '';
  ta.addEventListener('input', () => { S.drafts[key] = ta.value; persistDrafts(); });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
    if (e.key === 'Escape') close(false);
  });
  wrap.appendChild(ta);

  const bar = document.createElement('div');
  bar.className = 'ebar';
  bar.innerHTML = '<span>as <b></b></span><span class="spacer"></span><span><kbd>Ctrl</kbd> <kbd>⏎</kbd></span>';
  $('b', bar).textContent = S.me;
  const cancel = document.createElement('button');
  cancel.className = 'cancel';
  cancel.textContent = 'Discard';
  cancel.addEventListener('click', () => close(true));
  const sendBtn = document.createElement('button');
  sendBtn.className = 'send';
  sendBtn.innerHTML = iconHTML('send-horizontal');
  sendBtn.appendChild(document.createTextNode('Send'));
  sendBtn.addEventListener('click', send);
  bar.appendChild(cancel);
  bar.appendChild(sendBtn);
  wrap.appendChild(bar);

  function close(discard) {
    if (discard) { delete S.drafts[key]; persistDrafts(); }
    S.editorsOpen.delete(key);
    render();
  }
  function send() {
    const text = ta.value.trim();
    if (!text) return;
    let op;
    if (isReply) {
      op = { type: 'reply', parentHash: target.hash, occ: target.occ, author: S.me, text, time: nowStamp() };
    } else {
      // find nearest preceding heading for the fallback anchor
      const bi = S.parsed.blocks.indexOf(target);
      let sectionHash = null;
      for (let i = bi; i >= 0; i--) {
        if (S.parsed.blocks[i].type === 'heading') { sectionHash = S.parsed.blocks[i].hash; break; }
      }
      op = { type: 'add', blockHash: target.hash, occ: target.occ, sectionHash, author: S.me, text, time: nowStamp() };
    }
    delete S.drafts[key];
    persistDrafts();
    S.editorsOpen.delete(key);
    submitOps([op]);
    render();
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// save pipeline: apply pending ops to the freshest content, CAS-write, and
// on 409 re-apply against what the other writer produced and try again.
// ---------------------------------------------------------------------------
function submitOps(ops) {
  S.queue.push(...ops);
  drain();
}

async function drain() {
  if (S.saving || !S.queue.length) return;
  S.saving = true;
  setStatus('busy', 'saving…');
  try {
    let attempts = 0;
    while (S.queue.length && attempts < 20) {
      attempts++;
      const base = S.doc;
      const { text, results } = RvParser.applyOps(normEol(base.content), S.queue);

      const failed = results.filter(r => !r.ok).map(r => r.op);
      if (failed.length) {
        for (const r of results) if (!r.ok) S.conflicts.push({ op: r.op, reason: r.reason });
        S.queue = S.queue.filter(op => !failed.includes(op));
        renderConflicts();
        continue; // recompute without the failed ops
      }
      if (!S.queue.length) break;

      const body = denormEol(text);
      const res = await api('POST', '/api/file', { path: S.path, baseHash: base.hash, content: body });
      if (res.status === 200) {
        S.queue = [];
        S.doc = { content: body, hash: res.json.hash };
        render();
        break;
      } else if (res.status === 409) {
        setStatus('busy', 'file changed under us — reapplying…');
        S.doc = { content: res.json.content, hash: res.json.hash };
        detectEol();
        render();
        await sleep(100 + Math.random() * 300);
      } else {
        setStatus('warn', 'save failed: ' + ((res.json && res.json.error) || res.status));
        await sleep(1000);
      }
    }
  } finally {
    S.saving = false;
  }
  if (S.queue.length) setTimeout(drain, 500);
  else idleStatus();
}

// ---------------------------------------------------------------------------
// conflicts tray
// ---------------------------------------------------------------------------
function renderConflicts() {
  const tray = $('#conflicts');
  if (!S.conflicts.length) { tray.classList.add('hidden'); return; }
  tray.classList.remove('hidden');
  tray.innerHTML = '<h3>' + iconHTML('triangle-alert') + ' Comments that lost their place (the file changed too much)</h3>';
  S.conflicts.forEach((c, idx) => {
    const row = document.createElement('div');
    row.className = 'conflict';
    const txt = document.createElement('div');
    txt.className = 'ctext';
    txt.textContent = c.op.text || '(read-marker change)';
    const reason = document.createElement('div');
    reason.className = 'creason';
    reason.textContent = c.reason;
    txt.appendChild(reason);
    row.appendChild(txt);

    if (c.op.text) {
      const retry = document.createElement('button');
      retry.innerHTML = iconHTML('corner-down-right');
      retry.appendChild(document.createTextNode('Append at end'));
      retry.addEventListener('click', () => {
        S.conflicts.splice(idx, 1);
        submitOps([{ type: 'add', blockHash: null, occ: 0, sectionHash: c.op.sectionHash || null, author: c.op.author, text: c.op.text, time: c.op.time || nowStamp(), atEnd: true }]);
        renderConflicts();
      });
      const copy = document.createElement('button');
      copy.innerHTML = iconHTML('copy');
      copy.appendChild(document.createTextNode('Copy'));
      copy.addEventListener('click', () => navigator.clipboard.writeText(c.op.text));
      row.appendChild(copy);
      row.appendChild(retry);
    }
    const drop = document.createElement('button');
    drop.innerHTML = iconHTML('trash-2');
    drop.appendChild(document.createTextNode('Discard'));
    drop.addEventListener('click', () => { S.conflicts.splice(idx, 1); renderConflicts(); idleStatus(); });
    row.appendChild(drop);
    tray.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// unread navigation
// ---------------------------------------------------------------------------
let unreadCursor = -1;
function updateUnreadUI() {
  const unread = S.parsed ? S.parsed.items.filter(isUnread) : [];
  const btn = $('#unreadBtn');
  btn.classList.toggle('hidden', unread.length === 0);
  btn.innerHTML = iconHTML('bell-dot');
  btn.appendChild(document.createTextNode(unread.length + ' unread'));
  document.title = (unread.length ? '(' + unread.length + ') ' : '') + (S.path.split(/[\\/]/).pop() || 'remark');
}
function jumpUnread() {
  const unread = S.parsed.items.filter(isUnread);
  if (!unread.length) return;
  unreadCursor = (unreadCursor + 1) % unread.length;
  revealItem(unread[unreadCursor]);
}

// expands the path to a comment, scrolls to it and flashes its card
function revealItem(it) {
  for (let p = it; p; p = p.parent) S.collapsed.set(p.key, false);
  render();
  const el = $('[data-ikey="' + CSS.escape(it.key) + '"]');
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const card = el.closest('.thread');
  if (card) { card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash'); }
}

// ---------------------------------------------------------------------------
// outline panel: the document's headings, with unread markers per section.
// Clicking a title jumps to the heading; clicking a marker jumps to the
// section's first unread comment. Comments themselves are not listed.
// ---------------------------------------------------------------------------
function collectUnread(item, out) {
  if (isUnread(item)) out.push(item);
  item.children.forEach(c => collectUnread(c, out));
}

function buildOutline() {
  const nav = $('#outline');
  nav.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'ohead';
  head.innerHTML = iconHTML('table-of-contents');
  head.appendChild(document.createTextNode('Outline'));
  nav.appendChild(head);

  let current = null;
  const sections = [];
  for (const b of S.parsed.blocks) {
    if (b.type === 'heading') {
      current = { block: b, unread: [] };
      sections.push(current);
    } else if (b.type === 'thread' && current) {
      collectUnread(b.thread, current.unread);
    }
  }

  for (const sec of sections) {
    const row = document.createElement('div');
    row.className = 'orow l' + sec.block.level;
    const title = document.createElement('span');
    title.className = 'otitle';
    title.textContent = sec.block.headingText.replace(/[#*_`\[\]]/g, '');
    title.title = title.textContent;
    row.appendChild(title);
    row.addEventListener('click', () => {
      const el = $('.block[data-key="' + CSS.escape(sec.block.key) + '"]');
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.classList.add('anchor-hl');
      setTimeout(() => el.classList.remove('anchor-hl'), 1200);
    });
    if (sec.unread.length) {
      const mark = document.createElement('span');
      mark.className = 'omark';
      mark.textContent = sec.unread.length;
      mark.title = sec.unread.length + ' unread comment(s) here — click to jump to the first';
      mark.addEventListener('click', e => {
        e.stopPropagation();
        revealItem(sec.unread[0]);
      });
      row.appendChild(mark);
    }
    nav.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// margin layout
// ---------------------------------------------------------------------------
let layoutPending = false;
function layoutRail() {
  if (S.mode !== 'margin') return;
  const rail = $('#rail');
  const railRect = rail.getBoundingClientRect();
  let prevBottom = 0;
  for (const { card, anchorEl } of railEntries) {
    let want = 0;
    if (anchorEl) {
      const r = anchorEl.getBoundingClientRect();
      want = r.top - railRect.top;
    }
    const top = Math.max(want, prevBottom + 10);
    card.style.top = top + 'px';
    prevBottom = top + card.offsetHeight;
  }
  const docH = $('#doc').offsetHeight;
  rail.style.height = Math.max(docH, prevBottom + 20) + 'px';
}
function scheduleLayout() {
  if (layoutPending) return;
  layoutPending = true;
  requestAnimationFrame(() => { layoutPending = false; layoutRail(); });
}
new ResizeObserver(scheduleLayout).observe(document.body);
window.addEventListener('resize', scheduleLayout);

// draggable divider between document and comment rail (margin mode)
function wireDivider() {
  const div = $('#divider');
  const wrap = $('#docwrap');
  if (PREFS.splitPct) wrap.style.setProperty('--split', PREFS.splitPct + '%');
  let dragging = false;
  div.addEventListener('pointerdown', e => {
    dragging = true;
    div.setPointerCapture(e.pointerId);
    div.classList.add('dragging');
    e.preventDefault();
  });
  div.addEventListener('pointermove', e => {
    if (!dragging) return;
    const r = wrap.getBoundingClientRect();
    let pct = ((e.clientX - r.left) / r.width) * 100;
    pct = Math.max(28, Math.min(78, pct));
    wrap.style.setProperty('--split', pct.toFixed(1) + '%');
    scheduleLayout();
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    div.classList.remove('dragging');
    const v = parseFloat(wrap.style.getPropertyValue('--split'));
    if (v) setPref('splitPct', v);
    scheduleLayout();
  };
  div.addEventListener('pointerup', end);
  div.addEventListener('pointercancel', end);
  div.addEventListener('dblclick', () => {
    wrap.style.removeProperty('--split');
    setPref('splitPct', null);
    scheduleLayout();
  });
}

// ---------------------------------------------------------------------------
// live updates
// ---------------------------------------------------------------------------
function detectEol() { S.eol = S.doc.content.includes('\r\n') ? '\r\n' : '\n'; }

function openEvents() {
  const es = new EventSource('/api/events?path=' + encodeURIComponent(S.path) + '&t=' + TOKEN);
  es.onmessage = e => {
    const state = JSON.parse(e.data);
    if (S.doc && state.hash === S.doc.hash) return;
    S.doc = { content: state.content, hash: state.hash };
    detectEol();
    render();
    if (!S.saving) idleStatus();
  };
  es.onopen = () => { if (!S.saving) idleStatus(); };
  es.onerror = () => setStatus('warn', 'watcher reconnecting…');
}

// ---------------------------------------------------------------------------
// recents / landing
// ---------------------------------------------------------------------------
function recents() {
  return Array.isArray(PREFS.recents) ? PREFS.recents : [];
}
function addRecent(p) {
  setPref('recents', [p].concat(recents().filter(x => x !== p)).slice(0, 10));
}
function splitPath(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return { dir: i >= 0 ? p.slice(0, i + 1) : '', base: p.slice(i + 1) };
}

function showLanding() {
  document.body.classList.add('landing');
  $('#brandmark').innerHTML = iconHTML('notebook-pen');
  $('#landing').classList.remove('hidden');
  $('#heroIcon').innerHTML = iconHTML('notebook-pen');
  const browse = $('#browseBtn');
  browse.innerHTML = iconHTML('folder-open');
  browse.appendChild(document.createTextNode('Browse for a file…'));
  browse.addEventListener('click', pickAndOpen);
  const list = recents();
  if (list.length) {
    const div = $('#recent');
    div.innerHTML = '<h3>Recent files</h3>';
    for (const p of list) {
      const a = document.createElement('a');
      a.href = '/?t=' + TOKEN + '&f=' + encodeURIComponent(p);
      const { dir, base } = splitPath(p);
      a.innerHTML = iconHTML('file-text');
      const name = document.createElement('span');
      name.className = 'rname';
      name.textContent = base;
      const dd = document.createElement('span');
      dd.className = 'rdir';
      dd.textContent = dir.replace(/[\\/]+$/, '');
      a.appendChild(name);
      a.appendChild(dd);
      div.appendChild(a);
    }
  }
  $('#openForm').addEventListener('submit', e => {
    e.preventDefault();
    const p = $('#pathInput').value.trim();
    if (p) location.href = '/?t=' + TOKEN + '&f=' + encodeURIComponent(p);
  });
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
// native open-file dialog via the server; falls back to the manual path
// input on platforms without one
async function pickAndOpen() {
  const dir = S.path ? splitPath(S.path).dir : '';
  const r = await api('GET', '/api/pickfile?dir=' + encodeURIComponent(dir));
  if (r.status === 200 && r.json && r.json.path) {
    location.href = '/?t=' + TOKEN + '&f=' + encodeURIComponent(r.json.path);
  } else if (!S.path) {
    const inp = $('#pathInput');
    if (inp) inp.focus();
  }
}

function applyChrome() {
  $('#main').className = 'mode-' + S.mode + (S.outline ? ' outline-open' : '');
}

function wireTopbar() {
  $('#brandmark').innerHTML = iconHTML('notebook-pen');
  $('#openBtn').innerHTML = iconHTML('folder-open');
  $('#openBtn').addEventListener('click', pickAndOpen);
  $('#outlineBtn').innerHTML = iconHTML('panel-left');
  $('#outlineBtn').addEventListener('click', () => {
    S.outline = !S.outline;
    setPref('outline', S.outline);
    applyChrome();
    if (S.mode === 'margin') scheduleLayout();
  });
  $('#collapseAll').innerHTML = iconHTML('chevrons-down-up');
  $('#expandAll').innerHTML = iconHTML('chevrons-up-down');
  const segIcons = { inline: 'wrap-text', margin: 'panel-right' };
  for (const b of $$('#modeSeg button')) {
    b.innerHTML = iconHTML(segIcons[b.dataset.mode]);
    b.appendChild(document.createTextNode(' ' + b.dataset.mode[0].toUpperCase() + b.dataset.mode.slice(1)));
  }
  const meIn = $('#meInput');
  meIn.value = S.me;
  meIn.addEventListener('change', () => {
    S.me = meIn.value.trim() || 'Me';
    setPref('me', S.me);
    render();
  });
  for (const b of $$('#modeSeg button')) {
    b.classList.toggle('active', b.dataset.mode === S.mode);
    b.addEventListener('click', () => {
      S.mode = b.dataset.mode;
      setPref('mode', S.mode);
      $$('#modeSeg button').forEach(x => x.classList.toggle('active', x === b));
      applyChrome();
      render();
    });
  }
  $('#collapseAll').addEventListener('click', () => {
    for (const b of S.parsed.blocks) if (b.type === 'thread') S.collapsed.set(b.thread.key, true);
    render();
  });
  $('#expandAll').addEventListener('click', () => {
    for (const it of S.parsed.items) S.collapsed.set(it.key, false);
    render();
  });
  $('#unreadBtn').addEventListener('click', jumpUnread);
}

async function init() {
  await loadPrefs();
  S.me = PREFS.me || 'Me';
  S.mode = PREFS.mode || 'inline';
  S.outline = PREFS.outline !== undefined ? PREFS.outline : true;
  if (!S.path) { showLanding(); return; }
  applyChrome();
  const fn = $('#filename');
  fn.textContent = '';
  const bb = document.createElement('b');
  bb.textContent = splitPath(S.path).base;
  fn.appendChild(bb);
  fn.title = S.path;
  wireTopbar();
  wireDivider();
  new ResizeObserver(scheduleLayout).observe($('#doc'));
  new ResizeObserver(scheduleLayout).observe($('#rail'));
  loadDrafts();

  const res = await api('GET', '/api/file?path=' + encodeURIComponent(S.path));
  if (res.status !== 200) {
    setStatus('warn', 'cannot open file');
    $('#doc').innerHTML = '<p style="color:var(--danger)">Could not open <code></code></p>';
    $('#doc code').textContent = S.path + ' — ' + ((res.json && res.json.error) || res.status);
    return;
  }
  addRecent(S.path);
  S.doc = { content: res.json.content, hash: res.json.hash };
  detectEol();
  render();
  idleStatus();
  openEvents();
}

window.addEventListener('beforeunload', e => {
  if (S.queue.length || S.saving) { e.preventDefault(); e.returnValue = ''; }
});

init();
