// remark parser: parses a markdown document into blocks, recognising inline
// comment threads written as list items — either checkbox ("resolvable")
// items or plain-dash items:
//
//   - [ ] Author: comment text <!--rv-->
//
//     - Other: a nested reply (plain item, not resolvable)
//
// A checkbox item nested inside a thread is always a comment; a PLAIN "- "
// item is a comment only when its text carries an author prefix or a
// <!--thread-->/<!--rv--> marker — otherwise it is ordinary body list
// content of the enclosing comment. A top-level item (either form) is a
// thread root when it carries the marker, or (for files written by hand)
// when it starts with a short "Author:" prefix. Ordinary task lists (e.g.
// an agent's task log) are left alone and rendered as plain markdown.
//
// Per-item state:
//   - resolvable: the item was written with a checkbox
//   - checked:    for resolvable items this means "resolved"
//   - seenBy:     readers listed in an optional <!--seen:A,B--> marker on
//                 the item's first line (stripped from display and hashes)
//
// It also applies operations (add thread / reply / resolve / seen / stamp)
// to a fresh copy of the document, anchoring by content hashes rather than
// line numbers so ops survive concurrent edits by other writers.

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.RvParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MARKER = '<!--thread-->';
  var MARKER_RE = /<!--\s*(?:rv|thread)\s*-->/;
  var MARKER_RE_G = /<!--\s*(?:rv|thread)\s*-->/g;
  var ITEM_RE = /^(\s*)- \[([ xX])\] (.*)$/;
  var PLAIN_ITEM_RE = /^(\s*)- (?!\[[ xX]\] )(\S.*)$/;
  var SEEN_RE = /<!--\s*seen:\s*([^>]*?)\s*-->/;
  var SEEN_RE_G = /<!--\s*seen:[^>]*-->/g;
  var SEEN_STRIP_RE = /[ \t]*<!--\s*seen:[^>]*-->/;
  var LIST_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+/;
  var HEADING_RE = /^(#{1,6})\s+(.*)$/;
  var FENCE_RE = /^\s*(```|~~~)/;

  function hashText(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  function normalize(s) {
    return s.replace(MARKER_RE_G, '').replace(SEEN_RE_G, '')
      .replace(/\s+/g, ' ').trim().slice(0, 400);
  }

  // Matches EITHER item form and normalizes it into one shape, or null.
  // No comment-gating here — callers decide (checkbox items are always
  // comments when nested; plain items must pass isCommentText / the root
  // heuristic).
  function matchItemForm(line) {
    var m = line.match(ITEM_RE);
    if (m) return { indent: m[1].length, checked: m[2] !== ' ', resolvable: true, text: m[3] };
    m = line.match(PLAIN_ITEM_RE);
    if (m) return { indent: m[1].length, checked: false, resolvable: false, text: m[2] };
    return null;
  }

  // Gate for PLAIN "- " items only: they count as comments when explicitly
  // marked or when their text carries a TIMESTAMPED author prefix. The
  // timestamp is required because ordinary body bullets like "- Homepage:
  // the intro page" would otherwise read as comments by author "Homepage"
  // (and the auto-stamper would then write timestamps into them).
  function isCommentText(text) {
    if (MARKER_RE.test(text)) return true;
    var a = parseAuthor(text.replace(MARKER_RE_G, '').replace(SEEN_RE_G, '').trim());
    return !!a && TIME_RE.test(a.author);
  }

  function indentOf(line) {
    var m = line.match(/^ */);
    return m[0].length;
  }

  function isBlank(line) {
    return /^\s*$/.test(line);
  }

  // Optional timestamp suffix in the author prefix, embedded as plain text:
  // "Alice (2026-09-02 14:32): ..."
  var TIME_RE = /\s*\((\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)\)$/;

  // "Author: rest" on the first line of an item body. Lenient — used for
  // display on items already inside a thread.
  function parseAuthor(firstLine) {
    var m = firstLine.match(/^(.{1,48}?):\s+(.*)$/);
    if (!m) {
      // "Author (ts):" with nothing after the colon — the writer uses this
      // for bodies that cannot sit inline (fences, lists, blank first line);
      // only the unambiguous timestamped prefix qualifies as empty-bodied.
      m = firstLine.match(/^(.{1,48}?):\s*$/);
      if (!m || !TIME_RE.test(m[1])) return null;
      m = [m[0], m[1], ''];
    }
    var name = m[1];
    if (/https?$/i.test(name) || name.indexOf('](') !== -1 || name.indexOf('`') !== -1 ||
        name.indexOf('[') !== -1 || name.indexOf('*') !== -1) return null;
    return { author: name.trim(), rest: m[2] };
  }

  // Strict heuristic for deciding a top-level checkbox item is a thread root
  // (only used when the <!--rv--> marker is absent): author must be a single
  // word, or an emoji/symbol-prefixed short name like "🤖 Agent".
  function isThreadRootText(text) {
    if (MARKER_RE.test(text)) return true;
    var a = parseAuthor(text);
    if (!a) return false;
    var name = a.author.replace(TIME_RE, '').trim();
    if (name.length > 24) return false;
    var words = name.split(/\s+/);
    if (words.length === 1) return true;
    var startsSymbol = /^[^A-Za-z0-9À-ɏ]/.test(name);
    return startsSymbol && words.length <= 3;
  }

  // Parses the comment-item tree starting at lines[start] (a thread root,
  // checkbox or plain form). Returns {item, end} where end is the last line
  // index belonging to the thread (trailing blank lines excluded).
  function parseItemTree(lines, start) {
    var m = matchItemForm(lines[start]);
    var rootIndent = m.indent;

    function newItem(indent, checked, resolvable, firstLine, lineNo) {
      return {
        indent: indent, checked: checked, resolvable: resolvable,
        bodyLines: [firstLine],
        startLine: lineNo, endLine: lineNo, children: [],
        // parts preserves the ORDER of text and nested items, so a reply can
        // sit half-way through a comment (an interjection) and render there
        parts: [{ lines: [firstLine], nos: [lineNo] }]
      };
    }

    function pushText(owner, text, lineNo, blanks) {
      var last = owner.parts[owner.parts.length - 1];
      if (!last || last.child) {
        last = { lines: [], nos: [] };
        owner.parts.push(last);
        blanks = 0; // blanks between a child and resumed text are separators
      }
      for (var b = 0; b < blanks; b++) {
        last.lines.push('');
        last.nos.push(-1);
      }
      last.lines.push(text);
      last.nos.push(lineNo);
    }

    var rootItem = newItem(rootIndent, m.checked, m.resolvable, m.text, start);
    var stack = [rootItem];
    var pendingBlanks = 0;
    var i = start + 1;
    var lastContent = start;
    var inFence = false; // fenced code inside a comment body: lines that look
                         // like checkbox items in there are NOT replies

    for (; i < lines.length; i++) {
      var line = lines[i];
      if (isBlank(line)) { pendingBlanks++; continue; }
      var ind = indentOf(line);
      if (!inFence && ind <= rootIndent) break;

      var im = !inFence && matchItemForm(line);
      if (im && im.indent > rootIndent && (im.resolvable || isCommentText(im.text))) {
        var iind = im.indent;
        while (stack.length > 1 && stack[stack.length - 1].indent >= iind) stack.pop();
        var parent = stack[stack.length - 1];
        var child = newItem(iind, im.checked, im.resolvable, im.text, i);
        parent.children.push(child);
        parent.parts.push({ child: child });
        stack.push(child);
      } else {
        // continuation line: belongs to the deepest item shallower than it
        if (!inFence) {
          while (stack.length > 1 && stack[stack.length - 1].indent >= ind) stack.pop();
        }
        var owner = stack[stack.length - 1];
        for (var b2 = 0; b2 < pendingBlanks; b2++) owner.bodyLines.push('');
        var textLine = line.slice(Math.min(ind, owner.indent + 2));
        owner.bodyLines.push(textLine);
        pushText(owner, textLine, i, pendingBlanks);
        if (FENCE_RE.test(line)) inFence = !inFence;
      }
      pendingBlanks = 0;
      lastContent = i;
      for (var s = 0; s < stack.length; s++) stack[s].endLine = i;
    }

    finalizeItem(rootItem, true);
    return { item: rootItem, end: lastContent };
  }

  function finalizeItem(item, isRoot) {
    var raw = item.bodyLines.join('\n').replace(/\s+$/, '');
    item.seenBy = [];
    var seenM = (item.bodyLines[0] || '').match(SEEN_RE);
    if (seenM) {
      item.seenBy = seenM[1].split(',')
        .map(function (s2) { return s2.trim(); })
        .filter(function (s2) { return s2 !== ''; });
    }
    item.author = null;
    item.time = null;
    item.title = null;
    item.segments = [];
    var texts = [];
    var raws = [];
    var firstText = true;

    item.parts.forEach(function (part) {
      if (part.child) {
        finalizeItem(part.child, false);
        item.segments.push({ type: 'item', item: part.child });
        return;
      }
      // structural markers live on the item's FIRST line only — strip them
      // there and nowhere else, so a body can *talk about* `<!--seen:-->`
      // (e.g. in backticks) without the text vanishing
      var display = part.lines.join('\n').replace(/\s+$/, '').replace(/[ \t]+$/gm, '');
      if (firstText) {
        var dstrip = display.split('\n');
        dstrip[0] = dstrip[0].replace(MARKER_RE_G, '').replace(SEEN_RE_G, '').replace(/[ \t]+$/, '');
        display = dstrip.join('\n');
      }
      var raw2 = display;
      if (firstText) {
        firstText = false;
        var dl = display.split('\n');
        var a = parseAuthor(dl[0]);
        item.author = a ? a.author : null;
        if (item.author) {
          var tm = item.author.match(TIME_RE);
          if (tm) {
            item.time = tm[1];
            item.author = item.author.slice(0, tm.index).trim();
          }
        }
        display = a ? [a.rest].concat(dl.slice(1)).join('\n') : display;
        raw2 = display; // author prefix stripped, title line KEPT — edit source
        // thread title: a root comment whose body's ENTIRE first line is
        // bold ("**Title**") names the whole thread
        if (isRoot) {
          var bl = display.split('\n');
          var tt = bl[0].match(/^\*\*([^*].*?)\*\*\s*$/);
          if (tt) {
            item.title = tt[1].trim();
            display = bl.slice(1).join('\n');
          }
        }
      }
      display = display.replace(/^\n+/, '');
      raw2 = raw2.replace(/^\n+/, '');
      if (raw2.trim() !== '') raws.push(raw2);
      if (display.trim() !== '') {
        item.segments.push({ type: 'text', md: display, part: part });
        texts.push(display);
      }
    });

    item.bodyMd = texts.join('\n\n').replace(/\s+$/, '');
    // rawBody: what an editor should be prefilled with — the item's own text
    // minus author prefix and markers, title line included
    item.rawBody = raws.join('\n\n').replace(/\s+$/, '');
    item.hasMarker = MARKER_RE.test(raw);
    item.hash = hashText(normalize(raw));
  }

  // the paragraphs of an item's own text (children excluded), each with a
  // content hash and the file line it ends on — anchors for interjections.
  // The first line is normalized the same way the renderer sees it (author
  // prefix and title line stripped), so DOM-side hashes match.
  function itemParagraphs(item) {
    var out = [];
    var firstText = true;
    item.parts.forEach(function (part) {
      if (part.child) return;
      var lines2 = part.lines.slice();
      var nos2 = part.nos.slice();
      if (firstText) {
        firstText = false;
        var a = parseAuthor(lines2[0].replace(MARKER_RE_G, '').replace(SEEN_RE_G, ''));
        if (a) lines2[0] = a.rest;
        if (item.title && lines2.length &&
            /^\*\*([^*].*?)\*\*\s*$/.test(lines2[0].replace(MARKER_RE_G, '').replace(SEEN_RE_G, '').trim())) {
          lines2.shift();
          nos2.shift();
        }
      }
      var cur = null;
      for (var i = 0; i < lines2.length; i++) {
        var t = lines2[i];
        if (t.trim() === '') { cur = null; continue; }
        if (!cur) {
          cur = { text: t, lastNo: nos2[i] };
          out.push(cur);
        } else {
          cur.text += ' ' + t;
          if (nos2[i] >= 0) cur.lastNo = nos2[i];
        }
      }
    });
    out.forEach(function (p) { p.hash = hashText(normalize(p.text)); });
    return out;
  }

  function subtreeEnd(item) {
    var end = item.endLine;
    item.children.forEach(function (c) { end = Math.max(end, subtreeEnd(c)); });
    return end;
  }

  function flattenItems(item, out) {
    out.push(item);
    item.children.forEach(function (c) { flattenItems(c, out); });
    return out;
  }

  // ---- document parsing ------------------------------------------------

  // Returns { blocks: [...], items: [...] }.
  // Block: { type: 'heading'|'prose'|'thread', startLine, endLine, text,
  //          hash, level? (heading), thread? (root item) }
  function parse(text) {
    var lines = text.split('\n');
    var blocks = [];
    var n = lines.length;
    var i = 0;

    function pushBlock(type, start, end, extra) {
      var blockText = lines.slice(start, end + 1).join('\n');
      var b = {
        type: type, startLine: start, endLine: end,
        text: blockText, hash: hashText(normalize(blockText))
      };
      if (extra) for (var k in extra) b[k] = extra[k];
      blocks.push(b);
      return b;
    }

    while (i < n) {
      var line = lines[i];
      if (isBlank(line)) { i++; continue; }

      // fenced code block
      var fm = line.match(FENCE_RE);
      if (fm) {
        var fence = fm[1];
        var j = i + 1;
        while (j < n && lines[j].indexOf(fence) === -1) j++;
        pushBlock('prose', i, Math.min(j, n - 1));
        i = Math.min(j, n - 1) + 1;
        continue;
      }

      // heading
      var hm = line.match(HEADING_RE);
      if (hm) {
        pushBlock('heading', i, i, { level: hm[1].length, headingText: hm[2] });
        i++;
        continue;
      }

      // thread root (checkbox or plain form, same gating for both)
      var im = matchItemForm(line);
      if (im && im.indent === 0 && isThreadRootText(im.text)) {
        var t = parseItemTree(lines, i);
        pushBlock('thread', i, t.end, { thread: t.item });
        i = t.end + 1;
        continue;
      }

      // ordinary list (incl. non-thread task lists): consume the whole list
      if (LIST_RE.test(line)) {
        var k2 = i;
        var last = i;
        while (k2 < n) {
          if (isBlank(lines[k2])) {
            // continue the list only if the next non-blank line is indented
            // or is another non-thread list item
            var p = k2;
            while (p < n && isBlank(lines[p])) p++;
            if (p >= n) break;
            var pin = indentOf(lines[p]);
            var pim = matchItemForm(lines[p]);
            if (pin > 0) { k2 = p; continue; }
            if (LIST_RE.test(lines[p]) && !(pim && isThreadRootText(pim.text))) { k2 = p; continue; }
            break;
          }
          last = k2;
          k2++;
        }
        pushBlock('prose', i, last);
        i = last + 1;
        continue;
      }

      // paragraph / blockquote / table: consume until blank line or a
      // structural opener
      var j2 = i;
      while (j2 + 1 < n && !isBlank(lines[j2 + 1]) &&
             !HEADING_RE.test(lines[j2 + 1]) &&
             !FENCE_RE.test(lines[j2 + 1]) &&
             !LIST_RE.test(lines[j2 + 1])) {
        j2++;
      }
      pushBlock('prose', i, j2);
      i = j2 + 1;
    }

    var items = [];
    blocks.forEach(function (b) {
      if (b.type === 'thread') flattenItems(b.thread, items);
    });
    return { blocks: blocks, items: items, lines: lines };
  }

  // ---- rendering helpers -----------------------------------------------

  function findByHash(list, hash, occ) {
    var matches = list.filter(function (x) { return x.hash === hash; });
    if (!matches.length) return null;
    if (typeof occ === 'number' && occ < matches.length) return matches[occ];
    return matches[0];
  }

  function occurrenceOf(list, entry) {
    var occ = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i] === entry) return occ;
      if (list[i].hash === entry.hash) occ++;
    }
    return 0;
  }

  // ---- serialisation of new comments -----------------------------------

  // withMarker: only thread ROOTS carry the sentinel — replies are replies
  // by structure and stay clean.
  // opener: true writes a resolvable checkbox item "- [ ] ..."; false writes
  // a plain item "- ...". Defaults to true (checkbox) for back-compat.
  function commentLines(indent, checked, author, text, time, withMarker, opener) {
    if (opener === undefined) opener = true;
    var sp = new Array(indent + 1).join(' ');
    var spc = new Array(indent + 3).join(' ');
    var parts = text.replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n');
    var signed = author + (time ? ' (' + time + ')' : '');
    var bullet = opener ? '- [' + (checked ? 'x' : ' ') + '] ' : '- ';
    // A first line that is blank, opens a fence or starts its own list item
    // cannot sit inline after "Author:" — the whole body moves to
    // continuation lines and the item line ends at the colon (the parser
    // accepts that form when the prefix carries a timestamp).
    var inline = parts[0];
    var shunt = time && (inline.trim() === '' || FENCE_RE.test(inline) || LIST_RE.test(inline));
    var out = [sp + bullet + signed + ':' + (shunt ? '' : ' ' + inline) +
      (withMarker ? ' ' + MARKER : '')];
    for (var i = shunt ? 0 : 1; i < parts.length; i++) {
      out.push(parts[i].trim() === '' ? '' : spc + parts[i]);
    }
    return out;
  }

  // ---- operations -------------------------------------------------------

  // op = { type:'resolve', hash, occ, resolved }   (resolvable items only)
  //    | { type:'toggle',  hash, occ, checked }    (alias of 'resolve')
  //    | { type:'seen',    hash, occ, reader, on } (add/remove seen marker)
  //    | { type:'reply',   parentHash, occ, author, text, opener? }
  //    | { type:'add',     blockHash, occ, sectionHash, author, text, atEnd?, opener? }
  //    | { type:'edit',    hash, occ, text }        (rewrite an item's body text)
  //
  // reply: opener falsy writes a plain "- " item; true writes a checkbox.
  // add: opener defaults TRUE (thread roots are resolvable by default)
  //      unless op.opener === false.
  //
  // Returns { text, results: [{op, ok, reason?}] }. Ops are applied one at a
  // time against a re-parse, so line numbers stay valid.
  function applyOps(text, ops) {
    var results = [];
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      var doc = parse(text);
      var lines = doc.lines;
      var r = { op: op, ok: false };

      if (op.type === 'stamp') {
        // normalize a hand-typed comment: add missing author and/or timestamp
        var sit = findByHash(doc.items, op.hash, op.occ);
        if (!sit) { r.reason = 'comment not found'; results.push(r); continue; }
        var slm = lines[sit.startLine].match(/^(\s*- (?:\[[ xX]\] )?)(.*)$/);
        var srest = slm[2];
        var newRest;
        if (op.author) {
          newRest = op.author + ' (' + op.time + '): ' + srest;
        } else {
          var am = srest.match(/^(.{1,48}?):\s*/);
          if (!am) { r.reason = 'no author prefix to stamp'; results.push(r); continue; }
          newRest = am[1] + ' (' + op.time + '): ' + srest.slice(am[0].length);
        }
        lines[sit.startLine] = slm[1] + newRest;
        text = lines.join('\n');
        r.ok = true;

      } else if (op.type === 'toggle' || op.type === 'resolve') {
        var item = findByHash(doc.items, op.hash, op.occ);
        if (!item) { r.reason = 'comment not found in the current file'; results.push(r); continue; }
        if (!item.resolvable) { r.reason = 'comment is not resolvable (plain item, no checkbox)'; results.push(r); continue; }
        var want = op.type === 'resolve' ? op.resolved : op.checked;
        var lm = lines[item.startLine].match(ITEM_RE);
        lines[item.startLine] = lm[1] + '- [' + (want ? 'x' : ' ') + '] ' + lm[3];
        text = lines.join('\n');
        r.ok = true;

      } else if (op.type === 'seen') {
        var sit2 = findByHash(doc.items, op.hash, op.occ);
        if (!sit2) { r.reason = 'comment not found in the current file'; results.push(r); continue; }
        var ln0 = lines[sit2.startLine];
        var sm2 = ln0.match(SEEN_RE);
        var readers = sm2 ? sm2[1].split(',')
          .map(function (x) { return x.trim(); })
          .filter(function (x) { return x !== ''; }) : [];
        var ri = readers.indexOf(op.reader);
        if (op.on && ri === -1) readers.push(op.reader);
        else if (!op.on && ri !== -1) readers.splice(ri, 1);
        var ln1;
        if (readers.length === 0) {
          ln1 = sm2 ? ln0.replace(SEEN_STRIP_RE, '').replace(/[ \t]+$/, '') : ln0;
        } else {
          var tag = '<!--seen:' + readers.join(',') + '-->';
          ln1 = sm2 ? ln0.replace(SEEN_RE, tag) : ln0.replace(/[ \t]+$/, '') + ' ' + tag;
        }
        lines[sit2.startLine] = ln1;
        text = lines.join('\n');
        r.ok = true;

      } else if (op.type === 'reply') {
        var parent = findByHash(doc.items, op.parentHash, op.occ);
        if (!parent) { r.reason = 'the comment being replied to is gone from the file'; results.push(r); continue; }
        var insertAt = subtreeEnd(parent) + 1;
        // interjection: anchor the reply right after a specific paragraph
        // INSIDE the parent comment instead of after its whole subtree
        if (op.afterPara) {
          var paras = itemParagraphs(parent).filter(function (p) { return p.hash === op.afterPara; });
          var target = paras[op.afterParaOcc || 0] || paras[0];
          if (target && target.lastNo >= 0) insertAt = target.lastNo + 1;
        }
        var newLines = [''].concat(commentLines(parent.indent + 2, false, op.author, op.text, op.time, false, !!op.opener));
        Array.prototype.splice.apply(lines, [insertAt, 0].concat(newLines));
        text = lines.join('\n');
        r.ok = true;

      } else if (op.type === 'edit') {
        // rewrites the item's own body TEXT wholesale, keeping the bullet
        // form ("- " / "- [ ]" / "- [x]"), the author prefix incl. its
        // timestamp, and the first-line <!--thread-->/<!--rv-->/<!--seen-->
        // markers. op.hash is the PRE-edit content hash — the doc is
        // re-parsed per op, so it still resolves here; the hash changes
        // only in the text this op produces. Interjections: the item's text
        // may be interleaved with child items; the new body is written as
        // ONE contiguous block right after the prefix line and all children
        // are kept (verbatim) after it — interleaved placement is
        // intentionally not reconstructed.
        var eit = findByHash(doc.items, op.hash, op.occ);
        if (!eit) { r.reason = 'comment not found in the current file'; results.push(r); continue; }
        var estart = eit.startLine, eend = subtreeEnd(eit);
        var eln = lines[estart];
        var thrM = (eln.match(MARKER_RE) || [''])[0];
        var seenTag = (eln.match(SEEN_RE) || [''])[0];
        eln = eln.replace(MARKER_RE_G, '').replace(SEEN_RE_G, '').replace(/[ \t]+$/, '');
        var ebm = eln.match(/^(\s*- (?:\[[ xX]\] )?)(.*)$/);
        // op.opener (optional) rewrites the item's FORM: true gives it a
        // checkbox (keeping an existing checked state), false strips it
        if (op.opener !== undefined) {
          var eind2 = new Array(eit.indent + 1).join(' ');
          ebm[1] = op.opener
            ? eind2 + '- [' + (eit.resolvable && eit.checked ? 'x' : ' ') + '] '
            : eind2 + '- ';
        }
        var ea = parseAuthor(ebm[2]);
        var espc = new Array(eit.indent + 3).join(' ');
        var ebody = op.text.replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n');
        var eout = [ebm[1] + (ea ? ea.author + ': ' : '') + ebody[0] +
          (thrM ? ' ' + thrM : '') + (seenTag ? ' ' + seenTag : '')];
        for (var el2 = 1; el2 < ebody.length; el2++) {
          eout.push(ebody[el2].trim() === '' ? '' : espc + ebody[el2]);
        }
        eit.children.forEach(function (c) {
          eout.push('');
          for (var cl = c.startLine; cl <= subtreeEnd(c); cl++) eout.push(lines[cl]);
        });
        Array.prototype.splice.apply(lines, [estart, eend - estart + 1].concat(eout));
        text = lines.join('\n');
        r.ok = true;

      } else if (op.type === 'add') {
        var insertLine = -1;
        var anchor = null;
        if (op.blockHash) {
          anchor = findByHash(doc.blocks.filter(function (b) { return b.type !== 'thread'; }), op.blockHash, op.occ);
        }
        if (anchor) {
          // insert after the anchor block and any thread cluster already
          // attached to it
          var bi = doc.blocks.indexOf(anchor);
          while (bi + 1 < doc.blocks.length && doc.blocks[bi + 1].type === 'thread') bi++;
          insertLine = doc.blocks[bi].endLine + 1;
        } else if (op.sectionHash) {
          var sec = findByHash(doc.blocks.filter(function (b) { return b.type === 'heading'; }), op.sectionHash, 0);
          if (sec) {
            var si = doc.blocks.indexOf(sec);
            var endBlock = sec;
            for (var bj = si + 1; bj < doc.blocks.length; bj++) {
              if (doc.blocks[bj].type === 'heading' && doc.blocks[bj].level <= sec.level) break;
              endBlock = doc.blocks[bj];
            }
            insertLine = endBlock.endLine + 1;
          }
        }
        if (insertLine < 0 && op.atEnd) {
          insertLine = lines.length;
          while (insertLine > 0 && isBlank(lines[insertLine - 1])) insertLine--;
        }
        if (insertLine < 0) { r.reason = 'the paragraph this comment was attached to is gone from the file'; results.push(r); continue; }
        var nl = [''].concat(commentLines(0, false, op.author, op.text, op.time, true, op.opener !== false));
        Array.prototype.splice.apply(lines, [insertLine, 0].concat(nl));
        text = lines.join('\n');
        r.ok = true;

      } else {
        r.reason = 'unknown operation';
      }
      results.push(r);
    }
    return { text: text, results: results };
  }

  return {
    parse: parse,
    applyOps: applyOps,
    hashText: hashText,
    normalize: normalize,
    occurrenceOf: occurrenceOf,
    subtreeEnd: subtreeEnd,
    itemParagraphs: itemParagraphs,
    MARKER: MARKER
  };
});
