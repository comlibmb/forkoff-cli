#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import chalk from 'chalk';
import qrcode from 'qrcode-terminal';
import * as crypto from 'crypto';
import { config } from './config';
import { wsClient } from './websocket';
import { terminalManager } from './terminal';
import { approvalManager } from './approval';
import { toolDetector, claudeHooksManager, claudeSessionDetector, claudeProcessManager, PermissionIpcManager } from './tools';
import { transcriptStreamer } from './transcript-streamer';
import { setQuiet, setDebug, closeDebugLog, cleanupOldLogs, getLogFilePath, createSpinner } from './logger';
import { UsageTracker } from './usage-tracker';
import { enableStartup, disableStartup, isStartupRegistered, getBinaryPath } from './startup';
import { TunnelManager } from './tunnel';
import { TunnelNotifier } from './tunnel-notifier';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Module-level tunnel manager for cleanup on exit
let activeTunnel: TunnelManager | null = null;

/** Get the local network IP (first non-internal IPv4 address) */
function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

export function createProgram(): Command {
const program = new Command();

program
  .name('forkoff')
  .description('CLI tool for ForkOff - Connect your AI coding tools to mobile')
  .version(require('../package.json').version)
  .option('-q, --quiet', 'Suppress all output (for background operation)')
  .option('--debug', 'Enable debug logging to file (~/.forkoff-cli/logs/)');

program.hook('preAction', () => {
  if (program.opts().debug) {
    setDebug(true);
    cleanupOldLogs(10);
  }
  if (program.opts().quiet) {
    setQuiet(true);
  }
});

// Configure CLI settings
program
  .command('config')
  .description('Configure ForkOff CLI settings')
  .option('-p, --port <port>', 'Set relay server port')
  .option('-n, --name <name>', 'Set device name')
  .option('--allowed-dirs <dirs>', 'Set allowed directories (comma-separated, e.g. "D:\\datas,C:\\Projects")')
  .option('--show', 'Show current configuration')
  .option('--reset', 'Reset all configuration')
  .action(async (options) => {
    if (options.reset) {
      config.reset();
      console.log(chalk.green('Configuration reset successfully'));
      return;
    }

    if (options.port) {
      const port = parseInt(options.port, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.log(chalk.red('Invalid port number. Must be between 1 and 65535.'));
        return;
      }
      config.relayPort = port;
      console.log(chalk.green(`Relay port set to: ${port}`));
    }

    if (options.name) {
      config.deviceName = options.name;
      console.log(chalk.green(`Device name set to: ${options.name}`));
    }

    if (options.allowedDirs) {
      const dirs = (options.allowedDirs as string).split(',').map((d: string) => d.trim()).filter(Boolean);
      config.allowedDirs = dirs;
      console.log(chalk.green(`Allowed directories set to:`));
      dirs.forEach((d: string) => console.log(chalk.cyan(`  - ${d}`)));
    }

    if (options.show || (!options.port && !options.name && !options.reset && !options.allowedDirs)) {
      const localIp = getLocalIp();
      const isCloud = config.relayMode === 'cloud';
      console.log(chalk.bold('\nCurrent Configuration:'));
      console.log(`  Relay Mode:  ${isCloud ? chalk.green('Cloud') : chalk.cyan('Local')}`);
      if (isCloud) {
        console.log(`  Relay URL:   ${chalk.cyan(config.wsUrl)}`);
      } else {
        console.log(`  Relay URL:   ${chalk.cyan(`ws://${localIp}:${config.relayPort}`)}`);
      }
      console.log(`  Relay Port:  ${chalk.cyan(String(config.relayPort))} ${isCloud ? chalk.dim('(local mode only)') : ''}`);
      console.log(`  Device Name: ${chalk.cyan(config.deviceName)}`);
      console.log(`  Device ID:   ${chalk.cyan(config.deviceId || 'Not registered')}`);
      console.log(`  Paired:      ${config.isPaired ? chalk.green('Yes') : chalk.yellow('No')}`);
      console.log(`  Config Path: ${chalk.dim(config.getPath())}`);
      const startupStatus = config.startupEnabled === null
        ? chalk.dim('Not configured')
        : config.startupEnabled ? chalk.green('Enabled') : chalk.yellow('Disabled');
      console.log(`  Startup:     ${startupStatus}`);
      const allowedDirsStr = config.allowedDirs.length > 0
        ? config.allowedDirs.map(d => chalk.cyan(`\n    - ${d}`)).join('')
        : chalk.dim('None (home directory only)');
      console.log(`  Allowed Dirs:${allowedDirsStr}`);
    }
  });

// Pair device with mobile app
program
  .command('pair')
  .description('Generate pairing code to connect with mobile app')
  .option('--local', 'Use local network relay instead of cloud relay')
  .option('--tunnel', 'Use cloudflared tunnel for public internet access')
  .action(async (options) => {
    const isLocal = options.local;
    const useTunnel = options.tunnel;
    const spinner = createSpinner(isLocal ? 'Starting local relay server...' : useTunnel ? 'Starting tunnel relay...' : 'Connecting to cloud relay...').start();

    try {
      // Ensure we have a deviceId
      config.ensureDeviceId();

      // Generate random 8-char pairing code
      const pairingCode = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 8);
      config.pairingCode = pairingCode;

      if (useTunnel) {
        // Tunnel mode: start local relay + cloudflared tunnel
        config.relayMode = 'local';
        config.tunnelProvider = 'cloudflared';
        await wsClient.startServer(config.relayPort);
        wsClient.setPairingCode(pairingCode);

        // Start cloudflared tunnel
        activeTunnel = new TunnelManager();
        const tunnelUrl = await activeTunnel.start(config.relayPort);
        config.tunnelUrl = tunnelUrl;

        // Mobile expects wss:// format in QR code relay parameter
        const relayUrl = tunnelUrl.replace('https://', 'wss://').replace('http://', 'ws://');

        spinner.succeed(`Tunnel relay started\n`);

        // Notify Supabase so mobile can auto-reconnect on tunnel restart
        await TunnelNotifier.notifyTunnelUrl(config.deviceId!, tunnelUrl, pairingCode);

        // QR includes tunnel URL
        const pairingUrl = `forkoff://pair/${pairingCode}?relay=${encodeURIComponent(relayUrl)}`;
        console.log(chalk.bold('Scan this QR code with the ForkOff mobile app:\n'));
        qrcode.generate(pairingUrl, { small: true }, (code) => {
          console.log(code);
        });

        console.log(chalk.bold('\nOr enter this code manually:\n'));
        console.log(chalk.bgBlue.white.bold(`  ${pairingCode}  `));
        console.log();
        console.log(chalk.dim(`Tunnel: ${tunnelUrl}`));
        console.log(chalk.dim(`Relay: ws://localhost:${config.relayPort} → ${relayUrl}`));

        // Listen for tunnel URL changes and notify mobile
        activeTunnel.on('url_changed', async (newUrl: string) => {
          console.log(chalk.cyan(`[Tunnel] URL changed: ${newUrl}`));
          config.tunnelUrl = newUrl;
          await TunnelNotifier.notifyTunnelUrl(config.deviceId!, newUrl);
        });

        activeTunnel.on('error', async (err: Error) => {
          console.log(chalk.red(`[Tunnel] Error: ${err.message}`));
          if (err.message.includes('giving up')) {
            await TunnelNotifier.markTunnelOffline(config.deviceId!);
          }
        });

      } else if (isLocal) {
        // Local mode: start embedded relay server (existing behavior)
        config.relayMode = 'local';
        await wsClient.startServer(config.relayPort);

        // Set pairing code on server for in-process validation
        wsClient.setPairingCode(pairingCode);

        const localIp = getLocalIp();
        const relayUrl = `ws://${localIp}:${config.relayPort}`;

        spinner.succeed(`Local relay server started on ${relayUrl}\n`);

        // QR includes relay URL for local mode
        const pairingUrl = `forkoff://pair/${pairingCode}?relay=${encodeURIComponent(relayUrl)}`;
        console.log(chalk.bold('Scan this QR code with the ForkOff mobile app:\n'));
        qrcode.generate(pairingUrl, { small: true }, (code) => {
          console.log(code);
        });

        console.log(chalk.bold('\nOr enter this code manually:\n'));
        console.log(chalk.bgBlue.white.bold(`  ${pairingCode}  `));
        console.log();
        console.log(chalk.dim(`Relay: ${relayUrl}`));
      } else {
        // Cloud mode (default): connect to cloud relay as a client
        config.relayMode = 'cloud';
        await wsClient.connectToRelay(config.wsUrl);

        // Register pairing code with the relay
        wsClient.setPairingCode(pairingCode);

        spinner.succeed(`Connected to cloud relay\n`);

        // QR without relay URL — mobile uses its default cloud connection
        const pairingUrl = `forkoff://pair/${pairingCode}`;
        console.log(chalk.bold('Scan this QR code with the ForkOff mobile app:\n'));
        qrcode.generate(pairingUrl, { small: true }, (code) => {
          console.log(code);
        });

        console.log(chalk.bold('\nOr enter this code manually:\n'));
        console.log(chalk.bgBlue.white.bold(`  ${pairingCode}  `));
        console.log();
        console.log(chalk.dim(`Cloud relay: ${config.wsUrl}`));
      }

      console.log();

      // Wait for pairing
      console.log(chalk.yellow('Waiting for mobile app to scan...'));
      console.log(chalk.dim('Press Ctrl+C to cancel\n'));

      const pairData = await waitForPairing();

      config.pairedAt = new Date().toISOString();

      console.log(chalk.green('\n\u2713 Device paired successfully!'));
      console.log(chalk.dim('\nStarting connection...\n'));

      // Auto-register startup if not explicitly disabled
      if (config.startupEnabled !== false) {
        try {
          await enableStartup();
          console.log(chalk.green('Automatic startup registered. Use "forkoff startup --disable" to opt out.'));
        } catch {
          // Non-critical — don't fail pairing over this
        }
      }

      // Continue to main connection (transport already running)
      await startConnection();
    } catch (error: any) {
      spinner.fail('Failed to pair device');
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

    const localIp = getLocalIp();
    const isCloud = config.relayMode === 'cloud';
    console.log(chalk.bold('\nDevice Status:'));
    console.log(`  Device ID:   ${chalk.cyan(config.deviceId)}`);
    console.log(`  Device Name: ${chalk.cyan(config.deviceName)}`);
    console.log(`  Paired:      ${config.isPaired ? chalk.green('Yes') : chalk.yellow('No')}`);
    console.log(`  Relay Mode:  ${isCloud ? chalk.green('Cloud') : chalk.cyan('Local')}`);
    if (isCloud) {
      console.log(`  Relay URL:   ${chalk.cyan(config.wsUrl)}`);
    } else {
      console.log(`  Relay URL:   ${chalk.cyan(`ws://${localIp}:${config.relayPort}`)}`);
    }
    console.log(`  Mobile:      ${wsClient.isConnected ? chalk.green('Connected') : chalk.yellow('Not connected')}`);
    if (config.pairedAt) {
      console.log(`  Paired At:   ${chalk.dim(config.pairedAt)}`);
    }
  });

// Connect and stay online (for returning users who already paired)
program
  .command('connect')
  .description('Reconnect to ForkOff (for previously paired devices)')
  .option('--local', 'Use local network relay instead of cloud relay')
  .option('--tunnel', 'Use cloudflared tunnel for public internet access')
  .action(async (options) => {
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

    const useTunnel = options.tunnel || config.tunnelProvider === 'cloudflared';

    if (useTunnel) {
      // Tunnel mode: start local relay + cloudflared tunnel
      config.relayMode = 'local';
      config.tunnelProvider = 'cloudflared';
      await wsClient.startServer(config.relayPort);
      console.log(chalk.cyan(`Local relay server started on port ${config.relayPort}`));

      // Start cloudflared tunnel
      activeTunnel = new TunnelManager();
      try {
        const tunnelUrl = await activeTunnel.start(config.relayPort);
        config.tunnelUrl = tunnelUrl;
        console.log(chalk.green(`Tunnel started: ${tunnelUrl}`));

        // Notify Supabase so mobile can connect / auto-reconnect
        await TunnelNotifier.notifyTunnelUrl(config.deviceId!, tunnelUrl);

        // Listen for tunnel URL changes
        activeTunnel.on('url_changed', async (newUrl: string) => {
          console.log(chalk.cyan(`[Tunnel] URL changed: ${newUrl}`));
          config.tunnelUrl = newUrl;
          await TunnelNotifier.notifyTunnelUrl(config.deviceId!, newUrl);
        });

        activeTunnel.on('error', async (err: Error) => {
          console.log(chalk.red(`[Tunnel] Error: ${err.message}`));
          if (err.message.includes('giving up')) {
            await TunnelNotifier.markTunnelOffline(config.deviceId!);
          }
        });
      } catch (err: any) {
        console.log(chalk.red(`Failed to start tunnel: ${err.message}`));
        console.log(chalk.yellow('Falling back to local mode...'));
        activeTunnel = null;
      }
    } else if (options.local || config.relayMode === 'local') {
      // Local mode: start embedded relay server
      const localIp = getLocalIp();
      const relayUrl = `ws://${localIp}:${config.relayPort}`;
      await wsClient.startServer(config.relayPort);
      console.log(chalk.cyan(`Local relay server started on ${relayUrl}`));
    } else {
      // Cloud mode (default): connect to cloud relay
      await wsClient.connectToRelay(config.wsUrl);
      console.log(chalk.cyan(`Connected to cloud relay (${config.wsUrl})`));
    }
    console.log(chalk.dim('Waiting for mobile app to connect...\n'));

    await startConnection();
  });

// Disconnect/unpair device
program
  .command('disconnect')
  .description('Disconnect and unpair device')
  .action(async () => {
    wsClient.disconnect();

    // Disable startup registration so it doesn't run on boot after unpair
    if (isStartupRegistered()) {
      try { await disableStartup(); } catch {}
    }

    config.pairedAt = null;
    config.pairingCode = null;
    config.relayToken = null;
    config.pairId = null;

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

// Helper function to set up event handlers (server already started by caller)
async function startConnection(): Promise<void> {
  const spinner = createSpinner('Initializing...').start();

  try {
    PermissionIpcManager.cleanupStaleTempFiles();
    claudeProcessManager.cleanupAllPermissionState();
    spinner.succeed('Ready!\n');

    // Detect connected tools
    spinner.start('Detecting AI coding tools...');
    try {
      const toolResult = await toolDetector.detectAll();
      if (toolResult.tools.length > 0) {
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
      console.log(chalk.dim(`[Terminal] Session auto-created: ${data.terminalSessionId}`));
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

      console.log(chalk.dim(`[Terminal] Session created`));
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
        console.log(chalk.cyan(`[Claude] New session detected`));
        wsClient.sendClaudeSessionUpdate(session);
      });

      claudeSessionDetector.on('session_changed', (session) => {
        console.log(chalk.dim(`[Claude] Session updated (${session.state})`));
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
            hasActiveSession = true;
          }
        }

        wsClient.sendClaudeSessions(sessions);

        if (hasActiveSession) {
          console.log(chalk.cyan(`[Claude] Claude is now ACTIVE`));
          wsClient.sendToolStatusUpdate('claude_code', 'active');
        }

        // Seed the cache so startWatching doesn't re-emit these sessions
        // individually as session_detected events
        claudeSessionDetector.seedKnownSessions(sessions);
      }

      // Start watching for session changes
      claudeSessionDetector.startWatching(5000);
    }

    // Log approval events
    approvalManager.on('approved', (approval) => {
      console.log(chalk.green(`[Approval] Approved: ${approval.approvalId}`));
    });

    approvalManager.on('rejected', (approval) => {
      console.log(chalk.red(`[Approval] Rejected: ${approval.approvalId}`));
    });

    // Handle Claude start session request from mobile
    wsClient.on('claude_start_session', async (data: any) => {
      console.log(chalk.cyan(`[Claude] Start session request for ${data.terminalSessionId}`));
      try {
        const result = await claudeProcessManager.startSession(data.directory, data.terminalSessionId, data.dangerouslySkipPermissions, data.interactivePermissions);

        wsClient.sendToolStatusUpdate('claude_code', 'active');
        wsClient.sendTerminalCwd({ terminalSessionId: data.terminalSessionId, cwd: result.cwd });

        // Track session start for analytics
        usageTracker.recordSessionStart();

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
      // Prevent duplicate resume for the same session (avoid registration loop)
      if (claudeProcessManager.isSessionTakenOver(data.terminalSessionId)) {
        console.log(chalk.dim(`[Claude] Session ${data.sessionKey?.substring(0, 8)}... already registered, resending ready`));
        wsClient.sendClaudeSessionEvent({
          sessionKey: data.sessionKey,
          event: { type: 'ready' },
        });
        return;
      }

      console.log(chalk.cyan(`[Claude] Resume session request`));

      // Look up the correct directory from our locally scanned sessions
      // The mobile app may have a cached/stale directory (e.g. with corrupted hyphens)
      let resolvedDir = data.directory;
      const knownSession = claudeSessionDetector.getSessions().find(s => s.sessionKey === data.sessionKey);
      if (knownSession && knownSession.directory) {
        console.log(chalk.dim(`[Claude] Using local directory for session`));
        resolvedDir = knownSession.directory;
      }

      if (resolvedDir === '~' || resolvedDir.startsWith('~/')) {
        resolvedDir = resolvedDir === '~' ? os.homedir() : resolvedDir.replace('~', os.homedir());
      }
      resolvedDir = path.resolve(resolvedDir);

      // Always register the session — even if it's running in a terminal.
      // With --resume, we spawn a new process per turn which picks up where the session left off.
      // If the terminal session holds a file lock, the spawn will fail gracefully.
      // isRealSession: true if the key matches a locally-known Claude session, false if mobile-generated
      // (e.g. brainstorm-*, quick actions). Fresh sessions use startAndSendMessage instead of --resume.
      const isRealSession = !!knownSession;
      claudeProcessManager.registerSession(data.sessionKey, resolvedDir, data.terminalSessionId, data.dangerouslySkipPermissions, data.interactivePermissions, isRealSession);
      claudeProcessManager.markTakenOver(data.terminalSessionId);

      wsClient.sendToolStatusUpdate('claude_code', 'active');
      wsClient.sendClaudeSessionUpdate({
        sessionKey: data.sessionKey,
        directory: data.directory,
        state: 'active',
        lastUsedAt: new Date().toISOString(),
      });
      wsClient.sendTerminalCwd({ terminalSessionId: data.terminalSessionId, cwd: resolvedDir });

      // Sync any pending permission prompts to mobile
      const pendingPrompts = claudeProcessManager.getAllPendingPrompts();
      if (pendingPrompts.length > 0) {
        console.log(chalk.yellow(`[Claude] Syncing ${pendingPrompts.length} pending permission prompt(s) to mobile`));
        wsClient.sendPendingPermissionsSync({
          sessionKey: data.sessionKey,
          terminalSessionId: data.terminalSessionId,
          prompts: pendingPrompts,
        });
      }

      // Notify mobile that the session is ready for input
      wsClient.sendClaudeSessionEvent({
        sessionKey: data.sessionKey,
        event: { type: 'ready' },
      });

      console.log(chalk.green(`[Claude] Session ready (will spawn on first message)`));
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

        if (!config.isPathAllowed(resolvedPath)) {
          console.warn(chalk.yellow(`[Dir] Access denied — path not in allowed directories`));
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
      console.log(chalk.dim(`[File] Read request received`));
      try {
        // SECURITY: Whitelist of allowed filenames
        const allowedFiles = ['CLAUDE.md', 'README.md', 'package.json'];
        const fileName = path.basename(data.filePath);

        if (!allowedFiles.includes(fileName)) {
          console.warn(chalk.yellow(`[File] Access denied — file not in whitelist`));
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

        if (!config.isPathAllowed(resolvedPath)) {
          console.warn(chalk.yellow(`[File] Access denied — path not in allowed directories`));
          wsClient.sendReadFileResponse({
            requestId: data.requestId,
            exists: false,
            fileName,
            error: 'Access denied',
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
        console.error(`[File] Error reading ${path.basename(data.filePath)}:`, error.message);
        wsClient.sendReadFileResponse({
          requestId: data.requestId,
          exists: false,
          fileName: path.basename(data.filePath),
          error: 'File read failed',
        });
      }
    });

    // Handle transcript fetch requests from mobile
    wsClient.on('transcript_fetch', async (data: any) => {
      console.log(chalk.dim(`[Transcript] Fetching: offset: ${data.offset}, limit: ${data.limit}`));

      // Signal loading state to mobile
      wsClient.sendSessionLoading({ sessionKey: data.sessionKey, state: 'loading' });

      try {
        // SECURITY: Validate transcript path is under ~/.claude/projects/ to prevent path traversal
        const resolvedTranscriptPath = path.resolve(data.transcriptPath);
        const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
        const relPath = path.relative(claudeProjectsDir, resolvedTranscriptPath);
        if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
          console.warn(chalk.yellow(`[Transcript] Access denied — path outside ~/.claude/projects/`));
          wsClient.sendSessionLoading({ sessionKey: data.sessionKey, state: 'error', error: 'Access denied' });
          return;
        }

        const result = await transcriptStreamer.fetchHistory(
          resolvedTranscriptPath,
          data.offset || 0,
          data.limit || 100,
          data.reverse !== false // Default to true (most recent first)
        );
        const payload = JSON.stringify(result.entries);
        console.log(chalk.dim(`[Transcript] Sending history: ${result.entries.length} entries, ${result.totalEntries} total, payload ~${(payload.length / 1024).toFixed(0)}KB`));
        wsClient.sendTranscriptHistory({
          sessionKey: data.sessionKey,
          ...result,
          offset: data.offset || 0,
          requestedBy: data.requestedBy,
        });

        // Signal ready state to mobile
        wsClient.sendSessionLoading({ sessionKey: data.sessionKey, state: 'ready' });
      } catch (error: any) {
        console.error(chalk.red(`[Transcript] Error: ${error.message}`));
        wsClient.sendSessionLoading({ sessionKey: data.sessionKey, state: 'error', error: error.message });
      }
    });

    // Handle transcript subscribe
    wsClient.on('transcript_subscribe', (data: any) => {
      console.log(chalk.dim(`[Transcript] Subscribing to session`));
      // SECURITY: Validate transcript path to prevent path traversal
      const resolvedSubPath = path.resolve(data.transcriptPath);
      const claudeDir = path.join(os.homedir(), '.claude', 'projects');
      const subRelPath = path.relative(claudeDir, resolvedSubPath);
      if (subRelPath.startsWith('..') || path.isAbsolute(subRelPath)) {
        console.warn(chalk.yellow(`[Transcript] Subscribe denied — path outside ~/.claude/projects/`));
        return;
      }
      transcriptStreamer.subscribeToUpdates(data.sessionKey, resolvedSubPath);
    });

    // Handle transcript unsubscribe
    wsClient.on('transcript_unsubscribe', (data: any) => {
      console.log(chalk.dim(`[Transcript] Unsubscribing from session`));
      transcriptStreamer.unsubscribeFromUpdates(data.sessionKey);
    });

    // Re-send all sessions when E2EE establishes (bypasses queue TTL expiry)
    wsClient.on('e2ee_established', () => {
      if (claudeSessionDetector.isClaudeInstalled()) {
        const sessions = claudeSessionDetector.scanSessions();
        if (sessions.length > 0) {
          console.log(chalk.cyan(`[Claude] E2EE established — re-sending ${sessions.length} session(s)`));
          wsClient.sendClaudeSessions(sessions);
        }
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

    // Handle SDK session history requests from mobile (local JSONL lookup)
    // Mobile sends this when opening a session — CLI resolves it locally from disk
    wsClient.on('sdk_session_history', async (data: any) => {
      console.log(chalk.dim(`[Transcript] SDK session history requested`));

      // Signal loading state to mobile
      wsClient.sendSessionLoading({ sessionKey: data.sessionKey, state: 'loading' });

      try {
        // Find session locally by sessionKey or claudeSessionId
        let sessions = claudeSessionDetector.getSessions();
        let session = sessions.find((s: any) => s.sessionKey === data.sessionKey);
        if (!session && data.claudeSessionId) {
          session = sessions.find((s: any) => s.sessionKey === data.claudeSessionId);
        }

        // Fallback: rescan if not cached
        if (!session) {
          const freshSessions = claudeSessionDetector.scanSessions();
          session = freshSessions.find((s: any) =>
            s.sessionKey === data.sessionKey ||
            (data.claudeSessionId && s.sessionKey === data.claudeSessionId)
          );
        }

        if (session?.transcriptPath) {
          const result = await transcriptStreamer.fetchHistory(
            session.transcriptPath,
            data.offset || 0,
            data.limit || 200,
            true
          );
          console.log(chalk.dim(`[Transcript] Sending history: ${result.entries.length} entries`));
          wsClient.sendTranscriptHistory({
            sessionKey: data.sessionKey,
            ...result,
            offset: data.offset || 0,
            requestedBy: data.requestedBy,
          });
        } else {
          // No local transcript — send empty response so mobile stops loading
          wsClient.sendTranscriptHistory({
            sessionKey: data.sessionKey,
            entries: [],
            totalEntries: 0,
            offset: 0,
            hasMore: false,
            requestedBy: data.requestedBy,
          });
        }

        // Signal ready state
        wsClient.sendSessionLoading({ sessionKey: data.sessionKey, state: 'ready' });
      } catch (error: any) {
        console.error(chalk.red(`[Transcript] SDK session history error: ${error.message}`));
        wsClient.sendSessionLoading({ sessionKey: data.sessionKey, state: 'error', error: error.message });
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
      console.log(chalk.dim(`[Claude] Tool activity: ${data.toolName}`));
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
      console.log(chalk.green(`[Claude] Permission response: ${data.promptId}`));
      claudeProcessManager.handlePermissionResponse(data.promptId, data.decision, data.reason);
    });

    // Handle permission rules sync from mobile — write rules to disk for hook script
    wsClient.on('permission_rules_sync', (data: any) => {
      if (data.rules && Array.isArray(data.rules)) {
        console.log(chalk.cyan(`[Claude] Permission rules sync: ${data.rules.length} rules`));
        claudeProcessManager.updatePermissionRules(data.rules);
      }
    });

    // Handle Claude approval responses from mobile
    wsClient.on('claude_approval_response', (data: any) => {
      console.log(chalk.green(`[Claude] Approval response: ${data.approvalId}`));
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
          console.log(chalk.cyan(`[Claude] Starting fresh session for auto-prompt`));
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

        // Session was taken over before but cleared on reconnect — auto re-register
        const knownSession = claudeSessionDetector.getSessions().find(s => s.sessionKey === terminalSessionId);
        if (knownSession) {
          console.log(chalk.cyan(`[Claude] Auto re-registering session ${terminalSessionId.substring(0, 8)}... after reconnect`));
          const dir = knownSession.directory || data.directory;
          claudeProcessManager.registerSession(terminalSessionId, dir, terminalSessionId, false, true, true);
          claudeProcessManager.markTakenOver(terminalSessionId);
        } else {
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
      // Use terminalSessionId as fallback — fresh sessions (startAndSendMessage) may not
      // have captured the real session_id from SDK output before the process ended.
      // The mobile references these sessions by terminalSessionId, so the inactive update
      // must use it to prevent stale "active" sessions.
      const key = data.sessionKey || data.terminalSessionId;
      if (key) {
        wsClient.sendClaudeSessionUpdate({
          sessionKey: key,
          directory: data.directory,
          state: 'inactive',
          lastUsedAt: new Date().toISOString(),
        });
      }
    });

    // Forward thinking content to mobile
    claudeProcessManager.on('thinking_content', (data: any) => {
      if (data.content || !data.partial) {
        console.log(chalk.magenta(`[Claude] Thinking${data.partial ? ' (streaming)' : ' (complete)'}: ${data.content?.length || 0} chars`));
      }
      wsClient.sendThinkingContent({
        sessionKey: data.sessionKey,
        thinkingId: data.thinkingId,
        content: data.content,
        partial: data.partial,
      });
    });

    // Persistent usage tracker
    const usageTracker = new UsageTracker();
    wsClient.setUsageTracker(usageTracker);

    // Forward token usage to mobile and persist locally
    claudeProcessManager.on('token_usage', (data: any) => {
      console.log(chalk.blue(`[Claude] Tokens: ${data.usage.inputTokens} in / ${data.usage.outputTokens} out`));
      usageTracker.recordUsage(data.usage.inputTokens || 0, data.usage.outputTokens || 0);
      wsClient.sendTokenUsage({
        sessionKey: data.sessionKey,
        usage: data.usage,
      });
    });

    // Handle usage stats request from mobile (pull-refresh)
    wsClient.on('usage_stats_request', () => {
      console.log(chalk.blue('[Analytics] Usage stats requested by mobile'));
      wsClient.sendAllUsageStats();
    });

    // When a fresh session captures a real session_id, update the transcript
    // file watcher so the mobile gets real-time updates from the correct JSONL file.
    // This is critical for brainstorm/quick-action sessions where startAndSendMessage
    // creates a new Claude session with a new transcript file.
    claudeProcessManager.on('session_id_captured', (data: any) => {
      const { terminalSessionId, sessionId } = data;
      console.log(chalk.green(`[Claude] New session_id captured for ${terminalSessionId}`));

      // Re-scan to pick up the new session's transcript path
      const sessions = claudeSessionDetector.scanSessions();
      const newSession = sessions.find((s: any) => s.sessionKey === sessionId);
      if (newSession?.transcriptPath) {
        console.log(chalk.green(`[Claude] Updating transcript watcher`));
        transcriptStreamer.subscribeToUpdates(terminalSessionId, newSession.transcriptPath);
      } else {
        console.log(chalk.yellow(`[Claude] New session transcript not found yet, retrying in 1s...`));
        setTimeout(() => {
          const retrySessions = claudeSessionDetector.scanSessions();
          const retrySession = retrySessions.find((s: any) => s.sessionKey === sessionId);
          if (retrySession?.transcriptPath) {
            console.log(chalk.green(`[Claude] Retry: updating transcript watcher`));
            transcriptStreamer.subscribeToUpdates(terminalSessionId, retrySession.transcriptPath);
          } else {
            console.log(chalk.yellow(`[Claude] Retry: transcript still not found`));
          }
        }, 1000);
      }
    });

    // Forward task progress to mobile
    claudeProcessManager.on('task_progress', (data: any) => {
      if (data.type === 'list') {
        console.log(chalk.cyan(`[Claude] Task list: ${data.tasks?.length || 0} tasks`));
      } else {
        console.log(chalk.cyan(`[Claude] Task ${data.type}: ${data.task?.id || 'unknown'}`));
      }
      wsClient.sendTaskProgress({
        sessionKey: data.sessionKey,
        type: data.type,
        task: data.task,
        tasks: data.tasks,
      });
    });

    wsClient.on('connected', () => {
      claudeProcessManager.cancelSessionTTL();
    });

    wsClient.on('disconnected', (reason) => {
      console.log(chalk.yellow(`\nMobile disconnected: ${reason}`));
      claudeProcessManager.resolveAllPendingPrompts('deny', 'mobile disconnected');

      // Distinguish graceful disconnect (user closed app) from network interruption
      const isGraceful = reason === 'client namespace disconnect';
      if (isGraceful) {
        claudeProcessManager.cleanupAllPermissionState();
        claudeProcessManager.clearAllTakenOver();
      } else {
        // Network interruption — keep sessions for 5 min in case mobile reconnects
        console.log(chalk.dim('Network interruption — keeping sessions for 5 min'));
        claudeProcessManager.startSessionTTL(5 * 60 * 1000);
      }

      console.log(chalk.dim('Waiting for mobile to reconnect...'));
    });

    wsClient.on('session_release', (data: any) => {
      console.log(chalk.dim(`[Session] Mobile released session: ${data.sessionKey}`));
      claudeProcessManager.releaseSession(data.sessionKey);
    });

    wsClient.on('error', (error) => {
      console.error(chalk.red(`Connection error: ${error.message}`));
    });

    // Keep the process running
    process.on('SIGINT', async () => {
      console.log(chalk.yellow('\nDisconnecting...'));
      if (activeTunnel) {
        await TunnelNotifier.clearTunnelSession(config.deviceId!);
        await activeTunnel.stop();
        activeTunnel = null;
      }
      claudeProcessManager.cleanupAllPermissionState();
      usageTracker.flush();
      claudeSessionDetector.stopWatching();
      transcriptStreamer.cleanup();
      wsClient.disconnect();
      const logPath = getLogFilePath();
      closeDebugLog();
      if (logPath) {
        // Use original console since we just closed the debug log
        process.stdout.write(`\nDebug log saved: ${logPath}\n`);
      }
      process.exit(0);
    });

    // Keep alive
    await new Promise(() => {});
  } catch (error: any) {
    spinner.fail('Failed to connect');
    console.error(chalk.red(error.message || 'Unknown error'));
  }
}

// Helper function to wait for pairing via WebSocket event
async function waitForPairing(): Promise<{ mobileDeviceId: string }> {
  return new Promise((resolve) => {
    const sigintHandler = () => {
      console.log(chalk.yellow('\nPairing cancelled.'));
      wsClient.disconnect();
      process.exit(0);
    };

    wsClient.once('pair_device', (data: any) => {
      process.removeListener('SIGINT', sigintHandler);
      resolve({ mobileDeviceId: data.mobileDeviceId });
    });

    // Handle Ctrl+C
    process.on('SIGINT', sigintHandler);
  });
}

// Logs command — list and manage debug log files
program
  .command('logs')
  .description('List debug log files for troubleshooting')
  .option('--clean', 'Delete all debug log files')
  .option('--latest', 'Print path to the most recent log file')
  .action((options) => {
    const logDir = path.join(os.homedir(), '.forkoff-cli', 'logs');
    if (!fs.existsSync(logDir)) {
      console.log(chalk.dim('No debug logs found. Run with --debug to generate logs.'));
      return;
    }

    const logFiles = fs.readdirSync(logDir)
      .filter(f => f.startsWith('debug-') && f.endsWith('.log'))
      .sort()
      .reverse();

    if (logFiles.length === 0) {
      console.log(chalk.dim('No debug logs found. Run with --debug to generate logs.'));
      return;
    }

    if (options.clean) {
      for (const file of logFiles) {
        try { fs.unlinkSync(path.join(logDir, file)); } catch {}
      }
      console.log(chalk.green(`Deleted ${logFiles.length} log file(s).`));
      return;
    }

    if (options.latest) {
      console.log(path.join(logDir, logFiles[0]));
      return;
    }

    console.log(chalk.bold('Debug log files:\n'));
    for (const file of logFiles) {
      const filePath = path.join(logDir, file);
      const stat = fs.statSync(filePath);
      const sizeKB = (stat.size / 1024).toFixed(1);
      console.log(`  ${file}  ${chalk.dim(`(${sizeKB} KB)`)}`);
    }
    console.log(chalk.dim(`\nLog directory: ${logDir}`));
    console.log(chalk.dim('Run with --debug to generate a new log file.'));
  });

// Help command
program
  .command('help')
  .description('Show available commands and usage')
  .action(() => { program.outputHelp(); });

// Unknown command handling
program.showHelpAfterError('Run "forkoff help" for available commands.');
program.on('command:*', (operands) => {
  console.error(`Unknown command: ${operands[0]}\n`);
  console.log('Run "forkoff help" for available commands.');
  process.exitCode = 1;
});

return program;
}

// Run the CLI (skip when loaded as a module in tests)
if (require.main === module) {
  createProgram().parse();
}
