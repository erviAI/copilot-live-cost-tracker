#!/usr/bin/env node
/**
 * Dump schema (and optionally run a query) against agent-traces.db using sql.js (WASM).
 * Usage:
 *   node inspect.js                     # dump schema
 *   node inspect.js "<SQL>"             # run a query, print as table
 *   node inspect.js --db <path> "<SQL>"
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

function parseArgs(argv) {
  const args = { db: null, sql: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') { args.db = argv[++i]; }
    else if (!args.sql) { args.sql = argv[i]; }
  }
  if (!args.db) {
    args.db = path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db');
  }
  return args;
}

function printResult(res) {
  if (!res || res.length === 0) { console.log('(no rows)'); return; }
  const { columns, values } = res[0];
  console.log('| ' + columns.join(' | ') + ' |');
  console.log('|' + columns.map(() => '---').join('|') + '|');
  for (const row of values) {
    console.log('| ' + row.map(v => {
      if (v === null) return '';
      const s = String(v).replace(/\r?\n/g, ' ');
      return s.length > 200 ? s.slice(0, 200) + '…' : s;
    }).join(' | ') + ' |');
  }
  console.log(`\n(${values.length} rows)`);
}

(async () => {
  const { db: dbPath, sql } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(dbPath)) {
    console.error('DB not found:', dbPath);
    process.exit(1);
  }
  const SQL = await initSqlJs({ locateFile: f => path.join(__dirname, 'node_modules', 'sql.js', 'dist', f) });
  // Read main DB; sql.js cannot read WAL, so apply any pending WAL frames by also copying it.
  // Easiest: copy db to a tmp and let sqlite handle WAL. But sql.js loads bytes only — WAL won't be merged.
  // So warn if WAL exists.
  const wal = dbPath + '-wal';
  if (fs.existsSync(wal) && fs.statSync(wal).size > 0) {
    console.error(`Note: WAL file present (${fs.statSync(wal).size} bytes). sql.js reads the main DB only — recent writes may be missing.`);
  }
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);

  if (sql) {
    try {
      const res = db.exec(sql);
      printResult(res);
    } catch (e) {
      console.error('Query error:', e.message);
      process.exit(1);
    }
    return;
  }

  // No query → dump full schema
  console.log(`# Schema: ${dbPath}\n`);
  const tables = db.exec("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view','index','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type, name;");
  if (tables.length === 0) { console.log('(empty)'); return; }
  for (const row of tables[0].values) {
    const [name, type, sqlText] = row;
    console.log(`## ${type}: ${name}\n`);
    if (sqlText) console.log('```sql\n' + sqlText + '\n```\n');
    if (type === 'table') {
      const cols = db.exec(`PRAGMA table_info(${JSON.stringify(name)});`);
      if (cols.length) {
        console.log('| cid | column | type | notnull | dflt | pk |');
        console.log('|---:|---|---|---:|---|---:|');
        for (const c of cols[0].values) {
          console.log(`| ${c[0]} | ${c[1]} | ${c[2]} | ${c[3]} | ${c[4] ?? ''} | ${c[5]} |`);
        }
        console.log('');
      }
      const cnt = db.exec(`SELECT COUNT(*) FROM ${JSON.stringify(name)};`);
      console.log(`**Rows:** ${cnt[0].values[0][0]}\n`);
    }
  }
})();
