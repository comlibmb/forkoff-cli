import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';

function getSafeEnv(): Record<string, string | undefined> {
  const sensitivePatterns = [
    /^AWS_/i,
    /^AZURE_/i,
    /^GCP_/i,
    /^GOOGLE_/i,
    /SECRET/i,
    /PASSWORD/i,
    /PRIVATE_KEY/i,
    /^SUPABASE_SERVICE/i,
    /^DATABASE_URL$/i,
    /^ADMIN_API_KEY$/i,
    // Prevent code injection via environment variables
    /^NODE_OPTIONS$/i,
    /^NODE_EXTRA_CA_CERTS$/i,
    /^LD_PRELOAD$/i,
    /^LD_LIBRARY_PATH$/i,
    /^DYLD_INSERT_LIBRARIES$/i,
    /^DYLD_LIBRARY_PATH$/i,
    /^ELECTRON_RUN_AS_NODE$/i,
    // Language-specific code injection vectors
    /^PYTHONPATH$/i,
    /^PYTHONSTARTUP$/i,
    /^RUBYLIB$/i,
    /^PERL5LIB$/i,
    /^PERL5OPT$/i,
    /^JAVA_TOOL_OPTIONS$/i,
    /^_JAVA_OPTIONS$/i,
    // Git/SSH injection
    /^GIT_SSH_COMMAND$/i,
    /^GIT_EXEC_PATH$/i,
    // Pager/editor injection
    /^LESSOPEN$/i,
    /^LESSCLOSE$/i,
    // Shell startup injection
    /^BASH_ENV$/i,
    /^ENV$/i,
    /^PROMPT_COMMAND$/i,
    /^SHELLOPTS$/i,
    // Field separator injection
    /^IFS$/i,
    // Editor/browser auto-launch injection
    /^EDITOR$/i,
    /^VISUAL$/i,
    /^BROWSER$/i,
    // Proxy injection (MITM child process HTTP traffic)
    /^HTTPS?_PROXY$/i,
    /^ALL_PROXY$/i,
    /^NO_PROXY$/i,
    // TLS verification bypass
    /^SSL_CERT_FILE$/i,
    /^SSL_CERT_DIR$/i,
    /^NODE_TLS_REJECT_UNAUTHORIZED$/i,
    // npm config injection
    /^npm_config_/i,
    // Pager injection (git, man, etc.)
    /^PAGER$/i,
    // Zsh startup injection
    /^ZDOTDIR$/i,
    // Curl config injection
    /^CURL_HOME$/i,
    // Third-party API keys (defense-in-depth for child processes)
    /^OPENAI_/i,
    /^ANTHROPIC_/i,
    /^GITHUB_TOKEN$/i,
    /^GITLAB_TOKEN$/i,
    /^NPM_TOKEN$/i,
    /^DOCKER_PASSWORD$/i,
    /^SLACK_TOKEN$/i,
    /^SLACK_BOT_TOKEN$/i,
    /^SENDGRID_/i,
    /^TWILIO_/i,
    /^DATADOG_/i,
    /TOKEN$/i,
    /API_KEY$/i,
  ];

  const filtered: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!sensitivePatterns.some(pattern => pattern.test(key))) {
      filtered[key] = value;
    }
  }
  return filtered;
}

interface TerminalSession {
  id: string;
  process: ChildProcess | null;
  cwd: string;
}

class TerminalManager extends EventEmitter {
  private static readonly MAX_SESSIONS = 50;
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
    // Evict oldest session if at cap (FIFO)
    if (this.sessions.size >= TerminalManager.MAX_SESSIONS) {
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey) {
        console.warn(`[Terminal] MAX_SESSIONS (${TerminalManager.MAX_SESSIONS}) reached, evicting oldest: ${oldestKey}`);
        this.closeSession(oldestKey);
      }
    }

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
        env: getSafeEnv(),
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
