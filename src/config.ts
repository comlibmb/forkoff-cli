import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { machineIdSync } from 'node-machine-id';
import { v4 as uuidv4 } from 'uuid';

// SECURITY: Helper to check if URL is local (allows insecure connections for local dev)
function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' ||
           host === '127.0.0.1' ||
           host.startsWith('192.168.') ||
           host.startsWith('10.') ||
           host.startsWith('172.16.') ||
           host.startsWith('172.17.') ||
           host.startsWith('172.18.') ||
           host.startsWith('172.19.') ||
           host.startsWith('172.2') ||
           host.startsWith('172.30.') ||
           host.startsWith('172.31.');
  } catch {
    return false;
  }
}

// SECURITY: Enforce secure protocol for non-local URLs
function enforceSecureUrl(url: string, type: 'api' | 'ws'): string {
  if (isLocalUrl(url)) {
    return url; // Allow insecure for local development
  }

  // For non-local URLs, enforce HTTPS/WSS
  if (type === 'api' && url.startsWith('http://')) {
    console.warn('[Config] SECURITY: Upgrading insecure API URL to HTTPS');
    return url.replace('http://', 'https://');
  }
  if (type === 'ws' && url.startsWith('ws://')) {
    console.warn('[Config] SECURITY: Upgrading insecure WebSocket URL to WSS');
    return url.replace('ws://', 'wss://');
  }

  return url;
}

interface DeviceConfig {
  deviceId: string | null;
  deviceName: string;
  apiUrl: string;
  wsUrl: string;
  pairingCode: string | null;
  pairedAt: string | null;
  userId: string | null;
  machineId?: string;
  startupEnabled: boolean | null;
  startupBinaryPath: string | null;
}

const defaultConfig: DeviceConfig = {
  deviceId: null,
  deviceName: os.hostname(),
  apiUrl: 'https://api.forkoff.app/api',
  wsUrl: 'wss://api.forkoff.app',
  pairingCode: null,
  pairedAt: null,
  userId: null,
  startupEnabled: null,
  startupBinaryPath: null,
};

class Config {
  private configPath: string;
  private data: DeviceConfig;

  constructor() {
    this.configPath = this.getConfigPath();
    this.data = this.load();
  }

  private getConfigPath(): string {
    const configDir = process.platform === 'win32'
      ? path.join(process.env.APPDATA || os.homedir(), 'forkoff-cli')
      : path.join(os.homedir(), '.config', 'forkoff-cli');

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    return path.join(configDir, 'config.json');
  }

  private load(): DeviceConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const content = fs.readFileSync(this.configPath, 'utf-8');
        return { ...defaultConfig, ...JSON.parse(content) };
      }
    } catch (error) {
      // If config is corrupted, use defaults
    }
    return { ...defaultConfig };
  }

  private save(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.data, null, 2));
  }

  get deviceId(): string | null {
    return this.data.deviceId;
  }

  set deviceId(value: string | null) {
    this.data.deviceId = value;
    this.save();
  }

  get deviceName(): string {
    return this.data.deviceName;
  }

  set deviceName(value: string) {
    this.data.deviceName = value;
    this.save();
  }

  get apiUrl(): string {
    // SECURITY: Enforce HTTPS for non-local URLs
    return enforceSecureUrl(this.data.apiUrl, 'api');
  }

  set apiUrl(value: string) {
    // SECURITY: Enforce HTTPS for non-local URLs when setting
    this.data.apiUrl = enforceSecureUrl(value, 'api');
    this.save();
  }

  get wsUrl(): string {
    // SECURITY: Enforce WSS for non-local URLs
    return enforceSecureUrl(this.data.wsUrl, 'ws');
  }

  set wsUrl(value: string) {
    // SECURITY: Enforce WSS for non-local URLs when setting
    this.data.wsUrl = enforceSecureUrl(value, 'ws');
    this.save();
  }

  get pairingCode(): string | null {
    return this.data.pairingCode;
  }

  set pairingCode(value: string | null) {
    this.data.pairingCode = value;
    this.save();
  }

  get pairedAt(): string | null {
    return this.data.pairedAt;
  }

  set pairedAt(value: string | null) {
    this.data.pairedAt = value;
    this.save();
  }

  get userId(): string | null {
    return this.data.userId;
  }

  set userId(value: string | null) {
    this.data.userId = value;
    this.save();
  }

  get startupEnabled(): boolean | null {
    return this.data.startupEnabled;
  }

  set startupEnabled(value: boolean | null) {
    this.data.startupEnabled = value;
    this.save();
  }

  get startupBinaryPath(): string | null {
    return this.data.startupBinaryPath;
  }

  set startupBinaryPath(value: string | null) {
    this.data.startupBinaryPath = value;
    this.save();
  }

  get isPaired(): boolean {
    return !!this.userId && !!this.deviceId;
  }

  // Get unique machine identifier
  getMachineId(): string {
    try {
      return machineIdSync();
    } catch {
      // Fallback to stored or new UUID
      if (!this.data.machineId) {
        this.data.machineId = uuidv4();
        this.save();
      }
      return this.data.machineId!;
    }
  }

  // Get device info for registration
  getDeviceInfo() {
    return {
      name: this.deviceName,
      type: 'desktop' as const,
      platform: os.platform(),
      hostname: os.hostname(),
      machineId: this.getMachineId(),
    };
  }

  // Reset all config
  reset(): void {
    this.data = { ...defaultConfig };
    this.save();
  }

  // Get config file path
  getPath(): string {
    return this.configPath;
  }
}

export const config = new Config();
export default config;
