/**
 * Permission IPC Manager
 * Watches for permission request temp files created by the hook script,
 * emits events so the main process can forward them to mobile via WebSocket,
 * and writes response files when the mobile user responds.
 *
 * Communication flow:
 *   Hook Script (subprocess)          Main CLI Process
 *        |                                  |
 *        |-- Writes request.json ---------->| (IPC Manager watches temp dir)
 *        |                                  |-- Emits 'permission_prompt' event
 *        |                                  |        |
 *        |                                  |   (forwarded to mobile via WS)
 *        |                                  |        |
 *        |                                  |   (mobile user responds)
 *        |                                  |        |
 *        |   <-- Reads response.json -------| Writes response.json
 *        |                                  |
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface PendingPromptInfo {
  promptId: string;
  terminalSessionId: string;
  sessionKey?: string;
  timeoutId: NodeJS.Timeout;
}

interface PermissionPromptEvent {
  promptId: string;
  terminalSessionId: string;
  sessionKey?: string;
  toolName: string;
  toolInput: any;
  toolUseId: string;
}

/** Type-safe event signatures for PermissionIpcManager */
interface PermissionIpcManagerEvents {
  permission_prompt: [event: PermissionPromptEvent];
}

class PermissionIpcManager extends EventEmitter {
  private watchInterval: NodeJS.Timeout | null = null;
  private pendingPrompts: Map<string, PendingPromptInfo> = new Map();
  private readonly TIMEOUT_MS = 5 * 60 * 1000; // 5 minute timeout
  private readonly POLL_INTERVAL_MS = 200; // poll every 200ms
  private readonly TEMP_DIR = path.join(os.tmpdir(), 'forkoff-permissions');
  private processedFiles: Set<string> = new Set();

  /** Currently tracked terminal session ID */
  private terminalSessionId: string = '';
  /** Currently tracked session key */
  private sessionKey?: string;

  /** Type-safe emit for known events */
  public override emit<K extends keyof PermissionIpcManagerEvents>(
    event: K,
    ...args: PermissionIpcManagerEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  /** Type-safe on for known events */
  public override on<K extends keyof PermissionIpcManagerEvents>(
    event: K,
    listener: (...args: PermissionIpcManagerEvents[K]) => void,
  ): this {
    return super.on(event, listener);
  }

  /**
   * Start watching the temp directory for permission request files.
   * Ensures the temp dir exists and begins polling at POLL_INTERVAL_MS.
   *
   * @param terminalSessionId - The terminal session ID to attach to emitted events
   * @param sessionKey - Optional Claude session key for event payloads
   */
  start(terminalSessionId: string, sessionKey?: string): void {
    this.terminalSessionId = terminalSessionId;
    this.sessionKey = sessionKey;

    // Ensure temp directory exists
    try {
      fs.mkdirSync(this.TEMP_DIR, { recursive: true });
    } catch (err) {
      console.log(`[Permission IPC] Failed to create temp dir ${this.TEMP_DIR}: ${(err as Error).message}`);
    }

    // Clear any existing interval before starting a new one
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
    }

    console.log(`[Permission IPC] Started watching ${this.TEMP_DIR} for permission requests`);
    this.watchInterval = setInterval(() => this.checkForRequests(), this.POLL_INTERVAL_MS);
  }

  /**
   * Stop watching for permission requests.
   * Clears the polling interval, all pending prompt timeouts, and resets internal state.
   */
  stop(): void {
    // Clear polling interval
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
    }

    // Clear all pending prompt timeouts
    for (const [, info] of this.pendingPrompts) {
      clearTimeout(info.timeoutId);
    }
    this.pendingPrompts.clear();

    // Clean up processed files tracking
    this.processedFiles.clear();

    console.log('[Permission IPC] Stopped watching for permission requests');
  }

  /**
   * Handle a response from the mobile user for a pending permission prompt.
   * Writes a response JSON file that the hook script polls for.
   *
   * @param promptId - The unique prompt identifier to respond to
   * @param decision - Whether to allow or deny the permission request
   * @param reason - Optional reason for the decision
   */
  handleResponse(promptId: string, decision: 'allow' | 'deny', reason?: string): void {
    const pending = this.pendingPrompts.get(promptId);
    if (!pending) {
      console.log(`[Permission IPC] No pending prompt found for ${promptId}`);
      return;
    }

    // Clear the timeout for this prompt
    clearTimeout(pending.timeoutId);
    this.pendingPrompts.delete(promptId);

    // Write response file for the hook script to read
    const responseFile = path.join(this.TEMP_DIR, `${promptId}.response.json`);
    const responseData: { decision: string; reason?: string } = { decision };
    if (reason) {
      responseData.reason = reason;
    }

    try {
      fs.writeFileSync(responseFile, JSON.stringify(responseData), 'utf-8');
      console.log(`[Permission IPC] Wrote response for ${promptId}: ${decision}${reason ? ` (${reason})` : ''}`);
    } catch (err) {
      console.log(`[Permission IPC] Failed to write response file ${responseFile}: ${(err as Error).message}`);
    }
  }

  /**
   * Poll the temp directory for new permission request files.
   * Filters for .request.json files that haven't been processed yet.
   * For each new request, parses it, sets up a timeout, and emits a permission_prompt event.
   */
  private checkForRequests(): void {
    let files: string[];
    try {
      files = fs.readdirSync(this.TEMP_DIR);
    } catch (err) {
      // Temp dir might not exist yet or was cleaned up — that's fine
      return;
    }

    // Filter for request files we haven't processed yet
    const requestFiles = files.filter(
      (f) => f.endsWith('.request.json') && !this.processedFiles.has(f),
    );

    for (const file of requestFiles) {
      const filePath = path.join(this.TEMP_DIR, file);

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const request = JSON.parse(content);

        // Mark as processed to avoid duplicate handling
        this.processedFiles.add(file);

        const promptId = request.promptId || file.replace('.request.json', '');
        const toolName = request.toolName || 'unknown';
        const toolInput = request.toolInput || {};
        const toolUseId = request.toolUseId || '';

        // Set up timeout for auto-deny
        const timeoutId = setTimeout(
          () => this.handleTimeout(promptId),
          this.TIMEOUT_MS,
        );

        // Track the pending prompt
        this.pendingPrompts.set(promptId, {
          promptId,
          terminalSessionId: this.terminalSessionId,
          sessionKey: this.sessionKey,
          timeoutId,
        });

        // Build and emit the permission prompt event
        const event: PermissionPromptEvent = {
          promptId,
          terminalSessionId: this.terminalSessionId,
          sessionKey: this.sessionKey,
          toolName,
          toolInput,
          toolUseId,
        };

        console.log(`[Permission IPC] New permission request: ${promptId} - ${toolName}`);
        this.emit('permission_prompt', event);
      } catch (err) {
        // File might be partially written or malformed — skip it for now
        // but add to processed so we don't retry every poll cycle
        this.processedFiles.add(file);
        console.log(`[Permission IPC] Failed to read request file ${file}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Handle a prompt that has timed out waiting for a mobile response.
   * Auto-denies the request with a timeout reason.
   *
   * @param promptId - The prompt ID that timed out
   */
  private handleTimeout(promptId: string): void {
    console.log(`[Permission IPC] Prompt ${promptId} timed out after ${this.TIMEOUT_MS / 1000}s`);
    this.handleResponse(promptId, 'deny', 'Timed out waiting for mobile response');
  }

  /**
   * Full cleanup: stop watching and remove any remaining temp files.
   * Call this when the CLI process is shutting down.
   */
  cleanup(): void {
    this.stop();

    // Try to clean up remaining temp files in the directory
    try {
      const files = fs.readdirSync(this.TEMP_DIR);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(this.TEMP_DIR, file));
        } catch (err) {
          // File may already be deleted by the hook script — ignore
        }
      }
      console.log(`[Permission IPC] Cleaned up ${files.length} temp file(s)`);
    } catch (err) {
      // Directory might not exist — that's fine
      console.log(`[Permission IPC] Temp dir cleanup skipped: ${(err as Error).message}`);
    }
  }
  /**
   * Remove all regular files from the forkoff-permissions temp directory.
   * Call on startup to clean up files left behind by a crashed CLI process.
   */
  static cleanupStaleTempFiles(): void {
    const tempDir = path.join(os.tmpdir(), 'forkoff-permissions');
    let files: string[];
    try {
      files = fs.readdirSync(tempDir);
    } catch {
      // Directory doesn't exist — nothing to clean
      return;
    }

    let cleaned = 0;
    for (const file of files) {
      const filePath = path.join(tempDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch {
        // File may have been removed concurrently — ignore
      }
    }

    if (cleaned > 0) {
      console.log(`[Permission IPC] Cleaned up ${cleaned} stale temp file(s) on startup`);
    }
  }
}

export { PermissionIpcManager, PermissionPromptEvent, PendingPromptInfo };
