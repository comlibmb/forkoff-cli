import {
  computeSharedSecret,
  deriveSessionKey,
  performKeyExchange,
} from '../../crypto/keyExchange';
import { generateKeyPair } from '../../crypto/keyGeneration';

describe('CLI Key Exchange', () => {
  describe('computeSharedSecret', () => {
    it('computes shared secret from X25519 key exchange', () => {
      const aliceKeyPair = generateKeyPair();
      const bobKeyPair = generateKeyPair();

      const sharedSecret = computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey
      );

      expect(sharedSecret).toBeInstanceOf(Uint8Array);
      expect(sharedSecret.length).toBe(32); // X25519 produces 32-byte shared secret
    });

    it('shared secret is same on both sides (Alice and Bob)', () => {
      const aliceKeyPair = generateKeyPair();
      const bobKeyPair = generateKeyPair();

      // Alice computes shared secret using her private key and Bob's public key
      const aliceSharedSecret = computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey
      );

      // Bob computes shared secret using his private key and Alice's public key
      const bobSharedSecret = computeSharedSecret(
        bobKeyPair.privateKey,
        aliceKeyPair.publicKey
      );

      // Both should arrive at the same shared secret
      expect(aliceSharedSecret).toEqual(bobSharedSecret);
    });

    it('different key pairs produce different shared secrets', () => {
      const alice1KeyPair = generateKeyPair();
      const alice2KeyPair = generateKeyPair();
      const bobKeyPair = generateKeyPair();

      const sharedSecret1 = computeSharedSecret(
        alice1KeyPair.privateKey,
        bobKeyPair.publicKey
      );

      const sharedSecret2 = computeSharedSecret(
        alice2KeyPair.privateKey,
        bobKeyPair.publicKey
      );

      expect(sharedSecret1).not.toEqual(sharedSecret2);
    });
  });

  describe('deriveSessionKey', () => {
    it('derives session encryption key from shared secret', () => {
      const sharedSecret = new Uint8Array(32).fill(1);

      const sessionKey = deriveSessionKey(sharedSecret);

      expect(sessionKey).toBeInstanceOf(Uint8Array);
      expect(sessionKey.length).toBe(32); // AES-256 requires 32 bytes
    });

    it('derived key is 32 bytes (AES-256)', () => {
      const aliceKeyPair = generateKeyPair();
      const bobKeyPair = generateKeyPair();

      const sharedSecret = computeSharedSecret(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey
      );

      const sessionKey = deriveSessionKey(sharedSecret);

      expect(sessionKey.length).toBe(32);
    });

    it('same shared secret produces same session key (deterministic)', () => {
      const sharedSecret = new Uint8Array(32).fill(1);

      const sessionKey1 = deriveSessionKey(sharedSecret);
      const sessionKey2 = deriveSessionKey(sharedSecret);

      expect(sessionKey1).toEqual(sessionKey2);
    });

    it('different shared secrets produce different session keys', () => {
      const sharedSecret1 = new Uint8Array(32).fill(1);
      const sharedSecret2 = new Uint8Array(32).fill(2);

      const sessionKey1 = deriveSessionKey(sharedSecret1);
      const sessionKey2 = deriveSessionKey(sharedSecret2);

      expect(sessionKey1).not.toEqual(sessionKey2);
    });
  });

  describe('performKeyExchange (end-to-end)', () => {
    it('completes full key exchange flow', () => {
      const aliceKeyPair = generateKeyPair();
      const bobKeyPair = generateKeyPair();

      // Alice initiates key exchange
      const aliceSessionKey = performKeyExchange(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey
      );

      // Bob responds to key exchange
      const bobSessionKey = performKeyExchange(
        bobKeyPair.privateKey,
        aliceKeyPair.publicKey
      );

      // Both should derive the same session key
      expect(aliceSessionKey).toEqual(bobSessionKey);
      expect(aliceSessionKey.length).toBe(32);
    });

    it('session keys are suitable for AES-256-GCM encryption', () => {
      const aliceKeyPair = generateKeyPair();
      const bobKeyPair = generateKeyPair();

      const sessionKey = performKeyExchange(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey
      );

      // Verify it's a valid Uint8Array with correct length
      expect(sessionKey).toBeInstanceOf(Uint8Array);
      expect(sessionKey.length).toBe(32);
      expect(sessionKey.byteLength).toBe(32);
    });
  });
});
