import { EventEmitter } from 'events';
type DeviceStatus = 'online' | 'offline' | 'busy' | 'syncing';
interface ClaudeSessionUpdate {
    sessionKey: string;
    directory: string;
    state: 'active' | 'inactive';
    lastUsedAt: string;
    transcriptPath?: string;
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
declare class WebSocketClient extends EventEmitter {
    private socket;
    private reconnectAttempts;
    private maxReconnectAttempts;
    private heartbeatInterval;
    connect(): Promise<void>;
    disconnect(): void;
    private startHeartbeat;
    private stopHeartbeat;
    sendHeartbeat(status?: DeviceStatus): void;
    updateStatus(status: DeviceStatus): void;
    setSyncing(syncing: boolean): void;
    sendClaudeSessionUpdate(session: ClaudeSessionUpdate): void;
    sendClaudeSessions(sessions: ClaudeSessionUpdate[]): void;
    sendToolStatusUpdate(toolType: string, status: 'active' | 'inactive' | 'error'): void;
    sendApprovalRequest(data: {
        sessionId: string;
        messageId: string;
        type: 'CODE_CHANGE' | 'FILE_OPERATION' | 'COMMAND_EXECUTION' | 'OTHER';
        description: string;
        changes: any;
    }): void;
    sendTerminalOutput(data: {
        terminalSessionId: string;
        output: string;
        type: 'stdout' | 'stderr' | 'exit';
        exitCode?: number;
    }): void;
    sendTerminalCwd(data: {
        terminalSessionId: string;
        cwd: string;
    }): void;
    sendDirectoryListResponse(data: {
        requestId: string;
        entries: Array<{
            name: string;
            type: 'file' | 'directory';
            path: string;
        }>;
        currentPath: string;
    }): void;
    sendFileChanged(data: {
        projectId: string;
        filePath: string;
        changeType: 'created' | 'modified' | 'deleted';
    }): void;
    sendTranscriptHistory(data: {
        sessionKey: string;
        entries: TranscriptEntry[];
        totalEntries: number;
        offset: number;
        hasMore: boolean;
    }): void;
    sendTranscriptUpdate(data: {
        sessionKey: string;
        entry: TranscriptEntry;
    }): void;
    get isConnected(): boolean;
}
export declare const wsClient: WebSocketClient;
export default wsClient;
//# sourceMappingURL=websocket.d.ts.map