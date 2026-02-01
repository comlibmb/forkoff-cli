/**
 * Claude Process Manager
 * Spawns and manages Claude CLI processes for terminal sessions
 */

import spawn from 'cross-spawn';
import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';

interface ClaudeProcessInfo {
  terminalSessionId: string;
  process: ChildProcess;
  directory: string;
  sessionKey?: string;
  outputBuffer: string[]; // Recent output lines for context
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
  thinking_content: [event: ThinkingContentEvent];
  token_usage: [event: TokenUsageEvent];
  task_progress: [event: TaskProgressEvent];
}

class ClaudeProcessManager extends EventEmitter {
  private processes: Map<string, ClaudeProcessInfo> = new Map();
  private pendingApprovals: Map<string, PendingApproval> = new Map();
  private readonly APPROVAL_TIMEOUT_MS: number = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_OUTPUT_BUFFER_LINES: number = 20;

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
  async startSession(directory: string, terminalSessionId: string): Promise<{ cwd: string }> {
    const resolvedDir = this.resolvePath(directory);

    // SDK flags for structured JSON communication
    const args = [
      '--output-format', 'stream-json', // JSONL output from Claude
      '--input-format', 'stream-json',  // JSONL input to Claude
      '--verbose',                      // Complete messages
      // '--permission-mode' removed - using default mode for tool execution
    ];

    // SECURITY: Using cross-spawn instead of shell: true to prevent command injection
    const proc = spawn('claude', args, {
      cwd: resolvedDir,
      env: { ...process.env, TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.setupProcessHandlers(terminalSessionId, proc, resolvedDir);
    this.processes.set(terminalSessionId, { terminalSessionId, process: proc, directory: resolvedDir, outputBuffer: [] });

    return { cwd: resolvedDir };
  }

  /**
   * Resume an existing Claude session
   */
  async resumeSession(sessionKey: string, directory: string, terminalSessionId: string): Promise<{ cwd: string }> {
    const resolvedDir = this.resolvePath(directory);

    // SDK flags for structured JSON communication
    // When resuming from mobile, use acceptEdits to auto-approve file operations
    // This is necessary because SDK JSON streaming mode interprets raw 'y' input
    // as a user message rather than a permission approval
    const args = [
      '--resume', sessionKey,           // Pass session key to --resume!
      '--output-format', 'stream-json', // JSONL output from Claude
      '--input-format', 'stream-json',  // JSONL input to Claude
      '--verbose',                      // Complete messages
      '--permission-mode', 'acceptEdits', // Auto-approve edits when controlled from mobile
    ];

    console.log(`[Claude Process] Spawning: claude ${args.join(' ')}`);

    // SECURITY: Using cross-spawn instead of shell: true to prevent command injection
    const proc = spawn('claude', args, {
      cwd: resolvedDir,
      env: { ...process.env, TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.setupProcessHandlers(terminalSessionId, proc, resolvedDir, sessionKey);
    this.processes.set(terminalSessionId, { terminalSessionId, process: proc, directory: resolvedDir, sessionKey, outputBuffer: [] });

    return { cwd: resolvedDir };
  }

  /**
   * Send input to a Claude process in JSONL format
   * Format: {"type":"user","message":{"role":"user","content":"..."}}
   */
  sendInput(terminalSessionId: string, input: string): void {
    const info = this.processes.get(terminalSessionId);
    if (!info?.process) {
      console.log(`[Claude Process] No process found for ${terminalSessionId}`);
      return;
    }

    // Check if process has exited
    if (info.process.exitCode !== null) {
      console.log(`[Claude Process] Process already exited for ${terminalSessionId} (exit code: ${info.process.exitCode})`);
      return;
    }

    if (!info.process.stdin || info.process.stdin.destroyed) {
      console.log(`[Claude Process] stdin is closed or destroyed for ${terminalSessionId}`);
      return;
    }

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

    try {
      info.process.stdin.write(jsonLine, (err) => {
        if (err) {
          console.error(`[Claude Process] Error writing to stdin for ${terminalSessionId}:`, err.message);
        }
      });
    } catch (err) {
      console.error(`[Claude Process] Exception writing to stdin for ${terminalSessionId}:`, (err as Error).message);
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
    let jsonLineBuffer = '';

    proc.stdout?.on('data', (data: Buffer) => {
      const rawOutput = data.toString();
      jsonLineBuffer += rawOutput;

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
            console.log(`[Claude Process] Non-JSON stdout: ${line.substring(0, 50)}...`);
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
   * SECURITY: Validates path doesn't contain dangerous characters
   */
  private resolvePath(dir: string): string {
    // SECURITY: Reject paths with shell metacharacters that could be dangerous
    if (/[;&|`$()<>]/.test(dir)) {
      throw new Error('Invalid directory path: contains disallowed characters');
    }

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
    terminalSessionId: string,
    output: string,
    processInfo: ClaudeProcessInfo
  ): void {
    // Check if output matches any approval pattern
    const matchedPattern = APPROVAL_PATTERNS.find(pattern => pattern.test(output));
    if (!matchedPattern) return;

    // Don't create duplicate approvals
    for (const pending of this.pendingApprovals.values()) {
      if (pending.terminalSessionId === terminalSessionId) {
        console.log(`[Claude Process] Approval already pending for ${terminalSessionId}`);
        return;
      }
    }

    const approvalId = `approval-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const options = extractApprovalOptions(output);

    console.log(`[Claude Process] Approval pattern detected: ${matchedPattern.toString()}`);
    console.log(`[Claude Process] Options: ${options.join(', ')}`);

    // Set up timeout for auto-deny
    const timeoutId = setTimeout(() => {
      this.handleApprovalTimeout(approvalId);
    }, this.APPROVAL_TIMEOUT_MS);

    // Track pending approval
    this.pendingApprovals.set(approvalId, {
      approvalId,
      terminalSessionId,
      createdAt: Date.now(),
      timeoutId,
    });

    // Extract human-readable prompt from SDK JSON output
    let promptText = output.trim();
    let toolName = '';
    let toolInput = '';

    // Try to parse as JSON and extract meaningful content
    try {
      const lines = output.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const json = JSON.parse(line);
          // Check for tool_use in message content
          if (json.message?.content) {
            const content = Array.isArray(json.message.content) ? json.message.content : [json.message.content];
            for (const block of content) {
              if (block.type === 'tool_use') {
                toolName = block.name || 'Unknown tool';
                toolInput = typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2);
                promptText = `Claude wants to use: ${toolName}`;
                break;
              } else if (typeof block === 'string' && block.includes('[y]es')) {
                promptText = block;
                break;
              } else if (block.text && block.text.includes('[y]es')) {
                promptText = block.text;
                break;
              }
            }
          }
        } catch (e) {
          // Not JSON, might be text prompt
          if (line.includes('[y]es') || line.includes('(y/n)')) {
            promptText = line;
            break;
          }
        }
      }
    } catch (e) {
      // Keep original output
    }

    // Build context with tool details if available
    const context = [...processInfo.outputBuffer];
    if (toolInput && toolInput.length > 0) {
      context.push(`Tool: ${toolName}`);
      context.push(`Input: ${toolInput.substring(0, 500)}${toolInput.length > 500 ? '...' : ''}`);
    }

    // Emit approval request event
    const approvalRequest: ClaudeApprovalRequest = {
      approvalId,
      terminalSessionId,
      sessionKey: processInfo.sessionKey,
      context,
      options,
      promptText,
    };

    this.emit('claude_approval_request', approvalRequest);
    console.log(`[Claude Process] Emitted claude_approval_request: ${approvalId}, promptText: ${promptText.substring(0, 50)}...`);
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

    // Debug: log the message structure
    console.log(`[Claude Process] Checking assistant message for tool_use...`);

    if (!message.message?.content) {
      console.log(`[Claude Process] No message.content found in assistant message`);
      return;
    }

    const content = Array.isArray(message.message.content)
      ? message.message.content
      : [message.message.content];

    // Find tool_use blocks
    for (const block of content) {
      if (block.type === 'tool_use') {
        const toolName = block.name || 'Unknown tool';
        const toolId = block.id || '';
        const toolInput = block.input || {};

        // Check if we already have a pending approval for this terminal
        let alreadyPending = false;
        for (const pending of this.pendingApprovals.values()) {
          if (pending.terminalSessionId === terminalSessionId) {
            alreadyPending = true;
            break;
          }
        }
        if (alreadyPending) {
          console.log(`[Claude Process] Tool use detected but approval already pending for ${terminalSessionId}`);
          continue;
        }

        // Create approval notification
        const approvalId = `tool-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

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
            inputSummary = JSON.stringify(toolInput).substring(0, 200);
          }
        }

        const promptText = `Claude is using: ${toolName}`;
        const context = inputSummary ? [inputSummary, ...processInfo.outputBuffer.slice(-5)] : processInfo.outputBuffer.slice(-10);

        console.log(`[Claude Process] Tool use detected: ${toolName} (${toolId})`);
        console.log(`[Claude Process] Input summary: ${inputSummary.substring(0, 100)}`);

        // Set up timeout (5 minutes to match original plan)
        const timeoutId = setTimeout(() => {
          console.log(`[Claude Process] Tool approval timeout: ${approvalId}`);
          this.pendingApprovals.delete(approvalId);
        }, 300000); // 5 minute timeout for tool notifications

        // Track this notification
        this.pendingApprovals.set(approvalId, {
          approvalId,
          terminalSessionId,
          createdAt: Date.now(),
          timeoutId,
        });

        // Emit notification to mobile
        const approvalRequest: ClaudeApprovalRequest = {
          approvalId,
          terminalSessionId,
          sessionKey: processInfo.sessionKey,
          context,
          options: ['y:yes', 'n:no', 'p:plan'], // Standard options
          promptText,
        };

        this.emit('claude_approval_request', approvalRequest);
        console.log(`[Claude Process] Emitted tool_use notification: ${approvalId}, tool: ${toolName}`);
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

    // Check if process has exited
    if (processInfo.process.exitCode !== null) {
      console.log(`[Claude Process] Process already exited for ${pending.terminalSessionId} (exit code: ${processInfo.process.exitCode}), cannot send approval response`);
      return;
    }

    if (!processInfo.process.stdin || processInfo.process.stdin.destroyed) {
      console.log(`[Claude Process] stdin is closed or destroyed for ${pending.terminalSessionId}, cannot send approval response`);
      return;
    }

    // Write the response character to stdin (e.g., 'y', 'n', 'p')
    const char = response.charAt(0).toLowerCase();
    console.log(`[Claude Process] Writing response '${char}' to stdin for ${pending.terminalSessionId}`);

    try {
      processInfo.process.stdin.write(char, (err) => {
        if (err) {
          console.error(`[Claude Process] Error writing approval response to stdin for ${pending.terminalSessionId}:`, err.message);
        }
      });
    } catch (err) {
      console.error(`[Claude Process] Exception writing approval response to stdin for ${pending.terminalSessionId}:`, (err as Error).message);
    }
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

        console.log(`[Claude Process] Task created: ${task.subject}`);
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

export const claudeProcessManager = new ClaudeProcessManager();
export default claudeProcessManager;
