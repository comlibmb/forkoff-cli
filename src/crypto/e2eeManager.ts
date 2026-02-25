/**
 * E2EE Manager for CLI
 * Orchestrates key generation, storage, exchange, and message encryption/decryption.
 * Uses NaCl (tweetnacl) — compatible with mobile app's implementation.
 *
 * Security features:
 * - X25519 ECDH key exchange for shared secret derivation
 * - Ed25519 identity signatures on ephemeral keys (MITM protection)
 * - TOFU (Trust On First Use) for peer identity verification
 * - XSalsa20-Poly1305 authenticated encryption
 * - Per-peer monotonic message counters (replay protection)
 */
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, decodeUTF8 } from 'tweetnacl-util';
import { generateKeyPair } from './keyGeneration';
import { computeSharedKey, deriveSessionKeys } from './keyExchange';
import { encrypt, decrypt } from './encryption';
import {
  storePrivateKey,
  getPrivateKey,
  storeSessionKey,
  getSessionKey,
  clearSessionKeys,
  storeSigningKeyPair,
  getSigningKeyPair,
  loadTrustedPeerKeys,
  getTrustedPeerKey,
  trustPeerKey,
  removeTrustedPeerKey,
} from './keyStorage';
import {
  initSessionPersistence,
  persistSessionKey,
  loadPersistedSessionKey,
  deletePersistedSession,
  deleteAllPersistedSessions,
  listPersistedSessions,
} from './sessionPersistence';
import {
  E2EEKeyPair,
  SigningKeyPair,
  KeyExchangeInit,
  KeyExchangeAck,
  EncryptedMessage,
  SessionKeys,
} from './types';

interface ActiveSession {
  sendKey: Uint8Array;
  receiveKey: Uint8Array;
  outgoingCounter: number;
  lastReceivedCounter: number;
  createdAt: number;
}

export class E2EEManager {
  private deviceId: string;
  private keyPair: E2EEKeyPair | null = null;
  private signingKeyPair: SigningKeyPair | null = null;
  private initialized = false;

  // In-memory active sessions (parallel to keyStorage for fast access)
  private sessions = new Map<string, ActiveSession>();

  // Session expiry limits — re-key required after either threshold
  private static readonly SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
  private static readonly SESSION_MAX_MESSAGES = 10_000;

  // Ephemeral keys for pending key exchanges (with creation timestamp for TTL)
  private static readonly MAX_PENDING_EXCHANGES = 20;
  private static readonly PENDING_EXCHANGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private pendingExchanges = new Map<string, { keyPair: E2EEKeyPair; createdAt: number }>();

  constructor(deviceId: string) {
    this.deviceId = deviceId;
  }

  /**
   * Initializes E2EE manager: loads or generates identity key pairs (DH + signing).
   */
  async initialize(): Promise<void> {
    // Load or generate X25519 DH key pair
    const existingPrivateKey = await getPrivateKey(this.deviceId);

    if (existingPrivateKey) {
      const secretKey = decodeBase64(existingPrivateKey);
      const kp = nacl.box.keyPair.fromSecretKey(secretKey);
      this.keyPair = {
        publicKey: encodeBase64(kp.publicKey),
        privateKey: existingPrivateKey,
      };
    } else {
      this.keyPair = generateKeyPair();
      await storePrivateKey(this.deviceId, this.keyPair.privateKey);
    }

    // Load or generate Ed25519 signing key pair
    const existingSigningKP = await getSigningKeyPair(this.deviceId);
    if (existingSigningKP) {
      this.signingKeyPair = existingSigningKP;
    } else {
      const signKP = nacl.sign.keyPair();
      this.signingKeyPair = {
        publicKey: encodeBase64(signKP.publicKey),
        secretKey: encodeBase64(signKP.secretKey),
      };
      await storeSigningKeyPair(this.deviceId, this.signingKeyPair);
    }

    // Load trusted peer keys from disk
    loadTrustedPeerKeys();

    // Initialize session persistence encryption (derives key from identity private key)
    initSessionPersistence(this.keyPair.privateKey);

    this.initialized = true;
  }

  /** Get the public key (for uploading to server) */
  getPublicKey(): string | null {
    return this.keyPair?.publicKey ?? null;
  }

  /** Get the signing public key */
  getSigningPublicKey(): string | null {
    return this.signingKeyPair?.publicKey ?? null;
  }

  /** Check if manager is initialized */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Check if a session has expired (age or message count).
   * Returns true if the session should be torn down and re-keyed.
   */
  isSessionExpired(deviceId: string): boolean {
    const session = this.sessions.get(deviceId);
    if (!session) return false;

    if (Date.now() - session.createdAt > E2EEManager.SESSION_MAX_AGE_MS) {
      return true;
    }
    if (session.outgoingCounter >= E2EEManager.SESSION_MAX_MESSAGES) {
      return true;
    }
    if (session.lastReceivedCounter >= E2EEManager.SESSION_MAX_MESSAGES) {
      return true;
    }
    return false;
  }

  /**
   * Sign a key exchange payload with our Ed25519 identity key.
   * The signed message is: "prefix:senderDeviceId:ephemeralPublicKey[:recipientDeviceId]"
   */
  private signPayload(prefix: string, ephemeralPublicKey: string, recipientDeviceId?: string): string | undefined {
    if (!this.signingKeyPair) return undefined;
    const parts = [prefix, this.deviceId, ephemeralPublicKey];
    if (recipientDeviceId) parts.push(recipientDeviceId);
    const message = decodeUTF8(parts.join(':'));
    const secretKey = decodeBase64(this.signingKeyPair.secretKey);
    const signature = nacl.sign.detached(message, secretKey);
    return encodeBase64(signature);
  }

  /**
   * Verify a peer's signature on a key exchange payload.
   * Returns true if signature is valid OR if peer has no identity key (unsigned exchange accepted with warning).
   * Throws if the peer's identity key doesn't match TOFU record (potential MITM).
   */
  private verifyPeerSignature(
    peerId: string,
    identityPublicKey: string | undefined,
    signature: string | undefined,
    ephemeralPublicKey: string,
    prefix: string,
    recipientDeviceId?: string,
  ): void {
    if (!identityPublicKey || !signature) {
      throw new Error(
        `E2EE: Peer ${peerId} sent UNSIGNED key exchange. ` +
        `Identity verification is required. Update the peer to the latest version.`
      );
    }

    // TOFU: check if we already trust a different key for this peer
    const trusted = getTrustedPeerKey(peerId);
    if (trusted && trusted !== identityPublicKey) {
      throw new Error(
        `E2EE: IDENTITY KEY MISMATCH for device ${peerId}! ` +
        `Expected ${trusted.substring(0, 8)}... but got ${identityPublicKey.substring(0, 8)}... ` +
        `This could indicate a man-in-the-middle attack. Key exchange rejected.`
      );
    }

    // Verify the Ed25519 signature
    const parts = [prefix, peerId, ephemeralPublicKey];
    if (recipientDeviceId) parts.push(recipientDeviceId);
    const msgString = parts.join(':');
    const message = decodeUTF8(msgString);
    const sigBytes = decodeBase64(signature);
    const pubKeyBytes = decodeBase64(identityPublicKey);

    const valid = nacl.sign.detached.verify(message, sigBytes, pubKeyBytes);
    if (!valid) {
      throw new Error(
        `E2EE: INVALID SIGNATURE from device ${peerId}! ` +
        `The ephemeral key was not properly signed. Key exchange rejected.`
      );
    }

    // TOFU: trust this key if it's new
    if (!trusted) {
      trustPeerKey(peerId, identityPublicKey);
    }
  }

  /**
   * Create a key exchange initiation to send to a remote device.
   * Generates an ephemeral key pair and signs it with our identity key.
   */
  /**
   * Evict expired or excess pending key exchanges.
   */
  private cleanupPendingExchanges(): void {
    const now = Date.now();
    for (const [deviceId, entry] of this.pendingExchanges) {
      if (now - entry.createdAt > E2EEManager.PENDING_EXCHANGE_TTL_MS) {
        this.pendingExchanges.delete(deviceId);
        // Evicted expired pending exchange
      }
    }
    while (this.pendingExchanges.size >= E2EEManager.MAX_PENDING_EXCHANGES) {
      const oldestKey = this.pendingExchanges.keys().next().value;
      if (oldestKey) {
        this.pendingExchanges.delete(oldestKey);
        // MAX_PENDING_EXCHANGES reached, evicted oldest
      } else break;
    }
  }

  createKeyExchangeInit(targetDeviceId: string): KeyExchangeInit {
    this.cleanupPendingExchanges();
    const ephemeral = generateKeyPair();
    this.pendingExchanges.set(targetDeviceId, { keyPair: ephemeral, createdAt: Date.now() });

    const signature = this.signPayload('KEY_EXCHANGE_INIT', ephemeral.publicKey);

    return {
      senderDeviceId: this.deviceId,
      ephemeralPublicKey: ephemeral.publicKey,
      identityPublicKey: this.signingKeyPair?.publicKey,
      signature,
    };
  }

  /**
   * Handle an incoming key exchange init from a remote device.
   * Verifies the peer's identity signature (TOFU), computes shared key,
   * and returns a signed ack.
   */
  handleKeyExchangeInit(init: KeyExchangeInit): KeyExchangeAck {
    // Verify peer's signature (TOFU)
    this.verifyPeerSignature(
      init.senderDeviceId,
      init.identityPublicKey,
      init.signature,
      init.ephemeralPublicKey,
      'KEY_EXCHANGE_INIT',
    );

    const ephemeral = generateKeyPair();
    const rawSharedKey = computeSharedKey(ephemeral.privateKey, init.ephemeralPublicKey);

    // Derive directional send/receive keys via HKDF
    const { sendKey, receiveKey } = deriveSessionKeys(rawSharedKey, this.deviceId, init.senderDeviceId);

    console.log(`[E2EE] Key exchange init processed — session established with peer ${init.senderDeviceId.substring(0, 8)}...`);

    // Store session
    const sessionId = `session-${init.senderDeviceId}-${this.deviceId}-${Date.now()}`;
    this.sessions.set(init.senderDeviceId, {
      sendKey,
      receiveKey,
      outgoingCounter: 0,
      lastReceivedCounter: -1,
      createdAt: Date.now(),
    });
    storeSessionKey(init.senderDeviceId, sendKey, receiveKey, sessionId);

    // Persist to disk for reconnection resilience
    const sessionKeys: SessionKeys = {
      sendKey,
      receiveKey,
      sessionId,
      deviceId: init.senderDeviceId,
      messageCounter: 0,
      lastReceivedCounter: -1,
      createdAt: Date.now(),
    };
    persistSessionKey(this.deviceId, init.senderDeviceId, sessionKeys);

    // E2EE session established

    // Sign our ack
    const signature = this.signPayload('KEY_EXCHANGE_ACK', ephemeral.publicKey, init.senderDeviceId);

    return {
      senderDeviceId: this.deviceId,
      recipientDeviceId: init.senderDeviceId,
      ephemeralPublicKey: ephemeral.publicKey,
      identityPublicKey: this.signingKeyPair?.publicKey,
      signature,
    };
  }

  /**
   * Handle an incoming key exchange ack from a remote device.
   * Verifies the peer's identity signature (TOFU) and completes the key exchange.
   */
  handleKeyExchangeAck(ack: KeyExchangeAck): void {
    const peerId = ack.senderDeviceId;
    let pendingEntry = this.pendingExchanges.get(peerId);
    let pendingKey = peerId;
    // Fallback: relay may send mobile_connected with a different ID than the mobile's
    // real device ID, so the pending exchange may be stored under a different key.
    // If there's exactly one pending exchange, use it regardless of key.
    if (!pendingEntry && this.pendingExchanges.size === 1) {
      const [fallbackKey, fallbackEntry] = this.pendingExchanges.entries().next().value!;
      console.log(`[E2EE] Pending exchange not found for ${peerId.substring(0, 8)}..., using fallback`);
      pendingEntry = fallbackEntry;
      pendingKey = fallbackKey;
    }
    if (!pendingEntry) {
      throw new Error(`E2EE: No pending key exchange for device ${peerId}`);
    }
    const pending = pendingEntry.keyPair;

    // Verify peer's signature (TOFU)
    this.verifyPeerSignature(
      peerId,
      ack.identityPublicKey,
      ack.signature,
      ack.ephemeralPublicKey,
      'KEY_EXCHANGE_ACK',
      ack.recipientDeviceId,
    );

    const rawSharedKey = computeSharedKey(pending.privateKey, ack.ephemeralPublicKey);

    // Derive directional send/receive keys via HKDF
    const { sendKey, receiveKey } = deriveSessionKeys(rawSharedKey, this.deviceId, peerId);

    console.log(`[E2EE] Key exchange ack processed — session established with peer ${peerId.substring(0, 8)}...`);

    // Store session
    const sessionId = `session-${this.deviceId}-${peerId}-${Date.now()}`;
    this.sessions.set(peerId, {
      sendKey,
      receiveKey,
      outgoingCounter: 0,
      lastReceivedCounter: -1,
      createdAt: Date.now(),
    });
    storeSessionKey(peerId, sendKey, receiveKey, sessionId);

    // Persist to disk
    const sessionKeys: SessionKeys = {
      sendKey,
      receiveKey,
      sessionId,
      deviceId: peerId,
      messageCounter: 0,
      lastReceivedCounter: -1,
      createdAt: Date.now(),
    };
    persistSessionKey(this.deviceId, peerId, sessionKeys);

    this.pendingExchanges.delete(pendingKey);

    // E2EE session established
  }

  /**
   * Attempts to restore a persisted session after reconnection.
   * If the session has expired, it is deleted from persistence and not restored.
   */
  async restorePersistedSession(targetDeviceId: string): Promise<boolean> {
    const persisted = loadPersistedSessionKey(this.deviceId, targetDeviceId);
    if (!persisted) {
      return false;
    }

    this.sessions.set(targetDeviceId, {
      sendKey: persisted.sendKey,
      receiveKey: persisted.receiveKey,
      outgoingCounter: persisted.messageCounter,
      lastReceivedCounter: persisted.lastReceivedCounter,
      createdAt: persisted.createdAt ?? Date.now(),
    });

    // Check if the restored session is already expired
    if (this.isSessionExpired(targetDeviceId)) {
      console.log(`[E2EE] Persisted session with ${targetDeviceId} has expired — deleting`);
      this.sessions.delete(targetDeviceId);
      deletePersistedSession(this.deviceId, targetDeviceId);
      return false;
    }

    storeSessionKey(targetDeviceId, persisted.sendKey, persisted.receiveKey, persisted.sessionId);

    // Restored persisted E2EE session
    return true;
  }

  /** Lists all devices with persisted sessions */
  listPersistedDevices(): string[] {
    return listPersistedSessions(this.deviceId);
  }

  /** Check if an encrypted session is established with a device */
  hasSessionKey(deviceId: string): boolean {
    return this.sessions.has(deviceId);
  }

  /** Encrypt a message for a specific device */
  encryptMessage(
    plaintext: string,
    recipientDeviceId: string,
    sessionId: string,
  ): EncryptedMessage {
    const session = this.sessions.get(recipientDeviceId);
    if (!session) {
      throw new Error(`E2EE: No session established with device ${recipientDeviceId}`);
    }

    // Check session expiry BEFORE encrypting — force re-key
    if (this.isSessionExpired(recipientDeviceId)) {
      this.sessions.delete(recipientDeviceId);
      throw new Error(`E2EE: Session expired with device ${recipientDeviceId} — re-key required`);
    }

    const payload = encrypt(plaintext, session.sendKey);
    session.outgoingCounter++;

    if (session.outgoingCounter === 1) {
      console.log(`[E2EE] First encrypted message sent to ${recipientDeviceId.substring(0, 8)}...`);
    }

    return {
      senderDeviceId: this.deviceId,
      recipientDeviceId,
      sessionId,
      payload,
      messageCounter: session.outgoingCounter,
      timestamp: new Date().toISOString(),
    };
  }

  /** Decrypt an incoming encrypted message */
  decryptMessage(message: EncryptedMessage, senderDeviceId: string): string {
    const session = this.sessions.get(senderDeviceId);
    if (!session) {
      throw new Error(`E2EE: No session established with device ${senderDeviceId}`);
    }

    // SECURITY: Validate counter is a positive finite integer within safe bounds
    if (
      typeof message.messageCounter !== 'number' ||
      !Number.isFinite(message.messageCounter) ||
      !Number.isInteger(message.messageCounter) ||
      message.messageCounter < 1 ||
      message.messageCounter > Number.MAX_SAFE_INTEGER - 1
    ) {
      throw new Error('E2EE: Invalid message counter value');
    }

    // Replay protection
    if (message.messageCounter <= session.lastReceivedCounter) {
      throw new Error('E2EE: Replay attack detected - message counter too low');
    }

    const plaintext = decrypt(message.payload, session.receiveKey);
    session.lastReceivedCounter = message.messageCounter;

    // Check expiry AFTER decrypting — valid messages still get through, but warn caller
    if (this.isSessionExpired(senderDeviceId)) {
      console.warn(`[E2EE] Session with ${senderDeviceId.substring(0, 8)}... has expired — re-key required`);
    }

    return plaintext;
  }

  /** Clear session for a specific device */
  clearSession(deviceId: string): void {
    this.sessions.delete(deviceId);
    this.pendingExchanges.delete(deviceId);
  }

  /**
   * Cleans up all session keys and pending exchanges.
   * @param deletePersisted - Whether to delete persisted sessions from disk
   */
  cleanup(deletePersisted = false): void {
    clearSessionKeys();
    this.sessions.clear();
    this.pendingExchanges.clear();

    if (deletePersisted) {
      deleteAllPersistedSessions(this.deviceId);
    }
  }

  /** Removes a specific persisted session */
  removePersistedSession(targetDeviceId: string): void {
    deletePersistedSession(this.deviceId, targetDeviceId);
  }

  /** Reset TOFU trust for a peer (used on re-pair so new keys are accepted) */
  resetPeerTrust(targetDeviceId: string): void {
    removeTrustedPeerKey(targetDeviceId);
    this.sessions.delete(targetDeviceId);
    this.pendingExchanges.delete(targetDeviceId);
    deletePersistedSession(this.deviceId, targetDeviceId);
  }

  /** Light trust reset — only clears TOFU key, preserves pending exchanges in-flight */
  clearTrustOnly(targetDeviceId: string): void {
    removeTrustedPeerKey(targetDeviceId);
  }
}
