#!/usr/bin/env node
/**
 * Backfill `trace.jsonl` for a pre-card-model session from its `messages.jsonl`.
 *
 * WHY: The card/Steps refactor moved a turn's tool/narration steps off the
 * message spine into a per-session `trace.jsonl` (pulled lazily per turn via
 * `request_turn_trace`). Sessions created before that have their `tool_start`/
 * `tool_complete` steps in `messages.jsonl` but no `trace.jsonl`, so the new
 * "Steps" affordance renders empty for their historical turns.
 *
 * This script reconstructs `trace.jsonl` losslessly: every `messages.jsonl`
 * line whose type the Steps modal renders (tool_start / tool_complete /
 * agent_narration) is re-emitted as a trace line
 *   { turnStartSeq, type, payload, ts }
 * tagged with `turnStartSeq` = spine seq of the most recent `user_message`
 * (i.e. the turn that step belongs to) — exactly how SessionManager.appendTrace
 * tags live steps and how readTurnTrace slices them back per turn.
 *
 * It ALSO stamps `payload.steps` (a running count of the turn's tool_start +
 * agent_narration steps) onto each concluding bubble (agent_message /
 * system_message) in `messages.jsonl`, mirroring the tentacle's live counter.
 * That hint lets a concluded bubble show its "Steps" affordance from replay
 * alone — before (and without needing) the transient trace to be pulled into
 * the client store. The original messages.jsonl is backed up first (.bak-*).
 * Pass `--no-spine` to skip this and only backfill trace.jsonl.
 *
 * The trace `payload` field is the SAME stringified wire message already stored
 * on the spine line, copied verbatim — so a migrated entry is byte-identical to
 * what a live broadcast would have mirrored.
 *
 * It ALSO normalizes `meta.state` (ended/active → disconnected) so the imported
 * session is RESUMABLE — the tentacle only lazily resumes a 'disconnected'
 * session, and leaves 'ended' ones view-only. The agent's own transcript store
 * (e.g. claude-home/projects/<sdkSessionId>.jsonl) is untouched, so resuming
 * continues the original conversation with full memory. Pass `--keep-state` to
 * skip this (leave the session view-only).
 *
 * Usage:
 *   node scripts/backfill-trace.mjs <sessionDir> [--force] [--dry-run] [--no-spine] [--keep-state]
 *
 * Idempotent: refuses to overwrite an existing trace.jsonl unless --force
 * (in which case it backs the old one up first). Safe to re-run.
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// The only entry types the Steps modal renders (StepsModal.tsx `isTrace`).
const TRACE_TYPES = new Set(['tool_start', 'tool_complete', 'agent_narration']);
// The concluding/persistent bubbles that anchor a turn's Steps affordance and
// carry the replay-visible `payload.steps` hint (protocol AgentMessage /
// SystemMessage).
const BUBBLE_TYPES = new Set(['agent_message', 'system_message']);

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const sessionDir = args.find((a) => !a.startsWith('--'));
  const force = flags.has('--force');
  const dryRun = flags.has('--dry-run');
  const noSpine = flags.has('--no-spine'); // skip the messages.jsonl steps rewrite
  const keepState = flags.has('--keep-state'); // don't normalize meta.state

  if (!sessionDir) {
    console.error('usage: node scripts/backfill-trace.mjs <sessionDir> [--force] [--dry-run] [--no-spine] [--keep-state]');
    process.exit(2);
  }

  const msgPath = join(sessionDir, 'messages.jsonl');
  const tracePath = join(sessionDir, 'trace.jsonl');

  if (!existsSync(msgPath)) {
    console.error(`no messages.jsonl in ${sessionDir}`);
    process.exit(1);
  }
  if (existsSync(tracePath) && !force && !dryRun) {
    console.error(`trace.jsonl already exists in ${sessionDir} — pass --force to overwrite (a .bak is kept)`);
    process.exit(1);
  }

  const raw = readFileSync(msgPath, 'utf8');
  const lines = raw.split('\n');

  let currentTurnStartSeq = 0;
  // Running count of the current turn's chip-producing steps (tool_start +
  // agent_narration), reset on each user_message — mirrors the tentacle's live
  // `turnStepCounts` so a migrated bubble's `payload.steps` equals what a live
  // run would have stamped. tool_complete merges into its start, so it is NOT
  // counted (matches StepsList's tool_start↔tool_complete pairing).
  let stepCount = 0;
  const traceLines = [];
  const spineOut = []; // rewritten messages.jsonl lines (verbatim except bubbles)
  const stats = {
    total: 0, user_message: 0, tool_start: 0, tool_complete: 0, agent_narration: 0,
    malformed: 0, orphanNoTurn: 0, stamped: 0, stampSkipped: 0,
  };

  for (const line of lines) {
    if (!line.trim()) { spineOut.push(line); continue; } // preserve blanks / trailing newline
    stats.total++;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      stats.malformed++;
      spineOut.push(line); // keep unparseable lines untouched
      continue;
    }
    const type = entry.type;

    if (type === 'user_message') {
      // A user_message begins a new turn; its spine seq is the turnStartSeq
      // that mid-turn steps get tagged with (matches readTurnTrace's
      // "greatest user_message seq <= bubbleSeq" resolution) and resets the
      // per-turn step counter.
      currentTurnStartSeq = entry.seq ?? currentTurnStartSeq;
      stepCount = 0;
      stats.user_message++;
      spineOut.push(line);
      continue;
    }

    if (type === 'tool_start' || type === 'agent_narration') stepCount++;

    if (TRACE_TYPES.has(type)) {
      stats[type]++;
      if (currentTurnStartSeq === 0) stats.orphanNoTurn++;
      traceLines.push(JSON.stringify({
        turnStartSeq: currentTurnStartSeq,
        type,
        payload: entry.payload, // verbatim stringified wire message from the spine
        ts: entry.ts ?? new Date().toISOString(),
      }));
      spineOut.push(line); // trace entries stay on the OLD spine untouched
      continue;
    }

    if (!noSpine && BUBBLE_TYPES.has(type) && typeof entry.payload === 'string') {
      // Stamp the running step count into the bubble's inner wire payload so a
      // concluded bubble can show its Steps affordance from replay alone.
      try {
        const enriched = JSON.parse(entry.payload);
        if (enriched && typeof enriched.payload === 'object' && enriched.payload) {
          enriched.payload.steps = stepCount;
          entry.payload = JSON.stringify(enriched);
          spineOut.push(JSON.stringify(entry));
          stats.stamped++;
          continue;
        }
      } catch {
        // fall through: leave the bubble line untouched
      }
      stats.stampSkipped++;
    }

    spineOut.push(line);
  }

  console.log(`scanned ${stats.total} spine lines from ${msgPath}`);
  console.log(`  user_message (turn boundaries): ${stats.user_message}`);
  console.log(`  tool_start: ${stats.tool_start}  tool_complete: ${stats.tool_complete}  agent_narration: ${stats.agent_narration}`);
  console.log(`  -> ${traceLines.length} trace lines`);
  if (!noSpine) console.log(`  stamped payload.steps on ${stats.stamped} bubbles (agent_message/system_message)${stats.stampSkipped ? `, skipped ${stats.stampSkipped}` : ''}`);
  if (stats.malformed) console.log(`  WARN: skipped ${stats.malformed} malformed spine lines`);
  if (stats.orphanNoTurn) console.log(`  NOTE: ${stats.orphanNoTurn} steps had no preceding user_message (tagged turnStartSeq=0)`);

  if (dryRun) {
    console.log('dry-run: not writing trace.jsonl / messages.jsonl');
    return;
  }

  if (existsSync(tracePath) && force) {
    const bak = `${tracePath}.bak-${new Date().toISOString().replace(/[:.]/g, '')}`;
    renameSync(tracePath, bak);
    console.log(`backed up existing trace.jsonl -> ${bak}`);
  }
  writeFileSync(tracePath, traceLines.length ? traceLines.join('\n') + '\n' : '', 'utf8');
  console.log(`wrote ${tracePath}`);

  if (!noSpine && stats.stamped > 0) {
    const bak = `${msgPath}.bak-${new Date().toISOString().replace(/[:.]/g, '')}`;
    writeFileSync(bak, raw, 'utf8');
    writeFileSync(msgPath, spineOut.join('\n'), 'utf8');
    console.log(`rewrote ${msgPath} with steps hints (backup -> ${bak})`);
  }

  // Make the session RESUMABLE. The tentacle only lazily resumes a session when
  // its meta.state === 'disconnected' (ensureSessionResumed), and only lists
  // active/idle/disconnected as resumable (getResumableSessions). On a normal
  // daemon restart the tentacle auto-flips active/idle → disconnected, but an
  // 'ended' session stays non-resumable by design. An imported/old session that
  // was 'ended' would therefore replay fine but reject new messages ("Session
  // not found"). Normalize it to 'disconnected' so it comes alive on the first
  // message (its agent transcript — e.g. claude-home/projects — is untouched).
  const metaPath = join(sessionDir, 'meta.json');
  if (!keepState && existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (meta.state === 'ended' || meta.state === 'active') {
        const from = meta.state;
        meta.state = 'disconnected';
        writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
        console.log(`normalized meta.state ${from} -> disconnected (session now resumable)`);
      } else {
        console.log(`meta.state '${meta.state}' already resumable — left unchanged`);
      }
    } catch (err) {
      console.warn(`could not normalize meta.state: ${err.message}`);
    }
  }
}

main();
