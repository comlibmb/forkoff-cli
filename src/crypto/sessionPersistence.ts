import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionKeys } from './types';

/**
 * Session Persistence
 * Stores session keys to disk so they survive reconnections after IP changes
 */

const SESSION_STORE_DIR = path.join(os.homedir(), '.forkoff-cli', 'sessions');

/**
 * Ensures the session store directory exists
 */
function ensureSessionStoreExists(): void {
  if (!fs.existsSync(SESSION_STORE_DIR)) {
    fs.mkdirSync(SESSION_STORE_DIR, { recursive: true });
  }
}

/**
 * Gets the file path for a device's session
 */
function getSessionFilePath(deviceId: string, targetDeviceId: string): string {
  return path.join(SESSION_STORE_DIR, `${deviceId}-${targetDeviceId}.json`);
}

/**
 * Persists a session key to disk
 * @param deviceId - Current device ID
 * @param targetDeviceId - Target device ID
 * @param sessionKeys - Session encryption keys
 */
export function persistSessionKey(
  deviceId: string,
  targetDeviceId: string,
  sessionKeys: SessionKeys
): void {
  try {
    ensureSessionStoreExists();

    const data = {
      encryptionKey: Array.from(sessionKeys.encryptionKey), // Convert Uint8Array to Array for JSON
      sessionId: sessionKeys.sessionId,
      timestamp: new Date().toISOString(),
    };

    const filePath = getSessionFilePath(deviceId, targetDeviceId);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('Failed to persist session key:', error);
  }
}

/**
 * Loads a persisted session key from disk
 * @param deviceId - Current device ID
 * @param targetDeviceId - Target device ID
 * @returns SessionKeys or null if not found
 */
export function loadPersistedSessionKey(
  deviceId: string,
  targetDeviceId: string
): SessionKeys | null {
  try {
    const filePath = getSessionFilePath(deviceId, targetDeviceId);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    // Check if session is expired (older than 24 hours)
    const timestamp = new Date(data.timestamp);
    const now = new Date();
    const hoursSinceCreation = (now.getTime() - timestamp.getTime()) / (1000 * 60 * 60);

    if (hoursSinceCreation > 24) {
      // Session expired, delete it
      fs.unlinkSync(filePath);
      return null;
    }

    return {
      encryptionKey: new Uint8Array(data.encryptionKey),
      sessionId: data.sessionId,
    };
  } catch (error) {
    console.error('Failed to load persisted session key:', error);
    return null;
  }
}

/**
 * Deletes a persisted session
 * @param deviceId - Current device ID
 * @param targetDeviceId - Target device ID
 */
export function deletePersistedSession(
  deviceId: string,
  targetDeviceId: string
): void {
  try {
    const filePath = getSessionFilePath(deviceId, targetDeviceId);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error('Failed to delete persisted session:', error);
  }
}

/**
 * Deletes all persisted sessions for a device
 * @param deviceId - Current device ID
 */
export function deleteAllPersistedSessions(deviceId: string): void {
  try {
    if (!fs.existsSync(SESSION_STORE_DIR)) {
      return;
    }

    const files = fs.readdirSync(SESSION_STORE_DIR);

    for (const file of files) {
      if (file.startsWith(`${deviceId}-`)) {
        fs.unlinkSync(path.join(SESSION_STORE_DIR, file));
      }
    }
  } catch (error) {
    console.error('Failed to delete all persisted sessions:', error);
  }
}

/**
 * Lists all persisted sessions for a device
 * @param deviceId - Current device ID
 * @returns Array of target device IDs with active sessions
 */
export function listPersistedSessions(deviceId: string): string[] {
  try {
    if (!fs.existsSync(SESSION_STORE_DIR)) {
      return [];
    }

    const files = fs.readdirSync(SESSION_STORE_DIR);
    const prefix = `${deviceId}-`;

    return files
      .filter((file) => file.startsWith(prefix) && file.endsWith('.json'))
      .map((file) => file.substring(prefix.length, file.length - 5)); // Remove prefix and .json
  } catch (error) {
    console.error('Failed to list persisted sessions:', error);
    return [];
  }
}
