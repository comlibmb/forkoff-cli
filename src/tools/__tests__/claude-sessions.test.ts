import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We need to mock fs before importing the module
jest.mock('fs');
jest.mock('child_process');

const mockFs = fs as jest.Mocked<typeof fs>;

// Import after mocking
import { claudeSessionDetector } from '../claude-sessions';

describe('ClaudeSessionDetector', () => {
  const homeDir = os.homedir();
  const projectsDir = path.join(homeDir, '.claude', 'projects');

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset internal state
    (claudeSessionDetector as any).lastKnownSessions = new Map();
    (claudeSessionDetector as any).lastClaudeRunning = false;
  });

  describe('scanSessions', () => {
    it('should return empty array when projects dir does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const sessions = claudeSessionDetector.scanSessions();
      expect(sessions).toEqual([]);
    });

    it('should return sessions with state inactive by default', () => {
      const oldMtime = new Date(Date.now() - 120000); // 2 minutes ago

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = p.toString();
        return pathStr === projectsDir || pathStr.includes('test-project');
      });
      mockFs.readdirSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = p.toString();
        if (pathStr === projectsDir) return ['test-project'] as any;
        if (pathStr.includes('test-project')) return ['session-abc.jsonl'] as any;
        return [] as any;
      });
      mockFs.statSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = p.toString();
        if (pathStr.includes('.jsonl')) {
          return { mtime: oldMtime, isDirectory: () => false } as any;
        }
        return { isDirectory: () => true } as any;
      });
      mockFs.readFileSync.mockReturnValue('{"sessionId":"session-abc"}\n');

      const sessions = claudeSessionDetector.scanSessions();
      expect(sessions.length).toBe(1);
      expect(sessions[0].state).toBe('inactive');
      expect(sessions[0].sessionKey).toBe('session-abc');
    });
  });

  describe('checkAndEmitChanges', () => {
    function setupMockSessions(mtimeAgeMs: number) {
      const mtime = new Date(Date.now() - mtimeAgeMs);

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = p.toString();
        return pathStr === projectsDir || pathStr.includes('test-project');
      });
      mockFs.readdirSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = p.toString();
        if (pathStr === projectsDir) return ['test-project'] as any;
        if (pathStr.includes('test-project')) return ['session-1.jsonl'] as any;
        return [] as any;
      });
      mockFs.statSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = p.toString();
        if (pathStr.includes('.jsonl')) {
          return { mtime, isDirectory: () => false } as any;
        }
        return { isDirectory: () => true } as any;
      });
      mockFs.readFileSync.mockReturnValue('{"sessionId":"session-1"}\n');
    }

    it('should classify session as active when mtime < 60s ago', () => {
      setupMockSessions(30000); // 30 seconds ago

      const sessionChanges: any[] = [];
      claudeSessionDetector.on('session_detected', (s: any) => sessionChanges.push(s));

      (claudeSessionDetector as any).checkAndEmitChanges();

      expect(sessionChanges.length).toBe(1);
      expect(sessionChanges[0].state).toBe('active');
    });

    it('should classify session as inactive when mtime > 60s ago', () => {
      setupMockSessions(120000); // 2 minutes ago

      const sessionChanges: any[] = [];
      claudeSessionDetector.on('session_detected', (s: any) => sessionChanges.push(s));

      (claudeSessionDetector as any).checkAndEmitChanges();

      expect(sessionChanges.length).toBe(1);
      expect(sessionChanges[0].state).toBe('inactive');
    });

    it('should emit session_changed when session transitions from active to inactive', () => {
      // First scan: active (30s ago)
      setupMockSessions(30000);
      (claudeSessionDetector as any).checkAndEmitChanges();

      // Second scan: inactive (2 min ago)
      setupMockSessions(120000);

      const changedSessions: any[] = [];
      claudeSessionDetector.on('session_changed', (s: any) => changedSessions.push(s));

      (claudeSessionDetector as any).checkAndEmitChanges();

      expect(changedSessions.length).toBe(1);
      expect(changedSessions[0].state).toBe('inactive');
      expect(changedSessions[0].sessionKey).toBe('session-1');
    });

    it('should emit claude_running_changed when active state changes', () => {
      setupMockSessions(30000); // active

      const runningChanges: boolean[] = [];
      claudeSessionDetector.on('claude_running_changed', (running: boolean) =>
        runningChanges.push(running),
      );

      (claudeSessionDetector as any).checkAndEmitChanges();
      expect(runningChanges).toEqual([true]);

      // Now go inactive
      setupMockSessions(120000);
      (claudeSessionDetector as any).checkAndEmitChanges();
      expect(runningChanges).toEqual([true, false]);
    });

    it('should emit session_removed when a session disappears', () => {
      // First scan: one session
      setupMockSessions(30000);
      (claudeSessionDetector as any).checkAndEmitChanges();

      // Second scan: no sessions
      mockFs.existsSync.mockReturnValue(false);

      const removedSessions: any[] = [];
      claudeSessionDetector.on('session_removed', (s: any) => removedSessions.push(s));

      (claudeSessionDetector as any).checkAndEmitChanges();

      expect(removedSessions.length).toBe(1);
      expect(removedSessions[0].sessionKey).toBe('session-1');
    });
  });

  describe('seedKnownSessions', () => {
    function setupMockSessions(sessionIds: string[], mtimeAgeMs: number) {
      const mtime = new Date(Date.now() - mtimeAgeMs);

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = p.toString();
        return pathStr === projectsDir || pathStr.includes('test-project');
      });
      mockFs.readdirSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = p.toString();
        if (pathStr === projectsDir) return ['test-project'] as any;
        if (pathStr.includes('test-project'))
          return sessionIds.map((id) => `${id}.jsonl`) as any;
        return [] as any;
      });
      mockFs.statSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = p.toString();
        if (pathStr.includes('.jsonl')) {
          return { mtime, isDirectory: () => false } as any;
        }
        return { isDirectory: () => true } as any;
      });
      mockFs.readFileSync.mockImplementation((p: any) => {
        const pathStr = p.toString();
        const match = pathStr.match(/([^/\\]+)\.jsonl$/);
        const id = match ? match[1] : 'unknown';
        return `{"sessionId":"${id}"}\n`;
      });
    }

    it('should populate lastKnownSessions cache', () => {
      const sessions = [
        { sessionKey: 'session-a', directory: '/test', state: 'active' as const, lastUsedAt: new Date().toISOString() },
        { sessionKey: 'session-b', directory: '/test', state: 'inactive' as const, lastUsedAt: new Date().toISOString() },
      ];

      claudeSessionDetector.seedKnownSessions(sessions);

      const known = (claudeSessionDetector as any).lastKnownSessions as Map<string, any>;
      expect(known.size).toBe(2);
      expect(known.has('session-a')).toBe(true);
      expect(known.has('session-b')).toBe(true);
    });

    it('should prevent re-emission of seeded sessions on checkAndEmitChanges', () => {
      setupMockSessions(['session-1'], 30000);

      // Seed the cache with the same session that scanSessions will find
      claudeSessionDetector.seedKnownSessions([
        { sessionKey: 'session-1', directory: '/test', state: 'active', lastUsedAt: new Date().toISOString() },
      ]);

      const detected: any[] = [];
      claudeSessionDetector.on('session_detected', (s: any) => detected.push(s));

      // checkAndEmitChanges should NOT emit session_detected since session-1 is already known
      (claudeSessionDetector as any).checkAndEmitChanges();

      expect(detected.length).toBe(0);
    });

    it('should still detect genuinely new sessions after seeding', () => {
      // Seed with session-1
      claudeSessionDetector.seedKnownSessions([
        { sessionKey: 'session-1', directory: '/test', state: 'active', lastUsedAt: new Date().toISOString() },
      ]);

      // Now scan finds session-1 AND session-2
      setupMockSessions(['session-1', 'session-2'], 30000);

      const detected: any[] = [];
      claudeSessionDetector.on('session_detected', (s: any) => detected.push(s));

      (claudeSessionDetector as any).checkAndEmitChanges();

      // Only session-2 should be emitted as new
      expect(detected.length).toBe(1);
      expect(detected[0].sessionKey).toBe('session-2');
    });

    it('should clear previous cache when re-seeded', () => {
      claudeSessionDetector.seedKnownSessions([
        { sessionKey: 'old-session', directory: '/test', state: 'inactive', lastUsedAt: new Date().toISOString() },
      ]);

      claudeSessionDetector.seedKnownSessions([
        { sessionKey: 'new-session', directory: '/test', state: 'active', lastUsedAt: new Date().toISOString() },
      ]);

      const known = (claudeSessionDetector as any).lastKnownSessions as Map<string, any>;
      expect(known.size).toBe(1);
      expect(known.has('new-session')).toBe(true);
      expect(known.has('old-session')).toBe(false);
    });
  });

  describe('startWatching with seeded sessions', () => {
    it('should skip initial checkAndEmitChanges when sessions are seeded', () => {
      // Seed sessions first
      claudeSessionDetector.seedKnownSessions([
        { sessionKey: 'session-1', directory: '/test', state: 'active', lastUsedAt: new Date().toISOString() },
      ]);

      const detected: any[] = [];
      claudeSessionDetector.on('session_detected', (s: any) => detected.push(s));

      // Mock scanSessions to return the same session
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = p.toString();
        if (pathStr === projectsDir) return ['test-project'] as any;
        if (pathStr.includes('test-project')) return ['session-1.jsonl'] as any;
        return [] as any;
      });
      mockFs.statSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = p.toString();
        if (pathStr.includes('.jsonl')) {
          return { mtime: new Date(), isDirectory: () => false } as any;
        }
        return { isDirectory: () => true } as any;
      });
      mockFs.readFileSync.mockReturnValue('{"sessionId":"session-1"}\n');

      // startWatching should NOT re-emit seeded sessions
      claudeSessionDetector.startWatching(60000); // long interval to avoid timer issues

      expect(detected.length).toBe(0);

      // Cleanup
      claudeSessionDetector.stopWatching();
    });

    it('should do initial scan when not seeded', () => {
      // Don't seed - lastKnownSessions is empty
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = p.toString();
        if (pathStr === projectsDir) return ['test-project'] as any;
        if (pathStr.includes('test-project')) return ['session-1.jsonl'] as any;
        return [] as any;
      });
      mockFs.statSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = p.toString();
        if (pathStr.includes('.jsonl')) {
          return { mtime: new Date(), isDirectory: () => false } as any;
        }
        return { isDirectory: () => true } as any;
      });
      mockFs.readFileSync.mockReturnValue('{"sessionId":"session-1"}\n');

      const detected: any[] = [];
      claudeSessionDetector.on('session_detected', (s: any) => detected.push(s));

      claudeSessionDetector.startWatching(60000);

      // Should detect session-1 since cache was empty
      expect(detected.length).toBe(1);
      expect(detected[0].sessionKey).toBe('session-1');

      // Cleanup
      claudeSessionDetector.stopWatching();
    });
  });
});
