import * as fs from 'fs';
import * as readline from 'readline';
import { EventEmitter } from 'events';
import * as chokidar from 'chokidar';

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

class TranscriptStreamer extends EventEmitter {
  private watchers: Map<string, chokidar.FSWatcher> = new Map();
  private fileSizes: Map<string, number> = new Map();
  private lastLineNumbers: Map<string, number> = new Map();
  private processingLock: Map<string, boolean> = new Map(); // Prevent concurrent reads

  /**
   * Fetch transcript history from a JSONL file
   * Supports reverse pagination: offset 0 = most recent entries
   */
  async fetchHistory(
    transcriptPath: string,
    offset = 0,
    limit = 100,
    reverse = true // Default to reverse (most recent first for initial load)
  ): Promise<TranscriptFetchResult> {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(transcriptPath)) {
        return resolve({ entries: [], totalEntries: 0, hasMore: false });
      }

      const allEntries: TranscriptEntry[] = [];
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
        let resultEntries: TranscriptEntry[];
        let hasMore: boolean;

        if (reverse) {
          // Reverse pagination: offset 0 = last N entries
          // offset 400 = entries before the last 400
          const startIndex = Math.max(0, totalEntries - offset - limit);
          const endIndex = Math.max(0, totalEntries - offset);
          resultEntries = allEntries.slice(startIndex, endIndex);
          hasMore = startIndex > 0;
        } else {
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
  subscribeToUpdates(sessionKey: string, transcriptPath: string): void {
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
      interval: 300,  // Poll every 300ms for faster updates
      binaryInterval: 300,
    });

    watcher.on('change', async () => {
      try {
        // Prevent concurrent processing for the same session
        if (this.processingLock.get(sessionKey)) {
          console.log(`[Transcript] Skipping change event - already processing: ${sessionKey}`);
          return;
        }

        const newStats = fs.statSync(transcriptPath);
        console.log(`[Transcript] File changed: ${sessionKey}, size: ${newStats.size}`);
        const oldSize = this.fileSizes.get(sessionKey) || 0;

        // Only process if file grew
        if (newStats.size > oldSize) {
          // Acquire lock
          this.processingLock.set(sessionKey, true);
          this.fileSizes.set(sessionKey, newStats.size);

          try {
            // Read new lines from the file
            const newEntries = await this.readNewLines(transcriptPath, sessionKey);

            for (const entry of newEntries) {
              this.emit('update', {
                sessionKey,
                entry,
              });
            }
          } finally {
            // Release lock
            this.processingLock.set(sessionKey, false);
          }
        }
      } catch (error) {
        // File might be temporarily unavailable
        this.processingLock.set(sessionKey, false);
      }
    });

    this.watchers.set(sessionKey, watcher);
  }

  /**
   * Unsubscribe from transcript updates
   */
  unsubscribeFromUpdates(sessionKey: string): void {
    const watcher = this.watchers.get(sessionKey);
    if (watcher) {
      watcher.close();
      this.watchers.delete(sessionKey);
      this.fileSizes.delete(sessionKey);
      this.processingLock.delete(sessionKey);
    }
  }

  /**
   * Read new lines that were added to the file since last read
   */
  private async readNewLines(
    transcriptPath: string,
    sessionKey: string
  ): Promise<TranscriptEntry[]> {
    return new Promise((resolve) => {
      const lastLineNumber = this.lastLineNumbers.get(transcriptPath) || 0;
      const entries: TranscriptEntry[] = [];
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
          } else {
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
  private parseEntry(line: string, lineNumber: number): TranscriptEntry | null {
    if (!line.trim()) {
      return null;
    }

    try {
      const jsonLine = JSON.parse(line);
      return this.transformMessage(jsonLine, lineNumber);
    } catch {
      return null;
    }
  }

  /**
   * Transform Claude JSONL message format to our TranscriptEntry format
   * Shows all content visible in the Claude terminal
   */
  private transformMessage(jsonLine: any, lineNumber: number): TranscriptEntry | null {
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
      if (!text) return null;

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
        let filePath: string | undefined;
        let diff: DiffHunk[] | undefined;

        // Extract file path
        if (result.filePath) {
          filePath = result.filePath;
        }

        // Extract diff if present (for Edit tool results)
        if (result.structuredPatch && Array.isArray(result.structuredPatch)) {
          diff = result.structuredPatch.map((hunk: any) => ({
            oldStart: hunk.oldStart,
            oldLines: hunk.oldLines,
            newStart: hunk.newStart,
            newLines: hunk.newLines,
            lines: hunk.lines || [],
          }));
          // For diff results, show file path as main text
          resultText = filePath ? `Updated: ${filePath.split(/[/\\]/).pop()}` : 'File updated';
        } else {
          // Non-diff results
          if (result.stdout) resultText += result.stdout;
          if (result.stderr) resultText += (resultText ? '\n' : '') + result.stderr;
          if (filePath && !resultText) resultText = `File: ${filePath}`;
          if (result.content) resultText = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);

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
      } else if (Array.isArray(messageContent)) {
        // Extract text from content blocks
        for (const block of messageContent) {
          if (block.type === 'text') {
            text += (text ? '\n' : '') + block.text;
          } else if (block.type === 'tool_result') {
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
      let toolName: string | undefined;
      let toolInput: any;

      if (Array.isArray(messageContent)) {
        for (const block of messageContent) {
          if (block.type === 'text') {
            text += (text ? '\n' : '') + block.text;
          } else if (block.type === 'tool_use') {
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
        } else if (Array.isArray(jsonLine.content)) {
          text = jsonLine.content
            .filter((block: any) => block.type === 'text')
            .map((block: any) => block.text)
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
  cleanup(): void {
    for (const [sessionKey] of this.watchers) {
      this.unsubscribeFromUpdates(sessionKey);
    }
    this.fileSizes.clear();
    this.lastLineNumbers.clear();
    this.processingLock.clear();
  }
}

export const transcriptStreamer = new TranscriptStreamer();
