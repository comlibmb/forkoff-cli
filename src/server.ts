/**
 * Embedded relay server — turns the CLI into a Socket.io server.
 * Mobile connects directly to the CLI over the local network.
 * No rooms, no multi-device routing — just one CLI serving mobile connections.
 */
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { Server, Socket as ServerSocket } from 'socket.io';
import { EventEmitter } from 'events';

/** Events the server forwards from mobile → CLI (internal EventEmitter) */
const MOBILE_EVENTS = [
  'terminal_command', 'terminal_create', 'user_message',
  'claude_start_session', 'claude_resume_session', 'claude_sessions_request',
  'directory_list', 'read_file', 'transcript_fetch', 'transcript_subscribe',
  'transcript_unsubscribe', 'approval_response', 'claude_approval_response',
  'permission_response', 'permission_rules_sync', 'claude_abort', 'tab_complete',
  'subscribe_device', 'unsubscribe_device',
  'encrypted_key_exchange_init', 'encrypted_key_exchange_ack', 'encrypted_message',
];

export interface EmbeddedServerOptions {
  port: number;
  deviceId: string;
  deviceName: string;
}

export class EmbeddedRelayServer extends EventEmitter {
  private httpServer: ReturnType<typeof createServer> | null = null;
  private io: Server | null = null;
  private mobileSocket: ServerSocket | null = null;
  private port: number;
  private deviceId: string;
  private deviceName: string;
  /** The pairing code the CLI generated — validated in-process */
  private currentPairingCode: string | null = null;

  constructor(options: EmbeddedServerOptions) {
    super();
    this.port = options.port;
    this.deviceId = options.deviceId;
    this.deviceName = options.deviceName;
  }

  /** Set the pairing code for in-process validation */
  setPairingCode(code: string): void {
    this.currentPairingCode = code;
  }

  /** Start the HTTP + Socket.io server */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (req.url === '/health' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', mode: 'embedded' }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      this.io = new Server(this.httpServer, {
        cors: {
          origin: '*',
          methods: ['GET', 'POST'],
        },
        transports: ['websocket', 'polling'],
      });

      // Auth middleware — only accept mobile clients
      this.io.use((socket, next) => {
        const auth = socket.handshake.auth;
        if (auth.clientType !== 'mobile') {
          return next(new Error('CLI only accepts mobile connections'));
        }
        if (!auth.mobileDeviceId || auth.mobileDeviceId.length < 8) {
          return next(new Error('Invalid mobileDeviceId'));
        }
        socket.data = {
          clientType: 'mobile',
          deviceId: auth.mobileDeviceId,
          deviceName: auth.deviceName || 'Mobile',
        };
        next();
      });

      this.io.on('connection', (socket) => {
        const devId = socket.data.deviceId || 'unknown';
        console.log(`[Server] Mobile connected: ${devId.length > 8 ? devId.substring(0, 8) + '...' : devId}`);

        // Track the mobile socket (only one active connection)
        if (this.mobileSocket) {
          console.log(`[Server] Replacing existing mobile connection`);
          this.mobileSocket.disconnect(true);
        }
        this.mobileSocket = socket;
        this.emit('mobile_connected', { deviceId: socket.data.deviceId });

        // Handle pairing
        socket.on('pair_device', (data: any) => {
          if (this.currentPairingCode && data.pairingCode === this.currentPairingCode) {
            console.log(`[Server] Pairing successful`);
            // Notify internal listeners (wsClient)
            this.emit('pair_device', { mobileDeviceId: socket.data.deviceId });
            // Send ack directly to mobile
            socket.emit('pair_device_ack', {
              deviceId: this.deviceId,
              deviceName: this.deviceName,
              platform: process.platform,
              mobileDeviceId: socket.data.deviceId,
            });
          } else {
            console.log(`[Server] Pairing rejected — invalid code`);
            socket.emit('pair_device_reject', { reason: 'Invalid pairing code' });
          }
        });

        // Forward all mobile events → internal EventEmitter
        for (const event of MOBILE_EVENTS) {
          socket.on(event, (data: any) => {
            this.emit(event, data);
          });
        }

        socket.on('disconnect', (reason) => {
          console.log(`[Server] Mobile disconnected: ${reason}`);
          if (this.mobileSocket === socket) {
            this.mobileSocket = null;
          }
          this.emit('mobile_disconnected', { deviceId: socket.data.deviceId, reason });
        });
      });

      this.httpServer.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${this.port} is already in use. Use "forkoff config --port <port>" to change it.`));
        } else {
          reject(err);
        }
      });

      this.httpServer.listen(this.port, '0.0.0.0', () => {
        console.log(`[Server] Listening on 0.0.0.0:${this.port}`);
        resolve();
      });
    });
  }

  /** Emit an event to the connected mobile socket */
  emitToMobile(event: string, data: any): void {
    if (this.mobileSocket) {
      this.mobileSocket.emit(event, data);
    }
  }

  /** Check if a mobile client is connected */
  hasMobileConnection(): boolean {
    return this.mobileSocket !== null && this.mobileSocket.connected;
  }

  /** Get the connected mobile device ID (for E2EE targeting) */
  getMobileDeviceId(): string | null {
    return this.mobileSocket?.data?.deviceId ?? null;
  }

  /** Graceful shutdown */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.io) {
        this.io.close(() => {
          this.httpServer?.close(() => resolve());
        });
      } else if (this.httpServer) {
        this.httpServer.close(() => resolve());
      } else {
        resolve();
      }
      this.mobileSocket = null;
    });
  }
}
