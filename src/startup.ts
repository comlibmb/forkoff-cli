import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { config } from './config';

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const REG_VALUE = 'ForkOffCLI';
const LAUNCHD_LABEL = 'app.forkoff.cli';

function getPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function getBatPath(): string {
  const configDir = process.platform === 'win32'
    ? path.join(process.env.APPDATA || os.homedir(), 'forkoff-cli')
    : path.join(os.homedir(), '.config', 'forkoff-cli');
  return path.join(configDir, 'startup.bat');
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
      execSync(`reg query "${REG_KEY}" /v ${REG_VALUE}`, { stdio: 'pipe' });
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
  // Write a .bat wrapper so the registry value is a single path.
  // Quoting inside reg values is tricky when paths have spaces;
  // a .bat file sidesteps this entirely.
  const nodePath = process.execPath;
  const batPath = getBatPath();
  const batDir = path.dirname(batPath);
  if (!fs.existsSync(batDir)) {
    fs.mkdirSync(batDir, { recursive: true });
  }
  const batContent = `@echo off\r\n"${nodePath}" "${binaryPath}" connect --quiet\r\n`;
  fs.writeFileSync(batPath, batContent);

  // Use HKCU Run key — no admin required, runs on user logon
  execSync(
    `reg add "${REG_KEY}" /v ${REG_VALUE} /t REG_SZ /d "\\"${batPath}\\"" /f`,
    { stdio: 'pipe' }
  );
}

async function disableStartupWindows(): Promise<void> {
  // Remove registry Run key
  try {
    execSync(`reg delete "${REG_KEY}" /v ${REG_VALUE} /f`, { stdio: 'pipe' });
  } catch {
    // Key didn't exist
  }

  // Clean up the .bat wrapper
  const batPath = getBatPath();
  try {
    if (fs.existsSync(batPath)) {
      fs.unlinkSync(batPath);
    }
  } catch {
    // Non-critical
  }
}

async function enableStartupMacOS(binaryPath: string): Promise<void> {
  // Remove existing first (idempotent)
  await disableStartupMacOS();

  const configDir = path.join(os.homedir(), '.config', 'forkoff-cli');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Use the current node binary explicitly as the first ProgramArgument.
  // Users with nvm/fnm have node outside the default PATH, so launchd
  // can't find node via the shebang. Including process.execPath directly
  // ensures the plist always uses the correct node binary.
  const nodePath = process.execPath;
  const nodeDir = path.dirname(nodePath);

  // Build PATH that includes the current node binary's directory,
  // so any child processes also find the right node.
  const defaultPath = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin';
  const envPath = defaultPath.includes(nodeDir) ? defaultPath : `${nodeDir}:${defaultPath}`;

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
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
    <string>${envPath}</string>
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
