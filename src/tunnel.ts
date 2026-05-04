import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';

const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 5000;
const URL_TIMEOUT_MS = 30000;

export interface TunnelManagerEvents {
  url_changed: (url: string) => void;
  error: (error: Error) => void;
  retry: (attempt: number, maxRetries: number) => void;
}

export class TunnelManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private currentUrl: string | null = null;
  private retryCount = 0;
  private stopped = false;
  private cloudflaredPath: string;

  constructor(cloudflaredPath?: string) {
    super();
    // Default to full path on Windows since cloudflared may not be in PATH
    if (cloudflaredPath) {
      this.cloudflaredPath = cloudflaredPath;
    } else if (process.platform === 'win32') {
      // Try common locations
      const candidates = [
        'D:\\software\\cloudflared.exe',
        'C:\\Program Files\\cloudflared\\cloudflared.exe',
        'cloudflared',
      ];
      this.cloudflaredPath = candidates.find(p => {
        try { return require('fs').existsSync(p); } catch { return false; }
      }) || 'cloudflared';
    } else {
      this.cloudflaredPath = 'cloudflared';
    }
  }

  async start(localPort: number = 3000): Promise<string> {
    this.stopped = false;
    this.retryCount = 0;
    return this.spawnProcess(localPort);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.process) {
      try {
        this.process.kill('SIGTERM');
        // Give it 3 seconds to exit gracefully
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            try { this.process?.kill('SIGKILL'); } catch {}
            resolve();
          }, 3000);
          this.process!.on('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      } catch {}
      this.process = null;
    }
    this.currentUrl = null;
  }

  getCurrentUrl(): string | null {
    return this.currentUrl;
  }

  private spawnProcess(localPort: number): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        const args = ['tunnel', '--url', `http://localhost:${localPort}`];

        this.process = spawn(this.cloudflaredPath, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });

        let urlResolved = false;
        let stderrOutput = '';

        this.process.stdout!.on('data', (data: Buffer) => {
          const text = data.toString();
          const match = text.match(TUNNEL_URL_REGEX);
          if (match && !urlResolved) {
            urlResolved = true;
            this.currentUrl = match[0];
            this.retryCount = 0;
            this.emit('url_changed', this.currentUrl);
            resolve(this.currentUrl);
          }
        });

        this.process.stderr!.on('data', (data: Buffer) => {
          const text = data.toString();
          stderrOutput += text;
          // cloudflared outputs the URL to stderr too
          const match = text.match(TUNNEL_URL_REGEX);
          if (match && !urlResolved) {
            urlResolved = true;
            this.currentUrl = match[0];
            this.retryCount = 0;
            this.emit('url_changed', this.currentUrl);
            resolve(this.currentUrl);
          }
        });

        this.process.on('error', (err: Error) => {
          if (!urlResolved) {
            urlResolved = true;
            reject(new Error(`Failed to start cloudflared: ${err.message}. Install with: winget install cloudflare.cloudflared`));
          }
          this.emit('error', err);
        });

        this.process.on('exit', (code) => {
          this.process = null;
          if (this.stopped) return;

          if (!urlResolved) {
            urlResolved = true;
            // Process exited before we got a URL — retry
            this.handleCrash(localPort, reject);
            return;
          }

          // Process exited after we had a URL — auto-restart
          console.log(`[Tunnel] cloudflared exited with code ${code}, restarting...`);
          this.handleCrash(localPort, () => {});
        });

        // Timeout waiting for URL
        setTimeout(() => {
          if (!urlResolved) {
            urlResolved = true;
            this.process?.kill();
            reject(new Error(`Timed out waiting for tunnel URL. cloudflared output:\n${stderrOutput.slice(-500)}`));
          }
        }, URL_TIMEOUT_MS);

      } catch (err: any) {
        reject(new Error(`Failed to spawn cloudflared: ${err.message}. Install with: winget install cloudflare.cloudflared`));
      }
    });
  }

  private async handleCrash(localPort: number, initialReject: (err: Error) => void): Promise<void> {
    if (this.stopped) return;

    this.retryCount++;
    if (this.retryCount > MAX_RETRIES) {
      const err = new Error(`cloudflared exited ${MAX_RETRIES} times — giving up`);
      this.emit('error', err);
      initialReject(err);
      return;
    }

    this.emit('retry', this.retryCount, MAX_RETRIES);
    console.log(`[Tunnel] Restart attempt ${this.retryCount}/${MAX_RETRIES} in ${RETRY_DELAY_MS / 1000}s...`);

    await new Promise(r => setTimeout(r, RETRY_DELAY_MS));

    if (this.stopped) return;

    try {
      const newUrl = await this.spawnProcess(localPort);
      console.log(`[Tunnel] Tunnel restarted: ${newUrl}`);
    } catch (err: any) {
      // spawnProcess will have already called handleCrash recursively if retryable
      this.emit('error', err);
    }
  }
}
