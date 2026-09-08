import { explainPositions } from './explain-selection';
import { memo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { markdownWebUrl } from '../shared/markdown-link';

const plugins = [remarkGfm];
const positionPlugins = [explainPositions];
const components: Components = {
  a: ({ href, children, title }) => href
    ? <a href={href} target="_blank" rel="noopener noreferrer" title={title ?? `${href} — Open in browser`}>{children}</a>
    : <span>{children}</span>,
  img: ({ alt }) => <span className="markdown-image">{alt ? `[Image: ${alt}]` : '[Image]'}</span>,
  table: ({ children }) => <div className="markdown-table" role="region" aria-label="Table" tabIndex={0}><table>{children}</table></div>,
  pre: ({ children }) => <pre tabIndex={0} aria-label="Code block">{children}</pre>
};

export const AssistantMarkdown = memo(function AssistantMarkdown({ content, withSource = false }: { content: string; withSource?: boolean }) {
  return <div className="assistant-markdown"><Markdown remarkPlugins={plugins} rehypePlugins={withSource ? positionPlugins : undefined} components={components}
    urlTransform={(url, key) => key === 'href' ? markdownWebUrl(url) : ''}>{content}</Markdown></div>;
});
