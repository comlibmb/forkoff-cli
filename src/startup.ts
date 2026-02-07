import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { config } from './config';

const TASK_NAME = 'ForkOffCLI';
const LAUNCHD_LABEL = 'app.forkoff.cli';

function getPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

export function getBinaryPath(): string {
  // Check cached path
  if (config.startupBinaryPath && fs.existsSync(config.startupBinaryPath)) {
    return config.startupBinaryPath;
  }

  // Try to find forkoff in PATH
  try {
    const cmd = process.platform === 'win32' ? 'where forkoff' : 'which forkoff';
    const result = execSync(cmd, { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
    if (result && fs.existsSync(result)) {
      config.startupBinaryPath = result;
      return result;
    }
  } catch {
    // Not found in PATH
  }

  // Fallback to process.argv[1]
  const fallback = process.argv[1];
  if (fallback) {
    config.startupBinaryPath = fallback;
    return fallback;
  }

  throw new Error('Could not determine forkoff binary path');
}

export function isStartupRegistered(): boolean {
  if (process.platform === 'win32') {
    try {
      execSync(`schtasks /Query /TN "${TASK_NAME}"`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  } else if (process.platform === 'darwin') {
    return fs.existsSync(getPlistPath());
  }

  return false;
}

export async function enableStartup(): Promise<void> {
  const binaryPath = getBinaryPath();

  if (process.platform === 'win32') {
    await enableStartupWindows(binaryPath);
  } else if (process.platform === 'darwin') {
    await enableStartupMacOS(binaryPath);
  } else {
    throw new Error(`Startup registration is not supported on ${process.platform}`);
  }

  config.startupEnabled = true;
}

export async function disableStartup(): Promise<void> {
  if (process.platform === 'win32') {
    await disableStartupWindows();
  } else if (process.platform === 'darwin') {
    await disableStartupMacOS();
  } else {
    throw new Error(`Startup registration is not supported on ${process.platform}`);
  }

  config.startupEnabled = false;
}

async function enableStartupWindows(binaryPath: string): Promise<void> {
  // Remove existing task first (idempotent)
  try {
    execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: 'pipe' });
  } catch {
    // Task didn't exist
  }

  // Find node executable
  const nodePath = process.execPath;

  // Create scheduled task that runs on logon
  const taskCommand = `"${nodePath}" "${binaryPath}" connect --quiet`;
  execSync(
    `schtasks /Create /TN "${TASK_NAME}" /TR ${taskCommand} /SC ONLOGON /RL LIMITED /F`,
    { stdio: 'pipe' }
  );
}

async function disableStartupWindows(): Promise<void> {
  try {
    execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: 'pipe' });
  } catch {
    // Task didn't exist
  }
}

async function enableStartupMacOS(binaryPath: string): Promise<void> {
  // Remove existing first (idempotent)
  await disableStartupMacOS();

  const configDir = path.join(os.homedir(), '.config', 'forkoff-cli');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binaryPath}</string>
    <string>connect</string>
    <string>--quiet</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${configDir}/startup-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${configDir}/startup-stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>`;

  const plistPath = getPlistPath();
  const launchAgentsDir = path.dirname(plistPath);
  if (!fs.existsSync(launchAgentsDir)) {
    fs.mkdirSync(launchAgentsDir, { recursive: true });
  }

  fs.writeFileSync(plistPath, plist);

  try {
    execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' });
  } catch {
    // May fail if already loaded
  }
}

async function disableStartupMacOS(): Promise<void> {
  const plistPath = getPlistPath();

  if (fs.existsSync(plistPath)) {
    try {
      execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
    } catch {
      // May fail if not loaded
    }
    fs.unlinkSync(plistPath);
  }
}
