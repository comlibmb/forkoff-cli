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

function getStartupDir(): string {
  return process.platform === 'win32'
    ? path.join(process.env.APPDATA || os.homedir(), 'forkoff-cli')
    : path.join(os.homedir(), '.config', 'forkoff-cli');
}

function getVbsPath(): string {
  return path.join(getStartupDir(), 'startup.vbs');
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
  const startupDir = getStartupDir();
  if (!fs.existsSync(startupDir)) {
    fs.mkdirSync(startupDir, { recursive: true, mode: 0o700 });
  }

  // Resolve binaryPath to the .cmd shim if it exists (npm global installs create .cmd on Windows)
  let cmdPath = binaryPath;
  if (!cmdPath.endsWith('.cmd')) {
    const candidate = cmdPath + '.cmd';
    if (fs.existsSync(candidate)) {
      cmdPath = candidate;
    }
  }

  // SECURITY: Validate binary path exists
  if (!fs.existsSync(cmdPath)) {
    throw new Error(`Startup binary not found: ${cmdPath}`);
  }

  // SECURITY: Reject paths with VBScript metacharacters to prevent injection
  if (/[^a-zA-Z0-9_\-./\\ :]/.test(cmdPath)) {
    throw new Error(`Startup binary path contains disallowed characters: ${cmdPath}`);
  }

  // Write a .vbs (VBScript) wrapper that launches the command with a hidden window.
  // A .bat would open a visible cmd.exe window on every login — bad UX.
  // WScript.Shell.Run with windowStyle 0 = hidden, False = don't wait.
  const vbsPath = getVbsPath();
  const escapedPath = cmdPath.replace(/"/g, '""');
  const vbsContent = `CreateObject("WScript.Shell").Run """${escapedPath}"" connect --quiet --tunnel", 0, False\r\n`;
  fs.writeFileSync(vbsPath, vbsContent, { mode: 0o600 });

  // Use HKCU Run key — no admin required, runs on user logon
  execSync(
    `reg add "${REG_KEY}" /v ${REG_VALUE} /t REG_SZ /d "\\"${vbsPath}\\"" /f`,
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

  // Clean up startup scripts
  const startupDir = getStartupDir();
  for (const file of ['startup.vbs', 'startup.bat']) {
    try {
      const p = path.join(startupDir, file);
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
    } catch {
      // Non-critical
    }
  }
}

async function enableStartupMacOS(binaryPath: string): Promise<void> {
  // Remove existing first (idempotent)
  await disableStartupMacOS();

  const configDir = path.join(os.homedir(), '.config', 'forkoff-cli');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
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
    fs.mkdirSync(launchAgentsDir, { recursive: true, mode: 0o700 });
  }

  fs.writeFileSync(plistPath, plist, { mode: 0o600 });

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
