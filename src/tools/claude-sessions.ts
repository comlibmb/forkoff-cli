/**
 * Claude Session Detector
 *
 * Detects and monitors Claude Code sessions by:
 * 1. Scanning ~/.claude/projects/ for session directories
 * 2. Reading session transcript files to get metadata
 * 3. Detecting active Claude processes
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { execSync, spawn } from 'child_process';

export interface ClaudeSessionInfo {
  sessionKey: string;
  directory: string;
  state: 'active' | 'inactive';
  lastUsedAt: string;
  transcriptPath?: string;
}

class ClaudeSessionDetector extends EventEmitter {
  private claudeDir: string;
  private projectsDir: string;
  private watchInterval: NodeJS.Timeout | null = null;
  private lastKnownSessions: Map<string, ClaudeSessionInfo> = new Map();
  private lastClaudeRunning: boolean = false;

  constructor() {
    super();
    this.claudeDir = path.join(os.homedir(), '.claude');
    this.projectsDir = path.join(this.claudeDir, 'projects');
  }

  /**
   * Check if Claude Code is installed
   */
  isClaudeInstalled(): boolean {
    return fs.existsSync(this.claudeDir);
  }

  /**
   * Check if Claude process is currently running
   * This is a best-effort detection that may not always work
   */
  isClaudeRunning(): boolean {
    try {
      const platform = os.platform();

      if (platform === 'win32') {
        // Windows: look for node processes with claude in command line
        // or check for recently modified session files (within last 30 seconds)
        const sessions = this.scanSessions();
        if (sessions.length > 0) {
          const now = Date.now();
          const recentSession = sessions.find(s => {
            const sessionTime = new Date(s.lastUsedAt).getTime();
            return now - sessionTime < 30000; // Active in last 30 seconds
          });
          if (recentSession) {
            return true;
          }
        }
        return false;
      } else if (platform === 'darwin') {
        // macOS: use pgrep
        try {
          execSync('pgrep -x "Claude" || pgrep -x "claude"', {
            encoding: 'utf8',
            timeout: 5000,
          });
          return true;
        } catch {
          return false;
        }
      } else {
        // Linux: use pgrep
        try {
          execSync('pgrep -x claude', {
            encoding: 'utf8',
            timeout: 5000,
          });
          return true;
        } catch {
          return false;
        }
      }
    } catch {
      return false;
    }
  }

  /**
   * Scan for all Claude sessions in the projects directory
   */
  scanSessions(): ClaudeSessionInfo[] {
    const sessions: ClaudeSessionInfo[] = [];

    if (!fs.existsSync(this.projectsDir)) {
      return sessions;
    }

    try {
      // Each project directory is named after the project path (encoded)
      const projectDirs = fs.readdirSync(this.projectsDir);

      for (const projectDir of projectDirs) {
        const projectPath = path.join(this.projectsDir, projectDir);
        const stat = fs.statSync(projectPath);

        if (!stat.isDirectory()) continue;

        // Look for JSONL session files
        const files = fs.readdirSync(projectPath);
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;

          const filePath = path.join(projectPath, file);
          const sessionInfo = this.parseSessionFile(filePath, projectDir);
          if (sessionInfo) {
            sessions.push(sessionInfo);
          }
        }
      }
    } catch (error) {
      console.error('[ClaudeSessionDetector] Error scanning sessions:', error);
    }

    // Sort by lastUsedAt descending
    sessions.sort((a, b) =>
      new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime()
    );

    return sessions;
  }

  /**
   * Parse a session JSONL file to extract metadata
   */
  private parseSessionFile(filePath: string, projectDir: string): ClaudeSessionInfo | null {
    try {
      const stat = fs.statSync(filePath);
      const fileName = path.basename(filePath, '.jsonl');

      // Try to decode the project directory name to get the actual path
      let directory = projectDir;
      try {
        // Claude encodes paths - try to decode
        // Format is usually: C--Users-User-Desktop-project or similar
        directory = projectDir
          .replace(/--/g, ':')
          .replace(/-/g, path.sep)
          .replace(/:/g, path.sep);

        // Handle Windows drive letters
        if (os.platform() === 'win32' && directory.match(/^[A-Z]\\/i)) {
          directory = directory.charAt(0) + ':' + directory.slice(1);
        }
      } catch {
        // Keep the encoded version
      }

      // Try to read the first line to get session ID
      const content = fs.readFileSync(filePath, 'utf8');
      const firstLine = content.split('\n')[0];
      let sessionId = fileName;

      try {
        const firstMessage = JSON.parse(firstLine);
        if (firstMessage.sessionId) {
          sessionId = firstMessage.sessionId;
        }
      } catch {
        // Use filename as session ID
      }

      return {
        sessionKey: sessionId,
        directory,
        state: 'inactive', // Will be updated if Claude is running
        lastUsedAt: stat.mtime.toISOString(),
        transcriptPath: filePath,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Start watching for session changes
   */
  startWatching(intervalMs: number = 5000): void {
    if (this.watchInterval) {
      return;
    }

    // Initial scan
    this.checkAndEmitChanges();

    // Watch for changes
    this.watchInterval = setInterval(() => {
      this.checkAndEmitChanges();
    }, intervalMs);
  }

  /**
   * Stop watching for session changes
   */
  stopWatching(): void {
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
    }
  }

  /**
   * Check for changes and emit events
   */
  private checkAndEmitChanges(): void {
    const currentSessions = this.scanSessions();
    const now = Date.now();

    // Determine which sessions are active based on recent file modification
    // Sessions modified within last 60 seconds are considered active
    let hasActiveSession = false;
    for (const session of currentSessions) {
      const sessionTime = new Date(session.lastUsedAt).getTime();
      const isRecent = now - sessionTime < 60000; // Active in last 60 seconds

      if (isRecent) {
        session.state = 'active';
        hasActiveSession = true;
      }
    }

    // Emit running state change if different
    if (hasActiveSession !== this.lastClaudeRunning) {
      this.lastClaudeRunning = hasActiveSession;
      this.emit('claude_running_changed', hasActiveSession);
    }

    // Check for new or changed sessions
    for (const session of currentSessions) {
      const existing = this.lastKnownSessions.get(session.sessionKey);

      if (!existing) {
        // New session detected
        this.emit('session_detected', session);
      } else if (
        existing.state !== session.state ||
        existing.lastUsedAt !== session.lastUsedAt
      ) {
        // Session changed
        this.emit('session_changed', session);
      }
    }

    // Check for removed sessions
    for (const [sessionKey, session] of this.lastKnownSessions) {
      if (!currentSessions.find(s => s.sessionKey === sessionKey)) {
        this.emit('session_removed', session);
      }
    }

    // Update cache
    this.lastKnownSessions.clear();
    for (const session of currentSessions) {
      this.lastKnownSessions.set(session.sessionKey, session);
    }
  }

  /**
   * Get all currently known sessions
   */
  getSessions(): ClaudeSessionInfo[] {
    return Array.from(this.lastKnownSessions.values());
  }
}

export const claudeSessionDetector = new ClaudeSessionDetector();
export default claudeSessionDetector;
