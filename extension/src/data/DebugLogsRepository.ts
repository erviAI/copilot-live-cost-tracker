import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { ISpanRepository, ISpanResponseProvider } from './interfaces.js';
import { isSafeSessionId } from './identifiers.js';
import type { Span } from '../domain/models.js';

/** Prefix Copilot puts on an `agent_response` span id; the rest is the LLM span id. */
const AGENT_MSG_PREFIX = 'agent-msg-';
/** Max characters of assistant text kept per call, to bound the webview payload. */
const MAX_RESPONSE_CHARS = 20000;

/**
 * Reads token data from per-session `main.jsonl` debug logs found under each
 * workspace's `GitHub.copilot-chat/debug-logs/<sessionId>/main.jsonl`.
 *
 * These logs only exist when Copilot's debug logging is enabled, but when
 * available they cover days where `agent-traces.db` has no `chat` spans —
 * the OpenTelemetry tracing feature is newer than the debug log.
 *
 * Numeric totals match `agent-traces.db` exactly **except** cache-write
 * tokens (`gen_ai.usage.cache_creation.input_tokens`), which are not surfaced
 * here and are left unreported so the pricing layer can derive them.
 *
 * Per-file caching (path → {mtime, spans}) avoids re-parsing unchanged logs.
 */
export class DebugLogsRepository implements ISpanRepository, ISpanResponseProvider {
  private readonly workspaceStorageRoot: string;
  /** Cache: full main.jsonl path → { mtimeMs, parsed spans } */
  private readonly cache = new Map<string, { mtimeMs: number; spans: Span[] }>();
  /** Cache: full main.jsonl path → { mtimeMs, spanId → assistant text } */
  private readonly responseCache = new Map<string, { mtimeMs: number; responses: Map<string, string> }>();
  /** Cache of workspace listing (one-time, refreshed if root mtime changes) */
  private wsListCache: { mtimeMs: number; names: string[] } | null = null;

  /** @param userDir Absolute path to VS Code's `User` directory. */
  constructor(userDir: string) {
    this.workspaceStorageRoot = path.join(userDir, 'workspaceStorage');
  }

  async isAvailable(): Promise<boolean> {
    try {
      return fs.existsSync(this.workspaceStorageRoot);
    } catch {
      return false;
    }
  }

  async getSpansForSession(sessionId: string): Promise<Span[]> {
    // sessionId is interpolated into a path below; reject anything unsafe.
    if (!isSafeSessionId(sessionId)) return [];
    const file = this.findSessionLog(sessionId);
    return file ? this.readSpans(file, sessionId, 0) : [];
  }

  async getSpansSince(timestampMs: number): Promise<Span[]> {
    const result: Span[] = [];
    for (const wsName of this.listWorkspaces()) {
      const debugRoot = path.join(
        this.workspaceStorageRoot, wsName, 'GitHub.copilot-chat', 'debug-logs'
      );
      let sessions: string[];
      try {
        sessions = fs.readdirSync(debugRoot, { withFileTypes: true })
          .filter(d => d.isDirectory()).map(d => d.name);
      } catch {
        continue;
      }
      for (const sid of sessions) {
        const file = path.join(debugRoot, sid, 'main.jsonl');
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        if (stat.size === 0) continue;
        // Skip files whose latest mtime is before the cutoff. (Older files
        // can't contain events newer than their mtime.)
        if (stat.mtimeMs < timestampMs) continue;
        const spans = await this.readSpans(file, sid, timestampMs);
        for (const s of spans) result.push(s);
      }
    }
    return result;
  }

  async getRecentSessionSpans(_limit: number): Promise<Map<string, Span[]>> {
    // Recent-session listing is sourced from agent-traces.db; debug logs
    // are only consulted for historical day backfill.
    return new Map();
  }

  async getSpanResponses(sessionId: string): Promise<Map<string, string>> {
    if (!isSafeSessionId(sessionId)) return new Map();
    const file = this.findSessionLog(sessionId);
    if (!file) return new Map();
    try {
      const stat = fs.statSync(file);
      const cached = this.responseCache.get(file);
      if (cached && cached.mtimeMs === stat.mtimeMs) return cached.responses;
      const responses = await parseAgentResponses(file);
      this.responseCache.set(file, { mtimeMs: stat.mtimeMs, responses });
      return responses;
    } catch {
      // Debug logs are an optional enhancement; absence just hides the text.
      return new Map();
    }
  }

  dispose(): void {
    this.cache.clear();
    this.responseCache.clear();
    this.wsListCache = null;
  }

  // --- internals ---------------------------------------------------------

  /** Locate a session's main.jsonl; sessions live under one unknown workspace. */
  private findSessionLog(sessionId: string): string | null {
    for (const wsName of this.listWorkspaces()) {
      const file = path.join(
        this.workspaceStorageRoot, wsName, 'GitHub.copilot-chat', 'debug-logs', sessionId, 'main.jsonl'
      );
      if (fs.existsSync(file)) return file;
    }
    return null;
  }

  private listWorkspaces(): string[] {
    try {
      const stat = fs.statSync(this.workspaceStorageRoot);
      if (this.wsListCache && this.wsListCache.mtimeMs === stat.mtimeMs) {
        return this.wsListCache.names;
      }
      const names = fs.readdirSync(this.workspaceStorageRoot, { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => d.name);
      this.wsListCache = { mtimeMs: stat.mtimeMs, names };
      return names;
    } catch {
      return [];
    }
  }

  private async readSpans(file: string, sessionId: string, sinceMs: number): Promise<Span[]> {
    const stat = fs.statSync(file);
    const cached = this.cache.get(file);
    let spans: Span[];
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      spans = cached.spans;
    } else {
      spans = await parseMainJsonl(file, sessionId);
      this.cache.set(file, { mtimeMs: stat.mtimeMs, spans });
    }
    return sinceMs > 0 ? spans.filter(s => s.startTimeMs >= sinceMs) : spans;
  }
}

/**
 * Parse a main.jsonl file into Span objects. Only `llm_request` events with
 * non-zero token counts become spans.
 */
async function parseMainJsonl(file: string, sessionId: string): Promise<Span[]> {
  const spans: Span[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let idx = 0;
  for await (const line of rl) {
    if (!line) continue;
    let ev: DebugLogEvent;
    try { ev = JSON.parse(line) as DebugLogEvent; } catch { continue; }
    if (ev?.type !== 'llm_request') continue;
    const attrs = ev.attrs ?? {};
    const inputTokens = numberOrZero(attrs.inputTokens);
    const outputTokens = numberOrZero(attrs.outputTokens);
    const cachedTokens = numberOrZero(attrs.cachedTokens);
    if (inputTokens === 0 && outputTokens === 0 && cachedTokens === 0) continue;
    const ts = typeof ev.ts === 'number' ? ev.ts : null;
    if (ts === null) continue;
    const dur = typeof ev.dur === 'number' ? ev.dur : 0;
    const model: string | null = typeof attrs.model === 'string' ? attrs.model : null;
    const ttft = typeof attrs.ttft === 'number' ? attrs.ttft : null;
    spans.push({
      spanId: `dbg-${sessionId}-${idx++}`,
      traceId: `dbg-${sessionId}`,
      parentSpanId: null,
      operationName: 'chat',
      agentName: 'GitHub Copilot Chat',
      requestModel: model,
      responseModel: model,
      inputTokens,
      outputTokens,
      cachedTokens,
      cacheWriteTokens: null, // not present in debug logs; derived from pricing
      reasoningTokens: 0,
      startTimeMs: ts,
      endTimeMs: ts + dur,
      ttftMs: ttft,
      chatSessionId: sessionId,
      conversationId: sessionId,
      turnIndex: null,
      statusCode: 1,
      statusMessage: null,
      toolName: null,
      maxPromptTokens: null, // not present in debug logs
    });
  }
  return spans;
}

interface DebugLogEvent {
  type?: string;
  ts?: unknown;
  dur?: unknown;
  attrs?: {
    inputTokens?: unknown;
    outputTokens?: unknown;
    cachedTokens?: unknown;
    model?: unknown;
    ttft?: unknown;
  };
}

/**
 * Extract the assistant text each model call produced, keyed by the LLM span id
 * (which matches `spans.span_id` in agent-traces.db).
 *
 * Copilot writes one `agent_response` event per call whose `spanId` is the
 * producing call's span id prefixed with `agent-msg-`.
 */
async function parseAgentResponses(file: string): Promise<Map<string, string>> {
  const responses = new Map<string, string>();
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    // Lines embedding a full request payload run to hundreds of KB, so screen
    // them out with a substring test before paying for JSON.parse. The marker
    // can also occur inside such a payload, hence the type re-check below.
    if (!line || !line.includes('"type":"agent_response"')) continue;
    let ev: { type?: string; spanId?: unknown; attrs?: { response?: unknown } };
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.type !== 'agent_response') continue;
    const spanId = typeof ev.spanId === 'string' && ev.spanId.startsWith(AGENT_MSG_PREFIX)
      ? ev.spanId.slice(AGENT_MSG_PREFIX.length)
      : null;
    if (!spanId) continue;
    const text = extractAssistantText(ev.attrs?.response);
    if (!text) continue;
    // A call can emit several messages; keep them all in order.
    const prev = responses.get(spanId);
    responses.set(spanId, prev ? cap(prev + '\n\n' + text) : cap(text));
  }
  return responses;
}

/** `attrs.response` is a JSON-encoded array of assistant messages with typed parts. */
function extractAssistantText(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  let messages: unknown;
  try { messages = JSON.parse(raw); } catch { return ''; }
  if (!Array.isArray(messages)) return '';
  const chunks: string[] = [];
  for (const msg of messages) {
    const parts = (msg as { parts?: unknown })?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const p = part as { type?: unknown; content?: unknown };
      if (p?.type === 'text' && typeof p.content === 'string' && p.content.length > 0) {
        chunks.push(p.content);
      }
    }
  }
  return chunks.join('\n\n').trim();
}

function cap(text: string): string {
  return text.length > MAX_RESPONSE_CHARS ? text.slice(0, MAX_RESPONSE_CHARS) + '…' : text;
}

function numberOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
