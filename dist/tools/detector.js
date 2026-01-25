"use strict";
/**
 * Tool Detector - Detects installed AI coding tools
 *
 * Supports:
 * - Claude Code (Anthropic CLI)
 * - Cursor IDE
 * - GitHub Copilot (VS Code extension)
 * - Continue.dev (VS Code extension)
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
exports.toolDetector = void 0;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
class ToolDetector {
    constructor() {
        this.platform = this.detectPlatform();
        this.homeDir = os.homedir();
    }
    detectPlatform() {
        switch (os.platform()) {
            case 'win32':
                return 'windows';
            case 'darwin':
                return 'macos';
            default:
                return 'linux';
        }
    }
    /**
     * Detect all supported AI coding tools
     */
    async detectAll() {
        const tools = [];
        // Detect each tool
        const claudeCode = await this.detectClaudeCode();
        if (claudeCode)
            tools.push(claudeCode);
        const cursor = await this.detectCursor();
        if (cursor)
            tools.push(cursor);
        const copilot = await this.detectCopilot();
        if (copilot)
            tools.push(copilot);
        const continueDev = await this.detectContinue();
        if (continueDev)
            tools.push(continueDev);
        return {
            tools,
            platform: this.platform,
            timestamp: new Date().toISOString(),
        };
    }
    /**
     * Detect Claude Code (Anthropic CLI)
     */
    async detectClaudeCode() {
        const tool = {
            type: 'claude-code',
            name: 'Claude Code',
            version: null,
            path: null,
            isRunning: false,
            configPath: null,
            status: 'detected',
        };
        // Check for .claude config directory
        const claudeConfigDir = path.join(this.homeDir, '.claude');
        if (fs.existsSync(claudeConfigDir)) {
            tool.configPath = claudeConfigDir;
            tool.status = 'configured';
        }
        // Try to find claude command
        try {
            const claudePath = this.findCommand('claude');
            if (claudePath) {
                tool.path = claudePath;
                // Get version
                try {
                    const versionOutput = (0, child_process_1.execSync)('claude --version', {
                        encoding: 'utf8',
                        timeout: 5000,
                        stdio: ['pipe', 'pipe', 'pipe']
                    }).trim();
                    // Parse version from output like "claude 1.0.0" or similar
                    const versionMatch = versionOutput.match(/[\d]+\.[\d]+\.[\d]+/);
                    if (versionMatch) {
                        tool.version = versionMatch[0];
                    }
                }
                catch {
                    // Command exists but version check failed
                }
            }
        }
        catch {
            // Claude command not found
        }
        // Check if Claude is running
        tool.isRunning = this.isProcessRunning('claude');
        if (tool.isRunning) {
            tool.status = 'running';
        }
        // Only return if we found evidence of Claude Code
        if (tool.configPath || tool.path) {
            return tool;
        }
        return null;
    }
    /**
     * Detect Cursor IDE
     */
    async detectCursor() {
        const tool = {
            type: 'cursor',
            name: 'Cursor',
            version: null,
            path: null,
            isRunning: false,
            configPath: null,
            status: 'detected',
        };
        // Check for Cursor installation based on platform
        const cursorPaths = {
            windows: [
                path.join(process.env.LOCALAPPDATA || '', 'Programs', 'cursor', 'Cursor.exe'),
                path.join(process.env.LOCALAPPDATA || '', 'cursor', 'Cursor.exe'),
                'C:\\Program Files\\Cursor\\Cursor.exe',
            ],
            macos: [
                '/Applications/Cursor.app',
                path.join(this.homeDir, 'Applications', 'Cursor.app'),
            ],
            linux: [
                '/usr/bin/cursor',
                '/opt/cursor/cursor',
                path.join(this.homeDir, '.local', 'bin', 'cursor'),
            ],
        };
        for (const cursorPath of cursorPaths[this.platform]) {
            if (fs.existsSync(cursorPath)) {
                tool.path = cursorPath;
                break;
            }
        }
        // Check for Cursor config
        const configPaths = {
            windows: path.join(process.env.APPDATA || '', 'Cursor', 'User'),
            macos: path.join(this.homeDir, 'Library', 'Application Support', 'Cursor', 'User'),
            linux: path.join(this.homeDir, '.config', 'Cursor', 'User'),
        };
        const configPath = configPaths[this.platform];
        if (fs.existsSync(configPath)) {
            tool.configPath = configPath;
            tool.status = 'configured';
        }
        // Check if Cursor is running
        tool.isRunning = this.isProcessRunning('cursor') || this.isProcessRunning('Cursor');
        if (tool.isRunning) {
            tool.status = 'running';
        }
        // Try to get version from package.json or similar
        if (tool.path && this.platform === 'macos') {
            try {
                const plistPath = path.join(tool.path, 'Contents', 'Info.plist');
                if (fs.existsSync(plistPath)) {
                    const plistContent = fs.readFileSync(plistPath, 'utf8');
                    const versionMatch = plistContent.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
                    if (versionMatch) {
                        tool.version = versionMatch[1];
                    }
                }
            }
            catch {
                // Couldn't read version
            }
        }
        if (tool.path || tool.configPath) {
            return tool;
        }
        return null;
    }
    /**
     * Detect GitHub Copilot (VS Code extension)
     */
    async detectCopilot() {
        const tool = {
            type: 'copilot',
            name: 'GitHub Copilot',
            version: null,
            path: null,
            isRunning: false,
            configPath: null,
            status: 'detected',
        };
        // Check for VS Code extensions directory
        const vscodeExtPaths = {
            windows: path.join(this.homeDir, '.vscode', 'extensions'),
            macos: path.join(this.homeDir, '.vscode', 'extensions'),
            linux: path.join(this.homeDir, '.vscode', 'extensions'),
        };
        const extensionsDir = vscodeExtPaths[this.platform];
        if (fs.existsSync(extensionsDir)) {
            try {
                const extensions = fs.readdirSync(extensionsDir);
                const copilotExt = extensions.find(ext => ext.toLowerCase().startsWith('github.copilot-') &&
                    !ext.includes('chat'));
                const copilotChatExt = extensions.find(ext => ext.toLowerCase().startsWith('github.copilot-chat'));
                if (copilotExt || copilotChatExt) {
                    tool.path = path.join(extensionsDir, copilotExt || copilotChatExt || '');
                    tool.configPath = extensionsDir;
                    // Extract version from folder name
                    const ext = copilotExt || copilotChatExt;
                    if (ext) {
                        const versionMatch = ext.match(/-(\d+\.\d+\.\d+)$/);
                        if (versionMatch) {
                            tool.version = versionMatch[1];
                        }
                    }
                    tool.status = 'configured';
                }
            }
            catch {
                // Couldn't read extensions directory
            }
        }
        // Check if VS Code is running (Copilot runs within VS Code)
        tool.isRunning = this.isProcessRunning('code') || this.isProcessRunning('Code');
        if (tool.isRunning && tool.path) {
            tool.status = 'running';
        }
        if (tool.path) {
            return tool;
        }
        return null;
    }
    /**
     * Detect Continue.dev (VS Code extension)
     */
    async detectContinue() {
        const tool = {
            type: 'continue',
            name: 'Continue.dev',
            version: null,
            path: null,
            isRunning: false,
            configPath: null,
            status: 'detected',
        };
        // Check for Continue config
        const continueConfigDir = path.join(this.homeDir, '.continue');
        if (fs.existsSync(continueConfigDir)) {
            tool.configPath = continueConfigDir;
            tool.status = 'configured';
        }
        // Check VS Code extensions
        const extensionsDir = path.join(this.homeDir, '.vscode', 'extensions');
        if (fs.existsSync(extensionsDir)) {
            try {
                const extensions = fs.readdirSync(extensionsDir);
                const continueExt = extensions.find(ext => ext.toLowerCase().startsWith('continue.continue'));
                if (continueExt) {
                    tool.path = path.join(extensionsDir, continueExt);
                    const versionMatch = continueExt.match(/-(\d+\.\d+\.\d+)$/);
                    if (versionMatch) {
                        tool.version = versionMatch[1];
                    }
                    tool.status = 'configured';
                }
            }
            catch {
                // Couldn't read extensions
            }
        }
        // Check if VS Code is running
        tool.isRunning = this.isProcessRunning('code') || this.isProcessRunning('Code');
        if (tool.isRunning && (tool.path || tool.configPath)) {
            tool.status = 'running';
        }
        if (tool.path || tool.configPath) {
            return tool;
        }
        return null;
    }
    /**
     * Find a command in PATH
     */
    findCommand(command) {
        try {
            const cmd = this.platform === 'windows' ? 'where' : 'which';
            const result = (0, child_process_1.execSync)(`${cmd} ${command}`, {
                encoding: 'utf8',
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
            return result.split('\n')[0] || null;
        }
        catch {
            return null;
        }
    }
    /**
     * Check if a process is running
     */
    isProcessRunning(processName) {
        try {
            let cmd;
            if (this.platform === 'windows') {
                cmd = `tasklist /FI "IMAGENAME eq ${processName}.exe" 2>NUL | find /I "${processName}"`;
            }
            else {
                cmd = `pgrep -x "${processName}" 2>/dev/null || pgrep -f "${processName}" 2>/dev/null`;
            }
            (0, child_process_1.execSync)(cmd, {
                encoding: 'utf8',
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Watch for tool status changes
     */
    watchToolStatus(callback, intervalMs = 5000) {
        let lastStatus = '';
        const checkStatus = async () => {
            const result = await this.detectAll();
            const currentStatus = JSON.stringify(result.tools.map(t => ({ type: t.type, status: t.status })));
            if (currentStatus !== lastStatus) {
                lastStatus = currentStatus;
                callback(result.tools);
            }
        };
        // Initial check
        checkStatus();
        // Set up interval
        const interval = setInterval(checkStatus, intervalMs);
        // Return cleanup function
        return () => clearInterval(interval);
    }
}
exports.toolDetector = new ToolDetector();
exports.default = exports.toolDetector;
//# sourceMappingURL=detector.js.map