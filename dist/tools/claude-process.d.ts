/**
 * Claude Process Manager
 * Spawns and manages Claude CLI processes for terminal sessions
 */
import { EventEmitter } from 'events';
declare class ClaudeProcessManager extends EventEmitter {
    private processes;
    /**
     * Start a new Claude session in the specified directory
     */
    startSession(directory: string, terminalSessionId: string): Promise<{
        cwd: string;
    }>;
    /**
     * Resume an existing Claude session
     */
    resumeSession(sessionKey: string, directory: string, terminalSessionId: string): Promise<{
        cwd: string;
    }>;
    /**
     * Send input to a Claude process
     */
    sendInput(terminalSessionId: string, input: string): void;
    /**
     * Check if a session is a Claude session
     */
    isClaudeSession(terminalSessionId: string): boolean;
    /**
     * Set up event handlers for the spawned process
     */
    private setupProcessHandlers;
    /**
     * Resolve path (handle ~ for home directory)
     */
    private resolvePath;
    /**
     * Kill a Claude process
     */
    killProcess(terminalSessionId: string): void;
    /**
     * Get all active process IDs
     */
    getActiveProcessIds(): string[];
}
export declare const claudeProcessManager: ClaudeProcessManager;
export default claudeProcessManager;
//# sourceMappingURL=claude-process.d.ts.map