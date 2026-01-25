"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chatSessionManager = void 0;
const events_1 = require("events");
const websocket_1 = require("./websocket");
class ChatSessionManager extends events_1.EventEmitter {
    constructor() {
        super(...arguments);
        this.sessions = new Map();
        this.messageCounter = 0;
    }
    /**
     * Create or get a chat session
     */
    getOrCreateSession(sessionId, projectId) {
        let session = this.sessions.get(sessionId);
        if (!session) {
            session = {
                id: sessionId,
                projectId,
                messages: [],
                isActive: true,
                startedAt: new Date(),
            };
            this.sessions.set(sessionId, session);
            this.emit('session_created', session);
        }
        return session;
    }
    /**
     * Handle incoming message from mobile app
     */
    handleIncomingMessage(sessionId, content, requestedBy) {
        const session = this.getOrCreateSession(sessionId);
        const messageId = `msg_${++this.messageCounter}_${Date.now()}`;
        const message = {
            id: messageId,
            sessionId,
            content,
            role: 'user',
            timestamp: new Date(),
        };
        session.messages.push(message);
        this.emit('message_received', message, requestedBy);
        return message;
    }
    /**
     * Send a complete message to mobile app
     */
    sendMessage(sessionId, content, role = 'assistant') {
        const session = this.getOrCreateSession(sessionId);
        const messageId = `msg_${++this.messageCounter}_${Date.now()}`;
        const message = {
            id: messageId,
            sessionId,
            content,
            role,
            timestamp: new Date(),
        };
        session.messages.push(message);
        // Send to mobile app
        websocket_1.wsClient.sendChatMessage({
            sessionId,
            content,
            role,
            messageId,
            streaming: false,
        });
        this.emit('message_sent', message);
        return message;
    }
    /**
     * Start streaming a message to mobile app
     */
    startStreamingMessage(sessionId, role = 'assistant') {
        const session = this.getOrCreateSession(sessionId);
        const messageId = `msg_${++this.messageCounter}_${Date.now()}`;
        const message = {
            id: messageId,
            sessionId,
            content: '',
            role,
            timestamp: new Date(),
            streaming: true,
        };
        session.messages.push(message);
        const streamWriter = {
            messageId,
            write: (chunk) => {
                message.content += chunk;
                websocket_1.wsClient.sendChatStream({
                    sessionId,
                    messageId,
                    chunk,
                    done: false,
                });
            },
            end: () => {
                message.streaming = false;
                websocket_1.wsClient.sendChatStream({
                    sessionId,
                    messageId,
                    chunk: '',
                    done: true,
                });
                this.emit('stream_ended', message);
            },
        };
        this.emit('stream_started', message);
        return { messageId, stream: streamWriter };
    }
    /**
     * End a chat session
     */
    endSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.isActive = false;
            this.emit('session_ended', session);
        }
    }
    /**
     * Get active sessions
     */
    getActiveSessions() {
        return Array.from(this.sessions.values()).filter((s) => s.isActive);
    }
    /**
     * Get session by ID
     */
    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }
    /**
     * Get session messages
     */
    getMessages(sessionId) {
        return this.sessions.get(sessionId)?.messages || [];
    }
    /**
     * Clear all sessions
     */
    clear() {
        this.sessions.clear();
        this.messageCounter = 0;
    }
}
exports.chatSessionManager = new ChatSessionManager();
exports.default = exports.chatSessionManager;
//# sourceMappingURL=chat.js.map