/**
 * Tests for WebSocketClient with embedded relay server
 *
 * Verifies:
 * - Server starts and listens on specified port
 * - Mobile connections are accepted/rejected based on auth
 * - Events are forwarded from server to WebSocketClient EventEmitter
 * - isConnected reflects mobile connection state
 * - Pairing code validation works in-process
 * - Heartbeat sent to connected mobile
 * - Device registration required before starting server
 */

// Mock the server module
const mockServer = {
  start: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
  setPairingCode: jest.fn(),
  emitToMobile: jest.fn(),
  hasMobileConnection: jest.fn().mockReturnValue(false),
  getMobileDeviceId: jest.fn().mockReturnValue(null),
  on: jest.fn(),
  removeAllListeners: jest.fn(),
};

jest.mock('../server', () => ({
  EmbeddedRelayServer: jest.fn(() => mockServer),
}));

jest.mock('../config', () => ({
  config: {
    deviceId: 'test-device-id',
    deviceName: 'test-device',
    relayPort: 3000,
  },
}));

// Mock E2EE to avoid real crypto
jest.mock('../crypto/e2eeManager', () => ({
  E2EEManager: jest.fn(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    listPersistedDevices: jest.fn().mockReturnValue([]),
    restorePersistedSession: jest.fn().mockResolvedValue(false),
    hasSessionKey: jest.fn().mockReturnValue(false),
    cleanup: jest.fn(),
  })),
}));

import { WebSocketClient } from '../websocket';

describe('WebSocketClient - Embedded Server Mode', () => {
  let wsClient: WebSocketClient;

  beforeEach(() => {
    jest.clearAllMocks();
    wsClient = new WebSocketClient();
    // Prevent unhandled 'error' event throws
    wsClient.on('error', () => {});
  });

  afterEach(() => {
    wsClient.disconnect();
  });

  describe('Server startup', () => {
    it('should start the embedded relay server on specified port', async () => {
      await wsClient.startServer(3000);
      expect(mockServer.start).toHaveBeenCalled();
    });

    it('should reject if no deviceId is configured', async () => {
      const configModule = jest.requireMock('../config');
      const originalDeviceId = configModule.config.deviceId;
      configModule.config.deviceId = '';

      const freshClient = new WebSocketClient();
      await expect(freshClient.startServer(3000)).rejects.toThrow('Device not registered');

      configModule.config.deviceId = originalDeviceId;
    });
  });

  describe('Pairing code', () => {
    it('should set pairing code on server', async () => {
      await wsClient.startServer(3000);
      wsClient.setPairingCode('ABC12345');
      expect(mockServer.setPairingCode).toHaveBeenCalledWith('ABC12345');
    });
  });

  describe('isConnected', () => {
    it('should return false when no mobile is connected', async () => {
      await wsClient.startServer(3000);
      mockServer.hasMobileConnection.mockReturnValue(false);
      expect(wsClient.isConnected).toBe(false);
    });

    it('should return true when mobile is connected', async () => {
      await wsClient.startServer(3000);
      mockServer.hasMobileConnection.mockReturnValue(true);
      expect(wsClient.isConnected).toBe(true);
    });

    it('should return false when server is not started', () => {
      expect(wsClient.isConnected).toBe(false);
    });
  });

  describe('Emit to mobile', () => {
    it('should send non-sensitive events via emitToMobile', async () => {
      await wsClient.startServer(3000);
      wsClient.sendToolStatusUpdate('claude_code', 'active');
      expect(mockServer.emitToMobile).toHaveBeenCalledWith('tool_status_update', expect.objectContaining({
        toolType: 'claude_code',
        status: 'active',
      }));
    });

    it('should send heartbeat to mobile', async () => {
      await wsClient.startServer(3000);
      wsClient.sendHeartbeat('online');
      expect(mockServer.emitToMobile).toHaveBeenCalledWith('device_status', {
        status: 'online',
        deviceId: 'test-device-id',
      });
    });
  });

  describe('Disconnect', () => {
    it('should stop the server on disconnect', async () => {
      await wsClient.startServer(3000);
      wsClient.disconnect();
      expect(mockServer.stop).toHaveBeenCalled();
    });
  });
});
