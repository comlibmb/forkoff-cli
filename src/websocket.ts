import { config } from './config';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { E2EEManager } from './crypto/e2eeManager';
import { KeyExchangeInit, KeyExchangeAck, EncryptedMessage } from './crypto/types';
import { EmbeddedRelayServer } from './server';
import type { UsageTracker } from './usage-tracker';

type DeviceStatus = 'online' | 'offline' | 'busy' | 'syncing';

interface TerminalCommand {
  terminalSessionId: string;
  command: string;
  requestedBy: string;
}

interface TerminalCreate {
  terminalSessionId: string;
  cwd: string;
  requestedBy: string;
}

interface ApprovalResponse {
  approvalId: string;
  sessionId: string;
  status: 'APPROVED' | 'REJECTED';
  respondedBy: string;
}

interface ClaudeResumeRequest {
  sessionKey: string;
  directory: string;
  terminalSessionId: string;
  requestedBy: string;
  dangerouslySkipPermissions?: boolean;
}

interface UserMessageRequest {
  deviceId: string;
  message: string;
  sessionKey?: string;
  terminalSessionId?: string;
  mode?: {
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    model?: string;
  };
}

interface ClaudeStartRequest {
  directory: string;
  terminalSessionId: string;
  requestedBy: string;
  dangerouslySkipPermissions?: boolean;
}

interface DirectoryListRequest {
  path: string;
  requestId: string;
  requestedBy: string;
}

interface ReadFileRequest {
  filePath: string;
  requestId: string;
  requestedBy: string;
}

interface ClaudeSessionUpdate {
  sessionKey: string;
  directory: string;
  name?: string;
  state: 'active' | 'inactive';
  lastUsedAt: string;
  transcriptPath?: string;
}

interface TranscriptFetchRequest {
  sessionKey: string;
  transcriptPath: string;
  offset?: number;
  limit?: number;
  requestedBy: string;
}

interface TranscriptSubscribeRequest {
  sessionKey: string;
  transcriptPath: string;
  requestedBy: string;
}

interface TranscriptEntry {
  id: string;
  parentId?: string;
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result';
  timestamp: string;
  lineNumber: number;
  content?: {
    role?: 'user' | 'assistant';
    text?: string;
    toolName?: string;
    toolInput?: any;
    isError?: boolean;
  };
}

// Claude approval request for mobile approval
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

// Claude approval response from mobile
interface ClaudeApprovalResponse {
  approvalId: string;
  response: string;        // The response character ('y', 'n', 'p', etc.)
  respondedBy: string;
}

// Whitelist of events allowed via encrypted_message channel (inbound from mobile)
const ALLOWED_ENCRYPTED_EVENTS = new Set([
  'terminal_command',
  'terminal_create',
  'terminal_resize',
  'terminal_close',
  'claude_start_session',
  'claude_resume_session',
  'claude_stop_session',
  'user_message',
  'directory_list',
  'read_file',
  'transcript_fetch',
  'transcript_subscribe',
  'transcript_unsubscribe',
  'permission_response',
  'permission_rules_sync',
  'session_settings_update',
  'transcript_subscribe_sdk',
  'tab_complete',
  'claude_approval_response',
  'approval_response',
  'sdk_session_history',
  'claude_abort',
  'usage_stats_request',
]);

// Events that carry user data and MUST be encrypted — plaintext fallback is refused.
// If E2EE is not established, these are queued (not sent in plaintext).
const ENFORCED_SENSITIVE_EVENTS = new Set([
  // Core sensitive data
  'terminal_output',
  'read_file_response',
  'directory_list_response',
  'permission_prompt',
  // Transcript data (contains full code, file contents, conversation history)
  'transcript_history',
  'transcript_update',
  // Claude reasoning and session data
  'thinking_content',
  'task_progress',
  'tool_activity',
  // Approval context
  'claude_approval_request',
  'approval_request',
  // Session metadata (contains directory paths, file paths, working directories)
  'claude_session_update',
  'claude_session_batch_update',
  'terminal_cwd',
  'file_changed',
  // Token usage (contains session identifiers)
  'token_usage',
  // Pending permissions (contains prompt details)
  'pending_permissions_sync',
  // Session events (may contain error messages with paths)
  'claude_session_event',
  // Usage analytics sync
  'usage_stats_sync',
  'daily_usage_sync',
  'streak_info_sync',
]);

// SECURITY: Inbound events from mobile that MUST arrive via E2EE decryption when active.
// Plaintext versions are dropped when E2EE session is established with mobile peer.
const ENFORCED_INBOUND_EVENTS = new Set([
  'terminal_command', 'user_message', 'read_file', 'directory_list',
  'tab_complete', 'permission_response', 'claude_approval_response',
  'approval_response', 'rpc_response', 'terminal_create',
  'sdk_session_history', 'claude_abort', 'claude_start_session',
  'claude_resume_session', 'transcript_fetch', 'transcript_subscribe',
  'permission_rules_sync',
  'usage_stats_request',
]);

interface PendingSensitiveMessage {
  event: string;
  data: any;
  targetDeviceId: string;
  queuedAt: number;
}

/** Events forwarded from server that need plaintext-drop checking */
const PLAINTEXT_DROP_EVENTS = [
  'terminal_create', 'terminal_command', 'approval_response',
  'user_message', 'claude_resume_session', 'claude_start_session',
  'directory_list', 'transcript_fetch', 'transcript_subscribe',
  'read_file', 'claude_approval_response', 'permission_response',
  'permission_rules_sync', 'claude_abort', 'tab_complete',
  'usage_stats_request',
];

/** Events forwarded from server that do NOT need plaintext-drop checking */
const PASSTHROUGH_EVENTS = [
  'transcript_unsubscribe', 'claude_sessions_request', 'pair_device',
];

export class WebSocketClient extends EventEmitter {
  private server: EmbeddedRelayServer | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private _sessionId: string = '';
  private e2eeManager: E2EEManager | null = null;
  private e2eeInitialized = false;
  // The mobile device ID learned from key exchange (used for encrypting CLI→mobile messages)
  private e2eePeerDeviceId: string | null = null;
  // Queue for sensitive messages waiting for E2EE session establishment
  private pendingSensitiveMessages: PendingSensitiveMessage[] = [];
  private static readonly SENSITIVE_QUEUE_TTL_MS = 30_000; // 30 seconds max wait
  private static readonly MAX_PENDING_SENSITIVE = 200;
  private usageTracker: UsageTracker | null = null;

  // Unique session ID for this CLI connection
  get sessionId(): string {
    if (!this._sessionId) {
      this._sessionId = uuidv4();
    }
    return this._sessionId;
  }

  /** Start the embedded relay server and wire up event forwarding */
  async startServer(port: number): Promise<void> {
    const deviceId = config.deviceId;
    if (!deviceId) {
      throw new Error('Device not registered');
    }

    this.server = new EmbeddedRelayServer({
      port,
      deviceId,
      deviceName: config.deviceName,
    });

    await this.server.start();

    // When mobile connects, emit connected + start heartbeat + initiate E2EE
    this.server.on('mobile_connected', (data) => {
      console.log(`[WS] Mobile connected: ${data.deviceId}`);
      this.emit('connected');
      this.startHeartbeat();

      // Initiate E2EE key exchange with the connected mobile device
      if (this.e2eeManager && this.e2eeInitialized) {
        try {
          // Clear any old session keys for this device — forces fresh key exchange.
          // Without this, queued messages would be encrypted with stale keys from
          // a previous connection that the mobile no longer has.
          this.e2eeManager.clearSession(data.deviceId);

          const initPayload = this.e2eeManager.createKeyExchangeInit(data.deviceId);
          this.server?.emitToMobile('encrypted_key_exchange_init', {
            ...initPayload,
            recipientDeviceId: data.deviceId,
          });
          // E2EE key exchange initiated
        } catch (err) {
          console.warn('[E2EE] Failed to initiate key exchange');
        }
      }
    });

    this.server.on('mobile_disconnected', (data) => {
      console.log(`[WS] Mobile disconnected: ${data.reason}`);
      this.emit('disconnected', data.reason);
      this.stopHeartbeat();
    });

    // Forward events that need plaintext-drop check
    for (const event of PLAINTEXT_DROP_EVENTS) {
      this.server.on(event, (data: any) => {
        if (this.shouldDropPlaintextInbound()) return;
        if (process.env.DEBUG) {
          console.log(`[WS] Received ${event}`);
        }
        this.emit(event, data);
      });
    }

    // Forward events that pass through without plaintext-drop check
    for (const event of PASSTHROUGH_EVENTS) {
      this.server.on(event, (data: any) => {
        if (process.env.DEBUG) {
          console.log(`[WS] Received ${event}`);
        }
        this.emit(event, data);
      });
    }

    // On successful pairing, reset TOFU trust for that specific device (handles re-pair with new keys).
    // Don't delete pending exchange or re-initiate — the init from mobile_connected is in-flight.
    this.server.on('pair_device', (data: any) => {
      const mobileDeviceId = data.mobileDeviceId;
      if (mobileDeviceId && this.e2eeManager) {
        this.e2eeManager.clearTrustOnly(mobileDeviceId);
        // Reset TOFU trust for re-pair
      }
    });

    // E2EE key exchange events — forwarded from server, handled here
    this.server.on('encrypted_key_exchange_init', (data: KeyExchangeInit) => {
      if (!this.e2eeManager) return;
      try {
        const ack = this.e2eeManager.handleKeyExchangeInit(data);
        this.e2eePeerDeviceId = data.senderDeviceId;
        this.server?.emitToMobile('encrypted_key_exchange_ack', {
          ...ack,
          senderDeviceId: config.deviceId,
          recipientDeviceId: data.senderDeviceId,
        });
        this.emit('e2ee_established', { peerDeviceId: data.senderDeviceId });
        this.flushSensitiveQueue();
        this.sendAllUsageStats();
      } catch (err) {
        console.error('[E2EE] Key exchange init failed');
      }
    });

    this.server.on('encrypted_key_exchange_ack', (data: KeyExchangeAck) => {
      if (!this.e2eeManager) return;
      try {
        this.e2eeManager.handleKeyExchangeAck(data);
        this.e2eePeerDeviceId = data.senderDeviceId;
        this.emit('e2ee_established', { peerDeviceId: data.senderDeviceId });
        this.flushSensitiveQueue();
        this.sendAllUsageStats();
      } catch (err) {
        console.error('[E2EE] Key exchange ack failed');
      }
    });

    // Encrypted messages — decrypt and re-emit as original event
    this.server.on('encrypted_message', (data: EncryptedMessage) => {
      if (!this.e2eeManager) return;

      let plaintext: string;
      try {
        plaintext = this.e2eeManager.decryptMessage(data, data.senderDeviceId);
      } catch {
        console.error('[E2EE] Decryption failed — message dropped');
        return;
      }

      // Validate JSON structure separately from decryption
      let parsed: unknown;
      try {
        parsed = JSON.parse(plaintext);
      } catch {
        console.error('[E2EE] Invalid JSON in decrypted message — dropped');
        return;
      }

      // Validate payload structure
      if (!parsed || typeof parsed !== 'object') {
        console.error('[E2EE] Decrypted payload is not an object — dropped');
        return;
      }

      const payload = parsed as Record<string, unknown>;
      const eventName = payload._event;

      if (typeof eventName !== 'string') {
        console.error('[E2EE] Missing or invalid _event in decrypted payload — dropped');
        return;
      }

      if (!ALLOWED_ENCRYPTED_EVENTS.has(eventName)) {
        console.warn('[E2EE] Decrypted event not in whitelist — dropped');
        return;
      }

      this.emit(eventName, payload._data);
    });

    // Initialize E2EE (non-blocking — don't delay server start)
    this.initE2EE().catch((err) => {
      console.warn('[E2EE] \u26a0 End-to-end encryption initialization failed. Messages will be sent without E2EE protection.');
      if (process.env.DEBUG) {
        console.warn(`[E2EE] Init error detail:`, err.message);
      }
    });
  }

  /** Set pairing code on the embedded server for in-process validation */
  setPairingCode(code: string): void {
    this.server?.setPairingCode(code);
  }

  /**
   * Initialize E2EE manager: generate/load keys.
   * Called automatically on startServer. Non-blocking.
   */
  private async initE2EE(): Promise<void> {
    const deviceId = config.deviceId;
    if (!deviceId) return;

    this.e2eeManager = new E2EEManager(deviceId);
    await this.e2eeManager.initialize();
    this.e2eeInitialized = true;

    // Restore any persisted sessions
    const persisted = this.e2eeManager.listPersistedDevices();
    for (const targetDeviceId of persisted) {
      const restored = await this.e2eeManager.restorePersistedSession(targetDeviceId);
      if (restored) {
        // Restored persisted E2EE session
      }
    }

    // E2EE initialized
  }

  /**
   * Send a sensitive event: encrypt if E2EE session exists with the target device.
   * For events in ENFORCED_SENSITIVE_EVENTS, plaintext fallback is REFUSED — messages
   * are queued until E2EE session establishes, or dropped after timeout.
   */
  emitSensitive(event: string, data: any, targetDeviceId?: string): void {
    // If E2EE session exists, encrypt and send
    if (this.e2eeManager && targetDeviceId && this.e2eeManager.hasSessionKey(targetDeviceId)) {
      try {
        const plaintext = JSON.stringify({ _event: event, _data: data });
        const encrypted = this.e2eeManager.encryptMessage(
          plaintext,
          targetDeviceId,
          this._sessionId || 'default',
        );
        this.server?.emitToMobile('encrypted_message', encrypted);
        return;
      } catch (err) {
        console.error('[E2EE] Encryption failed, message NOT sent (refusing plaintext fallback)');
        return;
      }
    }

    // For enforced sensitive events: NEVER send plaintext — queue until E2EE establishes
    if (ENFORCED_SENSITIVE_EVENTS.has(event)) {
      if (this.e2eeInitialized) {
        // E2EE initialized but no session yet — queue for when session establishes
        if (this.pendingSensitiveMessages.length >= WebSocketClient.MAX_PENDING_SENSITIVE) {
          const dropped = this.pendingSensitiveMessages.shift();
          if (dropped) {
            console.warn('[E2EE] Sensitive queue full, dropped oldest');
          }
        }
        this.pendingSensitiveMessages.push({
          event,
          data,
          targetDeviceId: targetDeviceId || '__pending__',
          queuedAt: Date.now(),
        });
        if (this.pendingSensitiveMessages.length === 1) {
          console.warn('[E2EE] Queued sensitive event — waiting for E2EE session');
        }
        return;
      }
      // E2EE not initialized — drop silently (no user data leaks)
      console.error('[E2EE] Dropped sensitive event — E2EE not available, refusing plaintext');
      return;
    }

    // Non-sensitive events: plaintext is acceptable
    this.server?.emitToMobile(event, data);
  }

  /**
   * Flush queued sensitive messages now that E2EE session is established.
   * Drops messages older than SENSITIVE_QUEUE_TTL_MS.
   */
  private flushSensitiveQueue(): void {
    if (this.pendingSensitiveMessages.length === 0) return;

    const now = Date.now();
    let sent = 0;
    let dropped = 0;

    for (const msg of this.pendingSensitiveMessages) {
      if (now - msg.queuedAt > WebSocketClient.SENSITIVE_QUEUE_TTL_MS) {
        dropped++;
        continue;
      }
      // Resolve pending target device ID
      const target = msg.targetDeviceId === '__pending__'
        ? this.e2eePeerDeviceId ?? undefined
        : msg.targetDeviceId;
      // Attempt to send via encryption
      this.emitSensitive(msg.event, msg.data, target);
      sent++;
    }

    this.pendingSensitiveMessages = [];
    // Flushed sensitive queue
  }

  /** Get the E2EE manager (for external key exchange initiation) */
  getE2EEManager(): E2EEManager | null {
    return this.e2eeManager;
  }

  /** Check if E2EE session is active with a device */
  isE2EEActive(deviceId: string): boolean {
    return this.e2eeManager?.hasSessionKey(deviceId) ?? false;
  }

  /** SECURITY: Check if plaintext inbound events should be dropped (E2EE active with peer) */
  private shouldDropPlaintextInbound(): boolean {
    return !!(this.e2eePeerDeviceId && this.e2eeManager?.hasSessionKey(this.e2eePeerDeviceId));
  }

  disconnect(): void {
    this.stopHeartbeat();
    this.e2eeManager?.cleanup(false);
    this.e2eeManager = null;
    this.e2eeInitialized = false;
    this.e2eePeerDeviceId = null;
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, 30000); // Every 30 seconds
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  // Send heartbeat to connected mobile
  sendHeartbeat(status: DeviceStatus = 'online'): void {
    this.server?.emitToMobile('device_status', { status, deviceId: config.deviceId });
  }

  // Update device status
  updateStatus(status: DeviceStatus): void {
    this.server?.emitToMobile('device_status', { status, deviceId: config.deviceId });
  }

  // Send Claude session update (sensitive — contains directory paths)
  sendClaudeSessionUpdate(session: ClaudeSessionUpdate): void {
    this.emitSensitive('claude_session_update', { ...session, deviceId: config.deviceId }, this.e2eePeerDeviceId ?? undefined);
  }

  // Send multiple Claude sessions as a single batch event (sensitive — contains directory paths)
  sendClaudeSessions(sessions: ClaudeSessionUpdate[]): void {
    if (sessions.length > 0) {
      const withDeviceId = sessions.map(s => ({ ...s, deviceId: config.deviceId }));
      this.emitSensitive('claude_session_batch_update', { sessions: withDeviceId }, this.e2eePeerDeviceId ?? undefined);
    }
  }

  // Send tool status update (e.g., Claude active/inactive)
  sendToolStatusUpdate(toolType: string, status: 'active' | 'inactive' | 'error'): void {
    this.server?.emitToMobile('tool_status_update', {
      toolType,
      status,
      timestamp: new Date().toISOString(),
    });
  }

  // Send approval request (sensitive — contains code change descriptions)
  sendApprovalRequest(data: {
    sessionId: string;
    messageId: string;
    type: 'CODE_CHANGE' | 'FILE_OPERATION' | 'COMMAND_EXECUTION' | 'OTHER';
    description: string;
    changes: any;
  }): void {
    this.emitSensitive('approval_request', data, this.e2eePeerDeviceId ?? undefined);
  }

  // Send terminal output (sensitive — encrypted if E2EE active)
  sendTerminalOutput(data: {
    terminalSessionId: string;
    output: string;
    type: 'stdout' | 'stderr' | 'exit';
    exitCode?: number;
  }): void {
    this.emitSensitive('terminal_output', data, this.e2eePeerDeviceId ?? undefined);
  }

  // Send working directory change (sensitive — contains working directory path)
  sendTerminalCwd(data: { terminalSessionId: string; cwd: string }): void {
    this.emitSensitive('terminal_cwd', data, this.e2eePeerDeviceId ?? undefined);
  }

  // Send directory listing response (sensitive — encrypted if E2EE active)
  sendDirectoryListResponse(data: {
    requestId: string;
    entries: Array<{ name: string; type: 'file' | 'directory'; path: string }>;
    currentPath: string;
  }): void {
    this.emitSensitive('directory_list_response', data, this.e2eePeerDeviceId ?? undefined);
  }

  // Send read file response (sensitive — encrypted if E2EE active)
  sendReadFileResponse(data: {
    requestId: string;
    content?: string;
    exists: boolean;
    fileName: string;
    error?: string;
  }): void {
    this.emitSensitive('read_file_response', data, this.e2eePeerDeviceId ?? undefined);
  }

  // Send file change notification (sensitive — contains file paths)
  sendFileChanged(data: {
    projectId: string;
    filePath: string;
    changeType: 'created' | 'modified' | 'deleted';
  }): void {
    this.emitSensitive('file_changed', data, this.e2eePeerDeviceId ?? undefined);
  }

  // Send transcript history to mobile app (sensitive — contains code and conversation)
  sendTranscriptHistory(data: {
    sessionKey: string;
    entries: TranscriptEntry[];
    totalEntries: number;
    offset: number;
    hasMore: boolean;
    requestedBy?: string;
  }): void {
    this.emitSensitive('transcript_history', data, this.e2eePeerDeviceId ?? undefined);
  }

  // Send transcript update (new entry) to mobile app (sensitive — contains code)
  sendTranscriptUpdate(data: {
    sessionKey: string;
    entry: TranscriptEntry;
  }): void {
    this.emitSensitive('transcript_update', data, this.e2eePeerDeviceId ?? undefined);
  }

  // Send Claude approval request to mobile (sensitive — contains context)
  sendClaudeApprovalRequest(data: ClaudeApprovalRequest): void {
    console.log(`[WS] Sending claude_approval_request: ${data.approvalId}`);
    this.emitSensitive('claude_approval_request', data, this.e2eePeerDeviceId ?? undefined);
  }

  // Send tool activity notification to mobile (sensitive — contains tool inputs)
  sendToolActivity(data: {
    terminalSessionId: string;
    sessionKey?: string;
    toolName: string;
    toolId: string;
    inputSummary: string;
  }): void {
    console.log(`[WS] Sending tool_activity: ${data.toolName} (${data.toolId})`);
    this.emitSensitive('tool_activity', data, this.e2eePeerDeviceId ?? undefined);
  }

  // Send permission prompt to mobile (sensitive — encrypted if E2EE active)
  sendPermissionPrompt(data: {
    promptId: string;
    terminalSessionId: string;
    sessionKey?: string;
    toolName: string;
    toolInput: any;
    toolUseId: string;
  }): void {
    console.log(`[WS] Sending permission_prompt: ${data.toolName} (${data.promptId})`);
    this.emitSensitive('permission_prompt', data, this.e2eePeerDeviceId ?? undefined);
  }

  // Send thinking content to mobile (sensitive — contains Claude's reasoning about code)
  sendThinkingContent(data: {
    sessionKey?: string;
    thinkingId: string;
    content: string;
    partial: boolean;
  }): void {
    this.emitSensitive('thinking_content', data, this.e2eePeerDeviceId ?? undefined);
  }

  // Send token usage to mobile (sensitive — contains session identifiers)
  sendTokenUsage(data: {
    sessionKey?: string;
    usage: {
      inputTokens: number;
      outputTokens: number;
    };
  }): void {
    this.emitSensitive('token_usage', data, this.e2eePeerDeviceId ?? undefined);
  }

  // Send pending permissions sync to mobile (sensitive — contains prompt details)
  sendPendingPermissionsSync(data: {
    sessionKey: string;
    terminalSessionId: string;
    prompts: any[];
  }): void {
    console.log(`[WS] Sending pending_permissions_sync: ${data.prompts.length} prompt(s)`);
    this.emitSensitive('pending_permissions_sync', data, this.e2eePeerDeviceId ?? undefined);
  }

  // Send task progress to mobile (sensitive — contains task subjects/descriptions)
  sendTaskProgress(data: {
    sessionKey?: string;
    type: 'created' | 'updated' | 'completed' | 'list';
    task?: {
      id: string;
      subject: string;
      status: 'pending' | 'in_progress' | 'completed';
      activeForm?: string;
    };
    tasks?: Array<{
      id: string;
      subject: string;
      status: 'pending' | 'in_progress' | 'completed';
      activeForm?: string;
    }>;
  }): void {
    this.emitSensitive('task_progress', data, this.e2eePeerDeviceId ?? undefined);
  }

  // E2EE event emitters — send to mobile via server
  emitKeyExchangeInit(data: {
    recipientDeviceId: string;
    senderDeviceId: string;
    ephemeralPublicKey: string;
  }): void {
    this.server?.emitToMobile('encrypted_key_exchange_init', data);
  }

  emitKeyExchangeAck(data: {
    recipientDeviceId: string;
    senderDeviceId: string;
    ephemeralPublicKey: string;
  }): void {
    this.server?.emitToMobile('encrypted_key_exchange_ack', data);
  }

  emitEncryptedMessage(data: any): void {
    this.server?.emitToMobile('encrypted_message', data);
  }

  /** Set the usage tracker instance (called from index.ts after instantiation) */
  setUsageTracker(tracker: UsageTracker): void {
    this.usageTracker = tracker;
  }

  /** Send all usage stats to mobile (called after E2EE established and on request) */
  sendAllUsageStats(): void {
    if (!this.usageTracker) return;
    const deviceId = config.deviceId;
    const stats = this.usageTracker.getUsageStats('all');
    const daily = this.usageTracker.getDailyUsage();
    const streak = this.usageTracker.getStreakInfo();

    this.emitSensitive('usage_stats_sync', { ...stats, deviceId }, this.e2eePeerDeviceId ?? undefined);
    this.emitSensitive('daily_usage_sync', { daily, deviceId }, this.e2eePeerDeviceId ?? undefined);
    this.emitSensitive('streak_info_sync', { ...streak, deviceId }, this.e2eePeerDeviceId ?? undefined);
    console.log(`[WS] Sent usage stats sync to mobile`);
  }

  // Send Claude session event (sensitive — may contain error messages with paths)
  sendClaudeSessionEvent(data: {
    sessionKey: string;
    event: { type: string; [key: string]: any };
  }): void {
    this.emitSensitive('claude_session_event', data, this.e2eePeerDeviceId ?? undefined);
  }

  get isConnected(): boolean {
    return this.server?.hasMobileConnection() ?? false;
  }
}

export const wsClient = new WebSocketClient();
export default wsClient;
