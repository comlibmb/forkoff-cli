#!/usr/bin/env node
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const chalk_1 = __importDefault(require("chalk"));
const ora_1 = __importDefault(require("ora"));
const qrcode_terminal_1 = __importDefault(require("qrcode-terminal"));
const config_1 = require("./config");
const api_1 = require("./api");
const websocket_1 = require("./websocket");
const terminal_1 = require("./terminal");
const approval_1 = require("./approval");
const tools_1 = require("./tools");
const transcript_streamer_1 = require("./transcript-streamer");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const program = new commander_1.Command();
program
    .name('forkoff')
    .description('CLI tool for ForkOff - Connect your AI coding tools to mobile')
    .version('1.0.0');
// Configure API/WS URLs
program
    .command('config')
    .description('Configure ForkOff CLI settings')
    .option('-a, --api <url>', 'Set API URL')
    .option('-w, --ws <url>', 'Set WebSocket URL')
    .option('-n, --name <name>', 'Set device name')
    .option('--show', 'Show current configuration')
    .option('--reset', 'Reset all configuration')
    .action(async (options) => {
    if (options.reset) {
        config_1.config.reset();
        console.log(chalk_1.default.green('Configuration reset successfully'));
        return;
    }
    if (options.api) {
        config_1.config.apiUrl = options.api;
        console.log(chalk_1.default.green(`API URL set to: ${options.api}`));
    }
    if (options.ws) {
        config_1.config.wsUrl = options.ws;
        console.log(chalk_1.default.green(`WebSocket URL set to: ${options.ws}`));
    }
    if (options.name) {
        config_1.config.deviceName = options.name;
        console.log(chalk_1.default.green(`Device name set to: ${options.name}`));
    }
    if (options.show || (!options.api && !options.ws && !options.name && !options.reset)) {
        console.log(chalk_1.default.bold('\nCurrent Configuration:'));
        console.log(`  API URL:     ${chalk_1.default.cyan(config_1.config.apiUrl)}`);
        console.log(`  WebSocket:   ${chalk_1.default.cyan(config_1.config.wsUrl)}`);
        console.log(`  Device Name: ${chalk_1.default.cyan(config_1.config.deviceName)}`);
        console.log(`  Device ID:   ${chalk_1.default.cyan(config_1.config.deviceId || 'Not registered')}`);
        console.log(`  Paired:      ${config_1.config.isPaired ? chalk_1.default.green('Yes') : chalk_1.default.yellow('No')}`);
        console.log(`  Config Path: ${chalk_1.default.dim(config_1.config.getPath())}`);
    }
});
// Pair device with mobile app
program
    .command('pair')
    .description('Generate pairing code to connect with mobile app')
    .action(async () => {
    const spinner = (0, ora_1.default)('Connecting to ForkOff server...').start();
    try {
        // Check server health
        const isHealthy = await api_1.api.healthCheck();
        if (!isHealthy) {
            spinner.fail('Cannot connect to ForkOff server');
            console.log(chalk_1.default.yellow(`\nMake sure the server is running at ${config_1.config.apiUrl}`));
            console.log(chalk_1.default.dim('Use "forkoff config --api <url>" to change the server URL'));
            return;
        }
        spinner.text = 'Registering device...';
        // Register device or refresh pairing code
        let result;
        if (config_1.config.deviceId) {
            try {
                result = await api_1.api.refreshPairingCode(config_1.config.deviceId);
            }
            catch {
                // Device might not exist anymore, register fresh
                result = await api_1.api.registerDevice();
            }
        }
        else {
            result = await api_1.api.registerDevice();
        }
        // Save device info
        config_1.config.deviceId = result.device.id;
        config_1.config.pairingCode = result.pairingCode;
        spinner.succeed('Device registered successfully!\n');
        // Display pairing info
        console.log(chalk_1.default.bold('Scan this QR code with the ForkOff mobile app:\n'));
        // Generate QR code with pairing URL
        const pairingUrl = `forkoff://pair/${result.pairingCode}`;
        qrcode_terminal_1.default.generate(pairingUrl, { small: true }, (code) => {
            console.log(code);
        });
        console.log(chalk_1.default.bold('\nOr enter this code manually:\n'));
        console.log(chalk_1.default.bgBlue.white.bold(`  ${result.pairingCode}  `));
        console.log();
        const expiresAt = new Date(result.expiresAt);
        console.log(chalk_1.default.dim(`Code expires at: ${expiresAt.toLocaleTimeString()}`));
        console.log();
        // Wait for pairing
        console.log(chalk_1.default.yellow('Waiting for mobile app to scan...'));
        console.log(chalk_1.default.dim('Press Ctrl+C to cancel\n'));
        await waitForPairing(result.device.id);
        // Auto-connect after successful pairing
        await startConnection();
    }
    catch (error) {
        spinner.fail('Failed to register device');
        console.error(chalk_1.default.red(error.message || 'Unknown error'));
    }
});
// Check device status
program
    .command('status')
    .description('Check device connection status')
    .action(async () => {
    if (!config_1.config.deviceId) {
        console.log(chalk_1.default.yellow('Device not registered. Run "forkoff pair" first.'));
        return;
    }
    const spinner = (0, ora_1.default)('Checking status...').start();
    try {
        const status = await api_1.api.checkPairingStatus(config_1.config.deviceId);
        spinner.stop();
        console.log(chalk_1.default.bold('\nDevice Status:'));
        console.log(`  Device ID:   ${chalk_1.default.cyan(config_1.config.deviceId)}`);
        console.log(`  Device Name: ${chalk_1.default.cyan(config_1.config.deviceName)}`);
        console.log(`  Paired:      ${status.isPaired ? chalk_1.default.green('Yes') : chalk_1.default.yellow('No')}`);
        if (status.isPaired) {
            config_1.config.userId = status.userId;
            config_1.config.pairedAt = config_1.config.pairedAt || new Date().toISOString();
            console.log(`  User ID:     ${chalk_1.default.cyan(status.userId)}`);
        }
        if (websocket_1.wsClient.isConnected) {
            console.log(`  WebSocket:   ${chalk_1.default.green('Connected')}`);
        }
        else {
            console.log(`  WebSocket:   ${chalk_1.default.yellow('Disconnected')}`);
        }
    }
    catch (error) {
        spinner.fail('Failed to check status');
        console.error(chalk_1.default.red(error.message || 'Unknown error'));
    }
});
// Connect and stay online (for returning users who already paired)
program
    .command('connect')
    .description('Reconnect to ForkOff (for previously paired devices)')
    .action(async () => {
    if (!config_1.config.deviceId) {
        console.log(chalk_1.default.yellow('Device not registered. Run "forkoff pair" first.'));
        return;
    }
    if (!config_1.config.isPaired) {
        console.log(chalk_1.default.yellow('Device not paired. Run "forkoff pair" and scan the QR code.'));
        return;
    }
    await startConnection();
});
// Disconnect/unpair device
program
    .command('disconnect')
    .description('Disconnect and unpair device')
    .action(async () => {
    websocket_1.wsClient.disconnect();
    config_1.config.userId = null;
    config_1.config.pairedAt = null;
    config_1.config.pairingCode = null;
    console.log(chalk_1.default.green('Device disconnected and unpaired.'));
    console.log(chalk_1.default.dim('Run "forkoff pair" to pair again.'));
});
// Detect and manage AI coding tools
program
    .command('tools')
    .description('Detect and manage AI coding tools')
    .option('-d, --detect', 'Detect installed AI tools')
    .option('-i, --install-hooks', 'Install ForkOff hooks for Claude Code')
    .option('-u, --uninstall-hooks', 'Remove ForkOff hooks from Claude Code')
    .option('-w, --watch', 'Watch tool status changes')
    .action(async (options) => {
    if (options.installHooks) {
        const spinner = (0, ora_1.default)('Installing Claude Code hooks...').start();
        try {
            if (!tools_1.claudeHooksManager.canConfigure()) {
                spinner.fail('Claude Code not found');
                console.log(chalk_1.default.yellow('\nClaude Code must be installed to use hooks.'));
                console.log(chalk_1.default.dim('Install Claude Code from: https://claude.ai/download'));
                return;
            }
            await tools_1.claudeHooksManager.installHooks();
            spinner.succeed('Claude Code hooks installed!');
            console.log(chalk_1.default.green('\nForkOff will now receive events from Claude Code.'));
            console.log(chalk_1.default.dim('Run "forkoff connect" to start receiving events.'));
        }
        catch (error) {
            spinner.fail('Failed to install hooks');
            console.error(chalk_1.default.red(error.message));
        }
        return;
    }
    if (options.uninstallHooks) {
        const spinner = (0, ora_1.default)('Removing Claude Code hooks...').start();
        try {
            await tools_1.claudeHooksManager.uninstallHooks();
            spinner.succeed('Claude Code hooks removed!');
        }
        catch (error) {
            spinner.fail('Failed to remove hooks');
            console.error(chalk_1.default.red(error.message));
        }
        return;
    }
    if (options.watch) {
        console.log(chalk_1.default.bold('\nWatching for tool status changes...'));
        console.log(chalk_1.default.dim('Press Ctrl+C to stop\n'));
        tools_1.toolDetector.watchToolStatus((tools) => {
            console.log(chalk_1.default.cyan(`[${new Date().toLocaleTimeString()}] Tool status update:`));
            tools.forEach(tool => {
                const statusColor = tool.status === 'running' ? chalk_1.default.green :
                    tool.status === 'configured' ? chalk_1.default.yellow : chalk_1.default.dim;
                console.log(`  ${tool.name}: ${statusColor(tool.status)}`);
            });
            console.log();
        }, 3000);
        // Keep alive
        await new Promise(() => { });
        return;
    }
    // Default: detect tools
    const spinner = (0, ora_1.default)('Detecting AI coding tools...').start();
    try {
        const result = await tools_1.toolDetector.detectAll();
        spinner.stop();
        console.log(chalk_1.default.bold('\nDetected AI Coding Tools:\n'));
        if (result.tools.length === 0) {
            console.log(chalk_1.default.yellow('  No AI coding tools detected.'));
            console.log(chalk_1.default.dim('\n  Supported tools:'));
            console.log(chalk_1.default.dim('    - Claude Code (https://claude.ai/download)'));
            console.log(chalk_1.default.dim('    - Cursor (https://cursor.sh)'));
            console.log(chalk_1.default.dim('    - GitHub Copilot (VS Code extension)'));
            console.log(chalk_1.default.dim('    - Continue.dev (VS Code extension)'));
        }
        else {
            result.tools.forEach(tool => {
                const statusIcon = tool.status === 'running' ? chalk_1.default.green('●') :
                    tool.status === 'configured' ? chalk_1.default.yellow('○') :
                        chalk_1.default.dim('○');
                console.log(`  ${statusIcon} ${chalk_1.default.bold(tool.name)}`);
                console.log(`    Type:    ${chalk_1.default.cyan(tool.type)}`);
                if (tool.version) {
                    console.log(`    Version: ${chalk_1.default.dim(tool.version)}`);
                }
                if (tool.path) {
                    console.log(`    Path:    ${chalk_1.default.dim(tool.path)}`);
                }
                console.log(`    Status:  ${tool.status === 'running' ? chalk_1.default.green('Running') :
                    tool.status === 'configured' ? chalk_1.default.yellow('Configured') :
                        chalk_1.default.dim('Detected')}`);
                // Check if hooks are configured for Claude Code
                if (tool.type === 'claude-code') {
                    const hooksConfigured = tools_1.claudeHooksManager.isHookConfigured();
                    console.log(`    Hooks:   ${hooksConfigured ? chalk_1.default.green('Installed') : chalk_1.default.yellow('Not installed')}`);
                    if (!hooksConfigured) {
                        console.log(chalk_1.default.dim('             Run "forkoff tools --install-hooks" to enable'));
                    }
                }
                console.log();
            });
        }
        console.log(chalk_1.default.dim(`Platform: ${result.platform}`));
    }
    catch (error) {
        spinner.fail('Tool detection failed');
        console.error(chalk_1.default.red(error.message));
    }
});
// Helper function to start connection and set up event handlers
async function startConnection() {
    const spinner = (0, ora_1.default)('Connecting to ForkOff...').start();
    try {
        await websocket_1.wsClient.connect();
        spinner.succeed('Connected to ForkOff!\n');
        // Detect and report connected tools
        spinner.start('Detecting AI coding tools...');
        try {
            const toolResult = await tools_1.toolDetector.detectAll();
            if (toolResult.tools.length > 0) {
                const toolsToReport = toolResult.tools.map(tool => ({
                    type: tool.type,
                    name: tool.name,
                    version: tool.version || null,
                }));
                await api_1.api.reportConnectedTools(config_1.config.deviceId, toolsToReport);
                spinner.succeed(`Detected ${toolResult.tools.length} AI tool(s): ${toolResult.tools.map(t => t.name).join(', ')}`);
            }
            else {
                spinner.info('No AI coding tools detected');
            }
        }
        catch (toolError) {
            spinner.warn('Tool detection skipped: ' + (toolError.message || 'unknown error'));
        }
        console.log();
        console.log(chalk_1.default.green('Device is now online and ready to receive commands.'));
        console.log(chalk_1.default.dim('Press Ctrl+C to disconnect\n'));
        // Set up terminal output forwarding
        terminal_1.terminalManager.on('output', (data) => {
            websocket_1.wsClient.sendTerminalOutput(data);
        });
        terminal_1.terminalManager.on('cwd_changed', (data) => {
            websocket_1.wsClient.sendTerminalCwd(data);
        });
        // When a session is auto-created (command received before terminal_create), send the cwd
        terminal_1.terminalManager.on('session_created', (data) => {
            console.log(chalk_1.default.dim(`[Terminal] Session auto-created: ${data.terminalSessionId} at ${data.cwd}`));
            websocket_1.wsClient.sendTerminalCwd({
                terminalSessionId: data.terminalSessionId,
                cwd: data.cwd,
            });
        });
        // Set up terminal create handler
        websocket_1.wsClient.on('terminal_create', (data) => {
            console.log(chalk_1.default.blue(`[Terminal] Creating session: ${data.terminalSessionId}`));
            // Resolve the cwd (~ to home directory)
            let resolvedCwd = data.cwd || process.cwd();
            if (resolvedCwd === '~' || resolvedCwd.startsWith('~/')) {
                const homedir = require('os').homedir();
                resolvedCwd = resolvedCwd === '~' ? homedir : resolvedCwd.replace('~', homedir);
            }
            // Create the session
            const session = terminal_1.terminalManager.createSession(data.terminalSessionId, resolvedCwd);
            // Send back the resolved cwd
            websocket_1.wsClient.sendTerminalCwd({
                terminalSessionId: data.terminalSessionId,
                cwd: session.cwd,
            });
            console.log(chalk_1.default.dim(`[Terminal] Session created with cwd: ${session.cwd}`));
        });
        // Set up event handlers
        websocket_1.wsClient.on('terminal_command', async (data) => {
            // Check if this is a Claude terminal session
            if (tools_1.claudeProcessManager.isClaudeSession(data.terminalSessionId)) {
                console.log(chalk_1.default.cyan(`[Claude] Input: ${data.command.substring(0, 50)}${data.command.length > 50 ? '...' : ''}`));
                tools_1.claudeProcessManager.sendInput(data.terminalSessionId, data.command);
                return;
            }
            // Regular terminal command
            console.log(chalk_1.default.blue(`[Terminal] Executing: ${data.command}`));
            try {
                const result = await terminal_1.terminalManager.executeCommand(data.terminalSessionId, data.command);
                console.log(chalk_1.default.dim(`[Terminal] Exit code: ${result.exitCode}`));
            }
            catch (error) {
                console.error(chalk_1.default.red(`[Terminal] Error: ${error.message}`));
            }
        });
        websocket_1.wsClient.on('approval_response', (data) => {
            console.log(chalk_1.default.blue(`[Approval] ${data.status}: ${data.approvalId}`));
            approval_1.approvalManager.handleApprovalResponse(data.approvalId, data.status);
        });
        // Set up Claude session detection
        if (tools_1.claudeSessionDetector.isClaudeInstalled()) {
            console.log(chalk_1.default.cyan('[Claude] Scanning for Claude sessions...'));
            // Attach event listeners BEFORE starting to watch (so we catch initial events)
            tools_1.claudeSessionDetector.on('session_detected', (session) => {
                console.log(chalk_1.default.cyan(`[Claude] New session detected: ${session.directory}`));
                websocket_1.wsClient.sendClaudeSessionUpdate(session);
            });
            tools_1.claudeSessionDetector.on('session_changed', (session) => {
                console.log(chalk_1.default.dim(`[Claude] Session updated: ${session.directory} (${session.state})`));
                websocket_1.wsClient.sendClaudeSessionUpdate(session);
            });
            tools_1.claudeSessionDetector.on('claude_running_changed', (isRunning) => {
                console.log(chalk_1.default.cyan(`[Claude] Claude is now ${isRunning ? 'ACTIVE' : 'inactive'}`));
                websocket_1.wsClient.sendToolStatusUpdate('claude_code', isRunning ? 'active' : 'inactive');
            });
            // Scan and report existing sessions
            const sessions = tools_1.claudeSessionDetector.scanSessions();
            if (sessions.length > 0) {
                console.log(chalk_1.default.cyan(`[Claude] Found ${sessions.length} session(s)`));
                // Update session states based on file modification time before sending
                const now = Date.now();
                let hasActiveSession = false;
                for (const session of sessions) {
                    const sessionTime = new Date(session.lastUsedAt).getTime();
                    if (now - sessionTime < 60000) {
                        session.state = 'active';
                        hasActiveSession = true;
                    }
                }
                websocket_1.wsClient.sendClaudeSessions(sessions);
                if (hasActiveSession) {
                    console.log(chalk_1.default.cyan(`[Claude] Claude is now ACTIVE`));
                    websocket_1.wsClient.sendToolStatusUpdate('claude_code', 'active');
                }
            }
            // Start watching for session changes
            tools_1.claudeSessionDetector.startWatching(5000);
        }
        // Log approval events
        approval_1.approvalManager.on('approved', (approval) => {
            console.log(chalk_1.default.green(`[Approval] Approved: ${approval.description}`));
        });
        approval_1.approvalManager.on('rejected', (approval) => {
            console.log(chalk_1.default.red(`[Approval] Rejected: ${approval.description}`));
        });
        websocket_1.wsClient.on('git_clone', async (data) => {
            console.log(chalk_1.default.blue(`[Git] Clone request: ${data.repo.fullName}`));
            try {
                const result = await terminal_1.terminalManager.executeCommand(`git-clone-${Date.now()}`, data.command);
                console.log(chalk_1.default.green(`[Git] Clone completed with exit code: ${result.exitCode}`));
            }
            catch (error) {
                console.error(chalk_1.default.red(`[Git] Clone failed: ${error.message}`));
            }
        });
        // Handle Claude start session request from mobile
        websocket_1.wsClient.on('claude_start_session', async (data) => {
            console.log(chalk_1.default.cyan(`[Claude] Start session request: ${data.directory}`));
            try {
                const result = await tools_1.claudeProcessManager.startSession(data.directory, data.terminalSessionId);
                websocket_1.wsClient.sendToolStatusUpdate('claude_code', 'active');
                websocket_1.wsClient.sendTerminalCwd({ terminalSessionId: data.terminalSessionId, cwd: result.cwd });
                console.log(chalk_1.default.green(`[Claude] Session started: ${data.terminalSessionId}`));
            }
            catch (error) {
                console.error(chalk_1.default.red(`[Claude] Failed to start: ${error.message}`));
            }
        });
        // Handle Claude resume session request from mobile
        websocket_1.wsClient.on('claude_resume_session', async (data) => {
            console.log(chalk_1.default.cyan(`[Claude] Resume session request: ${data.sessionKey} in ${data.directory}`));
            try {
                const result = await tools_1.claudeProcessManager.resumeSession(data.sessionKey, data.directory, data.terminalSessionId);
                websocket_1.wsClient.sendToolStatusUpdate('claude_code', 'active');
                websocket_1.wsClient.sendClaudeSessionUpdate({
                    sessionKey: data.sessionKey,
                    directory: data.directory,
                    state: 'active',
                    lastUsedAt: new Date().toISOString(),
                });
                websocket_1.wsClient.sendTerminalCwd({ terminalSessionId: data.terminalSessionId, cwd: result.cwd });
                console.log(chalk_1.default.green(`[Claude] Session resumed: ${data.terminalSessionId}`));
            }
            catch (error) {
                console.error(chalk_1.default.red(`[Claude] Failed to resume: ${error.message}`));
            }
        });
        // Handle directory listing requests
        websocket_1.wsClient.on('directory_list', async (data) => {
            console.log(chalk_1.default.dim(`[Dir] Listing: ${data.path}`));
            try {
                let resolvedPath = data.path;
                if (resolvedPath === '~' || resolvedPath.startsWith('~/')) {
                    resolvedPath = resolvedPath === '~' ? os.homedir() : resolvedPath.replace('~', os.homedir());
                }
                const entries = fs.readdirSync(resolvedPath, { withFileTypes: true })
                    .filter(entry => !entry.name.startsWith('.'))
                    .map(entry => ({
                    name: entry.name,
                    type: entry.isDirectory() ? 'directory' : 'file',
                    path: path.join(resolvedPath, entry.name),
                }))
                    .sort((a, b) => {
                    if (a.type !== b.type)
                        return a.type === 'directory' ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });
                websocket_1.wsClient.sendDirectoryListResponse({ requestId: data.requestId, entries, currentPath: resolvedPath });
            }
            catch (error) {
                console.error(chalk_1.default.red(`[Dir] Error: ${error.message}`));
                websocket_1.wsClient.sendDirectoryListResponse({ requestId: data.requestId, entries: [], currentPath: data.path });
            }
        });
        // Handle transcript fetch requests from mobile
        websocket_1.wsClient.on('transcript_fetch', async (data) => {
            console.log(chalk_1.default.dim(`[Transcript] Fetching: ${data.sessionKey}, offset: ${data.offset}, limit: ${data.limit}, reverse: ${data.reverse}`));
            try {
                const result = await transcript_streamer_1.transcriptStreamer.fetchHistory(data.transcriptPath, data.offset || 0, data.limit || 100, data.reverse !== false // Default to true (most recent first)
                );
                websocket_1.wsClient.sendTranscriptHistory({
                    sessionKey: data.sessionKey,
                    ...result,
                    offset: data.offset || 0,
                });
            }
            catch (error) {
                console.error(chalk_1.default.red(`[Transcript] Error: ${error.message}`));
            }
        });
        // Handle transcript subscribe
        websocket_1.wsClient.on('transcript_subscribe', (data) => {
            console.log(chalk_1.default.dim(`[Transcript] Subscribing: ${data.sessionKey}`));
            transcript_streamer_1.transcriptStreamer.subscribeToUpdates(data.sessionKey, data.transcriptPath);
        });
        // Handle transcript unsubscribe
        websocket_1.wsClient.on('transcript_unsubscribe', (data) => {
            console.log(chalk_1.default.dim(`[Transcript] Unsubscribing: ${data.sessionKey}`));
            transcript_streamer_1.transcriptStreamer.unsubscribeFromUpdates(data.sessionKey);
        });
        // Handle claude sessions request - mobile app wants current sessions
        websocket_1.wsClient.on('claude_sessions_request', () => {
            console.log(chalk_1.default.cyan(`[Claude] Sessions requested by mobile`));
            if (tools_1.claudeSessionDetector.isClaudeInstalled()) {
                const sessions = tools_1.claudeSessionDetector.scanSessions();
                const now = Date.now();
                let hasActiveSession = false;
                // Update session states based on file modification time
                for (const session of sessions) {
                    const sessionTime = new Date(session.lastUsedAt).getTime();
                    if (now - sessionTime < 60000) {
                        session.state = 'active';
                        hasActiveSession = true;
                    }
                }
                // Send sessions
                if (sessions.length > 0) {
                    websocket_1.wsClient.sendClaudeSessions(sessions);
                }
                // Send tool status
                websocket_1.wsClient.sendToolStatusUpdate('claude_code', hasActiveSession ? 'active' : 'inactive');
            }
        });
        // Forward live transcript updates to WebSocket
        transcript_streamer_1.transcriptStreamer.on('update', (data) => {
            console.log(chalk_1.default.green(`[Transcript] Sending update for ${data.sessionKey}: ${data.entry?.type}`));
            websocket_1.wsClient.sendTranscriptUpdate(data);
        });
        // Forward Claude process output to WebSocket
        tools_1.claudeProcessManager.on('output', (data) => {
            websocket_1.wsClient.sendTerminalOutput(data);
        });
        // Handle Claude process end
        tools_1.claudeProcessManager.on('session_ended', (data) => {
            console.log(chalk_1.default.dim(`[Claude] Session ended: ${data.terminalSessionId}`));
            websocket_1.wsClient.sendToolStatusUpdate('claude_code', 'inactive');
            if (data.sessionKey) {
                websocket_1.wsClient.sendClaudeSessionUpdate({
                    sessionKey: data.sessionKey,
                    directory: data.directory,
                    state: 'inactive',
                    lastUsedAt: new Date().toISOString(),
                });
            }
        });
        websocket_1.wsClient.on('disconnected', (reason) => {
            console.log(chalk_1.default.yellow(`\nDisconnected: ${reason}`));
            if (reason !== 'io client disconnect') {
                console.log(chalk_1.default.dim('Attempting to reconnect...'));
            }
        });
        websocket_1.wsClient.on('error', (error) => {
            console.error(chalk_1.default.red(`Connection error: ${error.message}`));
        });
        // Keep the process running
        process.on('SIGINT', () => {
            console.log(chalk_1.default.yellow('\nDisconnecting...'));
            tools_1.claudeSessionDetector.stopWatching();
            transcript_streamer_1.transcriptStreamer.cleanup();
            websocket_1.wsClient.disconnect();
            process.exit(0);
        });
        // Keep alive
        await new Promise(() => { });
    }
    catch (error) {
        spinner.fail('Failed to connect');
        console.error(chalk_1.default.red(error.message || 'Unknown error'));
    }
}
// Helper function to wait for pairing
async function waitForPairing(deviceId) {
    return new Promise((resolve, reject) => {
        const checkInterval = setInterval(async () => {
            try {
                const status = await api_1.api.checkPairingStatus(deviceId);
                if (status.isPaired) {
                    clearInterval(checkInterval);
                    config_1.config.userId = status.userId;
                    config_1.config.pairedAt = new Date().toISOString();
                    console.log(chalk_1.default.green('\n✓ Device paired successfully!'));
                    console.log(chalk_1.default.dim('\nConnecting to receive commands...\n'));
                    // Auto-connect after successful pairing
                    resolve();
                }
            }
            catch (error) {
                // Continue waiting
            }
        }, 2000);
        // Handle Ctrl+C
        process.on('SIGINT', () => {
            clearInterval(checkInterval);
            console.log(chalk_1.default.yellow('\nPairing cancelled.'));
            process.exit(0);
        });
    });
}
// Run the CLI
program.parse();
//# sourceMappingURL=index.js.map