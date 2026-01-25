/**
 * Claude Session Detector
 *
 * Detects and monitors Claude Code sessions by:
 * 1. Scanning ~/.claude/projects/ for session directories
 * 2. Reading session transcript files to get metadata
 * 3. Detecting active Claude processes
 */
import { EventEmitter } from 'events';
export interface ClaudeSessionInfo {
    sessionKey: string;
    directory: string;
    state: 'active' | 'inactive';
    lastUsedAt: string;
    transcriptPath?: string;
}
declare class ClaudeSessionDetector extends EventEmitter {
    private claudeDir;
    private projectsDir;
    private watchInterval;
    private lastKnownSessions;
    private lastClaudeRunning;
    constructor();
    /**
     * Check if Claude Code is installed
     */
    isClaudeInstalled(): boolean;
    /**
     * Check if Claude process is currently running
     * This is a best-effort detection that may not always work
     */
    isClaudeRunning(): boolean;
    /**
     * Scan for all Claude sessions in the projects directory
     */
    scanSessions(): ClaudeSessionInfo[];
    /**
     * Parse a session JSONL file to extract metadata
     */
    private parseSessionFile;
    /**
     * Start watching for session changes
     */
    startWatching(intervalMs?: number): void;
    /**
     * Stop watching for session changes
     */
    stopWatching(): void;
    /**
     * Check for changes and emit events
     */
    private checkAndEmitChanges;
    /**
     * Get all currently known sessions
     */
    getSessions(): ClaudeSessionInfo[];
}
export declare const claudeSessionDetector: ClaudeSessionDetector;
export default claudeSessionDetector;
//# sourceMappingURL=claude-sessions.d.ts.map