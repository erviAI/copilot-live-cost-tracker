import * as fs from 'fs';
import * as path from 'path';
import type { ISessionTitleResolver, ITurnTextProvider } from './interfaces.js';
import type { TurnText } from '../domain/models.js';
import { openDatabase, type Database } from './sqlite.js';

/** Max characters retained per turn text field to bound the webview payload. */
const MAX_TURN_TEXT_CHARS = 20000;

/**
 * Resolves session display titles from VS Code's state.vscdb files.
 * Scans ALL workspace storage folders to find titles for sessions
 * that may have been started in any workspace.
 * Non-fatal: returns empty titles if databases are unavailable.
 */
export class StateRepository implements ISessionTitleResolver, ITurnTextProvider {
  private cache: Map<string, string> | null = null;
  private workspaceCache: Map<string, string> | null = null;
  private readonly workspaceStorageRoot: string | null;
  private readonly sessionStoreDbPath: string | null;

  /**
   * @param workspaceStorageRoot Absolute path to `User/workspaceStorage`.
   * @param userDir Absolute path to VS Code's `User` directory (used to locate
   *   `session-store.db`). Resolved rather than assuming the `Code` product folder.
   */
  constructor(workspaceStorageRoot: string | null, userDir: string | null) {
    this.workspaceStorageRoot = workspaceStorageRoot;
    this.sessionStoreDbPath = userDir
      ? path.join(userDir, 'globalStorage', 'github.copilot-chat', 'session-store.db')
      : null;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.workspaceStorageRoot) return false;
    return fs.existsSync(this.workspaceStorageRoot);
  }

  async getTitle(sessionId: string): Promise<string | null> {
    const titles = await this.getAllTitles();
    return titles.get(sessionId) ?? null;
  }

  async getAllTitles(): Promise<Map<string, string>> {
    if (this.cache) {
      return this.cache;
    }

    const titles = new Map<string, string>();
    const workspaces = new Map<string, string>();

    if (!this.workspaceStorageRoot || !fs.existsSync(this.workspaceStorageRoot)) {
      return titles;
    }

    // Scan all workspace storage folders for state.vscdb
    let dirs: string[];
    try {
      dirs = fs.readdirSync(this.workspaceStorageRoot);
    } catch {
      return titles;
    }

    for (const wsDir of dirs) {
      const stateDbPath = path.join(this.workspaceStorageRoot, wsDir, 'state.vscdb');
      if (!fs.existsSync(stateDbPath)) continue;

      let db: Database | null = null;
      try {
        db = await openDatabase(stateDbPath);
        const row = await db.get<{ value: string }>(
          `SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'`,
          []
        );

        if (!row?.value) {
          db.close();
          continue;
        }

        const parsed = JSON.parse(row.value) as {
          entries?: Record<string, { title?: string; isEmpty?: boolean }>;
        };
        if (parsed.entries) {
          // Resolve workspace name for this folder (once per folder)
          const wsName = resolveWorkspaceName(this.workspaceStorageRoot, wsDir);

          for (const [id, entry] of Object.entries(parsed.entries)) {
            if (entry.title && entry.title !== 'New Chat' && !entry.isEmpty) {
              titles.set(id, entry.title);
            }
            // Map every session in this workspace (whether titled or not)
            if (wsName) {
              workspaces.set(id, wsName);
            }
          }
        }
      } catch {
        // Skip inaccessible or malformed databases
      } finally {
        db?.close();
      }
    }

    await this.addSessionStoreFallbackTitles(titles);
    this.addDebugLogFallbackTitles(titles);

    this.cache = titles;
    this.workspaceCache = workspaces;
    return titles;
  }

  async getAllWorkspaces(): Promise<Map<string, string>> {
    if (this.workspaceCache) {
      return this.workspaceCache;
    }
    // Trigger the scan which populates both caches
    await this.getAllTitles();
    return this.workspaceCache ?? new Map();
  }

  private async addSessionStoreFallbackTitles(titles: Map<string, string>): Promise<void> {
    if (!this.sessionStoreDbPath || !fs.existsSync(this.sessionStoreDbPath)) {
      return;
    }

    let db: Database | null = null;
    try {
      db = await openDatabase(this.sessionStoreDbPath);

      const summaries = await db.all<{ id: string; summary: string | null }>(
        `SELECT id, summary FROM sessions WHERE summary IS NOT NULL AND TRIM(summary) <> ''`,
        []
      );
      for (const row of summaries) {
        if (!titles.has(row.id) && row.summary) {
          titles.set(row.id, row.summary.trim());
        }
      }

      const firstTurns = await db.all<{ session_id: string; user_message: string | null }>(
        `SELECT session_id, user_message
         FROM turns
         WHERE turn_index = 0 AND user_message IS NOT NULL AND TRIM(user_message) <> ''`,
        []
      );
      for (const row of firstTurns) {
        if (!titles.has(row.session_id) && row.user_message) {
          const msg = row.user_message.replace(/\s+/g, ' ').trim();
          if (msg) {
            titles.set(row.session_id, msg.length > 60 ? msg.slice(0, 57) + '...' : msg);
          }
        }
      }
    } catch {
      // session-store fallback is best-effort
    } finally {
      db?.close();
    }
  }

  /**
   * Resolve full per-turn text (user prompt + assistant response) for a session
   * from session-store.db. Keyed by `turn_index`, which aligns with the
   * `turnIndex` used to group spans in the aggregator. Best-effort: returns an
   * empty map when the database is unavailable or unreadable.
   */
  async getTurnTexts(sessionId: string): Promise<Map<number, TurnText>> {
    const result = new Map<number, TurnText>();
    if (!this.sessionStoreDbPath || !fs.existsSync(this.sessionStoreDbPath)) {
      return result;
    }

    let db: Database | null = null;
    try {
      db = await openDatabase(this.sessionStoreDbPath);
      const rows = await db.all<{
        turn_index: number;
        user_message: string | null;
        assistant_response: string | null;
      }>(
        `SELECT turn_index, user_message, assistant_response
         FROM turns
         WHERE session_id = ?`,
        [sessionId]
      );
      for (const row of rows) {
        if (row.turn_index == null) continue;
        result.set(row.turn_index, {
          userMessage: cap(row.user_message),
          assistantResponse: cap(row.assistant_response),
        });
      }
    } catch {
      // Turn text is best-effort; absence simply hides the prompt/response panels.
    } finally {
      db?.close();
    }
    return result;
  }

  private addDebugLogFallbackTitles(titles: Map<string, string>): void {
    if (!this.workspaceStorageRoot || !fs.existsSync(this.workspaceStorageRoot)) {
      return;
    }

    let wsDirs: string[];
    try {
      wsDirs = fs.readdirSync(this.workspaceStorageRoot);
    } catch {
      return;
    }

    for (const wsDir of wsDirs) {
      const debugLogsPath = path.join(this.workspaceStorageRoot, wsDir, 'GitHub.copilot-chat', 'debug-logs');
      if (!fs.existsSync(debugLogsPath)) continue;

      let sessionDirs: string[];
      try {
        sessionDirs = fs.readdirSync(debugLogsPath);
      } catch {
        continue;
      }

      for (const sessionId of sessionDirs) {
        if (titles.has(sessionId)) continue;

        const mainJsonl = path.join(debugLogsPath, sessionId, 'main.jsonl');
        if (!fs.existsSync(mainJsonl)) continue;

        try {
          const content = fs.readFileSync(mainJsonl, 'utf8');
          for (const line of content.split('\n')) {
            if (!line.trim()) continue;

            try {
              const event = JSON.parse(line) as {
                type?: string;
                attrs?: { content?: string };
              };
              if (event.type === 'user_message' && event.attrs?.content) {
                const msg = event.attrs.content.replace(/\s+/g, ' ').trim();
                if (msg) {
                  titles.set(sessionId, msg.length > 60 ? msg.slice(0, 57) + '...' : msg);
                }
                break;
              }
            } catch {
              // Ignore malformed log lines.
            }
          }
        } catch {
          // Ignore unreadable log files.
        }
      }
    }
  }

  /** Invalidate the cached titles (call when polling detects changes) */
  invalidateCache(): void {
    this.cache = null;
    this.workspaceCache = null;
  }

  dispose(): void {
    this.cache = null;
    this.workspaceCache = null;
  }
}

/**
 * Read workspace.json from a workspace storage folder and extract a short name.
 * Returns the last path segment of the workspace folder URI (e.g. "cost-research").
 */
function resolveWorkspaceName(storageRoot: string, wsDir: string): string | null {
  const wsJsonPath = path.join(storageRoot, wsDir, 'workspace.json');
  try {
    if (!fs.existsSync(wsJsonPath)) return null;
    const content = JSON.parse(fs.readFileSync(wsJsonPath, 'utf8')) as {
      folder?: string;
      workspace?: string;
    };
    const uri = content.folder ?? content.workspace;
    if (!uri) return null;
    // Decode the URI and extract the last meaningful path segment
    const decoded = decodeURIComponent(uri.replace(/^file:\/\/\//, ''));
    // For .code-workspace files, use the filename without extension
    if (decoded.endsWith('.code-workspace')) {
      const base = path.basename(decoded, '.code-workspace');
      return base;
    }
    // For folder URIs, use the last segment
    const segments = decoded.replace(/[\\/]+$/, '').split(/[\\/]/);
    return segments[segments.length - 1] || null;
  } catch {
    return null;
  }
}

/** Trim and cap a turn-text field; returns null for empty/missing values. */
function cap(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_TURN_TEXT_CHARS
    ? trimmed.slice(0, MAX_TURN_TEXT_CHARS) + '\n…[truncated]'
    : trimmed;
}
