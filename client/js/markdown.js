// A small, safe Markdown renderer for handouts. Pure (no DOM), so tests can import it.
// Everything is HTML-escaped first and Markdown is applied to the escaped text, so raw HTML in a
// handout is shown as text, never run. Links must be http(s); images must be /static/... paths.
//
// Supported: # headings (1–4), **bold**, *italic* / _italic_, `code`, - / * / 1. lists,
// > quotes, --- rules, [links](https://…), ![images](/static/…), paragraphs and line breaks.

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// URLs arrive already escaped; reject anything that isn't an allowed shape.
const safeLink = (url) => (/^https?:\/\/[^\s]+$/i.test(url) ? url : null);
const safeImage = (url) => (/^\/static\/[A-Za-z0-9_./-]+$/.test(url) && !url.includes('..') ? url : null);

function inline(text) {
  // Code spans and generated tags are set aside so emphasis never touches them (or their URLs).
  const kept = [];
  const keep = (html) => `\u0000${kept.push(html) - 1}\u0000`;
  let s = text.replace(/`([^`]+)`/g, (_, c) => keep(`<code>${c}</code>`));
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
    const src = safeImage(url);
    return src ? keep(`<img src="${src}" alt="${alt}" loading="lazy">`) : alt;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const href = safeLink(url);
    return href ? `${keep(`<a href="${href}" target="_blank" rel="noopener noreferrer">`)}${label}${keep('</a>')}` : label;
  });
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?!\s)(.+?)_(?!\w)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]);
}

export function renderMarkdown(src) {
  const lines = escapeHtml(String(src ?? '')).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // { tag: 'ul'|'ol', items: [] }
  let quote = [];
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; };
  const flushQuote = () => { if (quote.length) out.push(`<blockquote>${renderMarkdown(quote.join('\n').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'))}</blockquote>`); quote = []; };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (const line of lines) {
    const quoted = line.match(/^&gt;\s?(.*)$/);
    if (quoted) { flushPara(); flushList(); quote.push(quoted[1]); continue; }
    flushQuote();
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) { flushAll(); out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push((bullet ?? numbered)[1]);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushAll();
  return out.join('\n');
}
