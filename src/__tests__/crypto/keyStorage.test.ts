import {
  storePrivateKey,
  getPrivateKey,
  deletePrivateKey,
  storeSessionKey,
  getSessionKey,
  clearSessionKeys,
} from '../../crypto/keyStorage';

// Mock keytar to avoid actual OS keychain operations during tests
jest.mock('keytar', () => ({
  setPassword: jest.fn(),
  getPassword: jest.fn(),
  deletePassword: jest.fn(),
}));

import * as keytar from 'keytar';

describe('CLI Key Storage', () => {
  const mockKeytar = keytar as jest.Mocked<typeof keytar>;

  beforeEach(() => {
    jest.clearAllMocks();
    // Clear session keys between tests
    clearSessionKeys();
  });

  describe('OS Keychain Operations', () => {
    it('stores private key in OS keychain', async () => {
      const deviceId = 'device-123';
      const privateKey = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';

      mockKeytar.setPassword.mockResolvedValue();

      await storePrivateKey(deviceId, privateKey);

      expect(mockKeytar.setPassword).toHaveBeenCalledWith(
        'forkoff-cli',
        `e2ee-private-key-${deviceId}`,
        privateKey
      );
    });

    it('retrieves private key from OS keychain', async () => {
      const deviceId = 'device-123';
      const privateKey = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';

      mockKeytar.getPassword.mockResolvedValue(privateKey);

      const result = await getPrivateKey(deviceId);

      expect(result).toBe(privateKey);
      expect(mockKeytar.getPassword).toHaveBeenCalledWith(
        'forkoff-cli',
        `e2ee-private-key-${deviceId}`
      );
    });

    it('returns null when no key exists', async () => {
      const deviceId = 'device-123';

      mockKeytar.getPassword.mockResolvedValue(null);

      const result = await getPrivateKey(deviceId);

      expect(result).toBeNull();
    });

    it('deletes keys from keychain', async () => {
      const deviceId = 'device-123';

      mockKeytar.deletePassword.mockResolvedValue(true);

      await deletePrivateKey(deviceId);

      expect(mockKeytar.deletePassword).toHaveBeenCalledWith(
        'forkoff-cli',
        `e2ee-private-key-${deviceId}`
      );
    });

    it('handles keychain errors gracefully', async () => {
      const deviceId = 'device-123';

      mockKeytar.getPassword.mockRejectedValue(new Error('Keychain access denied'));

      // Should not throw, should return null
      const result = await getPrivateKey(deviceId);

      expect(result).toBeNull();
    });
  });

  describe('Session Key Storage (In-Memory)', () => {
    it('stores session keys in memory', () => {
      const deviceId = 'device-456';
      const sessionKey = new Uint8Array(32).fill(1);
      const sessionId = 'session-abc';

      storeSessionKey(deviceId, sessionKey, sessionId);

      const retrieved = getSessionKey(deviceId);

      expect(retrieved).toEqual({
        encryptionKey: sessionKey,
        sessionId,
      });
    });

    it('retrieves session keys by device ID', () => {
      const deviceId = 'device-456';
      const sessionKey = new Uint8Array(32).fill(2);
      const sessionId = 'session-xyz';

      storeSessionKey(deviceId, sessionKey, sessionId);

      const retrieved = getSessionKey(deviceId);

      expect(retrieved?.encryptionKey).toEqual(sessionKey);
      expect(retrieved?.sessionId).toBe(sessionId);
    });

    it('returns null for non-existent session keys', () => {
      const result = getSessionKey('nonexistent-device');

      expect(result).toBeNull();
    });

    it('clears all session keys', () => {
      const device1 = 'device-1';
      const device2 = 'device-2';

      storeSessionKey(device1, new Uint8Array(32).fill(1), 'session-1');
      storeSessionKey(device2, new Uint8Array(32).fill(2), 'session-2');

      clearSessionKeys();

      expect(getSessionKey(device1)).toBeNull();
      expect(getSessionKey(device2)).toBeNull();
    });

    it('overwrites existing session key for same device', () => {
      const deviceId = 'device-123';
      const firstKey = new Uint8Array(32).fill(1);
      const secondKey = new Uint8Array(32).fill(2);

      storeSessionKey(deviceId, firstKey, 'session-1');
      storeSessionKey(deviceId, secondKey, 'session-2');

      const retrieved = getSessionKey(deviceId);

      expect(retrieved?.encryptionKey).toEqual(secondKey);
      expect(retrieved?.sessionId).toBe('session-2');
    });
  });
});
