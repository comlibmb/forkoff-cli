/**
 * E2EE Type Definitions for ForkOff CLI
 *
 * X25519 key exchange + NaCl secretbox (XSalsa20-Poly1305)
 * Compatible with mobile app's tweetnacl implementation.
 */

/** X25519 key pair for Diffie-Hellman key exchange */
export interface E2EEKeyPair {
  publicKey: string;   // Base64-encoded 32-byte X25519 public key
  privateKey: string;  // Base64-encoded 32-byte X25519 private key (NEVER sent to server)
}

/** Encrypted payload using NaCl secretbox (XSalsa20-Poly1305) */
export interface EncryptedPayload {
  ciphertext: string;  // Base64-encoded encrypted data (includes auth tag)
  nonce: string;       // Base64-encoded 24-byte nonce
}

/** Full encrypted message sent over WebSocket */
export interface EncryptedMessage {
  senderDeviceId: string;
  recipientDeviceId: string;
  sessionId: string;
  payload: EncryptedPayload;
  messageCounter: number;
  timestamp: string;
}

/** Derived session keys for a specific device-to-device connection */
export interface SessionKeys {
  sendKey: Uint8Array;    // 32-byte directional key for encrypting outgoing messages
  receiveKey: Uint8Array; // 32-byte directional key for decrypting incoming messages
  sessionId: string;
  deviceId: string;       // The remote device ID
  messageCounter: number; // Outgoing message counter
  lastReceivedCounter: number; // Last received counter (replay protection)
  createdAt?: number;     // Timestamp when session was established (for expiry)
}

/** Ed25519 signing key pair for identity verification during key exchange */
export interface SigningKeyPair {
  publicKey: string;   // Base64-encoded 32-byte Ed25519 public key
  secretKey: string;   // Base64-encoded 64-byte Ed25519 secret key (NEVER sent to server)
}

/** Key exchange initiation (sender → recipient via server) */
export interface KeyExchangeInit {
  senderDeviceId: string;
  ephemeralPublicKey: string; // Base64-encoded X25519 public key
  identityPublicKey?: string; // Base64-encoded Ed25519 public key for TOFU verification
  signature?: string;         // Base64-encoded Ed25519 signature over exchange payload
}

/** Key exchange acknowledgment (recipient → sender via server) */
export interface KeyExchangeAck {
  senderDeviceId: string;     // Device that computed the ack (the responder)
  recipientDeviceId: string;  // Device that initiated the exchange (the initiator)
  ephemeralPublicKey: string;  // Base64-encoded X25519 public key
  identityPublicKey?: string; // Base64-encoded Ed25519 public key for TOFU verification
  signature?: string;         // Base64-encoded Ed25519 signature over exchange payload
}

/** E2EE session status */
export type E2EESessionStatus = 'none' | 'initiating' | 'established' | 'failed';
