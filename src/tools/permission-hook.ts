#!/usr/bin/env node

/**
 * ForkOff Permission Hook for Claude Code
 *
 * This is a standalone PreToolUse hook script. Claude Code spawns it as a
 * child process, passes tool info via stdin JSON, and reads the permission
 * decision from stdout JSON.
 *
 * The hook reads user-configurable rules from a JSON file on disk (written by
 * the CLI when mobile syncs rules). If no rules file exists, it falls back to
 * a hardcoded default safe-tools set.
 *
 * Safe tools are auto-approved immediately. For Bash, command patterns are
 * checked against user-defined glob patterns. Dangerous tools write a request
 * temp file and poll for a response file that the main CLI process creates
 * after receiving a mobile approval/denial.
 *
 * Exit codes:
 *   0 — allow (decision accepted)
 *   2 — deny (block the tool use)
 *
 * No external dependencies — only Node.js built-ins.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEMP_DIR = path.join(os.tmpdir(), 'forkoff-permissions');
const RULES_FILE = path.join(TEMP_DIR, 'rules.json');
const POLL_INTERVAL_MS = 200;
const TIMEOUT_MS = 300_000; // 5 minutes

/** Fallback safe tools when no rules file exists */
const DEFAULT_SAFE_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'AskUserQuestion',
  'Skill',
  'EnterPlanMode',
  'ExitPlanMode',
  'mcp__ide__getDiagnostics',
  'mcp__ide__executeCode',
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
}

interface PermissionRule {
  tool: string;
  action: 'allow' | 'ask';
  patterns?: string[];
}

interface PermissionRequest {
  promptId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  timestamp: number;
}

interface PermissionResponse {
  decision: 'allow' | 'deny';
  reason: string;
}

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: string;
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write the decision JSON to stdout synchronously and exit immediately. */
function respond(decision: 'allow' | 'deny', reason: string): never {
  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };

  // Use synchronous write to fd 1 (stdout) — process.stdout.write() is async
  // and the process would exit before the write completes.
  fs.writeSync(1, JSON.stringify(output) + '\n');
  process.exit(decision === 'allow' ? 0 : 2);
}

/** Ensure the temp directory exists. */
function ensureTempDir(): void {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

/** Cleanup request and response temp files. */
function cleanup(promptId: string): void {
  const requestFile = path.join(TEMP_DIR, `${promptId}.request.json`);
  const responseFile = path.join(TEMP_DIR, `${promptId}.response.json`);

  try {
    if (fs.existsSync(requestFile)) fs.unlinkSync(requestFile);
  } catch {
    // Best effort — ignore errors during cleanup.
  }

  try {
    if (fs.existsSync(responseFile)) fs.unlinkSync(responseFile);
  } catch {
    // Best effort.
  }
}

/**
 * Load permission rules from the rules file on disk.
 * Falls back to hardcoded defaults if the file doesn't exist or is invalid.
 */
export function loadRules(): { safeTools: Set<string>; bashPatterns: string[] } {
  try {
    const raw = fs.readFileSync(RULES_FILE, 'utf-8');
    const rules: PermissionRule[] = JSON.parse(raw);

    if (!Array.isArray(rules)) {
      return { safeTools: new Set(DEFAULT_SAFE_TOOLS), bashPatterns: [] };
    }

    const safeTools = new Set<string>();
    let bashPatterns: string[] = [];

    for (const rule of rules) {
      if (rule.action === 'allow') {
        safeTools.add(rule.tool);
        if (rule.tool === 'Bash' && Array.isArray(rule.patterns)) {
          bashPatterns = rule.patterns;
        }
      }
    }

    return { safeTools, bashPatterns };
  } catch {
    return { safeTools: new Set(DEFAULT_SAFE_TOOLS), bashPatterns: [] };
  }
}

/**
 * Check if a command matches any of the given glob-like patterns.
 * Patterns use simple glob matching where `*` matches any characters.
 *
 * @example
 * matchesAnyPattern('npm test', ['npm *', 'git status']) // true
 * matchesAnyPattern('rm -rf /', ['npm *', 'git status']) // false
 */
export function matchesAnyPattern(command: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (globMatch(command, pattern)) return true;
  }
  return false;
}

/**
 * Simple glob matching: `*` matches any sequence of characters.
 * The entire command must match (not just a prefix).
 */
function globMatch(str: string, pattern: string): boolean {
  // Escape regex special chars except *, then replace * with .*
  const regexStr = '^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*') + '$';
  return new RegExp(regexStr).test(str);
}

/**
 * Poll for the response file until it appears or the timeout elapses.
 * Returns the parsed response, or null on timeout.
 */
function pollForResponse(promptId: string): Promise<PermissionResponse | null> {
  const responseFile = path.join(TEMP_DIR, `${promptId}.response.json`);
  const deadline = Date.now() + TIMEOUT_MS;

  return new Promise((resolve) => {
    const check = (): void => {
      if (Date.now() > deadline) {
        resolve(null);
        return;
      }

      try {
        if (fs.existsSync(responseFile)) {
          const raw = fs.readFileSync(responseFile, 'utf-8');
          const response: PermissionResponse = JSON.parse(raw);
          resolve(response);
          return;
        }
      } catch {
        // File may be partially written — retry on next poll.
      }

      setTimeout(check, POLL_INTERVAL_MS);
    };

    check();
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Read all of stdin (Claude Code writes the JSON then closes the pipe).
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  const rawInput = Buffer.concat(chunks).toString('utf-8').trim();

  if (!rawInput) {
    respond('deny', 'No input received on stdin');
  }

  let input: HookInput;
  try {
    input = JSON.parse(rawInput) as HookInput;
  } catch {
    respond('deny', 'Failed to parse stdin JSON');
    return; // unreachable, satisfies TS
  }

  const { tool_name: toolName, tool_input: toolInput, tool_use_id: toolUseId } = input;

  // ------------------------------------------------------------------
  // Load dynamic rules (from mobile sync) or fall back to defaults.
  // ------------------------------------------------------------------
  const { safeTools, bashPatterns } = loadRules();

  // ------------------------------------------------------------------
  // Fast path: auto-approve safe tools.
  // For Bash with patterns, check command against patterns first.
  // ------------------------------------------------------------------
  if (safeTools.has(toolName)) {
    if (toolName === 'Bash' && bashPatterns.length > 0) {
      // Bash is allowed, but only for matching commands
      const command = String(toolInput.command || '');
      if (matchesAnyPattern(command, bashPatterns)) {
        respond('allow', `Auto-approved: Bash command matches pattern`);
      }
      // Command doesn't match any pattern — fall through to ask user
    } else {
      respond('allow', `Auto-approved safe tool: ${toolName}`);
    }
  }

  // ------------------------------------------------------------------
  // Dangerous tool — request approval via temp file IPC.
  // ------------------------------------------------------------------
  const promptId = crypto.randomUUID();

  try {
    ensureTempDir();

    const request: PermissionRequest = {
      promptId,
      toolName,
      toolInput,
      toolUseId,
      timestamp: Date.now(),
    };

    const requestFile = path.join(TEMP_DIR, `${promptId}.request.json`);
    fs.writeFileSync(requestFile, JSON.stringify(request, null, 2), 'utf-8');

    console.error(
      `[forkoff-hook] Permission requested for ${toolName} (promptId=${promptId}), polling...`,
    );

    const response = await pollForResponse(promptId);

    if (!response) {
      // Timeout — deny for safety.
      cleanup(promptId);
      respond('deny', 'Permission request timed out (5 minutes)');
    }

    // Clean up temp files before responding.
    cleanup(promptId);

    if (response!.decision === 'allow') {
      respond('allow', response!.reason || 'User approved via mobile');
    } else {
      respond('deny', response!.reason || 'User denied via mobile');
    }
  } catch (err) {
    // On any unexpected error, deny for safety.
    cleanup(promptId);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[forkoff-hook] Error: ${message}`);
    respond('deny', `Hook error: ${message}`);
  }
}

// Kick off and catch top-level errors.
main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[forkoff-hook] Fatal error: ${message}`);

  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Fatal hook error: ${message}`,
    },
  };

  fs.writeSync(1, JSON.stringify(output) + '\n');
  process.exit(2);
});
