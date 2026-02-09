import { generateKeyPair, generateKeyPairFromSeed } from '../../crypto/keyGeneration';

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
  });

  describe('generateKeyPairFromSeed', () => {
    it('key pair generation is deterministic when given seed', () => {
      const seed = Buffer.alloc(32, 1); // All bytes set to 1

      const keyPair1 = generateKeyPairFromSeed(seed);
      const keyPair2 = generateKeyPairFromSeed(seed);

      expect(keyPair1.publicKey).toBe(keyPair2.publicKey);
      expect(keyPair1.privateKey).toBe(keyPair2.privateKey);
    });

    it('different seeds produce different keys', () => {
      const seed1 = Buffer.alloc(32, 1);
      const seed2 = Buffer.alloc(32, 2);

      const keyPair1 = generateKeyPairFromSeed(seed1);
      const keyPair2 = generateKeyPairFromSeed(seed2);

      expect(keyPair1.publicKey).not.toBe(keyPair2.publicKey);
      expect(keyPair1.privateKey).not.toBe(keyPair2.privateKey);
    });

    it('seed must be 32 bytes', () => {
      const shortSeed = Buffer.alloc(16);

      expect(() => generateKeyPairFromSeed(shortSeed)).toThrow();
    });
  });
});
