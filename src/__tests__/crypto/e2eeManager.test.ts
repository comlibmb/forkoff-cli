import { E2EEManager } from '../../crypto/e2eeManager';
import * as keyStorage from '../../crypto/keyStorage';
import * as keyGeneration from '../../crypto/keyGeneration';

// Mock keytar to avoid actual OS keychain operations
jest.mock('keytar');

// Mock sessionPersistence to avoid disk I/O during tests
jest.mock('../../crypto/sessionPersistence', () => ({
  persistSessionKey: jest.fn(),
  loadPersistedSessionKey: jest.fn().mockReturnValue(null),
  deletePersistedSession: jest.fn(),
  deleteAllPersistedSessions: jest.fn(),
  listPersistedSessions: jest.fn().mockReturnValue([]),
}));

describe('CLI E2EE Manager', () => {
  let manager: E2EEManager;
  const deviceId = 'device-123';

  beforeEach(async () => {
    jest.clearAllMocks();
    keyStorage.clearSessionKeys();
  });

  describe('Initialization', () => {
    it('generates new keys if none stored', async () => {
      jest.spyOn(keyStorage, 'getPrivateKey').mockResolvedValue(null);
      const storeKeySpy = jest
        .spyOn(keyStorage, 'storePrivateKey')
        .mockResolvedValue();

      manager = new E2EEManager(deviceId);
      await manager.initialize();

      expect(storeKeySpy).toHaveBeenCalled();
      expect(manager.isInitialized()).toBe(true);
    });

    it('initializes with stored keys if they exist', async () => {
      // Generate a real key pair to get a valid private key
      const realKeyPair = keyGeneration.generateKeyPair();
      jest
        .spyOn(keyStorage, 'getPrivateKey')
        .mockResolvedValue(realKeyPair.privateKey);
      const generateSpy = jest.spyOn(keyGeneration, 'generateKeyPair');

      manager = new E2EEManager(deviceId);
      await manager.initialize();

      // Should NOT generate new keys
      expect(generateSpy).not.toHaveBeenCalled();
      expect(manager.isInitialized()).toBe(true);
    });

    it('public key is available after initialization', async () => {
      jest.spyOn(keyStorage, 'getPrivateKey').mockResolvedValue(null);
      jest.spyOn(keyStorage, 'storePrivateKey').mockResolvedValue();

      manager = new E2EEManager(deviceId);
      await manager.initialize();

      const publicKey = manager.getPublicKey();
      expect(publicKey).toBeDefined();
      expect(typeof publicKey).toBe('string');
      // Should be a valid Base64 string decoding to 32 bytes
      const publicKeyBytes = Buffer.from(publicKey!, 'base64');
      expect(publicKeyBytes.length).toBe(32);
    });
  });

  describe('Key Exchange', () => {
    beforeEach(async () => {
      jest.spyOn(keyStorage, 'getPrivateKey').mockResolvedValue(null);
      jest.spyOn(keyStorage, 'storePrivateKey').mockResolvedValue();

      manager = new E2EEManager(deviceId);
      await manager.initialize();
    });

    it('creates key exchange init with target device', () => {
      const targetDeviceId = 'device-456';

      const initPayload = manager.createKeyExchangeInit(targetDeviceId);

      expect(initPayload).toHaveProperty('senderDeviceId', deviceId);
      expect(initPayload).toHaveProperty('ephemeralPublicKey');
      expect(typeof initPayload.ephemeralPublicKey).toBe('string');
    });

    it('handles incoming key exchange init', () => {
      const senderDeviceId = 'device-456';
      const senderManager = new E2EEManager(senderDeviceId);

      // Generate a real ephemeral key pair for the sender
      const senderEphemeral = keyGeneration.generateKeyPair();

      const ackPayload = manager.handleKeyExchangeInit({
        senderDeviceId,
        ephemeralPublicKey: senderEphemeral.publicKey,
      });

      expect(ackPayload).toHaveProperty('recipientDeviceId', senderDeviceId);
      expect(ackPayload).toHaveProperty('ephemeralPublicKey');
      expect(manager.hasSessionKey(senderDeviceId)).toBe(true);
    });

    it('handles incoming key exchange ack', () => {
      const targetDeviceId = 'device-456';

      // First create init (stores pending ephemeral key)
      manager.createKeyExchangeInit(targetDeviceId);

      // Generate a real ephemeral key pair for the responder
      const responderEphemeral = keyGeneration.generateKeyPair();

      // Then handle ack
      manager.handleKeyExchangeAck({
        senderDeviceId: targetDeviceId,
        recipientDeviceId: deviceId,
        ephemeralPublicKey: responderEphemeral.publicKey,
      });

      expect(manager.hasSessionKey(targetDeviceId)).toBe(true);
    });

    it('throws on ack without pending exchange', () => {
      const unknownDeviceId = 'unknown-device';
      const ephemeral = keyGeneration.generateKeyPair();

      expect(() =>
        manager.handleKeyExchangeAck({
          senderDeviceId: unknownDeviceId,
          recipientDeviceId: deviceId,
          ephemeralPublicKey: ephemeral.publicKey,
        })
      ).toThrow(/No pending key exchange/);
    });
  });

  describe('Message Encryption', () => {
    let targetManager: E2EEManager;
    const targetDeviceId = 'device-456';

    beforeEach(async () => {
      jest.spyOn(keyStorage, 'getPrivateKey').mockResolvedValue(null);
      jest.spyOn(keyStorage, 'storePrivateKey').mockResolvedValue();

      manager = new E2EEManager(deviceId);
      await manager.initialize();

      // Complete a real key exchange between two managers
      targetManager = new E2EEManager(targetDeviceId);
      await targetManager.initialize();

      const initPayload = manager.createKeyExchangeInit(targetDeviceId);
      const ackPayload = targetManager.handleKeyExchangeInit(initPayload);
      manager.handleKeyExchangeAck(ackPayload);
    });

    it('encrypts outgoing messages', () => {
      const plaintext = 'Hello, World!';
      const sessionId = 'session-abc';

      const encryptedMessage = manager.encryptMessage(
        plaintext,
        targetDeviceId,
        sessionId
      );

      expect(encryptedMessage).toHaveProperty('senderDeviceId', deviceId);
      expect(encryptedMessage).toHaveProperty('recipientDeviceId', targetDeviceId);
      expect(encryptedMessage).toHaveProperty('sessionId', sessionId);
      expect(encryptedMessage).toHaveProperty('payload');
      expect(encryptedMessage.payload).toHaveProperty('ciphertext');
      expect(encryptedMessage.payload).toHaveProperty('nonce');
      // NaCl secretbox does NOT have a separate authTag
      expect(encryptedMessage.payload).not.toHaveProperty('authTag');
      expect(encryptedMessage).toHaveProperty('messageCounter');
      expect(encryptedMessage).toHaveProperty('timestamp');
    });

    it('increments message counter on send', () => {
      const sessionId = 'session-abc';

      const msg1 = manager.encryptMessage('Message 1', targetDeviceId, sessionId);
      const msg2 = manager.encryptMessage('Message 2', targetDeviceId, sessionId);

      expect(msg2.messageCounter).toBe(msg1.messageCounter + 1);
    });

    it('throws when no session key exists for target', () => {
      const unknownDeviceId = 'unknown-device';

      expect(() =>
        manager.encryptMessage('Hello', unknownDeviceId, 'session-123')
      ).toThrow(/No session established/);
    });
  });

  describe('Message Decryption', () => {
    let senderManager: E2EEManager;
    const senderDeviceId = 'device-456';

    beforeEach(async () => {
      jest.spyOn(keyStorage, 'getPrivateKey').mockResolvedValue(null);
      jest.spyOn(keyStorage, 'storePrivateKey').mockResolvedValue();

      manager = new E2EEManager(deviceId);
      await manager.initialize();

      senderManager = new E2EEManager(senderDeviceId);
      await senderManager.initialize();

      // Complete key exchange: sender initiates, manager (recipient) responds
      const initPayload = senderManager.createKeyExchangeInit(deviceId);
      const ackPayload = manager.handleKeyExchangeInit(initPayload);
      senderManager.handleKeyExchangeAck(ackPayload);
    });

    it('decrypts incoming messages', () => {
      const plaintext = 'Secret message';
      const sessionId = 'session-abc';

      // Sender encrypts a message
      const encryptedMessage = senderManager.encryptMessage(
        plaintext,
        deviceId,
        sessionId
      );

      // Recipient decrypts
      const decrypted = manager.decryptMessage(encryptedMessage, senderDeviceId);

      expect(decrypted).toBe(plaintext);
    });

    it('rejects messages with invalid counter (replay protection)', () => {
      const sessionId = 'session-abc';

      const msg1 = senderManager.encryptMessage('Message 1', deviceId, sessionId);
      const msg2 = senderManager.encryptMessage('Message 2', deviceId, sessionId);

      // Decrypt msg2 first
      manager.decryptMessage(msg2, senderDeviceId);

      // Try to decrypt msg1 (older counter) - should fail
      expect(() => manager.decryptMessage(msg1, senderDeviceId)).toThrow(
        /counter/i
      );
    });
  });

  describe('Session Management', () => {
    beforeEach(async () => {
      jest.spyOn(keyStorage, 'getPrivateKey').mockResolvedValue(null);
      jest.spyOn(keyStorage, 'storePrivateKey').mockResolvedValue();

      manager = new E2EEManager(deviceId);
      await manager.initialize();
    });

    it('tracks active sessions by device ID', () => {
      const device1 = 'device-456';
      const device2 = 'device-789';

      // Complete key exchanges for both devices
      const ephemeral1 = keyGeneration.generateKeyPair();
      const ephemeral2 = keyGeneration.generateKeyPair();

      manager.handleKeyExchangeInit({
        senderDeviceId: device1,
        ephemeralPublicKey: ephemeral1.publicKey,
      });

      manager.handleKeyExchangeInit({
        senderDeviceId: device2,
        ephemeralPublicKey: ephemeral2.publicKey,
      });

      expect(manager.hasSessionKey(device1)).toBe(true);
      expect(manager.hasSessionKey(device2)).toBe(true);
    });

    it('cleans up session keys on disconnect', () => {
      const targetDeviceId = 'device-456';
      const ephemeral = keyGeneration.generateKeyPair();

      manager.handleKeyExchangeInit({
        senderDeviceId: targetDeviceId,
        ephemeralPublicKey: ephemeral.publicKey,
      });

      expect(manager.hasSessionKey(targetDeviceId)).toBe(true);

      manager.cleanup();

      expect(manager.hasSessionKey(targetDeviceId)).toBe(false);
      expect(keyStorage.getSessionKey(targetDeviceId)).toBeNull();
    });
  });
});
