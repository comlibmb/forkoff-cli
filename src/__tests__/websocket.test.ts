/**
 * Tests for WebSocketClient reconnection resilience
 *
 * Verifies:
 * - Socket.io configured with Infinity reconnectionAttempts, 30s max delay, 0.5 randomization
 * - Immediate heartbeat sent after reconnect (when reconnectAttempts > 0)
 * - 'reconnecting' event emitted with attempt count on connect_error
 * - 'reconnected' event emitted with total attempts on successful reconnect
 * - Initial connect times out after 30s
 * - Disconnect reason logged
 */

// Build a mock socket with handler tracking
const mockHandlers = new Map<string, Function[]>();
const mockSocket = {
  connected: false,
  id: 'mock-socket-id',
  on: jest.fn((event: string, handler: Function) => {
    if (!mockHandlers.has(event)) {
      mockHandlers.set(event, []);
    }
    mockHandlers.get(event)!.push(handler);
    return mockSocket;
  }),
  onAny: jest.fn(),
  emit: jest.fn(),
  disconnect: jest.fn(),
};

jest.mock('socket.io-client', () => ({
  io: jest.fn(() => mockSocket),
}));

jest.mock('../config', () => ({
  config: {
    deviceId: 'test-device-id',
    wsUrl: 'ws://localhost:3000',
    userId: 'test-user-id',
  },
}));

// Mock package.json for cliVersion
jest.mock('../../package.json', () => ({ version: '1.0.0-test' }), { virtual: true });

import { WebSocketClient } from '../websocket';
const { io: mockIo } = jest.requireMock('socket.io-client');

function triggerSocketEvent(event: string, ...args: unknown[]) {
  const handlers = mockHandlers.get(event) || [];
  handlers.forEach((h) => h(...args));
}

describe('WebSocketClient - Reconnection Resilience', () => {
  let wsClient: WebSocketClient;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockHandlers.clear();
    mockSocket.connected = false;
    wsClient = new WebSocketClient();
    // Prevent Node.js EventEmitter from throwing on unhandled 'error' events
    wsClient.on('error', () => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    wsClient.disconnect();
  });

  describe('Socket.io configuration', () => {
    it('should configure infinite reconnection attempts', () => {
      // Start connect (don't await — we just need the io() call)
      wsClient.connect();

      expect(mockIo).toHaveBeenCalledWith(
        'ws://localhost:3000',
        expect.objectContaining({
          reconnectionAttempts: Infinity,
        }),
      );
    });

    it('should configure 30s max reconnection delay', () => {
      wsClient.connect();

      expect(mockIo).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          reconnectionDelayMax: 30000,
        }),
      );
    });

    it('should configure 0.5 randomization factor', () => {
      wsClient.connect();

      expect(mockIo).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          randomizationFactor: 0.5,
        }),
      );
    });

    it('should use websocket transport only', () => {
      wsClient.connect();

      expect(mockIo).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          transports: ['websocket'],
        }),
      );
    });

    it('should enable reconnection', () => {
      wsClient.connect();

      expect(mockIo).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          reconnection: true,
        }),
      );
    });
  });

  describe('Reconnect behavior', () => {
    it('should send immediate heartbeat after reconnect', () => {
      wsClient.connect();

      // Simulate connect_error to increment reconnectAttempts
      triggerSocketEvent('connect_error', new Error('connection failed'));

      // Clear previous emit calls
      mockSocket.emit.mockClear();

      // Simulate successful reconnect
      mockSocket.connected = true;
      triggerSocketEvent('connect');

      // Should have sent a heartbeat immediately on reconnect
      expect(mockSocket.emit).toHaveBeenCalledWith('device_heartbeat', { status: 'online' });
    });

    it('should NOT send immediate heartbeat on first connect', () => {
      wsClient.connect();

      mockSocket.emit.mockClear();

      // Simulate first connection (no prior connect_errors)
      mockSocket.connected = true;
      triggerSocketEvent('connect');

      // device_heartbeat should NOT be called immediately (only via startHeartbeat interval)
      const heartbeatCalls = mockSocket.emit.mock.calls.filter(
        (call) => call[0] === 'device_heartbeat',
      );
      expect(heartbeatCalls.length).toBe(0);
    });

    it('should emit "reconnected" event with attempt count on successful reconnect', () => {
      const reconnectedSpy = jest.fn();
      wsClient.on('reconnected', reconnectedSpy);

      wsClient.connect();

      // Simulate 3 connect_errors
      triggerSocketEvent('connect_error', new Error('fail 1'));
      triggerSocketEvent('connect_error', new Error('fail 2'));
      triggerSocketEvent('connect_error', new Error('fail 3'));

      // Simulate successful reconnect
      mockSocket.connected = true;
      triggerSocketEvent('connect');

      expect(reconnectedSpy).toHaveBeenCalledWith({ attempts: 3 });
    });

    it('should emit "reconnecting" event with attempt count on connect_error', () => {
      const reconnectingSpy = jest.fn();
      wsClient.on('reconnecting', reconnectingSpy);

      wsClient.connect();

      triggerSocketEvent('connect_error', new Error('network error'));

      expect(reconnectingSpy).toHaveBeenCalledWith({ attempt: 1 });

      triggerSocketEvent('connect_error', new Error('network error again'));

      expect(reconnectingSpy).toHaveBeenCalledWith({ attempt: 2 });
    });

    it('should reset reconnectAttempts to 0 after successful reconnect', () => {
      const reconnectedSpy = jest.fn();
      wsClient.on('reconnected', reconnectedSpy);

      wsClient.connect();

      // Simulate errors then reconnect
      triggerSocketEvent('connect_error', new Error('fail'));
      triggerSocketEvent('connect_error', new Error('fail'));
      mockSocket.connected = true;
      triggerSocketEvent('connect');

      expect(reconnectedSpy).toHaveBeenCalledWith({ attempts: 2 });
      reconnectedSpy.mockClear();

      // Simulate another disconnect/reconnect cycle
      triggerSocketEvent('connect_error', new Error('fail again'));
      triggerSocketEvent('connect');

      // Should be 1, not 3 (because counter was reset)
      expect(reconnectedSpy).toHaveBeenCalledWith({ attempts: 1 });
    });
  });

  describe('Initial connect timeout', () => {
    it('should reject after 30 seconds if initial connection fails', async () => {
      const connectPromise = wsClient.connect();

      // Advance past the 30s timeout
      jest.advanceTimersByTime(30000);

      await expect(connectPromise).rejects.toThrow('Initial connection timed out after 30 seconds');
    });

    it('should resolve if connect happens before timeout', async () => {
      const connectPromise = wsClient.connect();

      // Simulate connect within timeout
      mockSocket.connected = true;
      triggerSocketEvent('connect');

      await expect(connectPromise).resolves.toBeUndefined();
    });
  });

  describe('Disconnect handling', () => {
    it('should emit disconnected event with reason', () => {
      const disconnectedSpy = jest.fn();
      wsClient.on('disconnected', disconnectedSpy);

      wsClient.connect();

      triggerSocketEvent('disconnect', 'transport close');

      expect(disconnectedSpy).toHaveBeenCalledWith('transport close');
    });

    it('should emit error on connect_error', () => {
      const errorSpy = jest.fn();
      wsClient.on('error', errorSpy);

      wsClient.connect();

      const testError = new Error('connection refused');
      triggerSocketEvent('connect_error', testError);

      expect(errorSpy).toHaveBeenCalledWith(testError);
    });
  });

  describe('Device registration rejection', () => {
    it('should reject connect if no deviceId is configured', async () => {
      // Override config to have no deviceId
      const configModule = jest.requireMock('../config');
      const originalDeviceId = configModule.config.deviceId;
      configModule.config.deviceId = '';

      const freshClient = new WebSocketClient();
      await expect(freshClient.connect()).rejects.toThrow('Device not registered');

      // Restore
      configModule.config.deviceId = originalDeviceId;
    });
  });
});
