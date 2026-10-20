import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../client/js/markdown.js';

test('raw HTML is shown as text, never rendered', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n<img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;script&gt;/);
});

test('only http(s) links and /static images are allowed', () => {
  assert.equal(renderMarkdown('[x](javascript:alert(1))').includes('<a'), false);
  assert.equal(renderMarkdown('[x](data:text/html,hi)').includes('<a'), false);
  assert.equal(renderMarkdown('![x](https://evil.example/a.png)').includes('<img'), false);
  assert.equal(renderMarkdown('![x](/static/../server/x.png)').includes('<img'), false);
  assert.equal(renderMarkdown('[a "quote"](https://x.y)'), '<p><a href="https://x.y" target="_blank" rel="noopener noreferrer">a &quot;quote&quot;</a></p>');
  assert.equal(renderMarkdown('![map](/static/handouts/map.webp)'), '<p><img src="/static/handouts/map.webp" alt="map" loading="lazy"></p>');
});

test('renders the supported syntax', () => {
  assert.equal(renderMarkdown('# Title'), '<h1>Title</h1>');
  assert.equal(renderMarkdown('**b** *i* _i_ `c*d*`'), '<p><strong>b</strong> <em>i</em> <em>i</em> <code>c*d*</code></p>');
  assert.equal(renderMarkdown('- a\n- b\n\n1. one'), '<ul><li>a</li><li>b</li></ul>\n<ol><li>one</li></ol>');
  assert.equal(renderMarkdown('> said **so**'), '<blockquote><p>said <strong>so</strong></p></blockquote>');
  assert.equal(renderMarkdown('line one\nline two\n\n---'), '<p>line one<br>line two</p>\n<hr>');
  assert.equal(renderMarkdown('snake_case_name and 2*3*4'), '<p>snake_case_name and 2*3*4</p>');
  assert.equal(renderMarkdown('[the _map_](https://x.y/_a_)'), '<p><a href="https://x.y/_a_" target="_blank" rel="noopener noreferrer">the <em>map</em></a></p>');
  assert.equal(renderMarkdown(''), '');
});
