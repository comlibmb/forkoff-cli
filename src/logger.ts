import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let quiet = false;
let debugMode = false;
let logFilePath: string | null = null;
let logStream: fs.WriteStream | null = null;

const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info,
  debug: console.debug,
};

/**
 * Format a log line with ISO timestamp and level prefix.
 */
function formatLogLine(level: string, args: any[]): string {
  const timestamp = new Date().toISOString();
  const message = args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  // Strip ANSI color codes for clean log files
  const clean = message.replace(/\x1B\[[0-9;]*m/g, '');
  return `[${timestamp}] [${level}] ${clean}\n`;
}

/**
 * Write a line to the debug log file (if open).
 */
function writeToLogFile(level: string, args: any[]): void {
  if (!logStream) return;
  try {
    logStream.write(formatLogLine(level, args));
  } catch {
    // Swallow write errors — don't crash the CLI for logging
  }
}

export function setQuiet(value: boolean): void {
  quiet = value;
  if (value && !debugMode) {
    const noop = () => {};
    console.log = noop;
    console.error = noop;
    console.warn = noop;
    console.info = noop;
    console.debug = noop;
  } else if (value && debugMode) {
    // Quiet + debug: suppress terminal output but still write to log file
    console.log = (...args: any[]) => writeToLogFile('LOG', args);
    console.error = (...args: any[]) => writeToLogFile('ERROR', args);
    console.warn = (...args: any[]) => writeToLogFile('WARN', args);
    console.info = (...args: any[]) => writeToLogFile('INFO', args);
    console.debug = (...args: any[]) => writeToLogFile('DEBUG', args);
  } else {
    console.log = originalConsole.log;
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
    console.info = originalConsole.info;
    console.debug = originalConsole.debug;
  }
}

/**
 * Enable debug mode: tee all console output to a timestamped log file.
 * Also enables process.env.DEBUG for verbose logging throughout the codebase.
 */
export function setDebug(value: boolean): void {
  debugMode = value;

  if (!value) {
    // Disable debug mode
    if (logStream) {
      logStream.end();
      logStream = null;
    }
    logFilePath = null;
    process.env.DEBUG = '';
    return;
  }

  // Enable DEBUG env var so existing DEBUG-gated logs activate
  process.env.DEBUG = '1';

  // Create log directory
  const logDir = path.join(os.homedir(), '.forkoff-cli', 'logs');
  try {
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  } catch {
    originalConsole.error('[Debug] Failed to create log directory:', logDir);
    return;
  }

  // Create timestamped log file
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  logFilePath = path.join(logDir, `debug-${stamp}.log`);

  try {
    // SECURITY: Check for pre-existing symlink at the log path
    if (fs.existsSync(logFilePath)) {
      const stat = fs.lstatSync(logFilePath);
      if (stat.isSymbolicLink()) {
        originalConsole.error('[Debug] Symlink detected at log path, refusing to write');
        logFilePath = null;
        return;
      }
    }
    logStream = fs.createWriteStream(logFilePath, { flags: 'w', mode: 0o600 });
  } catch {
    originalConsole.error('[Debug] Failed to create log file');
    logFilePath = null;
    return;
  }

  // Write system info header
  const header = [
    `=== ForkOff CLI Debug Log ===`,
    `Date: ${now.toISOString()}`,
    `Platform: ${os.platform()} ${os.release()} (${os.arch()})`,
    `Node: ${process.version}`,
    `PID: ${process.pid}`,
    `User: ${os.userInfo().username}`,
    `Home: ${os.homedir()}`,
    `===`,
    '',
  ].join('\n');
  logStream.write(header + '\n');

  // Wrap console methods to tee to both terminal and log file
  console.log = (...args: any[]) => {
    originalConsole.log(...args);
    writeToLogFile('LOG', args);
  };
  console.error = (...args: any[]) => {
    originalConsole.error(...args);
    writeToLogFile('ERROR', args);
  };
  console.warn = (...args: any[]) => {
    originalConsole.warn(...args);
    writeToLogFile('WARN', args);
  };
  console.info = (...args: any[]) => {
    originalConsole.info(...args);
    writeToLogFile('INFO', args);
  };
  console.debug = (...args: any[]) => {
    originalConsole.debug(...args);
    writeToLogFile('DEBUG', args);
  };

  originalConsole.log(`[Debug] Logging to: ${logFilePath}`);
}

export function isQuiet(): boolean {
  return quiet;
}

export function isDebug(): boolean {
  return debugMode;
}

export function getLogFilePath(): string | null {
  return logFilePath;
}

/**
 * Flush and close the debug log stream. Call on process exit.
 */
export function closeDebugLog(): void {
  if (logStream) {
    logStream.write(formatLogLine('LOG', ['=== Debug log closed ===']));
    logStream.end();
    logStream = null;
  }
}

/**
 * Clean up old debug log files, keeping only the most recent N.
 */
export function cleanupOldLogs(keepCount: number = 10): void {
  const logDir = path.join(os.homedir(), '.forkoff-cli', 'logs');
  try {
    const files = fs.readdirSync(logDir)
      .filter(f => f.startsWith('debug-') && f.endsWith('.log'))
      .sort()
      .reverse();

    // Delete files beyond keepCount
    for (let i = keepCount; i < files.length; i++) {
      try {
        fs.unlinkSync(path.join(logDir, files[i]));
      } catch {
        // Ignore deletion errors
      }
    }
  } catch {
    // Log directory may not exist
  }
}

export function createSpinner(text: string): ora.Ora {
  return ora({ text, isSilent: quiet });
}
