import { WebSocketClient } from '../websocket';
import { E2EEManager } from './e2eeManager';
import { EncryptedMessage } from './types';

/**
 * WebSocket E2EE Integration
 * Adds end-to-end encryption capabilities to WebSocket client
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
  async initialize(deviceId: string, apiUrl: string, authToken: string): Promise<void> {
    this.e2eeManager = new E2EEManager(deviceId, apiUrl, authToken);
    await this.e2eeManager.initialize();
    this.setupEventHandlers();
    this.enabled = true;
  }

  /**
   * Sets up WebSocket event handlers for E2EE
   */
  private setupEventHandlers(): void {
    if (!this.e2eeManager) return;

    // Handle incoming key exchange init
    this.wsClient.on('encrypted_key_exchange_init', async (data: {
      senderDeviceId: string;
      ephemeralPublicKey: string;
    }) => {
      if (!this.e2eeManager) return;

      try {
        // Handle key exchange and send ack
        const ackPayload = await this.e2eeManager.handleKeyExchangeInit(
          data.senderDeviceId,
          data.ephemeralPublicKey
        );

        // Emit ack back to sender
        this.emitKeyExchangeAck(data.senderDeviceId, ackPayload.ephemeralPublicKey);
      } catch (error) {
        console.error('[E2EE] Failed to handle key exchange init:', error);
      }
    });

    // Handle incoming key exchange ack
    this.wsClient.on('encrypted_key_exchange_ack', async (data: {
      senderDeviceId: string;
      ephemeralPublicKey: string;
    }) => {
      if (!this.e2eeManager) return;

      try {
        await this.e2eeManager.handleKeyExchangeAck(
          data.senderDeviceId,
          data.ephemeralPublicKey
        );

        console.log(`[E2EE] Key exchange completed with ${data.senderDeviceId}`);
      } catch (error) {
        console.error('[E2EE] Failed to handle key exchange ack:', error);
      }
    });

    // Handle incoming encrypted messages
    this.wsClient.on('encrypted_message', (data: EncryptedMessage) => {
      if (!this.e2eeManager) return;

      try {
        const plaintext = this.e2eeManager.decryptMessage(data, data.senderDeviceId);

        // Emit decrypted message as a regular user_message event
        this.wsClient.emit('decrypted_message', {
          ...data,
          decryptedContent: plaintext,
        });
      } catch (error) {
        console.error('[E2EE] Failed to decrypt message:', error);
      }
    });
  }

  /**
   * Initiates key exchange with a target device
   */
  async initiateKeyExchange(targetDeviceId: string): Promise<void> {
    if (!this.e2eeManager) {
      throw new Error('E2EE not initialized');
    }

    const initPayload = await this.e2eeManager.initiateKeyExchange(targetDeviceId);

    // Emit key exchange init via WebSocket
    this.emitKeyExchangeInit(targetDeviceId, initPayload.ephemeralPublicKey);
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

    // Emit encrypted message via WebSocket
    this.emitEncryptedMessage(encryptedMessage);
  }

  /**
   * Checks if E2EE session exists for a device
   */
  hasSession(deviceId: string): boolean {
    return this.e2eeManager?.hasSessionKey(deviceId) ?? false;
  }

  /**
   * Checks if E2EE is enabled
   */
  isEnabled(): boolean {
    return this.enabled && this.e2eeManager !== null;
  }

  /**
   * Cleans up E2EE sessions
   */
  cleanup(): void {
    this.e2eeManager?.cleanup();
  }

  // Private WebSocket emit methods

  private emitKeyExchangeInit(recipientDeviceId: string, ephemeralPublicKey: string): void {
    // Access the internal socket via type casting
    const socket = (this.wsClient as any).socket;
    if (socket) {
      socket.emit('encrypted_key_exchange_init', {
        recipientDeviceId,
        senderDeviceId: this.e2eeManager?.['deviceId'],
        ephemeralPublicKey,
      });
    }
  }

  private emitKeyExchangeAck(recipientDeviceId: string, ephemeralPublicKey: string): void {
    const socket = (this.wsClient as any).socket;
    if (socket) {
      socket.emit('encrypted_key_exchange_ack', {
        recipientDeviceId,
        senderDeviceId: this.e2eeManager?.['deviceId'],
        ephemeralPublicKey,
      });
    }
  }

  private emitEncryptedMessage(message: EncryptedMessage): void {
    const socket = (this.wsClient as any).socket;
    if (socket) {
      socket.emit('encrypted_message', message);
    }
  }
}

/**
 * Factory function to create E2EE-enabled WebSocket client
 */
export function createE2EEWebSocketClient(
  wsClient: WebSocketClient,
  deviceId: string,
  apiUrl: string,
  authToken: string
): Promise<WebSocketE2EEIntegration> {
  const integration = new WebSocketE2EEIntegration(wsClient);
  return integration.initialize(deviceId, apiUrl, authToken).then(() => integration);
}
