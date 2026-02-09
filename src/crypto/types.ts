/**
 * E2EE Type Definitions for ForkOff CLI
 *
 * X25519 key exchange + AES-256-GCM encryption
 */

export interface E2EEKeyPair {
  publicKey: string;       // Base64-encoded X25519 public key (32 bytes)
  privateKey: string;      // Base64-encoded X25519 private key (32 bytes) - NEVER sent to server
}

export interface EncryptedPayload {
  ciphertext: string;      // Base64-encoded encrypted data
  nonce: string;           // Base64-encoded nonce (12 bytes for AES-GCM)
  authTag: string;         // Base64-encoded authentication tag (16 bytes for AES-GCM)
}

export interface EncryptedMessage {
  senderDeviceId: string;
  recipientDeviceId: string;
  sessionId: string;
  payload: EncryptedPayload;
  messageCounter: number;  // For replay protection
  timestamp: string;
}

export interface SessionKeys {
  encryptionKey: Uint8Array;  // 32 bytes for AES-256-GCM
  sessionId: string;
}

export interface KeyExchangeInit {
  senderDeviceId: string;
  ephemeralPublicKey: string; // Base64-encoded
}

export interface KeyExchangeAck {
  recipientDeviceId: string;
  ephemeralPublicKey: string; // Base64-encoded
}
