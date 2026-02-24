/**
 * Cloud relay client — CLI connects as a Socket.io CLIENT to the relay server
 * (e.g., wss://api.forkoff.app). The relay routes events to/from the paired mobile.
 * Same interface as EmbeddedRelayServer so WebSocketClient can use either.
 */
import { io, Socket } from 'socket.io-client';
import { EventEmitter } from 'events';
import { config } from './config';

/** Events the cloud relay forwards from mobile → CLI (same set as EmbeddedRelayServer) */
const MOBILE_EVENTS = [
  'terminal_command', 'terminal_create', 'user_message',
  'claude_start_session', 'claude_resume_session', 'claude_sessions_request',
  'directory_list', 'read_file', 'transcript_fetch', 'transcript_subscribe',
  'transcript_unsubscribe', 'approval_response', 'claude_approval_response',
  'permission_response', 'permission_rules_sync', 'claude_abort', 'tab_complete',
  'subscribe_device', 'unsubscribe_device',
  'encrypted_key_exchange_init', 'encrypted_key_exchange_ack', 'encrypted_message',
  'sdk_session_history', 'usage_stats_request', 'session_settings_update',
  'transcript_subscribe_sdk',
];

export interface CloudRelayOptions {
  url: string;
  deviceId: string;
  deviceName: string;
  relayToken?: string | null;
}

export class CloudRelayClient extends EventEmitter {
  private socket: Socket | null = null;
  private url: string;
  private deviceId: string;
  private deviceName: string;
  private relayToken: string | null;
  /** The pairing code the CLI generated — sent to relay for registration */
  private currentPairingCode: string | null = null;

  constructor(options: CloudRelayOptions) {
    super();
    this.url = options.url;
    this.deviceId = options.deviceId;
    this.deviceName = options.deviceName;
    this.relayToken = options.relayToken ?? null;
  }

  /** Set the pairing code — will be registered with the relay on connect */
  setPairingCode(code: string): void {
    this.currentPairingCode = code;
    // If already connected, register immediately
    if (this.socket?.connected) {
      this.socket.emit('register_pairing_code', {
        code,
        deviceId: this.deviceId,
        deviceName: this.deviceName,
        platform: process.platform,
      });
    }
  }

  /** Connect to the cloud relay as a CLI client */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = io(this.url, {
        auth: {
          clientType: 'cli',
          deviceId: this.deviceId,
          deviceName: this.deviceName,
          platform: process.platform,
          hostname: require('os').hostname(),
          relayToken: this.relayToken,
          userId: config.userId,
        },
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 15000,
        timeout: 10000,
      });

      let resolved = false;

      this.socket.on('connect', () => {
        console.log(`[CloudRelay] Connected to ${this.url}`);

        // Register pairing code if we have one
        if (this.currentPairingCode) {
          this.socket!.emit('register_pairing_code', {
            code: this.currentPairingCode,
            deviceId: this.deviceId,
            deviceName: this.deviceName,
            platform: process.platform,
          });
        }

        if (!resolved) {
          resolved = true;
          resolve();
        }
      });

      this.socket.on('connect_error', (err) => {
        console.error(`[CloudRelay] Connection error: ${err.message}`);
        if (!resolved) {
          resolved = true;
          reject(new Error(`Failed to connect to cloud relay at ${this.url}: ${err.message}`));
        }
      });

      this.socket.on('disconnect', (reason) => {
        console.log(`[CloudRelay] Disconnected: ${reason}`);
      });

      // Handle cloud pairing flow: relay sends pair_device when mobile enters our code
      this.socket.on('pair_device', (data: any) => {
        console.log(`[CloudRelay] Pairing request received from mobile`);
        // Emit internally so WebSocketClient can handle it
        this.emit('pair_device', { mobileDeviceId: data.mobileDeviceId });

        // Send ack back through relay — relay will forward to mobile with mobileRelayToken
        this.socket!.emit('pair_device_ack', {
          deviceId: this.deviceId,
          deviceName: this.deviceName,
          platform: process.platform,
          mobileDeviceId: data.mobileDeviceId,
          pairId: data.pairId,
          cliRelayToken: data.cliRelayToken,
        });

        // Store relay credentials locally
        if (data.cliRelayToken) {
          config.relayToken = data.cliRelayToken;
          this.relayToken = data.cliRelayToken;
        }
        if (data.pairId) {
          config.pairId = data.pairId;
        }
      });

      // Handle mobile connected notification from relay
      this.socket.on('mobile_connected', (data: any) => {
        console.log(`[CloudRelay] Mobile connected: ${data.deviceId || 'unknown'}`);
        this.emit('mobile_connected', { deviceId: data.deviceId || data.mobileDeviceId });
      });

      // Handle mobile disconnected notification from relay
      this.socket.on('mobile_disconnected', (data: any) => {
        console.log(`[CloudRelay] Mobile disconnected`);
        this.emit('mobile_disconnected', { deviceId: data.deviceId, reason: data.reason || 'disconnected' });
      });

      // Forward all mobile events → internal EventEmitter (same as EmbeddedRelayServer)
      for (const event of MOBILE_EVENTS) {
        this.socket.on(event, (data: any) => {
          this.emit(event, data);
        });
      }
    });
  }

  /** Emit an event to the mobile client via the relay */
  emitToMobile(event: string, data: any): void {
    if (this.socket?.connected) {
      // Relay will route this to the paired mobile client
      this.socket.emit(event, data);
    }
  }

  /** Check if mobile is connected (based on relay notifications) */
  hasMobileConnection(): boolean {
    return this.socket?.connected ?? false;
  }

  /** Get the connected mobile device ID (set after pairing or mobile_connected) */
  getMobileDeviceId(): string | null {
    // The relay manages this — we don't track directly in cloud mode
    return null;
  }

  /** Graceful shutdown */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket) {
        this.socket.disconnect();
        this.socket = null;
      }
      resolve();
    });
  }
}
