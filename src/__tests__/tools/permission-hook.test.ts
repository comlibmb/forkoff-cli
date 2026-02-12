/**
 * Tests for Permission Hook Script (permission-hook.ts)
 *
 * The permission hook is a standalone script spawned by Claude Code as a
 * PreToolUse hook. It reads JSON from stdin, decides whether to auto-approve
 * (safe tools) or request approval via temp files (dangerous tools), and
 * writes a JSON decision to stdout.
 *
 * These tests spawn the real hook script as a child process using ts-node,
 * write JSON to its stdin, and verify stdout output and exit codes.
 *
 * For dangerous-tool tests, we also watch the temp directory for the
 * .request.json file the hook writes, then write a .response.json file
 * to simulate the IPC manager's response.
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Give child processes plenty of time
jest.setTimeout(30000);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOOK_SCRIPT = path.resolve(__dirname, '../../tools/permission-hook.ts');
const TEMP_DIR = path.join(os.tmpdir(), 'forkoff-permissions');

/** All tools the hook considers safe by default (must match DEFAULT_SAFE_TOOLS in the hook). */
const SAFE_TOOLS = [
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
  'TaskOutput', 'TaskStop', 'AskUserQuestion', 'Skill',
  'EnterPlanMode', 'ExitPlanMode',
  'mcp__ide__getDiagnostics', 'mcp__ide__executeCode',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
}

interface HookResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  parsed: {
    hookSpecificOutput: {
      hookEventName: string;
      permissionDecision: 'allow' | 'deny';
      permissionDecisionReason: string;
    };
  } | null;
}

/**
 * Build a standard hook stdin payload.
 */
function makeInput(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: 'test-session-1',
    cwd: '/home/user/project',
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: '/some/file.ts' },
    tool_use_id: 'toolu_test_01',
    ...overrides,
  };
}

/**
 * Spawn the hook script via ts-node, write input to stdin, and collect
 * stdout/stderr/exitCode.
 *
 * @param stdinData - The string to write to the child's stdin (or null to
 *                    close stdin immediately with no data).
 */
function runHook(stdinData: string | null): Promise<HookResult> {
  return new Promise((resolve) => {
    // Use node directly to run ts-node's bin.js (avoids .cmd spawn issues on Windows)
    const projectRoot = path.resolve(__dirname, '../../..');
    const tsNodeBin = path.join(projectRoot, 'node_modules', 'ts-node', 'dist', 'bin.js');

    const child: ChildProcess = spawn(
      process.execPath,
      [tsNodeBin, '--transpile-only', HOOK_SCRIPT],
      {
        cwd: projectRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      },
    );

    let stdout = '';
    let stderr = '';

    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      resolve({ stdout, stderr, exitCode: null, parsed: null });
    });

    child.on('close', (code) => {
      let parsed: HookResult['parsed'] = null;
      try {
        // The hook's respond() function throws 'unreachable' after writing
        // stdout, which triggers the top-level .catch() handler that writes
        // a second JSON line. We only care about the FIRST JSON line.
        const lines = stdout.trim().split('\n').filter(Boolean);
        if (lines.length > 0) {
          parsed = JSON.parse(lines[0]);
        }
      } catch {
        // not parseable
      }

      resolve({ stdout, stderr, exitCode: code, parsed });
    });

    // Write stdin data and close the stream
    if (stdinData !== null) {
      child.stdin!.write(stdinData);
    }
    child.stdin!.end();
  });
}

/**
 * Watch the temp directory for a new .request.json file that was NOT present
 * in the `excludeFiles` set. This prevents picking up stale files from
 * previous tests.
 */
function waitForRequestFile(
  excludeFiles: Set<string> = new Set(),
  timeoutMs: number = 15000,
  pollMs: number = 100,
): Promise<{ filePath: string; content: any }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    const check = (): void => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`No new .request.json file appeared in ${TEMP_DIR} within ${timeoutMs}ms`));
        return;
      }

      try {
        if (fs.existsSync(TEMP_DIR)) {
          const files = fs.readdirSync(TEMP_DIR).filter(
            (f) => f.endsWith('.request.json') && !excludeFiles.has(f),
          );
          if (files.length > 0) {
            const filePath = path.join(TEMP_DIR, files[0]);
            const raw = fs.readFileSync(filePath, 'utf-8');
            const content = JSON.parse(raw);
            resolve({ filePath, content });
            return;
          }
        }
      } catch {
        // retry
      }

      setTimeout(check, pollMs);
    };

    check();
  });
}

/**
 * Snapshot the current set of files in the temp directory.
 */
function snapshotTempDir(): Set<string> {
  try {
    if (fs.existsSync(TEMP_DIR)) {
      return new Set(fs.readdirSync(TEMP_DIR));
    }
  } catch {
    // ignore
  }
  return new Set();
}

/**
 * Write a response file for the hook to pick up.
 */
function writeResponseFile(
  promptId: string,
  decision: 'allow' | 'deny',
  reason: string = '',
): void {
  const responseFile = path.join(TEMP_DIR, `${promptId}.response.json`);
  const data: { decision: string; reason?: string } = { decision };
  if (reason) {
    data.reason = reason;
  }
  fs.writeFileSync(responseFile, JSON.stringify(data), 'utf-8');
}

/**
 * Clean up the temp directory before/after tests.
 */
function cleanTempDir(): void {
  try {
    if (fs.existsSync(TEMP_DIR)) {
      const files = fs.readdirSync(TEMP_DIR);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(TEMP_DIR, file));
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
}

// ===========================================================================
// TEST SUITES
// ===========================================================================

describe('Permission Hook Script', () => {
  beforeEach(() => {
    cleanTempDir();
  });

  afterEach(() => {
    cleanTempDir();
  });

  // =========================================================================
  // 1. Safe tool (Read) -> auto-approved, exit code 0
  // =========================================================================

  describe('safe tool auto-approval', () => {
    it('auto-approves Read tool with exit code 0', async () => {
      const input = makeInput({ tool_name: 'Read' });
      const result = await runHook(JSON.stringify(input));

      expect(result.exitCode).toBe(0);
      expect(result.parsed).not.toBeNull();
      expect(result.parsed!.hookSpecificOutput.permissionDecision).toBe('allow');
      expect(result.parsed!.hookSpecificOutput.permissionDecisionReason).toContain('Auto-approved');
      expect(result.parsed!.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    });

    // =========================================================================
    // 2. Safe tool (Glob) -> same
    // =========================================================================

    it('auto-approves Glob tool with exit code 0', async () => {
      const input = makeInput({ tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } });
      const result = await runHook(JSON.stringify(input));

      expect(result.exitCode).toBe(0);
      expect(result.parsed!.hookSpecificOutput.permissionDecision).toBe('allow');
    });

    it('auto-approves Grep tool', async () => {
      const input = makeInput({ tool_name: 'Grep', tool_input: { pattern: 'TODO' } });
      const result = await runHook(JSON.stringify(input));

      expect(result.exitCode).toBe(0);
      expect(result.parsed!.hookSpecificOutput.permissionDecision).toBe('allow');
    });

    it('auto-approves WebSearch tool', async () => {
      const input = makeInput({ tool_name: 'WebSearch', tool_input: { query: 'test' } });
      const result = await runHook(JSON.stringify(input));

      expect(result.exitCode).toBe(0);
      expect(result.parsed!.hookSpecificOutput.permissionDecision).toBe('allow');
    });

    it('auto-approves TaskCreate tool', async () => {
      const input = makeInput({ tool_name: 'TaskCreate' });
      const result = await runHook(JSON.stringify(input));

      expect(result.exitCode).toBe(0);
      expect(result.parsed!.hookSpecificOutput.permissionDecision).toBe('allow');
    });

    it('auto-approves mcp__ide__getDiagnostics tool', async () => {
      const input = makeInput({ tool_name: 'mcp__ide__getDiagnostics' });
      const result = await runHook(JSON.stringify(input));

      expect(result.exitCode).toBe(0);
      expect(result.parsed!.hookSpecificOutput.permissionDecision).toBe('allow');
    });

    it('treats NotebookEdit as dangerous by default (requires approval)', async () => {
      const input = makeInput({ tool_name: 'NotebookEdit' });

      const existing = snapshotTempDir();
      const hookPromise = runHook(JSON.stringify(input));
      const { content } = await waitForRequestFile(existing);

      expect(content.toolName).toBe('NotebookEdit');

      writeResponseFile(content.promptId, 'allow');
      const result = await hookPromise;

      expect(result.exitCode).toBe(0);
      expect(result.parsed!.hookSpecificOutput.permissionDecision).toBe('allow');
    });

    it('does NOT write any temp files for safe tools', async () => {
      const existingBefore = snapshotTempDir();
      const input = makeInput({ tool_name: 'Read' });
      await runHook(JSON.stringify(input));

      // Check that no NEW request files were created
      if (fs.existsSync(TEMP_DIR)) {
        const newFiles = fs.readdirSync(TEMP_DIR).filter(
          (f) => f.endsWith('.request.json') && !existingBefore.has(f),
        );
        expect(newFiles).toHaveLength(0);
      }
    });
  });

  // =========================================================================
  // 3. Dangerous tool (Bash) -> writes request file, allow response -> exit 0
  // =========================================================================

  describe('dangerous tool with allow response', () => {
    it('Bash tool: writes request file and exits 0 when allowed', async () => {
      const input = makeInput({
        tool_name: 'Bash',
        tool_input: { command: 'npm install' },
        tool_use_id: 'toolu_bash_01',
      });

      const existing = snapshotTempDir();
      const hookPromise = runHook(JSON.stringify(input));
      const { content } = await waitForRequestFile(existing);

      expect(content.toolName).toBe('Bash');
      expect(content.toolInput).toEqual({ command: 'npm install' });
      expect(content.toolUseId).toBe('toolu_bash_01');
      expect(content.promptId).toBeDefined();

      writeResponseFile(content.promptId, 'allow', 'User approved via mobile');
      const result = await hookPromise;

      expect(result.exitCode).toBe(0);
      expect(result.parsed).not.toBeNull();
      expect(result.parsed!.hookSpecificOutput.permissionDecision).toBe('allow');
      expect(result.parsed!.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    });

    it('Edit tool: writes request file and exits 0 when allowed', async () => {
      const input = makeInput({
        tool_name: 'Edit',
        tool_input: { file_path: '/src/app.ts', old_string: 'a', new_string: 'b' },
      });

      const existing = snapshotTempDir();
      const hookPromise = runHook(JSON.stringify(input));
      const { content } = await waitForRequestFile(existing);

      expect(content.toolName).toBe('Edit');

      writeResponseFile(content.promptId, 'allow');
      const result = await hookPromise;

      expect(result.exitCode).toBe(0);
      expect(result.parsed!.hookSpecificOutput.permissionDecision).toBe('allow');
    });
  });

  // =========================================================================
  // 4. Dangerous tool (Write) -> writes request file, deny response -> exit 2
  // =========================================================================

  describe('dangerous tool with deny response', () => {
    it('Write tool: writes request file and exits 2 when denied', async () => {
      const input = makeInput({
        tool_name: 'Write',
        tool_input: { file_path: '/etc/passwd', content: 'bad stuff' },
        tool_use_id: 'toolu_write_01',
      });

      const existing = snapshotTempDir();
      const hookPromise = runHook(JSON.stringify(input));
      const { content } = await waitForRequestFile(existing);

      expect(content.toolName).toBe('Write');
      expect(content.toolInput).toEqual({ file_path: '/etc/passwd', content: 'bad stuff' });

      writeResponseFile(content.promptId, 'deny', 'Too risky');
      const result = await hookPromise;

      expect(result.exitCode).toBe(2);
      expect(result.parsed).not.toBeNull();
      expect(result.parsed!.hookSpecificOutput.permissionDecision).toBe('deny');
    });

    it('Bash tool: exits 2 when denied', async () => {
      const input = makeInput({
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      });

      const existing = snapshotTempDir();
      const hookPromise = runHook(JSON.stringify(input));
      const { content } = await waitForRequestFile(existing);

      writeResponseFile(content.promptId, 'deny', 'Absolutely not');
      const result = await hookPromise;

      expect(result.exitCode).toBe(2);
      expect(result.parsed!.hookSpecificOutput.permissionDecision).toBe('deny');
    });
  });

  // =========================================================================
  // 5. Empty stdin -> deny
  // =========================================================================

  describe('empty stdin', () => {
    it('denies with exit code 2 when stdin is empty', async () => {
      const result = await runHook('');

      expect(result.exitCode).toBe(2);
      expect(result.parsed).not.toBeNull();
      expect(result.parsed!.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(result.parsed!.hookSpecificOutput.permissionDecisionReason).toContain('No input');
    });

    it('denies with exit code 2 when stdin is null (closed immediately)', async () => {
      const result = await runHook(null);

      expect(result.exitCode).toBe(2);
      expect(result.parsed).not.toBeNull();
      expect(result.parsed!.hookSpecificOutput.permissionDecision).toBe('deny');
    });
  });

  // =========================================================================
  // 6. Invalid JSON stdin -> deny
  // =========================================================================

  describe('invalid JSON stdin', () => {
    it('denies with exit code 2 when stdin is not valid JSON', async () => {
      const result = await runHook('this is not json {{{');

      expect(result.exitCode).toBe(2);
      expect(result.parsed).not.toBeNull();
      expect(result.parsed!.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(result.parsed!.hookSpecificOutput.permissionDecisionReason).toContain('parse');
    });

    it('denies with exit code 2 for truncated JSON', async () => {
      const result = await runHook('{"tool_name": "Bash", "tool_input"');

      expect(result.exitCode).toBe(2);
      expect(result.parsed!.hookSpecificOutput.permissionDecision).toBe('deny');
    });
  });

  // =========================================================================
  // Output format validation
  // =========================================================================

  describe('output format', () => {
    it('stdout is valid JSON with correct structure', async () => {
      const input = makeInput({ tool_name: 'Read' });
      const result = await runHook(JSON.stringify(input));

      // Must parse as JSON
      expect(result.parsed).not.toBeNull();

      // Must have the required nested structure
      const output = result.parsed!;
      expect(output).toHaveProperty('hookSpecificOutput');
      expect(output.hookSpecificOutput).toHaveProperty('hookEventName');
      expect(output.hookSpecificOutput).toHaveProperty('permissionDecision');
      expect(output.hookSpecificOutput).toHaveProperty('permissionDecisionReason');
    });

    it('hookEventName is always PreToolUse', async () => {
      const input = makeInput({ tool_name: 'Glob' });
      const result = await runHook(JSON.stringify(input));

      expect(result.parsed!.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    });
  });

  // =========================================================================
  // Request file content validation (for dangerous tools)
  // =========================================================================

  describe('request file content', () => {
    it('request file contains promptId, toolName, toolInput, toolUseId, and timestamp', async () => {
      const input = makeInput({
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' },
        tool_use_id: 'toolu_verify_fields',
      });

      const existing = snapshotTempDir();
      const hookPromise = runHook(JSON.stringify(input));
      const { content } = await waitForRequestFile(existing);

      expect(content).toHaveProperty('promptId');
      expect(typeof content.promptId).toBe('string');
      expect(content.promptId.length).toBeGreaterThan(0);

      expect(content.toolName).toBe('Bash');
      expect(content.toolInput).toEqual({ command: 'echo hello' });
      expect(content.toolUseId).toBe('toolu_verify_fields');
      expect(content).toHaveProperty('timestamp');
      expect(typeof content.timestamp).toBe('number');

      writeResponseFile(content.promptId, 'allow');
      await hookPromise;
    });

    it('request file is written to forkoff-permissions under os.tmpdir()', async () => {
      const input = makeInput({ tool_name: 'Bash' });

      const existing = snapshotTempDir();
      const hookPromise = runHook(JSON.stringify(input));
      const { filePath, content } = await waitForRequestFile(existing);

      expect(path.dirname(filePath)).toBe(TEMP_DIR);

      const fileName = path.basename(filePath);
      expect(fileName).toMatch(/^.+\.request\.json$/);

      writeResponseFile(content.promptId, 'allow');
      await hookPromise;
    });
  });

  // =========================================================================
  // Temp file cleanup by hook
  // =========================================================================

  describe('temp file cleanup', () => {
    it('hook cleans up request and response files after processing', async () => {
      const input = makeInput({ tool_name: 'Bash' });

      const existing = snapshotTempDir();
      const hookPromise = runHook(JSON.stringify(input));
      const { content } = await waitForRequestFile(existing);

      writeResponseFile(content.promptId, 'allow');
      await hookPromise;

      // After the hook exits, both files should be cleaned up
      const requestFile = path.join(TEMP_DIR, `${content.promptId}.request.json`);
      const responseFile = path.join(TEMP_DIR, `${content.promptId}.response.json`);

      expect(fs.existsSync(requestFile)).toBe(false);
      expect(fs.existsSync(responseFile)).toBe(false);
    });
  });

  // =========================================================================
  // Unknown/new tools default to dangerous
  // =========================================================================

  describe('unknown tools', () => {
    it('treats unknown tool names as dangerous (writes request file)', async () => {
      const input = makeInput({
        tool_name: 'SomeNewDangerousTool',
        tool_input: { arg: 'value' },
      });

      const existing = snapshotTempDir();
      const hookPromise = runHook(JSON.stringify(input));
      const { content } = await waitForRequestFile(existing);

      expect(content.toolName).toBe('SomeNewDangerousTool');

      writeResponseFile(content.promptId, 'deny', 'Unknown tool denied');
      const result = await hookPromise;

      expect(result.exitCode).toBe(2);
      expect(result.parsed!.hookSpecificOutput.permissionDecision).toBe('deny');
    });
  });

  // =========================================================================
  // Dynamic rules loading (loadRules / matchesAnyPattern)
  // =========================================================================

  describe('dynamic rules', () => {
    const RULES_FILE = path.join(TEMP_DIR, 'rules.json');

    afterEach(() => {
      // Clean up rules file
      try {
        if (fs.existsSync(RULES_FILE)) fs.unlinkSync(RULES_FILE);
      } catch {
        // ignore
      }
    });

    it('uses default safe tools when no rules file exists', async () => {
      // Ensure rules file does not exist
      try { fs.unlinkSync(RULES_FILE); } catch { /* ok */ }

      const input = makeInput({ tool_name: 'Read' });
      const result = await runHook(JSON.stringify(input));

      expect(result.exitCode).toBe(0);
      expect(result.parsed!.hookSpecificOutput.permissionDecision).toBe('allow');
    });

    it('auto-approves Write when rules file marks it as allow', async () => {
      // Write rules that allow Write
      if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
      const rules = [
        { tool: 'Read', action: 'allow' },
        { tool: 'Write', action: 'allow' },
        { tool: 'Bash', action: 'ask' },
      ];
      fs.writeFileSync(RULES_FILE, JSON.stringify(rules), 'utf-8');

      const input = makeInput({
        tool_name: 'Write',
        tool_input: { file_path: '/test.txt', content: 'hello' },
      });
      const result = await runHook(JSON.stringify(input));

      expect(result.exitCode).toBe(0);
      expect(result.parsed!.hookSpecificOutput.permissionDecision).toBe('allow');
    });

    it('requires approval for Read when rules file marks it as ask', async () => {
      // Write rules that require approval for Read
      if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
      const rules = [
        { tool: 'Read', action: 'ask' },
        { tool: 'Bash', action: 'ask' },
      ];
      fs.writeFileSync(RULES_FILE, JSON.stringify(rules), 'utf-8');

      const input = makeInput({ tool_name: 'Read' });
      const existing = snapshotTempDir();
      const hookPromise = runHook(JSON.stringify(input));
      const { content } = await waitForRequestFile(existing);

      expect(content.toolName).toBe('Read');

      writeResponseFile(content.promptId, 'allow');
      const result = await hookPromise;

      expect(result.exitCode).toBe(0);
    });

    it('auto-approves Bash command when it matches a pattern', async () => {
      // Write rules: Bash is allowed with patterns
      if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
      const rules = [
        { tool: 'Bash', action: 'allow', patterns: ['npm *', 'git status'] },
        { tool: 'Read', action: 'allow' },
      ];
      fs.writeFileSync(RULES_FILE, JSON.stringify(rules), 'utf-8');

      const input = makeInput({
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
      });
      const result = await runHook(JSON.stringify(input));

      expect(result.exitCode).toBe(0);
      expect(result.parsed!.hookSpecificOutput.permissionDecision).toBe('allow');
      expect(result.parsed!.hookSpecificOutput.permissionDecisionReason).toContain('pattern');
    });

    it('requires approval for Bash command that does NOT match any pattern', async () => {
      // Write rules: Bash is allowed but only for specific patterns
      if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
      const rules = [
        { tool: 'Bash', action: 'allow', patterns: ['npm *', 'git status'] },
        { tool: 'Read', action: 'allow' },
      ];
      fs.writeFileSync(RULES_FILE, JSON.stringify(rules), 'utf-8');

      const input = makeInput({
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      });

      const existing = snapshotTempDir();
      const hookPromise = runHook(JSON.stringify(input));
      const { content } = await waitForRequestFile(existing);

      expect(content.toolName).toBe('Bash');

      writeResponseFile(content.promptId, 'deny', 'Not a safe command');
      const result = await hookPromise;

      expect(result.exitCode).toBe(2);
      expect(result.parsed!.hookSpecificOutput.permissionDecision).toBe('deny');
    });

    it('falls back to defaults when rules file has invalid JSON', async () => {
      if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
      fs.writeFileSync(RULES_FILE, 'not valid json!!!', 'utf-8');

      const input = makeInput({ tool_name: 'Read' });
      const result = await runHook(JSON.stringify(input));

      // Read is in defaults, so should be auto-approved
      expect(result.exitCode).toBe(0);
      expect(result.parsed!.hookSpecificOutput.permissionDecision).toBe('allow');
    });
  });
});

// ===========================================================================
// Unit tests for exported helpers (loadRules, matchesAnyPattern)
// These use integration-style tests via the hook subprocess since the module
// runs main() on import. loadRules is tested via rules.json file + subprocess,
// and matchesAnyPattern is tested via Bash patterns + subprocess.
// ===========================================================================
