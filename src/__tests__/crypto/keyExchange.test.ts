import { computeSharedKey } from '../../crypto/keyExchange';
import { generateKeyPair } from '../../crypto/keyGeneration';

describe('CLI Key Exchange', () => {
  describe('computeSharedKey', () => {
    it('computes shared key from X25519 key exchange', () => {
      const aliceKeyPair = generateKeyPair();
      const bobKeyPair = generateKeyPair();

      const sharedKey = computeSharedKey(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey
      );

      expect(sharedKey).toBeInstanceOf(Uint8Array);
      expect(sharedKey.length).toBe(32); // NaCl box.before produces 32-byte shared key
    });

    it('shared key is same on both sides (Alice and Bob)', () => {
      const aliceKeyPair = generateKeyPair();
      const bobKeyPair = generateKeyPair();

      // Alice computes shared key using her private key and Bob's public key
      const aliceSharedKey = computeSharedKey(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey
      );

      // Bob computes shared key using his private key and Alice's public key
      const bobSharedKey = computeSharedKey(
        bobKeyPair.privateKey,
        aliceKeyPair.publicKey
      );

      // Both should arrive at the same shared key
      expect(aliceSharedKey).toEqual(bobSharedKey);
    });

    it('different key pairs produce different shared keys', () => {
      const alice1KeyPair = generateKeyPair();
      const alice2KeyPair = generateKeyPair();
      const bobKeyPair = generateKeyPair();

      const sharedKey1 = computeSharedKey(
        alice1KeyPair.privateKey,
        bobKeyPair.publicKey
      );

      const sharedKey2 = computeSharedKey(
        alice2KeyPair.privateKey,
        bobKeyPair.publicKey
      );

      expect(sharedKey1).not.toEqual(sharedKey2);
    });

    it('shared key is suitable for NaCl secretbox encryption', () => {
      const aliceKeyPair = generateKeyPair();
      const bobKeyPair = generateKeyPair();

      const sharedKey = computeSharedKey(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey
      );

      // Verify it's a valid Uint8Array with correct length for NaCl secretbox
      expect(sharedKey).toBeInstanceOf(Uint8Array);
      expect(sharedKey.length).toBe(32);
      expect(sharedKey.byteLength).toBe(32);
    });
  });

  describe('End-to-end key exchange flow', () => {
    it('both sides derive the same shared key', () => {
      const aliceKeyPair = generateKeyPair();
      const bobKeyPair = generateKeyPair();

      // Alice computes shared key
      const aliceSharedKey = computeSharedKey(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey
      );

      // Bob computes shared key
      const bobSharedKey = computeSharedKey(
        bobKeyPair.privateKey,
        aliceKeyPair.publicKey
      );

      // Both should derive the same 32-byte key
      expect(aliceSharedKey).toEqual(bobSharedKey);
      expect(aliceSharedKey.length).toBe(32);
    });

    it('shared key works for encrypt/decrypt round trip', () => {
      const { encrypt, decrypt } = require('../../crypto/encryption');
      const aliceKeyPair = generateKeyPair();
      const bobKeyPair = generateKeyPair();

      const sharedKey = computeSharedKey(
        aliceKeyPair.privateKey,
        bobKeyPair.publicKey
      );

      const plaintext = 'Hello from Alice!';
      const encrypted = encrypt(plaintext, sharedKey);
      const decrypted = decrypt(encrypted, sharedKey);

      expect(decrypted).toBe(plaintext);
    });
  });
});
