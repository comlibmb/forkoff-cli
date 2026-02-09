import * as crypto from 'crypto';
import { EncryptedPayload } from './types';

const ALGORITHM = 'aes-256-gcm';
const NONCE_LENGTH = 12; // 96 bits for AES-GCM
const AUTH_TAG_LENGTH = 16; // 128 bits for AES-GCM

/**
 * Encrypts plaintext using AES-256-GCM
 *
 * @param plaintext - Text to encrypt
 * @param key - 32-byte encryption key (AES-256)
 * @returns EncryptedPayload with Base64-encoded ciphertext, nonce, and authTag
 */
export function encrypt(plaintext: string, key: Uint8Array): EncryptedPayload {
  if (key.length !== 32) {
    throw new Error('Encryption key must be 32 bytes (256 bits)');
  }

  // Generate random nonce (12 bytes)
  const nonce = crypto.randomBytes(NONCE_LENGTH);

  // Create cipher
  const cipher = crypto.createCipheriv(ALGORITHM, key, nonce);

  // Encrypt
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  // Get authentication tag
  const authTag = cipher.getAuthTag();

  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('Auth tag must be 16 bytes');
  }

  return {
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/**
 * Decrypts ciphertext using AES-256-GCM
 *
 * @param payload - EncryptedPayload with Base64-encoded ciphertext, nonce, and authTag
 * @param key - 32-byte encryption key (AES-256)
 * @returns Decrypted plaintext
 * @throws Error if decryption fails (wrong key, tampered data, etc.)
 */
export function decrypt(
  payload: EncryptedPayload,
  key: Uint8Array
): string {
  if (key.length !== 32) {
    throw new Error('Decryption key must be 32 bytes (256 bits)');
  }

  // Decode from Base64
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');
  const nonce = Buffer.from(payload.nonce, 'base64');
  const authTag = Buffer.from(payload.authTag, 'base64');

  if (nonce.length !== NONCE_LENGTH) {
    throw new Error('Nonce must be 12 bytes');
  }

  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('Auth tag must be 16 bytes');
  }

  try {
    // Create decipher
    const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce);

    // Set auth tag for verification
    decipher.setAuthTag(authTag);

    // Decrypt
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return plaintext.toString('utf8');
  } catch (error) {
    throw new Error(
      `Decryption failed: ${error instanceof Error ? error.message : 'unknown error'}`
    );
  }
}
