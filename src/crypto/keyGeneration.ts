/**
 * Key Generation Service
 * Generates X25519 key pairs for E2EE using tweetnacl.
 * Compatible with mobile app's tweetnacl implementation.
 */
import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { E2EEKeyPair } from './types';

/**
 * Generate a new X25519 key pair for Diffie-Hellman key exchange.
 * Uses NaCl's box keypair which generates X25519 keys.
 */
export function generateKeyPair(): E2EEKeyPair {
  const keyPair = nacl.box.keyPair();
  return {
    publicKey: encodeBase64(keyPair.publicKey),
    privateKey: encodeBase64(keyPair.secretKey),
  };
}
