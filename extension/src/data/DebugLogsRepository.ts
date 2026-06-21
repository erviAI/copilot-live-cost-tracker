import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { ISpanRepository } from './interfaces.js';
import { isSafeSessionId } from './identifiers.js';
import type { Span } from '../domain/models.js';

/**
 * Reads token data from per-session `main.jsonl` debug logs found under each
 * workspace's `GitHub.copilot-chat/debug-logs/<sessionId>/main.jsonl`.
 *
 * These logs only exist when Copilot's debug logging is enabled, but when
 * available they cover days where `agent-traces.db` has no `chat` spans —
 * the OpenTelemetry tracing feature is newer than the debug log.
 *
 * Numeric totals match `agent-traces.db` exactly **except** cache-write
 * tokens (`gen_ai.usage.cache_creation.input_tokens`) are not surfaced here.
 *
 * Per-file caching (path → {mtime, spans}) avoids re-parsing unchanged logs.
 */
export class DebugLogsRepository implements ISpanRepository {
  private readonly workspaceStorageRoot: string;
  /** Cache: full main.jsonl path → { mtimeMs, parsed spans } */
  private readonly cache = new Map<string, { mtimeMs: number; spans: Span[] }>();
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
    // Find the matching main.jsonl across workspaces. Sessions live under a
    // single workspace, but we don't know which — scan all.
    for (const wsName of this.listWorkspaces()) {
      const file = path.join(
        this.workspaceStorageRoot, wsName, 'GitHub.copilot-chat', 'debug-logs', sessionId, 'main.jsonl'
      );
      if (fs.existsSync(file)) {
        return this.readSpans(file, sessionId, 0);
      }
    }
    return [];
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

  dispose(): void {
    this.cache.clear();
    this.wsListCache = null;
  }

  // --- internals ---------------------------------------------------------

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
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
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
      cacheWriteTokens: 0, // not present in debug logs
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
    });
  }
  return spans;
}

function numberOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
