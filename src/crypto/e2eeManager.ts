import axios, { AxiosInstance } from 'axios';
import { generateKeyPair } from './keyGeneration';
import {
  storePrivateKey,
  getPrivateKey,
  storeSessionKey,
  getSessionKey,
  clearSessionKeys,
} from './keyStorage';
import { performKeyExchange } from './keyExchange';
import { encrypt, decrypt } from './encryption';
import {
  E2EEKeyPair,
  KeyExchangeInit,
  KeyExchangeAck,
  EncryptedMessage,
} from './types';
import {
  persistSessionKey,
  loadPersistedSessionKey,
  deletePersistedSession,
  deleteAllPersistedSessions,
  listPersistedSessions,
} from './sessionPersistence';

/**
 * E2EE Manager for CLI
 * Orchestrates all end-to-end encryption operations
 */
export class E2EEManager {
  private deviceId: string;
  private apiUrl: string;
  private authToken: string;
  private keyPair: E2EEKeyPair | null = null;
  private initialized = false;

  // Track ephemeral keys for pending key exchanges
  private pendingKeyExchanges = new Map<string, string>(); // deviceId -> ephemeralPrivateKey

  // Track message counters for replay protection
  private outgoingCounters = new Map<string, number>(); // deviceId -> counter
  private incomingCounters = new Map<string, number>(); // deviceId -> last seen counter

  private axiosInstance: AxiosInstance;

  constructor(deviceId: string, apiUrl: string, authToken: string) {
    this.deviceId = deviceId;
    this.apiUrl = apiUrl;
    this.authToken = authToken;

    this.axiosInstance = axios.create({
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });
  }

  /**
   * Initializes E2EE manager
   * - Loads or generates key pair
   * - Uploads public key to backend
   */
  async initialize(): Promise<void> {
    // Try to load existing key pair
    const existingPrivateKey = await getPrivateKey(this.deviceId);

    if (existingPrivateKey) {
      // Derive public key from existing private key
      const publicKey = this.derivePublicKeyFromPrivateKey(existingPrivateKey);
      this.keyPair = {
        publicKey,
        privateKey: existingPrivateKey,
      };
    } else {
      // Generate new key pair
      this.keyPair = generateKeyPair();
      await storePrivateKey(this.deviceId, this.keyPair.privateKey);
    }

    // Upload public key to backend
    await this.uploadPublicKey();

    this.initialized = true;
  }

  /**
   * Derives X25519 public key from private key
   */
  private derivePublicKeyFromPrivateKey(privateKey: string): string {
    const crypto = require('crypto');
    const privateKeyBytes = Buffer.from(privateKey, 'base64');

    // Create private key object
    const privateKeyObject = crypto.createPrivateKey({
      key: Buffer.concat([
        Buffer.from([
          0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
          0x6e, 0x04, 0x22, 0x04, 0x20,
        ]),
        privateKeyBytes,
      ]),
      format: 'der',
      type: 'pkcs8',
    });

    // Derive public key
    const publicKeyObject = crypto.createPublicKey(privateKeyObject);
    const publicKeyDER = publicKeyObject.export({
      type: 'spki',
      format: 'der',
    }) as Buffer;

    // Extract raw 32-byte public key
    const rawPublicKey = publicKeyDER.slice(-32);
    return rawPublicKey.toString('base64');
  }

  /**
   * Uploads public key to backend
   */
  private async uploadPublicKey(): Promise<void> {
    if (!this.keyPair) {
      throw new Error('Key pair not initialized');
    }

    await this.axiosInstance.put(
      `${this.apiUrl}/devices/${this.deviceId}/public-key`,
      { publicKey: this.keyPair.publicKey }
    );
  }

  /**
   * Initiates key exchange with target device
   * Returns payload to send via WebSocket
   */
  async initiateKeyExchange(targetDeviceId: string): Promise<KeyExchangeInit> {
    if (!this.keyPair) {
      throw new Error('E2EE Manager not initialized');
    }

    // Generate ephemeral key pair for this exchange
    const ephemeralKeyPair = generateKeyPair();

    // Store ephemeral private key for when we receive ack
    this.pendingKeyExchanges.set(targetDeviceId, ephemeralKeyPair.privateKey);

    // Fetch target device's public key
    const response = await this.axiosInstance.get(
      `${this.apiUrl}/devices/${targetDeviceId}/public-key`
    );

    const targetPublicKey = response.data.publicKey;

    // Compute session key using our ephemeral private key and their public key
    const sessionKey = performKeyExchange(
      ephemeralKeyPair.privateKey,
      targetPublicKey
    );

    // Store session key (in memory and on disk for reconnection resilience)
    const sessionId = `session-${this.deviceId}-${targetDeviceId}-${Date.now()}`;
    const sessionKeys = { encryptionKey: sessionKey, sessionId };
    storeSessionKey(targetDeviceId, sessionKey, sessionId);
    persistSessionKey(this.deviceId, targetDeviceId, sessionKeys); // Persist to disk

    // Initialize counters
    this.outgoingCounters.set(targetDeviceId, 0);
    this.incomingCounters.set(targetDeviceId, -1); // Start at -1 so first message (counter: 0) is accepted

    return {
      senderDeviceId: this.deviceId,
      ephemeralPublicKey: ephemeralKeyPair.publicKey,
    };
  }

  /**
   * Handles incoming key exchange init from sender
   * Returns ack payload to send back via WebSocket
   */
  async handleKeyExchangeInit(
    senderDeviceId: string,
    senderEphemeralPublicKey: string
  ): Promise<KeyExchangeAck> {
    if (!this.keyPair) {
      throw new Error('E2EE Manager not initialized');
    }

    // Generate our ephemeral key pair
    const ephemeralKeyPair = generateKeyPair();

    // Compute session key using our ephemeral private key and their ephemeral public key
    const sessionKey = performKeyExchange(
      ephemeralKeyPair.privateKey,
      senderEphemeralPublicKey
    );

    // Store session key (in memory and on disk for reconnection resilience)
    const sessionId = `session-${senderDeviceId}-${this.deviceId}-${Date.now()}`;
    const sessionKeys = { encryptionKey: sessionKey, sessionId };
    storeSessionKey(senderDeviceId, sessionKey, sessionId);
    persistSessionKey(this.deviceId, senderDeviceId, sessionKeys); // Persist to disk

    // Initialize counters
    this.outgoingCounters.set(senderDeviceId, 0);
    this.incomingCounters.set(senderDeviceId, -1); // Start at -1 so first message (counter: 0) is accepted

    return {
      recipientDeviceId: this.deviceId,
      ephemeralPublicKey: ephemeralKeyPair.publicKey,
    };
  }

  /**
   * Handles incoming key exchange ack from recipient
   * Completes the key exchange by deriving the final session key
   */
  async handleKeyExchangeAck(
    recipientDeviceId: string,
    recipientEphemeralPublicKey: string
  ): Promise<void> {
    const ephemeralPrivateKey = this.pendingKeyExchanges.get(recipientDeviceId);

    if (!ephemeralPrivateKey) {
      throw new Error(
        'No pending key exchange for this device. Must call initiateKeyExchange first.'
      );
    }

    // Compute session key using our ephemeral private key and their ephemeral public key
    const sessionKey = performKeyExchange(
      ephemeralPrivateKey,
      recipientEphemeralPublicKey
    );

    // Store session key (overwrites the one from init, in memory and on disk)
    const sessionId = `session-${this.deviceId}-${recipientDeviceId}-${Date.now()}`;
    const sessionKeys = { encryptionKey: sessionKey, sessionId };
    storeSessionKey(recipientDeviceId, sessionKey, sessionId);
    persistSessionKey(this.deviceId, recipientDeviceId, sessionKeys); // Persist to disk

    // Clean up pending exchange
    this.pendingKeyExchanges.delete(recipientDeviceId);
  }

  /**
   * Attempts to restore a persisted session after reconnection
   * Useful when IP changes cause WebSocket disconnection
   */
  async restorePersistedSession(targetDeviceId: string): Promise<boolean> {
    const persistedKeys = loadPersistedSessionKey(this.deviceId, targetDeviceId);

    if (!persistedKeys) {
      return false;
    }

    // Restore session to memory
    storeSessionKey(
      targetDeviceId,
      persistedKeys.encryptionKey,
      persistedKeys.sessionId
    );

    // Reset counters (conservative approach - could be persisted too)
    this.outgoingCounters.set(targetDeviceId, 0);
    this.incomingCounters.set(targetDeviceId, -1);

    console.log(`[E2EE] Restored persisted session for ${targetDeviceId}`);
    return true;
  }

  /**
   * Lists all devices with persisted sessions
   * Useful for auto-reconnection after network changes
   */
  listPersistedDevices(): string[] {
    return listPersistedSessions(this.deviceId);
  }

  /**
   * Encrypts a message for a target device
   */
  encryptMessage(
    plaintext: string,
    targetDeviceId: string,
    sessionId: string
  ): EncryptedMessage {
    const sessionKeys = getSessionKey(targetDeviceId);

    if (!sessionKeys) {
      throw new Error(
        `No session key found for device ${targetDeviceId}. Must complete key exchange first.`
      );
    }

    // Encrypt message
    const encryptedPayload = encrypt(plaintext, sessionKeys.encryptionKey);

    // Get and increment counter
    const counter = this.outgoingCounters.get(targetDeviceId) ?? 0;
    this.outgoingCounters.set(targetDeviceId, counter + 1);

    return {
      senderDeviceId: this.deviceId,
      recipientDeviceId: targetDeviceId,
      sessionId,
      payload: encryptedPayload,
      messageCounter: counter,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Decrypts a message from a sender device
   */
  decryptMessage(
    encryptedMessage: EncryptedMessage,
    senderDeviceId: string
  ): string {
    const sessionKeys = getSessionKey(senderDeviceId);

    if (!sessionKeys) {
      throw new Error(
        `No session key found for device ${senderDeviceId}. Key exchange not completed.`
      );
    }

    // Replay protection: check message counter
    const lastCounter = this.incomingCounters.get(senderDeviceId) ?? -1;

    if (encryptedMessage.messageCounter <= lastCounter) {
      throw new Error(
        `Invalid message counter. Possible replay attack. Expected > ${lastCounter}, got ${encryptedMessage.messageCounter}`
      );
    }

    // Update last seen counter
    this.incomingCounters.set(senderDeviceId, encryptedMessage.messageCounter);

    // Decrypt message
    const plaintext = decrypt(
      encryptedMessage.payload,
      sessionKeys.encryptionKey
    );

    return plaintext;
  }

  /**
   * Checks if a session key exists for a device
   */
  hasSessionKey(deviceId: string): boolean {
    return getSessionKey(deviceId) !== null;
  }

  /**
   * Checks if manager is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Cleans up all session keys and pending exchanges
   * @param deletePersisted - Whether to delete persisted sessions from disk (default: false)
   */
  cleanup(deletePersisted = false): void {
    clearSessionKeys();
    this.pendingKeyExchanges.clear();
    this.outgoingCounters.clear();
    this.incomingCounters.clear();

    // Optionally delete persisted sessions
    if (deletePersisted) {
      deleteAllPersistedSessions(this.deviceId);
    }
  }

  /**
   * Removes a specific persisted session
   */
  removePersistedSession(targetDeviceId: string): void {
    deletePersistedSession(this.deviceId, targetDeviceId);
  }
}
