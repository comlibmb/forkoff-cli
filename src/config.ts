import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { machineIdSync } from 'node-machine-id';
import { v4 as uuidv4 } from 'uuid';

interface DeviceConfig {
  deviceId: string | null;
  deviceName: string;
  apiUrl: string;
  wsUrl: string;
  pairingCode: string | null;
  pairedAt: string | null;
  userId: string | null;
  machineId?: string;
}

const defaultConfig: DeviceConfig = {
  deviceId: null,
  deviceName: os.hostname(),
  apiUrl: 'http://localhost:3000/api',
  wsUrl: 'ws://localhost:3000',
  pairingCode: null,
  pairedAt: null,
  userId: null,
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
    return this.data.apiUrl;
  }

  set apiUrl(value: string) {
    this.data.apiUrl = value;
    this.save();
  }

  get wsUrl(): string {
    return this.data.wsUrl;
  }

  set wsUrl(value: string) {
    this.data.wsUrl = value;
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
