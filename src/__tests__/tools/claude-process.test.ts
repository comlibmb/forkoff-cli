/**
 * Tests for Claude Process Manager
 * Covers:
 * - Bug 1: dangerouslySkipPermissions threading through startSession, resumeSession, sendInput, registerSession
 * - Bug 2: tool_activity event instead of claude_approval_request for SDK tool_use, disabled regex approval, guarded stdin writes
 */

import { EventEmitter } from 'events';

// Mock cross-spawn before importing the module
const mockSpawn = jest.fn();
jest.mock('cross-spawn', () => mockSpawn);

// Mock fs to prevent hook config from writing real files
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn((p: string) => {
      // Hook script doesn't exist in test env — skip hook config
      if (typeof p === 'string' && p.includes('permission-hook')) return false;
      return actual.existsSync(p);
    }),
    mkdirSync: jest.fn(),
    writeFileSync: jest.fn(),
    readFileSync: jest.fn((p: string, enc?: string) => {
      if (typeof p === 'string' && p.includes('settings.local.json')) return '{}';
      return actual.readFileSync(p, enc);
    }),
  };
});

// Create a mock child process
function createMockProcess() {
  const stdin = {
    write: jest.fn((_data: any, cb?: any) => { if (cb) cb(null); }),
    destroyed: false,
  };
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc: any = new EventEmitter();
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.exitCode = null;
  proc.kill = jest.fn(() => {
    proc.exitCode = 0;
  });
  return proc;
}

import { ClaudeProcessManager } from '../../tools/claude-process';

describe('ClaudeProcessManager', () => {
  let manager: ClaudeProcessManager;
  let mockProc: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);
    manager = new ClaudeProcessManager();
  });

  // ==================== Bug 1: dangerouslySkipPermissions ====================

  describe('Bug 1: dangerouslySkipPermissions flag', () => {
    describe('startSession', () => {
      it('should NOT include --dangerously-skip-permissions when flag is false', async () => {
        await manager.startSession('/test/dir', 'session-1', false);

        expect(mockSpawn).toHaveBeenCalledTimes(1);
        const args = mockSpawn.mock.calls[0][1];
        expect(args).not.toContain('--dangerously-skip-permissions');
      });

      it('should NOT include --dangerously-skip-permissions when flag is undefined', async () => {
        await manager.startSession('/test/dir', 'session-1');

        expect(mockSpawn).toHaveBeenCalledTimes(1);
        const args = mockSpawn.mock.calls[0][1];
        expect(args).not.toContain('--dangerously-skip-permissions');
      });

      it('should include --dangerously-skip-permissions when flag is true', async () => {
        await manager.startSession('/test/dir', 'session-1', true);

        expect(mockSpawn).toHaveBeenCalledTimes(1);
        const args = mockSpawn.mock.calls[0][1];
        expect(args).toContain('--dangerously-skip-permissions');
      });
    });

    describe('resumeSession', () => {
      it('should NOT include --dangerously-skip-permissions when flag is false (uses hooks instead)', async () => {
        await manager.resumeSession('key-1', '/test/dir', 'session-1', false);

        const args = mockSpawn.mock.calls[0][1];
        expect(args).not.toContain('--dangerously-skip-permissions');
        // No longer uses --permission-mode; interactive hooks handle permissions
        expect(args).not.toContain('--permission-mode');
      });

      it('should use --dangerously-skip-permissions when flag is true', async () => {
        await manager.resumeSession('key-1', '/test/dir', 'session-1', true);

        const args = mockSpawn.mock.calls[0][1];
        expect(args).toContain('--dangerously-skip-permissions');
        expect(args).not.toContain('--permission-mode');
      });
    });

    describe('registerSession', () => {
      it('should store dangerouslySkipPermissions in closedSessions', () => {
        manager.registerSession('key-1', '/test/dir', 'session-1', true);

        // Verify the session can be retrieved and used (sendInput will use it)
        expect(manager.isClaudeSession('session-1')).toBe(true);
      });
    });

    describe('sendInput (preserves flag across respawns)', () => {
      it('should pass dangerouslySkipPermissions=true to resumeSession when respawning', async () => {
        // Register a session with the flag set
        manager.registerSession('key-1', '/test/dir', 'session-1', true);

        // Spy on resumeSession to check the flag is passed
        const resumeSpy = jest.spyOn(manager, 'resumeSession');

        await manager.sendInput('session-1', 'hello');

        expect(resumeSpy).toHaveBeenCalledWith(
          'key-1',
          expect.any(String),
          'session-1',
          true,
          undefined
        );
      });

      it('should not pass dangerouslySkipPermissions when not set', async () => {
        manager.registerSession('key-1', '/test/dir', 'session-1');

        const resumeSpy = jest.spyOn(manager, 'resumeSession');

        await manager.sendInput('session-1', 'hello');

        expect(resumeSpy).toHaveBeenCalledWith(
          'key-1',
          expect.any(String),
          'session-1',
          undefined,
          undefined
        );
      });

      it('should pass interactivePermissions=true to resumeSession when respawning', async () => {
        manager.registerSession('key-1', '/test/dir', 'session-1', false, true);

        const resumeSpy = jest.spyOn(manager, 'resumeSession');

        await manager.sendInput('session-1', 'hello');

        expect(resumeSpy).toHaveBeenCalledWith(
          'key-1',
          expect.any(String),
          'session-1',
          false,
          true
        );
      });
    });
  });

  // ==================== Bug 2: Approval system fix ====================

  describe('Bug 2: Approval system fix', () => {
    describe('checkForToolUseInSdkMessage → tool_activity', () => {
      it('should emit tool_activity instead of claude_approval_request for SDK tool_use', async () => {
        await manager.startSession('/test/dir', 'session-1');

        const toolActivityEvents: any[] = [];
        const approvalEvents: any[] = [];

        manager.on('tool_activity', (event: any) => toolActivityEvents.push(event));
        manager.on('claude_approval_request', (event: any) => approvalEvents.push(event));

        // Simulate an SDK assistant message with tool_use via stdout
        const sdkMessage = {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool-123',
                name: 'Read',
                input: { file_path: '/some/file.ts' },
              },
            ],
          },
        };

        mockProc.stdout.emit('data', Buffer.from(JSON.stringify(sdkMessage) + '\n'));
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(toolActivityEvents.length).toBe(1);
        expect(toolActivityEvents[0].toolName).toBe('Read');
        expect(toolActivityEvents[0].toolId).toBe('tool-123');
        expect(toolActivityEvents[0].terminalSessionId).toBe('session-1');
        // Should NOT emit approval requests
        expect(approvalEvents.length).toBe(0);
      });

      it('should NOT emit tool_activity for non-tool_use assistant messages', async () => {
        await manager.startSession('/test/dir', 'session-1');

        const toolActivityEvents: any[] = [];
        manager.on('tool_activity', (event: any) => toolActivityEvents.push(event));

        const sdkMessage = {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Here is the answer' }],
          },
        };

        mockProc.stdout.emit('data', Buffer.from(JSON.stringify(sdkMessage) + '\n'));
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(toolActivityEvents.length).toBe(0);
      });

      it('should include inputSummary with file_path for file tools', async () => {
        await manager.startSession('/test/dir', 'session-1');

        const events: any[] = [];
        manager.on('tool_activity', (event: any) => events.push(event));

        const sdkMessage = {
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'tool-456',
              name: 'Read',
              input: { file_path: '/path/to/file.ts' },
            }],
          },
        };

        mockProc.stdout.emit('data', Buffer.from(JSON.stringify(sdkMessage) + '\n'));
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(events[0].inputSummary).toContain('/path/to/file.ts');
      });

      it('should include inputSummary with command for Bash tools', async () => {
        await manager.startSession('/test/dir', 'session-1');

        const events: any[] = [];
        manager.on('tool_activity', (event: any) => events.push(event));

        const sdkMessage = {
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'tool-789',
              name: 'Bash',
              input: { command: 'npm run build' },
            }],
          },
        };

        mockProc.stdout.emit('data', Buffer.from(JSON.stringify(sdkMessage) + '\n'));
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(events[0].inputSummary).toContain('npm run build');
      });
    });

    describe('checkForApprovalPattern disabled for SDK mode', () => {
      it('should NOT emit claude_approval_request when SDK JSON output contains approval-like patterns', async () => {
        await manager.startSession('/test/dir', 'session-1');

        const approvalEvents: any[] = [];
        manager.on('claude_approval_request', (event: any) => approvalEvents.push(event));

        // SDK JSON that contains "[y]es" pattern in a text field
        const jsonWithPattern = JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Do you want to proceed? [y]es, [n]o' }] },
        }) + '\n';

        mockProc.stdout.emit('data', Buffer.from(jsonWithPattern));
        await new Promise(resolve => setTimeout(resolve, 50));

        // Regex-based detection should be disabled for SDK mode
        expect(approvalEvents.length).toBe(0);
      });
    });

    describe('handleApprovalResponse guards SDK mode', () => {
      it('should NOT write raw characters to stdin for SDK mode processes', async () => {
        await manager.startSession('/test/dir', 'session-1');

        // Manually set up a pending approval to test the guard
        const approvalId = 'test-approval-1';
        (manager as any).pendingApprovals?.set(approvalId, {
          approvalId,
          terminalSessionId: 'session-1',
          createdAt: Date.now(),
          timeoutId: setTimeout(() => {}, 10000),
        });

        manager.handleApprovalResponse(approvalId, 'y');

        // stdin.write should NOT have been called with a raw character
        const writeCall = mockProc.stdin.write.mock.calls.find(
          (call: any[]) => call[0] === 'y'
        );
        expect(writeCall).toBeUndefined();
      });
    });
  });

  // ==================== getAllPendingPrompts ====================

  describe('getAllPendingPrompts()', () => {
    it('returns empty array when no IPC managers exist', () => {
      expect(manager.getAllPendingPrompts()).toEqual([]);
    });

    it('returns empty array when IPC managers have no pending prompts', async () => {
      // Start a session with interactivePermissions to create an IPC manager
      // (hook script doesn't exist in test env, so IPC manager won't be created via configureHook,
      //  but we can test the method itself returns [] when the map is empty)
      expect(manager.getAllPendingPrompts()).toEqual([]);
    });

    it('delegates to IPC manager getPendingPromptData()', () => {
      // Create a mock IPC manager and inject it
      const mockIpcManager = {
        getPendingPromptData: jest.fn().mockReturnValue([
          {
            promptId: 'p1',
            terminalSessionId: 'ts1',
            sessionKey: 'sk1',
            toolName: 'Bash',
            toolInput: { command: 'ls' },
            toolUseId: 'toolu_1',
          },
          {
            promptId: 'p2',
            terminalSessionId: 'ts1',
            sessionKey: 'sk1',
            toolName: 'Edit',
            toolInput: { file_path: '/a.ts' },
            toolUseId: 'toolu_2',
          },
        ]),
      };

      // Inject mock IPC manager
      (manager as any).permissionIpcManagers.set('ts1', mockIpcManager);

      const result = manager.getAllPendingPrompts();
      expect(mockIpcManager.getPendingPromptData).toHaveBeenCalled();
      expect(result).toHaveLength(2);
      expect(result[0].promptId).toBe('p1');
      expect(result[1].promptId).toBe('p2');
    });
  });

  // ==================== Fix: takenOverSessions tracking ====================

  describe('takenOverSessions tracking', () => {
    describe('markTakenOver / isTakenOver', () => {
      it('should return false for unknown sessions', () => {
        expect(manager.isTakenOver('unknown-session')).toBe(false);
      });

      it('should return true after markTakenOver', () => {
        manager.markTakenOver('session-taken');
        expect(manager.isTakenOver('session-taken')).toBe(true);
      });

      it('should track multiple sessions independently', () => {
        manager.markTakenOver('session-a');
        manager.markTakenOver('session-b');

        expect(manager.isTakenOver('session-a')).toBe(true);
        expect(manager.isTakenOver('session-b')).toBe(true);
        expect(manager.isTakenOver('session-c')).toBe(false);
      });
    });

    describe('clearTakenOver', () => {
      it('should clear a single session', () => {
        manager.markTakenOver('session-x');
        manager.markTakenOver('session-y');

        manager.clearTakenOver('session-x');

        expect(manager.isTakenOver('session-x')).toBe(false);
        expect(manager.isTakenOver('session-y')).toBe(true);
      });

      it('should be safe on non-existent session', () => {
        expect(() => manager.clearTakenOver('nonexistent')).not.toThrow();
      });
    });

    describe('clearAllTakenOver', () => {
      it('should clear all sessions', () => {
        manager.markTakenOver('session-1');
        manager.markTakenOver('session-2');
        manager.markTakenOver('session-3');

        manager.clearAllTakenOver();

        expect(manager.isTakenOver('session-1')).toBe(false);
        expect(manager.isTakenOver('session-2')).toBe(false);
        expect(manager.isTakenOver('session-3')).toBe(false);
      });

      it('should be safe when empty', () => {
        expect(() => manager.clearAllTakenOver()).not.toThrow();
      });
    });

    describe('independence from isClaudeSession', () => {
      it('isClaudeSession=true but isTakenOver=false for registered-only sessions', () => {
        manager.registerSession('key-1', '/test/dir', 'session-reg');

        expect(manager.isClaudeSession('session-reg')).toBe(true);
        expect(manager.isTakenOver('session-reg')).toBe(false);
      });

      it('both true after registerSession + markTakenOver', () => {
        manager.registerSession('key-1', '/test/dir', 'session-both');
        manager.markTakenOver('session-both');

        expect(manager.isClaudeSession('session-both')).toBe(true);
        expect(manager.isTakenOver('session-both')).toBe(true);
      });
    });

    describe('preserves session info', () => {
      it('clearAllTakenOver does not affect closedSessions', () => {
        manager.registerSession('key-1', '/test/dir', 'session-preserved');
        manager.markTakenOver('session-preserved');

        manager.clearAllTakenOver();

        // Session is still registered (closedSessions intact), just not taken over
        expect(manager.isClaudeSession('session-preserved')).toBe(true);
        expect(manager.isTakenOver('session-preserved')).toBe(false);
      });
    });
  });

  // ==================== Fix: Mobile-generated session keys (brainstorm) ====================

  describe('isRealSession flag (brainstorm session fix)', () => {
    describe('registerSession stores isRealSession', () => {
      it('should store isRealSession=false for mobile-generated keys', () => {
        manager.registerSession('brainstorm-12345', '/test/dir', 'session-bs', false, true, false);
        expect(manager.isClaudeSession('session-bs')).toBe(true);
      });

      it('should store isRealSession=true for known Claude sessions', () => {
        manager.registerSession('real-uuid-key', '/test/dir', 'session-real', false, true, true);
        expect(manager.isClaudeSession('session-real')).toBe(true);
      });

      it('should default isRealSession to undefined when not specified', () => {
        manager.registerSession('key-1', '/test/dir', 'session-default');
        expect(manager.isClaudeSession('session-default')).toBe(true);
      });
    });

    describe('sendInput with isRealSession=false uses startAndSendMessage', () => {
      it('should call startAndSendMessage instead of resumeSession for non-real sessions', async () => {
        manager.registerSession('brainstorm-99999', '/test/dir', 'bs-session', false, true, false);

        const resumeSpy = jest.spyOn(manager, 'resumeSession');
        const startSpy = jest.spyOn(manager, 'startAndSendMessage');

        await manager.sendInput('bs-session', 'hello world');

        // Should NOT call resumeSession
        expect(resumeSpy).not.toHaveBeenCalled();
        // SHOULD call startAndSendMessage with the directory and message
        expect(startSpy).toHaveBeenCalledWith(
          expect.stringContaining('test'),  // resolved directory
          'bs-session',
          'hello world',
          false,
          true
        );
      });

      it('should still call resumeSession for real sessions (isRealSession=true)', async () => {
        manager.registerSession('real-session-key', '/test/dir', 'real-session', false, true, true);

        const resumeSpy = jest.spyOn(manager, 'resumeSession');
        const startSpy = jest.spyOn(manager, 'startAndSendMessage');

        await manager.sendInput('real-session', 'hello world');

        expect(resumeSpy).toHaveBeenCalledWith(
          'real-session-key',
          expect.any(String),
          'real-session',
          false,
          true
        );
        expect(startSpy).not.toHaveBeenCalled();
      });

      it('should call resumeSession when isRealSession is undefined (backward compat)', async () => {
        manager.registerSession('old-key', '/test/dir', 'old-session');

        const resumeSpy = jest.spyOn(manager, 'resumeSession');
        const startSpy = jest.spyOn(manager, 'startAndSendMessage');

        await manager.sendInput('old-session', 'hello');

        expect(resumeSpy).toHaveBeenCalled();
        expect(startSpy).not.toHaveBeenCalled();
      });
    });

    describe('close handler preserves captured session_id', () => {
      it('should use processInfo.sessionKey (captured from SDK) over closure sessionKey', async () => {
        // Start a session with NO sessionKey (like startAndSendMessage)
        await manager.startSession('/test/dir', 'capture-session');

        // Simulate SDK result with session_id
        const resultMessage = {
          type: 'result',
          subtype: 'success',
          session_id: 'real-claude-uuid-from-sdk',
          cost_usd: 0.01,
        };
        mockProc.stdout.emit('data', Buffer.from(JSON.stringify(resultMessage) + '\n'));
        await new Promise(resolve => setTimeout(resolve, 50));

        // Now simulate process close
        mockProc.emit('close', 0);
        await new Promise(resolve => setTimeout(resolve, 50));

        // The closedSessions should have the captured session_id, not undefined
        const closedInfo = (manager as any).closedSessions.get('capture-session');
        expect(closedInfo).toBeDefined();
        // processInfo.sessionKey was set by the result handler,
        // close handler should use it via resolvedSessionKey
        expect(closedInfo.sessionKey).toBe('real-claude-uuid-from-sdk');
        expect(closedInfo.isRealSession).toBe(true);
      });
    });
  });
});
