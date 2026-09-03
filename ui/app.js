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
  optimistic: new Map(),  // item key -> desired resolved state
  optimisticSeen: new Map(), // item key -> desired seen-by-me state
  known: null,            // Set of item keys seen in previous render
  focusMemo: null,
};

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

marked.use({ gfm: true });
function md(text) {
  const clean = DOMPurify.sanitize(marked.parse(text));
  // relative image links resolve against the DOCUMENT's folder, not the
  // app origin — route them through the scoped asset endpoint
  if (clean.includes('<img')) {
    const tpl = document.createElement('template');
    tpl.innerHTML = clean;
    for (const img of tpl.content.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      if (src && !/^([a-z][a-z0-9+.-]*:|\/)/i.test(src)) {
        img.src = '/api/asset?path=' + encodeURIComponent(S.path) +
          '&f=' + encodeURIComponent(src) + '&t=' + TOKEN;
      }
    }
    return tpl.innerHTML;
  }
  return clean;
}

// fence-aware split of a comment body into paragraph chunks; chunk hashes
// line up with RvParser.itemParagraphs so interjections can anchor on them
function mdChunks(mdText) {
  const chunks = [];
  let cur = [];
  let inFence = false;
  for (const l of mdText.split('\n')) {
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
    if (!inFence && l.trim() === '') {
      if (cur.length) { chunks.push(cur.join('\n')); cur = []; }
    } else {
      cur.push(l);
    }
  }
  if (cur.length) chunks.push(cur.join('\n'));
  return chunks;
}
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
  Object.keys(S.drafts).forEach(k => {
    if (!k.endsWith(':title')) S.editorsOpen.add(k);
  });
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

// Identity is the LITERAL author string (owner's decree in the Delivery
// receipts thread): no case folding, no emoji stripping, no magic. The only
// hygiene is whitespace trimming, which comes from parsing, not matching.
// "🤖 Claude" and "claude" are two different participants.
function normName(s) {
  return (s || '').trim();
}
function isMe(author) {
  return normName(author) === normName(S.me);
}
function effChecked(item) {
  return S.optimistic.has(item.key) ? S.optimistic.get(item.key) : item.checked;
}
function seenByMe(item) {
  if (S.optimisticSeen.has(item.key)) return S.optimisticSeen.get(item.key);
  return (item.seenBy || []).some(n => normName(n) === normName(S.me));
}
// unread = someone else's comment you haven't marked seen. A legacy-style
// tick on a resolvable item still counts as read so old files stay sane.
function isUnread(item) {
  if (isMe(item.author)) return false;
  if (seenByMe(item)) return false;
  return !(item.resolvable && effChecked(item));
}

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

// literal identity: names display exactly as written, no dressing up
function prettyName(n) {
  return n;
}

function render() {
  const parsed = RvParser.parse(normEol(S.doc.content));
  annotate(parsed);
  S.parsed = parsed;

  // clean confirmed optimistic state
  for (const it of parsed.items) {
    if (S.optimistic.has(it.key) && S.optimistic.get(it.key) === it.checked) {
      S.optimistic.delete(it.key);
    }
    if (S.optimisticSeen.has(it.key)) {
      const real = (it.seenBy || []).some(n => normName(n) === normName(S.me));
      if (real === S.optimisticSeen.get(it.key)) S.optimisticSeen.delete(it.key);
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
  let lastAnchorBlock = null; // anchor of the current thread cluster
  let clusterThreads = 0;
  let pendingEditor = null;
  let prevThreadBlock = null; // previous thread card in this cluster (seams)

  // ends a paragraph+threads cluster: the new-thread composer (and a ghost
  // "new thread here" button) sit AFTER the cluster's threads, matching
  // where a new comment is actually inserted in the file
  const endCluster = () => {
    if (S.mode !== 'margin' && clusterThreads > 0 && lastAnchorBlock &&
        !S.editorsOpen.has('new:' + lastAnchorBlock.key)) {
      const target = lastAnchorBlock;
      const nb = document.createElement('button');
      nb.className = 'newthreadbtn';
      nb.innerHTML = iconHTML('message-square-plus');
      nb.appendChild(document.createTextNode('New thread here'));
      nb.addEventListener('click', () => toggleEditor('new:' + target.key));
      doc.appendChild(nb);
    }
    clusterThreads = 0;
    prevThreadBlock = null;
    if (pendingEditor) {
      doc.appendChild(buildEditor(pendingEditor.key, pendingEditor.block));
      pendingEditor = null;
    }
  };

  for (const block of parsed.blocks) {
    if (block.type === 'thread') {
      // toolbar filter: resolved threads drop out of view entirely — but
      // never ones with unread comments, or the unread navigation would
      // point at nothing
      if (S.hideResolved && block.thread.resolvable && effChecked(block.thread) &&
          threadStats(block.thread).unread === 0) continue;
      clusterThreads++;
      const card = buildThread(block);
      if (S.mode === 'margin') {
        rail.appendChild(card);
        railEntries.push({ card, anchorEl: lastBlockEl, root: block.thread });
        if (lastBlockEl) markAnchor(lastBlockEl, block.thread, card);
      } else {
        // a seam between consecutive threads inserts a new thread right
        // there in the file — same affordance as between paragraphs
        if (prevThreadBlock) {
          const pt = prevThreadBlock;
          const tgap = document.createElement('div');
          tgap.className = 'igap tgap';
          tgap.title = 'Insert a thread between these two';
          tgap.innerHTML = '<span class="iglabel">— insert thread —</span>';
          tgap.addEventListener('click', () => toggleEditor('new:' + pt.key));
          doc.appendChild(tgap);
          if (S.editorsOpen.has('new:' + pt.key)) {
            doc.appendChild(buildEditor('new:' + pt.key, pt));
          }
        }
        doc.appendChild(card);
        prevThreadBlock = block;
      }
      continue;
    }
    endCluster();
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
    lastAnchorBlock = block;

    if (S.editorsOpen.has('new:' + block.key)) {
      pendingEditor = { key: 'new:' + block.key, block };
    }
  }
  endCluster();

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
  if (S.pendingFocus) {
    const ed = $('.editor[data-key="' + CSS.escape(S.pendingFocus) + '"] textarea');
    if (ed) {
      ed.focus();
      try { ed.setSelectionRange(ed.value.length, ed.value.length); } catch (e) {}
    }
    S.pendingFocus = null;
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

// Resolving a subtree that still has unread comments is not allowed
// blind: the first click arms the button into an inline question with the
// count ("Mark N unread as read & resolve?"); a second click within a few
// seconds marks them all read and resolves in one batch. Reopening never
// asks.
function wireResolve(btn, item, resolved) {
  btn.addEventListener('click', () => {
    const ops = [];
    if (!resolved) {
      const unread = [];
      collectUnread(item, unread);
      if (unread.length && !btn.dataset.armed) {
        btn.dataset.armed = '1';
        btn.classList.add('confirming');
        btn.innerHTML = iconHTML('check-check');
        btn.appendChild(document.createTextNode(
          'Mark ' + unread.length + ' unread as read & resolve?'));
        setTimeout(() => { if (btn.isConnected && btn.dataset.armed) render(); }, 5000);
        return;
      }
      for (const it of unread) {
        S.optimisticSeen.set(it.key, true);
        ops.push({ type: 'seen', hash: it.hash, occ: it.occ, reader: S.me, on: true });
      }
      // resolving folds the thread away — that's the point of settling it.
      // Empty composers in the subtree close first (they'd invisibly pin it
      // open); one with typed text keeps the thread open to protect the draft.
      const subKeys = [];
      (function walk(it) { subKeys.push(it.key); it.children.forEach(walk); })(item);
      for (const ek of [...S.editorsOpen]) {
        const inSub = subKeys.some(k =>
          ek === 'reply:' + k || ek === 'edit:' + k || ek.startsWith('ipara:' + k + ':'));
        if (inSub && !S.drafts[ek]) S.editorsOpen.delete(ek);
      }
      if (!item.parent && !hasOpenEditor(item)) {
        S.collapsed.set(item.key, true);
        persistCollapse(item.key, true);
      }
    }
    S.optimistic.set(item.key, !resolved);
    ops.push({ type: 'resolve', hash: item.hash, occ: item.occ, resolved: !resolved });
    submitOps(ops);
    render();
  });
}

function buildThread(block) {
  const root = block.thread;
  const card = document.createElement('div');
  // left-edge state: blue = has unread, amber = open (unresolved) but all
  // read, neutral = resolved or status-free
  const stripe = threadStats(root).unread ? ' has-unread'
    : (root.resolvable && !effChecked(root) ? ' is-open' : '');
  card.className = 'thread' + stripe;
  card.dataset.rootKey = root.key;
  card.appendChild(buildItem(root));

  // resolve/reopen at the thread's bottom — same author-owned resolution as
  // the root's pill, reachable without scrolling back up
  if (root.resolvable && !isCollapsed(root)) {
    const resolved = effChecked(root);
    const tf = document.createElement('div');
    tf.className = 'tfoot';
    const rbtn = document.createElement('button');
    rbtn.className = 'rstat ' + (resolved ? 'is-read' : 'is-open');
    rbtn.innerHTML = iconHTML(resolved ? 'clock' : 'check-check');
    rbtn.appendChild(document.createTextNode(resolved ? 'Reopen thread' : 'Resolve thread'));
    rbtn.title = 'Thread resolution — ' + (isMe(root.author) ? 'yours to settle' : 'owned by ' + (root.author || 'its author'));
    wireResolve(rbtn, root, resolved);
    tf.appendChild(rbtn);
    card.appendChild(tf);
  }

  // scroll-to-top-of-thread button: lives in the right gutter, sticky so it
  // stays on screen but never leaves the thread's own vertical extent
  const rail2 = document.createElement('div');
  rail2.className = 'tsticky';
  const topBtn = document.createElement('button');
  topBtn.className = 'ttop';
  topBtn.title = 'Scroll to the top of this thread';
  topBtn.innerHTML = iconHTML('chevron-down');
  topBtn.addEventListener('click', () => {
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  rail2.appendChild(topBtn);
  // the card clips its contents (overflow: hidden for the rounded corners),
  // so the gutter rail must live OUTSIDE it — a positioning wrapper carries
  // both. Margin mode has no gutter rail and keeps the bare card.
  if (S.mode === 'margin') return card;
  const twrap = document.createElement('div');
  twrap.className = 'twrap';
  twrap.appendChild(card);
  twrap.appendChild(rail2);
  return twrap;
}

function hasOpenEditor(item) {
  if (S.editorsOpen.has('reply:' + item.key)) return true;
  if (S.editorsOpen.has('edit:' + item.key)) return true;
  return item.children.some(hasOpenEditor);
}

// Whether this item starts out folded: roots fold by default once their
// whole subtree is read; replies stay open. The computed default is locked
// in, so later read-state changes never move the UI — collapsing happens
// only on explicit action. A subtree with an open editor never folds.
// deliberate fold/unfold choices persist across restarts, per file, in
// localStorage; computed defaults and programmatic expansions stay
// session-only so future defaults aren't frozen
function persistCollapse(key, val) {
  if (!S.collapsedSaved) S.collapsedSaved = {};
  S.collapsedSaved[key] = val;
  try {
    const valid = new Set(S.parsed.items.map(i => i.key));
    const out = {};
    for (const k in S.collapsedSaved) if (valid.has(k)) out[k] = S.collapsedSaved[k];
    S.collapsedSaved = out;
    localStorage.setItem('remark:collapsed:' + S.path, JSON.stringify(out));
  } catch (e) { /* storage full/blocked: state stays session-only */ }
}

function isCollapsed(item) {
  if (hasOpenEditor(item)) {
    S.collapsed.set(item.key, false);
    return false;
  }
  const manual = S.collapsed.get(item.key);
  if (manual !== undefined) return manual;
  if (S.collapsedSaved && item.key in S.collapsedSaved) {
    const saved = S.collapsedSaved[item.key];
    S.collapsed.set(item.key, saved);
    return saved;
  }
  const def = !item.parent && threadStats(item).unread === 0;
  S.collapsed.set(item.key, def);
  return def;
}

function buildItem(item) {
  const st = threadStats(item);
  const collapsed = isCollapsed(item);
  const el = document.createElement('div');
  // your own comment with no reply yet (no child, nothing after it at its
  // level) wears an amber edge while the thread is unresolved — a
  // comment-level "awaiting reply", never propagated to thread status
  let root = item;
  while (root.parent) root = root.parent;
  const lastAtLevel = !item.parent ||
    item.parent.children[item.parent.children.length - 1] === item;
  const unreplied = !(root.resolvable && effChecked(root)) &&
    isMe(item.author) && item.children.length === 0 && lastAtLevel;
  el.className = 'citem' +
    (isUnread(item) ? ' unread' : '') +
    (collapsed ? ' collapsed' : '') +
    (unreplied ? ' unreplied' : '') +
    (isMe(item.author) ? ' mine' : '');
  el.dataset.ikey = item.key;

  const head = document.createElement('div');
  head.className = 'chead';
  // the whole header row toggles collapse; buttons inside keep their own action
  head.addEventListener('click', e => {
    if (e.target.closest('button, input, a')) return;
    S.collapsed.set(item.key, !collapsed);
    persistCollapse(item.key, !collapsed);
    render();
  });

  const tw = document.createElement('button');
  tw.className = 'twisty';
  tw.innerHTML = iconHTML('chevron-down');
  tw.title = collapsed ? 'Expand' : 'Collapse';
  tw.addEventListener('click', () => {
    S.collapsed.set(item.key, !collapsed);
    persistCollapse(item.key, !collapsed);
    render();
  });
  head.appendChild(tw);

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

  if (item.title) {
    const tt = document.createElement('span');
    tt.className = 'ctitle';
    tt.textContent = item.title;
    tt.title = item.title;
    head.appendChild(tt);
  } else if (collapsed) {
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

  // own comments get a hover-revealed edit pencil in the header corner
  const editing = S.editorsOpen.has('edit:' + item.key) && isMe(item.author);
  if (!collapsed && isMe(item.author) && !editing) {
    const eb = document.createElement('button');
    eb.className = 'replybtn inhead';
    eb.innerHTML = iconHTML('pencil');
    eb.title = 'Edit your comment';
    eb.addEventListener('click', () => toggleEditor('edit:' + item.key));
    head.appendChild(eb);
  }

  // leaf comments get Reply in the header corner, before the status pills —
  // except thread roots, whose reply affordance is the bottom slot
  if (!collapsed && item.children.length === 0 && item.parent) {
    const reply = document.createElement('button');
    reply.className = 'replybtn inhead';
    reply.innerHTML = iconHTML('reply');
    reply.appendChild(document.createTextNode('Reply'));
    reply.addEventListener('click', () => toggleEditor('reply:' + item.key));
    head.appendChild(reply);
  }

  // resolution pill — only on items written with a checkbox; the status is
  // the AUTHOR's to settle (anyone can click, the tooltip says whose call)
  if (item.resolvable) {
    const checked = effChecked(item);
    const rpill = document.createElement('button');
    rpill.className = 'rstat ' + (checked ? 'is-read' : 'is-open');
    rpill.innerHTML = iconHTML(checked ? 'check-check' : 'clock');
    rpill.appendChild(document.createTextNode(checked ? 'Resolved' : 'Open'));
    rpill.title = 'Resolution — ' +
      (isMe(item.author) ? 'yours to settle' : 'owned by ' + (item.author || 'its author')) +
      (checked ? '. Click to reopen.' : '. Click to resolve.');
    wireResolve(rpill, item, checked);
    head.appendChild(rpill);
  }

  // per-message read state: a GitHub-style dot on the right — filled when
  // unread, hollow when read, toggleable, stored as a hidden seen-marker
  if (!isMe(item.author)) {
    const seen = seenByMe(item);
    const rdot = document.createElement('button');
    rdot.className = 'rdot' + (seen ? ' seen' : '');
    if (seen) rdot.innerHTML = iconHTML('check');
    rdot.title = seen
      ? 'Read — click to mark unread'
      : 'Unread — click to mark read (writes a seen-marker, just for you)';
    rdot.addEventListener('click', () => {
      S.optimisticSeen.set(item.key, !seen);
      submitOps([{ type: 'seen', hash: item.hash, occ: item.occ, reader: S.me, on: !seen }]);
      render();
    });
    head.appendChild(rdot);
  } else if ((item.seenBy || []).length) {
    const sb = document.createElement('span');
    sb.className = 'seenby';
    sb.innerHTML = iconHTML('check-check');
    sb.dataset.tip = 'Seen by ' + item.seenBy.map(prettyName).join(', ');
    head.appendChild(sb);
  }
  // the delivery ladder's first rung: a single check per agent whose
  // monitor emitted events for this file after the comment was written —
  // "reached X's monitor", nothing more. Upgrades to the ✓✓ above once
  // that agent writes its seen-marker.
  if (isMe(item.author) && item.time) {
    const seenNorm = new Set((item.seenBy || []).map(normName));
    for (const pr of S.presence || []) {
      if (pr.kind !== 'agent' || !pr.delivered || pr.delivered < item.time) continue;
      if (seenNorm.has(normName(pr.name))) continue;
      const dv = document.createElement('span');
      dv.className = 'dcheck';
      dv.innerHTML = iconHTML('check');
      dv.dataset.tip = 'Reached ' + prettyName(pr.name) + "'s monitor at " + pr.delivered.slice(11);
      head.appendChild(dv);
    }
  }

  el.appendChild(head);

  // editing swaps the body text for a composer; children keep rendering
  // below it (the edit op writes the new body as one block before them)
  if (editing) el.appendChild(buildEditor('edit:' + item.key, item));

  // segments preserve order: an interjection (a reply placed half-way
  // through a comment) renders exactly where it sits in the markdown.
  // Interjections nested INSIDE a list render as children of the list item
  // they sit under (the raw markdown already has that shape) — the list is
  // stitched back together around them so numbering flows on.
  const trailingList = b => {
    const ps = b ? b.querySelectorAll('.cpara') : [];
    const lp = ps.length ? ps[ps.length - 1] : null;
    const t = lp && lp.lastElementChild;
    return t && /^(OL|UL)$/.test(t.tagName) ? t : null;
  };
  const hangInLi = (list, card) => {
    const w = document.createElement('div');
    w.className = 'licard';
    w.appendChild(card);
    list.lastElementChild.appendChild(w);
  };
  let lastBody = null;
  let pendingLi = null; // cards awaiting the list continuation in the next text
  for (let si = 0; si < item.segments.length; si++) {
    const seg = item.segments[si];
    if (seg.type === 'text') {
      if (editing) continue;
      const body = document.createElement('div');
      body.className = 'cbody';
      const chunks = mdChunks(seg.md);
      chunks.forEach((chunk, ci) => {
        const pHash = RvParser.hashText(RvParser.normalize(chunk));
        const ikey = 'ipara:' + item.key + ':' + pHash;
        const pe = document.createElement('div');
        pe.className = 'cpara';
        pe.innerHTML = md(chunk);
        body.appendChild(pe);
        // interject zone BETWEEN paragraphs only — a single-paragraph
        // comment has no in-between, so it gets none (reply covers it)
        if (ci < chunks.length - 1) {
          const gap = document.createElement('div');
          gap.className = 'igap';
          gap.title = 'Insert a comment between these paragraphs';
          gap.innerHTML = '<span class="iglabel">— insert comment —</span>';
          gap.addEventListener('click', () => toggleEditor(ikey));
          body.appendChild(gap);
        }
        if (S.editorsOpen.has(ikey)) {
          body.appendChild(buildEditor(ikey, { item: item, paraHash: pHash }));
        }
      });
      if (pendingLi) {
        // this text continues the interrupted list: hang the cards inside
        // the li they were nested under, then splice the two list halves
        const fp = body.querySelector('.cpara');
        const nl = fp && fp.firstElementChild;
        if (nl && nl.tagName === pendingLi.list.tagName) {
          pendingLi.cards.forEach(c => hangInLi(pendingLi.list, c));
          while (nl.firstChild) pendingLi.list.appendChild(nl.firstChild);
          nl.remove();
          if (!fp.childElementCount) fp.remove();
        } else {
          pendingLi.cards.forEach(c => el.appendChild(c));
        }
        pendingLi = null;
      }
      el.appendChild(body);
      lastBody = body;
    } else {
      const card = buildItem(seg.item);
      const tl = trailingList(lastBody);
      const nxt = item.segments[si + 1];
      const nxtFirst = nxt && nxt.type === 'text'
        ? (nxt.md.split('\n').find(l => l.trim() !== '') || '') : '';
      if (tl && /^ {0,3}(?:[-*+]|\d+[.)])\s/.test(nxtFirst)) {
        (pendingLi = pendingLi || { list: tl, cards: [] }).cards.push(card);
      } else if (tl && !nxt) {
        hangInLi(tl, card); // nested under the final list item
      } else {
        el.appendChild(card);
      }
    }
  }
  if (pendingLi) pendingLi.cards.forEach(c => el.appendChild(c));

  // exactly ONE reply affordance per comment: leaves have it in the header
  // (scrolling up on a long comment is intentional friction toward flat
  // discussion); only comments WITH children keep it after the subtree,
  // where it appends at that level
  // thread roots always have the bottom slot (even childless — a fresh
  // thread must be answerable without hunting for the header ↩)
  if (!collapsed && (item.children.length > 0 || !item.parent) &&
      !S.editorsOpen.has('reply:' + item.key)) {
    const foot = document.createElement('div');
    foot.className = 'cfoot';
    // a quiet input-shaped seed: "here is where you type" — focusing it
    // swaps in the real editor
    const seed = document.createElement('input');
    seed.className = 'replyseed';
    seed.placeholder = 'Reply…';
    seed.readOnly = true;
    seed.addEventListener('focus', () => toggleEditor('reply:' + item.key));
    foot.appendChild(seed);
    el.appendChild(foot);
  }

  if (S.editorsOpen.has('reply:' + item.key)) {
    el.appendChild(buildEditor('reply:' + item.key, item));
  }
  return el;
}

// ---------------------------------------------------------------------------
// editors
// ---------------------------------------------------------------------------
function toggleEditor(key) {
  if (S.editorsOpen.has(key) && !S.drafts[key]) {
    S.editorsOpen.delete(key);
  } else {
    S.editorsOpen.add(key);
    S.pendingFocus = key;
  }
  render();
}

function buildEditor(key, target) {
  const isReply = key.startsWith('reply:');
  const isInterject = key.startsWith('ipara:');
  const isEdit = key.startsWith('edit:');
  const isNewThread = !isReply && !isInterject && !isEdit;
  const tKey = key + ':title';
  const wrap = document.createElement('div');
  wrap.className = 'editor' + (isNewThread ? ' newthread' : '');
  wrap.dataset.key = key;

  // new threads get an optional title line (never auto-focused); editing a
  // thread root shows it too, prefilled, so a title can be added later
  const editRoot = isEdit && !target.parent;
  let titleIn = null;
  if (isNewThread || editRoot) {
    titleIn = document.createElement('input');
    titleIn.className = 'etitle';
    titleIn.placeholder = 'Title (optional)';
    titleIn.value = editRoot && !(tKey in S.drafts) ? (target.title || '') : (S.drafts[tKey] || '');
    titleIn.addEventListener('input', () => { S.drafts[tKey] = titleIn.value; persistDrafts(); });
    titleIn.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); ta.focus(); }
      if (e.key === 'Escape') close(false);
    });
    wrap.appendChild(titleIn);
  }

  const ta = document.createElement('textarea');
  ta.placeholder = isEdit ? 'Edit… (markdown, Ctrl+Enter to save)'
    : isReply ? 'Reply… (markdown, Ctrl+Enter to send)' : 'New comment… (markdown, Ctrl+Enter to send)';
  // edits prefill with the comment's raw markdown body; when the title input
  // is shown it takes the title line, the textarea gets the rest
  const editPrefill = isEdit ? (titleIn ? target.rawBody.replace(/^\*\*[^\n]*\*\*\n?/, '') : target.rawBody) : '';
  ta.value = isEdit && !(key in S.drafts) ? editPrefill : (S.drafts[key] || '');
  const autosize = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 2, 340) + 'px';
  };
  // paste an image: the link lands at the cursor immediately, but the BYTES
  // stay in memory until Send — an accidental paste discarded with the
  // draft leaves nothing on disk. The clipboard's own filename wins when it
  // has a real one, otherwise <docname>-<stamp>.<ext>.
  ta.addEventListener('paste', e => {
    const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('image/'));
    if (!f) return;
    e.preventDefault();
    const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    let name = f.name && !/^image(\.[a-z0-9]+)?$/i.test(f.name)
      ? f.name.replace(/[^A-Za-z0-9._-]+/g, '-') : '';
    if (!name) {
      const stem = splitPath(S.path).base.replace(/\.[^.]*$/, '');
      const d = new Date(), pd = n => String(n).padStart(2, '0');
      name = stem + '-' + d.getFullYear() + pd(d.getMonth() + 1) + pd(d.getDate()) +
        '-' + pd(d.getHours()) + pd(d.getMinutes()) + pd(d.getSeconds()) + '.' + ext;
    } else if (!/\.[a-z0-9]+$/i.test(name)) name += '.' + ext;
    if (!S.pendingImgs) S.pendingImgs = new Map();
    const pend = S.pendingImgs.get(key) || [];
    let final = name, ix = 2;
    while (pend.some(p => p.name === final)) {
      final = name.replace(/(\.[^.]*)$/, '-' + (ix++) + '$1');
    }
    pend.push({ name: final, file: f, ext });
    S.pendingImgs.set(key, pend);
    const link = '![' + final + '](' + final + ')';
    const s0 = ta.selectionStart, s1 = ta.selectionEnd;
    ta.value = ta.value.slice(0, s0) + link + ta.value.slice(s1);
    ta.selectionStart = ta.selectionEnd = s0 + link.length;
    ta.dispatchEvent(new Event('input'));
  });
  ta.addEventListener('input', () => {
    S.drafts[key] = ta.value;
    persistDrafts();
    autosize();
  });
  requestAnimationFrame(autosize);
  wrap.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
    if (e.key === 'Escape') close(isEdit); // Esc on an edit restores the original
  });
  wrap.appendChild(ta);

  const preview = document.createElement('div');
  preview.className = 'epreview cbody';
  preview.style.display = 'none';
  wrap.appendChild(preview);

  const bar = document.createElement('div');
  bar.className = 'ebar';
  bar.innerHTML = '<span>as <b></b></span><span class="spacer"></span><span><kbd>Ctrl</kbd> <kbd>⏎</kbd></span>';
  $('b', bar).textContent = S.me;

  // opener toggle: a plain reply carries no status; ticking this writes a
  // checkbox item with its own author-owned resolution. New threads default
  // to resolvable — a root is a resolvable thing by nature.
  const opLabel = document.createElement('label');
  opLabel.className = 'openertoggle';
  const opChk = document.createElement('input');
  opChk.type = 'checkbox';
  opChk.checked = isEdit ? !!target.resolvable : isNewThread;
  opLabel.appendChild(opChk);
  opLabel.appendChild(document.createTextNode('needs resolution'));
  bar.insertBefore(opLabel, bar.children[1]); // edits can change the form too

  let previewing = false;
  const previewBtn = document.createElement('button');
  previewBtn.className = 'cancel';
  previewBtn.textContent = 'Preview';
  previewBtn.addEventListener('click', () => {
    previewing = !previewing;
    if (previewing) {
      const titleText = titleIn ? titleIn.value.trim() : '';
      preview.innerHTML = md((titleText ? '**' + titleText + '**\n\n' : '') + (ta.value || '*nothing to preview*'));
      preview.style.display = '';
      ta.style.display = 'none';
      previewBtn.textContent = 'Edit';
    } else {
      preview.style.display = 'none';
      ta.style.display = '';
      previewBtn.textContent = 'Preview';
      ta.focus();
    }
  });
  bar.appendChild(previewBtn);
  const cancel = document.createElement('button');
  cancel.className = 'cancel';
  cancel.textContent = isEdit ? 'Cancel' : 'Discard';
  cancel.addEventListener('click', () => close(true));
  const sendBtn = document.createElement('button');
  sendBtn.className = 'send';
  sendBtn.innerHTML = iconHTML(isEdit ? 'check' : 'send-horizontal');
  sendBtn.appendChild(document.createTextNode(isEdit ? 'Save' : 'Send'));
  sendBtn.addEventListener('click', send);
  bar.appendChild(cancel);
  bar.appendChild(sendBtn);
  wrap.appendChild(bar);

  function close(discard) {
    if (discard) {
      delete S.drafts[key]; delete S.drafts[tKey]; persistDrafts();
      if (S.pendingImgs) S.pendingImgs.delete(key); // pasted bytes die with the draft
    }
    S.editorsOpen.delete(key);
    render();
  }
  async function send() {
    let text = ta.value.trim();
    const titleText = titleIn ? titleIn.value.trim().replace(/\*\*/g, '') : '';
    if (!text && !titleText) return;
    if (titleText) text = '**' + titleText + '**\n' + text;
    // pasted images hit the disk only now, at Send; a link the user deleted
    // from the draft is skipped, a server collision-rename rewrites the link
    const pend = (S.pendingImgs && S.pendingImgs.get(key)) || [];
    for (const pi of pend) {
      if (!text.includes('(' + pi.name + ')')) continue;
      try {
        const r = await fetch('/api/image?path=' + encodeURIComponent(S.path) +
          '&name=' + encodeURIComponent(pi.name) + '&ext=' + encodeURIComponent(pi.ext) +
          '&t=' + TOKEN, { method: 'POST', body: pi.file });
        if (!r.ok) throw new Error('save failed');
        const { file } = await r.json();
        if (file !== pi.name) text = text.split(pi.name).join(file);
      } catch (err) {
        setStatus('warn', 'image save failed — comment not sent');
        return;
      }
    }
    if (S.pendingImgs) S.pendingImgs.delete(key);
    let op;
    if (isEdit) {
      // unchanged text AND unchanged form: just restore
      if (text === target.rawBody && opChk.checked === !!target.resolvable) { close(true); return; }
      // no timestamp change on edit; hash/occ identify the PRE-edit item.
      // opener rewrites the item's form when the toggle moved.
      op = { type: 'edit', hash: target.hash, occ: target.occ, text };
      if (opChk.checked !== !!target.resolvable) op.opener = opChk.checked;
      // the edit changes the item's hash — keep its thread expanded under
      // the key the edited item will get
      const pfx = target.author ? target.author + (target.time ? ' (' + target.time + ')' : '') + ': ' : '';
      S.collapsed.set(RvParser.hashText(RvParser.normalize(pfx + text)) + ':' + target.occ, false);
    } else if (isInterject) {
      op = {
        type: 'reply', parentHash: target.item.hash, occ: target.item.occ,
        afterPara: target.paraHash, author: S.me, text, time: nowStamp(),
        opener: opChk.checked,
      };
    } else if (isReply) {
      op = { type: 'reply', parentHash: target.hash, occ: target.occ, author: S.me, text, time: nowStamp(), opener: opChk.checked };
    } else {
      // find nearest preceding heading for the fallback anchor
      const bi = S.parsed.blocks.indexOf(target);
      let sectionHash = null;
      for (let i = bi; i >= 0; i--) {
        if (S.parsed.blocks[i].type === 'heading') { sectionHash = S.parsed.blocks[i].hash; break; }
      }
      op = target.type === 'thread'
        // seam between threads: the new root goes right AFTER this thread
        ? { type: 'add', afterThreadHash: target.hash, occ: target.occ || 0, sectionHash, author: S.me, text, time: nowStamp(), opener: opChk.checked }
        : target.type === 'heading'
          // empty-section target: land at the section's end
          ? { type: 'add', sectionHash: target.hash, author: S.me, text, time: nowStamp(), opener: opChk.checked }
          : { type: 'add', blockHash: target.hash, occ: target.occ, sectionHash, author: S.me, text, time: nowStamp(), opener: opChk.checked };
      // a just-sent thread is all-read by its author, which would default it
      // collapsed — seed the new root's key expanded before it first renders
      const rootPfx = S.me + ' (' + op.time + '): ';
      S.collapsed.set(RvParser.hashText(RvParser.normalize(rootPfx + text)) + ':0', false);
    }
    delete S.drafts[key];
    delete S.drafts[tKey];
    persistDrafts();
    S.editorsOpen.delete(key);
    const ops = [op];
    // replying implies you've read the parent — write your seen-marker on
    // someone else's comment along with the reply
    const seenTarget = isInterject ? target.item : (isReply ? target : null);
    if (seenTarget && !isMe(seenTarget.author) && !seenByMe(seenTarget)) {
      S.optimisticSeen.set(seenTarget.key, true);
      ops.push({ type: 'seen', hash: seenTarget.hash, occ: seenTarget.occ, reader: S.me, on: true });
    }
    // appending at a level answers the comment directly above: mark that
    // preceding sibling read too — but only when it is the ONLY unread
    // earlier comment at the level (ambiguity stays a manual decision).
    // The op is anchored to that sibling's content hash, so a comment that
    // lands between composing and saving can never be marked by accident.
    if (isReply && target.children && target.children.length) {
      const sibs = target.children;
      const unreadSibs = sibs.filter(isUnread);
      if (unreadSibs.length === 1 && unreadSibs[0] === sibs[sibs.length - 1]) {
        const sib = unreadSibs[0];
        S.optimisticSeen.set(sib.key, true);
        ops.push({ type: 'seen', hash: sib.hash, occ: sib.occ, reader: S.me, on: true });
      }
    }
    submitOps(ops);
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

// a thread is "open" when it holds an unresolved resolvable item or
// something you haven't read yet
function threadOpen(item) {
  if (item.resolvable && !effChecked(item)) return true;
  if (isUnread(item)) return true;
  return item.children.some(threadOpen);
}

// "who's here": every author seen in the document plus everyone announced
// via a presence heartbeat, with a clear online/offline signal — its main
// job is answering "is the agent actually listening right now?"
function buildPresence() {
  const wrap = document.createElement('div');
  wrap.className = 'presence';
  const head = document.createElement('div');
  head.className = 'ohead';
  head.innerHTML = iconHTML('users');
  head.appendChild(document.createTextNode('Authors'));
  wrap.appendChild(head);

  // display names: prefer the document's rendition (emoji, casing) and the
  // longest variant seen
  const display = new Map();
  const claim = n => {
    const k = normName(n);
    if (k && (!display.has(k) || n.length > display.get(k).length)) display.set(k, n);
    return k;
  };
  const rows = new Map();
  if (S.me) rows.set(claim(S.me), { online: false, isMe: true });
  for (const it of S.parsed.items) {
    if (!it.author) continue;
    const k = claim(it.author);
    if (k && !rows.has(k)) rows.set(k, { online: false });
  }
  for (const p of S.presence || []) {
    const k = claim(p.name);
    if (!k) continue;
    const r = rows.get(k) || {};
    rows.set(k, { ...r, online: p.online, lastSeen: p.lastSeen });
  }
  const sorted = [...rows.entries()].sort((a, b) =>
    (b[1].isMe ? 1 : 0) - (a[1].isMe ? 1 : 0) ||
    (b[1].online ? 1 : 0) - (a[1].online ? 1 : 0) ||
    display.get(a[0]).localeCompare(display.get(b[0])));
  for (const [k, r] of sorted) {
    const row = document.createElement('div');
    row.className = 'prow' + (freshRows.has(k) ? ' fresh' : '');
    row.appendChild(avatarEl(display.get(k)));
    const nm = document.createElement('span');
    nm.className = 'pname';
    // the avatar already shows a leading emoji — don't repeat it in the name
    let dispName = display.get(k);
    const em = dispName.match(/^\p{Extended_Pictographic}️?\s*/u);
    if (em && dispName.length > em[0].length) dispName = dispName.slice(em[0].length);
    nm.textContent = dispName + (r.isMe ? ' (you)' : '');
    row.appendChild(nm);
    const st = document.createElement('span');
    st.className = 'pstat ' + (r.online ? 'on' : 'off');
    st.textContent = r.online ? 'online' : 'offline';
    if (!r.online && r.lastSeen) st.title = 'last seen ' + r.lastSeen;
    row.appendChild(st);
    wrap.appendChild(row);
  }
  return wrap;
}

let lastPresenceJson = '';
let prevAgents = null;               // normName -> {name, online} from the last poll
const offlineNotified = new Set();   // agents whose outage the user was warned about
const freshRows = new Map();         // normName -> focused-milliseconds accumulated

// toasts: noticeable but never in the way of writing — a fixed stack in the
// corner; every notice is dismiss-only (the back-online one by spec, the
// offline one because "the agent can't hear you" shouldn't quietly vanish)
function toast(kind, html) {
  let box = $('#notices');
  if (!box) {
    box = document.createElement('div');
    box.id = 'notices';
    document.body.appendChild(box);
  }
  const n = document.createElement('div');
  n.className = 'notice ' + kind;
  n.innerHTML = html;
  const x = document.createElement('button');
  x.className = 'ndismiss';
  x.textContent = '×';
  x.title = 'Dismiss';
  x.addEventListener('click', () => n.remove());
  n.appendChild(x);
  box.appendChild(n);
}

async function fetchPresence() {
  if (!S.path) return;
  try {
    const r = await fetch('/api/presence?path=' + encodeURIComponent(S.path) + '&t=' + TOKEN);
    if (!r.ok) return;
    const list = await r.json();
    const cur = new Map();
    for (const p of list) {
      if (p.kind === 'agent') cur.set(normName(p.name), { name: p.name, online: p.online });
    }
    if (prevAgents) {
      for (const [k, p] of prevAgents) {
        const now = cur.get(k);
        if (p.online && (!now || !now.online)) {
          offlineNotified.add(k);
          toast('warn', '<b>' + p.name + '</b> went offline — comments on this file are not being heard right now.');
        }
      }
      for (const [k, p] of cur) {
        const was = prevAgents.get(k);
        if (p.online && (!was || !was.online)) {
          if (offlineNotified.has(k)) {
            offlineNotified.delete(k);
            toast('ok', '<b>' + p.name + '</b> is back online.');
          } else {
            freshRows.set(k, 0); // quiet arrival: green row for a while
          }
        }
      }
    }
    prevAgents = cur;
    const j = JSON.stringify(list);
    if (j !== lastPresenceJson) {
      lastPresenceJson = j;
      S.presence = list;
      // full render, not just the outline: delivery checks live on the
      // comments themselves and must update without a file change
      render();
    }
  } catch (e) { /* server briefly away; keep last known state */ }
}

// the green-arrival fade only counts down while the window is focused, so
// an arrival during your absence is still green when you come back
setInterval(() => {
  if (!freshRows.size || !document.hasFocus()) return;
  let changed = false;
  for (const [k, ms] of freshRows) {
    const next = ms + 1000;
    if (next >= 8000) { freshRows.delete(k); changed = true; }
    else freshRows.set(k, next);
  }
  if (changed) buildOutline();
}, 1000);

function buildOutline() {
  const nav = $('#outline');
  nav.innerHTML = '';
  nav.appendChild(buildPresence());
  const head = document.createElement('div');
  head.className = 'ohead';
  head.innerHTML = iconHTML('table-of-contents');
  head.appendChild(document.createTextNode('Outline'));
  const sp = document.createElement('span');
  sp.className = 'spacer';
  sp.style.flex = '1';
  head.appendChild(sp);
  const filterBtn = document.createElement('button');
  filterBtn.className = 'ofilter';
  filterBtn.textContent = S.outlineAll ? 'all' : 'open';
  filterBtn.title = S.outlineAll
    ? 'Showing every thread — click to show only open ones'
    : 'Showing open threads only — click to show all';
  filterBtn.addEventListener('click', () => {
    S.outlineAll = !S.outlineAll;
    setPref('outlineAll', S.outlineAll);
    buildOutline();
  });
  head.appendChild(filterBtn);
  nav.appendChild(head);

  let current = null;
  const sections = [];
  for (const b of S.parsed.blocks) {
    if (b.type === 'heading') {
      current = { block: b, unread: [], threads: [] };
      sections.push(current);
    } else if (b.type === 'thread' && current) {
      collectUnread(b.thread, current.unread);
      current.threads.push(b.thread);
    }
  }

  for (const sec of sections) {
    const row = document.createElement('div');
    row.className = 'orow l' + sec.block.level;
    // fixed-width slot BEFORE the title keeps titles aligned whether or
    // not a section has unread counts
    const slot = document.createElement('span');
    slot.className = 'oslot';
    if (sec.unread.length) {
      const mark = document.createElement('span');
      mark.className = 'omark';
      mark.textContent = sec.unread.length;
      mark.title = sec.unread.length + ' unread comment(s) here — click to jump to the first';
      mark.addEventListener('click', e => {
        e.stopPropagation();
        revealItem(sec.unread[0]);
      });
      slot.appendChild(mark);
    }
    row.appendChild(slot);
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
    // per-section new-thread: same composer the cluster-end button opens,
    // anchored to the section's last commentable block (or the heading
    // itself for an empty section — the op then lands at section end)
    {
      const nt = document.createElement('button');
      nt.className = 'onew';
      nt.innerHTML = iconHTML('message-square-plus');
      nt.title = 'New thread in this section';
      nt.addEventListener('click', e => {
        e.stopPropagation();
        let anchor = null;
        const bi = S.parsed.blocks.indexOf(sec.block);
        for (let i = bi + 1; i < S.parsed.blocks.length; i++) {
          const bb = S.parsed.blocks[i];
          if (bb.type === 'heading' && bb.level <= sec.block.level) break;
          if (bb.type !== 'thread' && bb.type !== 'heading') anchor = bb;
        }
        const target = anchor || sec.block;
        const key = 'new:' + target.key;
        if (!S.editorsOpen.has(key)) toggleEditor(key);
        requestAnimationFrame(() => {
          const ed = $('.editor[data-key="' + CSS.escape(key) + '"]');
          if (ed) ed.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      });
      row.appendChild(nt);
    }
    nav.appendChild(row);

    // the section's threads, jumpable, with a status dot; "open" filter
    // hides fully-processed ones (upgrades to resolve-items once agreed)
    for (const th of sec.threads) {
      const stats = threadStats(th);
      const open = threadOpen(th);
      if (!S.outlineAll && !open) continue;
      const trow = document.createElement('div');
      trow.className = 'otrow';
      const dot = document.createElement('span');
      dot.className = 'ostat ' + (stats.unread ? 'unread' : open ? 'open' : 'done');
      dot.title = stats.unread ? stats.unread + ' unread' : open ? 'awaiting a reply or tick' : 'all processed';
      trow.appendChild(dot);
      const txt = document.createElement('span');
      txt.className = 'otxt';
      txt.textContent = th.title ||
        ((th.author ? th.author + ': ' : '') + th.bodyMd.split('\n')[0].replace(/[#*_`>\[\]]/g, '').slice(0, 46));
      txt.title = txt.textContent;
      trow.appendChild(txt);
      trow.addEventListener('click', () => {
        const unreadHere = [];
        collectUnread(th, unreadHere);
        revealItem(unreadHere[0] || th);
      });
      nav.appendChild(trow);
    }
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
  const z = S.zoom || 1; // rects are in zoomed pixels, style.top/offsetHeight in CSS pixels
  let prevBottom = 0;
  for (const { card, anchorEl } of railEntries) {
    let want = 0;
    if (anchorEl) {
      const r = anchorEl.getBoundingClientRect();
      want = (r.top - railRect.top) / z;
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

// only the INNERMOST hovered comment shows its Reply button — hovering a
// deep subtree must not light up the whole ancestor staircase
let hoveredItem = null;
document.addEventListener('mouseover', e => {
  const it = e.target.closest ? e.target.closest('.citem') : null;
  if (it === hoveredItem) return;
  if (hoveredItem) hoveredItem.classList.remove('hovering');
  hoveredItem = it;
  if (hoveredItem) hoveredItem.classList.add('hovering');
});

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

// remark stamps hand-typed comments itself: a bare item gets the local
// user's name + time, an authored-but-unstamped item gets the time — a
// couple of seconds after the file stops changing, so half-typed saves
// from an external editor aren't grabbed mid-sentence
let stampTimer = null;
function scheduleAutoStamp() {
  clearTimeout(stampTimer);
  stampTimer = setTimeout(() => {
    if (!S.parsed || S.saving) return;
    const ops = [];
    for (const it of S.parsed.items) {
      if (it.time) continue;
      if (!it.author) {
        ops.push({ type: 'stamp', hash: it.hash, occ: it.occ, author: S.me, time: nowStamp() });
      } else {
        ops.push({ type: 'stamp', hash: it.hash, occ: it.occ, time: nowStamp() });
      }
    }
    if (ops.length) submitOps(ops);
  }, 2500);
}

function openEvents() {
  const es = new EventSource('/api/events?path=' + encodeURIComponent(S.path) + '&t=' + TOKEN);
  es.onmessage = e => {
    const state = JSON.parse(e.data);
    if (S.doc && state.hash === S.doc.hash) return;
    S.doc = { content: state.content, hash: state.hash };
    detectEol();
    render();
    if (!S.saving) idleStatus();
    scheduleAutoStamp();
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
// ---------------------------------------------------------------------------
// zoom: handled in-app (CSS zoom) so it can persist across restarts; the
// browser's own zoom shortcuts are intercepted
// ---------------------------------------------------------------------------
function applyZoom() {
  document.body.style.zoom = S.zoom || 1;
  scheduleLayout();
}
let zoomStatusTimer = null;
function setZoom(z) {
  S.zoom = Math.min(2.5, Math.max(0.5, Math.round(z * 10) / 10));
  setPref('zoom', S.zoom);
  applyZoom();
  setStatus('ok', Math.round(S.zoom * 100) + '%');
  clearTimeout(zoomStatusTimer);
  zoomStatusTimer = setTimeout(idleStatus, 1200);
}
window.addEventListener('keydown', e => {
  if (!e.ctrlKey && !e.metaKey) return;
  if (e.key === '=' || e.key === '+') { e.preventDefault(); setZoom((S.zoom || 1) + 0.1); }
  else if (e.key === '-') { e.preventDefault(); setZoom((S.zoom || 1) - 0.1); }
  else if (e.key === '0') { e.preventDefault(); setZoom(1); }
});
window.addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom((S.zoom || 1) + (e.deltaY < 0 ? 0.1 : -0.1));
}, { passive: false });

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
  const hrBtn = $('#hideResolvedBtn');
  // the button reads as "Show resolved": bright blue while resolved threads
  // are visible, quiet/dark while they are filtered out
  const syncHideResolved = () => {
    hrBtn.innerHTML = iconHTML('check-check');
    hrBtn.appendChild(document.createTextNode('Show resolved'));
    hrBtn.classList.toggle('active', !S.hideResolved);
    hrBtn.title = S.hideResolved
      ? 'Resolved threads are hidden — click to show them'
      : 'Showing resolved threads — click to hide them';
  };
  syncHideResolved();
  hrBtn.addEventListener('click', () => {
    S.hideResolved = !S.hideResolved;
    setPref('hideResolved', S.hideResolved);
    syncHideResolved();
    render();
  });
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
    for (const b of S.parsed.blocks) if (b.type === 'thread') {
      S.collapsed.set(b.thread.key, true);
      persistCollapse(b.thread.key, true);
    }
    render();
  });
  $('#expandAll').addEventListener('click', () => {
    for (const it of S.parsed.items) {
      S.collapsed.set(it.key, false);
      persistCollapse(it.key, false);
    }
    render();
  });
  $('#unreadBtn').addEventListener('click', jumpUnread);
}

// data-tip tooltips: one fixed bubble on body, since thread cards clip
// their contents and would cut off any tooltip rendered inside them
const tipEl = document.createElement('div');
tipEl.id = 'tipbubble';
if (document.body) document.body.appendChild(tipEl);
else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(tipEl));
document.addEventListener('mouseover', e => {
  const t = e.target.closest ? e.target.closest('[data-tip]') : null;
  if (!t) { tipEl.style.display = 'none'; return; }
  tipEl.textContent = t.dataset.tip;
  tipEl.style.display = 'block';
  // rects are visual (zoom-scaled) but style.left applies inside the zoomed
  // body — compute in visual space, then divide the zoom back out
  const z = parseFloat(getComputedStyle(document.body).zoom) || 1;
  const r = t.getBoundingClientRect();
  const w = tipEl.offsetWidth * z, h = tipEl.offsetHeight * z;
  const vx = Math.min(innerWidth - w - 8, Math.max(8, r.right - w));
  const vy = Math.max(6, r.top - h - 7);
  tipEl.style.left = vx / z + 'px';
  tipEl.style.top = vy / z + 'px';
});

// links: anchors jump in place, everything external opens in the system
// browser via the server (the app window must never navigate away)
document.addEventListener('click', e => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (href.startsWith('#')) {
    e.preventDefault();
    const want = decodeURIComponent(href.slice(1)).toLowerCase();
    const slug = s => s.toLowerCase().trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-');
    const target = document.getElementById(want) ||
      [...document.querySelectorAll('#doc h1,#doc h2,#doc h3,#doc h4,#doc h5,#doc h6')]
        .find(h => slug(h.textContent) === want);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (/^(https?:|mailto:)/i.test(href)) {
    e.preventDefault();
    fetch('/api/openurl?u=' + encodeURIComponent(href) + '&t=' + TOKEN);
  } else if (!href.startsWith(location.origin)) {
    e.preventDefault(); // relative/file links: nowhere sensible to go in-app
  }
});

async function init() {
  await loadPrefs();
  S.me = PREFS.me || 'Me';
  S.mode = PREFS.mode || 'inline';
  S.outline = PREFS.outline !== undefined ? PREFS.outline : true;
  S.outlineAll = !!PREFS.outlineAll;
  S.hideResolved = !!PREFS.hideResolved;
  S.zoom = PREFS.zoom || 1;
  try {
    S.collapsedSaved = JSON.parse(localStorage.getItem('remark:collapsed:' + S.path) || '{}');
  } catch (e) { S.collapsedSaved = {}; }
  applyZoom();
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
  fetchPresence();
  setInterval(fetchPresence, 5000);

  // return to an in-progress draft after a restart
  if (S.editorsOpen.size) {
    const firstKey = S.editorsOpen.values().next().value;
    const ed = $('.editor[data-key="' + CSS.escape(firstKey) + '"]');
    if (ed) {
      ed.scrollIntoView({ block: 'center' });
      const ta = $('textarea', ed);
      if (ta) {
        ta.focus();
        try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}
      }
    }
  }
}

window.addEventListener('beforeunload', e => {
  if (S.queue.length || S.saving) { e.preventDefault(); e.returnValue = ''; }
});

init();
