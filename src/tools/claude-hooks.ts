/**
 * Claude Code Hooks Integration
 *
 * Integrates with Claude Code's hook system to:
 * - Intercept tool usage (PreToolUse, PostToolUse)
 * - Receive notifications
 * - Request approvals before executing dangerous operations
 *
 * Claude Code hooks are configured in ~/.claude/settings.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';

export interface ClaudeHookInput {
  hook_type: 'PreToolUse' | 'PostToolUse' | 'Notification' | 'Stop';
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  session_id: string;
  message?: string;
  transcript_path?: string;
}

export interface ClaudeHookOutput {
  continue: boolean;
  reason?: string;
  // For PreToolUse - can modify the input
  modified_input?: Record<string, unknown>;
}

export interface ClaudeSettings {
  hooks?: {
    PreToolUse?: Array<{ matcher: string; hooks: string[] }>;
    PostToolUse?: Array<{ matcher: string; hooks: string[] }>;
    Notification?: Array<{ matcher: string; hooks: string[] }>;
    Stop?: Array<{ matcher: string; hooks: string[] }>;
  };
  permissions?: Record<string, unknown>;
}

class ClaudeHooksManager extends EventEmitter {
  private claudeDir: string;
  private settingsPath: string;
  private hookScriptPath: string;
  private isConfigured: boolean = false;

  constructor() {
    super();
    this.claudeDir = path.join(os.homedir(), '.claude');
    this.settingsPath = path.join(this.claudeDir, 'settings.json');
    this.hookScriptPath = this.getHookScriptPath();
  }

  private getHookScriptPath(): string {
    const platform = os.platform();

    if (platform === 'win32') {
      return path.join(os.homedir(), '.forkoff', 'forkoff-hook.cmd');
    } else {
      return path.join(os.homedir(), '.forkoff', 'forkoff-hook');
    }
  }

  /**
   * Check if Claude Code is installed and hooks can be configured
   */
  canConfigure(): boolean {
    return fs.existsSync(this.claudeDir);
  }

  /**
   * Check if ForkOff hooks are already configured
   */
  isHookConfigured(): boolean {
    if (!fs.existsSync(this.settingsPath)) {
      return false;
    }

    try {
      const settings = this.readSettings();
      const hookName = 'forkoff-hook';

      // Check if any hook configuration references forkoff-hook
      const hookTypes: Array<keyof NonNullable<ClaudeSettings['hooks']>> = ['PreToolUse', 'PostToolUse', 'Notification', 'Stop'];
      for (const hookType of hookTypes) {
        const hooks = settings.hooks?.[hookType];
        if (hooks && hooks.some(h => h.hooks.includes(hookName))) {
          return true;
        }
      }
    } catch {
      return false;
    }

    return false;
  }

  /**
   * Read Claude settings
   */
  private readSettings(): ClaudeSettings {
    if (!fs.existsSync(this.settingsPath)) {
      return {};
    }

    const content = fs.readFileSync(this.settingsPath, 'utf8');
    return JSON.parse(content);
  }

  /**
   * Write Claude settings
   */
  private writeSettings(settings: ClaudeSettings): void {
    fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2));
  }

  /**
   * Install ForkOff hooks into Claude Code
   */
  async installHooks(): Promise<void> {
    if (!this.canConfigure()) {
      throw new Error('Claude Code not found. Please install Claude Code first.');
    }

    // Create hook script directory
    const hookDir = path.dirname(this.hookScriptPath);
    if (!fs.existsSync(hookDir)) {
      fs.mkdirSync(hookDir, { recursive: true });
    }

    // Create the hook script
    await this.createHookScript();

    // Update Claude settings
    const settings = this.readSettings();

    settings.hooks = settings.hooks || {};

    const hookConfig = { matcher: '.*', hooks: ['forkoff-hook'] };

    // Add hooks for all event types
    settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];
    if (!settings.hooks.PreToolUse.some(h => h.hooks.includes('forkoff-hook'))) {
      settings.hooks.PreToolUse.push(hookConfig);
    }

    settings.hooks.PostToolUse = settings.hooks.PostToolUse || [];
    if (!settings.hooks.PostToolUse.some(h => h.hooks.includes('forkoff-hook'))) {
      settings.hooks.PostToolUse.push(hookConfig);
    }

    settings.hooks.Notification = settings.hooks.Notification || [];
    if (!settings.hooks.Notification.some(h => h.hooks.includes('forkoff-hook'))) {
      settings.hooks.Notification.push(hookConfig);
    }

    this.writeSettings(settings);
    this.isConfigured = true;

    this.emit('hooks_installed');
  }

  /**
   * Create the hook script that Claude Code will execute
   */
  private async createHookScript(): Promise<void> {
    const platform = os.platform();

    if (platform === 'win32') {
      // Windows batch script
      const script = `@echo off
node "%~dp0forkoff-hook.js" %*
`;
      fs.writeFileSync(this.hookScriptPath, script);

      // Create the Node.js script
      const jsScript = this.getHookJsScript();
      fs.writeFileSync(
        path.join(path.dirname(this.hookScriptPath), 'forkoff-hook.js'),
        jsScript
      );
    } else {
      // Unix shell script
      const script = `#!/bin/bash
node "$(dirname "$0")/forkoff-hook.js" "$@"
`;
      fs.writeFileSync(this.hookScriptPath, script, { mode: 0o755 });

      // Create the Node.js script
      const jsScript = this.getHookJsScript();
      fs.writeFileSync(
        path.join(path.dirname(this.hookScriptPath), 'forkoff-hook.js'),
        jsScript
      );
    }
  }

  /**
   * Get the JavaScript hook script content
   */
  private getHookJsScript(): string {
    return `#!/usr/bin/env node
/**
 * ForkOff Hook Script for Claude Code
 * This script is called by Claude Code for hook events
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Read input from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});

process.stdin.on('end', async () => {
  try {
    const hookData = JSON.parse(input);

    // Try to send to ForkOff daemon
    await sendToForkOff(hookData);

    // By default, allow the operation to continue
    const output = { continue: true };
    console.log(JSON.stringify(output));
    process.exit(0);
  } catch (error) {
    // On error, still allow the operation
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }
});

async function sendToForkOff(hookData) {
  return new Promise((resolve, reject) => {
    // Read config to find daemon port
    const configPath = path.join(require('os').homedir(), '.forkoff', 'config.json');

    let port = 47471; // Default daemon port
    try {
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        port = config.daemonPort || port;
      }
    } catch {}

    const data = JSON.stringify(hookData);

    const options = {
      hostname: '127.0.0.1',
      port: port,
      path: '/hook',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 1000
    };

    const req = http.request(options, (res) => {
      let response = '';
      res.on('data', (chunk) => response += chunk);
      res.on('end', () => resolve(response));
    });

    req.on('error', () => resolve(null)); // Daemon not running, that's ok
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    req.write(data);
    req.end();
  });
}
`;
  }

  /**
   * Remove ForkOff hooks from Claude Code
   */
  async uninstallHooks(): Promise<void> {
    if (!fs.existsSync(this.settingsPath)) {
      return;
    }

    const settings = this.readSettings();

    if (settings.hooks) {
      // Remove forkoff-hook from all hook types
      for (const hookType of ['PreToolUse', 'PostToolUse', 'Notification', 'Stop'] as const) {
        if (settings.hooks[hookType]) {
          settings.hooks[hookType] = settings.hooks[hookType]!.filter(
            h => !h.hooks.includes('forkoff-hook')
          );
          if (settings.hooks[hookType]!.length === 0) {
            delete settings.hooks[hookType];
          }
        }
      }

      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }
    }

    this.writeSettings(settings);

    // Remove hook scripts
    const hookDir = path.dirname(this.hookScriptPath);
    if (fs.existsSync(hookDir)) {
      try {
        fs.rmSync(hookDir, { recursive: true });
      } catch {
        // Ignore errors
      }
    }

    this.isConfigured = false;
    this.emit('hooks_uninstalled');
  }

  /**
   * Process a hook event (called by the hook script via local HTTP)
   */
  processHookEvent(hookData: ClaudeHookInput): ClaudeHookOutput {
    this.emit('hook_event', hookData);

    switch (hookData.hook_type) {
      case 'PreToolUse':
        return this.handlePreToolUse(hookData);
      case 'PostToolUse':
        return this.handlePostToolUse(hookData);
      case 'Notification':
        return this.handleNotification(hookData);
      case 'Stop':
        return this.handleStop(hookData);
      default:
        return { continue: true };
    }
  }

  private handlePreToolUse(hookData: ClaudeHookInput): ClaudeHookOutput {
    this.emit('pre_tool_use', {
      toolName: hookData.tool_name,
      toolInput: hookData.tool_input,
      sessionId: hookData.session_id,
    });

    // For now, always allow - approval logic can be added later
    return { continue: true };
  }

  private handlePostToolUse(hookData: ClaudeHookInput): ClaudeHookOutput {
    this.emit('post_tool_use', {
      toolName: hookData.tool_name,
      toolInput: hookData.tool_input,
      toolOutput: hookData.tool_output,
      sessionId: hookData.session_id,
    });

    return { continue: true };
  }

  private handleNotification(hookData: ClaudeHookInput): ClaudeHookOutput {
    this.emit('notification', {
      message: hookData.message,
      sessionId: hookData.session_id,
    });

    return { continue: true };
  }

  private handleStop(hookData: ClaudeHookInput): ClaudeHookOutput {
    this.emit('stop', {
      sessionId: hookData.session_id,
      transcriptPath: hookData.transcript_path,
    });

    return { continue: true };
  }
}

export const claudeHooksManager = new ClaudeHooksManager();
export default claudeHooksManager;
