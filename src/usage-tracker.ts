import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface DailyUsage {
  inputTokens: number;
  outputTokens: number;
  sessionCount: number;
}

interface UsageData {
  daily: Record<string, DailyUsage>;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalSessionCount: number;
  activeDays: string[];
}

function getConfigDir(): string {
  return process.platform === 'win32'
    ? path.join(process.env.APPDATA || os.homedir(), 'forkoff-cli')
    : path.join(os.homedir(), '.config', 'forkoff-cli');
}

function getTodayKey(): string {
  return new Date().toISOString().split('T')[0]; // "YYYY-MM-DD"
}

export class UsageTracker {
  private filePath: string;
  private data: UsageData;
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor() {
    const configDir = getConfigDir();
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }
    this.filePath = path.join(configDir, 'usage.json');
    this.data = this.load();
  }

  private load(): UsageData {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      }
    } catch {
      // Corrupted file — start fresh
    }
    return {
      daily: {},
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalSessionCount: 0,
      activeDays: [],
    };
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) {
        this.saveNow();
      }
    }, 2000);
  }

  private saveNow(): void {
    try {
      const tmpFile = this.filePath + '.tmp.' + process.pid;
      fs.writeFileSync(tmpFile, JSON.stringify(this.data, null, 2), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmpFile, this.filePath);
      this.dirty = false;
    } catch (err) {
      console.error(`[UsageTracker] Failed to save: ${(err as Error).message}`);
    }
  }

  private ensureDay(dateKey: string): DailyUsage {
    if (!this.data.daily[dateKey]) {
      this.data.daily[dateKey] = { inputTokens: 0, outputTokens: 0, sessionCount: 0 };
      if (!this.data.activeDays.includes(dateKey)) {
        this.data.activeDays.push(dateKey);
        this.data.activeDays.sort();
      }
    }
    return this.data.daily[dateKey];
  }

  recordUsage(inputTokens: number, outputTokens: number): void {
    const today = getTodayKey();
    const day = this.ensureDay(today);
    day.inputTokens += inputTokens;
    day.outputTokens += outputTokens;
    this.data.totalInputTokens += inputTokens;
    this.data.totalOutputTokens += outputTokens;
    this.scheduleSave();
  }

  recordSessionStart(): void {
    const today = getTodayKey();
    const day = this.ensureDay(today);
    day.sessionCount += 1;
    this.data.totalSessionCount += 1;
    this.scheduleSave();
  }

  /**
   * Get usage stats matching the mobile UsageStats type.
   */
  getUsageStats(period: 'day' | 'week' | 'month' | 'all' = 'all'): {
    totalInputTokens: string;
    totalOutputTokens: string;
    totalTokens: string;
    totalSessionCount: number;
    estimatedCostUsd: number;
    period: string;
  } {
    const now = new Date();
    let startDate: Date | null = null;

    if (period === 'day') {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (period === 'week') {
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 7);
    } else if (period === 'month') {
      startDate = new Date(now);
      startDate.setMonth(startDate.getMonth() - 1);
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let sessionCount = 0;

    if (!startDate) {
      // 'all' — use totals directly
      inputTokens = this.data.totalInputTokens;
      outputTokens = this.data.totalOutputTokens;
      sessionCount = this.data.totalSessionCount;
    } else {
      const startKey = startDate.toISOString().split('T')[0];
      for (const [dateKey, day] of Object.entries(this.data.daily)) {
        if (dateKey >= startKey) {
          inputTokens += day.inputTokens;
          outputTokens += day.outputTokens;
          sessionCount += day.sessionCount;
        }
      }
    }

    const totalTokens = inputTokens + outputTokens;
    // Rough cost estimate: $3/M input, $15/M output (Claude Sonnet pricing)
    const estimatedCostUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

    return {
      totalInputTokens: String(inputTokens),
      totalOutputTokens: String(outputTokens),
      totalTokens: String(totalTokens),
      totalSessionCount: sessionCount,
      estimatedCostUsd: Math.round(estimatedCostUsd * 100) / 100,
      period,
    };
  }

  /**
   * Get daily usage matching the mobile TokenUsageDaily[] type.
   */
  getDailyUsage(startDate?: string, endDate?: string): Array<{
    date: string;
    inputTokens: string;
    outputTokens: string;
    totalTokens: string;
    sessionCount: number;
    estimatedCostUsd: number | null;
  }> {
    const result: Array<{
      date: string;
      inputTokens: string;
      outputTokens: string;
      totalTokens: string;
      sessionCount: number;
      estimatedCostUsd: number | null;
    }> = [];

    const sortedDays = Object.keys(this.data.daily).sort();
    for (const dateKey of sortedDays) {
      if (startDate && dateKey < startDate) continue;
      if (endDate && dateKey > endDate) continue;

      const day = this.data.daily[dateKey];
      const total = day.inputTokens + day.outputTokens;
      const cost = (day.inputTokens * 3 + day.outputTokens * 15) / 1_000_000;

      result.push({
        date: dateKey,
        inputTokens: String(day.inputTokens),
        outputTokens: String(day.outputTokens),
        totalTokens: String(total),
        sessionCount: day.sessionCount,
        estimatedCostUsd: Math.round(cost * 100) / 100,
      });
    }

    return result;
  }

  /**
   * Get streak info matching the mobile StreakInfo type.
   */
  getStreakInfo(): { currentStreak: number; totalActiveDays: number } {
    const activeDays = this.data.activeDays;
    const totalActiveDays = activeDays.length;

    if (totalActiveDays === 0) {
      return { currentStreak: 0, totalActiveDays: 0 };
    }

    // Calculate current streak from today backwards
    const today = getTodayKey();
    let currentStreak = 0;
    let checkDate = new Date(today + 'T00:00:00');

    // Allow today or yesterday as the start of the streak
    const todayInList = activeDays.includes(today);
    if (!todayInList) {
      checkDate.setDate(checkDate.getDate() - 1);
      const yesterday = checkDate.toISOString().split('T')[0];
      if (!activeDays.includes(yesterday)) {
        return { currentStreak: 0, totalActiveDays };
      }
    }

    while (true) {
      const key = checkDate.toISOString().split('T')[0];
      if (activeDays.includes(key)) {
        currentStreak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        break;
      }
    }

    return { currentStreak, totalActiveDays };
  }

  /** Flush pending writes immediately (call before exit). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) {
      this.saveNow();
    }
  }
}
