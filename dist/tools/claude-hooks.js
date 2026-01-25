"use strict";
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
exports.claudeHooksManager = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const events_1 = require("events");
class ClaudeHooksManager extends events_1.EventEmitter {
    constructor() {
        super();
        this.isConfigured = false;
        this.claudeDir = path.join(os.homedir(), '.claude');
        this.settingsPath = path.join(this.claudeDir, 'settings.json');
        this.hookScriptPath = this.getHookScriptPath();
    }
    getHookScriptPath() {
        const platform = os.platform();
        if (platform === 'win32') {
            return path.join(os.homedir(), '.forkoff', 'forkoff-hook.cmd');
        }
        else {
            return path.join(os.homedir(), '.forkoff', 'forkoff-hook');
        }
    }
    /**
     * Check if Claude Code is installed and hooks can be configured
     */
    canConfigure() {
        return fs.existsSync(this.claudeDir);
    }
    /**
     * Check if ForkOff hooks are already configured
     */
    isHookConfigured() {
        if (!fs.existsSync(this.settingsPath)) {
            return false;
        }
        try {
            const settings = this.readSettings();
            const hookName = 'forkoff-hook';
            // Check if any hook configuration references forkoff-hook
            const hookTypes = ['PreToolUse', 'PostToolUse', 'Notification', 'Stop'];
            for (const hookType of hookTypes) {
                const hooks = settings.hooks?.[hookType];
                if (hooks && hooks.some(h => h.hooks.includes(hookName))) {
                    return true;
                }
            }
        }
        catch {
            return false;
        }
        return false;
    }
    /**
     * Read Claude settings
     */
    readSettings() {
        if (!fs.existsSync(this.settingsPath)) {
            return {};
        }
        const content = fs.readFileSync(this.settingsPath, 'utf8');
        return JSON.parse(content);
    }
    /**
     * Write Claude settings
     */
    writeSettings(settings) {
        fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2));
    }
    /**
     * Install ForkOff hooks into Claude Code
     */
    async installHooks() {
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
    async createHookScript() {
        const platform = os.platform();
        if (platform === 'win32') {
            // Windows batch script
            const script = `@echo off
node "%~dp0forkoff-hook.js" %*
`;
            fs.writeFileSync(this.hookScriptPath, script);
            // Create the Node.js script
            const jsScript = this.getHookJsScript();
            fs.writeFileSync(path.join(path.dirname(this.hookScriptPath), 'forkoff-hook.js'), jsScript);
        }
        else {
            // Unix shell script
            const script = `#!/bin/bash
node "$(dirname "$0")/forkoff-hook.js" "$@"
`;
            fs.writeFileSync(this.hookScriptPath, script, { mode: 0o755 });
            // Create the Node.js script
            const jsScript = this.getHookJsScript();
            fs.writeFileSync(path.join(path.dirname(this.hookScriptPath), 'forkoff-hook.js'), jsScript);
        }
    }
    /**
     * Get the JavaScript hook script content
     */
    getHookJsScript() {
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
    async uninstallHooks() {
        if (!fs.existsSync(this.settingsPath)) {
            return;
        }
        const settings = this.readSettings();
        if (settings.hooks) {
            // Remove forkoff-hook from all hook types
            for (const hookType of ['PreToolUse', 'PostToolUse', 'Notification', 'Stop']) {
                if (settings.hooks[hookType]) {
                    settings.hooks[hookType] = settings.hooks[hookType].filter(h => !h.hooks.includes('forkoff-hook'));
                    if (settings.hooks[hookType].length === 0) {
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
            }
            catch {
                // Ignore errors
            }
        }
        this.isConfigured = false;
        this.emit('hooks_uninstalled');
    }
    /**
     * Process a hook event (called by the hook script via local HTTP)
     */
    processHookEvent(hookData) {
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
    handlePreToolUse(hookData) {
        this.emit('pre_tool_use', {
            toolName: hookData.tool_name,
            toolInput: hookData.tool_input,
            sessionId: hookData.session_id,
        });
        // For now, always allow - approval logic can be added later
        return { continue: true };
    }
    handlePostToolUse(hookData) {
        this.emit('post_tool_use', {
            toolName: hookData.tool_name,
            toolInput: hookData.tool_input,
            toolOutput: hookData.tool_output,
            sessionId: hookData.session_id,
        });
        return { continue: true };
    }
    handleNotification(hookData) {
        this.emit('notification', {
            message: hookData.message,
            sessionId: hookData.session_id,
        });
        return { continue: true };
    }
    handleStop(hookData) {
        this.emit('stop', {
            sessionId: hookData.session_id,
            transcriptPath: hookData.transcript_path,
        });
        return { continue: true };
    }
}
exports.claudeHooksManager = new ClaudeHooksManager();
exports.default = exports.claudeHooksManager;
//# sourceMappingURL=claude-hooks.js.map