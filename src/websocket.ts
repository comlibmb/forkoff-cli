import { io, Socket } from 'socket.io-client';
import { config } from './config';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

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
}

// Claude approval response from mobile
interface ClaudeApprovalResponse {
  approvalId: string;
  response: string;        // The response character ('y', 'n', 'p', etc.)
  respondedBy: string;
}

class WebSocketClient extends EventEmitter {
  private socket: Socket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private _sessionId: string = '';

  // Unique session ID for this CLI connection
  get sessionId(): string {
    if (!this._sessionId) {
      this._sessionId = uuidv4();
    }
    return this._sessionId;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket?.connected) {
        resolve();
        return;
      }

      const deviceId = config.deviceId;
      if (!deviceId) {
        reject(new Error('Device not registered'));
        return;
      }

      // Generate unique session ID for this CLI connection
      const sessionId = this.sessionId;
      const userId = config.userId; // Pass userId from config for user-based routing

      this.socket = io(config.wsUrl, {
        auth: {
          deviceId,
          userId, // Include userId so API can track by user even if device not in DB
          clientType: 'session-scoped',
          sessionId,
        },
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: this.maxReconnectAttempts,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
      });

      this.socket.on('connect', () => {
        this.reconnectAttempts = 0;
        console.log(`[WS] Connected with deviceId: ${deviceId}, sessionId: ${sessionId}`);
        this.emit('connected');
        this.startHeartbeat();
        resolve();
      });

      this.socket.on('disconnect', (reason) => {
        this.emit('disconnected', reason);
        this.stopHeartbeat();
      });

      this.socket.on('connect_error', (error) => {
        this.reconnectAttempts++;
        this.emit('error', error);

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          reject(new Error('Failed to connect after maximum attempts'));
        }
      });

      // Listen for terminal create requests from mobile app
      this.socket.on('terminal_create', (data: TerminalCreate) => {
        console.log(`[WS] Received terminal_create:`, JSON.stringify(data));
        this.emit('terminal_create', data);
      });

      // Listen for terminal commands from mobile app
      this.socket.on('terminal_command', (data: TerminalCommand) => {
        console.log(`[WS] Received terminal_command:`, JSON.stringify(data));
        this.emit('terminal_command', data);
      });

      // Listen for approval responses
      this.socket.on('approval_response', (data: ApprovalResponse) => {
        this.emit('approval_response', data);
      });

      // Listen for git clone requests
      this.socket.on('git_clone', (data: any) => {
        this.emit('git_clone', data);
      });

      // Listen for user messages from mobile app
      this.socket.on('user_message', (data: UserMessageRequest) => {
        console.log(`[WS] Received user_message: ${data.message.substring(0, 50)}...`);
        this.emit('user_message', data);
      });

      // Listen for Claude session requests from mobile app
      this.socket.on('claude_resume_session', (data: ClaudeResumeRequest) => {
        console.log(`[WS] Received claude_resume_session:`, JSON.stringify(data));
        this.emit('claude_resume_session', data);
      });

      this.socket.on('claude_start_session', (data: ClaudeStartRequest) => {
        console.log(`[WS] Received claude_start_session:`, JSON.stringify(data));
        this.emit('claude_start_session', data);
      });

      this.socket.on('directory_list', (data: DirectoryListRequest) => {
        console.log(`[WS] Received directory_list:`, JSON.stringify(data));
        this.emit('directory_list', data);
      });

      // Listen for transcript fetch requests from mobile app
      this.socket.on('transcript_fetch', (data: TranscriptFetchRequest) => {
        console.log(`[WS] Received transcript_fetch:`, JSON.stringify(data));
        this.emit('transcript_fetch', data);
      });

      // Listen for transcript subscribe requests
      this.socket.on('transcript_subscribe', (data: TranscriptSubscribeRequest) => {
        console.log(`[WS] Received transcript_subscribe:`, JSON.stringify(data));
        this.emit('transcript_subscribe', data);
      });

      // Listen for transcript unsubscribe requests
      this.socket.on('transcript_unsubscribe', (data: { sessionKey: string }) => {
        console.log(`[WS] Received transcript_unsubscribe:`, JSON.stringify(data));
        this.emit('transcript_unsubscribe', data);
      });

      // Listen for SDK subscribe start requests from API
      // This is sent when mobile uses transcript_subscribe_sdk
      this.socket.on('transcript_subscribe_sdk_start', (data: { sessionKey: string; requestedBy: string }) => {
        console.log(`[WS] Received transcript_subscribe_sdk_start:`, JSON.stringify(data));
        this.emit('transcript_subscribe_sdk_start', data);
      });

      // Listen for claude sessions request (mobile wants current state)
      this.socket.on('claude_sessions_request', (data: { requestedBy: string }) => {
        console.log(`[WS] Received claude_sessions_request`);
        this.emit('claude_sessions_request', data);
      });

      // Listen for RPC requests from the API gateway
      this.socket.on('rpc_request', (data: { requestId: string; method: string; params: any }) => {
        console.log(`[WS] Received rpc_request: ${data.method}, requestId: ${data.requestId}`);
        this.emit('rpc_request', data);
      });

      // Listen for read file requests from mobile app
      this.socket.on('read_file', (data: ReadFileRequest) => {
        console.log(`[WS] Received read_file: ${data.filePath}`);
        this.emit('read_file', data);
      });

      // Listen for Claude approval responses from mobile
      this.socket.on('claude_approval_response', (data: ClaudeApprovalResponse) => {
        console.log(`[WS] Received claude_approval_response: ${data.approvalId}, response: ${data.response}`);
        this.emit('claude_approval_response', data);
      });
    });
  }

  disconnect(): void {
    this.stopHeartbeat();
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
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

  // Send heartbeat to keep connection alive
  sendHeartbeat(status: DeviceStatus = 'online'): void {
    this.socket?.emit('device_heartbeat', { status });
  }

  // Update device status
  updateStatus(status: DeviceStatus): void {
    this.socket?.emit('device_heartbeat', { status });
  }

  // Send syncing status
  setSyncing(syncing: boolean): void {
    this.socket?.emit('device_syncing', { syncing });
  }

  // Send Claude session update
  sendClaudeSessionUpdate(session: ClaudeSessionUpdate): void {
    this.socket?.emit('claude_session_update', session);
  }

  // Send multiple Claude sessions as a single batch event
  sendClaudeSessions(sessions: ClaudeSessionUpdate[]): void {
    if (sessions.length > 0) {
      this.socket?.emit('claude_session_batch_update', { sessions });
    }
  }

  // Send tool status update (e.g., Claude active/inactive)
  sendToolStatusUpdate(toolType: string, status: 'active' | 'inactive' | 'error'): void {
    this.socket?.emit('tool_status_update', {
      toolType,
      status,
      timestamp: new Date().toISOString(),
    });
  }

  // Send approval request
  sendApprovalRequest(data: {
    sessionId: string;
    messageId: string;
    type: 'CODE_CHANGE' | 'FILE_OPERATION' | 'COMMAND_EXECUTION' | 'OTHER';
    description: string;
    changes: any;
  }): void {
    this.socket?.emit('approval_request', data);
  }

  // Send terminal output
  sendTerminalOutput(data: {
    terminalSessionId: string;
    output: string;
    type: 'stdout' | 'stderr' | 'exit';
    exitCode?: number;
  }): void {
    this.socket?.emit('terminal_output', data);
  }

  // Send working directory change
  sendTerminalCwd(data: { terminalSessionId: string; cwd: string }): void {
    this.socket?.emit('terminal_cwd', data);
  }

  // Send directory listing response
  sendDirectoryListResponse(data: {
    requestId: string;
    entries: Array<{ name: string; type: 'file' | 'directory'; path: string }>;
    currentPath: string;
  }): void {
    this.socket?.emit('directory_list_response', data);
  }

  // Send read file response
  sendReadFileResponse(data: {
    requestId: string;
    content?: string;
    exists: boolean;
    fileName: string;
    error?: string;
  }): void {
    this.socket?.emit('read_file_response', data);
  }

  // Send file change notification
  sendFileChanged(data: {
    projectId: string;
    filePath: string;
    changeType: 'created' | 'modified' | 'deleted';
  }): void {
    this.socket?.emit('file_changed', data);
  }

  // Send transcript history to mobile app
  sendTranscriptHistory(data: {
    sessionKey: string;
    entries: TranscriptEntry[];
    totalEntries: number;
    offset: number;
    hasMore: boolean;
  }): void {
    this.socket?.emit('transcript_history', data);
  }

  // Send transcript update (new entry) to mobile app
  sendTranscriptUpdate(data: {
    sessionKey: string;
    entry: TranscriptEntry;
  }): void {
    this.socket?.emit('transcript_update', data);
  }

  // Send RPC response back to API gateway
  sendRpcResponse(data: {
    requestId: string;
    result?: any;
    error?: { code: number; message: string };
  }): void {
    console.log(`[WS] Sending rpc_response: ${data.requestId}, hasResult: ${!!data.result}, hasError: ${!!data.error}`);
    this.socket?.emit('rpc_response', data);
  }

  // Send Claude approval request to mobile
  sendClaudeApprovalRequest(data: ClaudeApprovalRequest): void {
    console.log(`[WS] Sending claude_approval_request: ${data.approvalId}`);
    this.socket?.emit('claude_approval_request', data);
  }

  // Send thinking content to mobile
  sendThinkingContent(data: {
    sessionKey?: string;
    thinkingId: string;
    content: string;
    partial: boolean;
  }): void {
    this.socket?.emit('thinking_content', data);
  }

  // Send token usage to mobile
  sendTokenUsage(data: {
    sessionKey?: string;
    usage: {
      inputTokens: number;
      outputTokens: number;
    };
  }): void {
    this.socket?.emit('token_usage', data);
  }

  // Send task progress to mobile
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
    this.socket?.emit('task_progress', data);
  }

  get isConnected(): boolean {
    return this.socket?.connected ?? false;
  }
}

export const wsClient = new WebSocketClient();
export default wsClient;
