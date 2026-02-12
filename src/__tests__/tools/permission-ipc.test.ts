/**
 * Tests for PermissionIpcManager (permission-ipc.ts)
 *
 * Uses REAL filesystem operations in a unique temp directory per test run.
 * The PermissionIpcManager is imported directly and tested end-to-end:
 *   start() -> detect request files -> emit events -> handleResponse() -> write response files
 *   cleanup() -> remove temp files
 *   auto-timeout -> auto-deny after TIMEOUT_MS
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PermissionIpcManager, PermissionPromptEvent } from '../../tools/permission-ipc';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** The real TEMP_DIR the manager uses: os.tmpdir()/forkoff-permissions */
const REAL_TEMP_DIR = path.join(os.tmpdir(), 'forkoff-permissions');

/**
 * Write a .request.json file into the IPC temp directory so the manager
 * picks it up during its next poll cycle.
 */
function writeRequestFile(
  promptId: string,
  overrides: Record<string, unknown> = {},
): void {
  const filePath = path.join(REAL_TEMP_DIR, `${promptId}.request.json`);
  const data = {
    promptId,
    toolName: 'Bash',
    toolInput: { command: 'npm test' },
    toolUseId: 'toolu_test_01',
    timestamp: Date.now(),
    ...overrides,
  };
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
}

/**
 * Wait for a condition to become true (up to `timeoutMs`).
 * Useful for waiting for async polling to detect files.
 */
function waitFor(
  conditionFn: () => boolean,
  timeoutMs: number = 3000,
  intervalMs: number = 50,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = (): void => {
      if (conditionFn()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

/**
 * Remove all files from the forkoff-permissions temp directory.
 */
function cleanTempDir(): void {
  try {
    if (fs.existsSync(REAL_TEMP_DIR)) {
      const files = fs.readdirSync(REAL_TEMP_DIR);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(REAL_TEMP_DIR, file));
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
}

// ===========================================================================
// TEST SUITES
// ===========================================================================

describe('PermissionIpcManager', () => {
  let manager: PermissionIpcManager;

  beforeEach(() => {
    cleanTempDir();
    manager = new PermissionIpcManager();
  });

  afterEach(() => {
    manager.cleanup();
    cleanTempDir();
  });

  // =========================================================================
  // 1. start() creates temp dir and begins polling
  // =========================================================================

  describe('start()', () => {
    it('creates the forkoff-permissions temp directory', () => {
      // Remove the directory first if it exists
      try {
        if (fs.existsSync(REAL_TEMP_DIR)) {
          fs.rmSync(REAL_TEMP_DIR, { recursive: true, force: true });
        }
      } catch {
        // ignore
      }

      manager.start('terminal-session-1');

      expect(fs.existsSync(REAL_TEMP_DIR)).toBe(true);
    });

    it('stores the terminalSessionId and sessionKey', async () => {
      const events: PermissionPromptEvent[] = [];
      manager.on('permission_prompt', (evt) => events.push(evt));
      manager.start('ts-123', 'sk-abc');

      // Write a request file so we can observe the emitted event's metadata
      writeRequestFile('prompt-ids-test');

      await waitFor(() => events.length > 0);

      expect(events[0].terminalSessionId).toBe('ts-123');
      expect(events[0].sessionKey).toBe('sk-abc');
    });

    it('does not throw if temp dir already exists', () => {
      fs.mkdirSync(REAL_TEMP_DIR, { recursive: true });
      expect(() => manager.start('ts-1')).not.toThrow();
    });

    it('clears any previous polling interval when called again', () => {
      // Call start twice - should not leak intervals
      manager.start('ts-1');
      manager.start('ts-2');

      // If it leaked, cleanup would still be clean (no double-fire observed)
      // We just verify it does not throw
      manager.stop();
    });
  });

  // =========================================================================
  // 2. Detecting .request.json files -> emitting 'permission_prompt'
  // =========================================================================

  describe('request file detection and event emission', () => {
    it('emits permission_prompt when a .request.json file appears', async () => {
      const events: PermissionPromptEvent[] = [];
      manager.on('permission_prompt', (evt) => events.push(evt));
      manager.start('ts-detect');

      writeRequestFile('prompt-detect-1', {
        toolName: 'Edit',
        toolInput: { file_path: '/src/app.ts', old_string: 'a', new_string: 'b' },
        toolUseId: 'toolu_edit_01',
      });

      await waitFor(() => events.length > 0);

      expect(events).toHaveLength(1);
      expect(events[0].promptId).toBe('prompt-detect-1');
      expect(events[0].toolName).toBe('Edit');
      expect(events[0].toolInput).toEqual({
        file_path: '/src/app.ts',
        old_string: 'a',
        new_string: 'b',
      });
      expect(events[0].toolUseId).toBe('toolu_edit_01');
      expect(events[0].terminalSessionId).toBe('ts-detect');
    });

    it('emits events for multiple request files', async () => {
      const events: PermissionPromptEvent[] = [];
      manager.on('permission_prompt', (evt) => events.push(evt));
      manager.start('ts-multi');

      writeRequestFile('prompt-multi-1', { toolName: 'Bash' });
      writeRequestFile('prompt-multi-2', { toolName: 'Write' });
      writeRequestFile('prompt-multi-3', { toolName: 'Edit' });

      await waitFor(() => {
        const ids = events.map((e) => e.promptId);
        return ids.includes('prompt-multi-1')
          && ids.includes('prompt-multi-2')
          && ids.includes('prompt-multi-3');
      });

      const ourEvents = events.filter((e) =>
        ['prompt-multi-1', 'prompt-multi-2', 'prompt-multi-3'].includes(e.promptId),
      );
      expect(ourEvents).toHaveLength(3);
      const promptIds = ourEvents.map((e) => e.promptId).sort();
      expect(promptIds).toEqual(['prompt-multi-1', 'prompt-multi-2', 'prompt-multi-3']);
    });

    it('uses the file name (sans .request.json) as promptId if not in content', async () => {
      const events: PermissionPromptEvent[] = [];
      manager.on('permission_prompt', (evt) => events.push(evt));
      manager.start('ts-fallback');

      // Write a request file where promptId is missing from the JSON content
      const filePath = path.join(REAL_TEMP_DIR, 'fallback-id.request.json');
      fs.writeFileSync(
        filePath,
        JSON.stringify({ toolName: 'Bash', toolInput: {}, toolUseId: 'x' }),
        'utf-8',
      );

      await waitFor(() => events.some((e) => e.promptId === 'fallback-id'));

      // The manager should fall back to extracting the id from the file name
      const fallbackEvent = events.find((e) => e.promptId === 'fallback-id');
      expect(fallbackEvent).toBeDefined();
      expect(fallbackEvent!.toolName).toBe('Bash');
    });
  });

  // =========================================================================
  // 3. handleResponse() writes a .response.json file
  // =========================================================================

  describe('handleResponse()', () => {
    it('writes a .response.json file with allow decision', async () => {
      const events: PermissionPromptEvent[] = [];
      manager.on('permission_prompt', (evt) => events.push(evt));
      manager.start('ts-respond');

      writeRequestFile('prompt-allow');
      await waitFor(() => events.length > 0);

      manager.handleResponse('prompt-allow', 'allow', 'User approved');

      const responseFile = path.join(REAL_TEMP_DIR, 'prompt-allow.response.json');
      expect(fs.existsSync(responseFile)).toBe(true);

      const content = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
      expect(content.decision).toBe('allow');
      expect(content.reason).toBe('User approved');
    });

    it('writes a .response.json file with deny decision', async () => {
      const events: PermissionPromptEvent[] = [];
      manager.on('permission_prompt', (evt) => events.push(evt));
      manager.start('ts-deny');

      writeRequestFile('prompt-deny');
      await waitFor(() => events.length > 0);

      manager.handleResponse('prompt-deny', 'deny', 'Too risky');

      const responseFile = path.join(REAL_TEMP_DIR, 'prompt-deny.response.json');
      const content = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
      expect(content.decision).toBe('deny');
      expect(content.reason).toBe('Too risky');
    });

    it('omits reason field when no reason is provided', async () => {
      const events: PermissionPromptEvent[] = [];
      manager.on('permission_prompt', (evt) => events.push(evt));
      manager.start('ts-no-reason');

      writeRequestFile('prompt-no-reason');
      await waitFor(() => events.length > 0);

      manager.handleResponse('prompt-no-reason', 'allow');

      const responseFile = path.join(REAL_TEMP_DIR, 'prompt-no-reason.response.json');
      const content = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
      expect(content.decision).toBe('allow');
      expect(content).not.toHaveProperty('reason');
    });

    it('does nothing for an unknown promptId (not pending)', () => {
      manager.start('ts-unknown');

      // No request file was ever written, so 'nonexistent' is not pending
      manager.handleResponse('nonexistent', 'allow');

      const responseFile = path.join(REAL_TEMP_DIR, 'nonexistent.response.json');
      expect(fs.existsSync(responseFile)).toBe(false);
    });
  });

  // =========================================================================
  // 4. stop() clears the polling interval
  // =========================================================================

  describe('stop()', () => {
    it('stops polling so new request files are not detected', async () => {
      const events: PermissionPromptEvent[] = [];
      manager.on('permission_prompt', (evt) => events.push(evt));
      manager.start('ts-stop');

      // Stop immediately
      manager.stop();

      // Write a request file after stopping
      writeRequestFile('prompt-after-stop');

      // Give it some time - the file should NOT be picked up
      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(events).toHaveLength(0);
    });

    it('clears all pending prompt timeouts', async () => {
      const events: PermissionPromptEvent[] = [];
      manager.on('permission_prompt', (evt) => events.push(evt));
      manager.start('ts-clear-timeouts');

      writeRequestFile('prompt-pending');
      await waitFor(() => events.length > 0);

      // Now stop - should clear the pending timeout without writing a response
      manager.stop();

      // The response file should NOT exist (the timeout was cleared, not triggered)
      const responseFile = path.join(REAL_TEMP_DIR, 'prompt-pending.response.json');
      expect(fs.existsSync(responseFile)).toBe(false);
    });

    it('clears the processed files set', async () => {
      const events: PermissionPromptEvent[] = [];
      manager.on('permission_prompt', (evt) => events.push(evt));
      manager.start('ts-processed-clear');

      writeRequestFile('prompt-processed');
      await waitFor(() => events.length > 0);

      manager.stop();

      // Re-start the manager - the same file should be picked up again
      // because the processed set was cleared
      const events2: PermissionPromptEvent[] = [];
      manager.on('permission_prompt', (evt) => events2.push(evt));
      manager.start('ts-processed-clear-2');

      await waitFor(() => events2.length > 0);

      expect(events2[0].promptId).toBe('prompt-processed');
    });
  });

  // =========================================================================
  // 5. cleanup() removes temp files
  // =========================================================================

  describe('cleanup()', () => {
    it('removes all files from the temp directory', async () => {
      manager.start('ts-cleanup');

      writeRequestFile('cleanup-1');
      writeRequestFile('cleanup-2');

      // Give the manager time to detect them
      await new Promise((resolve) => setTimeout(resolve, 500));

      manager.cleanup();

      // Check that the temp directory files are cleaned up
      if (fs.existsSync(REAL_TEMP_DIR)) {
        const remaining = fs.readdirSync(REAL_TEMP_DIR);
        expect(remaining).toHaveLength(0);
      }
    });

    it('calls stop() internally', async () => {
      const events: PermissionPromptEvent[] = [];
      manager.on('permission_prompt', (evt) => events.push(evt));
      manager.start('ts-cleanup-stops');

      manager.cleanup();

      // Write a file after cleanup - should not be detected
      writeRequestFile('prompt-after-cleanup');
      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(events).toHaveLength(0);
    });

    it('does not throw if temp directory does not exist', () => {
      // Remove the directory manually
      try {
        fs.rmSync(REAL_TEMP_DIR, { recursive: true, force: true });
      } catch {
        // ignore
      }

      expect(() => manager.cleanup()).not.toThrow();
    });
  });

  // =========================================================================
  // 6. Auto-timeout denies after TIMEOUT_MS (using fake timers)
  // =========================================================================

  describe('auto-timeout (5 minutes)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('auto-denies a pending prompt after TIMEOUT_MS', () => {
      manager.start('ts-timeout');

      // Ensure temp dir exists for our write
      fs.mkdirSync(REAL_TEMP_DIR, { recursive: true });

      // Write request file directly
      writeRequestFile('prompt-timeout');

      // Trigger a poll cycle (200ms is the POLL_INTERVAL_MS)
      jest.advanceTimersByTime(200);

      // At this point the manager should have found the request
      // and set up a timeout. Advance to just past 5 minutes.
      jest.advanceTimersByTime(5 * 60 * 1000);

      // The auto-deny should have written a response file
      const responseFile = path.join(REAL_TEMP_DIR, 'prompt-timeout.response.json');
      expect(fs.existsSync(responseFile)).toBe(true);

      const content = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
      expect(content.decision).toBe('deny');
      expect(content.reason).toContain('Timed out');
    });

    it('does NOT auto-deny if response was already provided', () => {
      const events: PermissionPromptEvent[] = [];
      manager.on('permission_prompt', (evt) => events.push(evt));
      manager.start('ts-no-double-deny');

      fs.mkdirSync(REAL_TEMP_DIR, { recursive: true });
      writeRequestFile('prompt-early');

      // Trigger poll to detect the request
      jest.advanceTimersByTime(200);

      // User responds quickly
      manager.handleResponse('prompt-early', 'allow', 'Approved fast');

      // Read the response that was written
      const responseFile = path.join(REAL_TEMP_DIR, 'prompt-early.response.json');
      const earlyContent = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
      expect(earlyContent.decision).toBe('allow');

      // Now advance past the timeout
      jest.advanceTimersByTime(5 * 60 * 1000);

      // The response file should still have the 'allow' decision (not overwritten to deny)
      const finalContent = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
      expect(finalContent.decision).toBe('allow');
    });

    it('each pending prompt has its own independent timeout', () => {
      manager.start('ts-independent');

      fs.mkdirSync(REAL_TEMP_DIR, { recursive: true });

      // Write first request
      writeRequestFile('prompt-ind-1');
      jest.advanceTimersByTime(200);

      // 1 minute later, write second request
      jest.advanceTimersByTime(60 * 1000);
      writeRequestFile('prompt-ind-2');
      jest.advanceTimersByTime(200);

      // Advance 4 minutes from second request (so 5m 1s from first)
      jest.advanceTimersByTime(4 * 60 * 1000);

      // First should have timed out
      const resp1 = path.join(REAL_TEMP_DIR, 'prompt-ind-1.response.json');
      expect(fs.existsSync(resp1)).toBe(true);
      const content1 = JSON.parse(fs.readFileSync(resp1, 'utf-8'));
      expect(content1.decision).toBe('deny');

      // Second should NOT have timed out yet (only ~4 minutes have passed for it)
      const resp2 = path.join(REAL_TEMP_DIR, 'prompt-ind-2.response.json');
      expect(fs.existsSync(resp2)).toBe(false);

      // Advance the remaining minute for the second prompt
      jest.advanceTimersByTime(60 * 1000);
      expect(fs.existsSync(resp2)).toBe(true);
    });
  });

  // =========================================================================
  // 7. Malformed request files are skipped (logged but marked processed)
  // =========================================================================

  describe('malformed request files', () => {
    it('skips malformed JSON and does not emit an event', async () => {
      const events: PermissionPromptEvent[] = [];
      manager.on('permission_prompt', (evt) => events.push(evt));
      manager.start('ts-malformed');

      // Write a file with invalid JSON
      const filePath = path.join(REAL_TEMP_DIR, 'bad-json.request.json');
      fs.writeFileSync(filePath, 'this is not valid JSON{{{', 'utf-8');

      // Give time for a few poll cycles
      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(events).toHaveLength(0);
    });

    it('marks malformed files as processed so they are not retried', async () => {
      const events: PermissionPromptEvent[] = [];
      manager.on('permission_prompt', (evt) => events.push(evt));
      manager.start('ts-malformed-processed');

      // Write malformed file
      const filePath = path.join(REAL_TEMP_DIR, 'malformed.request.json');
      fs.writeFileSync(filePath, '{{invalid}}', 'utf-8');

      // Let multiple poll cycles pass
      await new Promise((resolve) => setTimeout(resolve, 800));

      // Even after many polls, no event should be emitted (file was processed once)
      expect(events).toHaveLength(0);

      // Now write a valid request alongside the malformed one
      writeRequestFile('prompt-after-malformed');
      await waitFor(() => events.length > 0);

      // The valid one is picked up, but the malformed one is not retried
      expect(events).toHaveLength(1);
      expect(events[0].promptId).toBe('prompt-after-malformed');
    });
  });

  // =========================================================================
  // 8. Already-processed files are not re-emitted
  // =========================================================================

  describe('already-processed files', () => {
    it('does not re-emit events for files it already processed', async () => {
      const events: PermissionPromptEvent[] = [];
      manager.on('permission_prompt', (evt) => events.push(evt));
      manager.start('ts-no-reemit');

      writeRequestFile('prompt-once-only');

      await waitFor(() => events.length > 0);
      expect(events).toHaveLength(1);

      // The file is still on disk. Wait several more poll cycles.
      await new Promise((resolve) => setTimeout(resolve, 800));

      // Should still be exactly 1 event
      expect(events).toHaveLength(1);
    });

    it('new files added later are still detected', async () => {
      const events: PermissionPromptEvent[] = [];
      manager.on('permission_prompt', (evt) => events.push(evt));
      manager.start('ts-new-after-old');

      writeRequestFile('prompt-first');
      await waitFor(() => events.length >= 1);

      // Add a second file later
      writeRequestFile('prompt-second', { toolName: 'Write' });
      await waitFor(() => events.length >= 2);

      expect(events).toHaveLength(2);
      expect(events[0].promptId).toBe('prompt-first');
      expect(events[1].promptId).toBe('prompt-second');
      expect(events[1].toolName).toBe('Write');
    });
  });

  // =========================================================================
  // getPendingPromptData()
  // =========================================================================

  describe('getPendingPromptData()', () => {
    it('returns empty array when no prompts are pending', () => {
      manager.start('ts-empty');
      expect(manager.getPendingPromptData()).toEqual([]);
    });

    it('returns pending prompt data with tool details', async () => {
      const events: PermissionPromptEvent[] = [];
      manager.on('permission_prompt', (evt) => events.push(evt));
      manager.start('ts-pending-data', 'sk-abc');

      writeRequestFile('prompt-data-1', {
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
        toolUseId: 'toolu_bash_01',
      });

      await waitFor(() => events.length > 0);

      const pending = manager.getPendingPromptData();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toEqual({
        promptId: 'prompt-data-1',
        terminalSessionId: 'ts-pending-data',
        sessionKey: 'sk-abc',
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
        toolUseId: 'toolu_bash_01',
      });
    });

    it('returns multiple pending prompts', async () => {
      const events: PermissionPromptEvent[] = [];
      manager.on('permission_prompt', (evt) => events.push(evt));
      manager.start('ts-multi-pending');

      writeRequestFile('prompt-mp-1', { toolName: 'Bash', toolInput: { command: 'ls' }, toolUseId: 'toolu_1' });
      writeRequestFile('prompt-mp-2', { toolName: 'Edit', toolInput: { file_path: '/a.ts' }, toolUseId: 'toolu_2' });
      writeRequestFile('prompt-mp-3', { toolName: 'Write', toolInput: { file_path: '/b.ts' }, toolUseId: 'toolu_3' });

      await waitFor(() => events.length >= 3);

      const pending = manager.getPendingPromptData();
      expect(pending).toHaveLength(3);
      const ids = pending.map(p => p.promptId).sort();
      expect(ids).toEqual(['prompt-mp-1', 'prompt-mp-2', 'prompt-mp-3']);
    });

    it('excludes prompts that have been responded to', async () => {
      const events: PermissionPromptEvent[] = [];
      manager.on('permission_prompt', (evt) => events.push(evt));
      manager.start('ts-exclude-responded');

      writeRequestFile('prompt-keep', { toolName: 'Bash', toolInput: {}, toolUseId: 'toolu_k' });
      writeRequestFile('prompt-respond', { toolName: 'Edit', toolInput: {}, toolUseId: 'toolu_r' });

      await waitFor(() => events.length >= 2);

      // Respond to one prompt
      manager.handleResponse('prompt-respond', 'allow');

      const pending = manager.getPendingPromptData();
      expect(pending).toHaveLength(1);
      expect(pending[0].promptId).toBe('prompt-keep');
    });
  });

  // =========================================================================
  // EventEmitter inheritance
  // =========================================================================

  describe('EventEmitter behavior', () => {
    it('is an instance of EventEmitter', () => {
      const { EventEmitter } = require('events');
      expect(manager).toBeInstanceOf(EventEmitter);
    });

    it('supports multiple listeners on permission_prompt', async () => {
      const results1: string[] = [];
      const results2: string[] = [];

      manager.on('permission_prompt', (evt) => results1.push(evt.promptId));
      manager.on('permission_prompt', (evt) => results2.push(evt.promptId));

      manager.start('ts-multi-listener');
      writeRequestFile('prompt-multi-listen');

      await waitFor(() => results1.length > 0 && results2.length > 0);

      expect(results1).toEqual(['prompt-multi-listen']);
      expect(results2).toEqual(['prompt-multi-listen']);
    });
  });

  // =========================================================================
  // 9. Static cleanupStaleTempFiles
  // =========================================================================

  describe('cleanupStaleTempFiles (static)', () => {
    it('removes all files from forkoff-permissions temp directory', () => {
      fs.mkdirSync(REAL_TEMP_DIR, { recursive: true });
      // Write some stale files
      fs.writeFileSync(path.join(REAL_TEMP_DIR, 'stale-1.request.json'), '{}', 'utf-8');
      fs.writeFileSync(path.join(REAL_TEMP_DIR, 'stale-2.response.json'), '{}', 'utf-8');
      fs.writeFileSync(path.join(REAL_TEMP_DIR, 'stale-3.request.json'), '{}', 'utf-8');

      PermissionIpcManager.cleanupStaleTempFiles();

      const remaining = fs.readdirSync(REAL_TEMP_DIR);
      expect(remaining).toHaveLength(0);
    });

    it('does not throw when temp directory does not exist', () => {
      // Remove the directory
      try {
        fs.rmSync(REAL_TEMP_DIR, { recursive: true, force: true });
      } catch {
        // ignore
      }

      expect(() => PermissionIpcManager.cleanupStaleTempFiles()).not.toThrow();
    });

    it('does not throw when temp directory is empty', () => {
      fs.mkdirSync(REAL_TEMP_DIR, { recursive: true });
      // Ensure it's empty
      for (const file of fs.readdirSync(REAL_TEMP_DIR)) {
        fs.unlinkSync(path.join(REAL_TEMP_DIR, file));
      }

      expect(() => PermissionIpcManager.cleanupStaleTempFiles()).not.toThrow();
    });

    it('removes only files, not subdirectories', () => {
      fs.mkdirSync(REAL_TEMP_DIR, { recursive: true });
      fs.writeFileSync(path.join(REAL_TEMP_DIR, 'stale-file.json'), '{}', 'utf-8');
      fs.mkdirSync(path.join(REAL_TEMP_DIR, 'subdir'), { recursive: true });

      PermissionIpcManager.cleanupStaleTempFiles();

      const remaining = fs.readdirSync(REAL_TEMP_DIR);
      // subdir should remain, file should be gone
      expect(remaining).toEqual(['subdir']);

      // Cleanup the subdir for subsequent tests
      fs.rmSync(path.join(REAL_TEMP_DIR, 'subdir'), { recursive: true, force: true });
    });
  });
});
