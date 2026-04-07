import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { AgentAvatar } from '../common/AgentAvatar';

const markdownComponents = {
  a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
  ),
  table: ({ children, ...props }: React.TableHTMLAttributes<HTMLTableElement>) => (
    <div className="max-h-60 overflow-auto">
      <table {...props}>{children}</table>
    </div>
  ),
};

export function StreamingText({ content, agent, sessionId }: { content: string; agent?: string; sessionId?: string }) {
  return (
    <div className="flex gap-2">
      <div className="mt-0.5 shrink-0">
        <AgentAvatar agent={agent ?? ''} sessionId={sessionId} size="sm" />
      </div>
      <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-ocean-500/5 px-4 py-2.5 shadow-sm sm:max-w-[70%]">
        <div className="markdown-content streaming-cursor text-sm leading-relaxed text-text-primary">
          <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>{content}</Markdown>
        </div>
      </div>
    </div>
  );
}
