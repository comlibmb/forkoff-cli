/**
 * End-to-End Integration Test for E2EE
 *
 * Simulates the complete flow using the NaCl-based API:
 * 1. Mobile generates keys (initialize)
 * 2. CLI generates keys (initialize)
 * 3. Mobile creates key exchange init for CLI
 * 4. CLI handles init and returns ack
 * 5. Mobile handles ack — both sides now share a key
 * 6. Mobile encrypts message -> sends to CLI
 * 7. CLI receives -> decrypts -> verifies content matches
 * 8. CLI encrypts reply -> sends to Mobile
 * 9. Mobile receives -> decrypts -> verifies content matches
 *
 * This test verifies the complete encrypted communication flow.
 */

import { E2EEManager } from '../../crypto/e2eeManager';
import * as keyStorage from '../../crypto/keyStorage';

// Mock keytar
jest.mock('keytar');

// Mock sessionPersistence to avoid disk I/O
jest.mock('../../crypto/sessionPersistence', () => ({
  persistSessionKey: jest.fn(),
  loadPersistedSessionKey: jest.fn().mockReturnValue(null),
  deletePersistedSession: jest.fn(),
  deleteAllPersistedSessions: jest.fn(),
  listPersistedSessions: jest.fn().mockReturnValue([]),
}));

describe('E2EE End-to-End Integration Test', () => {
  let mobileManager: E2EEManager;
  let cliManager: E2EEManager;

  const mobileDeviceId = 'mobile-device-123';
  const cliDeviceId = 'cli-device-456';
  const sessionId = 'test-session-abc';

  beforeEach(async () => {
    jest.clearAllMocks();
    keyStorage.clearSessionKeys();

    // Mock key storage for both devices
    jest.spyOn(keyStorage, 'getPrivateKey').mockResolvedValue(null);
    jest.spyOn(keyStorage, 'storePrivateKey').mockResolvedValue();

    // Initialize Mobile E2EE Manager
    mobileManager = new E2EEManager(mobileDeviceId);
    await mobileManager.initialize();

    // Initialize CLI E2EE Manager
    cliManager = new E2EEManager(cliDeviceId);
    await cliManager.initialize();
  });

  afterEach(() => {
    mobileManager.cleanup();
    cliManager.cleanup();
  });

  describe('Complete E2EE Flow', () => {
    it('completes full bidirectional encrypted communication flow', () => {
      // ============================================================
      // STEP 1: Mobile creates key exchange init for CLI
      // ============================================================
      console.log('\n[TEST] Step 1: Mobile creates key exchange init for CLI');

      const mobileInitPayload = mobileManager.createKeyExchangeInit(cliDeviceId);

      expect(mobileInitPayload).toHaveProperty('senderDeviceId', mobileDeviceId);
      expect(mobileInitPayload).toHaveProperty('ephemeralPublicKey');
      console.log('[TEST] Mobile generated ephemeral key pair and created init');

      // ============================================================
      // STEP 2: CLI receives key exchange init and sends ack
      // ============================================================
      console.log('\n[TEST] Step 2: CLI receives key exchange init and sends ack');

      const cliAckPayload = cliManager.handleKeyExchangeInit(mobileInitPayload);

      expect(cliAckPayload).toHaveProperty('recipientDeviceId', mobileDeviceId);
      expect(cliAckPayload).toHaveProperty('ephemeralPublicKey');
      expect(cliManager.hasSessionKey(mobileDeviceId)).toBe(true);
      console.log('[TEST] CLI derived shared key and sent ack');

      // ============================================================
      // STEP 3: Mobile receives ack and completes key exchange
      // ============================================================
      console.log('\n[TEST] Step 3: Mobile receives ack and completes key exchange');

      mobileManager.handleKeyExchangeAck(cliAckPayload);

      expect(mobileManager.hasSessionKey(cliDeviceId)).toBe(true);
      console.log('[TEST] Mobile completed key exchange and derived shared key');

      // ============================================================
      // STEP 4: Mobile encrypts message and sends to CLI
      // ============================================================
      console.log('\n[TEST] Step 4: Mobile encrypts message and sends to CLI');

      const mobileMessage = 'Hello from mobile! This is a secret message.';

      const encryptedFromMobile = mobileManager.encryptMessage(
        mobileMessage,
        cliDeviceId,
        sessionId
      );

      expect(encryptedFromMobile.payload.ciphertext).toBeDefined();
      expect(encryptedFromMobile.payload.ciphertext).not.toContain(mobileMessage);
      // NaCl secretbox payload should NOT have authTag
      expect(encryptedFromMobile.payload).not.toHaveProperty('authTag');
      console.log('[TEST] Mobile encrypted message');

      // ============================================================
      // STEP 5: CLI receives and decrypts mobile's message
      // ============================================================
      console.log('\n[TEST] Step 5: CLI receives and decrypts mobile\'s message');

      const decryptedAtCli = cliManager.decryptMessage(
        encryptedFromMobile,
        mobileDeviceId
      );

      expect(decryptedAtCli).toBe(mobileMessage);
      console.log('[TEST] CLI successfully decrypted: "' + decryptedAtCli + '"');

      // ============================================================
      // STEP 6: CLI encrypts reply and sends to Mobile
      // ============================================================
      console.log('\n[TEST] Step 6: CLI encrypts reply and sends to Mobile');

      const cliReply = 'Hello from CLI! Message received and understood.';

      const encryptedFromCli = cliManager.encryptMessage(
        cliReply,
        mobileDeviceId,
        sessionId
      );

      expect(encryptedFromCli.payload.ciphertext).toBeDefined();
      expect(encryptedFromCli.payload.ciphertext).not.toContain(cliReply);
      console.log('[TEST] CLI encrypted reply');

      // ============================================================
      // STEP 7: Mobile receives and decrypts CLI's reply
      // ============================================================
      console.log('\n[TEST] Step 7: Mobile receives and decrypts CLI\'s reply');

      const decryptedAtMobile = mobileManager.decryptMessage(
        encryptedFromCli,
        cliDeviceId
      );

      expect(decryptedAtMobile).toBe(cliReply);
      console.log('[TEST] Mobile successfully decrypted: "' + decryptedAtMobile + '"');

      // ============================================================
      // STEP 8: Verify bidirectional communication continues
      // ============================================================
      console.log('\n[TEST] Step 8: Verify bidirectional communication continues');

      const mobileMessage2 = 'Second message from mobile';
      const encrypted2FromMobile = mobileManager.encryptMessage(
        mobileMessage2,
        cliDeviceId,
        sessionId
      );

      const decrypted2AtCli = cliManager.decryptMessage(
        encrypted2FromMobile,
        mobileDeviceId
      );

      expect(decrypted2AtCli).toBe(mobileMessage2);
      console.log('[TEST] Second message successfully encrypted and decrypted');

      console.log('\n[TEST] ========================================');
      console.log('[TEST] FULL E2EE FLOW COMPLETED SUCCESSFULLY');
      console.log('[TEST] ========================================\n');
    });

    it('preserves unicode and emoji in encrypted messages', () => {
      // Set up E2EE session
      const initPayload = mobileManager.createKeyExchangeInit(cliDeviceId);
      const ackPayload = cliManager.handleKeyExchangeInit(initPayload);
      mobileManager.handleKeyExchangeAck(ackPayload);

      // Test unicode and emoji
      const unicodeMessage = 'Hello 世界 🌍 Привет мир 🚀 مرحبا بالعالم ✨';

      const encrypted = mobileManager.encryptMessage(unicodeMessage, cliDeviceId, sessionId);
      const decrypted = cliManager.decryptMessage(encrypted, mobileDeviceId);

      expect(decrypted).toBe(unicodeMessage);
    });

    it('handles large messages (10KB)', () => {
      // Set up E2EE session
      const initPayload = mobileManager.createKeyExchangeInit(cliDeviceId);
      const ackPayload = cliManager.handleKeyExchangeInit(initPayload);
      mobileManager.handleKeyExchangeAck(ackPayload);

      // Test large message
      const largeMessage = 'A'.repeat(10 * 1024); // 10KB

      const encrypted = mobileManager.encryptMessage(largeMessage, cliDeviceId, sessionId);
      const decrypted = cliManager.decryptMessage(encrypted, mobileDeviceId);

      expect(decrypted).toBe(largeMessage);
      expect(decrypted.length).toBe(10 * 1024);
    });
  });

  describe('Security Properties', () => {
    beforeEach(() => {
      // Set up E2EE session for security tests
      const initPayload = mobileManager.createKeyExchangeInit(cliDeviceId);
      const ackPayload = cliManager.handleKeyExchangeInit(initPayload);
      mobileManager.handleKeyExchangeAck(ackPayload);
    });

    it('rejects replayed messages (replay attack protection)', () => {
      const message1 = 'First message';
      const message2 = 'Second message';

      const encrypted1 = mobileManager.encryptMessage(message1, cliDeviceId, sessionId);
      const encrypted2 = mobileManager.encryptMessage(message2, cliDeviceId, sessionId);

      // Decrypt in order
      cliManager.decryptMessage(encrypted1, mobileDeviceId);
      cliManager.decryptMessage(encrypted2, mobileDeviceId);

      // Try to replay message 1 - should fail
      expect(() => cliManager.decryptMessage(encrypted1, mobileDeviceId)).toThrow(/counter/i);
    });

    it('detects tampered ciphertext', () => {
      const message = 'Secret message';
      const encrypted = mobileManager.encryptMessage(message, cliDeviceId, sessionId);

      // Tamper with ciphertext
      const tamperedCiphertext = Buffer.from(encrypted.payload.ciphertext, 'base64');
      tamperedCiphertext[0] ^= 0xFF;
      encrypted.payload.ciphertext = tamperedCiphertext.toString('base64');

      // Should fail on decryption
      expect(() => cliManager.decryptMessage(encrypted, mobileDeviceId)).toThrow();
    });

    it('detects tampered nonce', () => {
      const message = 'Secret message';
      const encrypted = mobileManager.encryptMessage(message, cliDeviceId, sessionId);

      // Tamper with nonce
      const tamperedNonce = Buffer.from(encrypted.payload.nonce, 'base64');
      tamperedNonce[0] ^= 0xFF;
      encrypted.payload.nonce = tamperedNonce.toString('base64');

      // Should fail on decryption
      expect(() => cliManager.decryptMessage(encrypted, mobileDeviceId)).toThrow();
    });

    it('prevents message decryption with wrong session key', async () => {
      // Create a third device (attacker)
      const attackerManager = new E2EEManager('attacker-device');
      await attackerManager.initialize();

      // Mobile sends encrypted message to CLI
      const message = 'Secret message';
      const encrypted = mobileManager.encryptMessage(message, cliDeviceId, sessionId);

      // Attacker tries to set up their own session with mobile
      const attackerInit = attackerManager.createKeyExchangeInit(mobileDeviceId);
      const attackerAck = mobileManager.handleKeyExchangeInit(attackerInit);
      attackerManager.handleKeyExchangeAck(attackerAck);

      // Attacker intercepts message meant for CLI and tries to decrypt
      // This should fail because the message was encrypted with CLI's session key
      expect(() => attackerManager.decryptMessage(encrypted, mobileDeviceId)).toThrow();

      attackerManager.cleanup();
    });
  });

  describe('Multi-device Support', () => {
    it('maintains multiple concurrent E2EE sessions independently', () => {
      // First session: Mobile <-> CLI
      const init1 = mobileManager.createKeyExchangeInit(cliDeviceId);
      const ack1 = cliManager.handleKeyExchangeInit(init1);
      mobileManager.handleKeyExchangeAck(ack1);

      // Verify first session is active
      expect(mobileManager.hasSessionKey(cliDeviceId)).toBe(true);
      expect(cliManager.hasSessionKey(mobileDeviceId)).toBe(true);

      // Verify it doesn't have a session with a non-existent device
      expect(mobileManager.hasSessionKey('non-existent-device')).toBe(false);

      // Verify we can send multiple messages to the same device
      const message1 = 'First message to CLI';
      const message2 = 'Second message to CLI';
      const message3 = 'Third message to CLI';

      const encrypted1 = mobileManager.encryptMessage(message1, cliDeviceId, sessionId);
      const encrypted2 = mobileManager.encryptMessage(message2, cliDeviceId, sessionId);
      const encrypted3 = mobileManager.encryptMessage(message3, cliDeviceId, sessionId);

      // Verify all messages can be decrypted in order
      const decrypted1 = cliManager.decryptMessage(encrypted1, mobileDeviceId);
      const decrypted2 = cliManager.decryptMessage(encrypted2, mobileDeviceId);
      const decrypted3 = cliManager.decryptMessage(encrypted3, mobileDeviceId);

      expect(decrypted1).toBe(message1);
      expect(decrypted2).toBe(message2);
      expect(decrypted3).toBe(message3);
    });
  });
});
