import { encrypt, decrypt } from '../../crypto/encryption';

describe('CLI Encryption/Decryption', () => {
  const testKey = new Uint8Array(32).fill(1); // 32-byte NaCl secretbox key

  describe('Basic Encryption', () => {
    it('encrypts plaintext to EncryptedPayload', () => {
      const plaintext = 'Hello, World!';

      const encrypted = encrypt(plaintext, testKey);

      expect(encrypted).toHaveProperty('ciphertext');
      expect(encrypted).toHaveProperty('nonce');
      expect(typeof encrypted.ciphertext).toBe('string');
      expect(typeof encrypted.nonce).toBe('string');
      // NaCl secretbox does NOT have a separate authTag — it's embedded in ciphertext
      expect(encrypted).not.toHaveProperty('authTag');
    });

    it('nonce is 24 bytes (NaCl secretbox nonce)', () => {
      const plaintext = 'Test message';

      const encrypted = encrypt(plaintext, testKey);
      const nonceBytes = Buffer.from(encrypted.nonce, 'base64');

      expect(nonceBytes.length).toBe(24);
    });

    it('encrypted ciphertext is different from plaintext', () => {
      const plaintext = 'Secret message';

      const encrypted = encrypt(plaintext, testKey);
      const ciphertext = Buffer.from(encrypted.ciphertext, 'base64').toString('utf8');

      expect(ciphertext).not.toBe(plaintext);
    });

    it('same plaintext produces different ciphertext (random nonce)', () => {
      const plaintext = 'Same message';

      const encrypted1 = encrypt(plaintext, testKey);
      const encrypted2 = encrypt(plaintext, testKey);

      // Nonces should be different (random)
      expect(encrypted1.nonce).not.toBe(encrypted2.nonce);
      // Ciphertexts should be different (due to different nonces)
      expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);
    });
  });

  describe('Decryption', () => {
    it('decrypts EncryptedPayload back to original plaintext', () => {
      const plaintext = 'Hello, World!';

      const encrypted = encrypt(plaintext, testKey);
      const decrypted = decrypt(encrypted, testKey);

      expect(decrypted).toBe(plaintext);
    });

    it('encrypt-decrypt round trip preserves message content', () => {
      const messages = [
        'Simple message',
        'Message with numbers 12345',
        'Special chars: !@#$%^&*()',
        '',
      ];

      messages.forEach((message) => {
        const encrypted = encrypt(message, testKey);
        const decrypted = decrypt(encrypted, testKey);
        expect(decrypted).toBe(message);
      });
    });

    it('encrypt-decrypt round trip preserves unicode/emoji', () => {
      const plaintext = 'Hello 世界 🌍🚀✨';

      const encrypted = encrypt(plaintext, testKey);
      const decrypted = decrypt(encrypted, testKey);

      expect(decrypted).toBe(plaintext);
    });

    it('encrypt-decrypt round trip preserves large messages (10KB)', () => {
      const plaintext = 'A'.repeat(10 * 1024); // 10KB of 'A'

      const encrypted = encrypt(plaintext, testKey);
      const decrypted = decrypt(encrypted, testKey);

      expect(decrypted).toBe(plaintext);
      expect(decrypted.length).toBe(10 * 1024);
    });
  });

  describe('Security Properties', () => {
    it('decryption with wrong key fails', () => {
      const plaintext = 'Secret message';
      const correctKey = new Uint8Array(32).fill(1);
      const wrongKey = new Uint8Array(32).fill(2);

      const encrypted = encrypt(plaintext, correctKey);

      expect(() => decrypt(encrypted, wrongKey)).toThrow();
    });

    it('decryption with tampered ciphertext fails', () => {
      const plaintext = 'Secret message';
      const encrypted = encrypt(plaintext, testKey);

      // Tamper with ciphertext
      const tamperedCiphertext = Buffer.from(encrypted.ciphertext, 'base64');
      tamperedCiphertext[0] ^= 0xFF; // Flip bits
      encrypted.ciphertext = tamperedCiphertext.toString('base64');

      expect(() => decrypt(encrypted, testKey)).toThrow();
    });

    it('decryption with tampered nonce fails', () => {
      const plaintext = 'Secret message';
      const encrypted = encrypt(plaintext, testKey);

      // Tamper with nonce
      const tamperedNonce = Buffer.from(encrypted.nonce, 'base64');
      tamperedNonce[0] ^= 0xFF;
      encrypted.nonce = tamperedNonce.toString('base64');

      expect(() => decrypt(encrypted, testKey)).toThrow();
    });
  });
});
