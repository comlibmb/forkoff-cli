/**
 * Key Exchange Service
 * Performs X25519 Diffie-Hellman key exchange using NaCl box.before,
 * then derives directional send/receive keys via HKDF-SHA256.
 * Compatible with mobile app's tweetnacl implementation.
 */
import nacl from 'tweetnacl';
import { decodeBase64, decodeUTF8 } from 'tweetnacl-util';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

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

/**
 * Derive directional send/receive keys from the raw ECDH shared secret using HKDF-SHA256.
 *
 * Both sides must derive identical key material. Directionality is determined by
 * lexicographic ordering of device IDs:
 * - The device with the lexicographically smaller ID gets bytes 0-31 as sendKey
 * - The device with the lexicographically larger ID gets bytes 32-63 as sendKey
 * - receiveKey is always the opposite half
 *
 * @param rawSharedKey - 32-byte ECDH output from computeSharedKey
 * @param myDeviceId - This device's ID
 * @param peerDeviceId - The remote device's ID
 * @returns { sendKey, receiveKey } - 32-byte directional keys
 */
export function deriveSessionKeys(
  rawSharedKey: Uint8Array,
  myDeviceId: string,
  peerDeviceId: string,
): { sendKey: Uint8Array; receiveKey: Uint8Array } {
  // Salt: sorted concatenation of both device IDs (deterministic regardless of who calls)
  const sortedIds = [myDeviceId, peerDeviceId].sort();
  const salt = decodeUTF8(sortedIds[0] + sortedIds[1]);

  // Info string identifying the protocol version
  const info = decodeUTF8('forkoff-e2ee-v1');

  // Derive 64 bytes of key material
  const derivedKeyMaterial = hkdf(sha256, rawSharedKey, salt, info, 64);

  // Split into two 32-byte keys
  const firstHalf = derivedKeyMaterial.slice(0, 32);
  const secondHalf = derivedKeyMaterial.slice(32, 64);

  // Directionality: device with smaller ID gets firstHalf as sendKey
  const iAmSmaller = myDeviceId < peerDeviceId;

  return {
    sendKey: iAmSmaller ? firstHalf : secondHalf,
    receiveKey: iAmSmaller ? secondHalf : firstHalf,
  };
}
