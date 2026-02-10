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
      it('should NOT include --dangerouslySkipPermissions when flag is false', async () => {
        await manager.startSession('/test/dir', 'session-1', false);

        expect(mockSpawn).toHaveBeenCalledTimes(1);
        const args = mockSpawn.mock.calls[0][1];
        expect(args).not.toContain('--dangerouslySkipPermissions');
      });

      it('should NOT include --dangerouslySkipPermissions when flag is undefined', async () => {
        await manager.startSession('/test/dir', 'session-1');

        expect(mockSpawn).toHaveBeenCalledTimes(1);
        const args = mockSpawn.mock.calls[0][1];
        expect(args).not.toContain('--dangerouslySkipPermissions');
      });

      it('should include --dangerouslySkipPermissions when flag is true', async () => {
        await manager.startSession('/test/dir', 'session-1', true);

        expect(mockSpawn).toHaveBeenCalledTimes(1);
        const args = mockSpawn.mock.calls[0][1];
        expect(args).toContain('--dangerouslySkipPermissions');
      });
    });

    describe('resumeSession', () => {
      it('should use --permission-mode acceptEdits when flag is false', async () => {
        await manager.resumeSession('key-1', '/test/dir', 'session-1', false);

        const args = mockSpawn.mock.calls[0][1];
        expect(args).toContain('--permission-mode');
        expect(args).toContain('acceptEdits');
        expect(args).not.toContain('--dangerouslySkipPermissions');
      });

      it('should use --dangerouslySkipPermissions instead of --permission-mode when flag is true', async () => {
        await manager.resumeSession('key-1', '/test/dir', 'session-1', true);

        const args = mockSpawn.mock.calls[0][1];
        expect(args).toContain('--dangerouslySkipPermissions');
        expect(args).not.toContain('--permission-mode');
        expect(args).not.toContain('acceptEdits');
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
          true
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
          undefined
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
});
