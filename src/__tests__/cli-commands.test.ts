/**
 * Tests for CLI commands: help, unknown command, version
 * Uses createProgram() exported from index.ts
 */

// Mock all heavy dependencies so importing index.ts doesn't trigger real connections
jest.mock('../config', () => ({
  config: {
    deviceId: null,
    deviceName: 'test',
    apiUrl: 'http://localhost:3000',
    wsUrl: 'ws://localhost:3000',
    pairingCode: null,
    pairedAt: null,
    userId: null,
    isPaired: false,
    startupEnabled: null,
    startupBinaryPath: null,
    getPath: () => '/tmp/config.json',
    reset: jest.fn(),
  },
}));

jest.mock('../api', () => ({
  api: {
    healthCheck: jest.fn(),
    registerDevice: jest.fn(),
    refreshPairingCode: jest.fn(),
    checkPairingStatus: jest.fn(),
    reportConnectedTools: jest.fn(),
  },
}));

jest.mock('../websocket', () => ({
  wsClient: {
    connect: jest.fn(),
    disconnect: jest.fn(),
    isConnected: false,
    on: jest.fn(),
    sendTerminalOutput: jest.fn(),
    sendTerminalCwd: jest.fn(),
    sendClaudeSessionUpdate: jest.fn(),
    sendClaudeSessions: jest.fn(),
    sendToolStatusUpdate: jest.fn(),
    sendDirectoryListResponse: jest.fn(),
    sendReadFileResponse: jest.fn(),
    sendTranscriptHistory: jest.fn(),
    sendTranscriptUpdate: jest.fn(),
    sendClaudeApprovalRequest: jest.fn(),
    sendToolActivity: jest.fn(),
    sendPermissionPrompt: jest.fn(),
    sendClaudeSessionEvent: jest.fn(),
    sendRpcResponse: jest.fn(),
    sendPendingPermissionsSync: jest.fn(),
    sendThinkingContent: jest.fn(),
    sendTokenUsage: jest.fn(),
    sendTaskProgress: jest.fn(),
  },
}));

jest.mock('../terminal', () => ({
  terminalManager: {
    on: jest.fn(),
    createSession: jest.fn(),
    executeCommand: jest.fn(),
  },
}));

jest.mock('../approval', () => ({
  approvalManager: {
    on: jest.fn(),
    handleApprovalResponse: jest.fn(),
  },
}));

jest.mock('../tools', () => ({
  toolDetector: { detectAll: jest.fn(), watchToolStatus: jest.fn() },
  claudeHooksManager: { canConfigure: jest.fn(), installHooks: jest.fn(), uninstallHooks: jest.fn(), isHookConfigured: jest.fn() },
  claudeSessionDetector: {
    isClaudeInstalled: jest.fn().mockReturnValue(false),
    scanSessions: jest.fn().mockReturnValue([]),
    getSessions: jest.fn().mockReturnValue([]),
    startWatching: jest.fn(),
    stopWatching: jest.fn(),
    seedKnownSessions: jest.fn(),
    on: jest.fn(),
  },
  claudeProcessManager: {
    isClaudeSession: jest.fn(),
    sendInput: jest.fn(),
    registerSession: jest.fn(),
    markTakenOver: jest.fn(),
    isTakenOver: jest.fn(),
    startSession: jest.fn(),
    startAndSendMessage: jest.fn(),
    handleApprovalResponse: jest.fn(),
    handlePermissionResponse: jest.fn(),
    updatePermissionRules: jest.fn(),
    clearAllTakenOver: jest.fn(),
    autoAllowAllPendingPrompts: jest.fn(),
    cleanupAllPermissionState: jest.fn(),
    getAllPendingPrompts: jest.fn().mockReturnValue([]),
    on: jest.fn(),
  },
  PermissionIpcManager: {
    cleanupStaleTempFiles: jest.fn(),
  },
}));

jest.mock('../transcript-streamer', () => ({
  transcriptStreamer: {
    fetchHistory: jest.fn(),
    subscribeToUpdates: jest.fn(),
    unsubscribeFromUpdates: jest.fn(),
    cleanup: jest.fn(),
    on: jest.fn(),
  },
}));

jest.mock('../logger', () => ({
  setQuiet: jest.fn(),
  createSpinner: jest.fn(() => ({
    start: jest.fn().mockReturnThis(),
    stop: jest.fn(),
    succeed: jest.fn(),
    fail: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    text: '',
  })),
}));

jest.mock('chalk', () => {
  const handler: ProxyHandler<any> = {
    get: () => new Proxy((s: string) => s, handler),
    apply: (_target: any, _thisArg: any, args: any[]) => args[0],
  };
  return new Proxy((s: string) => s, handler);
});

jest.mock('qrcode-terminal', () => ({
  generate: jest.fn(),
}));

jest.mock('../startup', () => ({
  enableStartup: jest.fn(),
  disableStartup: jest.fn(),
  isStartupRegistered: jest.fn().mockReturnValue(false),
  getBinaryPath: jest.fn().mockReturnValue('/usr/local/bin/forkoff'),
}));

import { createProgram } from '../index';

describe('CLI commands', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    process.exitCode = undefined as any;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    process.exitCode = undefined as any;
  });

  describe('help command', () => {
    it('outputs available commands', async () => {
      const program = createProgram();
      // Prevent commander from calling process.exit on help
      program.exitOverride();

      let helpOutput = '';
      program.configureOutput({
        writeOut: (str) => { helpOutput += str; },
        writeErr: (str) => { helpOutput += str; },
      });

      try {
        await program.parseAsync(['node', 'forkoff', 'help']);
      } catch {
        // Commander throws on exitOverride
      }

      // The help action calls program.outputHelp(), check console.log calls
      const allOutput = helpOutput + consoleLogSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
      expect(allOutput).toContain('pair');
      expect(allOutput).toContain('connect');
      expect(allOutput).toContain('disconnect');
      expect(allOutput).toContain('status');
      expect(allOutput).toContain('startup');
      expect(allOutput).toContain('config');
      expect(allOutput).toContain('tools');
      expect(allOutput).toContain('help');
    });
  });

  describe('--version flag', () => {
    it('shows version from package.json', async () => {
      const program = createProgram();
      program.exitOverride();

      let versionOutput = '';
      program.configureOutput({
        writeOut: (str) => { versionOutput += str; },
        writeErr: (str) => { versionOutput += str; },
      });

      try {
        await program.parseAsync(['node', 'forkoff', '--version']);
      } catch {
        // Commander throws on exitOverride
      }

      const pkg = require('../../package.json');
      expect(versionOutput).toContain(pkg.version);
    });
  });

  describe('unknown command', () => {
    it('sets process.exitCode = 1 and shows error message', async () => {
      const program = createProgram();

      await program.parseAsync(['node', 'forkoff', 'gibberish']);

      expect(process.exitCode).toBe(1);
      const errorOutput = consoleErrorSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
      expect(errorOutput).toContain('Unknown command: gibberish');
    });
  });
});
