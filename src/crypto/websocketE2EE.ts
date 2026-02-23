import { WebSocketClient } from '../websocket';
import { E2EEManager } from './e2eeManager';
import { EncryptedMessage, KeyExchangeInit, KeyExchangeAck } from './types';

/**
 * WebSocket E2EE Integration (legacy wrapper)
 * E2EE is now wired directly into WebSocketClient.
 * This class remains for backward compatibility.
 */
export class WebSocketE2EEIntegration {
  private wsClient: WebSocketClient;
  private e2eeManager: E2EEManager | null = null;
  private enabled = false;

  constructor(wsClient: WebSocketClient) {
    this.wsClient = wsClient;
  }

  /**
   * Initializes E2EE and sets up event handlers
   */
  async initialize(deviceId: string): Promise<void> {
    this.e2eeManager = new E2EEManager(deviceId);
    await this.e2eeManager.initialize();
    this.setupEventHandlers();
    this.enabled = true;
  }

  private setupEventHandlers(): void {
    if (!this.e2eeManager) return;

    // Handle incoming key exchange init
    this.wsClient.on('encrypted_key_exchange_init', (data: KeyExchangeInit) => {
      if (!this.e2eeManager) return;
      try {
        const ack = this.e2eeManager.handleKeyExchangeInit(data);
        this.emitKeyExchangeAck(data.senderDeviceId, ack.ephemeralPublicKey);
      } catch (error) {
        console.error('[E2EE] Failed to handle key exchange init:', (error as Error).message);
      }
    });

    // Handle incoming key exchange ack
    this.wsClient.on('encrypted_key_exchange_ack', (data: KeyExchangeAck) => {
      if (!this.e2eeManager) return;
      try {
        this.e2eeManager.handleKeyExchangeAck(data);
        console.log(`[E2EE] Key exchange completed with ${data.senderDeviceId}`);
      } catch (error) {
        console.error('[E2EE] Failed to handle key exchange ack:', (error as Error).message);
      }
    });

    // Handle incoming encrypted messages
    this.wsClient.on('encrypted_message', (data: EncryptedMessage) => {
      if (!this.e2eeManager) return;
      try {
        const plaintext = this.e2eeManager.decryptMessage(data, data.senderDeviceId);
        this.wsClient.emit('decrypted_message', {
          ...data,
          decryptedContent: plaintext,
        });
      } catch (error) {
        console.error('[E2EE] Failed to decrypt message:', (error as Error).message);
      }
    });
  }

  /**
   * Initiates key exchange with a target device
   */
  initiateKeyExchange(targetDeviceId: string): void {
    if (!this.e2eeManager) {
      throw new Error('E2EE not initialized');
    }

    const init = this.e2eeManager.createKeyExchangeInit(targetDeviceId);
    this.emitKeyExchangeInit(targetDeviceId, init.ephemeralPublicKey);
  }

  /**
   * Encrypts and sends a message to a target device
   */
  sendEncryptedMessage(
    plaintext: string,
    targetDeviceId: string,
    sessionId: string
  ): void {
    if (!this.e2eeManager) {
      throw new Error('E2EE not initialized');
    }

    if (!this.e2eeManager.hasSessionKey(targetDeviceId)) {
      throw new Error(
        `No E2EE session with ${targetDeviceId}. Must complete key exchange first.`
      );
    }

    const encryptedMessage = this.e2eeManager.encryptMessage(
      plaintext,
      targetDeviceId,
      sessionId
    );

    this.emitEncryptedMessage(encryptedMessage);
  }

  hasSession(deviceId: string): boolean {
    return this.e2eeManager?.hasSessionKey(deviceId) ?? false;
  }

  isEnabled(): boolean {
    return this.enabled && this.e2eeManager !== null;
  }

  cleanup(): void {
    this.e2eeManager?.cleanup();
  }

  private emitKeyExchangeInit(recipientDeviceId: string, ephemeralPublicKey: string): void {
    this.wsClient.emitKeyExchangeInit({
      recipientDeviceId,
      senderDeviceId: (this.e2eeManager as any)?.deviceId || '',
      ephemeralPublicKey,
    });
  }

  private emitKeyExchangeAck(recipientDeviceId: string, ephemeralPublicKey: string): void {
    this.wsClient.emitKeyExchangeAck({
      recipientDeviceId,
      senderDeviceId: (this.e2eeManager as any)?.deviceId || '',
      ephemeralPublicKey,
    });
  }

  private emitEncryptedMessage(message: EncryptedMessage): void {
    this.wsClient.emitEncryptedMessage(message);
  }
}

/**
 * Factory function to create E2EE-enabled WebSocket client
 */
export function createE2EEWebSocketClient(
  wsClient: WebSocketClient,
  deviceId: string,
): Promise<WebSocketE2EEIntegration> {
  const integration = new WebSocketE2EEIntegration(wsClient);
  return integration.initialize(deviceId).then(() => integration);
}
