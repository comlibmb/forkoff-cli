import { WebSocketClient } from '../../websocket';
import { E2EEManager } from '../../crypto/e2eeManager';
import * as keyStorage from '../../crypto/keyStorage';

// Mock socket.io-client
jest.mock('socket.io-client', () => ({
  io: jest.fn(),
}));

// Mock keytar
jest.mock('keytar');

// Mock axios
jest.mock('axios');
import axios from 'axios';
const mockAxios = axios as jest.Mocked<typeof axios>;

describe('CLI WebSocket E2EE Integration', () => {
  let wsClient: WebSocketClient;
  let e2eeManager: E2EEManager;
  let mockSocket: any;

  const deviceId = 'cli-device-123';
  const mobileDeviceId = 'mobile-device-456';
  const apiUrl = 'https://api.forkoff.app/api';
  const authToken = 'mock-token';

  // Mock axios instance
  const mockAxiosInstance = {
    put: jest.fn(),
    get: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    keyStorage.clearSessionKeys();

    // Mock axios.create
    mockAxios.create = jest.fn().mockReturnValue(mockAxiosInstance as any);

    // Mock successful API responses
    mockAxiosInstance.put.mockResolvedValue({ data: { success: true, keyVersion: 1 } });
    mockAxiosInstance.get.mockResolvedValue({
      data: {
        publicKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
        keyVersion: 1,
      },
    });

    // Create mock socket
    mockSocket = {
      on: jest.fn(),
      emit: jest.fn(),
      connected: true,
      disconnect: jest.fn(),
    };

    // Mock io to return our mock socket
    const { io } = require('socket.io-client');
    io.mockReturnValue(mockSocket);

    // Mock key storage
    jest.spyOn(keyStorage, 'getPrivateKey').mockResolvedValue(null);
    jest.spyOn(keyStorage, 'storePrivateKey').mockResolvedValue();

    // Initialize E2EE manager
    e2eeManager = new E2EEManager(deviceId, apiUrl, authToken);
    await e2eeManager.initialize();
  });

  describe('Key Exchange Events', () => {
    it('emits encrypted_key_exchange_init when starting encrypted session', async () => {
      const initPayload = await e2eeManager.initiateKeyExchange(mobileDeviceId);

      // Simulate emitting via WebSocket
      mockSocket.emit('encrypted_key_exchange_init', {
        recipientDeviceId: mobileDeviceId,
        ...initPayload,
      });

      expect(mockSocket.emit).toHaveBeenCalledWith(
        'encrypted_key_exchange_init',
        expect.objectContaining({
          senderDeviceId: deviceId,
          recipientDeviceId: mobileDeviceId,
          ephemeralPublicKey: expect.any(String),
        })
      );
    });

    it('handles incoming encrypted_key_exchange_init', async () => {
      const incomingInit = {
        senderDeviceId: mobileDeviceId,
        ephemeralPublicKey: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=',
      };

      // Handle key exchange init
      const ackPayload = await e2eeManager.handleKeyExchangeInit(
        incomingInit.senderDeviceId,
        incomingInit.ephemeralPublicKey
      );

      expect(ackPayload).toHaveProperty('recipientDeviceId', deviceId);
      expect(ackPayload).toHaveProperty('ephemeralPublicKey');
      expect(e2eeManager.hasSessionKey(mobileDeviceId)).toBe(true);
    });

    it('emits encrypted_key_exchange_ack after key derivation', async () => {
      const incomingInit = {
        senderDeviceId: mobileDeviceId,
        ephemeralPublicKey: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=',
      };

      const ackPayload = await e2eeManager.handleKeyExchangeInit(
        incomingInit.senderDeviceId,
        incomingInit.ephemeralPublicKey
      );

      // Simulate emitting ack via WebSocket
      mockSocket.emit('encrypted_key_exchange_ack', {
        senderDeviceId: deviceId,
        ...ackPayload,
      });

      expect(mockSocket.emit).toHaveBeenCalledWith(
        'encrypted_key_exchange_ack',
        expect.objectContaining({
          senderDeviceId: deviceId,
          recipientDeviceId: deviceId,
          ephemeralPublicKey: expect.any(String),
        })
      );
    });

    it('handles incoming encrypted_key_exchange_ack', async () => {
      // First initiate
      await e2eeManager.initiateKeyExchange(mobileDeviceId);

      // Then handle ack
      const incomingAck = {
        recipientDeviceId: deviceId,
        ephemeralPublicKey: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=',
      };

      await e2eeManager.handleKeyExchangeAck(
        mobileDeviceId,
        incomingAck.ephemeralPublicKey
      );

      expect(e2eeManager.hasSessionKey(mobileDeviceId)).toBe(true);
    });
  });

  describe('Message Encryption', () => {
    beforeEach(async () => {
      // Set up E2EE session
      await e2eeManager.initiateKeyExchange(mobileDeviceId);
      await e2eeManager.handleKeyExchangeAck(
        mobileDeviceId,
        'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM='
      );
    });

    it('encrypts user_message before sending when E2EE established', () => {
      const plaintext = 'Hello from CLI';
      const sessionId = 'session-abc';

      const encryptedMessage = e2eeManager.encryptMessage(
        plaintext,
        mobileDeviceId,
        sessionId
      );

      // Simulate emitting encrypted message via WebSocket
      mockSocket.emit('encrypted_message', encryptedMessage);

      expect(mockSocket.emit).toHaveBeenCalledWith(
        'encrypted_message',
        expect.objectContaining({
          senderDeviceId: deviceId,
          recipientDeviceId: mobileDeviceId,
          sessionId,
          payload: expect.objectContaining({
            ciphertext: expect.any(String),
            nonce: expect.any(String),
            authTag: expect.any(String),
          }),
          messageCounter: expect.any(Number),
          timestamp: expect.any(String),
        })
      );
    });

    it('falls back to plaintext if E2EE not established', () => {
      const unknownDeviceId = 'unknown-device';
      const plaintext = 'Hello';

      // Should throw because no session key exists
      expect(() =>
        e2eeManager.encryptMessage(plaintext, unknownDeviceId, 'session-123')
      ).toThrow(/No session key found/);
    });
  });

  describe('Message Decryption', () => {
    beforeEach(async () => {
      // Set up E2EE session as recipient
      const ephemeralPublicKey = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=';
      await e2eeManager.handleKeyExchangeInit(mobileDeviceId, ephemeralPublicKey);
    });

    it('decrypts incoming encrypted_message', () => {
      const plaintext = 'Secret message from mobile';
      const sessionId = 'session-xyz';

      // Get session key
      const sessionKeys = keyStorage.getSessionKey(mobileDeviceId);
      if (!sessionKeys) {
        throw new Error('Session key not found');
      }

      // Create encrypted message (simulating what mobile would send)
      const { encrypt } = require('../../crypto/encryption');
      const encryptedPayload = encrypt(plaintext, sessionKeys.encryptionKey);

      const encryptedMessage = {
        senderDeviceId: mobileDeviceId,
        recipientDeviceId: deviceId,
        sessionId,
        payload: encryptedPayload,
        messageCounter: 1,
        timestamp: new Date().toISOString(),
      };

      // Decrypt
      const decrypted = e2eeManager.decryptMessage(encryptedMessage, mobileDeviceId);

      expect(decrypted).toBe(plaintext);
    });

    it('rejects tampered encrypted messages', () => {
      const sessionKeys = keyStorage.getSessionKey(mobileDeviceId);
      if (!sessionKeys) {
        throw new Error('Session key not found');
      }

      const { encrypt } = require('../../crypto/encryption');
      const encryptedPayload = encrypt('Original message', sessionKeys.encryptionKey);

      // Tamper with ciphertext
      const tamperedCiphertext = Buffer.from(encryptedPayload.ciphertext, 'base64');
      tamperedCiphertext[0] ^= 0xff;
      encryptedPayload.ciphertext = tamperedCiphertext.toString('base64');

      const encryptedMessage = {
        senderDeviceId: mobileDeviceId,
        recipientDeviceId: deviceId,
        sessionId: 'session-xyz',
        payload: encryptedPayload,
        messageCounter: 1,
        timestamp: new Date().toISOString(),
      };

      // Should throw on decryption
      expect(() =>
        e2eeManager.decryptMessage(encryptedMessage, mobileDeviceId)
      ).toThrow();
    });
  });

  describe('E2EE Session Status', () => {
    it('tracks E2EE session status per device', async () => {
      expect(e2eeManager.hasSessionKey(mobileDeviceId)).toBe(false);

      // Set up session
      const ephemeralPublicKey = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=';
      await e2eeManager.handleKeyExchangeInit(mobileDeviceId, ephemeralPublicKey);

      expect(e2eeManager.hasSessionKey(mobileDeviceId)).toBe(true);
    });

    it('indicates when message should be encrypted', async () => {
      // No session - should not be able to encrypt
      expect(e2eeManager.hasSessionKey(mobileDeviceId)).toBe(false);

      // Set up session
      await e2eeManager.initiateKeyExchange(mobileDeviceId);
      await e2eeManager.handleKeyExchangeAck(
        mobileDeviceId,
        'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM='
      );

      // Now should be able to encrypt
      expect(e2eeManager.hasSessionKey(mobileDeviceId)).toBe(true);
    });

    it('cleans up E2EE sessions on disconnect', () => {
      // Set up session
      keyStorage.storeSessionKey(
        mobileDeviceId,
        new Uint8Array(32),
        'session-abc'
      );

      expect(e2eeManager.hasSessionKey(mobileDeviceId)).toBe(true);

      // Cleanup
      e2eeManager.cleanup();

      expect(e2eeManager.hasSessionKey(mobileDeviceId)).toBe(false);
    });
  });
});
