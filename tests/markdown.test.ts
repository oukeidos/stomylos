import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { AssistantMarkdown } from '../src/renderer/markdown';
import { markdownWebUrl } from '../src/shared/markdown-link';

const render = (content: string) => renderToStaticMarkup(createElement(AssistantMarkdown, { content }));
const fixture = readFileSync(new URL('./fixtures/assistant-markdown.md', import.meta.url), 'utf8');

it('renders conversation formatting while keeping code text literal', () => {
  const html = render(fixture);
  for (const tag of ['h2', 'strong', 'em', 'del', 'ul', 'ol', 'blockquote', 'code', 'table', 'thead', 'tbody']) expect(html).toContain(`<${tag}`);
  expect(html).toContain('<strong>one quiet moment</strong>');
  expect(html).toContain('<code>one_small_step()</code>');
  expect(html).toContain('tabindex="0"');
  expect(html).toContain('Keep this line break.');
  expect(render('```html\n<img src="secret" onerror="alert(1)">\n```')).toContain('&lt;img');
});

it('keeps raw HTML inert, replaces images with alt text and rejects non-web links', () => {
  const html = render(fixture + '\n\n<iframe src="https://example.com"></iframe>\n\n<img src="x" onerror="alert(1)">');
  for (const tag of ['script', 'iframe', 'img']) expect(html).not.toContain(`<${tag}`);
  expect(html).toContain('[Image: Quiet tree]');
  expect(html).not.toContain('image-must-not-load.png');
  expect(html).toContain('target="_blank" rel="noopener noreferrer"');
  expect(html).toContain('<span>Unsafe script</span>');
  expect(html).toContain('<span>Local file</span>');
  expect(html).toContain('<span>App resource</span>');
  expect(html).toContain('<span>Relative path</span>');
});

it('renders incomplete streaming prefixes without throwing or exposing active HTML', () => {
  for (let length = 0; length <= fixture.length; length += 23) {
    const html = render(fixture.slice(0, length));
    expect(html).not.toMatch(/<(script|iframe|img)\b/);
  }
  expect(render('Before **unfinished')).toContain('unfinished');
  expect(render('```js\nconst value = 1;')).toContain('const value = 1;');
});

it('only accepts absolute HTTP(S) links at both rendering and browser boundaries', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/a', 'stomylos://app/',
    'mailto:test@example.com', '//example.com', '/relative', '#anchor', 'https://',
    'https://user:password@example.com/', 'https://example.com/\nfile', ' https://example.com/', 'https://example.com/\u0000']) {
    expect(markdownWebUrl(value), value).toBe('');
  }
  expect(markdownWebUrl('https://example.com/path?q=a%20b#section')).toBe('https://example.com/path?q=a%20b#section');
  expect(markdownWebUrl('http://example.com')).toBe('http://example.com/');
});


it('adds source positions without changing rendered meaning, valid tables or inert HTML', () => {
  const html = renderToStaticMarkup(createElement(AssistantMarkdown, { content: fixture, withSource: true }));
  expect(html.replace(/<span data-source-start="\d+" data-source-end="\d+">([\s\S]*?)<\/span>/g, '$1')).toBe(render(fixture));
  expect(html).not.toMatch(/<(?:table|tr|thead|tbody|ul|ol)><span/);
  expect(html).toContain('data-source-start="24" data-source-end="40"');
});
