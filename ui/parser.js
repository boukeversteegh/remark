// remark parser: parses a markdown document into blocks, recognising inline
// comment threads written as checkbox list items:
//
//   - [ ] Author: comment text <!--rv-->
//
//     - [x] Other: a nested reply
//
// A top-level checkbox item is a thread root when it carries the <!--rv-->
// marker, or (for files written by hand / by the agent before adopting the
// marker) when it starts with a short "Author:" prefix. Ordinary task lists
// (e.g. an agent's task log) are left alone and rendered as plain markdown.
//
// It also applies operations (add thread / reply / toggle read-checkbox) to a
// fresh copy of the document, anchoring by content hashes rather than line
// numbers so ops survive concurrent edits by other writers.

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.RvParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MARKER = '<!--rv-->';
  var MARKER_RE = /<!--\s*rv\s*-->/;
  var MARKER_RE_G = /<!--\s*rv\s*-->/g;
  var ITEM_RE = /^(\s*)- \[([ xX])\] (.*)$/;
  var LIST_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+/;
  var HEADING_RE = /^(#{1,6})\s+(.*)$/;
  var FENCE_RE = /^\s*(```|~~~)/;

  function hashText(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  function normalize(s) {
    return s.replace(MARKER_RE_G, '').replace(/\s+/g, ' ').trim().slice(0, 400);
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
    if (!m) return null;
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

  // Parses the checkbox-item tree starting at lines[start] (a thread root).
  // Returns {item, end} where end is the last line index belonging to the
  // thread (trailing blank lines excluded).
  function parseItemTree(lines, start) {
    var m = lines[start].match(ITEM_RE);
    var rootIndent = m[1].length;

    function newItem(indent, checked, firstLine, lineNo) {
      return {
        indent: indent, checked: checked, bodyLines: [firstLine],
        startLine: lineNo, endLine: lineNo, children: []
      };
    }

    var rootItem = newItem(rootIndent, m[2] !== ' ', m[3], start);
    var stack = [rootItem];
    var pendingBlanks = 0;
    var i = start + 1;
    var lastContent = start;

    for (; i < lines.length; i++) {
      var line = lines[i];
      if (isBlank(line)) { pendingBlanks++; continue; }
      var ind = indentOf(line);
      if (ind <= rootIndent) break;

      var im = line.match(ITEM_RE);
      if (im && im[1].length > rootIndent) {
        var iind = im[1].length;
        while (stack.length > 1 && stack[stack.length - 1].indent >= iind) stack.pop();
        var parent = stack[stack.length - 1];
        var child = newItem(iind, im[2] !== ' ', im[3], i);
        parent.children.push(child);
        stack.push(child);
      } else {
        // continuation line: belongs to the deepest item shallower than it
        while (stack.length > 1 && stack[stack.length - 1].indent >= ind) stack.pop();
        var owner = stack[stack.length - 1];
        for (var b = 0; b < pendingBlanks; b++) owner.bodyLines.push('');
        owner.bodyLines.push(line.slice(Math.min(ind, owner.indent + 2)));
      }
      pendingBlanks = 0;
      lastContent = i;
      for (var s = 0; s < stack.length; s++) stack[s].endLine = i;
    }

    finalizeItem(rootItem);
    return { item: rootItem, end: lastContent };
  }

  function finalizeItem(item) {
    var raw = item.bodyLines.join('\n').replace(/\s+$/, '');
    var display = raw.replace(MARKER_RE_G, '').replace(/[ \t]+$/gm, '');
    var a = parseAuthor(display.split('\n')[0]);
    item.author = a ? a.author : null;
    item.time = null;
    if (item.author) {
      var tm = item.author.match(TIME_RE);
      if (tm) {
        item.time = tm[1];
        item.author = item.author.slice(0, tm.index).trim();
      }
    }
    item.bodyMd = a ? [a.rest].concat(display.split('\n').slice(1)).join('\n') : display;
    item.hasMarker = MARKER_RE.test(raw);
    item.hash = hashText(normalize(raw));
    item.children.forEach(finalizeItem);
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

      // thread root
      var im = line.match(ITEM_RE);
      if (im && im[1].length === 0 && isThreadRootText(im[3])) {
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
            var pim = lines[p].match(ITEM_RE);
            if (pin > 0) { k2 = p; continue; }
            if (LIST_RE.test(lines[p]) && !(pim && isThreadRootText(pim[3]))) { k2 = p; continue; }
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

  function commentLines(indent, checked, author, text, time) {
    var sp = new Array(indent + 1).join(' ');
    var spc = new Array(indent + 3).join(' ');
    var parts = text.replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n');
    var signed = author + (time ? ' (' + time + ')' : '');
    var out = [sp + '- [' + (checked ? 'x' : ' ') + '] ' + signed + ': ' + parts[0] + ' ' + MARKER];
    for (var i = 1; i < parts.length; i++) {
      out.push(parts[i].trim() === '' ? '' : spc + parts[i]);
    }
    return out;
  }

  // ---- operations -------------------------------------------------------

  // op = { type:'toggle', hash, occ, checked }
  //    | { type:'reply',  parentHash, occ, author, text }
  //    | { type:'add',    blockHash, occ, sectionHash, author, text, atEnd? }
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

      if (op.type === 'toggle') {
        var item = findByHash(doc.items, op.hash, op.occ);
        if (!item) { r.reason = 'comment not found in the current file'; results.push(r); continue; }
        var lm = lines[item.startLine].match(ITEM_RE);
        lines[item.startLine] = lm[1] + '- [' + (op.checked ? 'x' : ' ') + '] ' + lm[3];
        text = lines.join('\n');
        r.ok = true;

      } else if (op.type === 'reply') {
        var parent = findByHash(doc.items, op.parentHash, op.occ);
        if (!parent) { r.reason = 'the comment being replied to is gone from the file'; results.push(r); continue; }
        var insertAt = subtreeEnd(parent) + 1;
        var newLines = [''].concat(commentLines(parent.indent + 2, false, op.author, op.text, op.time));
        Array.prototype.splice.apply(lines, [insertAt, 0].concat(newLines));
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
        var nl = [''].concat(commentLines(0, false, op.author, op.text, op.time));
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
    MARKER: MARKER
  };
});
