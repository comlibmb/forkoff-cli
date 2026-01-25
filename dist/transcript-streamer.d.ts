import { EventEmitter } from 'events';
export interface DiffHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
}
export interface TranscriptEntry {
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
        filePath?: string;
        diff?: DiffHunk[];
    };
}
interface TranscriptFetchResult {
    entries: TranscriptEntry[];
    totalEntries: number;
    hasMore: boolean;
}
declare class TranscriptStreamer extends EventEmitter {
    private watchers;
    private fileSizes;
    private lastLineNumbers;
    /**
     * Fetch transcript history from a JSONL file
     * Supports reverse pagination: offset 0 = most recent entries
     */
    fetchHistory(transcriptPath: string, offset?: number, limit?: number, reverse?: boolean): Promise<TranscriptFetchResult>;
    /**
     * Subscribe to live updates from a transcript file
     */
    subscribeToUpdates(sessionKey: string, transcriptPath: string): void;
    /**
     * Unsubscribe from transcript updates
     */
    unsubscribeFromUpdates(sessionKey: string): void;
    /**
     * Read new lines that were added to the file since last read
     */
    private readNewLines;
    /**
     * Parse a JSONL line into a TranscriptEntry
     */
    private parseEntry;
    /**
     * Transform Claude JSONL message format to our TranscriptEntry format
     * Shows all content visible in the Claude terminal
     */
    private transformMessage;
    /**
     * Clean up all watchers
     */
    cleanup(): void;
}
export declare const transcriptStreamer: TranscriptStreamer;
export {};
//# sourceMappingURL=transcript-streamer.d.ts.map