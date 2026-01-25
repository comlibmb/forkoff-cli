import { EventEmitter } from 'events';
export interface ChatMessage {
    id: string;
    sessionId: string;
    content: string;
    role: 'user' | 'assistant' | 'system';
    timestamp: Date;
    streaming?: boolean;
}
export interface ChatSession {
    id: string;
    projectId?: string;
    messages: ChatMessage[];
    isActive: boolean;
    startedAt: Date;
}
declare class ChatSessionManager extends EventEmitter {
    private sessions;
    private messageCounter;
    /**
     * Create or get a chat session
     */
    getOrCreateSession(sessionId: string, projectId?: string): ChatSession;
    /**
     * Handle incoming message from mobile app
     */
    handleIncomingMessage(sessionId: string, content: string, requestedBy: string): ChatMessage;
    /**
     * Send a complete message to mobile app
     */
    sendMessage(sessionId: string, content: string, role?: 'assistant' | 'system'): ChatMessage;
    /**
     * Start streaming a message to mobile app
     */
    startStreamingMessage(sessionId: string, role?: 'assistant' | 'system'): {
        messageId: string;
        stream: StreamWriter;
    };
    /**
     * End a chat session
     */
    endSession(sessionId: string): void;
    /**
     * Get active sessions
     */
    getActiveSessions(): ChatSession[];
    /**
     * Get session by ID
     */
    getSession(sessionId: string): ChatSession | undefined;
    /**
     * Get session messages
     */
    getMessages(sessionId: string): ChatMessage[];
    /**
     * Clear all sessions
     */
    clear(): void;
}
export interface StreamWriter {
    messageId: string;
    write: (chunk: string) => void;
    end: () => void;
}
export declare const chatSessionManager: ChatSessionManager;
export default chatSessionManager;
//# sourceMappingURL=chat.d.ts.map