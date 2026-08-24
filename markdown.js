// Shared by the notes panel (content script) and the settings page.
// Classic script: loaded after vendor/marked.umd.js, defines globals.

function escapeHtml(str) {
  return str.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const CODE_KEYWORDS = new Set([
  'if', 'else', 'elif', 'for', 'while', 'do', 'switch', 'case', 'default',
  'break', 'continue', 'return', 'yield', 'pass', 'goto',
  'class', 'struct', 'enum', 'interface', 'namespace', 'template', 'typename',
  'def', 'fn', 'func', 'function', 'lambda', 'end',
  'var', 'let', 'const', 'auto', 'static', 'final', 'mut', 'val',
  'public', 'private', 'protected', 'override', 'virtual', 'abstract',
  'new', 'delete', 'this', 'self', 'super', 'nil', 'null', 'None',
  'true', 'false', 'True', 'False',
  'try', 'catch', 'except', 'finally', 'throw', 'raise', 'with',
  'import', 'from', 'using', 'include', 'package', 'require', 'as',
  'in', 'is', 'not', 'and', 'or', 'async', 'await', 'impl', 'pub', 'match',
  'int', 'long', 'short', 'double', 'float', 'bool', 'boolean', 'char',
  'string', 'str', 'void', 'unsigned', 'size_t', 'vector', 'unordered_map',
  'unordered_set', 'map', 'set', 'pair', 'deque', 'queue', 'stack',
  'List', 'Optional', 'sizeof', 'typedef', 'extern', 'inline',
]);

const TOKEN_RE = new RegExp([
  /\/\*[\s\S]*?\*\//.source,
  /\/\/[^\n]*/.source,
  /#[^\n]*/.source,
  /"(?:\\.|[^"\\])*"/.source,
  /'(?:\\.|[^'\\])*'/.source,
  /`(?:\\.|[^`\\])*`/.source,
  /\b\d[\d_]*(?:\.\d+)?\b/.source,
  /[A-Za-z_]\w*/.source,
].join('|'), 'g');

function highlight(code) {
  let out = '';
  let last = 0;

  for (const m of code.matchAll(TOKEN_RE)) {
    const text = m[0];
    out += escapeHtml(code.slice(last, m.index));
    last = m.index + text.length;

    let cls = '';
    if (text.startsWith('//') || text.startsWith('/*') || text.startsWith('#')) cls = 'com';
    else if (/^["'`]/.test(text)) cls = 'str';
    else if (/^\d/.test(text)) cls = 'num';
    else if (CODE_KEYWORDS.has(text)) cls = 'kw';
    else if (code[last] === '(') cls = 'fn';

    out += cls ? `<span class="t-${cls}">${escapeHtml(text)}</span>` : escapeHtml(text);
  }

  return out + escapeHtml(code.slice(last));
}

let markedReady = false;

function markdownToHtml(source) {
  const md = globalThis.marked;
  if (!md?.parse) return `<pre><code>${escapeHtml(source)}</code></pre>`;

  if (!markedReady) {
    md.use({
      gfm: true,
      breaks: true,
      renderer: {
        code({ text, lang }) {
          const label = (lang || '').split(/\s+/)[0];
          return `<pre${label ? ` data-lang="${escapeHtml(label)}"` : ''}><code>${highlight(text)}</code></pre>`;
        },
        link({ href, title, tokens }) {
          const body = this.parser.parseInline(tokens);
          const t = title ? ` title="${escapeHtml(title)}"` : '';
          return `<a href="${escapeHtml(href)}"${t} target="_blank" rel="noreferrer">${body}</a>`;
        },
        // raw HTML in a note is shown as text, never rendered
        html({ text }) {
          return escapeHtml(text);
        },
      },
    });
    markedReady = true;
  }

  try {
    return md.parse(source);
  } catch {
    return `<p>${escapeHtml(source)}</p>`;
  }
}
