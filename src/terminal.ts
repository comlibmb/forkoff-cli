import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';

interface TerminalSession {
  id: string;
  process: ChildProcess | null;
  cwd: string;
}

class TerminalManager extends EventEmitter {
  private sessions: Map<string, TerminalSession> = new Map();
  private defaultShell: string;

  constructor() {
    super();
    this.defaultShell = this.getDefaultShell();
  }

  private getDefaultShell(): string {
    if (os.platform() === 'win32') {
      return process.env.COMSPEC || 'cmd.exe';
    }
    return process.env.SHELL || '/bin/bash';
  }

  createSession(terminalSessionId: string, cwd?: string): TerminalSession {
    // Default to home directory, not process.cwd()
    let resolvedCwd = cwd || os.homedir();

    // Resolve ~ to home directory
    if (resolvedCwd === '~' || resolvedCwd.startsWith('~/')) {
      resolvedCwd = resolvedCwd === '~' ? os.homedir() : resolvedCwd.replace('~', os.homedir());
    }

    const session: TerminalSession = {
      id: terminalSessionId,
      process: null,
      cwd: resolvedCwd,
    };

    this.sessions.set(terminalSessionId, session);
    return session;
  }

  async executeCommand(
    terminalSessionId: string,
    command: string
  ): Promise<{ output: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      let session = this.sessions.get(terminalSessionId);
      const wasNewSession = !session;

      if (!session) {
        session = this.createSession(terminalSessionId);
        // Emit session_created so websocket can send the initial cwd
        this.emit('session_created', {
          terminalSessionId,
          cwd: session.cwd,
        });
      }

      const isWindows = os.platform() === 'win32';
      const shell = isWindows ? 'cmd.exe' : '/bin/bash';
      const shellArgs = isWindows ? ['/c', command] : ['-c', command];

      const proc = spawn(shell, shellArgs, {
        cwd: session.cwd,
        env: process.env,
        shell: false,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        const output = data.toString();
        stdout += output;
        this.emit('output', {
          terminalSessionId,
          output,
          type: 'stdout',
        });
      });

      proc.stderr?.on('data', (data) => {
        const output = data.toString();
        stderr += output;
        this.emit('output', {
          terminalSessionId,
          output,
          type: 'stderr',
        });
      });

      proc.on('close', (code) => {
        const exitCode = code ?? 0;
        this.emit('output', {
          terminalSessionId,
          output: '',
          type: 'exit',
          exitCode,
        });

        // Check for cd command to update cwd
        this.updateCwdFromCommand(terminalSessionId, command);

        resolve({
          output: stdout + stderr,
          exitCode,
        });
      });

      proc.on('error', (error) => {
        this.emit('output', {
          terminalSessionId,
          output: error.message,
          type: 'stderr',
        });
        reject(error);
      });
    });
  }

  private updateCwdFromCommand(terminalSessionId: string, command: string): void {
    const session = this.sessions.get(terminalSessionId);
    if (!session) return;

    // Simple cd detection
    const cdMatch = command.match(/^\s*cd\s+(.+)$/i);
    if (cdMatch) {
      const newPath = cdMatch[1].trim().replace(/["']/g, '');
      if (path.isAbsolute(newPath)) {
        session.cwd = newPath;
      } else {
        session.cwd = path.resolve(session.cwd, newPath);
      }
      this.emit('cwd_changed', {
        terminalSessionId,
        cwd: session.cwd,
      });
    }
  }

  getSession(terminalSessionId: string): TerminalSession | undefined {
    return this.sessions.get(terminalSessionId);
  }

  closeSession(terminalSessionId: string): void {
    const session = this.sessions.get(terminalSessionId);
    if (session?.process) {
      session.process.kill();
    }
    this.sessions.delete(terminalSessionId);
  }

  closeAllSessions(): void {
    for (const [terminalSessionId] of this.sessions) {
      this.closeSession(terminalSessionId);
    }
  }
}

export const terminalManager = new TerminalManager();
export default terminalManager;
