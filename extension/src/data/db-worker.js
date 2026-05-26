/**
 * Database worker script — runs in a child process using system Node.js.
 * Accepts JSON commands on stdin, returns JSON results on stdout.
 * This avoids Electron ABI mismatch with native better-sqlite3 bindings.
 *
 * Protocol: one JSON object per line (newline-delimited JSON)
 * Request:  { "id": number, "action": "open"|"all"|"get"|"close", ... }
 * Response: { "id": number, "result": ... } or { "id": number, "error": string }
 */
const path = require('path');

// Resolve better-sqlite3 from the extension's node_modules (next to this script)
const extensionRoot = path.resolve(__dirname, '..');
const modulePath = path.join(extensionRoot, 'node_modules', 'better-sqlite3');
const Database = require(modulePath);

const databases = new Map();
let dbCounter = 0;

process.stdin.setEncoding('utf8');

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newlineIdx;
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (line) {
      try {
        const request = JSON.parse(line);
        handleRequest(request);
      } catch (err) {
        // Malformed JSON — skip
      }
    }
  }
});

process.stdin.on('end', () => {
  // Clean up all open databases
  for (const db of databases.values()) {
    try { db.close(); } catch {}
  }
  process.exit(0);
});

function handleRequest(req) {
  const { id, action } = req;
  try {
    switch (action) {
      case 'open': {
        const db = new Database(req.dbPath, { readonly: true, fileMustExist: true });
        db.pragma('busy_timeout = 3000');
        const handle = ++dbCounter;
        databases.set(handle, db);
        respond(id, { handle });
        break;
      }
      case 'all': {
        const db = databases.get(req.handle);
        if (!db) throw new Error('Invalid database handle');
        const rows = db.prepare(req.sql).all(...(req.params || []));
        respond(id, { rows });
        break;
      }
      case 'get': {
        const db = databases.get(req.handle);
        if (!db) throw new Error('Invalid database handle');
        const row = db.prepare(req.sql).get(...(req.params || []));
        respond(id, { row: row ?? null });
        break;
      }
      case 'close': {
        const db = databases.get(req.handle);
        if (db) {
          db.close();
          databases.delete(req.handle);
        }
        respond(id, { ok: true });
        break;
      }
      default:
        respond(id, null, `Unknown action: ${action}`);
    }
  } catch (err) {
    respond(id, null, err.message || String(err));
  }
}

function respond(id, result, error) {
  const msg = error ? { id, error } : { id, result };
  process.stdout.write(JSON.stringify(msg) + '\n');
}
