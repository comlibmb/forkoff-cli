import { io, Socket } from 'socket.io-client';
import { config } from './config';
import { EventEmitter } from 'events';

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
}

interface ClaudeStartRequest {
  directory: string;
  terminalSessionId: string;
  requestedBy: string;
}

interface DirectoryListRequest {
  path: string;
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

class WebSocketClient extends EventEmitter {
  private socket: Socket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private heartbeatInterval: NodeJS.Timeout | null = null;

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

      this.socket = io(config.wsUrl, {
        auth: {
          deviceId,
        },
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: this.maxReconnectAttempts,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
      });

      this.socket.on('connect', () => {
        this.reconnectAttempts = 0;
        console.log(`[WS] Connected with deviceId: ${deviceId}`);
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

      // Listen for claude sessions request (mobile wants current state)
      this.socket.on('claude_sessions_request', (data: { requestedBy: string }) => {
        console.log(`[WS] Received claude_sessions_request`);
        this.emit('claude_sessions_request', data);
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

  // Send multiple Claude sessions (batch update)
  sendClaudeSessions(sessions: ClaudeSessionUpdate[]): void {
    for (const session of sessions) {
      this.sendClaudeSessionUpdate(session);
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

  get isConnected(): boolean {
    return this.socket?.connected ?? false;
  }
}

export const wsClient = new WebSocketClient();
export default wsClient;
