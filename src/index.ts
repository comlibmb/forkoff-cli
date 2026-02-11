#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import qrcode from 'qrcode-terminal';
import { config } from './config';
import { api } from './api';
import { wsClient } from './websocket';
import { terminalManager } from './terminal';
import { approvalManager } from './approval';
import { toolDetector, claudeHooksManager, claudeSessionDetector, claudeProcessManager, PermissionIpcManager } from './tools';
import { transcriptStreamer } from './transcript-streamer';
import { setQuiet, createSpinner } from './logger';
import { enableStartup, disableStartup, isStartupRegistered, getBinaryPath } from './startup';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const program = new Command();

program
  .name('forkoff')
  .description('CLI tool for ForkOff - Connect your AI coding tools to mobile')
  .version('1.0.0')
  .option('-q, --quiet', 'Suppress all output (for background operation)');

program.hook('preAction', () => {
  if (program.opts().quiet) {
    setQuiet(true);
  }
});

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
      config.reset();
      console.log(chalk.green('Configuration reset successfully'));
      return;
    }

    if (options.api) {
      config.apiUrl = options.api;
      console.log(chalk.green(`API URL set to: ${options.api}`));
    }

    if (options.ws) {
      config.wsUrl = options.ws;
      console.log(chalk.green(`WebSocket URL set to: ${options.ws}`));
    }

    if (options.name) {
      config.deviceName = options.name;
      console.log(chalk.green(`Device name set to: ${options.name}`));
    }

    if (options.show || (!options.api && !options.ws && !options.name && !options.reset)) {
      console.log(chalk.bold('\nCurrent Configuration:'));
      console.log(`  API URL:     ${chalk.cyan(config.apiUrl)}`);
      console.log(`  WebSocket:   ${chalk.cyan(config.wsUrl)}`);
      console.log(`  Device Name: ${chalk.cyan(config.deviceName)}`);
      console.log(`  Device ID:   ${chalk.cyan(config.deviceId || 'Not registered')}`);
      console.log(`  Paired:      ${config.isPaired ? chalk.green('Yes') : chalk.yellow('No')}`);
      console.log(`  Config Path: ${chalk.dim(config.getPath())}`);
      const startupStatus = config.startupEnabled === null
        ? chalk.dim('Not configured')
        : config.startupEnabled ? chalk.green('Enabled') : chalk.yellow('Disabled');
      console.log(`  Startup:     ${startupStatus}`);
    }
  });

// Pair device with mobile app
program
  .command('pair')
  .description('Generate pairing code to connect with mobile app')
  .action(async () => {
    const spinner = createSpinner('Connecting to ForkOff server...').start();

    try {
      // Check server health
      const isHealthy = await api.healthCheck();
      if (!isHealthy) {
        spinner.fail('Cannot connect to ForkOff server');
        console.log(chalk.yellow(`\nMake sure the server is running at ${config.apiUrl}`));
        console.log(chalk.dim('Use "forkoff config --api <url>" to change the server URL'));
        return;
      }

      spinner.text = 'Registering device...';

      // Register device or refresh pairing code
      let result;
      if (config.deviceId) {
        try {
          result = await api.refreshPairingCode(config.deviceId);
        } catch {
          // Device might not exist anymore, register fresh
          result = await api.registerDevice();
        }
      } else {
        result = await api.registerDevice();
      }

      // Save device info
      config.deviceId = result.device.id;
      config.pairingCode = result.pairingCode;

      spinner.succeed('Device registered successfully!\n');

      // Display pairing info
      console.log(chalk.bold('Scan this QR code with the ForkOff mobile app:\n'));

      // Generate QR code with pairing URL
      const pairingUrl = `forkoff://pair/${result.pairingCode}`;
      qrcode.generate(pairingUrl, { small: true }, (code) => {
        console.log(code);
      });

      console.log(chalk.bold('\nOr enter this code manually:\n'));
      console.log(chalk.bgBlue.white.bold(`  ${result.pairingCode}  `));
      console.log();

      const expiresAt = new Date(result.expiresAt);
      console.log(chalk.dim(`Code expires at: ${expiresAt.toLocaleTimeString()}`));
      console.log();

      // Wait for pairing
      console.log(chalk.yellow('Waiting for mobile app to scan...'));
      console.log(chalk.dim('Press Ctrl+C to cancel\n'));

      await waitForPairing(result.device.id);

      // Auto-register startup if not explicitly disabled
      if (config.startupEnabled !== false) {
        try {
          await enableStartup();
          console.log(chalk.green('Automatic startup registered. Use "forkoff startup --disable" to opt out.'));
        } catch {
          // Non-critical — don't fail pairing over this
        }
      }

      // Auto-connect after successful pairing
      await startConnection();
    } catch (error: any) {
      spinner.fail('Failed to register device');
      console.error(chalk.red(error.message || 'Unknown error'));
    }
  });

// Check device status
program
  .command('status')
  .description('Check device connection status')
  .action(async () => {
    if (!config.deviceId) {
      console.log(chalk.yellow('Device not registered. Run "forkoff pair" first.'));
      return;
    }

    const spinner = createSpinner('Checking status...').start();

    try {
      const status = await api.checkPairingStatus(config.deviceId);

      spinner.stop();

      console.log(chalk.bold('\nDevice Status:'));
      console.log(`  Device ID:   ${chalk.cyan(config.deviceId)}`);
      console.log(`  Device Name: ${chalk.cyan(config.deviceName)}`);
      console.log(`  Paired:      ${status.isPaired ? chalk.green('Yes') : chalk.yellow('No')}`);

      if (status.isPaired) {
        config.userId = status.userId;
        config.pairedAt = config.pairedAt || new Date().toISOString();
        console.log(`  User ID:     ${chalk.cyan(status.userId)}`);
      }

      if (wsClient.isConnected) {
        console.log(`  WebSocket:   ${chalk.green('Connected')}`);
      } else {
        console.log(`  WebSocket:   ${chalk.yellow('Disconnected')}`);
      }
    } catch (error: any) {
      spinner.fail('Failed to check status');
      console.error(chalk.red(error.message || 'Unknown error'));
    }
  });

// Connect and stay online (for returning users who already paired)
program
  .command('connect')
  .description('Reconnect to ForkOff (for previously paired devices)')
  .action(async () => {
    if (!config.deviceId) {
      console.log(chalk.yellow('Device not registered. Run "forkoff pair" first.'));
      return;
    }

    if (!config.isPaired) {
      console.log(chalk.yellow('Device not paired. Run "forkoff pair" and scan the QR code.'));
      return;
    }

    // Auto-register startup if not explicitly disabled and not already registered
    if (config.startupEnabled !== false && !isStartupRegistered()) {
      try {
        await enableStartup();
        console.log(chalk.green('Automatic startup registered. Use "forkoff startup --disable" to opt out.'));
      } catch {
        // Non-critical
      }
    }

    await startConnection();
  });

// Disconnect/unpair device
program
  .command('disconnect')
  .description('Disconnect and unpair device')
  .action(async () => {
    wsClient.disconnect();
    config.userId = null;
    config.pairedAt = null;
    config.pairingCode = null;

    console.log(chalk.green('Device disconnected and unpaired.'));
    console.log(chalk.dim('Run "forkoff pair" to pair again.'));
  });

// Manage startup registration
program
  .command('startup')
  .description('Manage automatic startup on login')
  .option('--enable', 'Enable automatic startup')
  .option('--disable', 'Disable automatic startup')
  .option('--status', 'Show startup status (default)')
  .action(async (options) => {
    if (options.enable) {
      try {
        await enableStartup();
        console.log(chalk.green('Automatic startup enabled.'));
        console.log(chalk.dim(`Binary: ${getBinaryPath()}`));
        console.log(chalk.dim('ForkOff will connect automatically when you log in.'));
      } catch (error: any) {
        console.error(chalk.red(`Failed to enable startup: ${error.message}`));
      }
      return;
    }

    if (options.disable) {
      try {
        await disableStartup();
        console.log(chalk.green('Automatic startup disabled.'));
        console.log(chalk.dim('ForkOff will no longer start on login.'));
      } catch (error: any) {
        console.error(chalk.red(`Failed to disable startup: ${error.message}`));
      }
      return;
    }

    // Default: show status
    const registered = isStartupRegistered();
    const configState = config.startupEnabled;

    console.log(chalk.bold('\nStartup Status:'));
    console.log(`  OS Registration: ${registered ? chalk.green('Registered') : chalk.yellow('Not registered')}`);
    console.log(`  Config State:    ${
      configState === null ? chalk.dim('Not configured') :
      configState ? chalk.green('Enabled') : chalk.yellow('Disabled')
    }`);
    try {
      console.log(`  Binary Path:     ${chalk.dim(getBinaryPath())}`);
    } catch {
      console.log(`  Binary Path:     ${chalk.red('Not found')}`);
    }
    console.log(`  Platform:        ${chalk.dim(process.platform)}`);
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
      const spinner = createSpinner('Installing Claude Code hooks...').start();
      try {
        if (!claudeHooksManager.canConfigure()) {
          spinner.fail('Claude Code not found');
          console.log(chalk.yellow('\nClaude Code must be installed to use hooks.'));
          console.log(chalk.dim('Install Claude Code from: https://claude.ai/download'));
          return;
        }

        await claudeHooksManager.installHooks();
        spinner.succeed('Claude Code hooks installed!');
        console.log(chalk.green('\nForkOff will now receive events from Claude Code.'));
        console.log(chalk.dim('Run "forkoff connect" to start receiving events.'));
      } catch (error: any) {
        spinner.fail('Failed to install hooks');
        console.error(chalk.red(error.message));
      }
      return;
    }

    if (options.uninstallHooks) {
      const spinner = createSpinner('Removing Claude Code hooks...').start();
      try {
        await claudeHooksManager.uninstallHooks();
        spinner.succeed('Claude Code hooks removed!');
      } catch (error: any) {
        spinner.fail('Failed to remove hooks');
        console.error(chalk.red(error.message));
      }
      return;
    }

    if (options.watch) {
      console.log(chalk.bold('\nWatching for tool status changes...'));
      console.log(chalk.dim('Press Ctrl+C to stop\n'));

      toolDetector.watchToolStatus((tools) => {
        console.log(chalk.cyan(`[${new Date().toLocaleTimeString()}] Tool status update:`));
        tools.forEach(tool => {
          const statusColor = tool.status === 'running' ? chalk.green :
                             tool.status === 'configured' ? chalk.yellow : chalk.dim;
          console.log(`  ${tool.name}: ${statusColor(tool.status)}`);
        });
        console.log();
      }, 3000);

      // Keep alive
      await new Promise(() => {});
      return;
    }

    // Default: detect tools
    const spinner = createSpinner('Detecting AI coding tools...').start();

    try {
      const result = await toolDetector.detectAll();
      spinner.stop();

      console.log(chalk.bold('\nDetected AI Coding Tools:\n'));

      if (result.tools.length === 0) {
        console.log(chalk.yellow('  No AI coding tools detected.'));
        console.log(chalk.dim('\n  Supported tools:'));
        console.log(chalk.dim('    - Claude Code (https://claude.ai/download)'));
        console.log(chalk.dim('    - Cursor (https://cursor.sh)'));
        console.log(chalk.dim('    - GitHub Copilot (VS Code extension)'));
        console.log(chalk.dim('    - Continue.dev (VS Code extension)'));
      } else {
        result.tools.forEach(tool => {
          const statusIcon = tool.status === 'running' ? chalk.green('●') :
                            tool.status === 'configured' ? chalk.yellow('○') :
                            chalk.dim('○');

          console.log(`  ${statusIcon} ${chalk.bold(tool.name)}`);
          console.log(`    Type:    ${chalk.cyan(tool.type)}`);
          if (tool.version) {
            console.log(`    Version: ${chalk.dim(tool.version)}`);
          }
          if (tool.path) {
            console.log(`    Path:    ${chalk.dim(tool.path)}`);
          }
          console.log(`    Status:  ${
            tool.status === 'running' ? chalk.green('Running') :
            tool.status === 'configured' ? chalk.yellow('Configured') :
            chalk.dim('Detected')
          }`);

          // Check if hooks are configured for Claude Code
          if (tool.type === 'claude-code') {
            const hooksConfigured = claudeHooksManager.isHookConfigured();
            console.log(`    Hooks:   ${
              hooksConfigured ? chalk.green('Installed') : chalk.yellow('Not installed')
            }`);
            if (!hooksConfigured) {
              console.log(chalk.dim('             Run "forkoff tools --install-hooks" to enable'));
            }
          }
          console.log();
        });
      }

      console.log(chalk.dim(`Platform: ${result.platform}`));
    } catch (error: any) {
      spinner.fail('Tool detection failed');
      console.error(chalk.red(error.message));
    }
  });

// Helper function to start connection and set up event handlers
async function startConnection(): Promise<void> {
  const spinner = createSpinner('Connecting to ForkOff...').start();

  try {
    await wsClient.connect();
    PermissionIpcManager.cleanupStaleTempFiles();
    spinner.succeed('Connected to ForkOff!\n');

    // Detect and report connected tools
    spinner.start('Detecting AI coding tools...');
    try {
      const toolResult = await toolDetector.detectAll();
      if (toolResult.tools.length > 0) {
        const toolsToReport = toolResult.tools.map(tool => ({
          type: tool.type,
          name: tool.name,
          version: tool.version || null,
        }));

        await api.reportConnectedTools(config.deviceId!, toolsToReport);
        spinner.succeed(`Detected ${toolResult.tools.length} AI tool(s): ${toolResult.tools.map(t => t.name).join(', ')}`);
      } else {
        spinner.info('No AI coding tools detected');
      }
    } catch (toolError: any) {
      spinner.warn('Tool detection skipped: ' + (toolError.message || 'unknown error'));
    }

    console.log();
    console.log(chalk.green('Device is now online and ready to receive commands.'));
    console.log(chalk.dim('Press Ctrl+C to disconnect\n'));

    // Set up terminal output forwarding
    terminalManager.on('output', (data) => {
      wsClient.sendTerminalOutput(data);
    });

    terminalManager.on('cwd_changed', (data) => {
      wsClient.sendTerminalCwd(data);
    });

    // When a session is auto-created (command received before terminal_create), send the cwd
    terminalManager.on('session_created', (data) => {
      console.log(chalk.dim(`[Terminal] Session auto-created: ${data.terminalSessionId} at ${data.cwd}`));
      wsClient.sendTerminalCwd({
        terminalSessionId: data.terminalSessionId,
        cwd: data.cwd,
      });
    });

    // Set up terminal create handler
    wsClient.on('terminal_create', (data: any) => {
      console.log(chalk.blue(`[Terminal] Creating session: ${data.terminalSessionId}`));

      // Resolve the cwd (~ to home directory)
      let resolvedCwd = data.cwd || process.cwd();
      if (resolvedCwd === '~' || resolvedCwd.startsWith('~/')) {
        const homedir = require('os').homedir();
        resolvedCwd = resolvedCwd === '~' ? homedir : resolvedCwd.replace('~', homedir);
      }

      // Create the session
      const session = terminalManager.createSession(data.terminalSessionId, resolvedCwd);

      // Send back the resolved cwd
      wsClient.sendTerminalCwd({
        terminalSessionId: data.terminalSessionId,
        cwd: session.cwd,
      });

      console.log(chalk.dim(`[Terminal] Session created with cwd: ${session.cwd}`));
    });

    // Set up event handlers
    wsClient.on('terminal_command', async (data) => {
      // Check if this is a Claude terminal session
      if (claudeProcessManager.isClaudeSession(data.terminalSessionId)) {
        // SECURITY: Don't log command content - may contain sensitive data
        console.log(chalk.cyan(`[Claude] Input received (${data.command.length} chars)`));
        await claudeProcessManager.sendInput(data.terminalSessionId, data.command);
        return;
      }

      // Regular terminal command
      // SECURITY: Don't log command content - may contain passwords, API keys, etc.
      console.log(chalk.blue(`[Terminal] Executing command (${data.command.length} chars)`));
      try {
        const result = await terminalManager.executeCommand(
          data.terminalSessionId,
          data.command
        );
        console.log(chalk.dim(`[Terminal] Exit code: ${result.exitCode}`));
      } catch (error: any) {
        console.error(chalk.red(`[Terminal] Error: ${error.message}`));
      }
    });

    wsClient.on('approval_response', (data) => {
      console.log(chalk.blue(`[Approval] ${data.status}: ${data.approvalId}`));
      approvalManager.handleApprovalResponse(data.approvalId, data.status);
    });

    // Set up Claude session detection
    if (claudeSessionDetector.isClaudeInstalled()) {
      console.log(chalk.cyan('[Claude] Scanning for Claude sessions...'));

      // Attach event listeners BEFORE starting to watch (so we catch initial events)
      claudeSessionDetector.on('session_detected', (session) => {
        console.log(chalk.cyan(`[Claude] New session detected: ${session.directory}`));
        wsClient.sendClaudeSessionUpdate(session);
      });

      claudeSessionDetector.on('session_changed', (session) => {
        console.log(chalk.dim(`[Claude] Session updated: ${session.directory} (${session.state})`));
        wsClient.sendClaudeSessionUpdate(session);
      });

      claudeSessionDetector.on('claude_running_changed', (isRunning) => {
        console.log(chalk.cyan(`[Claude] Claude is now ${isRunning ? 'ACTIVE' : 'inactive'}`));
        wsClient.sendToolStatusUpdate('claude_code', isRunning ? 'active' : 'inactive');
      });

      // Scan and report existing sessions
      const sessions = claudeSessionDetector.scanSessions();
      if (sessions.length > 0) {
        console.log(chalk.cyan(`[Claude] Found ${sessions.length} session(s)`));

        // Update session states based on file modification time before sending
        const now = Date.now();
        let hasActiveSession = false;
        for (const session of sessions) {
          const sessionTime = new Date(session.lastUsedAt).getTime();
          if (now - sessionTime < 60000) {
            session.state = 'active';
            session.lastUsedAt = new Date().toISOString(); // Update to NOW for active sessions
            hasActiveSession = true;
          }
        }

        wsClient.sendClaudeSessions(sessions);

        if (hasActiveSession) {
          console.log(chalk.cyan(`[Claude] Claude is now ACTIVE`));
          wsClient.sendToolStatusUpdate('claude_code', 'active');
        }
      }

      // Start watching for session changes
      claudeSessionDetector.startWatching(5000);
    }

    // Log approval events
    approvalManager.on('approved', (approval) => {
      console.log(chalk.green(`[Approval] Approved: ${approval.description}`));
    });

    approvalManager.on('rejected', (approval) => {
      console.log(chalk.red(`[Approval] Rejected: ${approval.description}`));
    });

    wsClient.on('git_clone', async (data) => {
      console.log(chalk.blue(`[Git] Clone request: ${data.repo.fullName}`));
      try {
        const result = await terminalManager.executeCommand(
          `git-clone-${Date.now()}`,
          data.command
        );
        console.log(chalk.green(`[Git] Clone completed with exit code: ${result.exitCode}`));
      } catch (error: any) {
        console.error(chalk.red(`[Git] Clone failed: ${error.message}`));
      }
    });

    // Handle Claude start session request from mobile
    wsClient.on('claude_start_session', async (data: any) => {
      console.log(chalk.cyan(`[Claude] Start session request: ${data.directory}`));
      try {
        const result = await claudeProcessManager.startSession(data.directory, data.terminalSessionId, data.dangerouslySkipPermissions, data.interactivePermissions);

        wsClient.sendToolStatusUpdate('claude_code', 'active');
        wsClient.sendTerminalCwd({ terminalSessionId: data.terminalSessionId, cwd: result.cwd });

        // Notify mobile that the session is ready for input
        wsClient.sendClaudeSessionEvent({
          sessionKey: data.terminalSessionId,
          event: { type: 'ready' },
        });

        console.log(chalk.green(`[Claude] Session started: ${data.terminalSessionId}`));
      } catch (error: any) {
        console.error(chalk.red(`[Claude] Failed to start: ${error.message}`));
      }
    });

    // Handle Claude resume session request from mobile
    // NOTE: This is called when mobile opens a session view - we DON'T spawn Claude here
    // Claude is only spawned when the user actually sends a message (via user_message event)
    // This prevents duplicate transcript entries from double spawns
    wsClient.on('claude_resume_session', async (data: any) => {
      console.log(chalk.cyan(`[Claude] Resume session request: ${data.sessionKey} in ${data.directory}`));

      // Look up the correct directory from our locally scanned sessions
      // The mobile app may have a cached/stale directory (e.g. with corrupted hyphens)
      let resolvedDir = data.directory;
      const knownSession = claudeSessionDetector.getSessions().find(s => s.sessionKey === data.sessionKey);
      if (knownSession && knownSession.directory) {
        console.log(chalk.dim(`[Claude] Using local directory for session: ${knownSession.directory}`));
        resolvedDir = knownSession.directory;
      }

      if (resolvedDir === '~' || resolvedDir.startsWith('~/')) {
        resolvedDir = resolvedDir === '~' ? os.homedir() : resolvedDir.replace('~', os.homedir());
      }
      resolvedDir = path.resolve(resolvedDir);

      // Always register the session — even if it's running in a terminal.
      // With --resume, we spawn a new process per turn which picks up where the session left off.
      // If the terminal session holds a file lock, the spawn will fail gracefully.
      claudeProcessManager.registerSession(data.sessionKey, resolvedDir, data.terminalSessionId, data.dangerouslySkipPermissions, data.interactivePermissions);
      claudeProcessManager.markTakenOver(data.terminalSessionId);

      wsClient.sendToolStatusUpdate('claude_code', 'active');
      wsClient.sendClaudeSessionUpdate({
        sessionKey: data.sessionKey,
        directory: data.directory,
        state: 'active',
        lastUsedAt: new Date().toISOString(),
      });
      wsClient.sendTerminalCwd({ terminalSessionId: data.terminalSessionId, cwd: resolvedDir });

      // Notify mobile that the session is ready for input
      wsClient.sendClaudeSessionEvent({
        sessionKey: data.sessionKey,
        event: { type: 'ready' },
      });

      console.log(chalk.green(`[Claude] Session ready (will spawn on first message): ${data.sessionKey}`));
    });

    // Handle directory listing requests
    wsClient.on('directory_list', async (data: any) => {
      console.log(chalk.dim(`[Dir] Listing request received`));
      try {
        let resolvedPath = data.path;
        if (resolvedPath === '~' || resolvedPath.startsWith('~/')) {
          resolvedPath = resolvedPath === '~' ? os.homedir() : resolvedPath.replace('~', os.homedir());
        }

        // SECURITY: Normalize and validate path to prevent traversal attacks
        resolvedPath = path.resolve(resolvedPath);
        const homeDir = os.homedir();

        // SECURITY: Only allow access to directories under home directory
        // This prevents accessing sensitive system files like /etc/passwd
        if (!resolvedPath.startsWith(homeDir)) {
          console.warn(chalk.yellow(`[Dir] Access denied - path outside home directory: ${resolvedPath}`));
          wsClient.sendDirectoryListResponse({ requestId: data.requestId, entries: [], currentPath: data.path });
          return;
        }

        const entries = fs.readdirSync(resolvedPath, { withFileTypes: true })
          .filter(entry => !entry.name.startsWith('.'))
          .map(entry => ({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' as const : 'file' as const,
            path: path.join(resolvedPath, entry.name),
          }))
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
            return a.name.localeCompare(b.name);
          });

        wsClient.sendDirectoryListResponse({ requestId: data.requestId, entries, currentPath: resolvedPath });
      } catch (error: any) {
        console.error(chalk.red(`[Dir] Error: ${error.message}`));
        wsClient.sendDirectoryListResponse({ requestId: data.requestId, entries: [], currentPath: data.path });
      }
    });

    // Handle read file requests from mobile (e.g., CLAUDE.md)
    wsClient.on('read_file', async (data: any) => {
      console.log(chalk.dim(`[File] Read request: ${data.filePath}`));
      try {
        // SECURITY: Whitelist of allowed filenames
        const allowedFiles = ['CLAUDE.md', 'README.md', 'package.json'];
        const fileName = path.basename(data.filePath);

        if (!allowedFiles.includes(fileName)) {
          console.warn(chalk.yellow(`[File] Access denied - file not in whitelist: ${fileName}`));
          wsClient.sendReadFileResponse({
            requestId: data.requestId,
            exists: false,
            fileName,
            error: 'File not allowed',
          });
          return;
        }

        // Resolve path
        let resolvedPath = data.filePath;
        if (resolvedPath === '~' || resolvedPath.startsWith('~/')) {
          resolvedPath = resolvedPath === '~' ? os.homedir() : resolvedPath.replace('~', os.homedir());
        }
        resolvedPath = path.resolve(resolvedPath);

        // SECURITY: Only allow access under home directory
        const homeDir = os.homedir();
        if (!resolvedPath.startsWith(homeDir)) {
          console.warn(chalk.yellow(`[File] Access denied - path outside home directory: ${resolvedPath}`));
          wsClient.sendReadFileResponse({
            requestId: data.requestId,
            exists: false,
            fileName,
            error: 'Path outside home directory',
          });
          return;
        }

        // Check if file exists
        if (!fs.existsSync(resolvedPath)) {
          wsClient.sendReadFileResponse({
            requestId: data.requestId,
            exists: false,
            fileName,
          });
          return;
        }

        // SECURITY: Check file size (max 100KB)
        const stats = fs.statSync(resolvedPath);
        if (stats.size > 100 * 1024) {
          wsClient.sendReadFileResponse({
            requestId: data.requestId,
            exists: true,
            fileName,
            error: 'File too large (max 100KB)',
          });
          return;
        }

        const content = fs.readFileSync(resolvedPath, 'utf-8');
        wsClient.sendReadFileResponse({
          requestId: data.requestId,
          content,
          exists: true,
          fileName,
        });
      } catch (error: any) {
        console.error(chalk.red(`[File] Error: ${error.message}`));
        wsClient.sendReadFileResponse({
          requestId: data.requestId,
          exists: false,
          fileName: path.basename(data.filePath),
          error: error.message,
        });
      }
    });

    // Handle transcript fetch requests from mobile
    wsClient.on('transcript_fetch', async (data: any) => {
      console.log(chalk.dim(`[Transcript] Fetching: ${data.sessionKey}, offset: ${data.offset}, limit: ${data.limit}, reverse: ${data.reverse}`));
      try {
        const result = await transcriptStreamer.fetchHistory(
          data.transcriptPath,
          data.offset || 0,
          data.limit || 100,
          data.reverse !== false // Default to true (most recent first)
        );
        wsClient.sendTranscriptHistory({
          sessionKey: data.sessionKey,
          ...result,
          offset: data.offset || 0,
        });
      } catch (error: any) {
        console.error(chalk.red(`[Transcript] Error: ${error.message}`));
      }
    });

    // Handle transcript subscribe
    wsClient.on('transcript_subscribe', (data: any) => {
      console.log(chalk.dim(`[Transcript] Subscribing: ${data.sessionKey}`));
      transcriptStreamer.subscribeToUpdates(data.sessionKey, data.transcriptPath);
    });

    // Handle transcript unsubscribe
    wsClient.on('transcript_unsubscribe', (data: any) => {
      console.log(chalk.dim(`[Transcript] Unsubscribing: ${data.sessionKey}`));
      transcriptStreamer.unsubscribeFromUpdates(data.sessionKey);
    });

    // Handle SDK subscribe start - mobile wants live updates for a session
    // This is sent by API when mobile uses transcript_subscribe_sdk
    wsClient.on('transcript_subscribe_sdk_start', async (data: any) => {
      console.log(chalk.cyan(`[Transcript] SDK subscribe start: ${data.sessionKey}`));

      // Find the transcript file for this session
      const sessions = claudeSessionDetector.scanSessions();
      const session = sessions.find(s => s.sessionKey === data.sessionKey);

      if (session?.transcriptPath) {
        console.log(chalk.dim(`[Transcript] Starting watch for: ${session.transcriptPath}`));
        transcriptStreamer.subscribeToUpdates(data.sessionKey, session.transcriptPath);
      } else {
        console.log(chalk.yellow(`[Transcript] No transcript found for session: ${data.sessionKey}`));
      }
    });

    // Handle claude sessions request - mobile app wants current sessions
    wsClient.on('claude_sessions_request', () => {
      console.log(chalk.cyan(`[Claude] Sessions requested by mobile`));
      if (claudeSessionDetector.isClaudeInstalled()) {
        const sessions = claudeSessionDetector.scanSessions();
        const now = Date.now();
        let hasActiveSession = false;

        // Update session states based on file modification time
        for (const session of sessions) {
          const sessionTime = new Date(session.lastUsedAt).getTime();
          if (now - sessionTime < 60000) {
            session.state = 'active';
            session.lastUsedAt = new Date().toISOString(); // Update to NOW for active sessions
            hasActiveSession = true;
          }
        }

        // Send sessions
        if (sessions.length > 0) {
          wsClient.sendClaudeSessions(sessions);
        }

        // Send tool status
        wsClient.sendToolStatusUpdate('claude_code', hasActiveSession ? 'active' : 'inactive');
      }
    });

    // Handle RPC requests from the API gateway
    wsClient.on('rpc_request', async (data: { requestId: string; method: string; params: any }) => {
      console.log(chalk.cyan(`[RPC] Request: ${data.method}, requestId: ${data.requestId}`));

      try {
        if (data.method === 'get_session_history') {
          const { claudeSessionId, sessionKey, limit = 400, offset = 0 } = data.params;
          console.log(chalk.dim(`[RPC] get_session_history request received`));

          // Find the transcript file
          let transcriptPath: string | undefined;

          // If claudeSessionId is provided, search for the JSONL file directly
          if (claudeSessionId) {
            // SECURITY: Validate claudeSessionId to prevent path traversal
            // Session IDs should be alphanumeric with hyphens/underscores only
            const sessionIdRegex = /^[a-zA-Z0-9_-]+$/;
            if (!sessionIdRegex.test(claudeSessionId)) {
              console.warn(chalk.yellow(`[RPC] Invalid claudeSessionId format - rejected`));
              wsClient.sendRpcResponse({
                requestId: data.requestId,
                error: { code: -32602, message: 'Invalid session ID format' }
              });
              return;
            }

            const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
            if (fs.existsSync(claudeProjectsDir)) {
              const projectDirs = fs.readdirSync(claudeProjectsDir);
              for (const projectDir of projectDirs) {
                // SECURITY: Validate projectDir as well to prevent traversal
                if (!sessionIdRegex.test(projectDir) && !/^[a-zA-Z0-9_.-]+$/.test(projectDir)) {
                  continue;
                }
                const potentialPath = path.join(claudeProjectsDir, projectDir, `${claudeSessionId}.jsonl`);
                // SECURITY: Verify the resolved path is still under claudeProjectsDir
                const resolvedPotentialPath = path.resolve(potentialPath);
                if (!resolvedPotentialPath.startsWith(claudeProjectsDir)) {
                  continue;
                }
                if (fs.existsSync(potentialPath)) {
                  transcriptPath = potentialPath;
                  console.log(chalk.dim(`[RPC] Found JSONL transcript`));
                  break;
                }
              }
            }
          }

          // If not found by claudeSessionId, search all sessions
          if (!transcriptPath && claudeSessionDetector.isClaudeInstalled()) {
            const sessions = claudeSessionDetector.scanSessions();

            // First try to match by sessionKey
            let session = sessions.find(s => s.sessionKey === sessionKey);

            // If no match by sessionKey, try to find most recent session for the same directory
            if (!session && sessions.length > 0) {
              // Just use the most recent session as fallback
              session = sessions[0];
              console.log(chalk.dim(`[RPC] Using most recent session as fallback: ${session.sessionKey}`));
            }

            if (session?.transcriptPath) {
              transcriptPath = session.transcriptPath;
              console.log(chalk.dim(`[RPC] Found transcript path: ${transcriptPath}`));
            }
          }

          if (!transcriptPath || !fs.existsSync(transcriptPath)) {
            console.log(chalk.yellow(`[RPC] No transcript file found for session`));
            wsClient.sendRpcResponse({
              requestId: data.requestId,
              result: { entries: [], totalEntries: 0, hasMore: false }
            });
            return;
          }

          // Read the transcript file
          const result = await transcriptStreamer.fetchHistory(transcriptPath, offset, limit, true);
          console.log(chalk.green(`[RPC] Loaded ${result.entries.length} entries from transcript`));

          // IMPORTANT: Start watching this transcript for live updates
          // This is needed because SDK mode doesn't send transcript_subscribe
          // Use sessionKey from mobile for updates (must match what mobile is listening for)
          const updateSessionKey = sessionKey;
          if (!updateSessionKey) {
            console.log(chalk.yellow(`[RPC] No sessionKey provided, using claudeSessionId - updates may not route correctly`));
          }
          const watchKey = updateSessionKey || claudeSessionId || data.requestId;
          console.log(chalk.cyan(`[RPC] Starting file watch for live updates: ${watchKey}`));
          transcriptStreamer.subscribeToUpdates(watchKey, transcriptPath);

          wsClient.sendRpcResponse({
            requestId: data.requestId,
            result: {
              entries: result.entries,
              totalEntries: result.totalEntries,
              hasMore: result.hasMore,
              sessionKey: watchKey, // Tell mobile which sessionKey to listen for updates
            }
          });
        } else {
          console.log(chalk.yellow(`[RPC] Unknown method: ${data.method}`));
          wsClient.sendRpcResponse({
            requestId: data.requestId,
            error: { code: -32601, message: `Method not found: ${data.method}` }
          });
        }
      } catch (error: any) {
        console.error(chalk.red(`[RPC] Error handling ${data.method}:`, error.message));
        wsClient.sendRpcResponse({
          requestId: data.requestId,
          error: { code: -32603, message: error.message || 'Internal error' }
        });
      }
    });

    // Forward live transcript updates to WebSocket
    transcriptStreamer.on('update', (data: any) => {
      console.log(chalk.green(`[Transcript] Sending update for ${data.sessionKey}: ${data.entry?.type}`));
      wsClient.sendTranscriptUpdate(data);

      // Also update session lastUsedAt to keep it fresh
      // Find the session to get the directory
      const sessions = claudeSessionDetector.getSessions();
      const session = sessions.find(s => s.sessionKey === data.sessionKey);
      if (session) {
        wsClient.sendClaudeSessionUpdate({
          sessionKey: data.sessionKey,
          directory: session.directory,
          state: 'active',
          lastUsedAt: new Date().toISOString(),
          transcriptPath: session.transcriptPath,
        });
      }
    });

    // Forward Claude process output to WebSocket
    claudeProcessManager.on('output', (data: any) => {
      wsClient.sendTerminalOutput(data);
    });

    // Forward Claude approval requests to WebSocket (mobile approval)
    claudeProcessManager.on('claude_approval_request', (data: any) => {
      console.log(chalk.yellow(`[Claude] Approval request: ${data.approvalId}`));
      wsClient.sendClaudeApprovalRequest(data);
    });

    // Forward tool activity events to mobile (non-blocking notifications)
    claudeProcessManager.on('tool_activity', (data: any) => {
      console.log(chalk.dim(`[Claude] Tool activity: ${data.toolName} - ${data.inputSummary?.substring(0, 60)}`));
      wsClient.sendToolActivity(data);
    });

    // Forward permission prompts from hook system to mobile (interactive approval)
    // Only forward if the session is taken over; otherwise auto-allow so Claude doesn't hang
    claudeProcessManager.on('permission_prompt', (data: any) => {
      if (!claudeProcessManager.isTakenOver(data.terminalSessionId)) {
        console.log(chalk.dim(`[Claude] Permission prompt auto-allowed (watch-only): ${data.toolName} (${data.promptId})`));
        claudeProcessManager.handlePermissionResponse(data.promptId, 'allow', 'Auto-allowed: session not taken over');
        return;
      }
      console.log(chalk.yellow(`[Claude] Permission prompt: ${data.toolName} (${data.promptId})`));
      wsClient.sendPermissionPrompt(data);
    });

    // Handle permission responses from mobile → route back to hook IPC
    wsClient.on('permission_response', (data: any) => {
      console.log(chalk.green(`[Claude] Permission response: ${data.promptId} -> ${data.decision}`));
      claudeProcessManager.handlePermissionResponse(data.promptId, data.decision, data.reason);
    });

    // Handle mobile disconnect — full reset: clear taken-over, auto-allow pending, tear down hooks
    wsClient.on('mobile_disconnected', () => {
      console.log(chalk.yellow(`[Claude] Mobile disconnected — full permission reset`));
      claudeProcessManager.clearAllTakenOver();
      claudeProcessManager.autoAllowAllPendingPrompts();
      claudeProcessManager.cleanupAllPermissionState();
    });

    // Handle Claude approval responses from mobile
    wsClient.on('claude_approval_response', (data: any) => {
      console.log(chalk.green(`[Claude] Approval response: ${data.approvalId} -> ${data.response}`));
      claudeProcessManager.handleApprovalResponse(data.approvalId, data.response);
    });

    // Handle user messages from mobile app (send to Claude session)
    wsClient.on('user_message', async (data: any) => {
      // SECURITY: Don't log message content - may contain sensitive prompts
      console.log(chalk.cyan(`[Claude] User message received (${data.message.length} chars)`));

      // The session should have been registered via claude_resume_session
      // sendInput will spawn the process if needed using the registered session info
      const terminalSessionId = data.sessionKey; // Use sessionKey as terminalSessionId

      if (!terminalSessionId) {
        console.log(chalk.yellow(`[Claude] No sessionKey provided in user_message`));
        return;
      }

      // Check if this session has been taken over by the mobile user
      if (!claudeProcessManager.isTakenOver(terminalSessionId)) {
        // Fresh session from auto-prompt (quick action): start new session with directory
        if (data.directory) {
          console.log(chalk.cyan(`[Claude] Starting fresh session for auto-prompt in ${data.directory}`));
          const sent = await claudeProcessManager.startAndSendMessage(data.directory, terminalSessionId, data.message, data.mode?.permissionMode === 'bypassPermissions', data.interactivePermissions);
          if (sent) {
            // Notify mobile that session is ready
            wsClient.sendClaudeSessionUpdate({
              sessionKey: terminalSessionId,
              directory: data.directory,
              state: 'active',
              lastUsedAt: new Date().toISOString(),
            });
          } else {
            console.log(chalk.yellow(`[Claude] Failed to start fresh session`));
          }
          return;
        }

        // Session not taken over — user must press "Take Over" first
        console.log(chalk.yellow(`[Claude] Session not taken over: ${terminalSessionId} — watch-only mode`));
        wsClient.sendClaudeSessionEvent({
          sessionKey: terminalSessionId,
          event: {
            type: 'error',
            message: 'You must take over this session before sending messages.',
          },
        });
        return;
      }

      console.log(chalk.dim(`[Claude] Sending to session: ${terminalSessionId}`));
      const sent = await claudeProcessManager.sendInput(terminalSessionId, data.message + '\n');
      if (!sent) {
        console.log(chalk.yellow(`[Claude] Failed to send message - session may need restart`));
      }
    });

    // Handle Claude process end
    claudeProcessManager.on('session_ended', (data: any) => {
      console.log(chalk.dim(`[Claude] Session ended: ${data.terminalSessionId}`));
      wsClient.sendToolStatusUpdate('claude_code', 'inactive');
      if (data.sessionKey) {
        wsClient.sendClaudeSessionUpdate({
          sessionKey: data.sessionKey,
          directory: data.directory,
          state: 'inactive',
          lastUsedAt: new Date().toISOString(),
        });
      }
    });

    // Forward thinking content to mobile
    claudeProcessManager.on('thinking_content', (data: any) => {
      if (data.content || !data.partial) {
        console.log(chalk.magenta(`[Claude] Thinking${data.partial ? ' (streaming)' : ' (complete)'}: ${data.content?.substring(0, 50) || '...'}`));
      }
      wsClient.sendThinkingContent({
        sessionKey: data.sessionKey,
        thinkingId: data.thinkingId,
        content: data.content,
        partial: data.partial,
      });
    });

    // Forward token usage to mobile
    claudeProcessManager.on('token_usage', (data: any) => {
      console.log(chalk.blue(`[Claude] Tokens: ${data.usage.inputTokens} in / ${data.usage.outputTokens} out`));
      wsClient.sendTokenUsage({
        sessionKey: data.sessionKey,
        usage: data.usage,
      });
    });

    // Forward task progress to mobile
    claudeProcessManager.on('task_progress', (data: any) => {
      if (data.type === 'list') {
        console.log(chalk.cyan(`[Claude] Task list: ${data.tasks?.length || 0} tasks`));
      } else {
        console.log(chalk.cyan(`[Claude] Task ${data.type}: ${data.task?.subject || data.task?.id}`));
      }
      wsClient.sendTaskProgress({
        sessionKey: data.sessionKey,
        type: data.type,
        task: data.task,
        tasks: data.tasks,
      });
    });

    wsClient.on('disconnected', (reason) => {
      console.log(chalk.yellow(`\nDisconnected: ${reason}`));
      if (reason !== 'io client disconnect') {
        console.log(chalk.dim('Attempting to reconnect...'));
      }
    });

    wsClient.on('error', (error) => {
      console.error(chalk.red(`Connection error: ${error.message}`));
    });

    // Keep the process running
    process.on('SIGINT', () => {
      console.log(chalk.yellow('\nDisconnecting...'));
      claudeSessionDetector.stopWatching();
      transcriptStreamer.cleanup();
      wsClient.disconnect();
      process.exit(0);
    });

    // Keep alive
    await new Promise(() => {});
  } catch (error: any) {
    spinner.fail('Failed to connect');
    console.error(chalk.red(error.message || 'Unknown error'));
  }
}

// Helper function to wait for pairing
async function waitForPairing(deviceId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const checkInterval = setInterval(async () => {
      try {
        const status = await api.checkPairingStatus(deviceId);

        if (status.isPaired) {
          clearInterval(checkInterval);
          config.userId = status.userId;
          config.pairedAt = new Date().toISOString();

          console.log(chalk.green('\n✓ Device paired successfully!'));
          console.log(chalk.dim('\nConnecting to receive commands...\n'));

          // Auto-connect after successful pairing
          resolve();
        }
      } catch (error) {
        // Continue waiting
      }
    }, 2000);

    // Handle Ctrl+C
    process.on('SIGINT', () => {
      clearInterval(checkInterval);
      console.log(chalk.yellow('\nPairing cancelled.'));
      process.exit(0);
    });
  });
}

// Run the CLI
program.parse();
