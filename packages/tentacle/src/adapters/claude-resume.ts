import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface ResumeMeta { sdkSessionId?: string; forkFrom?: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SDK resume IDs are not Kraki session IDs. A new session is persisted before
 * its deferred SDK query starts, so a restart can legitimately find no SDK ID.
 * Recover an init whose sidecar write was lost from this session's own scoped
 * transcripts; never guess between histories or silently discard one.
 */
export function claudeResumeTarget(sessionId: string, meta: ResumeMeta | null, claudeHome: string): string | undefined {
  if (meta?.sdkSessionId) return meta.sdkSessionId;
  if (meta?.forkFrom) return meta.forkFrom;
  const projects = join(claudeHome, 'projects');
  const candidates = new Set<string>();
  if (existsSync(projects)) {
    for (const project of readdirSync(projects, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      // Only top-level primary transcripts, not subagent logs or other homes.
      for (const file of readdirSync(join(projects, project.name), { withFileTypes: true })) {
        if (file.isFile() && file.name.endsWith('.jsonl') && uuid.test(file.name.slice(0, -6))
          && statSync(join(projects, project.name, file.name)).size > 0) {
          candidates.add(file.name.slice(0, -6));
        }
      }
    }
  }
  if (candidates.has(sessionId)) return sessionId;
  if (candidates.size === 1) return [...candidates][0];
  if (candidates.size > 1) throw new Error('Cannot resume Claude session: multiple transcripts exist but its SDK session ID is missing.');
  // Pre-co-location imported sessions used the SDK UUID as their Kraki ID.
  if (uuid.test(sessionId)) return sessionId;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) return undefined; // Created but never initialized.
  throw new Error('Cannot resume Claude session: its saved metadata is missing. Restore the session metadata or start a new session.');
}
