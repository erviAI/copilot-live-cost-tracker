import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DebugLogsRepository } from '../src/data/DebugLogsRepository.js';

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let userDir: string;
let logDir: string;

function response(parts: unknown[]): string {
  return JSON.stringify([{ role: 'assistant', parts }]);
}

function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

function writeLog(content: string): void {
  fs.writeFileSync(path.join(logDir, 'main.jsonl'), content, 'utf8');
}

beforeAll(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clct-dbg-'));
  logDir = path.join(userDir, 'workspaceStorage', 'ws1', 'GitHub.copilot-chat', 'debug-logs', SESSION);
  fs.mkdirSync(logDir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(userDir, { recursive: true, force: true });
});

describe('DebugLogsRepository.getSpanResponses', () => {
  it('keys assistant text by the LLM span id behind the agent-msg- prefix', async () => {
    writeLog(
      line({ type: 'llm_request', spanId: '0612cfb9bb5e51a9', attrs: { model: 'claude-opus-5' } }) +
      line({
        type: 'agent_response',
        spanId: 'agent-msg-0612cfb9bb5e51a9',
        attrs: { response: response([{ type: 'text', content: 'First, a correction.' }]) },
      })
    );
    const repo = new DebugLogsRepository(userDir);
    const responses = await repo.getSpanResponses(SESSION);
    expect(responses.get('0612cfb9bb5e51a9')).toBe('First, a correction.');
    repo.dispose();
  });

  it('keeps only text parts and joins multiple text parts', async () => {
    writeLog(line({
      type: 'agent_response',
      spanId: 'agent-msg-abc123',
      attrs: {
        response: response([
          { type: 'text', content: 'one' },
          { type: 'tool_use', content: 'ignored' },
          { type: 'text', content: 'two' },
        ]),
      },
    }));
    const repo = new DebugLogsRepository(userDir);
    const responses = await repo.getSpanResponses(SESSION);
    expect(responses.get('agent-msg-abc123')).toBeUndefined();
    expect(responses.get('abc123')).toBe('one\n\ntwo');
    repo.dispose();
  });

  it('concatenates several responses emitted by the same call', async () => {
    writeLog(
      line({ type: 'agent_response', spanId: 'agent-msg-dup', attrs: { response: response([{ type: 'text', content: 'first' }]) } }) +
      line({ type: 'agent_response', spanId: 'agent-msg-dup', attrs: { response: response([{ type: 'text', content: 'second' }]) } })
    );
    const repo = new DebugLogsRepository(userDir);
    const responses = await repo.getSpanResponses(SESSION);
    expect(responses.get('dup')).toBe('first\n\nsecond');
    repo.dispose();
  });

  it('ignores the marker when it only appears inside an embedded payload', async () => {
    writeLog(line({
      type: 'llm_request',
      spanId: 'big',
      attrs: { inputMessages: 'a transcript mentioning "type":"agent_response" verbatim' },
    }));
    const repo = new DebugLogsRepository(userDir);
    const responses = await repo.getSpanResponses(SESSION);
    expect(responses.size).toBe(0);
    repo.dispose();
  });

  it('survives malformed lines, bad payloads and missing prefixes', async () => {
    writeLog(
      '{not json at all\n' +
      line({ type: 'agent_response', spanId: 'agent-msg-bad', attrs: { response: '{{{' } }) +
      line({ type: 'agent_response', spanId: 'no-prefix', attrs: { response: response([{ type: 'text', content: 'x' }]) } }) +
      line({ type: 'agent_response', spanId: 'agent-msg-empty', attrs: { response: response([]) } }) +
      line({ type: 'agent_response', spanId: 'agent-msg-ok', attrs: { response: response([{ type: 'text', content: 'kept' }]) } })
    );
    const repo = new DebugLogsRepository(userDir);
    const responses = await repo.getSpanResponses(SESSION);
    expect(responses.size).toBe(1);
    expect(responses.get('ok')).toBe('kept');
    repo.dispose();
  });

  it('caps very long responses', async () => {
    writeLog(line({
      type: 'agent_response',
      spanId: 'agent-msg-long',
      attrs: { response: response([{ type: 'text', content: 'x'.repeat(25000) }]) },
    }));
    const repo = new DebugLogsRepository(userDir);
    const responses = await repo.getSpanResponses(SESSION);
    expect(responses.get('long')).toHaveLength(20001); // 20000 + ellipsis
    repo.dispose();
  });

  it('returns empty for unknown sessions and unsafe ids', async () => {
    const repo = new DebugLogsRepository(userDir);
    expect((await repo.getSpanResponses('11111111-2222-3333-4444-555555555555')).size).toBe(0);
    expect((await repo.getSpanResponses('../../etc/passwd')).size).toBe(0);
    repo.dispose();
  });
});

describe('DebugLogsRepository.getSpanResponses incremental reads', () => {
  const file = () => path.join(logDir, 'main.jsonl');
  const entry = (id: string, content: string) =>
    line({ type: 'agent_response', spanId: 'agent-msg-' + id, attrs: { response: response([{ type: 'text', content }]) } });

  it('picks up appended records without re-reading the whole file', async () => {
    writeLog(entry('one', 'first'));
    const repo = new DebugLogsRepository(userDir);
    expect((await repo.getSpanResponses(SESSION)).get('one')).toBe('first');

    fs.appendFileSync(file(), entry('two', 'second'), 'utf8');
    const after = await repo.getSpanResponses(SESSION);
    expect(after.get('one')).toBe('first');
    expect(after.get('two')).toBe('second');
    repo.dispose();
  });

  it('resumes mid-line when the log is flushed without a trailing newline', async () => {
    const partial = entry('split', 'whole record').trimEnd();
    writeLog(entry('before', 'kept') + partial.slice(0, 40));
    const repo = new DebugLogsRepository(userDir);
    const first = await repo.getSpanResponses(SESSION);
    expect(first.get('before')).toBe('kept');
    expect(first.has('split')).toBe(false); // incomplete line is not consumed

    fs.appendFileSync(file(), partial.slice(40) + '\n', 'utf8');
    const second = await repo.getSpanResponses(SESSION);
    expect(second.get('before')).toBe('kept');
    expect(second.get('split')).toBe('whole record');
    repo.dispose();
  });

  it('keeps byte offsets correct across multi-byte characters', async () => {
    writeLog(entry('uni', 'héllo — wörld 🎉'));
    const repo = new DebugLogsRepository(userDir);
    expect((await repo.getSpanResponses(SESSION)).get('uni')).toBe('héllo — wörld 🎉');

    fs.appendFileSync(file(), entry('next', 'ascii'), 'utf8');
    const after = await repo.getSpanResponses(SESSION);
    expect(after.get('uni')).toBe('héllo — wörld 🎉');
    expect(after.get('next')).toBe('ascii');
    repo.dispose();
  });

  it('re-reads from scratch when the log shrinks', async () => {
    writeLog(entry('old', 'stale') + entry('gone', 'dropped'));
    const repo = new DebugLogsRepository(userDir);
    expect((await repo.getSpanResponses(SESSION)).size).toBe(2);

    writeLog(entry('fresh', 'rotated'));
    const after = await repo.getSpanResponses(SESSION);
    expect(after.size).toBe(1);
    expect(after.get('fresh')).toBe('rotated');
    repo.dispose();
  });

  it('handles a record split across the stream chunk boundary', async () => {
    // Far larger than the 64 KB default highWaterMark, so the line spans chunks.
    writeLog(entry('big', 'y'.repeat(200_000)) + entry('tail', 'last'));
    const repo = new DebugLogsRepository(userDir);
    const responses = await repo.getSpanResponses(SESSION);
    expect(responses.get('big')).toHaveLength(20001);
    expect(responses.get('tail')).toBe('last');
    repo.dispose();
  });
});

