// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// Same answers, byte for byte. Built for CPU time: single-pass Markdown with a
// charCode inline scanner (no per-character regex escapes), ASCII fast-path
// slugify, slice-based front matter, and templates compiled to JS functions
// with includes inlined (tree-walk interpreter kept as a fallback).

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const SLUG_MAX = 64;

// ---------------------------------------------------------------- text

// HTML escape. Fast path: a run with no special char is returned as-is.
const ESC_RE = /[&<>"']/;
function escapeHtml(s) {
  const m = ESC_RE.exec(s);
  if (m === null) return s;
  let out = s.slice(0, m.index);
  for (let i = m.index; i < s.length; i++) {
    const c = s[i];
    if (c === '&') out += '&amp;';
    else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else if (c === "'") out += '&#39;';
    else out += c;
  }
  return out;
}

function slugCoreAscii(s) {
  let out = '', gap = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 127) return null;
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  return out;
}

function slugCoreAny(s) {
  let out = '', gap = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  return out;
}

function slugify(text) {
  let out = slugCoreAscii(text);
  if (out === null) out = slugCoreAny(text.normalize('NFKD').replace(/\p{M}/gu, ''));
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

function longDate(date) {
  return (+date.slice(8, 10)) + ' ' + MONTHS[+date.slice(5, 7) - 1] + ' ' + date.slice(0, 4);
}

// JS \s set, as a table, for wordsOf (the baseline's /\S+/g).
const WS = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279]) WS[c] = 1;
for (let c = 8192; c <= 8202; c++) WS[c] = 1;

function wordsOf(text) {
  let n = 0, inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS[text.charCodeAt(i)]) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  let i = 0;
  while (i <= rel.length) {
    let j = rel.indexOf('/', i);
    if (j === -1) j = rel.length;
    const seg = rel.slice(i, j);
    if (seg !== '' && seg !== '.') {
      if (seg === '..') {
        if (parts.length === 0) return null;
        parts.pop();
      } else parts.push(seg);
    }
    i = j + 1;
  }
  return parts.join('/');
}

// Whether `t` opens on a scheme (letters, digits, +, -, . then ':').
function hasScheme(t) {
  const ci = t.indexOf(':');
  if (ci <= 0) return false;
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < ci; i++) {
    const c = t.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function fmStringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmStringOf(raw);
      return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? +m[1] : 0, mo = m ? +m[2] : 0, d = m ? +m[3] : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) tags[i] = tags[i].trim();
      for (let i = 0; i < tags.length; i++) {
        if (tags[i] === '' || !FM_TAG.test(tags[i])) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

function isBlankLine(s, a, b) { // s[a..b) all spaces/tabs
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Parse front matter without splitting the whole text: body is a slice.
// Returns { data, body } or { error }.
function parseFrontMatter(text) {
  let nl = text.indexOf('\n');
  const firstEnd = nl === -1 ? text.length : nl;
  if (firstEnd !== 3 || text[0] !== '-' || text[1] !== '-' || text[2] !== '-') return { error: 'no front matter' };
  // find the closing '---' line
  let pos = nl === -1 ? text.length : nl + 1;
  let closeStart = -1, closeEnd = -1;
  while (pos < text.length) {
    nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    if (end - pos === 3 && text[pos] === '-' && text[pos + 1] === '-' && text[pos + 2] === '-') {
      closeStart = pos; closeEnd = end;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // lines 1..close: line numbers counted from 1 at the opening '---'
  let lineNo = 1, p = text.indexOf('\n') + 1;
  while (p < closeStart) {
    nl = text.indexOf('\n', p);
    const end = nl === -1 ? text.length : nl;
    lineNo++;
    const line = text.slice(p, end);
    if (!isBlankLine(text, p, end) && text.charCodeAt(p) !== 35) { // not blank, not '#'
      const colon = line.indexOf(':');
      let key = '', raw = null;
      if (colon !== -1) {
        key = line.slice(0, colon);
        let ok = key.length > 0;
        for (let i = 0; ok && i < key.length; i++) {
          const c = key.charCodeAt(i);
          if (!((c >= 97 && c <= 122) || c === 95)) ok = false;
        }
        if (ok) {
          if (colon === line.length - 1) raw = '';
          else if (line.charCodeAt(colon + 1) === 32) raw = line.slice(colon + 2);
          else ok = false;
        }
      }
      if (colon === -1 || raw === null) return { error: 'line ' + lineNo + ' is not "key: value"' };
      let t = raw.length;
      while (t > 0) {
        const c = raw.charCodeAt(t - 1);
        if (c === 32 || c === 9) t--; else break;
      }
      raw = t === raw.length ? raw : raw.slice(0, t);
      if (!FM_KEYS.includes(key)) return { error: 'unknown key "' + key + '"' };
      if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
      if (raw === '') return { error: 'key "' + key + '" has no value' };
      const v = fmValueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (nl === -1) break;
    p = nl + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const bodyStart = closeEnd === text.length ? text.length : closeEnd + 1;
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown


function trimLine(s) {
  let a = 0, b = s.length;
  while (a < b) { const c = s.charCodeAt(a); if (c === 32 || c === 9) a++; else break; }
  while (b > a) { const c = s.charCodeAt(b - 1); if (c === 32 || c === 9) b--; else break; }
  return s.slice(a, b);
}

function isBlank(s) {
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

// '```' + optional lang + spaces/tabs only. Returns lang or null.
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
  for (let j = i; j < line.length; j++) { const c = line.charCodeAt(j); if (c !== 32 && c !== 9) return null; }
  return line.slice(3, i);
}

function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) { const c = line.charCodeAt(j); if (c !== 32 && c !== 9) return false; }
  return true;
}

// Heading: 1-6 '#', >=1 space/tab, non-empty text (trailing spaces/tabs dropped).
// Mirrors /^(#{1,6})[ \t]+(.*?)[ \t]*$/ with non-empty text.
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let s = n;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s) { const d = line.charCodeAt(e - 1); if (d === 32 || d === 9) e--; else break; }
  if (s >= e) return null;
  return { depth: n, text: line.slice(s, e) };
}

function isHr(line) {
  if (line.length < 3) return false;
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false; // '-' or '*'
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let j = 3; j < line.length; j++) { const c = line.charCodeAt(j); if (c !== 32 && c !== 9) return false; }
  return true;
}

// Whether a line ends a paragraph: blank, fence, heading, or hr. Dispatched
// on the first char so a plain paragraph line costs one check.
function endsPara(line) {
  if (line.length === 0) return true; // '' has charCodeAt(0) === NaN
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return fenceOpen(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

function orderedOf(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null; // '.' + ' '
  return { num: line.slice(0, i), text: line.slice(i + 2) };
}

function isContinued(line) { // /^ {2,}\S/
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i >= 2 && i < line.length && !WS[line.charCodeAt(i)];
}

// The characters a backslash escapes, as a table.
const ESC_TABLE = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESC_TABLE[c] = 1;

function findUnescaped(s, what, from) {
  const w0 = what.charCodeAt(0), w1 = what.length > 1 ? what.charCodeAt(1) : -1;
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESC_TABLE[s.charCodeAt(j + 1)] === 1) { j++; continue; }
    if (s.charCodeAt(j) === w0 && (w1 === -1 || s.charCodeAt(j + 1) === w1)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESC_TABLE[s.charCodeAt(j + 1)] === 1) { j++; continue; }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

// Inline renderer: the next special is found by a native regex scan, plain runs
// are pushed whole, and only constructs (code/strong/em/link) recurse.
function inline(s, link) {
  const re = /[\\`*\[&<>"']/g;
  const out = [];
  const n = s.length;
  let run = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const j = m.index;
    const c = s.charCodeAt(j);
    if (c === 92) { // backslash
      if (j + 1 < n && ESC_TABLE[s.charCodeAt(j + 1)] === 1) {
        if (j > run) out.push(s.slice(run, j));
        const nx = s[j + 1];
        out.push(nx === '>' ? '&gt;' : nx);
        run = j + 2;
        re.lastIndex = run;
      } else {
        re.lastIndex = j + 1; // literal backslash, keep the run going
      }
      continue;
    }
    if (c === 96) { // backtick code span
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > run) out.push(s.slice(run, j));
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        run = k + 1;
        re.lastIndex = run;
      } else {
        re.lastIndex = j + 1;
      }
      continue;
    }
    if (c === 42) { // * strong / emphasis
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > run) out.push(s.slice(run, j));
          out.push('<strong>', inline(s.slice(j + 2, k), link), '</strong>');
          run = k + 2;
          re.lastIndex = run;
        } else {
          re.lastIndex = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          if (j > run) out.push(s.slice(run, j));
          out.push('<em>', inline(s.slice(j + 1, k), link), '</em>');
          run = k + 1;
          re.lastIndex = run;
        } else {
          re.lastIndex = j + 1;
        }
      }
      continue;
    }
    if (c === 91) { // [ link
      const k = findUnescaped(s, ']', j + 1);
      const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        if (j > run) out.push(s.slice(run, j));
        out.push('<a href="', escapeHtml(link(target)), '">', inline(s.slice(j + 1, k), link), '</a>');
        run = mm + 1;
        re.lastIndex = run;
      } else {
        re.lastIndex = j + 1;
      }
      continue;
    }
    // & < > " '
    if (j > run) out.push(s.slice(run, j));
    out.push(c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;');
    run = j + 1;
    re.lastIndex = run;
  }
  if (run < n) out.push(s.slice(run));
  return out.join('');
}

// Render one body: returns { html, toc, excerpt }. Renders blocks directly.
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const L = lines.length;
  while (i < L) {
    const line = lines[i];
    if (line === '') { i++; continue; } // blank (charCodeAt(0) is NaN)
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) { // indented: blank, or a paragraph line
      if (isBlank(line)) { i++; continue; }
    } else if (c0 === 96) { // '`' fence
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < L && !fenceClose(lines[i])) body.push(lines[i++]);
        i++;
        let code = '';
        for (let k = 0; k < body.length; k++) code += escapeHtml(body[k]) + '\n';
        blocks.push('<pre><code' + (lang === '' ? '' : ' class="language-' + escapeHtml(lang) + '"') + '>' + code + '</code></pre>');
        continue;
      }
    } else if (c0 === 35) { // '#' heading
      const hd = headingOf(line);
      if (hd !== null) {
        const id = uniqueSlug(slugify(hd.text), ids);
        const html = inline(hd.text, link);
        blocks.push('<h' + hd.depth + ' id="' + id + '">' + html + '</h' + hd.depth + '>');
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) { // '-' or '*': hr or bullet
      if (isHr(line)) { blocks.push('<hr>'); i++; continue; }
      const b0 = bulletOf(line);
      if (b0 !== null) {
        const items = [];
        while (i < L) {
          const m = bulletOf(lines[i]);
          if (m !== null) { items.push([trimLine(m)]); i++; continue; }
          if (items.length > 0 && isContinued(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; continue; }
          break;
        }
        let html = '<ul>\n';
        for (let k = 0; k < items.length; k++) html += '<li>' + inline(items[k].join('\n'), link) + '</li>\n';
        blocks.push(html + '</ul>');
        continue;
      }
    } else if (c0 === 62) { // '>' blockquote
      const body = [];
      while (i < L && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        l = trimLine(l);
        if (l !== '') body.push(l);
      }
      blocks.push(body.length === 0 ? '<blockquote>\n</blockquote>' : '<blockquote>\n<p>' + inline(body.join('\n'), link) + '</p>\n</blockquote>');
      continue;
    } else if (c0 >= 48 && c0 <= 57) { // digit: ordered list
      const o0 = orderedOf(line);
      if (o0 !== null) {
        const items = [];
        while (i < L) {
          const m = orderedOf(lines[i]);
          if (m !== null) { items.push([trimLine(m.text)]); i++; continue; }
          if (items.length > 0 && isContinued(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; continue; }
          break;
        }
        const startNum = +o0.num;
        let html = startNum !== 1 ? '<ol start="' + startNum + '">\n' : '<ol>\n';
        for (let k = 0; k < items.length; k++) html += '<li>' + inline(items[k].join('\n'), link) + '</li>\n';
        blocks.push(html + '</ol>');
        continue;
      }
    }
    // paragraph
    const body = [trimLine(line)];
    i++;
    while (i < L && !endsPara(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
  }
  let html = '';
  for (let k = 0; k < blocks.length; k++) html += blocks[k] + '\n';
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

// Tokenize exactly as makefun-site's template.js does (including the
// standalone-tag line rule and its error strings).
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError('template "' + name + '": an else outside an if');
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

// --- template value helpers (same semantics as makefun-site's) ---

function own(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// --- compiled templates ---
// A compiled template is a function (V, F) -> string, V the top-level vars,
// F the helpers { e: escapeHtml, t: textOf, y: truthy, o: own }.
// Includes are inlined at compile time with the call site's bindings, so a
// path's first segment resolves at compile time: a for-bound name to its JS
// variable, anything else to an own property of V. Depth stops includes at 8.
const F = { e: escapeHtml, t: textOf, y: truthy, o: own };

function compileTemplate(parsed, templates, depth, bound) {
  // bound: Map<template name, js var name> for the for-bound names in scope.
  let tmp = 0;
  const out = [];
  const jsStr = (s) => JSON.stringify(s);

  function pathExpr(path, bnd) {
    const first = path[0];
    let e;
    if (bnd.has(first)) e = bnd.get(first);
    else e = 'F.o(V,' + jsStr(first) + ')';
    for (let k = 1; k < path.length; k++) e = 'F.o(' + e + ',' + jsStr(path[k]) + ')';
    return e;
  }

  function gen(nodes, d, bnd) {
    for (const n of nodes) {
      if (n.kind === 'text') {
        if (n.text !== '') out.push('o.push(' + jsStr(n.text) + ');');
      } else if (n.kind === 'var') {
        out.push('o.push(F.e(F.t(' + pathExpr(n.path, bnd) + ')));');
      } else if (n.kind === 'raw') {
        out.push('o.push(F.t(' + pathExpr(n.path, bnd) + '));');
      } else if (n.kind === 'if') {
        const cond = 'F.y(' + pathExpr(n.path, bnd) + ')';
        out.push('if(' + (n.not ? '!' + cond : cond) + '){');
        gen(n.then, d, bnd);
        if (n.else !== null) { out.push('}else{'); gen(n.else, d, bnd); }
        out.push('}');
      } else if (n.kind === 'for') {
        const a = '_a' + (tmp++);
        const k = '_i' + (tmp++);
        const v = '$v' + (tmp++);
        const l = '$l' + (tmp++);
        out.push('var ' + a + '=' + pathExpr(n.path, bnd) + ';');
        out.push('if(Array.isArray(' + a + ')){');
        out.push('for(var ' + k + '=0;' + k + '<' + a + '.length;' + k + '++){');
        out.push('var ' + v + '=' + a + '[' + k + '];');
        out.push('var ' + l + '={index:' + k + '+1,first:' + k + '===0,last:' + k + '===' + a + '.length-1,length:' + a + '.length};');
        const b2 = new Map(bnd);
        b2.set(n.name, v);
        b2.set('loop', l);
        gen(n.body, d, b2);
        out.push('}}');
      } else if (n.kind === 'include') {
        const t = templates.get(n.name);
        if (t !== undefined && d < INCLUDE_DEPTH) gen(t, d + 1, bnd);
      }
    }
  }

  gen(parsed, depth, bound);
  const body = 'var o=[];' + out.join('') + 'return o.join("");';
  return new Function('V', 'F', body);
}

// --- interpreter fallback (same semantics, used only if codegen is unavailable) ---

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function renderNodes(nodes, scope, templates, depth) {
  let out = '';
  for (const n of nodes) {
    if (n.kind === 'text') out += n.text;
    else if (n.kind === 'var') out += escapeHtml(textOf(lookup(scope, n.path)));
    else if (n.kind === 'raw') out += textOf(lookup(scope, n.path));
    else if (n.kind === 'if') {
      const v = truthy(lookup(scope, n.path));
      const branch = v !== n.not ? n.then : n.else;
      if (branch !== null) out += renderNodes(branch, scope, templates, depth);
    } else if (n.kind === 'for') {
      const xs = lookup(scope, n.path);
      if (Array.isArray(xs)) {
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += renderNodes(n.body, { vars, parent: scope }, templates, depth);
        }
      }
    } else if (n.kind === 'include') {
      const t = templates.get(n.name);
      if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, templates, depth + 1);
    }
  }
  return out;
}

// ---------------------------------------------------------------- build

export function run(input) {
  // 1. templates, parsed in code-unit order of name
  const parsed = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const compiled = new Map(); // name -> function (compiled at depth 0, no bindings)
  let useCompiled = true;
  let compileFailed = false;
  const getCompiled = (name) => {
    let fn = compiled.get(name);
    if (fn === undefined && !compileFailed) {
      try {
        fn = compileTemplate(parsed.get(name), parsed, 0, new Map());
        compiled.set(name, fn);
      } catch (e) {
        compileFailed = true;
        useCompiled = false;
        fn = undefined;
      }
    }
    return fn;
  };
  const render = (name, vars) => {
    const nodes = parsed.get(name);
    if (nodes === undefined) return null;
    if (useCompiled) {
      const fn = getCompiled(name);
      if (fn !== undefined) return fn(vars, F);
    }
    return renderNodes(nodes, { vars, parent: null }, parsed, 0);
  };

  // 2. sources, sorted by path
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const bySource = new Map();
  const broken = new Set();

  // 3. front matter
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push('refused ' + s.path + ': ' + fm.error); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let ownDir;
    if (s.path.startsWith('tags/')) ownDir = 'tags';
    else if (s.path.startsWith('page/')) ownDir = 'page';
    if (ownDir !== undefined) { report.push('refused ' + s.path + ': ' + ownDir + '/ is the generator\'s own'); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push('refused ' + s.path + ': a post needs a date'); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!parsed.has(layout)) { report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses'); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push('draft ' + s.path); continue; }
    kept.push(s);
  }

  // 4. permalinks
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // 5. markdown
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
      if (path !== null && staticPaths.has(path)) return base + '/' + path + frag;
      broken.add('broken-link ' + s.path + ' -> ' + target);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 6. collections
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 7. tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (let i = 0; i < tags.length; i++) {
      const slug = slugify(tags[i]);
      if (!seen.has(slug)) { seen.add(slug); out.push([tags[i], slug]); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const [name, slug] of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = [];
    for (const [name, slug] of ownTags(s)) {
      const t = bySlug.get(slug);
      s.tagRefs.push(t === undefined ? { name, slug, url: '', posts: [] } : t);
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 8. cards / pages / layouts
  const linkOf = (s) => s === null ? null : {
    title: s.data.title, url: s.url,
    date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
  const cards = new Map();
  for (const p of posts) {
    cards.set(p, {
      title: p.data.title, url: p.url,
      date: p.data.date ?? '', date_long: p.data.date === undefined ? '' : longDate(p.data.date),
      summary: p.data.summary ?? '', excerpt: p.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(p.body) / 200)),
      tags: p.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    });
  }
  const pageOf = (s) => {
    const c = cards.get(s);
    if (c !== undefined) {
      return {
        title: c.title, url: c.url, date: c.date, date_long: c.date_long, summary: c.summary,
        excerpt: c.excerpt, reading_minutes: c.reading_minutes, tags: c.tags,
        slug: s.slug, content: s.html,
        toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
        newer: linkOf(s.newer ?? null), older: linkOf(s.older ?? null), is_post: s.post,
      };
    }
    return {
      title: s.data.title, url: s.url,
      date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '', excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      slug: s.slug, content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: null, older: null, is_post: s.post,
    };
  };

  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  for (const s of kept) output[s.outDir + '/index.html'] = render(s.layout, { site, tags: allTags, recent, page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      site, tags: allTags, recent,
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      site, tags: allTags, recent,
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', { site, tags: allTags, recent });
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  // 9. report
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push('built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
