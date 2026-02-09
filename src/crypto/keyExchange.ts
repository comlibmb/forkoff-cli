import * as crypto from 'crypto';

/**
 * Computes X25519 shared secret using ECDH
 *
 * @param privateKey - Base64-encoded X25519 private key (32 bytes)
 * @param publicKey - Base64-encoded X25519 public key (32 bytes)
 * @returns Shared secret (32 bytes)
 */
export function computeSharedSecret(
  privateKey: string,
  publicKey: string
): Uint8Array {
  const privateKeyBytes = Buffer.from(privateKey, 'base64');
  const publicKeyBytes = Buffer.from(publicKey, 'base64');

  if (privateKeyBytes.length !== 32) {
    throw new Error('Private key must be 32 bytes');
  }

  if (publicKeyBytes.length !== 32) {
    throw new Error('Public key must be 32 bytes');
  }

  // Create X25519 private key object from raw bytes
  const privateKeyObject = crypto.createPrivateKey({
    key: Buffer.concat([
      // PKCS#8 header for X25519
      Buffer.from([
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e,
        0x04, 0x22, 0x04, 0x20,
      ]),
      privateKeyBytes,
    ]),
    format: 'der',
    type: 'pkcs8',
  });

  // Create X25519 public key object from raw bytes
  const publicKeyObject = crypto.createPublicKey({
    key: Buffer.concat([
      // SPKI header for X25519
      Buffer.from([
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
      ]),
      publicKeyBytes,
    ]),
    format: 'der',
    type: 'spki',
  });

  // Perform ECDH to compute shared secret
  const sharedSecret = crypto.diffieHellman({
    privateKey: privateKeyObject,
    publicKey: publicKeyObject,
  });

  return new Uint8Array(sharedSecret);
}

/**
 * Derives a session encryption key from a shared secret using HKDF
 *
 * @param sharedSecret - Shared secret from X25519 key exchange
 * @returns Derived session key (32 bytes for AES-256)
 */
export function deriveSessionKey(sharedSecret: Uint8Array): Uint8Array {
  if (sharedSecret.length !== 32) {
    throw new Error('Shared secret must be 32 bytes');
  }

  // Use HKDF-SHA256 to derive session key
  // Info string provides domain separation
  const info = Buffer.from('forkoff-e2ee-session-key-v1', 'utf8');
  const salt = Buffer.alloc(0); // Empty salt (optional for HKDF)

  // Use synchronous HKDF (blocking but fast for 32-byte output)
  const derivedKey = crypto.hkdfSync(
    'sha256',
    Buffer.from(sharedSecret),
    salt,
    info,
    32 // Output length: 32 bytes for AES-256
  );

  return new Uint8Array(derivedKey);
}

/**
 * Performs complete key exchange: computes shared secret and derives session key
 *
 * @param myPrivateKey - My Base64-encoded X25519 private key
 * @param theirPublicKey - Their Base64-encoded X25519 public key
 * @returns Derived session encryption key (32 bytes for AES-256-GCM)
 */
export function performKeyExchange(
  myPrivateKey: string,
  theirPublicKey: string
): Uint8Array {
  const sharedSecret = computeSharedSecret(myPrivateKey, theirPublicKey);
  const sessionKey = deriveSessionKey(sharedSecret);
  return sessionKey;
}
