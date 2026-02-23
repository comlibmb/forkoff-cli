/**
 * Claude Process Manager
 * Spawns and manages Claude CLI processes for terminal sessions
 */

import spawn from 'cross-spawn';
import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { PermissionIpcManager, PermissionPromptEvent } from './permission-ipc';

/**
 * Returns a filtered copy of process.env with sensitive variables removed.
 * Prevents accidental leakage of credentials to Claude child processes.
 */
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

interface ClaudeProcessInfo {
  terminalSessionId: string;
  process: ChildProcess;
  directory: string;
  sessionKey?: string;
  outputBuffer: string[]; // Recent output lines for context
  wasAutoRestarted?: boolean; // Track if this was an auto-restart
  dangerouslySkipPermissions?: boolean; // Unrestricted mode from mobile
  interactivePermissions?: boolean; // Mobile user opted into hook-based approval
}

/**
 * Regular expression patterns used to detect approval prompts in Claude CLI output.
 * When any of these patterns match the output, an approval request is triggered
 * and sent to the mobile app for user confirmation.
 *
 * Supported patterns include:
 * - [y]es, [n]o, [p]lan format (bracketed option letters)
 * - (y/n) format (parenthetical yes/no)
 * - Various question phrases like "Do you want to proceed?", "Allow this action?", etc.
 *
 * @constant {RegExp[]}
 */
const APPROVAL_PATTERNS = [
  /\[y\]es.*\[n\]o/i,                      // [y]es, [n]o, [p]lan format
  /\(y\/n\)/i,                              // (y/n) format
  /do you want to proceed/i,                // Do you want to proceed?
  /allow this action/i,                     // Allow this action?
  /continue\?/i,                            // Continue?
  /approve this/i,                          // Approve this?
];

/**
 * Extracts available approval options from a prompt text.
 *
 * Parses the approval prompt to identify available response options.
 * For bracketed format prompts like "[y]es, [n]o, [p]lan", it extracts
 * each option as "key:label" pairs (e.g., "y:yes", "n:no", "p:plan").
 *
 * @param {string} text - The prompt text to parse for options
 * @returns {string[]} Array of option strings in "key:label" format.
 *                     Returns ['y:yes', 'n:no'] as default if no specific options are found.
 *
 * @example
 * // Bracketed format
 * extractApprovalOptions("[y]es, [n]o, [p]lan");
 * // Returns: ['y:yes', 'n:no', 'p:plan']
 *
 * @example
 * // Default fallback
 * extractApprovalOptions("Continue? (y/n)");
 * // Returns: ['y:yes', 'n:no']
 */
function extractApprovalOptions(text: string): string[] {
  // Skip JSON content - only parse plain text prompts
  if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
    // For SDK JSON output, default to standard options
    return ['y:yes', 'n:no', 'p:plan'];
  }

  // Check for [y]es, [n]o, [p]lan format in plain text
  const bracketMatch = text.match(/\[([ynpae])\][a-z]+/gi);
  if (bracketMatch && bracketMatch.length >= 2 && bracketMatch.length <= 4) {
    return bracketMatch.map(m => {
      const key = m.match(/\[([a-z])\]/i)?.[1]?.toLowerCase() || '';
      const full = m.replace(/\[|\]/g, '');
      return `${key}:${full}`;
    });
  }

  // Default yes/no/plan
  return ['y:yes', 'n:no', 'p:plan'];
}

/**
 * Represents a pending approval request that is waiting for user response.
 * Used internally to track active approval requests and manage their timeouts.
 *
 * @interface PendingApproval
 * @property {string} approvalId - Unique identifier for this approval request
 * @property {string} terminalSessionId - The terminal session that triggered this approval
 * @property {number} createdAt - Unix timestamp (ms) when the approval was created
 * @property {NodeJS.Timeout} timeoutId - Reference to the timeout that will auto-deny if no response
 */
interface PendingApproval {
  approvalId: string;
  terminalSessionId: string;
  createdAt: number;
  timeoutId: NodeJS.Timeout;
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

/**
 * Event payload emitted when Claude CLI requests user approval.
 * This is sent to the mobile app to display an approval dialog to the user.
 *
 * @interface ClaudeApprovalRequest
 * @property {string} approvalId - Unique identifier for this approval request
 * @property {string} terminalSessionId - The terminal session that triggered this approval
 * @property {string} [sessionKey] - Optional Claude session key for session resumption
 * @property {string[]} context - Recent output lines providing context for the approval
 * @property {string[]} options - Available response options in "key:label" format
 *                                (e.g., ['y:yes', 'n:no', 'p:plan'])
 * @property {string} promptText - The actual approval prompt text from Claude CLI
 */
interface ClaudeApprovalRequest {
  approvalId: string;
  terminalSessionId: string;
  sessionKey?: string;
  context: string[];       // Recent output lines for context
  options: string[];       // Available options (e.g., ['y:yes', 'n:no', 'p:plan'])
  promptText: string;      // The actual prompt text
  toolName?: string;       // Structured tool name from SDK tool_use block
  toolInput?: any;         // Structured tool input from SDK tool_use block
}

/** SDK message structure received from Claude CLI JSONL output */
interface SdkMessage {
  type: string;
  subtype?: string;
  [key: string]: unknown;
}

/** Thinking content event payload */
interface ThinkingContentEvent {
  terminalSessionId: string;
  sessionKey?: string;
  thinkingId: string;
  content: string;
  partial: boolean;
}

/** Token usage event payload */
interface TokenUsageEvent {
  terminalSessionId: string;
  sessionKey?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

/** Task structure for task progress tracking */
interface TaskInfo {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

/** Task progress event payload */
interface TaskProgressEvent {
  terminalSessionId: string;
  sessionKey?: string;
  type: 'created' | 'updated' | 'completed' | 'list';
  task?: TaskInfo;
  tasks?: TaskInfo[];
}

/** Event payload for SDK messages */
interface SdkMessageEvent {
  terminalSessionId: string;
  message: SdkMessage;
}

/** Type-safe event signatures for ClaudeProcessManager */
interface ClaudeProcessManagerEvents {
  output: [event: ProcessOutputEvent];
  session_ended: [event: SessionEndedEvent];
  sdk_message: [event: SdkMessageEvent];
  claude_approval_request: [request: ClaudeApprovalRequest];
  tool_activity: [event: ToolActivityEvent];
  permission_prompt: [event: PermissionPromptEvent];
  thinking_content: [event: ThinkingContentEvent];
  token_usage: [event: TokenUsageEvent];
  task_progress: [event: TaskProgressEvent];
  session_id_captured: [data: { terminalSessionId: string; sessionId: string; directory: string }];
}

/** Stores session info for auto-restart capability */
interface SessionRestartInfo {
  sessionKey?: string;
  directory: string;
  lastExitCode: number;
  lastExitTime: number;
  restartCount: number;
  dangerouslySkipPermissions?: boolean;
  interactivePermissions?: boolean;
  /** Whether sessionKey is a real Claude session (from local scanner) vs mobile-generated key */
  isRealSession?: boolean;
}

/** Tool activity event — non-blocking notification of tool execution */
interface ToolActivityEvent {
  terminalSessionId: string;
  sessionKey?: string;
  toolName: string;
  toolId: string;
  inputSummary: string;
}

class ClaudeProcessManager extends EventEmitter {
  private static readonly MAX_ACTIVE_PROCESSES = 20;
  private static readonly MAX_PENDING_APPROVALS = 50;
  private processes: Map<string, ClaudeProcessInfo> = new Map();
  private pendingApprovals: Map<string, PendingApproval> = new Map();
  private readonly APPROVAL_TIMEOUT_MS: number = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_OUTPUT_BUFFER_LINES: number = 20;
  /** Track closed sessions for auto-restart */
  private closedSessions: Map<string, SessionRestartInfo> = new Map();
  private static readonly MAX_CLOSED_SESSIONS = 200;
  /** Maximum number of auto-restarts per session to prevent chaos */
  private readonly MAX_AUTO_RESTARTS: number = 3;
  /** Permission IPC managers per session */
  private permissionIpcManagers: Map<string, PermissionIpcManager> = new Map();
  /** Track which process started each IPC manager (to avoid race conditions on close) */
  private ipcOwnerProcess: Map<string, ChildProcess> = new Map();
  /** Track directories where we've configured hooks */
  private hookConfiguredDirs: Set<string> = new Set();
  /** Track sessions that mobile has explicitly taken over (via claude_resume_session) */
  private takenOverSessions: Set<string> = new Set();
  private static readonly MAX_TAKEN_OVER_SESSIONS = 100;

  /** Type-safe emit for known events */
  public override emit<K extends keyof ClaudeProcessManagerEvents>(
    event: K,
    ...args: ClaudeProcessManagerEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  /** Type-safe on for known events */
  public override on<K extends keyof ClaudeProcessManagerEvents>(
    event: K,
    listener: (...args: ClaudeProcessManagerEvents[K]) => void
  ): this {
    return super.on(event, listener);
  }

  /**
   * Start a new Claude session in the specified directory
   */
  async startSession(directory: string, terminalSessionId: string, dangerouslySkipPermissions?: boolean, interactivePermissions?: boolean): Promise<{ cwd: string }> {
    const resolvedDir = this.resolvePath(directory);

    // SDK flags for structured JSON communication
    const args = [
      '--output-format', 'stream-json', // JSONL output from Claude
      '--input-format', 'stream-json',  // JSONL input to Claude
      '--verbose',                      // Complete messages
    ];

    // Permission modes (in priority order):
    // 1. dangerouslySkipPermissions → --dangerously-skip-permissions (full unrestricted access)
    // 2. interactivePermissions → configure hooks for mobile approval (opt-in)
    // 3. default → no hooks, Claude uses its own local permission mode
    if (dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions');
    } else if (interactivePermissions) {
      // Configure PreToolUse hook for interactive approvals
      this.configureHook(resolvedDir);
      // Start IPC manager to bridge hook ↔ WebSocket
      this.startPermissionIpc(terminalSessionId);
    }

    // SECURITY: Using cross-spawn instead of shell: true to prevent command injection
    const proc = spawn('claude', args, {
      cwd: resolvedDir,
      env: { ...getSafeEnv(), TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.setupProcessHandlers(terminalSessionId, proc, resolvedDir);
    this.enforceProcessCap();
    this.processes.set(terminalSessionId, { terminalSessionId, process: proc, directory: resolvedDir, outputBuffer: [], wasAutoRestarted: false, dangerouslySkipPermissions: !!dangerouslySkipPermissions, interactivePermissions: !!interactivePermissions });

    return { cwd: resolvedDir };
  }

  /**
   * Resume an existing Claude session
   */
  async resumeSession(sessionKey: string, directory: string, terminalSessionId: string, dangerouslySkipPermissions?: boolean, interactivePermissions?: boolean): Promise<{ cwd: string }> {
    const resolvedDir = this.resolvePath(directory);

    // SDK flags for structured JSON communication
    const args = [
      '--resume', sessionKey,           // Pass session key to --resume!
      '--output-format', 'stream-json', // JSONL output from Claude
      '--input-format', 'stream-json',  // JSONL input to Claude
      '--verbose',                      // Complete messages
    ];

    // Permission modes (in priority order):
    // 1. dangerouslySkipPermissions → --dangerously-skip-permissions (full unrestricted access)
    // 2. interactivePermissions → configure hooks for mobile approval (opt-in)
    // 3. default → no hooks, Claude uses its own local permission mode
    if (dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions');
    } else if (interactivePermissions) {
      // Configure PreToolUse hook for interactive approvals
      this.configureHook(resolvedDir);
      // Start IPC manager to bridge hook ↔ WebSocket
      this.startPermissionIpc(terminalSessionId, sessionKey);
    }

    console.log(`[Claude Process] Spawning: claude (${args.length} args)`);

    // SECURITY: Using cross-spawn instead of shell: true to prevent command injection
    const proc = spawn('claude', args, {
      cwd: resolvedDir,
      env: { ...getSafeEnv(), TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.setupProcessHandlers(terminalSessionId, proc, resolvedDir, sessionKey);
    this.enforceProcessCap();
    this.processes.set(terminalSessionId, { terminalSessionId, process: proc, directory: resolvedDir, sessionKey, outputBuffer: [], wasAutoRestarted: false, dangerouslySkipPermissions: !!dangerouslySkipPermissions, interactivePermissions: !!interactivePermissions });

    // Store session info for future message sends (needed since we spawn fresh process per message)
    this.closedSessions.set(terminalSessionId, {
      sessionKey,
      directory: resolvedDir,
      lastExitCode: 0,
      lastExitTime: Date.now(),
      restartCount: 0,
      dangerouslySkipPermissions: !!dangerouslySkipPermissions,
      interactivePermissions: !!interactivePermissions,
    });

    return { cwd: resolvedDir };
  }

  /**
   * Send input to a Claude process in JSONL format
   * Format: {"type":"user","message":{"role":"user","content":"..."}}
   *
   * IMPORTANT: Claude SDK with --resume and streaming JSON only supports ONE turn per process.
   * So we kill any existing process and spawn a fresh one for each message.
   * Since we use --resume, the conversation history is preserved.
   */
  async sendInput(terminalSessionId: string, input: string): Promise<boolean> {
    let info = this.processes.get(terminalSessionId);
    const restartInfo = this.closedSessions.get(terminalSessionId);

    // If there's an existing process, kill it first (Claude SDK only supports 1 turn per process)
    if (info?.process && info.process.exitCode === null) {
      console.log(`[Claude Process] Killing existing process for new message (SDK limitation: 1 turn per process)`);
      info.process.kill('SIGTERM');
      // Wait for process to die
      await new Promise(resolve => setTimeout(resolve, 200));
      this.processes.delete(terminalSessionId);
      info = undefined;
    }

    // Get session info from either current process or closed sessions
    const sessionKey = info?.sessionKey || restartInfo?.sessionKey;
    const directory = info?.directory || restartInfo?.directory;

    if (!sessionKey || !directory) {
      console.log(`[Claude Process] No session info found for ${terminalSessionId}`);
      return false;
    }

    // If the session key is mobile-generated (not a real Claude session), start fresh
    // instead of trying --resume with a non-existent key. The session_id capture in
    // setupProcessHandlers will store the real key for subsequent messages.
    if (restartInfo?.isRealSession === false) {
      console.log(`[Claude Process] Session key is mobile-generated — starting fresh session instead of --resume`);
      return this.startAndSendMessage(directory, terminalSessionId, input, restartInfo.dangerouslySkipPermissions, restartInfo.interactivePermissions);
    }

    // Spawn a fresh Claude process for this message
    // IMPORTANT: We must write to stdin immediately after spawn - Claude CLI with
    // stream-json input format exits if it doesn't receive input quickly
    console.log(`[Claude Process] Spawning fresh process for message (--resume preserves history)`);

    // Format as JSONL user message (SDK format)
    const message = {
      type: 'user',
      message: {
        role: 'user',
        content: input.replace(/\n$/, ''), // Remove trailing newline from input
      },
    };
    const jsonLine = JSON.stringify(message) + '\n';

    try {
      await this.resumeSession(sessionKey, directory, terminalSessionId, restartInfo?.dangerouslySkipPermissions, restartInfo?.interactivePermissions);
      info = this.processes.get(terminalSessionId);
    } catch (err) {
      console.error(`[Claude Process] Failed to spawn process:`, (err as Error).message);
      return false;
    }

    if (!info?.process) {
      console.log(`[Claude Process] Failed to get process after spawn for ${terminalSessionId}`);
      return false;
    }

    if (!info.process.stdin || info.process.stdin.destroyed) {
      console.log(`[Claude Process] stdin is closed or destroyed for ${terminalSessionId}`);
      return false;
    }

    // Write message to stdin IMMEDIATELY - no waiting
    console.log(`[Claude Process] Sending JSONL immediately (${jsonLine.length} chars)`);

    return new Promise((resolve) => {
      try {
        info!.process.stdin!.write(jsonLine, (err) => {
          if (err) {
            console.error(`[Claude Process] Error writing to stdin for ${terminalSessionId}:`, err.message);
            resolve(false);
          } else {
            console.log(`[Claude Process] Message written to stdin successfully`);
            resolve(true);
          }
        });
      } catch (err) {
        console.error(`[Claude Process] Exception writing to stdin for ${terminalSessionId}:`, (err as Error).message);
        resolve(false);
      }
    });
  }

  /**
   * Start a fresh Claude session and immediately send a message.
   * Used by auto-prompt quick actions where no prior session exists.
   * Spawns claude with stream-json flags, writes the JSONL user message to stdin right away.
   */
  async startAndSendMessage(directory: string, terminalSessionId: string, message: string, dangerouslySkipPermissions?: boolean, interactivePermissions?: boolean): Promise<boolean> {
    const resolvedDir = this.resolvePath(directory);

    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
    ];

    // Permission modes (same priority as startSession/resumeSession)
    if (dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions');
    } else if (interactivePermissions) {
      this.configureHook(resolvedDir);
      this.startPermissionIpc(terminalSessionId);
    }

    const proc = spawn('claude', args, {
      cwd: resolvedDir,
      env: { ...getSafeEnv(), TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.setupProcessHandlers(terminalSessionId, proc, resolvedDir);
    this.enforceProcessCap();
    this.processes.set(terminalSessionId, {
      terminalSessionId,
      process: proc,
      directory: resolvedDir,
      outputBuffer: [],
      wasAutoRestarted: false,
      dangerouslySkipPermissions: !!dangerouslySkipPermissions,
      interactivePermissions: !!interactivePermissions,
    });

    // Mark session as taken over so subsequent user_message events go through
    // sendInput() instead of creating another fresh session each time
    this.markTakenOver(terminalSessionId);

    // Store restart info so sendInput can find session details if the process
    // is killed before the SDK result captures the real session_id
    this.closedSessions.set(terminalSessionId, {
      directory: resolvedDir,
      lastExitCode: 0,
      lastExitTime: Date.now(),
      restartCount: 0,
      dangerouslySkipPermissions: !!dangerouslySkipPermissions,
      interactivePermissions: !!interactivePermissions,
      isRealSession: false, // Will become true when session_id is captured from SDK output
    });

    // Format as JSONL user message and write immediately
    const jsonLine = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: message.replace(/\n$/, '') },
    }) + '\n';

    if (!proc.stdin || proc.stdin.destroyed) {
      console.log(`[Claude Process] stdin not available for startAndSendMessage`);
      return false;
    }

    return new Promise((resolve) => {
      try {
        proc.stdin!.write(jsonLine, (err) => {
          if (err) {
            console.error(`[Claude Process] Error writing initial message:`, err.message);
            resolve(false);
          } else {
            console.log(`[Claude Process] Initial message written to new session`);
            resolve(true);
          }
        });
      } catch (err) {
        console.error(`[Claude Process] Exception writing initial message:`, (err as Error).message);
        resolve(false);
      }
    });
  }

  /**
   * Check if a session is a Claude session (active or restartable)
   */
  isClaudeSession(terminalSessionId: string): boolean {
    return this.processes.has(terminalSessionId) || this.closedSessions.has(terminalSessionId);
  }

  /**
   * Check if CLI has a running process for this session (not just registered)
   */
  hasRunningProcess(terminalSessionId: string): boolean {
    const info = this.processes.get(terminalSessionId);
    return !!(info?.process && info.process.exitCode === null);
  }

  /**
   * Register session info without spawning a process.
   * Used when mobile opens a session view - we store the info so we can spawn later on first message.
   */
  registerSession(sessionKey: string, directory: string, terminalSessionId: string, dangerouslySkipPermissions?: boolean, interactivePermissions?: boolean, isRealSession?: boolean): void {
    this.cleanupOldClosedSessions();

    // If we already captured a real Claude session key (from SDK output) for this
    // terminalSessionId, preserve it. This prevents reconnects from overwriting
    // the real key with the mobile-generated one (e.g. brainstorm-*).
    const existing = this.closedSessions.get(terminalSessionId);
    const effectiveSessionKey = (existing?.isRealSession && existing.sessionKey) ? existing.sessionKey : sessionKey;
    const effectiveIsReal = (existing?.isRealSession) ? true : isRealSession;

    console.log(`[Claude Process] Registering session: ${effectiveSessionKey}${dangerouslySkipPermissions ? ' (unrestricted)' : ''}${interactivePermissions ? ' (interactive)' : ''}${effectiveIsReal === false ? ' (fresh — no real Claude session)' : ''}`);
    this.closedSessions.set(terminalSessionId, {
      sessionKey: effectiveSessionKey,
      directory,
      lastExitCode: existing?.lastExitCode ?? 0,
      lastExitTime: Date.now(),
      restartCount: 0,
      dangerouslySkipPermissions,
      interactivePermissions,
      isRealSession: effectiveIsReal,
    });
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
    const MAX_LINE_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB
    let jsonLineBuffer = '';

    proc.stdout?.on('data', (data: Buffer) => {
      const rawOutput = data.toString();
      jsonLineBuffer += rawOutput;

      // Prevent unbounded buffer growth from missing newlines
      if (jsonLineBuffer.length > MAX_LINE_BUFFER_SIZE) {
        console.warn(`[Claude] JSONL line buffer exceeded ${MAX_LINE_BUFFER_SIZE} bytes, resetting`);
        jsonLineBuffer = '';
      }

      // Update output buffer for approval context
      const processInfo = this.processes.get(terminalSessionId);
      if (processInfo) {
        // Add new lines to buffer, keeping last N lines
        const newLines = rawOutput.split('\n').filter(l => l.trim());
        processInfo.outputBuffer.push(...newLines);
        if (processInfo.outputBuffer.length > this.MAX_OUTPUT_BUFFER_LINES) {
          processInfo.outputBuffer = processInfo.outputBuffer.slice(-this.MAX_OUTPUT_BUFFER_LINES);
        }

        // Check for approval patterns in the raw output
        this.checkForApprovalPattern(terminalSessionId, rawOutput, processInfo);
      }

      // Process complete JSONL lines
      const lines = jsonLineBuffer.split('\n');
      jsonLineBuffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line);
            // Emit parsed SDK message for status tracking
            this.emit('sdk_message', { terminalSessionId, message });

            // Log SDK message type for debugging
            if (message.type) {
              console.log(`[Claude Process] SDK message: ${message.type}${message.subtype ? '/' + message.subtype : ''}`);

              // Log when we receive a result message (end of turn)
              if (message.type === 'result') {
                console.log(`[Claude Process] Received result message - turn complete. Subtype: ${message.subtype}, Cost: $${message.cost_usd || 'unknown'}`);
                if (message.is_error) {
                  console.log(`[Claude Process] Result indicates error`);
                }

                // Capture session_id from result so future sendInput() can --resume
                if (message.session_id && processInfo && !processInfo.sessionKey) {
                  console.log(`[Claude Process] Captured session_id from result: ${message.session_id}`);
                  processInfo.sessionKey = message.session_id;
                  this.closedSessions.set(terminalSessionId, {
                    sessionKey: message.session_id,
                    directory,
                    lastExitCode: 0,
                    lastExitTime: Date.now(),
                    restartCount: 0,
                    dangerouslySkipPermissions: processInfo.dangerouslySkipPermissions,
                    interactivePermissions: processInfo.interactivePermissions,
                    isRealSession: true, // Now we have a real Claude session key
                  });
                  // Notify listeners so transcript watcher can switch to new session's JSONL file
                  this.emit('session_id_captured', { terminalSessionId, sessionId: message.session_id, directory });
                }
              }
            }

            // Detect tool_use in SDK messages and emit approval request
            if (processInfo) {
              this.checkForToolUseInSdkMessage(terminalSessionId, message, processInfo);
            }

            // Parse thinking content from content_block_delta with thinking type
            this.parseThinkingContent(terminalSessionId, message, sessionKey);

            // Parse token usage from message_delta
            this.parseTokenUsage(terminalSessionId, message, sessionKey);

            // Parse task progress from TaskCreate/TaskUpdate/TaskList tool_use
            this.parseTaskProgress(terminalSessionId, message, sessionKey);
          } catch (e) {
            // Non-JSON output (shouldn't happen with SDK flags, but log it)
            console.log(`[Claude Process] Non-JSON stdout (${line.length} chars)`);
          }
        }
      }

      // Keep raw output emission for terminal display
      const output: ProcessOutputEvent = {
        terminalSessionId,
        output: rawOutput,
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
      console.log(`[Claude Process] Process closed for ${terminalSessionId}, exit code: ${exitCode}`);

      // Store session info for potential restart
      // Get process info before we delete it
      const processInfo = this.processes.get(terminalSessionId);
      const existingInfo = this.closedSessions.get(terminalSessionId);

      // Only preserve restart count if this was an auto-restarted session
      // Otherwise reset to 0 (user explicitly started a new session)
      const restartCount = processInfo?.wasAutoRestarted
        ? (existingInfo?.restartCount ?? 0)
        : 0;

      // Use processInfo.sessionKey if it was captured from SDK output (e.g. session_id
      // in result message after startAndSendMessage), otherwise fall back to the closure's
      // sessionKey from setupProcessHandlers. This ensures fresh sessions get the real key.
      const resolvedSessionKey = processInfo?.sessionKey || sessionKey;

      this.closedSessions.set(terminalSessionId, {
        sessionKey: resolvedSessionKey,
        directory,
        lastExitCode: exitCode,
        lastExitTime: Date.now(),
        restartCount,
        dangerouslySkipPermissions: processInfo?.dangerouslySkipPermissions,
        interactivePermissions: processInfo?.interactivePermissions,
        // Once we have a real session key (captured from SDK), mark as real
        isRealSession: resolvedSessionKey ? true : existingInfo?.isRealSession,
      });

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

      // Only clean up IPC/hooks if no newer process has replaced this one.
      // Race condition: when sendInput kills the old process and spawns a new one,
      // the old close handler fires AFTER the new process starts, which would
      // incorrectly tear down the new process's IPC and hooks.
      const currentProcess = this.processes.get(terminalSessionId);
      const isCurrentProcess = currentProcess?.process === proc;

      if (isCurrentProcess || !currentProcess) {
        // Clean up permission IPC for this session
        this.stopPermissionIpc(terminalSessionId);

        // Remove hook config if no other sessions are using this directory
        const otherSessionsInDir = Array.from(this.processes.values())
          .filter(p => p.directory === directory && p.terminalSessionId !== terminalSessionId);
        if (otherSessionsInDir.length === 0) {
          this.removeHook(directory);
        }
      } else {
        console.log(`[Claude Process] Skipping IPC/hook cleanup — newer process owns this session`);
      }

      // Clean up process map entry only if it's still this process
      if (isCurrentProcess) {
        this.processes.delete(terminalSessionId);
      }
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
   * SECURITY: Validates path doesn't contain dangerous characters
   */
  private resolvePath(dir: string): string {
    // SECURITY: Reject paths with shell metacharacters or control characters
    if (/[;&|`$()<>\n\r\0]/.test(dir)) {
      throw new Error('Invalid directory path: contains disallowed characters');
    }

    let resolved: string;
    if (dir === '~' || dir.startsWith('~/')) {
      resolved = dir === '~' ? os.homedir() : dir.replace('~', os.homedir());
    } else {
      resolved = path.resolve(dir);
    }

    // SECURITY: Prevent path traversal — resolved path must be under home directory
    const homeDir = os.homedir();
    const normalized = path.normalize(resolved);
    // On Windows, paths are case-insensitive — use lowercase comparison
    const isUnderHome = os.platform() === 'win32'
      ? normalized.toLowerCase().startsWith(homeDir.toLowerCase())
      : normalized.startsWith(homeDir);
    if (!isUnderHome) {
      throw new Error('Invalid directory path: path traversal detected (must be under home directory)');
    }

    return normalized;
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

  /**
   * Get all active sessions with their details
   */
  getActiveSessions(): Array<{ terminalSessionId: string; sessionKey?: string; directory: string }> {
    return Array.from(this.processes.values()).map(info => ({
      terminalSessionId: info.terminalSessionId,
      sessionKey: info.sessionKey,
      directory: info.directory,
    }));
  }

  /** Enforce cap on active processes to prevent resource exhaustion */
  private enforceProcessCap(): void {
    while (this.processes.size >= ClaudeProcessManager.MAX_ACTIVE_PROCESSES) {
      const oldestKey = this.processes.keys().next().value;
      if (oldestKey) {
        const oldProcess = this.processes.get(oldestKey);
        if (oldProcess?.process) {
          try { oldProcess.process.kill(); } catch { /* best effort */ }
        }
        this.processes.delete(oldestKey);
        console.warn(`[Claude Process] MAX_ACTIVE_PROCESSES (${ClaudeProcessManager.MAX_ACTIVE_PROCESSES}) reached, killed: ${oldestKey}`);
      } else break;
    }
  }

  /**
   * Clean up old closed session entries to prevent memory leaks.
   * Sessions older than 1 hour are removed.
   */
  cleanupOldClosedSessions(): void {
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const now = Date.now();
    let cleanedCount = 0;

    for (const [sessionId, info] of this.closedSessions.entries()) {
      if (now - info.lastExitTime > ONE_HOUR_MS) {
        this.closedSessions.delete(sessionId);
        cleanedCount++;
      }
    }

    // Also enforce hard cap with FIFO eviction
    while (this.closedSessions.size > ClaudeProcessManager.MAX_CLOSED_SESSIONS) {
      const oldestKey = this.closedSessions.keys().next().value;
      if (oldestKey) {
        this.closedSessions.delete(oldestKey);
        cleanedCount++;
      } else break;
    }

    if (cleanedCount > 0) {
      console.log(`[Claude Process] Cleaned up ${cleanedCount} old closed session(s)`);
    }
  }

  /**
   * Clear restart counter for a session, allowing fresh restarts.
   * Useful when user explicitly wants to reset.
   */
  clearRestartCounter(terminalSessionId: string): void {
    const info = this.closedSessions.get(terminalSessionId);
    if (info) {
      info.restartCount = 0;
      console.log(`[Claude Process] Restart counter cleared for ${terminalSessionId}`);
    }
  }

  /**
   * Mark a session as taken over by the mobile user.
   */
  markTakenOver(terminalSessionId: string): void {
    // Evict oldest if at cap (FIFO — Set iteration order is insertion order)
    if (this.takenOverSessions.size >= ClaudeProcessManager.MAX_TAKEN_OVER_SESSIONS) {
      const oldest = this.takenOverSessions.values().next().value;
      if (oldest) {
        this.takenOverSessions.delete(oldest);
        console.warn(`[Claude Process] MAX_TAKEN_OVER_SESSIONS (${ClaudeProcessManager.MAX_TAKEN_OVER_SESSIONS}) reached, evicted: ${oldest}`);
      }
    }
    this.takenOverSessions.add(terminalSessionId);
    console.log(`[Claude Process] Session marked as taken over: ${terminalSessionId}`);
  }

  /**
   * Check if a session has been taken over by the mobile user.
   */
  isTakenOver(terminalSessionId: string): boolean {
    return this.takenOverSessions.has(terminalSessionId);
  }

  /**
   * Clear taken-over state for a single session.
   */
  clearTakenOver(terminalSessionId: string): void {
    this.takenOverSessions.delete(terminalSessionId);
  }

  /**
   * Clear all taken-over sessions (e.g., when mobile disconnects).
   */
  clearAllTakenOver(): void {
    this.takenOverSessions.clear();
    console.log(`[Claude Process] All taken-over sessions cleared`);
  }

  /**
   * Get all pending permission prompts across all IPC managers.
   * Used to sync pending permissions to mobile on take-over.
   */
  getAllPendingPrompts(): PermissionPromptEvent[] {
    const allPrompts: PermissionPromptEvent[] = [];
    for (const [, ipcManager] of this.permissionIpcManagers) {
      allPrompts.push(...ipcManager.getPendingPromptData());
    }
    return allPrompts;
  }

  /**
   * Auto-allow all pending permission prompts across all IPC managers.
   * Called when mobile disconnects so Claude doesn't hang waiting for approval.
   */
  autoAllowAllPendingPrompts(): void {
    const pending = this.getAllPendingPrompts();
    for (const prompt of pending) {
      // Find the IPC manager that owns this prompt and respond
      for (const [, ipcManager] of this.permissionIpcManagers) {
        ipcManager.handleResponse(prompt.promptId, 'allow', 'Auto-allowed: mobile disconnected');
      }
    }
    if (pending.length > 0) {
      console.log(`[Claude Process] Auto-allowed ${pending.length} pending permission prompt(s) on mobile disconnect`);
    }
  }

  /**
   * Tear down all permission hooks and IPC managers.
   * Called when mobile disconnects — hooks get re-configured on next Take Over + message.
   */
  cleanupAllPermissionState(): void {
    // Stop all IPC managers
    for (const [sessionId, ipcManager] of this.permissionIpcManagers) {
      ipcManager.cleanup();
      console.log(`[Claude Process] Stopped permission IPC for ${sessionId}`);
    }
    this.permissionIpcManagers.clear();

    // Remove hooks from all configured directories
    for (const dir of Array.from(this.hookConfiguredDirs)) {
      this.removeHook(dir);
    }

    console.log(`[Claude Process] All permission hooks and IPC managers cleaned up`);
  }

  /**
   * Write permission rules to disk so the hook script can read them.
   * Rules are written to a well-known temp file that the hook reads on each invocation.
   */
  updatePermissionRules(rules: any[]): void {
    const rulesDir = path.join(os.tmpdir(), 'forkoff-permissions');
    const rulesFile = path.join(rulesDir, 'rules.json');

    try {
      if (!fs.existsSync(rulesDir)) {
        fs.mkdirSync(rulesDir, { recursive: true, mode: 0o700 });
      } else {
        // SECURITY: Validate temp dir permissions aren't world-writable
        const dirStat = fs.statSync(rulesDir);
        const dirMode = dirStat.mode & 0o777;
        if (dirMode & 0o022) { // group or other writable
          console.error(`[Security] Temp dir has unsafe permissions (${dirMode.toString(8)}), refusing to write`);
          return;
        }
      }

      // SECURITY: Atomic write via temp file + rename to prevent TOCTOU
      const tmpFile = rulesFile + '.tmp.' + process.pid;
      fs.writeFileSync(tmpFile, JSON.stringify(rules, null, 2), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmpFile, rulesFile);
      console.log(`[Claude Process] Permission rules written`);
    } catch (err) {
      console.error(`[Claude Process] Failed to write permission rules:`, (err as Error).message);
    }
  }

  /**
   * Configure the PreToolUse hook in the project's .claude/settings.local.json.
   * This tells Claude Code to run our hook script before each tool use.
   */
  private configureHook(cwd: string): void {
    const hookScriptPath = path.resolve(__dirname, 'permission-hook.js');

    // Verify hook script exists (it should be compiled alongside this file)
    if (!fs.existsSync(hookScriptPath)) {
      console.log(`[Claude Process] Hook script not found, skipping hook configuration`);
      return;
    }

    const claudeDir = path.join(cwd, '.claude');
    const settingsFile = path.join(claudeDir, 'settings.local.json');

    try {
      // Create .claude dir if needed
      fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });

      // Read existing settings or start fresh
      let settings: any = {};
      if (fs.existsSync(settingsFile)) {
        try {
          settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
        } catch {
          settings = {};
        }
      }

      // Add our hook
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

      // Check if our hook is already configured
      const hookCommand = `node "${hookScriptPath}"`;
      const alreadyConfigured = settings.hooks.PreToolUse.some(
        (h: any) => h.hooks?.some((hook: any) => hook.command?.includes('permission-hook'))
      );

      if (!alreadyConfigured) {
        settings.hooks.PreToolUse.push({
          matcher: '',
          hooks: [{
            type: 'command',
            command: hookCommand,
          }],
        });
      }

      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), { encoding: 'utf-8', mode: 0o600 });
      this.hookConfiguredDirs.add(cwd);
      console.log(`[Claude Process] Hook configured`);
    } catch (err) {
      console.log(`[Claude Process] Failed to configure hook: ${(err as Error).message}`);
    }
  }

  /**
   * Remove our hook from the project's .claude/settings.local.json.
   */
  private removeHook(cwd: string): void {
    if (!this.hookConfiguredDirs.has(cwd)) return;

    const settingsFile = path.join(cwd, '.claude', 'settings.local.json');
    if (!fs.existsSync(settingsFile)) return;

    try {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      if (!settings.hooks?.PreToolUse) return;

      // Remove our hook entries
      settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
        (h: any) => !h.hooks?.some((hook: any) => hook.command?.includes('permission-hook'))
      );

      // Clean up empty arrays
      if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse;
      if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

      // Write back or delete if empty
      if (Object.keys(settings).length === 0) {
        fs.unlinkSync(settingsFile);
      } else {
        fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), { encoding: 'utf-8', mode: 0o600 });
      }

      this.hookConfiguredDirs.delete(cwd);
      console.log(`[Claude Process] Hook removed`);
    } catch (err) {
      console.log(`[Claude Process] Failed to remove hook: ${(err as Error).message}`);
    }
  }

  /**
   * Start the permission IPC manager for a session.
   * Listens for hook permission requests and forwards them as events.
   */
  private startPermissionIpc(terminalSessionId: string, sessionKey?: string): void {
    // Stop any existing IPC manager for this session
    this.stopPermissionIpc(terminalSessionId);

    const ipcManager = new PermissionIpcManager();

    // Forward permission_prompt events from IPC manager
    ipcManager.on('permission_prompt', (event: PermissionPromptEvent) => {
      this.emit('permission_prompt', event);
    });

    ipcManager.start(terminalSessionId, sessionKey);
    this.permissionIpcManagers.set(terminalSessionId, ipcManager);
    console.log(`[Claude Process] Permission IPC started for ${terminalSessionId}`);
  }

  /**
   * Stop the permission IPC manager for a session.
   */
  private stopPermissionIpc(terminalSessionId: string): void {
    const existing = this.permissionIpcManagers.get(terminalSessionId);
    if (existing) {
      existing.cleanup();
      this.permissionIpcManagers.delete(terminalSessionId);
    }
  }

  /**
   * Handle a permission response from mobile for a specific prompt.
   */
  handlePermissionResponse(promptId: string, decision: 'allow' | 'deny', reason?: string): void {
    // Find the IPC manager that has this prompt
    for (const [, ipcManager] of this.permissionIpcManagers) {
      ipcManager.handleResponse(promptId, decision, reason);
    }
  }

  /**
   * Checks Claude CLI output for approval patterns and emits approval request events.
   *
   * Scans the output against all patterns in APPROVAL_PATTERNS. When a match is found,
   * creates a unique approval ID, sets up a timeout for auto-denial, and emits a
   * 'claude_approval_request' event with the approval details.
   *
   * Prevents duplicate approvals for the same terminal session.
   *
   * @param {string} terminalSessionId - The terminal session ID producing the output
   * @param {string} output - Raw output text from the Claude CLI process
   * @param {ClaudeProcessInfo} processInfo - Process information including output buffer
   * @fires ClaudeProcessManager#claude_approval_request
   * @private
   */
  private checkForApprovalPattern(
    _terminalSessionId: string,
    _output: string,
    _processInfo: ClaudeProcessInfo
  ): void {
    // All current processes use SDK mode (--output-format stream-json).
    // Regex-based approval detection doesn't work with JSON output — the patterns
    // match JSON fragments rather than real interactive prompts. Skip entirely.
    // Tool use is now reported via tool_activity events from checkForToolUseInSdkMessage().
    return;
  }

  /**
   * Checks SDK messages for tool_use content and emits approval notifications.
   *
   * In SDK mode, Claude doesn't emit text approval prompts. Instead, we detect
   * tool_use in the SDK messages and emit approval notifications so the mobile
   * app can display what Claude is doing. Note: This is a notification, not
   * a blocking approval - the tool may already be executed by the time the
   * user sees this.
   *
   * @param {string} terminalSessionId - The terminal session ID
   * @param {any} message - The parsed SDK JSON message
   * @param {ClaudeProcessInfo} processInfo - Process info for context
   * @private
   */
  private checkForToolUseInSdkMessage(
    terminalSessionId: string,
    message: any,
    processInfo: ClaudeProcessInfo
  ): void {
    // Only check assistant messages with content
    if (message.type !== 'assistant') {
      return;
    }

    if (!message.message?.content) {
      return;
    }

    const content = Array.isArray(message.message.content)
      ? message.message.content
      : [message.message.content];

    // Find tool_use blocks and emit non-blocking activity events
    for (const block of content) {
      if (block.type === 'tool_use') {
        const toolName = block.name || 'Unknown tool';
        const toolId = block.id || '';
        const toolInput = block.input || {};

        // Format input for display
        let inputSummary = '';
        if (typeof toolInput === 'object') {
          if (toolInput.file_path) {
            inputSummary = `File: ${toolInput.file_path}`;
          } else if (toolInput.command) {
            inputSummary = `Command: ${toolInput.command.substring(0, 100)}`;
          } else if (toolInput.pattern) {
            inputSummary = `Pattern: ${toolInput.pattern}`;
          } else {
            try {
              inputSummary = JSON.stringify(toolInput).substring(0, 200);
            } catch {
              inputSummary = '[unserializable input]';
            }
          }
        }

        console.log(`[Claude Process] Tool activity: ${toolName} (${toolId})`);

        // Emit non-blocking tool_activity event (not an approval request)
        const toolActivity: ToolActivityEvent = {
          terminalSessionId,
          sessionKey: processInfo.sessionKey,
          toolName,
          toolId,
          inputSummary,
        };

        this.emit('tool_activity', toolActivity);
      }
    }
  }

  /**
   * Handles approval request timeout by automatically denying the request.
   *
   * Called when the approval timeout (APPROVAL_TIMEOUT_MS) expires without
   * receiving a user response. Automatically sends 'n' (no/deny) to the
   * Claude CLI process to prevent indefinite blocking.
   *
   * @param {string} approvalId - The unique identifier of the timed-out approval
   * @private
   */
  private handleApprovalTimeout(approvalId: string): void {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return;

    console.log(`[Claude Process] Approval timeout for ${approvalId}, auto-denying`);
    this.handleApprovalResponse(approvalId, 'n'); // Auto-deny with 'n'
  }

  /**
   * Handles an approval response received from the mobile app.
   *
   * Processes the user's response to an approval request by:
   * 1. Looking up the pending approval by ID
   * 2. Clearing the auto-deny timeout
   * 3. Writing the response character (e.g., 'y', 'n', 'p') to the Claude CLI stdin
   *
   * @param {string} approvalId - The unique identifier of the approval being responded to
   * @param {string} response - The user's response (first character will be sent to stdin)
   * @public
   */
  handleApprovalResponse(approvalId: string, response: string): void {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      console.log(`[Claude Process] No pending approval found for ${approvalId}`);
      return;
    }

    // Clear timeout
    clearTimeout(pending.timeoutId);
    this.pendingApprovals.delete(approvalId);

    // Get process and write response to stdin
    const processInfo = this.processes.get(pending.terminalSessionId);
    if (!processInfo?.process) {
      console.log(`[Claude Process] No process for ${pending.terminalSessionId}`);
      return;
    }

    // SDK mode (stream-json) does not accept raw character input — writing 'y' or 'n'
    // to stdin would be interpreted as a malformed JSONL message, not an approval response.
    // The tool has already executed by the time the user sees the notification.
    console.log(`[Claude Process] Approval response for ${approvalId} ignored — SDK mode processes don't accept raw stdin approval characters`);
  }

  /**
   * Retrieves a pending approval request for a specific terminal session.
   *
   * Searches through all pending approvals to find one matching the given
   * terminal session ID. Useful for checking if there's an active approval
   * request for a session before creating a new one.
   *
   * @param {string} terminalSessionId - The terminal session ID to search for
   * @returns {PendingApproval | undefined} The pending approval if found, undefined otherwise
   * @public
   */
  getPendingApproval(terminalSessionId: string): PendingApproval | undefined {
    for (const pending of this.pendingApprovals.values()) {
      if (pending.terminalSessionId === terminalSessionId) {
        return pending;
      }
    }
    return undefined;
  }

  /**
   * Parse thinking content from SDK messages.
   * Claude SDK emits content_block_delta with type 'thinking' for extended thinking.
   */
  private parseThinkingContent(
    terminalSessionId: string,
    message: any,
    sessionKey?: string
  ): void {
    // Check for content_block_delta with thinking type
    if (message.type === 'content_block_delta' && message.delta?.type === 'thinking_delta') {
      const thinkingId = message.index?.toString() || `thinking-${Date.now()}`;
      const content = message.delta?.thinking || '';

      this.emit('thinking_content', {
        terminalSessionId,
        sessionKey,
        thinkingId,
        content,
        partial: true,
      });
      return;
    }

    // Check for content_block_stop to mark thinking complete
    if (message.type === 'content_block_stop') {
      const processInfo = this.processes.get(terminalSessionId);
      // Check if this was a thinking block by looking at recent messages
      // The SDK sends content_block_start before deltas, so we track by index
      const thinkingId = message.index?.toString() || '';
      if (thinkingId) {
        this.emit('thinking_content', {
          terminalSessionId,
          sessionKey,
          thinkingId,
          content: '',
          partial: false,
        });
      }
    }

    // Also check for thinking in assistant message content array
    if (message.type === 'assistant' && message.message?.content) {
      const content = Array.isArray(message.message.content)
        ? message.message.content
        : [message.message.content];

      for (const block of content) {
        if (block.type === 'thinking' && block.thinking) {
          this.emit('thinking_content', {
            terminalSessionId,
            sessionKey,
            thinkingId: `msg-${message.message?.id || Date.now()}`,
            content: block.thinking,
            partial: false,
          });
        }
      }
    }
  }

  /**
   * Parse token usage from SDK messages.
   * Claude SDK emits message_delta with usage field containing token counts.
   */
  private parseTokenUsage(
    terminalSessionId: string,
    message: any,
    sessionKey?: string
  ): void {
    // Check for message_delta with usage
    if (message.type === 'message_delta' && message.usage) {
      const usage = message.usage;
      if (usage.input_tokens !== undefined || usage.output_tokens !== undefined) {
        this.emit('token_usage', {
          terminalSessionId,
          sessionKey,
          usage: {
            inputTokens: usage.input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
          },
        });
      }
      return;
    }

    // Also check for usage in result messages (end of conversation turn)
    if (message.type === 'result' && message.usage) {
      const usage = message.usage;
      this.emit('token_usage', {
        terminalSessionId,
        sessionKey,
        usage: {
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
        },
      });
    }
  }

  /**
   * Parse task progress from SDK messages.
   * Detects TaskCreate, TaskUpdate, TaskList tool uses and extracts task data.
   */
  private parseTaskProgress(
    terminalSessionId: string,
    message: any,
    sessionKey?: string
  ): void {
    // Only process assistant messages with tool_use
    if (message.type !== 'assistant') return;

    const content = message.message?.content;
    if (!content) return;

    const contentArray = Array.isArray(content) ? content : [content];

    for (const block of contentArray) {
      if (block.type !== 'tool_use') continue;

      const toolName = block.name?.toLowerCase();
      if (!toolName) continue;

      // Handle TaskCreate
      if (toolName === 'taskcreate') {
        const input = block.input || {};
        const task: TaskInfo = {
          id: block.id || `task-${Date.now()}`,
          subject: input.subject || 'New Task',
          status: 'pending',
          activeForm: input.activeForm,
        };

        console.log(`[Claude Process] Task created: ${task.id || 'unknown'}`);
        this.emit('task_progress', {
          terminalSessionId,
          sessionKey,
          type: 'created',
          task,
        });
      }

      // Handle TaskUpdate
      if (toolName === 'taskupdate') {
        const input = block.input || {};
        const task: TaskInfo = {
          id: input.taskId || block.id || '',
          subject: input.subject || '',
          status: input.status || 'pending',
          activeForm: input.activeForm,
        };

        const eventType = task.status === 'completed' ? 'completed' : 'updated';
        console.log(`[Claude Process] Task ${eventType}: ${task.id} -> ${task.status}`);
        this.emit('task_progress', {
          terminalSessionId,
          sessionKey,
          type: eventType,
          task,
        });
      }

      // Handle TaskList (tool result contains the list)
      if (toolName === 'tasklist') {
        console.log(`[Claude Process] Task list requested`);
        // TaskList doesn't have task data in tool_use, only in tool_result
        // We'll emit a list event when we see the result
      }
    }

    // Also check for tool_result from TaskList
    if (message.type === 'tool_result') {
      const toolName = message.tool_name?.toLowerCase();
      if (toolName === 'tasklist' && message.content) {
        try {
          // TaskList result might be JSON array of tasks
          const tasks = typeof message.content === 'string'
            ? JSON.parse(message.content)
            : message.content;

          if (Array.isArray(tasks)) {
            this.emit('task_progress', {
              terminalSessionId,
              sessionKey,
              type: 'list',
              tasks: tasks.map((t: any) => ({
                id: t.id || '',
                subject: t.subject || '',
                status: t.status || 'pending',
                activeForm: t.activeForm,
              })),
            });
          }
        } catch (e) {
          // Not JSON, ignore
        }
      }
    }
  }
}

export { ClaudeProcessManager };
export const claudeProcessManager = new ClaudeProcessManager();
export default claudeProcessManager;
