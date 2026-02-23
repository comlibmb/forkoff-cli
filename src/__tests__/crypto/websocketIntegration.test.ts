import { E2EEManager } from '../../crypto/e2eeManager';
import * as keyStorage from '../../crypto/keyStorage';
import * as keyGeneration from '../../crypto/keyGeneration';

// Mock server module (socket.io-client no longer used)
jest.mock('../../server', () => ({
  EmbeddedRelayServer: jest.fn(),
}));

// Mock keytar
jest.mock('keytar');

// Mock sessionPersistence to avoid disk I/O
jest.mock('../../crypto/sessionPersistence', () => ({
  initSessionPersistence: jest.fn(),
  persistSessionKey: jest.fn(),
  loadPersistedSessionKey: jest.fn().mockReturnValue(null),
  deletePersistedSession: jest.fn(),
  deleteAllPersistedSessions: jest.fn(),
  listPersistedSessions: jest.fn().mockReturnValue([]),
}));

describe('CLI WebSocket E2EE Integration', () => {
  let e2eeManager: E2EEManager;
  let mockSocket: any;

  const deviceId = 'cli-device-123';
  const mobileDeviceId = 'mobile-device-456';

  beforeEach(async () => {
    jest.clearAllMocks();
    keyStorage.clearSessionKeys();

    // Create mock socket (used to simulate WebSocket emit calls)
    mockSocket = {
      on: jest.fn(),
      emit: jest.fn(),
      connected: true,
      disconnect: jest.fn(),
    };

    // Mock key storage
    jest.spyOn(keyStorage, 'getPrivateKey').mockResolvedValue(null);
    jest.spyOn(keyStorage, 'storePrivateKey').mockResolvedValue();

    // Initialize E2EE manager (new NaCl-based API: only deviceId)
    e2eeManager = new E2EEManager(deviceId);
    await e2eeManager.initialize();
  });

  describe('Key Exchange Events', () => {
    it('emits encrypted_key_exchange_init when starting encrypted session', () => {
      const initPayload = e2eeManager.createKeyExchangeInit(mobileDeviceId);

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

    it('handles incoming encrypted_key_exchange_init', () => {
      // Generate real ephemeral keys so the key exchange computes properly
      const senderEphemeral = keyGeneration.generateKeyPair();

      const incomingInit = {
        senderDeviceId: mobileDeviceId,
        ephemeralPublicKey: senderEphemeral.publicKey,
      };

      // Handle key exchange init (new API: takes KeyExchangeInit object)
      const ackPayload = e2eeManager.handleKeyExchangeInit(incomingInit);

      expect(ackPayload).toHaveProperty('recipientDeviceId', mobileDeviceId);
      expect(ackPayload).toHaveProperty('ephemeralPublicKey');
      expect(e2eeManager.hasSessionKey(mobileDeviceId)).toBe(true);
    });

    it('emits encrypted_key_exchange_ack after key derivation', () => {
      const senderEphemeral = keyGeneration.generateKeyPair();

      const incomingInit = {
        senderDeviceId: mobileDeviceId,
        ephemeralPublicKey: senderEphemeral.publicKey,
      };

      const ackPayload = e2eeManager.handleKeyExchangeInit(incomingInit);

      // Simulate emitting ack via WebSocket
      mockSocket.emit('encrypted_key_exchange_ack', ackPayload);

      expect(mockSocket.emit).toHaveBeenCalledWith(
        'encrypted_key_exchange_ack',
        expect.objectContaining({
          senderDeviceId: deviceId,
          recipientDeviceId: mobileDeviceId,
          ephemeralPublicKey: expect.any(String),
        })
      );
    });

    it('handles incoming encrypted_key_exchange_ack', () => {
      // First create init (stores pending ephemeral)
      e2eeManager.createKeyExchangeInit(mobileDeviceId);

      // Generate real ephemeral for the ack
      const responderEphemeral = keyGeneration.generateKeyPair();

      const incomingAck = {
        senderDeviceId: mobileDeviceId,
        recipientDeviceId: deviceId,
        ephemeralPublicKey: responderEphemeral.publicKey,
      };

      // Handle ack (new API: takes KeyExchangeAck object)
      e2eeManager.handleKeyExchangeAck(incomingAck);

      expect(e2eeManager.hasSessionKey(mobileDeviceId)).toBe(true);
    });
  });

  describe('Message Encryption', () => {
    beforeEach(() => {
      // Set up a real E2EE session via proper key exchange
      const initPayload = e2eeManager.createKeyExchangeInit(mobileDeviceId);

      // Simulate the other side responding with a real ephemeral key
      const responderEphemeral = keyGeneration.generateKeyPair();
      e2eeManager.handleKeyExchangeAck({
        senderDeviceId: mobileDeviceId,
        recipientDeviceId: deviceId,
        ephemeralPublicKey: responderEphemeral.publicKey,
      });
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
          }),
          messageCounter: expect.any(Number),
          timestamp: expect.any(String),
        })
      );

      // NaCl secretbox does NOT have a separate authTag
      expect(encryptedMessage.payload).not.toHaveProperty('authTag');
    });

    it('throws if E2EE not established for target device', () => {
      const unknownDeviceId = 'unknown-device';
      const plaintext = 'Hello';

      // Should throw because no session key exists
      expect(() =>
        e2eeManager.encryptMessage(plaintext, unknownDeviceId, 'session-123')
      ).toThrow(/No session established/);
    });
  });

  describe('Message Decryption (cross-device)', () => {
    let mobileManager: E2EEManager;

    beforeEach(async () => {
      // Create a second E2EE manager to simulate the mobile side
      mobileManager = new E2EEManager(mobileDeviceId);
      await mobileManager.initialize();

      // Complete key exchange: mobile initiates, CLI responds
      const initPayload = mobileManager.createKeyExchangeInit(deviceId);
      const ackPayload = e2eeManager.handleKeyExchangeInit(initPayload);
      mobileManager.handleKeyExchangeAck(ackPayload);
    });

    it('decrypts incoming encrypted_message', () => {
      const plaintext = 'Secret message from mobile';
      const sessionId = 'session-xyz';

      // Mobile encrypts
      const encryptedMessage = mobileManager.encryptMessage(
        plaintext,
        deviceId,
        sessionId
      );

      // CLI decrypts
      const decrypted = e2eeManager.decryptMessage(encryptedMessage, mobileDeviceId);

      expect(decrypted).toBe(plaintext);
    });

    it('rejects tampered encrypted messages', () => {
      const plaintext = 'Original message';
      const sessionId = 'session-xyz';

      const encryptedMessage = mobileManager.encryptMessage(
        plaintext,
        deviceId,
        sessionId
      );

      // Tamper with ciphertext
      const tamperedCiphertext = Buffer.from(encryptedMessage.payload.ciphertext, 'base64');
      tamperedCiphertext[0] ^= 0xff;
      encryptedMessage.payload.ciphertext = tamperedCiphertext.toString('base64');

      // Should throw on decryption
      expect(() =>
        e2eeManager.decryptMessage(encryptedMessage, mobileDeviceId)
      ).toThrow();
    });
  });

  describe('E2EE Session Status', () => {
    it('tracks E2EE session status per device', () => {
      expect(e2eeManager.hasSessionKey(mobileDeviceId)).toBe(false);

      // Set up session via handleKeyExchangeInit
      const ephemeral = keyGeneration.generateKeyPair();
      e2eeManager.handleKeyExchangeInit({
        senderDeviceId: mobileDeviceId,
        ephemeralPublicKey: ephemeral.publicKey,
      });

      expect(e2eeManager.hasSessionKey(mobileDeviceId)).toBe(true);
    });

    it('indicates when message should be encrypted', () => {
      // No session - should not be able to encrypt
      expect(e2eeManager.hasSessionKey(mobileDeviceId)).toBe(false);

      // Set up session via createKeyExchangeInit + handleKeyExchangeAck
      e2eeManager.createKeyExchangeInit(mobileDeviceId);
      const responderEphemeral = keyGeneration.generateKeyPair();
      e2eeManager.handleKeyExchangeAck({
        senderDeviceId: mobileDeviceId,
        recipientDeviceId: deviceId,
        ephemeralPublicKey: responderEphemeral.publicKey,
      });

      // Now should be able to encrypt
      expect(e2eeManager.hasSessionKey(mobileDeviceId)).toBe(true);
    });

    it('cleans up E2EE sessions on disconnect', () => {
      // Set up session
      const ephemeral = keyGeneration.generateKeyPair();
      e2eeManager.handleKeyExchangeInit({
        senderDeviceId: mobileDeviceId,
        ephemeralPublicKey: ephemeral.publicKey,
      });

      expect(e2eeManager.hasSessionKey(mobileDeviceId)).toBe(true);

      // Cleanup
      e2eeManager.cleanup();

      expect(e2eeManager.hasSessionKey(mobileDeviceId)).toBe(false);
    });
  });
});
