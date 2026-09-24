import { parse, Allow } from 'partial-json';

type ToolCall = { id?: string; name?: string; arguments?: { text?: unknown } };
export interface AssistantStreamEvent {
  type: string;
  delta?: string;
  contentIndex?: number;
  id?: string;
  toolName?: string;
  toolCall?: ToolCall;
  // Older Pi RPC versions used the SDK's cumulative snapshots.
  partial?: { content?: Array<ToolCall & { type?: string }> };
}

/** Reconstruct only finalize_reply arguments, not every tool's potentially
 * large input. State is per assistant message, indexed by content block. */
export class PiFinalizeStream {
  private calls = new Map<number, { id: string; json: string }>();

  clear(): void { this.calls.clear(); }

  update(event: AssistantStreamEvent): { id: string; text: string } | undefined {
    const index = event.contentIndex;
    if (index === undefined) return;
    const snapshot = event.partial?.content?.[index];
    if (snapshot?.name === 'finalize_reply' && snapshot.id) {
      return this.text(snapshot.id, snapshot.arguments?.text);
    }
    if (event.type === 'toolcall_start') {
      this.calls.delete(index);
      if (event.toolName === 'finalize_reply' && event.id) {
        this.calls.set(index, { id: event.id, json: '' });
      }
      return;
    }
    if (event.type === 'toolcall_end') {
      this.calls.delete(index);
      const call = event.toolCall;
      if (call?.name === 'finalize_reply' && call.id) return this.text(call.id, call.arguments?.text);
      return;
    }
    const call = this.calls.get(index);
    if (event.type !== 'toolcall_delta' || !call || typeof event.delta !== 'string') return;
    call.json += event.delta;
    try {
      const args = parse(call.json, Allow.OBJ | Allow.STR) as { text?: unknown } | null;
      return this.text(call.id, args?.text);
    } catch {
      // A split escape/key may not be parseable yet. The authoritative end
      // record still reconciles the completed tool call.
      return;
    }
  }

  private text(id: string, value: unknown): { id: string; text: string } | undefined {
    if (typeof value !== 'string') return;
    // A split \uD83D\uDE00 must not emit an unpaired high surrogate to the UI.
    const text = /[\uD800-\uDBFF]$/.test(value) ? value.slice(0, -1) : value;
    return { id, text };
  }
}
