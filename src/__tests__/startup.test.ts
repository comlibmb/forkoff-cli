/**
 * Tests for startup module
 * Covers:
 * - Bug 1: Windows .bat wrapper for schtasks (avoids nested quoting)
 * - Bug 2: macOS plist uses explicit node path (nvm/fnm compatibility)
 * - disableStartup cleans up .bat file on Windows
 * - isStartupRegistered checks schtasks (win32) / plist existence (darwin)
 * - getBinaryPath: cached, which/where, fallback to process.argv[1]
 */

const mockExecSync = jest.fn();
jest.mock('child_process', () => ({
  execSync: mockExecSync,
}));

const mockExistsSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockUnlinkSync = jest.fn();
const mockMkdirSync = jest.fn();
jest.mock('fs', () => ({
  existsSync: mockExistsSync,
  writeFileSync: mockWriteFileSync,
  unlinkSync: mockUnlinkSync,
  mkdirSync: mockMkdirSync,
}));

const mockConfig: any = {
  startupBinaryPath: null,
  startupEnabled: null,
};
jest.mock('../config', () => ({
  config: mockConfig,
}));

import { getBinaryPath, isStartupRegistered, enableStartup, disableStartup } from '../startup';

describe('startup', () => {
  const originalPlatform = process.platform;
  const originalExecPath = process.execPath;
  const originalArgv = [...process.argv];

  function setPlatform(platform: string) {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }

  beforeEach(() => {
    // resetAllMocks clears calls AND implementations (unlike clearAllMocks)
    jest.resetAllMocks();
    mockConfig.startupBinaryPath = null;
    mockConfig.startupEnabled = null;
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
    process.argv = [...originalArgv];
  });

  describe('getBinaryPath', () => {
    it('returns cached path when it exists on disk', () => {
      mockConfig.startupBinaryPath = '/usr/local/bin/forkoff';
      mockExistsSync.mockReturnValue(true);

      expect(getBinaryPath()).toBe('/usr/local/bin/forkoff');
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('finds via which on darwin', () => {
      setPlatform('darwin');
      mockConfig.startupBinaryPath = null;
      mockExecSync.mockReturnValue('/usr/local/bin/forkoff\n');
      // startupBinaryPath is null → short-circuit, existsSync NOT called for cache.
      // First existsSync call is for the which result → return true.
      mockExistsSync.mockReturnValueOnce(true);

      expect(getBinaryPath()).toBe('/usr/local/bin/forkoff');
      expect(mockExecSync).toHaveBeenCalledWith('which forkoff', { encoding: 'utf-8' });
      expect(mockConfig.startupBinaryPath).toBe('/usr/local/bin/forkoff');
    });

    it('finds via where on win32', () => {
      setPlatform('win32');
      mockConfig.startupBinaryPath = null;
      mockExecSync.mockReturnValue('C:\\Program Files\\nodejs\\forkoff\r\n');
      mockExistsSync.mockReturnValueOnce(true);

      expect(getBinaryPath()).toBe('C:\\Program Files\\nodejs\\forkoff');
      expect(mockExecSync).toHaveBeenCalledWith('where forkoff', { encoding: 'utf-8' });
    });

    it('falls back to process.argv[1] when which/where fails', () => {
      setPlatform('darwin');
      mockConfig.startupBinaryPath = null;
      mockExecSync.mockImplementation(() => { throw new Error('not found'); });
      process.argv = ['node', '/home/user/.nvm/versions/node/bin/forkoff'];

      expect(getBinaryPath()).toBe('/home/user/.nvm/versions/node/bin/forkoff');
      expect(mockConfig.startupBinaryPath).toBe('/home/user/.nvm/versions/node/bin/forkoff');
    });

    it('throws when no binary can be found', () => {
      mockConfig.startupBinaryPath = null;
      mockExecSync.mockImplementation(() => { throw new Error('not found'); });
      process.argv = ['node']; // No argv[1]

      expect(() => getBinaryPath()).toThrow('Could not determine forkoff binary path');
    });
  });

  describe('isStartupRegistered', () => {
    it('returns true on win32 when schtasks query succeeds', () => {
      setPlatform('win32');
      mockExecSync.mockReturnValue('');

      expect(isStartupRegistered()).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('schtasks /Query'),
        { stdio: 'pipe' }
      );
    });

    it('returns false on win32 when schtasks query throws', () => {
      setPlatform('win32');
      mockExecSync.mockImplementation(() => { throw new Error('not found'); });

      expect(isStartupRegistered()).toBe(false);
    });

    it('returns true on darwin when plist file exists', () => {
      setPlatform('darwin');
      mockExistsSync.mockReturnValue(true);

      expect(isStartupRegistered()).toBe(true);
    });

    it('returns false on darwin when plist file does not exist', () => {
      setPlatform('darwin');
      mockExistsSync.mockReturnValue(false);

      expect(isStartupRegistered()).toBe(false);
    });

    it('returns false on unsupported platform', () => {
      setPlatform('linux');
      expect(isStartupRegistered()).toBe(false);
    });
  });

  describe('enableStartup (win32)', () => {
    beforeEach(() => {
      setPlatform('win32');
      Object.defineProperty(process, 'execPath', {
        value: 'C:\\Program Files\\nodejs\\node.exe',
        configurable: true,
      });
      mockConfig.startupBinaryPath = 'C:\\Users\\test\\AppData\\Roaming\\npm\\forkoff';
      mockExistsSync.mockReturnValue(true);
    });

    it('writes .bat wrapper with correct content', async () => {
      await enableStartup();

      const batCall = mockWriteFileSync.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].endsWith('.bat')
      );
      expect(batCall).toBeDefined();
      const batContent = batCall![1] as string;
      expect(batContent).toContain('@echo off');
      expect(batContent).toContain('"C:\\Program Files\\nodejs\\node.exe"');
      expect(batContent).toContain('"C:\\Users\\test\\AppData\\Roaming\\npm\\forkoff"');
      expect(batContent).toContain('connect --quiet');
    });

    it('calls schtasks /Create with .bat path', async () => {
      await enableStartup();

      const createCall = mockExecSync.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('schtasks /Create')
      );
      expect(createCall).toBeDefined();
      expect(createCall![0]).toContain('startup.bat');
      expect(createCall![0]).toContain('/SC ONLOGON');
    });

    it('sets config.startupEnabled = true', async () => {
      await enableStartup();
      expect(mockConfig.startupEnabled).toBe(true);
    });
  });

  describe('enableStartup (darwin)', () => {
    beforeEach(() => {
      setPlatform('darwin');
      Object.defineProperty(process, 'execPath', {
        value: '/Users/test/.nvm/versions/node/v20.0.0/bin/node',
        configurable: true,
      });
      mockConfig.startupBinaryPath = '/usr/local/bin/forkoff';
      mockExistsSync.mockReturnValue(true);
    });

    it('writes plist with process.execPath as first ProgramArgument', async () => {
      await enableStartup();

      const plistCall = mockWriteFileSync.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].endsWith('.plist')
      );
      expect(plistCall).toBeDefined();
      const plistContent = plistCall![1] as string;

      const argsMatch = plistContent.match(/<array>([\s\S]*?)<\/array>/);
      expect(argsMatch).toBeDefined();
      const strings = [...argsMatch![1].matchAll(/<string>(.*?)<\/string>/g)].map(m => m[1]);
      expect(strings[0]).toBe('/Users/test/.nvm/versions/node/v20.0.0/bin/node');
      expect(strings[1]).toBe('/usr/local/bin/forkoff');
      expect(strings[2]).toBe('connect');
      expect(strings[3]).toBe('--quiet');
    });

    it('includes node directory in PATH when not in default PATH', async () => {
      await enableStartup();

      const plistCall = mockWriteFileSync.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].endsWith('.plist')
      );
      const plistContent = plistCall![1] as string;
      expect(plistContent).toContain('/Users/test/.nvm/versions/node/v20.0.0/bin:');
    });

    it('calls launchctl load', async () => {
      await enableStartup();

      const loadCall = mockExecSync.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('launchctl load')
      );
      expect(loadCall).toBeDefined();
    });

    it('sets config.startupEnabled = true', async () => {
      await enableStartup();
      expect(mockConfig.startupEnabled).toBe(true);
    });
  });

  describe('disableStartup (win32)', () => {
    beforeEach(() => {
      setPlatform('win32');
    });

    it('calls schtasks /Delete', async () => {
      await disableStartup();

      const deleteCall = mockExecSync.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('schtasks /Delete')
      );
      expect(deleteCall).toBeDefined();
    });

    it('removes .bat file if it exists', async () => {
      mockExistsSync.mockReturnValue(true);

      await disableStartup();

      expect(mockUnlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('startup.bat')
      );
    });

    it('sets config.startupEnabled = false', async () => {
      await disableStartup();
      expect(mockConfig.startupEnabled).toBe(false);
    });
  });

  describe('disableStartup (darwin)', () => {
    beforeEach(() => {
      setPlatform('darwin');
    });

    it('calls launchctl unload and removes plist when it exists', async () => {
      mockExistsSync.mockReturnValue(true);

      await disableStartup();

      const unloadCall = mockExecSync.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('launchctl unload')
      );
      expect(unloadCall).toBeDefined();
      expect(mockUnlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('.plist')
      );
    });

    it('does nothing when plist does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      await disableStartup();

      expect(mockUnlinkSync).not.toHaveBeenCalled();
    });

    it('sets config.startupEnabled = false', async () => {
      await disableStartup();
      expect(mockConfig.startupEnabled).toBe(false);
    });
  });
});
