/**
 * Claude Process Manager
 * Spawns and manages Claude CLI processes for terminal sessions
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';

interface ClaudeProcessInfo {
  terminalSessionId: string;
  process: ChildProcess;
  directory: string;
  sessionKey?: string;
}

interface ProcessOutputEvent {
  terminalSessionId: string;
  output: string;
  type: 'stdout' | 'stderr' | 'exit';
  exitCode?: number;
}

interface SessionEndedEvent {
  terminalSessionId: string;
  directory: string;
  sessionKey?: string;
  exitCode: number;
}

class ClaudeProcessManager extends EventEmitter {
  private processes: Map<string, ClaudeProcessInfo> = new Map();

  /**
   * Start a new Claude session in the specified directory
   */
  async startSession(directory: string, terminalSessionId: string): Promise<{ cwd: string }> {
    const resolvedDir = this.resolvePath(directory);

    // SDK flags for structured JSON communication
    const args = [
      '--output-format', 'stream-json', // JSONL output from Claude
      '--input-format', 'stream-json',  // JSONL input to Claude
      '--verbose',                      // Complete messages
    ];

    const proc = spawn('claude', args, {
      cwd: resolvedDir,
      env: { ...process.env, TERM: 'xterm-256color' },
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.setupProcessHandlers(terminalSessionId, proc, resolvedDir);
    this.processes.set(terminalSessionId, { terminalSessionId, process: proc, directory: resolvedDir });

    return { cwd: resolvedDir };
  }

  /**
   * Resume an existing Claude session
   */
  async resumeSession(sessionKey: string, directory: string, terminalSessionId: string): Promise<{ cwd: string }> {
    const resolvedDir = this.resolvePath(directory);

    // SDK flags for structured JSON communication
    const args = [
      '--resume', sessionKey,           // Pass session key to --resume!
      '--output-format', 'stream-json', // JSONL output from Claude
      '--input-format', 'stream-json',  // JSONL input to Claude
      '--verbose',                      // Complete messages
    ];

    console.log(`[Claude Process] Spawning: claude ${args.join(' ')}`);

    const proc = spawn('claude', args, {
      cwd: resolvedDir,
      env: { ...process.env, TERM: 'xterm-256color' },
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.setupProcessHandlers(terminalSessionId, proc, resolvedDir, sessionKey);
    this.processes.set(terminalSessionId, { terminalSessionId, process: proc, directory: resolvedDir, sessionKey });

    return { cwd: resolvedDir };
  }

  /**
   * Send input to a Claude process in JSONL format
   * Format: {"type":"user","message":{"role":"user","content":"..."}}
   */
  sendInput(terminalSessionId: string, input: string): void {
    const info = this.processes.get(terminalSessionId);
    if (info?.process?.stdin) {
      // Format as JSONL user message (SDK format from happy-reference)
      const message = {
        type: 'user',
        message: {
          role: 'user',
          content: input.replace(/\n$/, ''), // Remove trailing newline from input
        },
      };
      const jsonLine = JSON.stringify(message) + '\n';
      console.log(`[Claude Process] Sending JSONL: ${jsonLine.substring(0, 100)}...`);
      info.process.stdin.write(jsonLine);
    }
  }

  /**
   * Check if a session is a Claude session
   */
  isClaudeSession(terminalSessionId: string): boolean {
    return this.processes.has(terminalSessionId);
  }

  /**
   * Set up event handlers for the spawned process
   */
  private setupProcessHandlers(
    terminalSessionId: string,
    proc: ChildProcess,
    directory: string,
    sessionKey?: string
  ): void {
    // Buffer for incomplete JSONL lines
    let outputBuffer = '';

    proc.stdout?.on('data', (data: Buffer) => {
      outputBuffer += data.toString();

      // Process complete JSONL lines
      const lines = outputBuffer.split('\n');
      outputBuffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line);
            // Emit parsed SDK message for status tracking
            this.emit('sdk_message', { terminalSessionId, message });

            // Log SDK message type for debugging
            if (message.type) {
              console.log(`[Claude Process] SDK message: ${message.type}${message.subtype ? '/' + message.subtype : ''}`);
            }
          } catch (e) {
            // Non-JSON output (shouldn't happen with SDK flags, but log it)
            console.log(`[Claude Process] Non-JSON stdout: ${line.substring(0, 50)}...`);
          }
        }
      }

      // Keep raw output emission for terminal display
      const output: ProcessOutputEvent = {
        terminalSessionId,
        output: data.toString(),
        type: 'stdout',
      };
      this.emit('output', output);
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const output: ProcessOutputEvent = {
        terminalSessionId,
        output: data.toString(),
        type: 'stderr',
      };
      this.emit('output', output);
    });

    proc.on('close', (code: number | null) => {
      const exitCode = code ?? 0;

      // Emit exit event
      const exitOutput: ProcessOutputEvent = {
        terminalSessionId,
        output: '',
        type: 'exit',
        exitCode,
      };
      this.emit('output', exitOutput);

      // Emit session ended event
      const endedEvent: SessionEndedEvent = {
        terminalSessionId,
        directory,
        sessionKey,
        exitCode,
      };
      this.emit('session_ended', endedEvent);

      // Clean up
      this.processes.delete(terminalSessionId);
    });

    proc.on('error', (error: Error) => {
      console.error(`[Claude Process] Error for ${terminalSessionId}:`, error.message);
      const output: ProcessOutputEvent = {
        terminalSessionId,
        output: `Error: ${error.message}\n`,
        type: 'stderr',
      };
      this.emit('output', output);
    });
  }

  /**
   * Resolve path (handle ~ for home directory)
   */
  private resolvePath(dir: string): string {
    if (dir === '~' || dir.startsWith('~/')) {
      return dir === '~' ? os.homedir() : dir.replace('~', os.homedir());
    }
    return path.resolve(dir);
  }

  /**
   * Kill a Claude process
   */
  killProcess(terminalSessionId: string): void {
    const info = this.processes.get(terminalSessionId);
    if (info?.process) {
      info.process.kill('SIGTERM');
    }
  }

  /**
   * Get all active process IDs
   */
  getActiveProcessIds(): string[] {
    return Array.from(this.processes.keys());
  }
}

export const claudeProcessManager = new ClaudeProcessManager();
export default claudeProcessManager;
