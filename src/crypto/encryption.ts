/**
 * Encryption/Decryption Service
 * Uses NaCl secretbox (XSalsa20-Poly1305) for symmetric encryption.
 * Compatible with mobile app's tweetnacl implementation.
 */
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';
import { EncryptedPayload } from './types';

/**
 * Encrypt a plaintext string using NaCl secretbox.
 * @param plaintext - The message to encrypt
 * @param key - 32-byte shared secret key
 * @returns EncryptedPayload with Base64-encoded ciphertext and nonce
 */
export function encrypt(plaintext: string, key: Uint8Array): EncryptedPayload {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength); // 24 bytes
  const messageBytes = decodeUTF8(plaintext);
  const ciphertext = nacl.secretbox(messageBytes, nonce, key);

  return {
    ciphertext: encodeBase64(ciphertext),
    nonce: encodeBase64(nonce),
  };
}

/**
 * Decrypt an EncryptedPayload back to plaintext.
 * @param payload - The encrypted payload (ciphertext + nonce)
 * @param key - 32-byte shared secret key (must match encryption key)
 * @returns Decrypted plaintext string
 * @throws Error if decryption fails (wrong key, tampered data, etc.)
 */
export function decrypt(payload: EncryptedPayload, key: Uint8Array): string {
  const ciphertext = decodeBase64(payload.ciphertext);
  const nonce = decodeBase64(payload.nonce);

  const decrypted = nacl.secretbox.open(ciphertext, nonce, key);
  if (!decrypted) {
    throw new Error('E2EE: Decryption failed - message may be tampered or wrong key');
  }

  return encodeUTF8(decrypted);
}
