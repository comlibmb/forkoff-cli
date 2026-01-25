"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.transcriptStreamer = void 0;
const fs = __importStar(require("fs"));
const readline = __importStar(require("readline"));
const events_1 = require("events");
const chokidar = __importStar(require("chokidar"));
class TranscriptStreamer extends events_1.EventEmitter {
    constructor() {
        super(...arguments);
        this.watchers = new Map();
        this.fileSizes = new Map();
        this.lastLineNumbers = new Map();
    }
    /**
     * Fetch transcript history from a JSONL file
     * Supports reverse pagination: offset 0 = most recent entries
     */
    async fetchHistory(transcriptPath, offset = 0, limit = 100, reverse = true // Default to reverse (most recent first for initial load)
    ) {
        return new Promise((resolve, reject) => {
            if (!fs.existsSync(transcriptPath)) {
                return resolve({ entries: [], totalEntries: 0, hasMore: false });
            }
            const allEntries = [];
            let lineNumber = 0;
            const fileStream = fs.createReadStream(transcriptPath, { encoding: 'utf8' });
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity,
            });
            rl.on('line', (line) => {
                lineNumber++;
                const entry = this.parseEntry(line, lineNumber);
                if (entry) {
                    allEntries.push(entry);
                }
            });
            rl.on('close', () => {
                this.lastLineNumbers.set(transcriptPath, lineNumber);
                const totalEntries = allEntries.length;
                let resultEntries;
                let hasMore;
                if (reverse) {
                    // Reverse pagination: offset 0 = last N entries
                    // offset 400 = entries before the last 400
                    const startIndex = Math.max(0, totalEntries - offset - limit);
                    const endIndex = Math.max(0, totalEntries - offset);
                    resultEntries = allEntries.slice(startIndex, endIndex);
                    hasMore = startIndex > 0;
                }
                else {
                    // Forward pagination: offset 0 = first N entries
                    const startIndex = offset;
                    const endIndex = Math.min(totalEntries, offset + limit);
                    resultEntries = allEntries.slice(startIndex, endIndex);
                    hasMore = endIndex < totalEntries;
                }
                resolve({
                    entries: resultEntries,
                    totalEntries,
                    hasMore,
                });
            });
            rl.on('error', (error) => {
                reject(error);
            });
        });
    }
    /**
     * Subscribe to live updates from a transcript file
     */
    subscribeToUpdates(sessionKey, transcriptPath) {
        // Unsubscribe if already subscribed
        this.unsubscribeFromUpdates(sessionKey);
        console.log(`[Transcript] subscribeToUpdates: sessionKey=${sessionKey}, path=${transcriptPath}`);
        if (!fs.existsSync(transcriptPath)) {
            console.log(`[Transcript] File does not exist: ${transcriptPath}`);
            return;
        }
        // Get initial file size
        const stats = fs.statSync(transcriptPath);
        this.fileSizes.set(sessionKey, stats.size);
        console.log(`[Transcript] Initial file size: ${stats.size}`);
        // Initialize last line number if not set
        const existingLineNumber = this.lastLineNumbers.get(transcriptPath);
        console.log(`[Transcript] Existing lastLineNumber for path: ${existingLineNumber}`);
        if (!this.lastLineNumbers.has(transcriptPath)) {
            this.lastLineNumbers.set(transcriptPath, 0);
            console.log(`[Transcript] Initialized lastLineNumber to 0`);
        }
        // Watch the file for changes - faster polling for real-time updates
        const watcher = chokidar.watch(transcriptPath, {
            persistent: true,
            usePolling: true,
            interval: 300, // Poll every 300ms for faster updates
            binaryInterval: 300,
        });
        watcher.on('change', async () => {
            try {
                const newStats = fs.statSync(transcriptPath);
                console.log(`[Transcript] File changed: ${sessionKey}, size: ${newStats.size}`);
                const oldSize = this.fileSizes.get(sessionKey) || 0;
                // Only process if file grew
                if (newStats.size > oldSize) {
                    this.fileSizes.set(sessionKey, newStats.size);
                    // Read new lines from the file
                    const newEntries = await this.readNewLines(transcriptPath, sessionKey);
                    for (const entry of newEntries) {
                        this.emit('update', {
                            sessionKey,
                            entry,
                        });
                    }
                }
            }
            catch (error) {
                // File might be temporarily unavailable
            }
        });
        this.watchers.set(sessionKey, watcher);
    }
    /**
     * Unsubscribe from transcript updates
     */
    unsubscribeFromUpdates(sessionKey) {
        const watcher = this.watchers.get(sessionKey);
        if (watcher) {
            watcher.close();
            this.watchers.delete(sessionKey);
            this.fileSizes.delete(sessionKey);
        }
    }
    /**
     * Read new lines that were added to the file since last read
     */
    async readNewLines(transcriptPath, sessionKey) {
        return new Promise((resolve) => {
            const lastLineNumber = this.lastLineNumbers.get(transcriptPath) || 0;
            const entries = [];
            let lineNumber = 0;
            let newLinesFound = 0;
            console.log(`[Transcript] readNewLines: lastLineNumber=${lastLineNumber}, path=${transcriptPath}`);
            const fileStream = fs.createReadStream(transcriptPath, { encoding: 'utf8' });
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity,
            });
            rl.on('line', (line) => {
                lineNumber++;
                // Only process lines after the last known line
                if (lineNumber > lastLineNumber) {
                    newLinesFound++;
                    const entry = this.parseEntry(line, lineNumber);
                    if (entry) {
                        console.log(`[Transcript] New entry found: type=${entry.type}, line=${lineNumber}`);
                        entries.push(entry);
                    }
                    else {
                        // Log first 100 chars of skipped line to understand what's being skipped
                        console.log(`[Transcript] Line ${lineNumber} skipped (no entry), preview: ${line.substring(0, 100)}`);
                    }
                }
            });
            rl.on('close', () => {
                console.log(`[Transcript] readNewLines complete: totalLines=${lineNumber}, newLines=${newLinesFound}, entries=${entries.length}`);
                this.lastLineNumbers.set(transcriptPath, lineNumber);
                resolve(entries);
            });
            rl.on('error', () => {
                resolve([]);
            });
        });
    }
    /**
     * Parse a JSONL line into a TranscriptEntry
     */
    parseEntry(line, lineNumber) {
        if (!line.trim()) {
            return null;
        }
        try {
            const jsonLine = JSON.parse(line);
            return this.transformMessage(jsonLine, lineNumber);
        }
        catch {
            return null;
        }
    }
    /**
     * Transform Claude JSONL message format to our TranscriptEntry format
     * Shows all content visible in the Claude terminal
     */
    transformMessage(jsonLine, lineNumber) {
        // Only skip internal metadata types
        const skipTypes = ['file-history-snapshot', 'init'];
        if (skipTypes.includes(jsonLine.type)) {
            return null;
        }
        // Skip compact summaries (internal resumption data)
        if (jsonLine.isCompactSummary) {
            return null;
        }
        // Handle system messages
        if (jsonLine.type === 'system') {
            const text = jsonLine.content || jsonLine.message?.content || '';
            if (!text)
                return null;
            return {
                id: jsonLine.uuid || `line-${lineNumber}`,
                parentId: jsonLine.parentUuid,
                type: 'system',
                timestamp: jsonLine.timestamp || new Date().toISOString(),
                lineNumber,
                content: {
                    text: typeof text === 'string' ? text : JSON.stringify(text),
                },
            };
        }
        // Handle user messages
        if (jsonLine.type === 'user') {
            const messageContent = jsonLine.message?.content;
            let text = '';
            // Handle tool results (show them as tool_result type)
            if (jsonLine.toolUseResult) {
                const result = jsonLine.toolUseResult;
                let resultText = '';
                let filePath;
                let diff;
                // Extract file path
                if (result.filePath) {
                    filePath = result.filePath;
                }
                // Extract diff if present (for Edit tool results)
                if (result.structuredPatch && Array.isArray(result.structuredPatch)) {
                    diff = result.structuredPatch.map((hunk) => ({
                        oldStart: hunk.oldStart,
                        oldLines: hunk.oldLines,
                        newStart: hunk.newStart,
                        newLines: hunk.newLines,
                        lines: hunk.lines || [],
                    }));
                    // For diff results, show file path as main text
                    resultText = filePath ? `Updated: ${filePath.split(/[/\\]/).pop()}` : 'File updated';
                }
                else {
                    // Non-diff results
                    if (result.stdout)
                        resultText += result.stdout;
                    if (result.stderr)
                        resultText += (resultText ? '\n' : '') + result.stderr;
                    if (filePath && !resultText)
                        resultText = `File: ${filePath}`;
                    if (result.content)
                        resultText = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
                    if (!resultText && result.type === 'text') {
                        resultText = result.text || '';
                    }
                }
                return {
                    id: jsonLine.uuid || `line-${lineNumber}`,
                    parentId: jsonLine.parentUuid,
                    type: 'tool_result',
                    timestamp: jsonLine.timestamp || new Date().toISOString(),
                    lineNumber,
                    content: {
                        text: resultText.substring(0, 2000) + (resultText.length > 2000 ? '...' : ''),
                        isError: result.is_error || result.isError || false,
                        filePath,
                        diff,
                    },
                };
            }
            if (typeof messageContent === 'string') {
                text = messageContent;
            }
            else if (Array.isArray(messageContent)) {
                // Extract text from content blocks
                for (const block of messageContent) {
                    if (block.type === 'text') {
                        text += (text ? '\n' : '') + block.text;
                    }
                    else if (block.type === 'tool_result') {
                        // Tool result in array format
                        const resultText = typeof block.content === 'string' ? block.content : '';
                        if (resultText) {
                            return {
                                id: jsonLine.uuid || `line-${lineNumber}`,
                                parentId: jsonLine.parentUuid,
                                type: 'tool_result',
                                timestamp: jsonLine.timestamp || new Date().toISOString(),
                                lineNumber,
                                content: {
                                    text: resultText.substring(0, 1000) + (resultText.length > 1000 ? '...' : ''),
                                    isError: block.is_error || false,
                                },
                            };
                        }
                    }
                }
            }
            // Skip if no actual text content for user message
            if (!text.trim()) {
                return null;
            }
            return {
                id: jsonLine.uuid || `line-${lineNumber}`,
                parentId: jsonLine.parentUuid,
                type: 'user',
                timestamp: jsonLine.timestamp || new Date().toISOString(),
                lineNumber,
                content: {
                    role: 'user',
                    text,
                },
            };
        }
        // Handle assistant messages
        if (jsonLine.type === 'assistant') {
            const messageContent = jsonLine.message?.content;
            let text = '';
            let toolName;
            let toolInput;
            if (Array.isArray(messageContent)) {
                for (const block of messageContent) {
                    if (block.type === 'text') {
                        text += (text ? '\n' : '') + block.text;
                    }
                    else if (block.type === 'tool_use') {
                        toolName = block.name;
                        toolInput = block.input;
                    }
                }
            }
            // If there's a tool use, return as tool_use type
            if (toolName) {
                return {
                    id: jsonLine.uuid || `line-${lineNumber}`,
                    parentId: jsonLine.parentUuid,
                    type: 'tool_use',
                    timestamp: jsonLine.timestamp || new Date().toISOString(),
                    lineNumber,
                    content: {
                        role: 'assistant',
                        text: text || undefined,
                        toolName,
                        toolInput,
                    },
                };
            }
            // Regular assistant text response
            if (text) {
                return {
                    id: jsonLine.uuid || `line-${lineNumber}`,
                    parentId: jsonLine.parentUuid,
                    type: 'assistant',
                    timestamp: jsonLine.timestamp || new Date().toISOString(),
                    lineNumber,
                    content: {
                        role: 'assistant',
                        text,
                    },
                };
            }
            return null;
        }
        // Handle tool results
        if (jsonLine.type === 'tool_result') {
            let text = '';
            let isError = false;
            if (jsonLine.content) {
                if (typeof jsonLine.content === 'string') {
                    text = jsonLine.content;
                }
                else if (Array.isArray(jsonLine.content)) {
                    text = jsonLine.content
                        .filter((block) => block.type === 'text')
                        .map((block) => block.text)
                        .join('\n');
                }
            }
            isError = jsonLine.is_error === true;
            return {
                id: jsonLine.uuid || `line-${lineNumber}`,
                parentId: jsonLine.parentUuid,
                type: 'tool_result',
                timestamp: jsonLine.timestamp || new Date().toISOString(),
                lineNumber,
                content: {
                    text: text.substring(0, 500) + (text.length > 500 ? '...' : ''), // Truncate long results
                    isError,
                },
            };
        }
        return null;
    }
    /**
     * Clean up all watchers
     */
    cleanup() {
        for (const [sessionKey] of this.watchers) {
            this.unsubscribeFromUpdates(sessionKey);
        }
        this.fileSizes.clear();
        this.lastLineNumbers.clear();
    }
}
exports.transcriptStreamer = new TranscriptStreamer();
//# sourceMappingURL=transcript-streamer.js.map