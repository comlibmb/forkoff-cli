import { generateKeyPair } from '../../crypto/keyGeneration';

describe('CLI Key Generation', () => {
  describe('generateKeyPair', () => {
    it('generates X25519 key pair with 32-byte public key', () => {
      const keyPair = generateKeyPair();
      const publicKeyBytes = Buffer.from(keyPair.publicKey, 'base64');

      expect(publicKeyBytes.length).toBe(32);
    });

    it('generates X25519 key pair with 32-byte private key', () => {
      const keyPair = generateKeyPair();
      const privateKeyBytes = Buffer.from(keyPair.privateKey, 'base64');

      expect(privateKeyBytes.length).toBe(32);
    });

    it('generated keys are Base64-encoded strings', () => {
      const keyPair = generateKeyPair();

      // Should be valid Base64 strings
      expect(typeof keyPair.publicKey).toBe('string');
      expect(typeof keyPair.privateKey).toBe('string');

      // Should decode without error
      expect(() => Buffer.from(keyPair.publicKey, 'base64')).not.toThrow();
      expect(() => Buffer.from(keyPair.privateKey, 'base64')).not.toThrow();

      // Re-encoding should match original
      expect(
        Buffer.from(keyPair.publicKey, 'base64').toString('base64')
      ).toBe(keyPair.publicKey);
      expect(
        Buffer.from(keyPair.privateKey, 'base64').toString('base64')
      ).toBe(keyPair.privateKey);
    });

    it('public and private keys are different', () => {
      const keyPair = generateKeyPair();

      expect(keyPair.publicKey).not.toBe(keyPair.privateKey);
    });

    it('generates unique key pairs on each call', () => {
      const keyPair1 = generateKeyPair();
      const keyPair2 = generateKeyPair();

      expect(keyPair1.publicKey).not.toBe(keyPair2.publicKey);
      expect(keyPair1.privateKey).not.toBe(keyPair2.privateKey);
    });

    it('key pair is compatible with nacl.box.keyPair', () => {
      const nacl = require('tweetnacl');
      const { decodeBase64 } = require('tweetnacl-util');

      const keyPair = generateKeyPair();

      // Should be able to recreate the key pair from secret key
      const secretKey = decodeBase64(keyPair.privateKey);
      const derived = nacl.box.keyPair.fromSecretKey(secretKey);

      const { encodeBase64 } = require('tweetnacl-util');
      expect(encodeBase64(derived.publicKey)).toBe(keyPair.publicKey);
    });
  });
});
