import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// No raw HTML (react-markdown drops it) and the default urlTransform drops javascript: links; links open in a new tab.
const plugins = [remarkGfm];
const components = { a: ({ node: _n, ...p }: any) => <a {...p} target="_blank" rel="noreferrer noopener" /> };

export const Md = memo(function Md({ text }: { text: string }) {
  return <div className="md"><Markdown remarkPlugins={plugins} components={components}>{text}</Markdown></div>;
});
