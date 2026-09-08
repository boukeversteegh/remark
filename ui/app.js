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
  tagFilter: new Set(),   // active tag filter (AND); session-only, never persisted
};

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
// the document scrolls inside #main, under the toolbar — not the window.
// A window scrollbar runs the full height of the viewport and paints over
// everything, the toolbar-as-title-bar included; the scroller's own starts
// below the toolbar. Everything that would ask the window asks this.
const scroller = () => $('#main');

marked.use({ gfm: true });
function md(text) {
  const clean = DOMPurify.sanitize(marked.parse(text));
  const needsRefs = /#r\d{8}/.test(clean);
  if (!clean.includes('<img') && !needsRefs) return clean;
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  // relative image links resolve against the DOCUMENT's folder, not the
  // app origin — route them through the scoped asset endpoint
  for (const img of tpl.content.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (src && !/^([a-z][a-z0-9+.-]*:|\/)/i.test(src)) {
      img.src = '/api/asset?path=' + encodeURIComponent(S.path) +
        '&f=' + encodeURIComponent(src) + '&t=' + TOKEN;
    }
  }
  if (needsRefs) linkCommentRefs(tpl.content);
  return tpl.innerHTML;
}

// bare #r<digits> in prose becomes a link to that comment's anchor (the
// digits are a comment timestamp) — plain text in the file, clickable in
// the render. Code spans and existing links are left alone.
function linkCommentRefs(rootNode) {
  const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
  const hits = [];
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (n.parentElement && n.parentElement.closest('code, pre, a')) continue;
    if (/#r\d{8}/.test(n.nodeValue)) hits.push(n);
  }
  for (const n of hits) {
    const s = n.nodeValue;
    const frag = document.createDocumentFragment();
    const re = /#r(\d{8,14})/g;
    let last = 0, m;
    while ((m = re.exec(s))) {
      frag.appendChild(document.createTextNode(s.slice(last, m.index)));
      const a = document.createElement('a');
      a.href = '#r' + m[1];
      a.textContent = '#r' + m[1];
      a.className = 'cref';
      frag.appendChild(a);
      last = m.index + m[0].length;
    }
    frag.appendChild(document.createTextNode(s.slice(last)));
    n.parentNode.replaceChild(frag, n);
  }
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

// the BOM travels like the EOL style: stripped before parsing, restored on
// save, so the file keeps its signature and "# Header" is line one's start
function normEol(s) { return s.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'); }
function denormEol(s) {
  const t = S.eol === '\r\n' ? s.replace(/\n/g, '\r\n') : s;
  return S.bom ? '\uFEFF' + t : t;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// local-time stamp embedded into new comments as plain text: "2026-09-02 14:32"
function nowStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

// Timestamps are comment identity, so a new comment may not share one with
// any existing comment — bump seconds forward until free.
function uniqueStamp() {
  const taken = new Set();
  try {
    RvParser.parse(normEol(S.doc.content)).items.forEach(it => { if (it.time) taken.add(it.time); });
  } catch (e) { /* unparseable doc: plain nowStamp is still fine */ }
  let d = new Date();
  const p = n => String(n).padStart(2, '0');
  const fmt = () => d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  let t = fmt();
  while (taken.has(t)) { d = new Date(d.getTime() + 1000); t = fmt(); }
  return t;
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
// behind the gateway the phone shares the PC's identity (name, aliases)
// but not its screen: the layout keys live on the device, and the PC's
// values for them are ignored, so neither side rearranges the other
const DEVICE_PREFS = ['mode', 'outline', 'outlineAll', 'hideResolved', 'splitPct', 'outlineW'];
// a group member's EVERYTHING lives on their device: name included, and
// nothing is ever posted back to the owner's prefs (the gateway refuses it)
const isDevicePref = k => DEVICE_PREFS.includes(k) || !!(PREFS && PREFS.group);
function devicePrefs() {
  const key = PREFS && PREFS.group ? 'remark:prefs:group:' + PREFS.group.id : 'remark:prefs:phone';
  try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) { return {}; }
}
async function loadPrefs() {
  const r = await api('GET', '/api/prefs');
  PREFS = r.json || {};
  if (PREFS.gateway) {
    // keys the server injected are the session's identity, not layout —
    // restore them BEFORE merging device prefs, because isDevicePref()
    // depends on PREFS.group being present
    const keep = { gateway: true, group: PREFS.group, recents: PREFS.recents };
    const d = devicePrefs();
    for (const k of Object.keys(PREFS)) if (isDevicePref(k)) delete PREFS[k];
    for (const k of Object.keys(keep)) if (keep[k] !== undefined) PREFS[k] = keep[k];
    for (const k of Object.keys(d)) if (isDevicePref(k) && !(k in keep)) PREFS[k] = d[k];
  }
}
function setPref(k, v) {
  if (v === undefined) v = null;
  PREFS[k] = v;
  if (PREFS.gateway && isDevicePref(k)) {
    const key = PREFS.group ? 'remark:prefs:group:' + PREFS.group.id : 'remark:prefs:phone';
    const d = devicePrefs();
    d[k] = v;
    try { localStorage.setItem(key, JSON.stringify(d)); } catch (e) {}
    return;
  }
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
// "🤖 Claude" and "claude" are two different participants — unless YOU
// said so: aliases (prefs, this computer only) map a name onto another
// author, and every same-author check goes through that map. Files are
// never rewritten; "Me" stays "Me" on disk and counts as Bouke here.
//   PREFS.aliases = { "Bouke": ["Me"], "🤖 Claude": ["Claude"] }
function aliasTarget(name) {
  const al = PREFS.aliases || {};
  for (const canon in al) {
    if ((al[canon] || []).some(a => a.trim() === name)) return canon.trim();
  }
  return name;
}
function normName(s) {
  return aliasTarget((s || '').trim());
}
// re-point a name: it (and anything aliased to it) becomes an alias of
// target; target === null ungroups it. Persisted, then everything re-renders
function setAlias(name, target) {
  const al = {};
  for (const c in PREFS.aliases || {}) al[c] = (PREFS.aliases[c] || []).filter(a => a !== name);
  const carried = al[name] || [];
  delete al[name];
  if (target) {
    target = aliasTarget(target); // an alias of an alias collapses onto the root
    if (target !== name) al[target] = [...new Set([...(al[target] || []), name, ...carried])];
  }
  for (const c in al) if (!al[c].length) delete al[c];
  setPref('aliases', al);
  render();
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
  if (item.bare) return false; // a reader tag is a label, never something to read
  if (isMe(item.author)) return false;
  if (seenByMe(item)) return false;
  return !(item.resolvable && effChecked(item));
}

function threadStats(root) {
  let count = 0, unread = 0;
  (function walk(it) {
    if (!it.bare) count++;
    if (isUnread(it)) unread++;
    it.children.forEach(walk);
  })(root);
  return { count, unread };
}

// ---------------------------------------------------------------------------
// tags: "#word" in a comment's text; a reply that is nothing but tags is a
// reader tag on its parent (hidden as a comment, shown as a chip there). A
// thread carries the union of its comments' tags; the filter is per tag
// set (every active tag must be present) and lives for the session only.
// ---------------------------------------------------------------------------
// the tags of a whole subtree (bare-tag replies already folded into their
// parents' tag lists)
function subtreeTags(root) {
  const out = new Set();
  (function walk(it) {
    if (!it.bare) for (const e of it.tags || []) if (!e.negated) out.add(e.tag);
    it.children.forEach(walk);
  })(root);
  return out;
}
function threadMatchesFilter(root) {
  if (!S.tagFilter.size) return true;
  const have = subtreeTags(root);
  for (const t of S.tagFilter) if (!have.has(t)) return false;
  return true;
}
// every tag in the document with the number of comments carrying it
function docTagCounts() {
  const counts = new Map();
  for (const it of (S.parsed && S.parsed.items) || []) {
    if (it.bare) continue;
    for (const e of it.tags || []) if (!e.negated) counts.set(e.tag, (counts.get(e.tag) || 0) + 1);
  }
  return counts;
}
function sortedTags(counts) {
  return [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b));
}
function toggleTag(tag) {
  if (S.tagFilter.has(tag)) S.tagFilter.delete(tag); else S.tagFilter.add(tag);
  if (S.tagFilter.size && S.parsed) {
    // the filter lands on the tagged comments: unfold the path to each
    for (const it of S.parsed.items) {
      if (it.bare || !(it.tags || []).some(e => !e.negated && S.tagFilter.has(e.tag))) continue;
      for (let p = it; p; p = p.parent) S.collapsed.set(p.key, false);
    }
    if (S.mobile) { S.focusThread = null; setTab('doc'); }
  }
  render();
  if (S.tagFilter.size) scroller().scrollTop = 0;
}
function tagInitial(name) {
  const n = (name || '').trim();
  const em = n.match(/^\p{Extended_Pictographic}️?/u);
  if (em) return em[0];
  return n.slice(0, 1).toUpperCase();
}
// one chip: "#tag", a small initial for a reader tag (who put it there); on
// the comment it filters on click and a reader tag of yours can be taken off
function tagChip(e, item) {
  const chip = document.createElement('button');
  chip.className = 'tagchip' + (S.tagFilter.has(e.tag) ? ' on' : '') + (e.authored ? '' : ' reader') +
    (e.negated ? ' negated' : '');
  chip.appendChild(document.createTextNode('#' + e.tag));
  if (!e.authored && e.by && e.by.length) {
    const who = document.createElement('span');
    who.className = 'tagby';
    who.textContent = e.by.map(tagInitial).join('');
    chip.appendChild(who);
  }
  if (e.negated) {
    // struck through: a "-#tag" reply took it off; only the remover's ×
    // (or re-adding the tag) brings it back — filters and counts skip it
    chip.title = 'Removed by ' + (e.negBy || []).join(', ');
    if (item && (e.negBy || []).some(isMe)) {
      const x = document.createElement('span');
      x.className = 'tagx';
      x.textContent = '×';
      x.title = 'Restore #' + e.tag;
      x.addEventListener('click', ev => {
        ev.stopPropagation();
        const mine = item.children.find(c => c.bare && isMe(c.author) && c.bareNegs.includes(e.tag));
        if (mine) rewriteMyBare(item, mine, mine.bareTags, mine.bareNegs.filter(t => t !== e.tag));
      });
      chip.appendChild(x);
    }
    return chip;
  }
  chip.title = (e.authored ? 'In the text' : 'Tagged by ' + (e.by || []).join(', ')) +
    (S.tagFilter.has(e.tag) ? ' — click to stop filtering by #' + e.tag : ' — click to show only threads with #' + e.tag);
  chip.addEventListener('click', ev => { ev.stopPropagation(); toggleTag(e.tag); });
  // every tag on a comment can be taken off: your own participations go
  // away (your text is edited, your bare-reply token dropped) and whatever
  // remains from others is negated with a "-#tag" in your bare reply —
  // their words and replies are never touched
  if (item) {
    const x = document.createElement('span');
    x.className = 'tagx';
    x.textContent = '×';
    x.title = 'Remove #' + e.tag + ' from this comment';
    x.addEventListener('click', ev => {
      ev.stopPropagation();
      removeTag(item, e);
    });
    chip.appendChild(x);
  }
  return chip;
}
// my bare-tag reply under item rewritten to carry exactly adds + negs;
// emptied out, the reply goes with it
function rewriteMyBare(item, mine, adds, negs) {
  const text = adds.map(t => '#' + t).concat(negs.map(t => '-#' + t)).join(' ');
  submitOps([text
    ? { type: 'edit', hash: mine.hash, occ: mine.occ, text }
    : { type: 'delete', hash: mine.hash, occ: mine.occ }]);
}
function removeTag(item, e) {
  const t = e.tag;
  const ops = [];
  // written in my own text: the token is edited out, tidying the line
  if (e.authored && isMe(item.author)) {
    const rx = new RegExp('(^|\\s)#' + t + '(?![\\w-])', 'gi');
    let text = item.rawBody.replace(rx, '$1');
    text = text.split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n')
      .replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
    ops.push({ type: 'edit', hash: item.hash, occ: item.occ, text });
  }
  // the tag would survive without me (someone else's text or reader tag):
  // a "-#tag" in my bare reply removes it without touching their words
  const needNeg = (e.authored && !isMe(item.author)) || (e.by || []).some(a => !isMe(a));
  const mine = item.children.find(c => c.bare && isMe(c.author));
  const adds = mine ? mine.bareTags.filter(x => x !== t) : [];
  const negs = mine ? mine.bareNegs.slice() : [];
  if (needNeg && negs.indexOf(t) === -1) negs.push(t);
  if (mine) {
    if (adds.length !== mine.bareTags.length || negs.length !== mine.bareNegs.length) {
      const text = adds.map(x => '#' + x).concat(negs.map(x => '-#' + x)).join(' ');
      ops.push(text
        ? { type: 'edit', hash: mine.hash, occ: mine.occ, text }
        : { type: 'delete', hash: mine.hash, occ: mine.occ });
    }
  } else if (needNeg) {
    ops.push({ type: 'reply', parentHash: item.hash, occ: item.occ, author: S.me, text: '-#' + t, time: uniqueStamp(), opener: false });
    if (!seenByMe(item)) {
      S.optimisticSeen.set(item.key, true);
      ops.push({ type: 'seen', hash: item.hash, occ: item.occ, reader: S.me, on: true });
    }
  }
  if (ops.length) submitOps(ops);
}
// "+ tag" on a comment: a tiny input in the header; Enter writes the tag —
// into your own text (appended, on the tag row at the end) or, on someone
// else's comment, as a bare-tag reply of yours (merged into an existing one)
function tagAddButton(item) {
  const btn = document.createElement('button');
  btn.className = 'tagadd';
  btn.innerHTML = iconHTML('tag');
  btn.title = 'Add a tag';
  btn.addEventListener('click', ev => {
    ev.stopPropagation();
    const inp = document.createElement('input');
    inp.className = 'taginput';
    inp.placeholder = '#tag';
    inp.setAttribute('list', 'taglist');
    inp.addEventListener('click', e2 => e2.stopPropagation());
    const done = () => { if (inp.isConnected) inp.replaceWith(btn); };
    inp.addEventListener('keydown', e2 => {
      e2.stopPropagation();
      if (e2.key === 'Escape') { e2.preventDefault(); done(); return; }
      if (e2.key !== 'Enter') return;
      e2.preventDefault();
      const tags = RvParser.extractTags(inp.value.split(/\s+/).map(w => w.startsWith('#') ? w : '#' + w).join(' '));
      if (!tags.length) { inp.classList.add('bad'); return; }
      done();
      addTags(item, tags);
    });
    inp.addEventListener('blur', () => setTimeout(done, 150));
    btn.replaceWith(inp);
    inp.focus();
  });
  return btn;
}
function addTags(item, tags) {
  // negated tags do not count as present: adding one back retracts your
  // "-#tag" (the underlying tag is still there, so nothing else to write)
  const have = new Set((item.tags || []).filter(e => !e.negated).map(e => e.tag));
  const add = tags.filter(t => !have.has(t));
  if (!add.length) { toast('ok', 'Already tagged #' + tags.join(' #')); return; }
  const mineBare = item.children.find(c => c.bare && isMe(c.author));
  if (mineBare && add.some(t => mineBare.bareNegs.includes(t))) {
    const negs = mineBare.bareNegs.filter(t => !add.includes(t));
    const adds = mineBare.bareTags.concat(add.filter(t =>
      !mineBare.bareNegs.includes(t) && !mineBare.bareTags.includes(t)));
    rewriteMyBare(item, mineBare, adds, negs);
    return;
  }
  const ops = [];
  if (isMe(item.author)) {
    const lines = item.rawBody.split('\n');
    const last = lines[lines.length - 1] || '';
    const text = item.rawBody + (RvParser.isBareTags(last) ? ' ' : (item.rawBody ? '\n\n' : '')) + add.map(t => '#' + t).join(' ');
    ops.push({ type: 'edit', hash: item.hash, occ: item.occ, text });
    const pfx = item.author ? item.author + (item.time ? ' (' + item.time + ')' : '') + ': ' : '';
    S.collapsed.set(RvParser.hashText(RvParser.normalize(pfx + text)) + ':' + item.occ, false);
  } else {
    const mine = item.children.find(c => c.bare && isMe(c.author));
    if (mine) {
      ops.push({ type: 'edit', hash: mine.hash, occ: mine.occ, text: mine.bareTags.concat(add).map(t => '#' + t).concat(mine.bareNegs.map(t => '-#' + t)).join(' ') });
    } else {
      ops.push({ type: 'reply', parentHash: item.hash, occ: item.occ, author: S.me, text: add.map(t => '#' + t).join(' '), time: uniqueStamp(), opener: false });
      if (!seenByMe(item)) {
        S.optimisticSeen.set(item.key, true);
        ops.push({ type: 'seen', hash: item.hash, occ: item.occ, reader: S.me, on: true });
      }
    }
  }
  submitOps(ops);
}
// "#tag" in rendered comment text becomes a chip-styled link that filters;
// code and existing links are left alone (same walk as comment refs)
function linkTags(rootNode) {
  const re = /(^|[^\w&\/#])#([A-Za-z][\w-]*)/g;
  const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
  const hits = [];
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (n.parentElement && n.parentElement.closest('code, pre, a')) continue;
    re.lastIndex = 0;
    if (re.test(n.nodeValue)) hits.push(n);
  }
  for (const n of hits) {
    const s = n.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(s))) {
      const tag = m[2].replace(/-+$/, '').toLowerCase();
      if (/^r\d{8,}$/.test(tag)) continue;
      const start = m.index + m[1].length;
      frag.appendChild(document.createTextNode(s.slice(last, start)));
      const a = document.createElement('a');
      a.href = '#';
      a.className = 'tagref';
      a.textContent = '#' + m[2].slice(0, tag.length);
      a.title = 'Show only threads with #' + tag;
      a.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); toggleTag(tag); });
      frag.appendChild(a);
      last = start + 1 + tag.length;
    }
    frag.appendChild(document.createTextNode(s.slice(last)));
    n.parentNode.replaceChild(frag, n);
  }
}
// "@Name" in rendered comment text becomes a mention chip when the name is
// a known author (longest name first, so multi-word names win); your own
// name is accented so being addressed stands out. Code and links stay put.
function docAuthors() {
  const names = new Set();
  for (const it of (S.parsed && S.parsed.items) || []) if (it.author) names.add(it.author);
  if (S.me) names.add(S.me);
  return [...names].sort((a, b) => b.length - a.length);
}
function linkMentions(rootNode) {
  const names = docAuthors();
  if (!names.length) return;
  const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
  const hits = [];
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (n.parentElement && n.parentElement.closest('code, pre, a')) continue;
    if (n.nodeValue.indexOf('@') !== -1) hits.push(n);
  }
  for (const n of hits) {
    const s = n.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0, pos = 0, changed = false;
    for (;;) {
      const at = s.indexOf('@', pos);
      if (at === -1) break;
      const prev = at > 0 ? s[at - 1] : ' ';
      let matched = null;
      if (!/[\w@]/.test(prev)) {
        for (const nm of names) {
          if (!s.startsWith(nm, at + 1)) continue;
          // a name ending in a word char must not continue into one:
          // "@Me" inside "@Meta" is not a mention of Me
          const after = s[at + 1 + nm.length];
          if (after !== undefined && /\w/.test(after) && /\w$/.test(nm)) continue;
          matched = nm;
          break;
        }
      }
      if (!matched) { pos = at + 1; continue; }
      frag.appendChild(document.createTextNode(s.slice(last, at)));
      const sp = document.createElement('span');
      sp.className = 'mention' + (isMe(matched) ? ' me' : '');
      sp.textContent = '@' + matched;
      sp.title = isMe(matched) ? 'You are addressed here' : 'Mention of ' + matched;
      frag.appendChild(sp);
      last = pos = at + 1 + matched.length;
      changed = true;
    }
    if (!changed) continue;
    frag.appendChild(document.createTextNode(s.slice(last)));
    n.parentNode.replaceChild(frag, n);
  }
}
// the Tags panel: every tag in the file with its count, most used first;
// tap one to filter the document (several combine: all must be present)
function buildTagsPanel() {
  const wrap = document.createElement('div');
  wrap.className = 'tagspanel' + (S.tagsCollapsed ? ' collapsed' : '');
  const head = document.createElement('div');
  head.className = 'ohead';
  head.innerHTML = iconHTML('tag');
  head.appendChild(document.createTextNode('Tags'));
  head.title = 'Click to fold or unfold';
  head.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    S.tagsCollapsed = !S.tagsCollapsed;
    wrap.classList.toggle('collapsed', !!S.tagsCollapsed);
  });
  const sp = document.createElement('span');
  sp.className = 'spacer';
  sp.style.flex = '1';
  head.appendChild(sp);
  if (S.tagFilter.size) {
    const clr = document.createElement('button');
    clr.className = 'ofilter';
    clr.textContent = 'clear';
    clr.title = 'Show every thread again';
    clr.addEventListener('click', () => { S.tagFilter.clear(); render(); });
    head.appendChild(clr);
  }
  wrap.appendChild(head);
  const counts = docTagCounts();
  // the datalist behind every "+ tag" input
  let dl = $('#taglist');
  if (!dl) { dl = document.createElement('datalist'); dl.id = 'taglist'; document.body.appendChild(dl); }
  dl.innerHTML = '';
  const tags = sortedTags(counts);
  for (const t of tags) { const o = document.createElement('option'); o.value = '#' + t; dl.appendChild(o); }
  if (!tags.length) {
    const none = document.createElement('div');
    none.className = 'nnone';
    none.textContent = 'no tags yet — write #word in a comment';
    wrap.appendChild(none);
    return wrap;
  }
  for (const t of tags) {
    const row = document.createElement('div');
    row.className = 'trow' + (S.tagFilter.has(t) ? ' on' : '');
    row.appendChild(tagChip({ tag: t, authored: true, by: [] }, null));
    const c = document.createElement('span');
    c.className = 'tcount';
    c.textContent = counts.get(t);
    c.title = counts.get(t) + (counts.get(t) === 1 ? ' comment' : ' comments');
    row.appendChild(c);
    row.addEventListener('click', () => toggleTag(t));
    wrap.appendChild(row);
  }
  return wrap;
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
  // a DM channel (chat marker on its first line) renders as a linear chat
  S.chat = /^\s*<!--\s*remark:chat\s*-->/.test(S.doc.content);
  document.body.classList.toggle('chat', !!S.chat);
  if (S.chat) mountChatBox();

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
  const scrollY = scroller().scrollTop;

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

  // focus: the board shows ONE thread (under its section heading) — that
  // is what rescues the scrollbar — while the outline keeps every row,
  // the others dimmed, for switching. A bar on top is the way back.
  let focusKeep = null;
  if (S.focusThread) {
    const froot = parsed.blocks.find(b => b.type === 'thread' && b.thread.time === S.focusThread);
    if (!froot) {
      // gone — unless it is a just-created thread whose save has not
      // landed yet; that one gets a grace until the next parse has it
      if (!S.focusPending) S.focusThread = null;
    } else {
      S.focusPending = false;
      focusKeep = new Set();
      let lastHeading = null;
      for (const b of parsed.blocks) {
        if (b.type === 'heading') lastHeading = b;
        if (b === froot) {
          if (lastHeading) focusKeep.add(lastHeading);
          focusKeep.add(b);
        }
      }
      const back = document.createElement('button');
      back.className = 'focusback';
      back.innerHTML = iconHTML('corner-down-right');
      back.appendChild(document.createTextNode('Whole document'));
      back.addEventListener('click', () => exitFocus());
      doc.appendChild(back);
      if (froot.thread.title) {
        const lbl = document.createElement('span');
        lbl.className = 'focuslabel';
        lbl.textContent = froot.thread.title;
        doc.appendChild(lbl);
      }
    }
  }
  // tag filter: only the threads carrying every active tag, under their
  // section headings, with a bar naming the tags and a way back — a
  // FOCUS wins over it while active, so a focused thread never vanishes
  // for lacking the filtered tag
  let tagKeep = null;
  if (S.tagFilter.size && !S.focusThread) {
    tagKeep = new Set();
    let lastHeading = null;
    for (const b of parsed.blocks) {
      if (b.type === 'heading') lastHeading = b;
      if (b.type === 'thread' && threadMatchesFilter(b.thread)) {
        if (lastHeading) tagKeep.add(lastHeading);
        tagKeep.add(b);
      }
    }
    const bar = document.createElement('div');
    bar.className = 'tagbar';
    const back = document.createElement('button');
    back.className = 'focusback';
    back.innerHTML = iconHTML('corner-down-right');
    back.appendChild(document.createTextNode('All threads'));
    back.addEventListener('click', () => { S.tagFilter.clear(); render(); });
    bar.appendChild(back);
    for (const t of S.tagFilter) bar.appendChild(tagChip({ tag: t, authored: true, by: [] }, null));
    const n = document.createElement('span');
    n.className = 'tagn';
    const nt = [...tagKeep].filter(b => b.type === 'thread').length;
    n.textContent = nt ? nt + (nt === 1 ? ' thread' : ' threads') : 'no thread carries all of these';
    bar.appendChild(n);
    doc.appendChild(bar);
  }
  for (const block of parsed.blocks) {
    if (focusKeep && !focusKeep.has(block)) continue;
    if (tagKeep && !tagKeep.has(block)) continue;
    if (block.type === 'thread') {
      // toolbar filter: resolved threads drop out of view entirely — but
      // never ones with unread comments, or the unread navigation would
      // point at nothing; and never under a tag filter, which asks for
      // these threads by name
      if (S.hideResolved && !tagKeep && block.thread.resolvable && effChecked(block.thread) &&
          threadStats(block.thread).unread === 0 && !hasOpenNested(block.thread)) continue;
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
          const nkey = 'new:' + pt.thread.key;
          const tgap = document.createElement('div');
          tgap.className = 'igap tgap';
          tgap.title = 'Insert a thread between these two';
          tgap.innerHTML = '<span class="iglabel">— insert thread —</span>';
          tgap.addEventListener('click', () => toggleEditor(nkey));
          doc.appendChild(tgap);
          if (S.editorsOpen.has(nkey)) {
            doc.appendChild(buildEditor(nkey, pt));
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

  // a tag filter hides the paragraphs — and with them every new-thread
  // affordance. Keep one: a new thread at the end of the document.
  if (tagKeep && S.mode !== 'margin' && parsed.blocks.length) {
    const target = parsed.blocks[parsed.blocks.length - 1];
    const nkey = 'new:' + (target.type === 'thread' ? target.thread.key : target.key);
    if (S.editorsOpen.has(nkey)) {
      doc.appendChild(buildEditor(nkey, target));
    } else {
      const nb = document.createElement('button');
      nb.className = 'newthreadbtn';
      nb.innerHTML = iconHTML('message-square-plus');
      nb.appendChild(document.createTextNode('New thread at the end of the document'));
      nb.addEventListener('click', () => toggleEditor(nkey));
      doc.appendChild(nb);
    }
  }
  // an open composer whose anchor block did not render (its paragraph is
  // hidden by a tag filter or focus view) still needs a home: it appears
  // at the end, and its ops keep targeting the anchor, so the thread
  // lands where it was asked for — the outline's per-section + works
  // whatever is on screen
  for (const k of S.editorsOpen) {
    if (!k.startsWith('new:')) continue;
    if (doc.querySelector('.editor[data-key="' + CSS.escape(k) + '"]')) continue;
    const target = parsed.blocks.find(b =>
      'new:' + (b.type === 'thread' ? b.thread.key : b.key) === k);
    if (target) doc.appendChild(buildEditor(k, target));
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

  scroller().scrollTop = scrollY;
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
  // …and its mirror: jump to the start of the LAST message in the thread
  const endBtn = document.createElement('button');
  endBtn.className = 'ttop tend';
  endBtn.title = 'Scroll to the last message of this thread';
  endBtn.innerHTML = iconHTML('chevron-down');
  endBtn.addEventListener('click', () => {
    const heads = card.querySelectorAll('.citem > .chead');
    const last = heads[heads.length - 1];
    (last || card).scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  rail2.appendChild(endBtn);
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

// bookmarks: private to this computer and file, keyed by comment timestamp
// (the comment's identity, edit-stable). Never written to the file.
function loadBookmarks() {
  S.bookmarks = new Set();
  try {
    const arr = JSON.parse(localStorage.getItem('remark:bookmarks:' + S.path) || '[]');
    if (Array.isArray(arr)) S.bookmarks = new Set(arr);
  } catch (e) { /* blocked storage: bookmarks stay session-only */ }
}
function toggleBookmark(time) {
  if (!time) return;
  if (S.bookmarks.has(time)) S.bookmarks.delete(time); else S.bookmarks.add(time);
  try { localStorage.setItem('remark:bookmarks:' + S.path, JSON.stringify([...S.bookmarks])); } catch (e) {}
  render();
}

function isCollapsed(item) {
  if (S.chat) return false; // a chat never folds its messages
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

function buildItem(item, opts) {
  const st = threadStats(item);
  const collapsed = isCollapsed(item);
  const el = document.createElement('div');
  // your own comment with no reply yet (no child, nothing after it at its
  // level) wears an amber edge while the thread is unresolved — a
  // comment-level "awaiting reply", never propagated to thread status
  let root = item;
  while (root.parent) root = root.parent;
  // reader tags (bare-tag replies without replies of their own) are chips
  // on this comment, not children of it
  const kids = item.children.filter(c => !(c.bare && !c.children.length));
  const lastAtLevel = !item.parent ||
    item.parent.children[item.parent.children.length - 1] === item;
  const unreplied = !(root.resolvable && effChecked(root)) &&
    isMe(item.author) && kids.length === 0 && lastAtLevel;
  el.className = 'citem' +
    (isUnread(item) ? ' unread' : '') +
    (collapsed ? ' collapsed' : '') +
    (unreplied ? ' unreplied' : '') +
    (isMe(item.author) ? ' mine' : '');
  el.dataset.ikey = item.key;
  // timestamps are comment identity — expose each as a linkable anchor, so
  // markdown can reference a comment as [](#r20260903221807)
  if (item.time) el.id = 'r' + item.time.replace(/\D/g, '');

  // the empty gutter under a caret collapses the comment it belongs to —
  // no scrolling back up to the caret from the bottom of a long one. One
  // strip per card: nested cards are positioned, so each covers its
  // parent's strip with its own. Flat replies under a root thus fold
  // individually, while a parent's rail running alongside its indented
  // subthread folds the whole subtree — the strip you click is always
  // exactly the thing that folds, and the hover lights its full extent.
  if (!collapsed) {
    const rail = document.createElement('div');
    rail.className = 'crail';
    rail.title = 'Collapse';
    rail.addEventListener('mouseenter', () => el.classList.add('railhot'));
    rail.addEventListener('mouseleave', () => el.classList.remove('railhot'));
    rail.addEventListener('click', () => {
      S.collapsed.set(item.key, true);
      persistCollapse(item.key, true);
      render();
      // land on the header of what was just folded, not a random spot below
      const hd = item.time && document.getElementById('r' + item.time.replace(/\D/g, ''));
      if (hd) hd.scrollIntoView({ block: 'nearest' });
    });
    el.appendChild(rail);
  }

  // collapsed, the WHOLE band between the dividers expands — the padding
  // around the compact head included, not just the head's own strip
  if (collapsed) {
    el.addEventListener('click', e => {
      if (e.target.closest('button, input, a, .chead')) return;
      S.collapsed.set(item.key, false);
      persistCollapse(item.key, false);
      render();
    });
  }

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
  // caret and gutter strip are one control: hovering the caret previews
  // the same fold the strip does
  if (!collapsed) {
    tw.addEventListener('mouseenter', () => el.classList.add('railhot'));
    tw.addEventListener('mouseleave', () => el.classList.remove('railhot'));
  }
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
    // the phone shows the time of day (the date when it is not today); the
    // full stamp stays in the tooltip and the outline
    time.textContent = S.mobile ? shortStamp(item.time) : item.time;
    time.title = 'Written ' + item.time;
    head.appendChild(time);

    const cp = document.createElement('button');
    cp.className = 'crefbtn';
    cp.innerHTML = iconHTML('copy');
    cp.title = 'Copy reference — paste as plain text to link this comment';
    cp.addEventListener('click', e => {
      e.stopPropagation();
      const ref = '#r' + item.time.replace(/\D/g, '');
      navigator.clipboard.writeText(ref).then(
        () => toast('ok', 'Copied <code>' + ref + '</code> — paste it in any comment to link here'),
        () => toast('warn', 'Could not access the clipboard'));
    });
    head.appendChild(cp);

    // bookmark: a private, per-file, per-window mark (local storage keyed
    // by the comment's timestamp — never written to the file); bookmarked
    // comments are listed under their thread in the outline
    const bm = document.createElement('button');
    const marked = S.bookmarks.has(item.time);
    bm.className = 'bmbtn' + (marked ? ' on' : '');
    bm.innerHTML = iconHTML('bookmark');
    bm.title = marked ? 'Remove bookmark' : 'Bookmark — listed in the outline, on this computer only';
    bm.addEventListener('click', e => {
      e.stopPropagation();
      toggleBookmark(item.time);
    });
    head.appendChild(bm);
  }

  // tags: chips after the time (the comment's own plus reader tags), and
  // a hover "+ tag" — on your own comment it lands in the text, on
  // another's it is a bare-tag reply of yours
  if ((item.tags && item.tags.length) || !collapsed) {
    const ct = document.createElement('span');
    ct.className = 'ctags';
    for (const e of item.tags || []) ct.appendChild(tagChip(e, item));
    if (!collapsed && !S.chat) ct.appendChild(tagAddButton(item));
    head.appendChild(ct);
  }

  if (item.title) {
    // the topic is the primary thing: its own line above the header row,
    // larger, in the display font; the header keeps author, time, badges
    const tt = document.createElement('div');
    tt.className = 'ctitlebar';
    tt.textContent = item.title;
    tt.title = item.title;
    // the title is the biggest thing on the card — it collapses the
    // thread just like the header row under it
    tt.addEventListener('click', e => {
      if (e.target.closest('button, input, a')) return;
      S.collapsed.set(item.key, !collapsed);
      persistCollapse(item.key, !collapsed);
      render();
    });
    el.appendChild(tt); // before the head, which is appended later
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

  // own comments get a hover-revealed edit pencil in the header corner;
  // deleting lives INSIDE the edit composer (a bare header button is too
  // easy to hit) — see the Delete… in buildEditor's bar
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
  if (!collapsed && kids.length === 0 && item.parent) {
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
  // the delivery ladder's first rung: ONE check for every agent whose
  // monitor emitted events for this file after the comment was written —
  // "reached X's monitor", nothing more; the tooltip names them. Upgrades
  // to the ✓✓ above once an agent writes its seen-marker.
  if (isMe(item.author) && item.time) {
    const seenNorm = new Set((item.seenBy || []).map(normName));
    const reached = [];
    for (const pr of S.presence || []) {
      if (pr.kind !== 'agent' || !pr.delivered || pr.delivered < item.time) continue;
      if (seenNorm.has(normName(pr.name))) continue;
      reached.push(prettyName(pr.name) + ' at ' + pr.delivered.slice(11));
    }
    if (reached.length) {
      const dv = document.createElement('span');
      dv.className = 'dcheck';
      dv.innerHTML = iconHTML('check');
      dv.dataset.tip = (reached.length === 1 ? 'Reached the monitor of ' : 'Reached the monitors of ') + reached.join(', ');
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
  let lastTextSeg = null; // the text segment behind lastBody, for source indents
  let lastParaHash = null; // the paragraph an interjection after it anchors on
  let pendingLi = null; // cards awaiting the list continuation in the next text
  for (let si = 0; si < item.segments.length; si++) {
    const seg = item.segments[si];
    if (seg.type === 'text') {
      if (editing) continue;
      const body = document.createElement('div');
      body.className = 'cbody';
      let chunks = mdChunks(seg.md);
      // a tag row at the end of the body (a last paragraph of nothing but
      // tags) is already on the header as chips — not repeated as text
      const lastText = item.segments.map(s => s.type).lastIndexOf('text') === si;
      if (lastText && chunks.length > 1 && RvParser.isBareTags(chunks[chunks.length - 1])) chunks = chunks.slice(0, -1);
      chunks.forEach((chunk, ci) => {
        const pHash = RvParser.hashText(RvParser.normalize(chunk));
        lastParaHash = pHash;
        const ikey = 'ipara:' + item.key + ':' + pHash;
        const pe = document.createElement('div');
        pe.className = 'cpara';
        pe.innerHTML = md(chunk);
        if (chunk.indexOf('#') !== -1) linkTags(pe);
        if (chunk.indexOf('@') !== -1) linkMentions(pe);
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
      lastTextSeg = seg;
    } else {
      if (seg.item.bare && !seg.item.children.length) continue; // a reader tag: chip on this comment, not a card
      const nxt = item.segments[si + 1];
      // an interjection sits mid-body: more of the PARENT'S OWN TEXT follows
      // it somewhere after (a sibling reply following does not count)
      const textFollows = item.segments.slice(si + 1).some(s => s.type === 'text');
      const card = buildItem(seg.item, { interjected: textFollows });
      if (textFollows) card.classList.add('interjected'); // indented at every level, root included
      const tl = trailingList(lastBody);
      // a card hangs under the final list item ONLY when the raw markdown
      // nests it there — its bullet deeper than the list's own bullets.
      // A reply at the parent's child indent is never part of the list,
      // however deep the body happens to be indented (hand-written bodies
      // often are, which used to swallow the reply into the list and
      // render it mid-body like an interjection). Body lines are stored
      // dedented by item.indent + 2, so that base recovers source indents.
      const lastLiIndent = (() => {
        if (!tl) return null;
        const ls = (lastTextSeg && lastTextSeg.part && lastTextSeg.part.lines) || [];
        for (let li = ls.length - 1; li >= 0; li--) {
          const mm = ls[li].match(/^(\s*)(?:[-*+]|\d+[.)])\s/);
          if (mm) return item.indent + 2 + mm[1].length;
        }
        return null;
      })();
      const nestedInLi = lastLiIndent != null && seg.item.indent > lastLiIndent;
      const nxtFirst = nxt && nxt.type === 'text'
        ? (nxt.md.split('\n').find(l => l.trim() !== '') || '') : '';
      if (tl && nestedInLi && /^ {0,3}(?:[-*+]|\d+[.)])\s/.test(nxtFirst)) {
        (pendingLi = pendingLi || { list: tl, cards: [] }).cards.push(card);
      } else if (tl && nestedInLi && !nxt) {
        hangInLi(tl, card); // nested under the final list item
      } else {
        el.appendChild(card);
        lastBody = null; // the list no longer trails: later cards stay out of it
        lastTextSeg = null;
        // the seam survives an interjection: another comment can be placed
        // at the same point, landing after the ones already there. Anchored
        // on the paragraph before them (what the parser positions by);
        // the key is unique per existing card so its editor opens right here
        if (nxt && nxt.type === 'text' && lastParaHash && !editing) {
          const akey = 'ipara:' + item.key + ':' + lastParaHash + ':after:' + seg.item.key;
          const gap = document.createElement('div');
          gap.className = 'igap iafter';
          gap.title = 'Insert another comment here';
          gap.innerHTML = '<span class="iglabel">— insert comment —</span>';
          gap.addEventListener('click', () => toggleEditor(akey));
          el.appendChild(gap);
          if (S.editorsOpen.has(akey)) {
            el.appendChild(buildEditor(akey, { item: item, paraHash: lastParaHash }));
          }
        }
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
  // interjections (a comment sitting mid-body of its parent) get it too:
  // their header ↩ is easy to lose between the parent's paragraphs
  if (!collapsed && (kids.length > 0 || !item.parent || (opts && opts.interjected)) &&
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
// chat mode: one pinned message box at the bottom. Every message is a new
// root at the end of the file (no nesting, no resolution); a message sent
// from a window opened for one instance carries <!--to:sid-->. Reply-to is
// flat: the quoted first line plus a #r link goes into the box.
function mountChatBox() {
  if ($('#chatbox')) { chatStick(); return; }
  const box = document.createElement('div');
  box.id = 'chatbox';
  const wrap = document.createElement('div');
  wrap.className = 'cbwrap';
  const ta = document.createElement('textarea');
  ta.placeholder = 'Message… (Ctrl+Enter to send)';
  ta.value = S.drafts['chat:' + S.path] || '';
  ta.addEventListener('input', () => { S.drafts['chat:' + S.path] = ta.value; persistDrafts(); });
  mountMentionPicker(ta);
  wrap.appendChild(ta);
  const bar = document.createElement('div');
  bar.className = 'cbbar';
  bar.innerHTML = '<span>as <b></b></span>';
  $('b', bar).textContent = S.me;
  const to = qs.get('to') || '';
  if (to) {
    const t = document.createElement('span');
    t.className = 'cbto';
    t.textContent = 'to instance ' + to;
    t.title = 'Only the monitor with this session id is woken by your messages; other instances of the name can still read the channel';
    bar.appendChild(t);
  }
  const sp = document.createElement('span');
  sp.className = 'spacer';
  bar.appendChild(sp);
  const send = document.createElement('button');
  send.className = 'send';
  send.innerHTML = iconHTML('send-horizontal');
  send.appendChild(document.createTextNode('Send'));
  const doSend = () => {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    delete S.drafts['chat:' + S.path]; persistDrafts();
    S.chatFollow = true;
    submitOps([{ type: 'add', blockHash: null, occ: 0, sectionHash: null, author: S.me, text,
      time: uniqueStamp(), atEnd: true, opener: false, extra: to ? '<!--to:' + to + '-->' : '' }]);
  };
  send.addEventListener('click', doSend);
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSend(); } });
  bar.appendChild(send);
  wrap.appendChild(bar);
  box.appendChild(wrap);
  document.body.appendChild(box);
  S.chatFollow = true;
  scroller().addEventListener('scroll', () => {
    const m = scroller();
    const room = m.scrollHeight - m.clientHeight;
    S.chatFollow = room - m.scrollTop < 200; // near the bottom: keep following
  }, { passive: true });
  chatStick();
}
function chatStick() {
  if (S.chatFollow !== false) requestAnimationFrame(() => { const m = scroller(); m.scrollTop = m.scrollHeight; });
}
function chatQuote(item) {
  const ta = $('#chatbox textarea');
  if (!ta) return;
  const first = (item.bodyMd || '').split('\n').find(l => l.trim()) || '';
  const ref = item.time ? ' #r' + item.time.replace(/\D/g, '') : '';
  const q = '> ' + (item.author ? item.author + ': ' : '') + first.slice(0, 120) + ref + '\n\n';
  ta.value = q + ta.value;
  ta.focus();
  ta.selectionStart = ta.selectionEnd = ta.value.length;
  ta.dispatchEvent(new Event('input'));
}

function toggleEditor(key) {
  if (S.chat && (key.startsWith('reply:') || key.startsWith('ipara:') || key.startsWith('new:'))) {
    // flat chat: replying quotes into the pinned box instead of nesting
    const k = key.replace(/^reply:/, '');
    const it = (S.parsed.items || []).find(i => i.key === k);
    if (it) chatQuote(it); else { const ta = $('#chatbox textarea'); if (ta) ta.focus(); }
    return;
  }
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
  wrap.className = 'editor' + (isNewThread ? ' newthread' : '') + (isEdit ? ' editedit' : '');
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
  // @-mentions: typing "@" opens a picker with every author in the document
  // and everyone online; picking inserts the name exactly as it is signed
  // (names may hold spaces or emoji) — the literal form a scoped monitor
  // listens for
  mountMentionPicker(ta);

  const preview = document.createElement('div');
  preview.className = 'epreview cbody';
  preview.style.display = 'none';
  wrap.appendChild(preview);

  const bar = document.createElement('div');
  bar.className = 'ebar';
  bar.innerHTML = '<span>as <b></b></span><span class="spacer"></span><span><kbd>Ctrl</kbd> <kbd>⏎</kbd></span>';
  $('b', bar).textContent = S.me;
  // presence is per file, and the author's assumption is not: say at the
  // point of writing when no agent's monitor covers THIS file, so a comment
  // is never left for a listener that is not there
  if (!(S.presence || []).some(p => p.kind === 'agent' && p.online)) {
    const nw = document.createElement('span');
    nw.className = 'nowatch';
    nw.textContent = 'no agent is watching this file';
    nw.title = 'No monitor with -as covers this file right now; an agent will only see this comment when it starts watching the file';
    bar.appendChild(nw);
  }

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
  // delete (own comments, edit mode only): the footer turns into an inline
  // confirmation that spells out what goes — how many comments, per author,
  // with their resolution state — before one op removes the whole subtree
  if (isEdit && isMe(target.author)) {
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = 'Delete…';
    del.title = 'Remove this comment and every reply under it';
    del.addEventListener('click', () => {
      const perAuthor = new Map();
      let total = 0;
      (function walk(it) {
        total++;
        const who = it.author || '(unsigned)';
        const st = perAuthor.get(who) || { n: 0, open: 0, resolved: 0, plain: 0 };
        st.n++;
        if (it.resolvable) { if (effChecked(it)) st.resolved++; else st.open++; } else st.plain++;
        perAuthor.set(who, st);
        it.children.forEach(walk);
      })(target);
      const box = document.createElement('div');
      box.className = 'delconfirm';
      const q = document.createElement('div');
      q.className = 'dq';
      q.textContent = total === 1 ? 'Remove this comment?' : 'Remove ' + total + ' comments?';
      box.appendChild(q);
      const ul = document.createElement('ul');
      for (const [who, st] of [...perAuthor.entries()].sort((a, b) => b[1].n - a[1].n)) {
        const li = document.createElement('li');
        const parts = [];
        if (st.open) parts.push(st.open + ' open');
        if (st.resolved) parts.push(st.resolved + ' resolved');
        if (st.plain) parts.push(st.plain + ' without status');
        li.textContent = who + ': ' + st.n + ' (' + parts.join(', ') + ')';
        ul.appendChild(li);
      }
      box.appendChild(ul);
      const row = document.createElement('div');
      row.className = 'drow';
      const no = document.createElement('button');
      no.className = 'cancel';
      no.textContent = 'Keep';
      no.addEventListener('click', () => { box.remove(); bar.style.display = ''; });
      const yes = document.createElement('button');
      yes.className = 'send danger';
      yes.textContent = total === 1 ? 'Delete' : 'Delete ' + total;
      yes.addEventListener('click', () => {
        close(true);
        submitOps([{ type: 'delete', hash: target.hash, occ: target.occ }]);
      });
      row.appendChild(no);
      row.appendChild(yes);
      box.appendChild(row);
      bar.style.display = 'none';
      wrap.appendChild(box);
    });
    bar.appendChild(del);
  }
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
        afterPara: target.paraHash, author: S.me, text, time: uniqueStamp(),
        opener: opChk.checked,
      };
    } else if (isReply) {
      op = { type: 'reply', parentHash: target.hash, occ: target.occ, author: S.me, text, time: uniqueStamp(), opener: opChk.checked };
    } else {
      // find nearest preceding heading for the fallback anchor
      const bi = S.parsed.blocks.indexOf(target);
      let sectionHash = null;
      for (let i = bi; i >= 0; i--) {
        if (S.parsed.blocks[i].type === 'heading') { sectionHash = S.parsed.blocks[i].hash; break; }
      }
      op = target.type === 'thread'
        // seam between threads: the new root goes right AFTER this thread,
        // anchored by its ROOT comment's stable hash
        ? { type: 'add', afterThreadHash: target.thread.hash, occ: target.thread.occ || 0, sectionHash, author: S.me, text, time: uniqueStamp(), opener: opChk.checked }
        : target.type === 'heading'
          // empty-section target: land at the section's end
          ? { type: 'add', sectionHash: target.hash, author: S.me, text, time: uniqueStamp(), opener: opChk.checked }
          : { type: 'add', blockHash: target.hash, occ: target.occ, sectionHash, author: S.me, text, time: uniqueStamp(), opener: opChk.checked };
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
    // in single-thread mode a freshly created thread is what you came to
    // write: the focus follows it (pending until the save lands — the
    // renderer must not mistake the not-yet-written thread for a deleted one)
    if (S.focusThread && isNewThread && op && op.time) {
      S.focusThread = op.time;
      S.focusPending = true;
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
        submitOps([{ type: 'add', blockHash: null, occ: 0, sectionHash: c.op.sectionHash || null, author: c.op.author, text: c.op.text, time: c.op.time || uniqueStamp(), atEnd: true }]);
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
// the pill counts and cycles only what is on screen: in focus mode the
// focused thread, under a tag filter the matching threads
function visibleUnread() {
  if (!S.parsed) return [];
  return S.parsed.items.filter(it => {
    if (!isUnread(it)) return false;
    let r = it;
    while (r.parent) r = r.parent;
    if (S.focusThread) return r.time === S.focusThread;
    if (S.tagFilter.size) return threadMatchesFilter(r);
    return true;
  });
}
function updateUnreadUI() {
  const unread = visibleUnread();
  const btn = $('#unreadBtn');
  btn.classList.toggle('hidden', unread.length === 0);
  btn.innerHTML = iconHTML('bell-dot');
  btn.appendChild(document.createTextNode(unread.length + ' unread'));
  setAppTitle((unread.length ? '(' + unread.length + ') ' : '') + docDisplayName());
  updateFilenameUI();
  const fm = $('#focusModeBtn');
  if (fm) fm.classList.toggle('active', !!S.focusThread);
}

// the document is named by its first heading; the filename disambiguates
function docTitle() {
  const h = S.parsed && S.parsed.blocks.find(b => b.type === 'heading');
  return h ? h.headingText.replace(/[#*_`\[\]]/g, '').trim() : '';
}
function docDisplayName() {
  const base = (S.path && S.path.split(/[\\/]/).pop()) || 'remark';
  const title = docTitle();
  return title && title !== base ? title + ' — ' + base : base;
}
// the toolbar names the document the same way: title first, file after
function updateFilenameUI() {
  const fn = $('#filename');
  if (!fn || !S.path) return;
  const title = docTitle();
  const base = splitPath(S.path).base;
  fn.textContent = '';
  const bb = document.createElement('b');
  bb.textContent = title || base;
  fn.appendChild(bb);
  if (title && title !== base) {
    const dim = document.createElement('span');
    dim.className = 'fnfile';
    dim.textContent = ' — ' + base;
    fn.appendChild(dim);
  }
  fn.title = S.path;
}

// document.title names the tab; the native window (alt-tab, taskbar)
// follows through the host bind when running in the app shell
function setAppTitle(t) {
  document.title = t;
  try { if (window.__remarkTitle) window.__remarkTitle(t); } catch (e) { }
}
function jumpUnread() {
  const unread = visibleUnread();
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
// a resolved root is not finished while any nested resolvable comment is
// still open: the hide-resolved filter keeps such threads in view
function hasOpenNested(item) {
  return item.children.some(c => (c.resolvable && !effChecked(c)) || hasOpenNested(c));
}
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
  head.title = 'Click to fold or unfold';
  head.addEventListener('click', () => {
    S.authorsCollapsed = !S.authorsCollapsed;
    wrap.classList.toggle('collapsed', !!S.authorsCollapsed);
  });
  wrap.classList.toggle('collapsed', !!S.authorsCollapsed);
  wrap.appendChild(head);

  // one row per identity (aliases fold into their target); the literal
  // names that fold into a row are listed under it. Display name: the
  // alias target when the row is one, else the document's longest rendition
  const display = new Map();
  const literals = new Map(); // key -> Set of literal names seen for it
  const claim = n => {
    n = (n || '').trim();
    const k = normName(n);
    if (!k) return k;
    if (!literals.has(k)) literals.set(k, new Set());
    literals.get(k).add(n);
    if (k === n || (PREFS.aliases || {})[k]) display.set(k, k);
    else if (!display.has(k) || n.length > display.get(k).length) display.set(k, n);
    return k;
  };
  const rows = new Map();
  if (S.me) rows.set(claim(S.me), { online: false, isMe: true });
  (function walk(items) {
    for (const it of items || []) {
      if (it.author) {
        const k = claim(it.author);
        if (k && !rows.has(k)) rows.set(k, { online: false });
      }
      walk(it.children);
    }
  })(S.parsed.items);
  // in a group everyone sees everyone: registered members get a row even
  // before their first comment
  for (const m of (PREFS.group && PREFS.group.members) || []) {
    const k = claim(m);
    if (k && !rows.has(k)) rows.set(k, { online: false });
  }
  // presence is per INSTANCE: the first live process of a name sits on the
  // name's row; every further live process of the same name gets a row of
  // its own right under it, so two "Claude"s show as two rows, not one
  const liveCount = new Map();
  for (const p of S.presence || []) {
    const k = claim(p.name);
    if (!k) continue;
    // only AGENTS split into instances (two monitors under one name are
    // two things to tell apart); a human's devices fold into one row
    if (p.online && p.kind === 'agent') {
      const n = (liveCount.get(k) || 0) + 1;
      liveCount.set(k, n);
      if (n > 1) {
        rows.set(k + '#' + (p.sid || n), { nameKey: k, inst: true, online: true, stalled: p.stalled,
          lastSeen: p.lastSeen, acted: p.acted, cwd: p.cwd, sid: p.sid });
        continue;
      }
    }
    const r = rows.get(k) || {};
    rows.set(k, { ...r, online: r.online || p.online, stalled: p.stalled, lastSeen: p.lastSeen,
      acted: (r.acted && (!p.acted || r.acted > p.acted)) ? r.acted : p.acted,
      cwd: p.online ? (p.cwd || r.cwd) : (r.cwd || p.cwd),
      sid: p.online ? (p.sid || r.sid) : r.sid });
  }
  for (const [k, n] of liveCount) if (rows.has(k)) rows.get(k).instances = n;
  const nameOf = ([k, r]) => display.get(r.nameKey || k) || '';
  const sorted = [...rows.entries()].sort((a, b) =>
    (b[1].isMe ? 1 : 0) - (a[1].isMe ? 1 : 0) ||
    (b[1].online ? 1 : 0) - (a[1].online ? 1 : 0) ||
    nameOf(a).localeCompare(nameOf(b)) ||
    (a[1].inst ? 1 : 0) - (b[1].inst ? 1 : 0));
  const closeMenus = () => wrap.querySelectorAll('.pmenu').forEach(m => m.remove());
  for (const [k, r] of sorted) {
    const nk = r.nameKey || k; // the name this row belongs to (instances share it)
    const row = document.createElement('div');
    row.className = 'prow' + (freshRows.has(nk) ? ' fresh' : '') + (r.inst ? ' inst' : '');
    row.appendChild(avatarEl(display.get(nk)));
    const nm = document.createElement('span');
    nm.className = 'pname';
    // the avatar already shows a leading emoji — don't repeat it in the name
    let dispName = display.get(nk);
    const em = dispName.match(/^\p{Extended_Pictographic}️?\s*/u);
    if (em && dispName.length > em[0].length) dispName = dispName.slice(em[0].length);
    nm.textContent = dispName + (r.isMe ? ' (you)' : '');
    const tipBits = [];
    if (r.online && r.lastSeen) tipBits.push('monitor since ' + r.lastSeen);
    if (r.cwd) tipBits.push('running in ' + r.cwd); // a worktree path tells which checkout
    if (r.sid) tipBits.push('instance ' + r.sid);
    if (tipBits.length) nm.dataset.tip = tipBits.join(' · ');
    row.appendChild(nm);
    if (r.instances > 1 || r.inst) {
      // two live monitors under one name: allowed, never silent — the
      // file cannot tell their comments apart, so the human should know
      const dup = document.createElement('span');
      dup.className = 'ptag pdup';
      dup.textContent = r.inst ? 'also' : r.instances + ' online';
      dup.dataset.tip = (r.instances || 2) + ' monitors announce this name on this file; their comments cannot be told apart — give each a distinct -as unless one is about to exit';
      row.appendChild(dup);
    }
    const st = document.createElement('span');
    st.className = 'pstat ' + (r.online ? (r.stalled ? 'stall' : 'on') : 'off');
    st.textContent = r.online ? (r.stalled ? 'stalled' : 'online') : 'offline';
    if (r.stalled) st.dataset.tip = "monitor running, but its output isn't being read";
    else if (!r.online && r.lastSeen) st.title = 'last seen ' + r.lastSeen;
    // an agent's last sign of life in THIS file (its own comment or
    // seen-marker, stamped by its monitor), and what arrived since without
    // its seen-marker — a healthy pipe with a growing "waiting" is how a
    // blocked agent shows
    if (r.online && !r.stalled && r.acted) {
      const ms = Date.now() - new Date(r.acted.replace(' ', 'T')).getTime();
      const m = Math.max(0, Math.round(ms / 60000));
      const ago = m < 60 ? m + 'm ago' : m < 1440 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago';
      st.textContent = m < 1 ? 'active' : 'active ' + ago;
      let waiting = 0;
      for (const it of S.parsed.items) {
        if (!it.time || !it.author || normName(it.author) === nk) continue;
        if (it.time.replace(' ', 'T') <= r.acted.replace(' ', 'T')) continue;
        if ((it.seenBy || []).some(n => normName(n) === nk)) continue;
        waiting++;
      }
      st.dataset.tip = 'last acted ' + r.acted + ' · ' +
        (waiting ? waiting + ' comment' + (waiting === 1 ? '' : 's') + ' by others since, without its read mark' : 'nothing waiting since');
    }
    row.appendChild(st);
    // Message: open this instance's channel in its own window, addressed to
    // it (only that monitor is woken; the channel file is shared history)
    if (r.online && r.sid && !r.isMe && !S.chat && !PREFS.group) {
      const msg = document.createElement('button');
      msg.className = 'pmore pmsg';
      msg.title = 'Message this instance directly';
      msg.textContent = '✉';
      msg.addEventListener('click', e => {
        e.stopPropagation();
        fetch('/api/dm?name=' + encodeURIComponent(display.get(nk)) + '&to=' + encodeURIComponent(r.sid) + '&t=' + TOKEN, { method: 'POST' })
          .then(x => x.json()).then(j => { if (j.error) toast('warn', 'Could not open the channel: ' + String(j.error).replace(/[<>&]/g, '')); })
          .catch(() => {});
      });
      row.appendChild(msg);
    }
    // "Also known as…" on the main name: pick another row and it folds in
    // under this one. Same gesture for everyone — you are a row too, so
    // "Bouke, also known as Me" is just that
    const others = r.inst ? [] : sorted.filter(([o, orow]) => o !== k && !orow.inst);
    if (others.length) {
      const more = document.createElement('button');
      more.className = 'pmore';
      more.title = 'Also known as…';
      more.textContent = '⋯';
      more.addEventListener('click', e => {
        e.stopPropagation();
        const open = row.querySelector('.pmenu');
        closeMenus();
        if (open) return;
        const menu = document.createElement('div');
        menu.className = 'pmenu';
        const h = document.createElement('div');
        h.className = 'pmhead';
        h.textContent = 'Also known as…';
        menu.appendChild(h);
        for (const [o] of others) {
          const opt = document.createElement('div');
          opt.className = 'pmopt';
          opt.appendChild(avatarEl(display.get(o)));
          opt.appendChild(document.createTextNode(display.get(o)));
          opt.addEventListener('click', ev => { ev.stopPropagation(); setAlias(o, k); });
          menu.appendChild(opt);
        }
        row.appendChild(menu);
        setTimeout(() => document.addEventListener('click', closeMenus, { once: true }), 0);
      });
      row.appendChild(more);
    }
    wrap.appendChild(row);
    // the literal names folded into this row, each with an Ungroup
    for (const lit of r.inst ? [] : [...literals.get(nk) || []].filter(n => n !== display.get(nk)).sort()) {
      const ar = document.createElement('div');
      ar.className = 'prow alias';
      const an = document.createElement('span');
      an.className = 'pname';
      an.textContent = '↳ ' + lit;
      ar.appendChild(an);
      const tag = document.createElement('span');
      tag.className = 'ptag';
      tag.textContent = 'aka';
      ar.appendChild(tag);
      const un = document.createElement('button');
      un.className = 'pmore punalias';
      un.title = 'Ungroup: ' + lit + ' becomes its own author again';
      un.textContent = '×';
      un.addEventListener('click', e => { e.stopPropagation(); setAlias(lit, null); });
      ar.appendChild(un);
      wrap.appendChild(ar);
    }
  }
  return wrap;
}

let lastPresenceJson = '';
let prevAgents = null;               // normName -> {name, online} from the last poll
const offlineNotified = new Set();   // agents whose outage the user was warned about
const freshRows = new Map();         // normName -> focused-milliseconds accumulated

// everyone you could tag: the document's authors (longest rendition wins,
// same rule as the Authors panel) plus whoever is online, minus yourself
function mentionCandidates() {
  const display = new Map();
  const claim = n => {
    const k = normName(n);
    if (k && (!display.has(k) || n.length > display.get(k).length)) display.set(k, n);
  };
  const walk = items => {
    for (const it of items || []) {
      if (it.author) claim(it.author);
      if (it.children) walk(it.children);
    }
  };
  walk(S.parsed && S.parsed.items);
  for (const p of S.presence || []) claim(p.name);
  if (S.me) display.delete(normName(S.me));
  return [...display.values()].sort((a, b) => a.localeCompare(b));
}

// the @ picker under a composer textarea: opens on "@" at a word start,
// narrows as you type, ↑/↓ + Enter/Tab pick, Esc closes (without closing
// the editor). Inserted as "@Name " — a name can contain spaces, so the
// trailing space is what ends it for the reader; the monitor matches the
// literal name and stops where it stops.
function mountMentionPicker(ta) {
  let box = null, start = -1, sel = 0, list = [], sigil = '@';
  const close = () => { if (box) box.remove(); box = null; start = -1; sel = 0; };
  // "@" offers names; "#" offers the document's existing tags (most used
  // first) — a new tag is simply typed through
  const query = () => {
    const head = ta.value.slice(0, ta.selectionStart);
    const at = Math.max(head.lastIndexOf('@'), head.lastIndexOf('#'));
    if (at < 0) return null;
    const q = head.slice(at + 1);
    if (q.includes('\n') || q.length > 40) return null;
    if (head[at] === '@') {
      if (at > 0 && /[\w@.]/.test(head[at - 1])) return null; // e-mail addresses, mid-word
      return { at, q, sigil: '@' };
    }
    if (at > 0 && /[\w&\/#]/.test(head[at - 1])) return null; // refs, entities, mid-word
    if (!/^[\w-]*$/.test(q)) return null; // "# heading", "#r2026…" and the like
    return { at, q, sigil: '#' };
  };
  const pick = name => {
    const pos = ta.selectionStart;
    ta.value = ta.value.slice(0, start) + sigil + name + ' ' + ta.value.slice(pos);
    ta.selectionStart = ta.selectionEnd = start + name.length + 2;
    close();
    ta.dispatchEvent(new Event('input'));
    ta.focus();
  };
  const show = () => {
    const m = query();
    if (!m) return close();
    const q = m.q.toLowerCase();
    sigil = m.sigil;
    list = sigil === '@'
      ? mentionCandidates().filter(n => n.toLowerCase().includes(q))
      : sortedTags(docTagCounts()).filter(t => t.includes(q) && t !== q);
    if (!list.length) return close();
    start = m.at;
    sel = Math.min(sel, list.length - 1);
    if (!box) {
      box = document.createElement('div');
      box.className = 'mentions';
      ta.insertAdjacentElement('afterend', box);
    }
    box.innerHTML = '';
    list.forEach((n, i) => {
      const it = document.createElement('div');
      it.className = 'mention' + (i === sel ? ' sel' : '');
      it.textContent = sigil + n;
      it.addEventListener('mousedown', e => { e.preventDefault(); pick(n); });
      box.appendChild(it);
    });
  };
  ta.addEventListener('input', show);
  ta.addEventListener('click', show);
  ta.addEventListener('keydown', e => {
    if (!box) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % list.length; show(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + list.length) % list.length; show(); }
    else if ((e.key === 'Enter' || e.key === 'Tab') && !e.ctrlKey && !e.metaKey) { e.preventDefault(); pick(list[sel]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  ta.addEventListener('blur', () => setTimeout(close, 150));
}

// "What's new": the entries the newer binary at this path knows and this
// process does not (the server asks that binary for its changelog and
// subtracts its own, keyed on titles). Shown in a small panel with Restart.
function showWhatsNew(mode) {
  const old = $('#whatsnew');
  if (old) old.remove();
  // mode 'seen': what this build has that this machine never showed (an
  // update done elsewhere) — opening the panel records it as shown
  const sinceSeen = mode === 'seen';
  const panel = document.createElement('div');
  panel.id = 'whatsnew';
  panel.innerHTML = '<div class="wnhead"><b>' + (sinceSeen ? 'What\'s new since last time' : 'What\'s new') + '</b><span class="spacer"></span>' +
    (sinceSeen ? '' : '<button class="tbtn" onclick="restartRemark()">Restart</button>') +
    '<button class="wnclose" title="Close">×</button></div><div class="wnbody">loading…</div>';
  panel.querySelector('.wnclose').addEventListener('click', () => panel.remove());
  document.body.appendChild(panel);
  if (sinceSeen) {
    const n = $('#notices .notice[data-key="whatsnew-seen"]');
    if (n) n.remove();
    fetch('/api/whatsnew/ack?t=' + TOKEN, { method: 'POST' }).catch(() => {});
  }
  fetch('/api/whatsnew?t=' + TOKEN + (sinceSeen ? '&since=seen' : '')).then(r => r.json()).then(j => {
    const body = panel.querySelector('.wnbody');
    body.innerHTML = '';
    if (j.ok === false) {
      const n = document.createElement('div');
      n.className = 'wnnote';
      n.textContent = 'Could not ask the newer build for its changelog; this is everything the running build knows.';
      body.appendChild(n);
    }
    if (!j.entries || !j.entries.length) {
      const n = document.createElement('div');
      n.className = 'wnnote';
      n.textContent = 'Nothing new in the changelog — a rebuild of the same changes.';
      body.appendChild(n);
      return;
    }
    let lastDate = null;
    for (const e of j.entries) {
      if (e.date && e.date !== lastDate) {
        lastDate = e.date;
        const d = document.createElement('div');
        d.className = 'wndate';
        d.textContent = e.date;
        body.appendChild(d);
      }
      const it = document.createElement('div');
      it.className = 'wnentry';
      const t = document.createElement('div');
      t.className = 'wntitle';
      t.textContent = e.title;
      it.appendChild(t);
      if (e.body) {
        const b = document.createElement('div');
        b.className = 'wntext';
        b.innerHTML = mdInline(e.body);
        it.appendChild(b);
      }
      body.appendChild(it);
    }
  }).catch(() => { panel.querySelector('.wnbody').textContent = 'Could not load the changelog.'; });
}

// the Gateway panel: the phone's way in. The gateway is a separate process
// this window can start, stop and inspect; "on the phone" registers this
// document with it; the QR carries address + pairing code (a pre-shared
// key), "New code" rotates it and every paired phone must scan again.
function showGateway() {
  const old = $('#gwpanel');
  if (old) { old.remove(); return; }
  const panel = document.createElement('div');
  panel.id = 'gwpanel';
  panel.innerHTML = '<div class="gwhead">' + iconHTML('share-2') + '<b>Sharing</b><span class="spacer"></span><button class="wnclose" title="Close">\u00d7</button></div><div class="gwbody">loading\u2026</div>';
  panel.querySelector('.wnclose').addEventListener('click', () => panel.remove());
  // the height cap is computed, not declared: inside a zoomed body 100vh
  // does not track the real viewport, so px divided by the zoom do
  panel.style.maxHeight = Math.round(innerHeight / (S.zoom || 1) - 72) + 'px';
  document.body.appendChild(panel);
  const q = '?path=' + encodeURIComponent(S.path || '') + '&t=' + TOKEN;
  const call = (ep, extra) => fetch('/api/gateway' + ep + q + (extra || ''), { method: ep ? 'POST' : 'GET' })
    .then(r => r.json()).then(render).catch(() => { panel.querySelector('.gwbody').textContent = 'Could not reach the server.'; });
  // groups: sharing with other people — their registry rides along with
  // every render so a change (join, new code) shows on the next refresh
  let groups = [], openGid = null, lastSt = null;
  const loadGroups = () => fetch('/api/groups?t=' + TOKEN).then(r => r.json())
    .then(g => { groups = Array.isArray(g) ? g : []; }).catch(() => {});
  const gpost = (ep, bodyObj) => fetch('/api/groups' + ep + '?t=' + TOKEN, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyObj),
  }).then(r => r.json()).then(loadGroups).then(() => { if (lastSt) render(lastSt); });
  // management (groups, the gateway itself) is secondary: folded away
  let manage = false, manageGroups = false;
  function render(st) {
    lastSt = st;
    const body = panel.querySelector('.gwbody');
    body.innerHTML = '';
    if (st.error) { body.textContent = st.error; return; }
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const btn = (text, cls, fn) => { const b = el('button', 'tbtn ' + (cls || ''), text); b.addEventListener('click', fn); return b; };
    const shared = !!st.shared;
    const here = p => S.path && p.replace(/\//g, '\\').toLowerCase() === S.path.replace(/\//g, '\\').toLowerCase();
    const sharedGroups = S.path ? groups.filter(g => g.docs.some(here)) : [];
    const sharedAny = shared || sharedGroups.length > 0;
    gatewayButtonState(sharedAny, !!st.running);

    // above the fold: one flat toggle per audience for THIS document —
    // Myself (your own phone) and each group. No dependencies between them;
    // turning any of them on also starts the gateway (a UX courtesy —
    // stopping the gateway never clears the sharing itself)
    if (!S.path) body.appendChild(el('div', 'gwname', 'No document open'));
    const startIfOff = () => { if (!st.running) call('/start'); };
    const shareRow = (label, on, toggle) => {
      const row = el('div', 'gwshare');
      row.appendChild(el('span', 'gwlabel', label));
      const sw = el('label', 'switch');
      const chk = el('input'); chk.type = 'checkbox'; chk.checked = on; chk.disabled = !S.path;
      sw.appendChild(chk); sw.appendChild(el('span', 'knob'));
      chk.addEventListener('change', () => toggle(chk.checked));
      row.appendChild(sw);
      body.appendChild(row);
    };
    shareRow('My devices', shared, on => {
      call('/share', '&on=' + (on ? '1' : '0')).then(() => { if (on) startIfOff(); });
    });
    for (const g of groups) {
      shareRow(g.name, S.path ? g.docs.some(here) : false, on => {
        gpost('/doc', { id: g.id, path: S.path, on }).then(() => { if (on) startIfOff(); });
      });
    }
    const status = el('div', 'gwstatus' + (sharedAny && st.running ? ' on' : ''));
    status.textContent = !S.path ? 'Open a document to share it.'
      : sharedAny && st.running ? 'Shared and reachable — readers open it from their list.'
      : sharedAny ? 'Marked shared, but the gateway is not running: start it below.'
      : st.running ? 'Not shared. Flip a switch to share it.'
      : 'Not shared. Flipping a switch also starts the gateway.';
    body.appendChild(status);

    // group MANAGEMENT lives behind its own fold, like the gateway:
    // members, invites and document lists, separate from sharing
    const gmore = el('button', 'gwmore');
    gmore.innerHTML = iconHTML('chevron-down', manageGroups ? '' : 'closed') +
      '<span>Groups' + (groups.length ? ' (' + groups.length + ')' : '') + '</span>';
    gmore.addEventListener('click', () => { manageGroups = !manageGroups; render(st); });
    body.appendChild(gmore);
    if (manageGroups) renderGroups(st);

    // secondary: the gateway
    const more = el('button', 'gwmore');
    more.innerHTML = iconHTML('chevron-down', manage ? '' : 'closed') + '<span>Gateway ' + (st.running ? 'running' : 'stopped') + '</span>';
    more.addEventListener('click', () => { manage = !manage; render(st); });
    body.appendChild(more);
    if (!manage) return;
    renderGateway(st);
  }

  function renderGroups(st) {
    const body = panel.querySelector('.gwbody');
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const btn = (text, cls, fn) => { const b = el('button', 'tbtn ' + (cls || ''), text); b.addEventListener('click', fn); return b; };
    const here = p => S.path && p.replace(/\//g, '\\').toLowerCase() === S.path.replace(/\//g, '\\').toLowerCase();
    for (const g of groups) {
      const grow = el('div', 'ggroup' + (openGid === g.id ? ' gopen' : ''));
      const gh = el('div', 'ghead');
      gh.appendChild(el('b', null, g.name));
      gh.appendChild(el('span', 'gcount',
        g.members.length + ' member' + (g.members.length === 1 ? '' : 's') +
        ' · ' + g.docs.length + ' document' + (g.docs.length === 1 ? '' : 's')));
      gh.addEventListener('click', () => { openGid = openGid === g.id ? null : g.id; render(st); });
      grow.appendChild(gh);
      if (openGid === g.id) {
        const det = el('div', 'gdet');
        det.appendChild(el('div', 'glabel', 'Documents'));
        if (!g.docs.length) det.appendChild(el('div', 'gwnote', 'Nothing shared with this group — the toggles above do that.'));
        for (const d of g.docs) {
          const r2 = el('div', 'gwdoc', d.split(/[\\/]/).pop() + (here(d) ? ' — this one' : ''));
          r2.title = d;
          const x = btn('×', 'gx quiet', () => gpost('/doc', { id: g.id, path: d, on: false }));
          x.title = 'Take out of the group';
          r2.appendChild(x);
          det.appendChild(r2);
        }
        det.appendChild(el('div', 'glabel', 'Members'));
        if (!g.members.length) det.appendChild(el('div', 'gwnote', 'Nobody yet — have them scan the code below.'));
        for (const m of g.members) {
          const r3 = el('div', 'gwdoc', m);
          const x = btn('×', 'gx quiet', () => {
            if (confirm('Remove ' + m + ' from ' + g.name + '? They can rejoin with the current code.')) {
              gpost('/member/remove', { id: g.id, name: m });
            }
          });
          x.title = 'Remove from the group';
          r3.appendChild(x);
          det.appendChild(r3);
        }
        det.appendChild(el('div', 'glabel', 'Invite'));
        // no gateway, no code: a stopped gateway has no live port, so the
        // QR would encode a link nobody can open
        if (!st.running) {
          det.appendChild(el('div', 'gwnote', 'Start the gateway below — the invite code appears once it runs.'));
        } else {
          const img = el('img', 'gwqr');
          img.src = '/api/groups/qr.png?id=' + encodeURIComponent(g.id) + '&t=' + TOKEN + '&r=' + Date.now();
          img.alt = 'group QR';
          det.appendChild(img);
          // the QR and the link are the same invite: scan one, send the other
          const ur = el('div', 'gwurlrow');
          ur.appendChild(el('div', 'gwurl', g.url || ''));
          ur.appendChild(btn('Copy link', 'quiet', () =>
            navigator.clipboard.writeText(g.url).then(() => toast('ok', 'Invite link copied'))));
          det.appendChild(ur);
        }
        const rr = el('div', 'gwrow');
        rr.appendChild(el('span', null, 'Members scan once; a new code locks out everyone who scanned this one.'));
        rr.appendChild(btn('New code', 'quiet', () => {
          if (confirm('Issue a new code for ' + g.name + '? Every member must scan again.')) gpost('/rotate', { id: g.id });
        }));
        det.appendChild(rr);
        const dr = el('div', 'gwrow');
        dr.appendChild(el('span', null, ''));
        dr.appendChild(btn('Delete group', 'quiet', () => {
          if (confirm('Delete ' + g.name + '? Its code stops working at once.')) { openGid = null; gpost('/delete', { id: g.id }); }
        }));
        det.appendChild(dr);
        grow.appendChild(det);
      }
      body.appendChild(grow);
    }
    const ng = el('div', 'gnew');
    const ninp = el('input');
    ninp.placeholder = 'New group…';
    const nbtn = btn('Create', 'quiet', () => {
      const n = ninp.value.trim();
      if (n) gpost('/new', { name: n }).then(() => { openGid = (groups.find(x => x.name === n) || {}).id || openGid; if (lastSt) render(lastSt); });
    });
    ninp.addEventListener('keydown', ev => { if (ev.key === 'Enter') nbtn.click(); });
    ng.appendChild(ninp);
    ng.appendChild(nbtn);
    body.appendChild(ng);
  }

  function renderGateway(st) {
    const body = panel.querySelector('.gwbody');
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const btn = (text, cls, fn) => { const b = el('button', 'tbtn ' + (cls || ''), text); b.addEventListener('click', fn); return b; };
    const row = (label, ctrl) => {
      const d = el('div', 'gwrow'); d.appendChild(el('span', null, label)); if (ctrl) d.appendChild(ctrl); body.appendChild(d);
    };
    if (st.running) {
      row('Port ' + st.port + ', since ' + st.since, btn('Stop', 'quiet', () => call('/stop')));
      const img = el('img', 'gwqr');
      img.src = '/api/gateway/qr.png?t=' + TOKEN + '&r=' + Date.now();
      img.alt = 'pairing QR';
      body.appendChild(img);
      const ur = el('div', 'gwurlrow');
      ur.appendChild(el('div', 'gwurl', st.url || ''));
      ur.appendChild(btn('Copy link', 'quiet', () =>
        navigator.clipboard.writeText(st.url || '').then(() => toast('ok', 'Link copied'))));
      body.appendChild(ur);
      if (st.addrs && st.addrs.length > 1) body.appendChild(el('div', 'gwnote', 'Also reachable on: ' + st.addrs.slice(1).join(', ')));
      row('Scan the QR or open the link once; the code survives restarts.', btn('New code', 'quiet', () => {
        if (confirm('Issue a new pairing code? Every paired device must scan again.')) call('/rotate');
      }));
    } else {
      row('The gateway serves your shared documents to paired devices over your network or VPN.', btn('Start', '', () => call('/start')));
    }
    const docs = st.docs || [];
    if (docs.length) {
      body.appendChild(el('div', 'gwnote', 'Shared documents'));
      for (const d of docs) {
        const r = el('div', 'gwdoc', d.split(/[\\/]/).pop());
        r.title = d;
        body.appendChild(r);
      }
    }
  }
  loadGroups().then(() => call(''));
}
// the sharing button tells the document's state at a glance: green when
// shared and reachable, red when shared but the gateway is stopped (the
// one moment the gateway state matters), gray when not shared
function gatewayButtonState(shared, running) {
  const b = $('#gatewayBtn');
  if (!b) return;
  b.classList.toggle('on', !!(shared && running));
  b.classList.toggle('warn', !!(shared && !running));
  b.title = shared && running ? 'Shared \u2014 readers can reach it'
    : shared ? 'Sharing unavailable \u2014 the gateway is stopped, start it inside'
    : 'Not shared \u2014 click to share this document';
}
// through the gateway the Phone panel makes no sense — this session IS the
// remote side. The button becomes a connection light instead: green, a
// signal icon (desktop browsers join groups too, not just phones), and a
// click says what you are connected to.
function wireRemoteBadge() {
  const ow = $('#openWithBtn');
  if (ow) ow.remove(); // apps open on the HOST — nothing to offer remotely
  const b = $('#gatewayBtn');
  if (!b) return;
  const nb = b.cloneNode(false); // drops the desktop panel click handler
  b.replaceWith(nb);
  nb.innerHTML = iconHTML('share-2');
  nb.classList.add('remote');
  nb.title = 'Connected remotely';
  nb.addEventListener('click', () => {
    const g = PREFS.group;
    const esc2 = s => String(s || '').replace(/[<>&]/g, '');
    toast('ok', g
      ? '<b>Connected remotely</b> — group ' + esc2(g.name) + (g.owner ? ', shared by ' + esc2(g.owner) : '')
      : '<b>Connected remotely</b> — this device reads the host over the gateway.');
  });
}
function gatewayProbe() {
  if (PREFS.gateway || !S.path) return;
  fetch('/api/gateway?path=' + encodeURIComponent(S.path) + '&t=' + TOKEN).then(r => r.json())
    .then(st => gatewayButtonState(!!(st && (st.sharedAny || st.shared)), !!(st && st.running))).catch(() => {});
}
window.addEventListener('DOMContentLoaded', () => {
  // Open in…: the native Open-with dialog — the system's own app list
  const ow = $('#openWithBtn');
  if (ow) {
    ow.innerHTML = iconHTML('external-link');
    ow.addEventListener('click', () => {
      if (!S.path) return;
      fetch('/api/openwith?path=' + encodeURIComponent(S.path) + '&t=' + TOKEN, { method: 'POST' })
        .then(r => r.json())
        .then(j => { if (j && j.error) toast('warn', 'Could not open the dialog: ' + String(j.error).replace(/[<>&]/g, '')); })
        .catch(() => toast('warn', 'Could not reach the server.'));
    });
  }
  const b = $('#gatewayBtn');
  if (b) { b.innerHTML = iconHTML('share-2'); b.addEventListener('click', showGateway); }
  setTimeout(gatewayProbe, 1500);
});

// image popout: click an image to see it large; wheel or pinch zooms
// around the pointer, drag pans, double-click toggles 2x, Esc / the x / a
// tap on the backdrop closes
function openLightbox(src, alt) {
  if ($('#lightbox')) return;
  const lb = document.createElement('div');
  lb.id = 'lightbox';
  lb.innerHTML = '<button class="lbclose" title="Close (Esc)">\u00d7</button><div class="lbstage"><img draggable="false"></div><div class="lbhint"></div>';
  const img = lb.querySelector('img');
  img.src = src;
  img.alt = alt || '';
  const stage = lb.querySelector('.lbstage');
  const hint = lb.querySelector('.lbhint');
  let scale = 1, tx = 0, ty = 0;
  const apply = () => {
    img.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + scale + ')';
    hint.textContent = Math.round(scale * 100) + '%';
  };
  // zoom keeping the point under the pointer where it is
  const zoomAt = (factor, cx, cy) => {
    const r = stage.getBoundingClientRect();
    const px = cx - r.left - r.width / 2, py = cy - r.top - r.height / 2;
    const ns = Math.min(10, Math.max(0.25, scale * factor));
    const k = ns / scale;
    tx = px - (px - tx) * k;
    ty = py - (py - ty) * k;
    scale = ns;
    apply();
  };
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
  }, { passive: false });
  // drag and pinch through pointer events (touch-action: none on the stage)
  const pts = new Map();
  let lastDist = 0, moved = false;
  stage.addEventListener('pointerdown', e => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stage.setPointerCapture(e.pointerId);
    moved = false;
    if (pts.size === 2) { const [a, b] = [...pts.values()]; lastDist = Math.hypot(a.x - b.x, a.y - b.y); }
  });
  stage.addEventListener('pointermove', e => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    if (pts.size === 1) { tx += e.clientX - p.x; ty += e.clientY - p.y; moved = true; apply(); }
    p.x = e.clientX; p.y = e.clientY;
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastDist) zoomAt(d / lastDist, (a.x + b.x) / 2, (a.y + b.y) / 2);
      lastDist = d;
      moved = true;
    }
  });
  const up = e => { pts.delete(e.pointerId); if (pts.size < 2) lastDist = 0; };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const close = () => { lb.remove(); document.removeEventListener('keydown', onKey, true); };
  document.addEventListener('keydown', onKey, true);
  lb.querySelector('.lbclose').addEventListener('click', close);
  stage.addEventListener('click', e => { if (!moved && e.target === stage) close(); });
  stage.addEventListener('dblclick', e => {
    if (scale !== 1) { scale = 1; tx = 0; ty = 0; apply(); } else zoomAt(2, e.clientX, e.clientY);
  });
  document.body.appendChild(lb);
  apply();
}
document.addEventListener('click', e => {
  const im = e.target.closest && e.target.closest('#doc img, #rail img');
  if (!im || e.target.closest('a')) return;
  e.preventDefault();
  openLightbox(im.currentSrc || im.src, im.alt);
});

// restart into the newer binary on the same document: the server spawns
// it and exits; this window closes with the process
function restartRemark() {
  fetch('/api/restart?path=' + encodeURIComponent(S.path) + '&t=' + TOKEN, { method: 'POST' })
    .then(r => r.json()).then(j => {
      if (j.error) toast('warn', 'Restart failed: ' + String(j.error).replace(/[<>&]/g, ''));
    }).catch(() => {});
}

// toasts: noticeable but never in the way of writing — a fixed stack in the
// corner; every notice is dismiss-only (the back-online one by spec, the
// offline one because "the agent can't hear you" shouldn't quietly vanish).
// A keyed notice replaces any earlier notice with the same key, so a
// state that flips back and forth (an agent's presence) shows its latest
// value once instead of stacking up
function toast(kind, html, key) {
  let box = $('#notices');
  if (!box) {
    box = document.createElement('div');
    box.id = 'notices';
    document.body.appendChild(box);
  }
  if (key) {
    for (const old of box.querySelectorAll('.notice')) {
      if (old.dataset.key === key) old.remove();
    }
  }
  const n = document.createElement('div');
  n.className = 'notice ' + kind;
  if (key) n.dataset.key = key;
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
    // a newer remark binary landed at this process's path (remark install):
    // one keyed notice with a Restart button per distinct build — dismissing
    // it covers that build only, the next install notifies again
    fetch('/api/update?t=' + TOKEN).then(x => x.json()).then(u => {
      if (u && u.updated && u.stamp && u.stamp !== S.updateStamp) {
        S.updateStamp = u.stamp;
        // through the gateway (the phone) there is no Restart: the gateway
        // refuses process control from the network; restart it from a window
        toast('ok', u.gateway
          ? '<b>remark was updated</b> — the gateway still runs the old build; stop and start it from a window on the PC. ' +
            '<button class="tbtn" onclick="showWhatsNew()">What\'s new</button>'
          : '<b>remark was updated</b> — this window still runs the old build. ' +
            '<button class="tbtn" onclick="showWhatsNew()">What\'s new</button>' +
            '<button class="tbtn" onclick="restartRemark()">Restart</button>', 'update');
      }
    }).catch(() => {});
    const r = await fetch('/api/presence?path=' + encodeURIComponent(S.path) + '&t=' + TOKEN);
    if (!r.ok) return;
    const list = await r.json();
    const cur = new Map();
    for (const p of list) {
      if (p.kind === 'agent') cur.set(normName(p.name), { name: p.name, online: p.online, stalled: p.stalled });
    }
    if (prevAgents) {
      for (const [k, p] of prevAgents) {
        const now = cur.get(k);
        if (p.online && (!now || !now.online)) {
          offlineNotified.add(k);
          toast('warn', '<b>' + p.name + '</b> went offline — comments on this file are not being heard right now.', 'presence:' + k);
        }
      }
      for (const [k, p] of cur) {
        const was = prevAgents.get(k);
        if (p.online && p.stalled && (!was || !was.stalled)) {
          toast('warn', '<b>' + p.name + "</b>'s monitor is stalled — it is running but its output isn't being read.", 'presence:' + k);
        }
        if (p.online && (!was || !was.online)) {
          if (offlineNotified.has(k)) {
            offlineNotified.delete(k);
            toast('ok', '<b>' + p.name + '</b> is back online.', 'presence:' + k);
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

// notifications: every comment you have not marked read, one row each,
// in the order you choose (latest, oldest, thread size) — a queue to work a
// backlog from, independent of where things sit in the document
function buildNotifications() {
  const wrap = document.createElement('div');
  wrap.className = 'notifs' + (S.notifsCollapsed ? ' collapsed' : '');
  const head = document.createElement('div');
  head.className = 'ohead';
  head.innerHTML = iconHTML('bell-dot');
  head.appendChild(document.createTextNode('Notifications'));
  head.title = 'Click to fold or unfold';
  head.addEventListener('click', e => {
    if (e.target.closest('select')) return;
    S.notifsCollapsed = !S.notifsCollapsed;
    wrap.classList.toggle('collapsed', !!S.notifsCollapsed);
  });
  const sp = document.createElement('span');
  sp.className = 'spacer';
  sp.style.flex = '1';
  head.appendChild(sp);
  const count = document.createElement('span');
  count.className = 'ncount';
  head.appendChild(count);
  const sort = document.createElement('select');
  sort.className = 'nsort';
  sort.title = 'Order';
  for (const [v, l] of [['latest', 'latest'], ['oldest', 'oldest'], ['size', 'thread size']]) {
    const o = document.createElement('option');
    o.value = v; o.textContent = l;
    sort.appendChild(o);
  }
  sort.value = S.notifSort || 'latest';
  sort.addEventListener('click', e => e.stopPropagation());
  sort.addEventListener('change', () => { S.notifSort = sort.value; buildOutline(); });
  head.appendChild(sort);
  wrap.appendChild(head);

  const rows = [];
  for (const b of S.parsed.blocks) {
    if (b.type !== 'thread') continue;
    const unread = [];
    collectUnread(b.thread, unread);
    const size = threadStats(b.thread).count;
    for (const it of unread) rows.push({ it, root: b.thread, size });
  }
  const t = r => (r.it.time || '').replace(' ', 'T');
  if ((S.notifSort || 'latest') === 'oldest') rows.sort((a, b) => t(a) < t(b) ? -1 : t(a) > t(b) ? 1 : 0);
  else if (S.notifSort === 'size') rows.sort((a, b) => b.size - a.size || (t(a) < t(b) ? 1 : -1));
  else rows.sort((a, b) => t(a) < t(b) ? 1 : t(a) > t(b) ? -1 : 0);
  count.textContent = rows.length ? String(rows.length) : '';
  if (!rows.length) {
    const none = document.createElement('div');
    none.className = 'nnone';
    none.textContent = 'nothing unread';
    wrap.appendChild(none);
    return wrap;
  }
  // the queue scrolls inside a capped box, so a big backlog never pushes
  // the outline off the screen
  const list = document.createElement('div');
  list.className = 'nlist';
  wrap.appendChild(list);
  for (const { it, root, size } of rows) {
    const row = document.createElement('div');
    row.className = 'nrow';
    const top = document.createElement('div');
    top.className = 'ntop';
    const who = document.createElement('span');
    who.className = 'nwho';
    who.textContent = it.author || '';
    top.appendChild(who);
    const when = document.createElement('span');
    when.className = 'nwhen';
    when.textContent = it.time || '';
    top.appendChild(when);
    row.appendChild(top);
    const thr = document.createElement('div');
    thr.className = 'nthread';
    thr.textContent = (root.title || ((root.author ? root.author + ': ' : '') + root.bodyMd.split('\n')[0]))
      .replace(/[#*_`>\[\]]/g, '').slice(0, 60) + ' · ' + size;
    row.appendChild(thr);
    const ex = document.createElement('div');
    ex.className = 'nex';
    ex.textContent = it.bodyMd.split('\n')[0].replace(/[#*_`>\[\]]/g, '').slice(0, 90);
    row.appendChild(ex);
    row.addEventListener('click', () => openFromPanel(it, root));
    list.appendChild(row);
  }
  return wrap;
}

// leaving a focus puts you back at the thread's place in the document
function exitFocus() {
  const t = S.focusThread;
  S.focusThread = null;
  S.focusPending = false;
  render();
  const el = t && document.getElementById('r' + t.replace(/\D/g, ''));
  if (el) el.scrollIntoView({ block: 'center' });
}
// Esc leaves a focused thread — unless you are typing somewhere
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !S.focusThread) return;
  if (e.target.closest && e.target.closest('textarea, input, [contenteditable]')) return;
  e.preventDefault();
  exitFocus();
});

// the sidebar's right edge drags to resize it; the width is a device
// preference so a phone never inherits a monitor-sized sidebar
function wireOutlineResize() {
  if (S.mobile || $('#outlineDrag')) return;
  const h = document.createElement('div');
  h.id = 'outlineDrag';
  h.title = 'Drag to resize the sidebar';
  document.body.appendChild(h);
  const apply = w => document.documentElement.style.setProperty('--outlinew', w + 'px');
  if (PREFS.outlineW) apply(PREFS.outlineW);
  h.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { h.setPointerCapture(e.pointerId); } catch (err) { }
    h.classList.add('dragging');
    let w = PREFS.outlineW || 268;
    const move = ev => {
      w = Math.round(Math.min(520, Math.max(180, ev.clientX / (S.zoom || 1))));
      apply(w);
      scheduleLayout();
    };
    const up = () => {
      h.classList.remove('dragging');
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', up);
      setPref('outlineW', w);
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
  });
}

// single-thread mode: the toolbar toggle enters on the thread the scroll
// spy marks current (else the first), and leaves back to the whole document
function toggleFocusMode() {
  if (S.focusThread) { exitFocus(); return; }
  let time = null;
  const act = $('#outline .otrow.active[data-spy-time]') || $('#outline .otrow[data-spy-time]');
  if (act && S.parsed) {
    const it = S.parsed.items.find(i => i.time && i.time.replace(/\D/g, '') === act.dataset.spyTime);
    time = it && it.time;
  }
  if (!time && S.parsed) {
    const tb = S.parsed.blocks.find(b => b.type === 'thread' && b.thread.time);
    time = tb && tb.thread.time;
  }
  if (!time) { toast('warn', 'No thread to focus.'); return; }
  S.focusThread = time;
  render();
  const el = document.getElementById('r' + time.replace(/\D/g, ''));
  if (el) el.scrollIntoView({ block: 'start' });
}
window.addEventListener('DOMContentLoaded', () => {
  const b = $('#focusModeBtn');
  if (b) { b.innerHTML = iconHTML('focus'); b.addEventListener('click', toggleFocusMode); }
});

// drag & drop between outline rows: the insertion line sits on the edge of
// the nearest row, so between two groups the two slots (end of the upper
// group, start of the lower) are distinct — the rule between them is the
// divide — and the destination group lights up so the drop is unambiguous
function clearOutlineDrop() {
  const nav = $('#outline');
  if (!nav) return;
  for (const el of nav.querySelectorAll('.dropbefore, .dropafter, .dropgroup')) {
    el.classList.remove('dropbefore', 'dropafter', 'dropgroup');
  }
}
function wireOutlineDrop(nav) {
  nav.addEventListener('dragover', ev => {
    if (!S.dragThread) return;
    const rows = [...nav.querySelectorAll('.otrow[data-th-hash]')]
      .filter(r => !r.classList.contains('dragging'));
    if (!rows.length) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    let best = null, bestDist = Infinity, before = false;
    for (const row of rows) {
      const rc = row.getBoundingClientRect();
      const dTop = Math.abs(ev.clientY - rc.top), dBot = Math.abs(ev.clientY - rc.bottom);
      if (dTop < bestDist) { best = row; bestDist = dTop; before = true; }
      if (dBot < bestDist) { best = row; bestDist = dBot; before = false; }
    }
    clearOutlineDrop();
    if (!best) return;
    best.classList.add(before ? 'dropbefore' : 'dropafter');
    for (const row of rows) {
      if (row.dataset.dgroup === best.dataset.dgroup) row.classList.add('dropgroup');
    }
    S.dropAt = { hash: best.dataset.thHash, occ: +best.dataset.thOcc || 0, before };
  });
  nav.addEventListener('drop', ev => {
    if (!S.dragThread || !S.dropAt) return;
    ev.preventDefault();
    const src = S.dragThread, at = S.dropAt;
    S.dragThread = null;
    S.dropAt = null;
    clearOutlineDrop();
    if (src.hash === at.hash && src.occ === at.occ) return;
    submitOps([{ type: 'move', hash: src.hash, occ: src.occ, refHash: at.hash, refOcc: at.occ, before: at.before }]);
  });
  nav.addEventListener('dragleave', ev => {
    if (ev.target === nav) clearOutlineDrop();
  });
}

function buildOutline() {
  const nav = $('#outline');
  nav.innerHTML = '';
  nav.appendChild(buildPresence());
  nav.appendChild(buildNotifications());
  nav.appendChild(buildTagsPanel());
  const head = document.createElement('div');
  head.className = 'ohead';
  head.innerHTML = iconHTML('table-of-contents');
  head.appendChild(document.createTextNode('Outline'));
  // every sidebar panel folds on its header (session-only state)
  head.title = 'Click to fold or unfold';
  head.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    S.outlineCollapsed = !S.outlineCollapsed;
    nav.classList.toggle('outline-collapsed', !!S.outlineCollapsed);
  });
  nav.classList.toggle('outline-collapsed', !!S.outlineCollapsed);
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
  requestAnimationFrame(spyOutline); // highlight where the document is, once the rows exist

  // bookmarked comments (this computer only): collected per thread so the
  // section list below can surface their thread in place
  const bookmarkedIn = th => {
    const hits = [];
    (function walk(it) {
      if (it.time && S.bookmarks.has(it.time)) hits.push(it);
      it.children.forEach(walk);
    })(th);
    return hits;
  };

  let current = null;
  let lastAnchor = null; // the block the following threads attach to
  const sections = [];
  for (const b of S.parsed.blocks) {
    if (b.type === 'heading') {
      current = { block: b, unread: [], threads: [] };
      sections.push(current);
      lastAnchor = b.key;
    } else if (b.type === 'thread' && current) {
      collectUnread(b.thread, current.unread);
      // anchor from the FULL document: grouping stays true even when
      // filters hide rows in between
      current.threads.push({ th: b.thread, anchor: lastAnchor });
    } else if (b.type !== 'thread') {
      lastAnchor = b.key;
    }
  }

  let dragGroup = 0; // visible anchor-group ids, for the drop highlight
  if (!nav.dataset.dropWired) {
    nav.dataset.dropWired = '1';
    wireOutlineDrop(nav);
  }
  for (const sec of sections) {
    const row = document.createElement('div');
    row.className = 'orow l' + sec.block.level;
    row.dataset.spy = sec.block.key; // scroll spy: the heading block this row stands for
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
      const go = () => {
        const el = $('.block[data-key="' + CSS.escape(sec.block.key) + '"]');
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.classList.add('anchor-hl');
        setTimeout(() => el.classList.remove('anchor-hl'), 1200);
      };
      if (S.mobile) { S.focusThread = null; setTab('doc'); render(); requestAnimationFrame(go); } else go();
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
    // hides fully-processed ones (upgrades to resolve-items once agreed).
    // A thin rule separates anchor groups: threads on the SAME paragraph
    // are direct siblings — drag a row to reorder among them or to carry
    // the thread into another group; threads across a rule attach to
    // different content.
    let prevAnchor;
    for (const { th, anchor } of sec.threads) {
      const stats = threadStats(th);
      const open = threadOpen(th);
      const marks = bookmarkedIn(th);
      // a bookmarked thread is always listed, whatever the filter says.
      // Focus mode never REVEALS rows the filters would hide — it only
      // dims the ones already there (plus the focused thread itself).
      const isFocused = S.focusThread && th.time === S.focusThread;
      if (!isFocused) {
        if (!S.outlineAll && !open && !marks.length) continue;
        if (!threadMatchesFilter(th)) continue; // the tag filter narrows the outline too
      }
      const trow = document.createElement('div');
      trow.className = 'otrow' + (marks.length ? ' bookmarked' : '') +
        (S.focusThread ? (th.time === S.focusThread ? ' focused' : ' dimfocus') : '');
      if (th.time) trow.dataset.spyTime = th.time.replace(/\D/g, ''); // scroll spy: the root's anchor
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
      // the thread's tags (its comments' union), a few chips and a count
      const ttags = [...subtreeTags(th)];
      if (ttags.length) {
        const ot = document.createElement('span');
        ot.className = 'otags';
        for (const t of ttags.slice(0, 2)) ot.appendChild(tagChip({ tag: t, authored: true, by: [] }, null));
        if (ttags.length > 2) {
          const more = document.createElement('span');
          more.className = 'tagmore';
          more.textContent = '+' + (ttags.length - 2);
          more.title = '#' + ttags.slice(2).join(' #');
          ot.appendChild(more);
        }
        trow.appendChild(ot);
      }
      if (marks.length) {
        const ic = document.createElement('span');
        ic.className = 'obicon';
        ic.innerHTML = iconHTML('bookmark');
        ic.title = marks.length === 1 ? 'bookmarked: ' + (marks[0].author || '') + ' ' + marks[0].time
          : marks.length + ' bookmarked comments';
        trow.appendChild(ic);
      }
      trow.addEventListener('click', () => {
        // in single-thread mode a click SWITCHES the focus to this thread
        if (S.focusThread && !S.mobile && th.time) {
          S.focusThread = th.time;
          render();
          return;
        }
        const unreadHere = [];
        collectUnread(th, unreadHere);
        openFromPanel(unreadHere[0] || th, th);
      });
      if (prevAnchor === undefined) {
        dragGroup++; // a section starts its own first group
      } else if (anchor !== prevAnchor) {
        const sep = document.createElement('div');
        sep.className = 'osep';
        nav.appendChild(sep);
        dragGroup++;
      }
      prevAnchor = anchor;
      // drag a thread row: within its group to reorder siblings, across a
      // rule to move the thread to that anchor group, at any position
      trow.dataset.thHash = th.hash;
      trow.dataset.thOcc = String(th.occ || 0);
      trow.dataset.dgroup = String(dragGroup);
      if (!S.mobile && th.hash) {
        trow.draggable = true;
        trow.addEventListener('dragstart', ev => {
          S.dragThread = { hash: th.hash, occ: th.occ || 0 };
          trow.classList.add('dragging');
          ev.dataTransfer.setData('text/plain', th.title || th.time || '');
          ev.dataTransfer.effectAllowed = 'move';
        });
        trow.addEventListener('dragend', () => {
          S.dragThread = null;
          trow.classList.remove('dragging');
          clearOutlineDrop();
        });
      }
      nav.appendChild(trow);
      // one line per bookmarked comment, nested under its thread
      for (const it of marks) {
        const brow = document.createElement('div');
        brow.className = 'obrow';
        const ic = document.createElement('span');
        ic.className = 'obicon';
        ic.innerHTML = iconHTML('bookmark');
        brow.appendChild(ic);
        const who = document.createElement('span');
        who.className = 'obwho';
        who.textContent = it.author || '';
        brow.appendChild(who);
        const ex = document.createElement('span');
        ex.className = 'otxt';
        ex.textContent = (it === th && it.title ? it.title + ' — ' : '') +
          it.bodyMd.split('\n')[0].replace(/[#*_`>\[\]]/g, '').slice(0, 60);
        ex.title = it.time + ' · ' + ex.textContent;
        brow.appendChild(ex);
        brow.addEventListener('click', () => openFromPanel(it, th));
        nav.appendChild(brow);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// scroll spy: the outline follows the document — the section you are in
// and the thread nearest the top of the view are highlighted, and the
// outline scrolls so the highlighted row stays in sight
// ---------------------------------------------------------------------------
let spyPending = false;
function spyOutline() {
  spyPending = false;
  const nav = $('#outline');
  if (!nav || !S.path) return;
  const line = 45 + 24; // just under the fixed topbar
  let sec = null, thr = null;
  for (const row of nav.querySelectorAll('.orow[data-spy]')) {
    const el = $('.block[data-key="' + CSS.escape(row.dataset.spy) + '"]');
    if (el && el.getBoundingClientRect().top <= line) sec = row;
  }
  for (const row of nav.querySelectorAll('.otrow[data-spy-time]')) {
    const el = document.getElementById('r' + row.dataset.spyTime);
    if (!el) continue;
    const card = el.closest('.block') || el;
    const r = card.getBoundingClientRect();
    if (r.top <= line && r.bottom > line) thr = row; // the thread under the line
    else if (r.top > line && !thr && r.top < window.innerHeight * 0.4) thr = row; // or the first one just below it
  }
  let changed = false;
  for (const row of nav.querySelectorAll('.orow.active, .otrow.active')) {
    if (row !== sec && row !== thr) { row.classList.remove('active'); changed = true; }
  }
  for (const row of [sec, thr]) {
    if (row && !row.classList.contains('active')) { row.classList.add('active'); changed = true; }
  }
  if (changed) {
    const keep = thr || sec;
    if (keep) keep.scrollIntoView({ block: 'nearest' });
  }
}
scroller().addEventListener('scroll', () => {
  if (spyPending) return;
  spyPending = true;
  requestAnimationFrame(spyOutline);
  // remember where the document is, per file, so a restart (an update,
  // a reopen) lands you where you were
  if (S.path && S.pendingScroll == null) {
    clearTimeout(window.scrollSaveTimer);
    window.scrollSaveTimer = setTimeout(() => {
      try { localStorage.setItem('remark:scroll:' + S.path, String(Math.round(scroller().scrollTop))); } catch (e) {}
    }, 150);
  }
}, { passive: true });

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
function detectEol() {
  S.eol = S.doc.content.includes('\r\n') ? '\r\n' : '\n';
  S.bom = S.doc.content.charCodeAt(0) === 0xFEFF;
}

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

// an external update must not move the text the reader is on: remember the
// first identifiable element starting below the topbar and put it back at
// the same screen position after the re-render
function captureScrollAnchor() {
  const m = scroller();
  if (!m || m.scrollTop < 5) return null; // pinned to the top stays at the top
  const base = m.getBoundingClientRect().top;
  for (const el of document.querySelectorAll('.citem[id], .block[data-key]')) {
    const r = el.getBoundingClientRect();
    if (r.top >= base && r.height > 0) {
      return { id: el.id || '', key: (el.dataset && el.dataset.key) || '', top: r.top };
    }
  }
  // reading past the last anchor: keep the distance to the end of the page
  return { end: m.scrollHeight - m.scrollTop };
}
function restoreScrollAnchor(a) {
  const m = scroller();
  if (!a || !m) return;
  if (a.end != null) {
    m.scrollTop = m.scrollHeight - a.end;
    return;
  }
  const el = a.id ? document.getElementById(a.id)
    : document.querySelector('.block[data-key="' + CSS.escape(a.key) + '"]');
  if (!el) return;
  // iterate: with CSS zoom active, rect pixels and scrollTop units differ
  // by the zoom factor — each pass closes the remaining gap
  for (let i = 0; i < 4; i++) {
    const d = el.getBoundingClientRect().top - a.top;
    if (Math.abs(d) < 0.5) break;
    m.scrollTop += d;
  }
}

function openEvents() {
  const es = new EventSource('/api/events?path=' + encodeURIComponent(S.path) + '&t=' + TOKEN);
  es.onmessage = e => {
    const state = JSON.parse(e.data);
    if (S.doc && state.hash === S.doc.hash) return;
    S.doc = { content: state.content, hash: state.hash };
    detectEol();
    const anchor = captureScrollAnchor();
    render();
    restoreScrollAnchor(anchor);
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
  // the landing shows them in columns now, so history can be generous
  setPref('recents', [p].concat(recents().filter(x => x !== p)).slice(0, 30));
}
function splitPath(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return { dir: i >= 0 ? p.slice(0, i + 1) : '', base: p.slice(i + 1) };
}

// first visit to a group: the join screen — the group's name, who shares
// it, and a field for YOUR name; the name lives only on this phone and
// signs your comments and read-marks
function showGroupJoin() {
  setAppTitle(PREFS.group.name + ' — remark');
  document.body.classList.add('landing', 'gateway');
  $('#brandmark').innerHTML = iconHTML('notebook-pen');
  $('#landing').classList.remove('hidden');
  $('#heroIcon').innerHTML = iconHTML('notebook-pen');
  const g = PREFS.group;
  const div = $('#recent');
  div.innerHTML = '<h3></h3><p class="rempty"></p>';
  div.querySelector('h3').textContent = g.name;
  div.querySelector('.rempty').textContent =
    (g.owner ? g.owner + ' shares documents with this group. ' : '') +
    'Pick the name you will write under — it stays on this phone.';
  const row = document.createElement('div');
  row.className = 'gjoin';
  const inp = document.createElement('input');
  inp.placeholder = 'Your name';
  const join = document.createElement('button');
  join.className = 'tbtn';
  join.textContent = 'Join';
  const go = () => {
    const name = inp.value.trim();
    if (!name) { inp.focus(); return; }
    api('POST', '/api/group/join', { name }).then(r => {
      if (!r.json || r.json.error) { toast('warn', 'Could not join the group.'); return; }
      setPref('me', name);
      location.reload();
    }).catch(() => toast('warn', 'Could not reach the gateway.'));
  };
  join.addEventListener('click', go);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  row.appendChild(inp);
  row.appendChild(join);
  div.appendChild(row);
  inp.focus();
}

function showLanding() {
  setAppTitle(PREFS.group ? PREFS.group.name + ' — remark' : 'remark');
  document.body.classList.add('landing');
  $('#brandmark').innerHTML = iconHTML('notebook-pen');
  $('#landing').classList.remove('hidden');
  $('#heroIcon').innerHTML = iconHTML('notebook-pen');
  const browse = $('#browseBtn');
  browse.innerHTML = iconHTML('folder-open');
  browse.appendChild(document.createTextNode('Browse for a file…'));
  browse.addEventListener('click', pickAndOpen);
  // behind the gateway the landing page is a document picker: the phone
  // can only open what the PC shared, so no browsing, no pasted paths, and
  // nothing to remove; the list is the whole page
  const gw = !!PREFS.gateway;
  const grp = PREFS.group;
  document.body.classList.toggle('gateway', gw);
  const list = recents();
  if (gw && !list.length) {
    $('#recent').innerHTML = '<h3></h3><p class="rempty"></p>';
    $('#recent h3').textContent = grp ? grp.name : 'Shared documents';
    $('#recent .rempty').textContent = grp
      ? 'Nothing shared with this group yet.'
      : 'Nothing shared yet. On the PC, open a document and flip a switch under Sharing.';
  }
  // remotely the shared list changes under you (the owner flips a switch):
  // watch for it and refresh, so a newly shared document just appears
  if (gw) {
    const before = JSON.stringify(recents());
    setInterval(async () => {
      try {
        const r = await api('GET', '/api/prefs');
        if (JSON.stringify((r.json && r.json.recents) || []) !== before) location.reload();
      } catch (e) { }
    }, 5000);
  }
  // inside a group the header names the group, and you can re-pick your name
  if (grp) {
    const yr = document.createElement('p');
    yr.className = 'gyou';
    yr.append('You are ');
    const b = document.createElement('b');
    b.textContent = PREFS.me || '';
    yr.appendChild(b);
    const ch = document.createElement('button');
    ch.className = 'gchange';
    ch.textContent = 'change';
    ch.addEventListener('click', () => { setPref('me', ''); location.reload(); });
    yr.appendChild(ch);
    const rec = $('#recent');
    rec.parentElement.insertBefore(yr, rec);
  }
  if (list.length) {
    const div = $('#recent');
    div.innerHTML = '<h3></h3>';
    div.querySelector('h3').textContent = grp ? grp.name : (gw ? 'Shared documents' : 'Recent files');
    for (const p of list) {
      const a = document.createElement('a');
      a.href = '/?t=' + TOKEN + '&f=' + encodeURIComponent(p);
      const { dir, base } = splitPath(p);
      a.innerHTML = iconHTML('file-text');
      // title first (the document's first heading, filled in when the
      // status load below has the content), filename and folder under it
      const main = document.createElement('span');
      main.className = 'rmain';
      // headline: the title with the filename inline after it; the path
      // gets its own line below — paths are long and would clip inline
      const line = document.createElement('span');
      line.className = 'rline';
      const name = document.createElement('span');
      name.className = 'rname';
      name.textContent = base;
      const fname = document.createElement('span');
      fname.className = 'rfname';
      line.appendChild(name);
      line.appendChild(fname);
      const dd = document.createElement('span');
      dd.className = 'rfile';
      dd.textContent = dir.replace(/[\\/]+$/, '');
      main.appendChild(line);
      main.appendChild(dd);
      a.appendChild(main);
      const stat = document.createElement('span');
      stat.className = 'rstatus';
      a.appendChild(stat);
      if (!gw) {
        const rm = document.createElement('button');
        rm.className = 'rremove';
        rm.textContent = '×';
        rm.title = 'Remove from recent files';
        rm.addEventListener('click', e => {
          e.preventDefault();
          e.stopPropagation();
          setPref('recents', recents().filter(x => x !== p));
          a.remove();
        });
        a.appendChild(rm);
      }
      div.appendChild(a);
      // thread-status badges load async per file: blue = unread comments
      // for this profile, amber = open (unresolved) threads
      fetch('/api/file?path=' + encodeURIComponent(p) + '&t=' + TOKEN)
        .then(r => r.ok ? r.json() : null)
        .then(st => {
          if (!st) return;
          const h1 = /^#\s+(.+?)\s*$/m.exec(st.content);
          if (h1 && h1[1].trim() && h1[1].trim() !== base) {
            name.textContent = h1[1].trim();
            fname.textContent = base;
          }
          const doc2 = RvParser.parse(st.content.replace(/\r\n/g, '\n'));
          const me = PREFS.me || 'Me';
          let unread = 0, open = 0;
          for (const it of doc2.items) {
            const seen = (it.seenBy || []).some(n => n === me);
            const legacyRead = it.resolvable && it.checked;
            if (it.author !== me && !seen && !legacyRead) unread++;
          }
          for (const b of doc2.blocks) {
            if (b.type === 'thread' && b.thread.resolvable && !b.thread.checked) open++;
          }
          if (unread) {
            const u = document.createElement('span');
            u.className = 'rbadge unread';
            u.textContent = unread + ' unread';
            stat.appendChild(u);
          }
          if (open) {
            const o = document.createElement('span');
            o.className = 'rbadge open';
            o.textContent = open + ' open';
            stat.appendChild(o);
          }
          if (!unread && !open) {
            const c = document.createElement('span');
            c.className = 'rbadge clear';
            c.innerHTML = iconHTML('check');
            stat.appendChild(c);
          }
        })
        .catch(() => {});
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
  if (window.__remarkChromeRelayout) __remarkChromeRelayout();
}
let zoomStatusTimer = null;
// the phone keeps its own zoom, on the device: the PC's preference is
// sized for a monitor and would scale the whole phone page with it
function phoneZoom() {
  try { return parseFloat(localStorage.getItem('remark:zoom:phone')) || 1; } catch (e) { return 1; }
}
function setZoom(z) {
  S.zoom = Math.min(2.5, Math.max(0.5, Math.round(z * 10) / 10));
  if (mobileQuery.matches) { try { localStorage.setItem('remark:zoom:phone', String(S.zoom)); } catch (e) {} }
  else {
    // per document, so two windows never fight over one number; the plain
    // key stays as the seed for documents opened for the first time
    setPref('zoom', S.zoom);
    if (S.path) setPref('zoom:' + S.path, S.zoom);
  }
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
  applyMobile();
}

// mobile: on a narrow screen (the phone through the gateway) every panel
// is a page — Document, Notifications, Outline, Authors — switched by a
// tab bar at the bottom; a notification opens its thread alone
const mobileQuery = window.matchMedia('(max-width: 720px)');
function applyMobile() {
  S.mobile = mobileQuery.matches && !!S.path;
  document.body.classList.toggle('mobile', S.mobile);
  if (!S.mobile) { document.body.className = document.body.className.replace(/\btab-\w+/g, '').trim(); return; }
  if (!$('#tabs')) {
    const bar = document.createElement('nav');
    bar.id = 'tabs';
    for (const [id, icon, label] of [['doc', 'file-text', 'Document'], ['notifs', 'bell-dot', 'Notifications'], ['tags', 'tag', 'Tags'], ['outline', 'table-of-contents', 'Outline'], ['authors', 'users', 'Authors']]) {
      const b = document.createElement('button');
      b.dataset.tab = id;
      b.innerHTML = iconHTML(icon) + '<span>' + label + '</span>';
      b.addEventListener('click', () => setTab(id));
      bar.appendChild(b);
    }
    document.body.appendChild(bar);
  }
  // after the bar exists, so the current tab's button is lit from the start
  setTab(S.tab || 'doc');
}
function setTab(id) {
  S.tab = id;
  document.body.className = document.body.className.replace(/\btab-\w+/g, '').trim() + ' tab-' + id;
  const tabs = $('#tabs');
  if (tabs) for (const b of tabs.querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab === id);
}
mobileQuery.addEventListener('change', () => { applyMobile(); if (S.parsed) render(); });
// open a comment from a panel: on the phone that means its thread alone on
// the Document page; on the desktop just scroll to it
function shortStamp(t) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})/.exec(t || '');
  if (!m) return t;
  const d = new Date();
  const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return m[1] + '-' + m[2] + '-' + m[3] === today ? m[4] : m[2] + '-' + m[3] + ' ' + m[4];
}
function openFromPanel(it, root) {
  if (S.mobile) {
    S.focusThread = root && root.time ? root.time : null;
    setTab('doc');
    render();
    requestAnimationFrame(() => revealItem(it));
  } else {
    revealItem(it);
  }
}

// ---------------------------------------------------------------------------
// window chrome: inside the native window the host drops the Windows title
// bar and #topbar IS the title bar. An invisible native window sits over the
// toolbar strip and answers Windows' hit test (drag, snap layouts, the
// caption buttons), with holes punched for our own controls — it needs to
// know where everything is, in device pixels, every time the bar lays out.
// __remarkChrome is bound by the host; in a browser it does not exist.
// ---------------------------------------------------------------------------
function wireWindowChrome() {
  if (typeof window.__remarkChrome !== 'function') return;
  document.body.classList.add('in-window');
  const bar = $('#topbar');
  const dev = el => {
    const r = el.getBoundingClientRect(), s = window.devicePixelRatio || 1;
    return { l: Math.round(r.left * s), t: Math.round(r.top * s), r: Math.round(r.right * s), b: Math.round(r.bottom * s) };
  };
  let last = '';
  const report = () => {
    // a fixed box stops at the document scrollbar; a title bar does not —
    // span the whole viewport (in the bar's own, zoomed, pixels)
    const z = parseFloat(document.body.style.zoom) || 1;
    const full = (innerWidth / z) + 'px';
    if (bar.style.width !== full) bar.style.width = full;
    const controls = [];
    for (const el of bar.querySelectorAll('button, input, label, a, select, .no-drag')) {
      if (el.closest('.caption')) continue;
      if (el.tagName === 'INPUT' && el.closest('label')) continue; // the label's rect covers it
      if (!el.offsetParent) continue; // display:none
      controls.push(dev(el));
    }
    const rep = {
      h: dev(bar).b,
      min: dev($('#capMin')), max: dev($('#capMax')), close: dev($('#capClose')),
      controls,
    };
    // the buttons touch: rounding must not leave a 1px seam where the hot
    // button would drop out and back in
    rep.min.r = rep.max.l; rep.max.r = rep.close.l;
    // only when something moved: the host answers a report by pushing state
    // back into the bar, which the observers below see — reporting that
    // again would loop forever
    const key = JSON.stringify(rep);
    if (key === last) return;
    last = key;
    window.__remarkChrome(rep);
  };
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; report(); });
  };
  new ResizeObserver(schedule).observe(bar);
  new MutationObserver(records => {
    // the caption buttons only ever change by the host's own pushes
    if (records.some(r => !(r.target.closest && r.target.closest('.caption')))) schedule();
  }).observe(bar, { subtree: true, childList: true, attributes: true, characterData: true });
  addEventListener('resize', schedule);
  document.fonts && document.fonts.ready.then(schedule);
  window.__remarkChromeRelayout = schedule; // applyZoom: the bar's pixels changed size
  // the host pushes hover/press of the caption buttons and the maximized
  // state (which glyph the middle button shows)
  window.__remarkCaptionHover = (hover, pressed) => {
    for (const [id, name] of [['#capMin', 'min'], ['#capMax', 'max'], ['#capClose', 'close']]) {
      $(id).classList.toggle('hover', hover === name);
      $(id).classList.toggle('pressed', pressed === name);
    }
  };
  window.__remarkCaptionState = maximized => {
    document.body.classList.toggle('maximized', !!maximized);
    const t = maximized ? 'Restore' : 'Maximize';
    if ($('#capMax').title !== t) $('#capMax').title = t;
  };
  schedule();
}

function wireTopbar() {
  $('#brandmark').innerHTML = iconHTML('notebook-pen');
  // the logo is the way back to the landing page (on the phone the only way
  // to switch documents)
  const brand = document.querySelector('.brand');
  brand.title = 'Open another document';
  brand.style.cursor = 'pointer';
  brand.addEventListener('click', () => { location.href = '/?t=' + TOKEN; });
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
    let target = document.getElementById(want) ||
      [...document.querySelectorAll('#doc h1,#doc h2,#doc h3,#doc h4,#doc h5,#doc h6')]
        .find(h => slug(h.textContent) === want);
    // a comment reference whose element isn't rendered: the comment sits in
    // a collapsed thread — expand its ancestry and retry
    if (!target && /^r\d{8,}$/.test(want)) {
      const digits = want.slice(1);
      let found = null;
      const walk = (items, anc) => items.forEach(it => {
        const chain = anc.concat(it);
        if (it.time && it.time.replace(/\D/g, '') === digits) found = chain;
        if (it.children) walk(it.children, chain);
      });
      try { walk(RvParser.parse(normEol(S.doc.content)).items, []); } catch (err) {}
      if (found) {
        for (const p of found) {
          S.collapsed.set(p.key, false);
          persistCollapse(p.key, false);
        }
        render();
        target = document.getElementById(want);
        if (!target) {
          toast('warn', 'That comment is in a hidden resolved thread — turn on “Show resolved” to jump to it.');
          return;
        }
      }
    }
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (/^(https?:|mailto:)/i.test(href)) {
    e.preventDefault();
    // remotely the HOST must not open windows — the reader's own browser
    // handles the link (openurl is refused through the gateway anyway)
    if (PREFS.gateway) { window.open(href, '_blank', 'noopener'); return; }
    fetch('/api/openurl?u=' + encodeURIComponent(href) + '&t=' + TOKEN);
  } else if (href.startsWith('/?') || href.startsWith('?') ||
             href.startsWith(location.origin + '/?')) {
    // the app's own navigation (landing recents open files this way)
  } else {
    // a relative link: markdown opens in a second remark window, any other
    // local file in its default app — this window itself never navigates
    e.preventDefault();
    if (PREFS.gateway) {
      toast('warn', 'That link points at a file on the host — only shared documents are reachable remotely.');
      return;
    }
    if (!S.path) return;
    fetch('/api/openfile?path=' + encodeURIComponent(S.path) +
          '&href=' + encodeURIComponent(href) + '&t=' + TOKEN)
      .then(r => r.json()).then(j => {
        if (j.error) toast('warn', 'Can’t open that link: ' + String(j.error).replace(/[<>&]/g, ''));
      }).catch(() => {});
  }
});


// the splash (index.html) covers load + first paint; drop it once painted
function dismissSplash() {
  fetch('/api/uiready?t=' + TOKEN).catch(() => {}); // reveal the native window
  // back to where the document was last time (saved on scroll, per file).
  // The page may still be short at first paint (content, images), so keep
  // trying until it can hold the position; saving is off meanwhile, or the
  // clamped scroll would overwrite the saved value with zero
  if (S.path && !S.scrollRestored) {
    S.scrollRestored = true;
    let y = 0;
    try { y = parseInt(localStorage.getItem('remark:scroll:' + S.path) || '', 10) || 0; } catch (e) {}
    if (y > 0) {
      S.pendingScroll = y;
      const until = Date.now() + 5000;
      const attempt = () => {
        if (S.pendingScroll == null) return;
        const m = scroller();
        const room = m.scrollHeight - m.clientHeight;
        if (room >= y || Date.now() > until) {
          m.scrollTop = Math.min(y, Math.max(0, room));
          S.pendingScroll = null;
          return;
        }
        requestAnimationFrame(attempt);
      };
      requestAnimationFrame(attempt);
    }
  }
  // an update done elsewhere (or a first run of a changelog-aware build):
  // whatever this build's changelog has that this machine never showed
  if (S.path && !S.whatsNewChecked) {
    S.whatsNewChecked = true;
    fetch('/api/whatsnew?since=seen&t=' + TOKEN).then(r => r.json()).then(j => {
      if (j && j.entries && j.entries.length) {
        toast('ok', '<b>remark was updated since you last used it</b> ' +
          '<button class="tbtn" onclick="showWhatsNew(\'seen\')">What\'s new</button>', 'whatsnew-seen');
      }
    }).catch(() => {});
  }
  const sp = $('#splash');
  if (!sp) return;
  requestAnimationFrame(() => {
    sp.classList.add('gone');
    setTimeout(() => sp.remove(), 300);
  });
}

async function init() {
  await loadPrefs();
  if (PREFS.gateway) wireRemoteBadge();
  // a group member without a name yet picks one first — nothing else works
  // until the comments they will write can be signed
  if (PREFS.group && !(PREFS.me || '').trim()) {
    showGroupJoin();
    dismissSplash();
    return;
  }
  S.me = PREFS.me || 'Me';
  S.mode = PREFS.mode || 'inline';
  S.outline = PREFS.outline !== undefined ? PREFS.outline : true;
  S.outlineAll = !!PREFS.outlineAll;
  S.hideResolved = !!PREFS.hideResolved;
  S.zoom = mobileQuery.matches ? phoneZoom()
    : (S.path && PREFS['zoom:' + S.path]) || PREFS.zoom || 1;
  try {
    S.collapsedSaved = JSON.parse(localStorage.getItem('remark:collapsed:' + S.path) || '{}');
  } catch (e) { S.collapsedSaved = {}; }
  loadBookmarks();
  applyZoom();
  wireWindowChrome(); // the landing page has the toolbar too
  if (!S.path) { showLanding(); dismissSplash(); return; }
  applyChrome();
  scroller().focus({ preventScroll: true }); // keyboard scrolling goes to the scroller
  const fn = $('#filename');
  fn.textContent = '';
  const bb = document.createElement('b');
  bb.textContent = splitPath(S.path).base;
  fn.appendChild(bb);
  fn.title = S.path;
  wireTopbar();
  wireDivider();
  wireOutlineResize();
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
  if (!PREFS.gateway) addRecent(S.path); // behind the gateway the list is the shared docs, not history
  S.doc = { content: res.json.content, hash: res.json.hash };
  detectEol();
  render();
  idleStatus();
  openEvents();
  fetchPresence();
  setInterval(fetchPresence, 5000);
  dismissSplash();

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
