"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wsClient = void 0;
const socket_io_client_1 = require("socket.io-client");
const config_1 = require("./config");
const events_1 = require("events");
class WebSocketClient extends events_1.EventEmitter {
    constructor() {
        super(...arguments);
        this.socket = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.heartbeatInterval = null;
    }
    connect() {
        return new Promise((resolve, reject) => {
            if (this.socket?.connected) {
                resolve();
                return;
            }
            const deviceId = config_1.config.deviceId;
            if (!deviceId) {
                reject(new Error('Device not registered'));
                return;
            }
            this.socket = (0, socket_io_client_1.io)(config_1.config.wsUrl, {
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
            this.socket.on('terminal_create', (data) => {
                console.log(`[WS] Received terminal_create:`, JSON.stringify(data));
                this.emit('terminal_create', data);
            });
            // Listen for terminal commands from mobile app
            this.socket.on('terminal_command', (data) => {
                console.log(`[WS] Received terminal_command:`, JSON.stringify(data));
                this.emit('terminal_command', data);
            });
            // Listen for approval responses
            this.socket.on('approval_response', (data) => {
                this.emit('approval_response', data);
            });
            // Listen for git clone requests
            this.socket.on('git_clone', (data) => {
                this.emit('git_clone', data);
            });
            // Listen for Claude session requests from mobile app
            this.socket.on('claude_resume_session', (data) => {
                console.log(`[WS] Received claude_resume_session:`, JSON.stringify(data));
                this.emit('claude_resume_session', data);
            });
            this.socket.on('claude_start_session', (data) => {
                console.log(`[WS] Received claude_start_session:`, JSON.stringify(data));
                this.emit('claude_start_session', data);
            });
            this.socket.on('directory_list', (data) => {
                console.log(`[WS] Received directory_list:`, JSON.stringify(data));
                this.emit('directory_list', data);
            });
            // Listen for transcript fetch requests from mobile app
            this.socket.on('transcript_fetch', (data) => {
                console.log(`[WS] Received transcript_fetch:`, JSON.stringify(data));
                this.emit('transcript_fetch', data);
            });
            // Listen for transcript subscribe requests
            this.socket.on('transcript_subscribe', (data) => {
                console.log(`[WS] Received transcript_subscribe:`, JSON.stringify(data));
                this.emit('transcript_subscribe', data);
            });
            // Listen for transcript unsubscribe requests
            this.socket.on('transcript_unsubscribe', (data) => {
                console.log(`[WS] Received transcript_unsubscribe:`, JSON.stringify(data));
                this.emit('transcript_unsubscribe', data);
            });
            // Listen for claude sessions request (mobile wants current state)
            this.socket.on('claude_sessions_request', (data) => {
                console.log(`[WS] Received claude_sessions_request`);
                this.emit('claude_sessions_request', data);
            });
        });
    }
    disconnect() {
        this.stopHeartbeat();
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
    }
    startHeartbeat() {
        this.heartbeatInterval = setInterval(() => {
            this.sendHeartbeat();
        }, 30000); // Every 30 seconds
    }
    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }
    // Send heartbeat to keep connection alive
    sendHeartbeat(status = 'online') {
        this.socket?.emit('device_heartbeat', { status });
    }
    // Update device status
    updateStatus(status) {
        this.socket?.emit('device_heartbeat', { status });
    }
    // Send syncing status
    setSyncing(syncing) {
        this.socket?.emit('device_syncing', { syncing });
    }
    // Send Claude session update
    sendClaudeSessionUpdate(session) {
        this.socket?.emit('claude_session_update', session);
    }
    // Send multiple Claude sessions (batch update)
    sendClaudeSessions(sessions) {
        for (const session of sessions) {
            this.sendClaudeSessionUpdate(session);
        }
    }
    // Send tool status update (e.g., Claude active/inactive)
    sendToolStatusUpdate(toolType, status) {
        this.socket?.emit('tool_status_update', {
            toolType,
            status,
            timestamp: new Date().toISOString(),
        });
    }
    // Send approval request
    sendApprovalRequest(data) {
        this.socket?.emit('approval_request', data);
    }
    // Send terminal output
    sendTerminalOutput(data) {
        this.socket?.emit('terminal_output', data);
    }
    // Send working directory change
    sendTerminalCwd(data) {
        this.socket?.emit('terminal_cwd', data);
    }
    // Send directory listing response
    sendDirectoryListResponse(data) {
        this.socket?.emit('directory_list_response', data);
    }
    // Send file change notification
    sendFileChanged(data) {
        this.socket?.emit('file_changed', data);
    }
    // Send transcript history to mobile app
    sendTranscriptHistory(data) {
        this.socket?.emit('transcript_history', data);
    }
    // Send transcript update (new entry) to mobile app
    sendTranscriptUpdate(data) {
        this.socket?.emit('transcript_update', data);
    }
    get isConnected() {
        return this.socket?.connected ?? false;
    }
}
exports.wsClient = new WebSocketClient();
exports.default = exports.wsClient;
//# sourceMappingURL=websocket.js.map