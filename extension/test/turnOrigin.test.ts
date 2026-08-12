import { describe, it, expect } from 'vitest';
import { classifyTurnOrigin, autoTurnLabel } from '../src/domain/turnOrigin.js';

const NOTIFICATION_EXIT_1 =
  '[Terminal 975cde77-c5dd-4ffc-a317-4eec8a3520e8 notification: command completed with exit code 1. ' +
  'Use send_to_terminal to send another command or kill_terminal to stop it.]\n' +
  'Terminal output:\nPS C:\\repo> npm test';

const NOTIFICATION_OK =
  '[Terminal a221d77d-d4c3-4400-ba27-82fd5c37ece2 notification: command completed. ' +
  'Use send_to_terminal to send another command or kill_terminal to stop it.]\nTerminal output:\nok';

const NOTIFICATION_CLEANED =
  '[Terminal 23f0ce16-e2c8-4e97-a1fd-d34b4e5bafd4 notification: command completed. ' +
  'The terminal has been cleaned up.]\nTerminal output:\nok';

/** The agent-traces label is capped at 50 chars, so classification must work on a prefix. */
const TRUNCATED_LABEL = NOTIFICATION_EXIT_1.slice(0, 50) + '…';

describe('classifyTurnOrigin', () => {
  it('classifies terminal notification prompts as auto-terminal', () => {
    expect(classifyTurnOrigin({ promptText: NOTIFICATION_EXIT_1 })).toBe('auto-terminal');
    expect(classifyTurnOrigin({ promptText: NOTIFICATION_OK })).toBe('auto-terminal');
    expect(classifyTurnOrigin({ promptText: NOTIFICATION_CLEANED })).toBe('auto-terminal');
  });

  it('classifies a truncated notification label as auto-terminal', () => {
    expect(classifyTurnOrigin({ label: TRUNCATED_LABEL })).toBe('auto-terminal');
  });

  it('prefers the trace-keyed label over the session-store text', () => {
    expect(classifyTurnOrigin({ label: NOTIFICATION_OK, promptText: 'Fix the failing test' })).toBe('auto-terminal');
    expect(classifyTurnOrigin({ label: 'Fix the failing test', promptText: NOTIFICATION_OK })).toBe('user');
  });

  it('treats real user text as a user prompt, even when it starts with a bracket', () => {
    expect(classifyTurnOrigin({ promptText: 'Fix the failing test' })).toBe('user');
    expect(classifyTurnOrigin({ label: 'Fix the failing test' })).toBe('user');
    expect(classifyTurnOrigin({ promptText: '[docs](https://example.com) please read this' })).toBe('user');
    expect(classifyTurnOrigin({ promptText: 'Here is the log:\n[Terminal 1 notification: command completed.]' })).toBe('user');
  });

  it('classifies subagent turns regardless of text', () => {
    expect(classifyTurnOrigin({ isSubagent: true, promptText: NOTIFICATION_OK })).toBe('subagent');
    expect(classifyTurnOrigin({ isSubagent: true })).toBe('subagent');
  });

  it('returns unknown when there is no text at all', () => {
    expect(classifyTurnOrigin({})).toBe('unknown');
    expect(classifyTurnOrigin({ label: null, promptText: null })).toBe('unknown');
  });
});

describe('autoTurnLabel', () => {
  it('summarises the notification status with its exit code', () => {
    expect(autoTurnLabel('auto-terminal', NOTIFICATION_EXIT_1)).toBe('Terminal follow-up · command completed (exit 1)');
  });

  it('summarises a successful command', () => {
    expect(autoTurnLabel('auto-terminal', NOTIFICATION_OK)).toBe('Terminal follow-up · command completed');
  });

  it('falls back when the status sentence is cut off', () => {
    expect(autoTurnLabel('auto-terminal', '[Terminal abc notification:')).toBe('Terminal follow-up');
    expect(autoTurnLabel('auto-terminal', null)).toBe('Terminal follow-up');
  });

  it('returns null for turns that are not auto-terminal', () => {
    expect(autoTurnLabel('user', NOTIFICATION_OK)).toBeNull();
    expect(autoTurnLabel('subagent', NOTIFICATION_OK)).toBeNull();
  });
});
