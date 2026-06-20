import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { CostHistoryService } from '../src/services/CostHistoryService.js';
import type { DashboardData, SessionInfo, ModelCost } from '../src/domain/models.js';

function makeDashboardData(overrides: Partial<DashboardData> = {}): DashboardData {
  const emptyPeriod = { totalCost: 0, modelTurns: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, byModel: [] };
  return {
    today: emptyPeriod,
    thisWeek: emptyPeriod,
    currentSession: { ...emptyPeriod, sessionId: null, title: null, agentName: null, workspace: null, latestSpanTimeMs: null, spanCount: 0 },
    last7Days: [],
    recentSessions: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  const now = Date.now();
  return {
    sessionId: 'session-1',
    title: 'Test session',
    model: 'claude-sonnet-4',
    agentName: null,
    workspace: 'my-project',
    startedAt: now - 3600_000,
    endedAt: now - 1800_000,
    totalCost: 0.50,
    modelTurns: 10,
    inputTokens: 50_000,
    outputTokens: 20_000,
    cachedTokens: 30_000,
    cacheWriteTokens: 5_000,
    byModel: [makeModelCost()],
    ...overrides,
  };
}

function makeModelCost(overrides: Partial<ModelCost> = {}): ModelCost {
  return {
    model: 'claude-sonnet-4',
    calls: 10,
    inputTokens: 50_000,
    outputTokens: 20_000,
    cachedTokens: 30_000,
    cacheWriteTokens: 5_000,
    freshInputCost: 0.06,
    cacheReadCost: 0.009,
    cacheWriteCost: 0.019,
    outputCost: 0.30,
    totalCost: 0.50,
    ...overrides,
  };
}

describe('CostHistoryService', () => {
  let tmpDir: string;
  let service: CostHistoryService;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cost-history-test-'));
    service = new CostHistoryService(tmpDir, () => 90);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('scrape', () => {
    it('creates current.json with today\'s sessions', async () => {
      const session = makeSessionInfo();
      const data = makeDashboardData({ recentSessions: [session] });

      await service.scrape(data);

      const currentPath = path.join(tmpDir, 'cost-history', 'current.json');
      const content = JSON.parse(await fs.readFile(currentPath, 'utf-8'));

      expect(content.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(content.sessions).toHaveLength(1);
      expect(content.sessions[0].sessionId).toBe('session-1');
      expect(content.sessions[0].workspace).toBe('my-project');
      expect(content.sessions[0].totalCost).toBe(0.50);
      expect(content.sessions[0].byModel).toHaveLength(1);
      expect(content.sessions[0].byModel[0].model).toBe('claude-sonnet-4');
    });

    it('filters sessions to today only', async () => {
      const todaySession = makeSessionInfo({ sessionId: 'today-1' });
      const yesterdaySession = makeSessionInfo({
        sessionId: 'yesterday-1',
        startedAt: Date.now() - 2 * 24 * 3600_000, // 2 days ago
        endedAt: Date.now() - 2 * 24 * 3600_000 + 1800_000,
      });
      const data = makeDashboardData({ recentSessions: [todaySession, yesterdaySession] });

      await service.scrape(data);

      const currentPath = path.join(tmpDir, 'cost-history', 'current.json');
      const content = JSON.parse(await fs.readFile(currentPath, 'utf-8'));

      expect(content.sessions).toHaveLength(1);
      expect(content.sessions[0].sessionId).toBe('today-1');
    });

    it('overwrites current.json on subsequent scrapes', async () => {
      const session1 = makeSessionInfo({ sessionId: 's1', totalCost: 0.10 });
      await service.scrape(makeDashboardData({ recentSessions: [session1] }));

      const session2 = makeSessionInfo({ sessionId: 's2', totalCost: 0.20 });
      await service.scrape(makeDashboardData({ recentSessions: [session1, session2] }));

      const currentPath = path.join(tmpDir, 'cost-history', 'current.json');
      const content = JSON.parse(await fs.readFile(currentPath, 'utf-8'));

      expect(content.sessions).toHaveLength(2);
    });
  });

  describe('rollup', () => {
    it('rolls up current day into daily file on day change', async () => {
      // Manually create a current.json for yesterday
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = formatDate(yesterday);

      const historyDir = path.join(tmpDir, 'cost-history');
      const dailyDir = path.join(historyDir, 'daily');
      await fs.mkdir(dailyDir, { recursive: true });

      const oldCurrent = {
        date: yesterdayStr,
        lastUpdatedAt: yesterday.toISOString(),
        sessions: [
          {
            sessionId: 's1',
            title: 'Yesterday session',
            workspace: 'project-a',
            totalCost: 1.00,
            modelTurns: 20,
            inputTokens: 100_000,
            outputTokens: 40_000,
            cachedTokens: 60_000,
            cacheWriteTokens: 10_000,
            byModel: [{ model: 'claude-sonnet-4', calls: 20, inputTokens: 100_000, outputTokens: 40_000, cachedTokens: 60_000, cacheWriteTokens: 10_000, totalCost: 1.00 }],
            startedAt: yesterday.getTime(),
            endedAt: yesterday.getTime() + 3600_000,
          },
          {
            sessionId: 's2',
            title: 'Yesterday session 2',
            workspace: 'project-b',
            totalCost: 0.50,
            modelTurns: 5,
            inputTokens: 20_000,
            outputTokens: 10_000,
            cachedTokens: 15_000,
            cacheWriteTokens: 3_000,
            byModel: [{ model: 'gpt-4.1', calls: 5, inputTokens: 20_000, outputTokens: 10_000, cachedTokens: 15_000, cacheWriteTokens: 3_000, totalCost: 0.50 }],
            startedAt: yesterday.getTime() + 1800_000,
            endedAt: yesterday.getTime() + 3600_000,
          },
        ],
      };
      await fs.writeFile(path.join(historyDir, 'current.json'), JSON.stringify(oldCurrent));

      // Scrape triggers rollup because current.json date != today
      const todaySession = makeSessionInfo({ sessionId: 'today-1' });
      await service.scrape(makeDashboardData({ recentSessions: [todaySession] }));

      // Verify daily file was created
      const dailyPath = path.join(dailyDir, `${yesterdayStr}.json`);
      const daily = JSON.parse(await fs.readFile(dailyPath, 'utf-8'));

      expect(daily.date).toBe(yesterdayStr);
      expect(daily.totalCost).toBeCloseTo(1.50);
      expect(daily.modelTurns).toBe(25);
      expect(daily.sessionCount).toBe(2);
      expect(daily.byModel).toHaveLength(2);
      expect(daily.byWorkspace).toHaveLength(2);
      expect(daily.byWorkspace.find((w: any) => w.workspace === 'project-a').totalCost).toBe(1.00);
      expect(daily.byWorkspace.find((w: any) => w.workspace === 'project-b').totalCost).toBe(0.50);

      // Verify current.json was reset to today
      const current = JSON.parse(await fs.readFile(path.join(historyDir, 'current.json'), 'utf-8'));
      expect(current.date).toBe(formatDate(new Date()));
    });
  });

  describe('prune', () => {
    it('deletes files older than retention period', async () => {
      const shortRetentionService = new CostHistoryService(tmpDir, () => 7);
      const dailyDir = path.join(tmpDir, 'cost-history', 'daily');
      await fs.mkdir(dailyDir, { recursive: true });

      // Create files: one recent, one old
      const recent = new Date();
      recent.setDate(recent.getDate() - 3);
      const old = new Date();
      old.setDate(old.getDate() - 30);

      await fs.writeFile(path.join(dailyDir, `${formatDate(recent)}.json`), '{}');
      await fs.writeFile(path.join(dailyDir, `${formatDate(old)}.json`), '{}');

      await shortRetentionService.prune();

      const entries = await fs.readdir(dailyDir);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toBe(`${formatDate(recent)}.json`);
    });
  });

  describe('getHistory', () => {
    it('returns daily aggregates sorted by date', async () => {
      const dailyDir = path.join(tmpDir, 'cost-history', 'daily');
      await fs.mkdir(dailyDir, { recursive: true });

      // Use dates within the requested window (relative to today) so the test
      // is not tied to a fixed calendar date — getHistory filters by recency.
      const d1 = new Date();
      d1.setDate(d1.getDate() - 2);
      const d2 = new Date();
      d2.setDate(d2.getDate() - 1);
      const date1 = formatDate(d1);
      const date2 = formatDate(d2);

      const day1 = { date: date1, totalCost: 1.0, modelTurns: 10, inputTokens: 50000, outputTokens: 20000, cachedTokens: 30000, cacheWriteTokens: 5000, byModel: [], byWorkspace: [], sessionCount: 2 };
      const day2 = { date: date2, totalCost: 2.0, modelTurns: 20, inputTokens: 100000, outputTokens: 40000, cachedTokens: 60000, cacheWriteTokens: 10000, byModel: [], byWorkspace: [], sessionCount: 4 };

      await fs.writeFile(path.join(dailyDir, `${date1}.json`), JSON.stringify(day1));
      await fs.writeFile(path.join(dailyDir, `${date2}.json`), JSON.stringify(day2));

      const history = await service.getHistory(7);
      expect(history).toHaveLength(2);
      expect(history[0].date).toBe(date1);
      expect(history[1].date).toBe(date2);
      expect(history[1].totalCost).toBe(2.0);
    });
  });

  describe('checkRollup', () => {
    it('does nothing when current.json is from today', async () => {
      const historyDir = path.join(tmpDir, 'cost-history');
      const dailyDir = path.join(historyDir, 'daily');
      await fs.mkdir(dailyDir, { recursive: true });

      const today = formatDate(new Date());
      const current = { date: today, lastUpdatedAt: new Date().toISOString(), sessions: [] };
      await fs.writeFile(path.join(historyDir, 'current.json'), JSON.stringify(current));

      await service.checkRollup();

      // No daily file created
      const entries = await fs.readdir(dailyDir);
      expect(entries).toHaveLength(0);
    });

    it('does nothing when no current.json exists', async () => {
      // Should not throw
      await service.checkRollup();
    });
  });
});

function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
