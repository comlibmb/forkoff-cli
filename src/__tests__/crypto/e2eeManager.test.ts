import { E2EEManager } from '../../crypto/e2eeManager';
import * as keyStorage from '../../crypto/keyStorage';
import * as keyGeneration from '../../crypto/keyGeneration';

// Mock keytar to avoid actual OS keychain operations
jest.mock('keytar');

// Mock axios for API calls
jest.mock('axios');
import axios from 'axios';
const mockAxios = axios as jest.Mocked<typeof axios>;

describe('CLI E2EE Manager', () => {
  let manager: E2EEManager;
  const deviceId = 'device-123';
  const apiUrl = 'https://api.forkoff.app/api';

  // Mock axios instance
  const mockAxiosInstance = {
    put: jest.fn(),
    get: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    keyStorage.clearSessionKeys();

    // Mock axios.create to return our mock instance
    mockAxios.create = jest.fn().mockReturnValue(mockAxiosInstance as any);

    // Mock successful API responses
    mockAxiosInstance.put.mockResolvedValue({ data: { success: true, keyVersion: 1 } });
    mockAxiosInstance.get.mockResolvedValue({
      data: {
        publicKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
        keyVersion: 1,
      },
    });
  });

  describe('Initialization', () => {
    it('generates new keys if none stored', async () => {
      jest.spyOn(keyStorage, 'getPrivateKey').mockResolvedValue(null);
      const storeKeySpy = jest
        .spyOn(keyStorage, 'storePrivateKey')
        .mockResolvedValue();

      manager = new E2EEManager(deviceId, apiUrl, 'mock-token');
      await manager.initialize();

      expect(storeKeySpy).toHaveBeenCalled();
      expect(manager.isInitialized()).toBe(true);
    });

    it('initializes with stored keys if they exist', async () => {
      const existingPrivateKey = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
      jest
        .spyOn(keyStorage, 'getPrivateKey')
        .mockResolvedValue(existingPrivateKey);
      const generateSpy = jest.spyOn(keyGeneration, 'generateKeyPair');

      manager = new E2EEManager(deviceId, apiUrl, 'mock-token');
      await manager.initialize();

      // Should NOT generate new keys
      expect(generateSpy).not.toHaveBeenCalled();
      expect(manager.isInitialized()).toBe(true);
    });

    it('uploads public key to backend on initialization', async () => {
      jest.spyOn(keyStorage, 'getPrivateKey').mockResolvedValue(null);
      jest.spyOn(keyStorage, 'storePrivateKey').mockResolvedValue();

      manager = new E2EEManager(deviceId, apiUrl, 'mock-token');
      await manager.initialize();

      expect(mockAxiosInstance.put).toHaveBeenCalledWith(
        `${apiUrl}/devices/${deviceId}/public-key`,
        expect.objectContaining({ publicKey: expect.any(String) })
      );
    });
  });

  describe('Key Exchange', () => {
    beforeEach(async () => {
      jest.spyOn(keyStorage, 'getPrivateKey').mockResolvedValue(null);
      jest.spyOn(keyStorage, 'storePrivateKey').mockResolvedValue();

      manager = new E2EEManager(deviceId, apiUrl, 'mock-token');
      await manager.initialize();
    });

    it('initiates key exchange with target device', async () => {
      const targetDeviceId = 'device-456';

      const initPayload = await manager.initiateKeyExchange(targetDeviceId);

      expect(initPayload).toHaveProperty('senderDeviceId', deviceId);
      expect(initPayload).toHaveProperty('ephemeralPublicKey');
      expect(typeof initPayload.ephemeralPublicKey).toBe('string');
    });

    it('handles incoming key exchange init', async () => {
      const senderDeviceId = 'device-456';
      const ephemeralPublicKey = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=';

      const ackPayload = await manager.handleKeyExchangeInit(
        senderDeviceId,
        ephemeralPublicKey
      );

      expect(ackPayload).toHaveProperty('recipientDeviceId', deviceId);
      expect(ackPayload).toHaveProperty('ephemeralPublicKey');
      expect(manager.hasSessionKey(senderDeviceId)).toBe(true);
    });

    it('handles incoming key exchange ack', async () => {
      const targetDeviceId = 'device-456';

      // First initiate
      await manager.initiateKeyExchange(targetDeviceId);

      // Then handle ack
      const ephemeralPublicKey = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=';
      await manager.handleKeyExchangeAck(targetDeviceId, ephemeralPublicKey);

      expect(manager.hasSessionKey(targetDeviceId)).toBe(true);
    });
  });

  describe('Message Encryption', () => {
    beforeEach(async () => {
      jest.spyOn(keyStorage, 'getPrivateKey').mockResolvedValue(null);
      jest.spyOn(keyStorage, 'storePrivateKey').mockResolvedValue();

      manager = new E2EEManager(deviceId, apiUrl, 'mock-token');
      await manager.initialize();

      // Set up session
      const targetDeviceId = 'device-456';
      await manager.initiateKeyExchange(targetDeviceId);
      const ephemeralPublicKey = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=';
      await manager.handleKeyExchangeAck(targetDeviceId, ephemeralPublicKey);
    });

    it('encrypts outgoing messages', () => {
      const targetDeviceId = 'device-456';
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
      expect(encryptedMessage.payload).toHaveProperty('authTag');
      expect(encryptedMessage).toHaveProperty('messageCounter');
      expect(encryptedMessage).toHaveProperty('timestamp');
    });

    it('increments message counter on send', () => {
      const targetDeviceId = 'device-456';
      const sessionId = 'session-abc';

      const msg1 = manager.encryptMessage('Message 1', targetDeviceId, sessionId);
      const msg2 = manager.encryptMessage('Message 2', targetDeviceId, sessionId);

      expect(msg2.messageCounter).toBe(msg1.messageCounter + 1);
    });
  });

  describe('Message Decryption', () => {
    beforeEach(async () => {
      jest.spyOn(keyStorage, 'getPrivateKey').mockResolvedValue(null);
      jest.spyOn(keyStorage, 'storePrivateKey').mockResolvedValue();

      manager = new E2EEManager(deviceId, apiUrl, 'mock-token');
      await manager.initialize();

      // Set up session (as recipient)
      const senderDeviceId = 'device-456';
      const ephemeralPublicKey = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=';
      await manager.handleKeyExchangeInit(senderDeviceId, ephemeralPublicKey);
    });

    it('decrypts incoming messages', () => {
      const senderDeviceId = 'device-456';
      const plaintext = 'Secret message';
      const sessionId = 'session-abc';

      // Get the session key
      const sessionKeys = keyStorage.getSessionKey(senderDeviceId);
      if (!sessionKeys) {
        throw new Error('Session key not found');
      }

      // Manually create an encrypted message (simulating what the sender would send)
      const { encrypt } = require('../../crypto/encryption');
      const encryptedPayload = encrypt(plaintext, sessionKeys.encryptionKey);

      const encryptedMessage = {
        senderDeviceId,
        recipientDeviceId: deviceId,
        sessionId,
        payload: encryptedPayload,
        messageCounter: 1, // First message from sender
        timestamp: new Date().toISOString(),
      };

      // Decrypt (simulating receiving from sender)
      const decrypted = manager.decryptMessage(encryptedMessage, senderDeviceId);

      expect(decrypted).toBe(plaintext);
    });

    it('rejects messages with invalid counter (replay protection)', () => {
      const senderDeviceId = 'device-456';
      const sessionId = 'session-abc';

      const msg1 = manager.encryptMessage('Message 1', senderDeviceId, sessionId);
      const msg2 = manager.encryptMessage('Message 2', senderDeviceId, sessionId);

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

      manager = new E2EEManager(deviceId, apiUrl, 'mock-token');
      await manager.initialize();
    });

    it('tracks active sessions by device ID', async () => {
      const device1 = 'device-456';
      const device2 = 'device-789';

      await manager.initiateKeyExchange(device1);
      await manager.initiateKeyExchange(device2);

      const ephemeralKey1 = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=';
      const ephemeralKey2 = 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=';

      await manager.handleKeyExchangeAck(device1, ephemeralKey1);
      await manager.handleKeyExchangeAck(device2, ephemeralKey2);

      expect(manager.hasSessionKey(device1)).toBe(true);
      expect(manager.hasSessionKey(device2)).toBe(true);
    });

    it('cleans up session keys on disconnect', () => {
      const targetDeviceId = 'device-456';
      keyStorage.storeSessionKey(
        targetDeviceId,
        new Uint8Array(32),
        'session-abc'
      );

      manager.cleanup();

      expect(keyStorage.getSessionKey(targetDeviceId)).toBeNull();
    });
  });
});
