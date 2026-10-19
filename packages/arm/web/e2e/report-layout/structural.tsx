/** Actual component + actual CSS; manually assembled App/SessionPage structure, NOT App/Router bootstrap. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ContentRef } from '@kraki/protocol';
import { HtmlArtifactPanel } from '../../src/components/chat/HtmlArtifactPanel';
import { ingestChunk, markAwaitingPush } from '../../src/lib/attachments';
import '../../src/index.css';
import '../../src/components/layout/sidebar.css';
import '../../src/components/chat/chat.css';

const root = createRoot(document.getElementById('root')!);
function StructuralReport({ artifact }: { artifact: ContentRef }) {
  const [expanded, setExpanded] = useState(false);
  // App.tsx wide sidebar/main and SessionPage.tsx report-owning wrappers.
  // Sidebar/chat contents intentionally inert; no store/router/network bootstrap.
  return <div className="app-viewport flex overflow-hidden bg-surface-primary">
    <aside data-layout-sidebar className="flex w-[280px] shrink-0 flex-col">Inert sidebar</aside>
    <main className="relative min-w-0 flex-1 flex-col overflow-hidden app-main-wide flex">
      <div className="kchat-page">
        <div className="kmedia-pane relative flex min-h-0 flex-1">
          <div className="relative flex min-w-0 flex-1"><div className="kchat">Inert conversation</div></div>
          <HtmlArtifactPanel artifact={artifact} sessionId="report-layout-structural" expanded={expanded}
            onToggleExpanded={() => setExpanded(value => !value)} onClose={() => root.render(null)} />
        </div>
      </div>
    </main>
  </div>;
}
Object.assign(window, { mountReport: async (html: string) => {
  const bytes = new TextEncoder().encode(html);
  const id = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  const ref: ContentRef = { type: 'content_ref', id, mimeType: 'text/html', size: bytes.length, name: 'layout.html', caption: 'Layout report' };
  markAwaitingPush(ref, () => { throw new Error('Unexpected layout attachment pull'); });
  const encoded = btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
  if (await ingestChunk(id, 0, 1, ref.mimeType, encoded) !== 'accepted') throw new Error('Layout fixture rejected');
  root.render(<StructuralReport key={id} artifact={ref} />);
  return { id, bytes: bytes.length };
} });
