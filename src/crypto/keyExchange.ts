/**
 * Key Exchange Service
 * Performs X25519 Diffie-Hellman key exchange using NaCl box.before.
 * Compatible with mobile app's tweetnacl implementation.
 */
import nacl from 'tweetnacl';
import { decodeBase64 } from 'tweetnacl-util';

/**
 * Compute a shared secret key from a private key and a remote public key.
 * Uses NaCl's box.before which performs X25519 ECDH + HSalsa20 key derivation.
 *
 * @param myPrivateKeyB64 - Base64-encoded 32-byte private key
 * @param theirPublicKeyB64 - Base64-encoded 32-byte public key
 * @returns 32-byte shared key suitable for NaCl secretbox encryption
 */
export function computeSharedKey(
  myPrivateKeyB64: string,
  theirPublicKeyB64: string
): Uint8Array {
  const myPrivateKey = decodeBase64(myPrivateKeyB64);
  const theirPublicKey = decodeBase64(theirPublicKeyB64);
  return nacl.box.before(theirPublicKey, myPrivateKey);
}
