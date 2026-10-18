/** Real panel, attachment lifecycle and hash/size-verified chunk cache. No app/transport bootstrap. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ContentRef } from '@kraki/protocol';
import { HtmlArtifactPanel } from '../../src/components/chat/HtmlArtifactPanel';
import { ingestChunk, markAwaitingPush } from '../../src/lib/attachments';
import { withMermaidRuntime } from '../../src/lib/report-mermaid';
import '../../src/components/chat/chat.css';
import './scenario.css';

const root = createRoot(document.getElementById('root')!);
function Scenario({ artifact }: { artifact: ContentRef }) {
  const [expanded, setExpanded] = useState(false);
  return <HtmlArtifactPanel artifact={artifact} sessionId="report-panel-fixture" onClose={() => root.render(null)}
    expanded={expanded} onToggleExpanded={() => setExpanded((value) => !value)} />;
}
// Unchanged pre-integration export API: reference bytes only, never rendered/executed.
Object.assign(window, { referenceExport: withMermaidRuntime, mountReport: async (html: string) => {
  const bytes = new TextEncoder().encode(html);
  const id = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  const ref: ContentRef = { type: 'content_ref', id, mimeType: 'text/html', size: bytes.length, name: 'fixture.html', caption: 'Fixture report' };
  markAwaitingPush(ref, () => { throw new Error('Unexpected fixture attachment pull'); });
  const encoded = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
  if (await ingestChunk(id, 0, 1, ref.mimeType, encoded) !== 'accepted') throw new Error('Fixture rejected');
  root.render(<Scenario key={id} artifact={ref} />);
  return { id, bytes: bytes.length };
} });
