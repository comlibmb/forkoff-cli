import * as crypto from 'crypto';
import { E2EEKeyPair } from './types';

/**
 * Generates a random X25519 key pair for E2EE
 * Uses Node.js crypto module
 *
 * @returns E2EEKeyPair with Base64-encoded public and private keys (32 bytes each)
 */
export function generateKeyPair(): E2EEKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: {
      type: 'spki',
      format: 'der',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'der',
    },
  });

  // Extract raw 32-byte keys from DER-encoded buffers
  // X25519 public key: last 32 bytes of SPKI
  // X25519 private key: last 32 bytes of PKCS8
  const rawPublicKey = publicKey.slice(-32);
  const rawPrivateKey = privateKey.slice(-32);

  return {
    publicKey: rawPublicKey.toString('base64'),
    privateKey: rawPrivateKey.toString('base64'),
  };
}

/**
 * Generates a deterministic X25519 key pair from a seed
 * Useful for testing and key derivation
 *
 * @param seed - 32-byte buffer to use as the private key seed
 * @returns E2EEKeyPair with Base64-encoded public and private keys
 * @throws Error if seed is not 32 bytes
 */
export function generateKeyPairFromSeed(seed: Buffer): E2EEKeyPair {
  if (seed.length !== 32) {
    throw new Error('Seed must be exactly 32 bytes');
  }

  // In X25519, the private key IS the seed (32 random bytes)
  // The public key is derived: publicKey = privateKey * basepoint
  const privateKeyObject = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]),
      seed,
    ]),
    format: 'der',
    type: 'pkcs8',
  });

  const publicKeyObject = crypto.createPublicKey(privateKeyObject);

  // Export raw keys
  const publicKeyDER = publicKeyObject.export({ type: 'spki', format: 'der' }) as Buffer;
  const privateKeyDER = privateKeyObject.export({ type: 'pkcs8', format: 'der' }) as Buffer;

  const rawPublicKey = publicKeyDER.slice(-32);
  const rawPrivateKey = privateKeyDER.slice(-32);

  return {
    publicKey: rawPublicKey.toString('base64'),
    privateKey: rawPrivateKey.toString('base64'),
  };
}
