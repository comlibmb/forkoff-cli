import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { SessionKeys } from './types';

/**
 * Session Persistence
 * Stores session keys to disk so they survive reconnections after IP changes.
 * Session data is encrypted at rest using a key derived from the device's identity private key.
 */

const SESSION_STORE_DIR = path.join(os.homedir(), '.forkoff-cli', 'sessions');

// In-memory encryption key for session files (derived from identity key at init)
let sessionFileKey: Uint8Array | null = null;

/**
 * Initialize session persistence with a key for encrypting session files at rest.
 * Derives a 32-byte key from the identity private key using NaCl hash.
 */
export function initSessionPersistence(identityPrivateKeyB64: string): void {
  const privateKey = decodeBase64(identityPrivateKeyB64);
  // Use NaCl hash to derive a deterministic 32-byte key from the private key
  // SHA-512 first 32 bytes = consistent encryption key for session files
  const hash = nacl.hash(privateKey);
  sessionFileKey = hash.slice(0, 32);
}

function ensureSessionStoreExists(): void {
  if (!fs.existsSync(SESSION_STORE_DIR)) {
    fs.mkdirSync(SESSION_STORE_DIR, { recursive: true, mode: 0o700 });
  } else {
    // SECURITY: Validate existing dir isn't world/group-writable (attacker pre-creation)
    const stat = fs.statSync(SESSION_STORE_DIR);
    const mode = stat.mode & 0o777;
    if (mode & 0o022) { // group or other writable
      throw new Error(`Session store has unsafe permissions (${mode.toString(8)})`);
    }
  }
}

function sanitizeDeviceIdForPath(id: string): string {
  // Strip path traversal and dangerous characters
  return id.replace(/[\/\\\.]+/g, '_').replace(/\.\./g, '_').substring(0, 64);
}

function getSessionFilePath(deviceId: string, targetDeviceId: string): string {
  const safeDeviceId = sanitizeDeviceIdForPath(deviceId);
  const safeTargetId = sanitizeDeviceIdForPath(targetDeviceId);
  const filePath = path.join(SESSION_STORE_DIR, `${safeDeviceId}-${safeTargetId}.json`);
  // Ensure resolved path is within SESSION_STORE_DIR
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(SESSION_STORE_DIR))) {
    throw new Error('E2EE: Session file path escapes store directory');
  }
  return filePath;
}

/**
 * Persists a session key to disk, encrypted at rest.
 */
export function persistSessionKey(
  deviceId: string,
  targetDeviceId: string,
  sessionKeys: SessionKeys
): void {
  try {
    ensureSessionStoreExists();

    const plainData = JSON.stringify({
      sharedKey: Array.from(sessionKeys.sharedKey),
      sessionId: sessionKeys.sessionId,
      deviceId: sessionKeys.deviceId,
      messageCounter: sessionKeys.messageCounter,
      lastReceivedCounter: sessionKeys.lastReceivedCounter,
      timestamp: new Date().toISOString(),
    });

    const filePath = getSessionFilePath(deviceId, targetDeviceId);

    // SECURITY: Atomic write via temp + rename to prevent TOCTOU
    const tmpPath = filePath + '.tmp.' + process.pid;
    if (!sessionFileKey) {
      // SECURITY: Refuse to persist session keys in plaintext — wait for key initialization
      console.error('[Security] Session persistence key not initialized, refusing to write plaintext session');
      return;
    }

    // Encrypt session data at rest
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const messageBytes = new TextEncoder().encode(plainData);
    const ciphertext = nacl.secretbox(messageBytes, nonce, sessionFileKey);
    const encrypted = {
      _encrypted: true,
      nonce: encodeBase64(nonce),
      ciphertext: encodeBase64(ciphertext),
    };
    fs.writeFileSync(tmpPath, JSON.stringify(encrypted), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    console.error('Failed to persist session key:', (error as Error).message);
  }
}

/**
 * Loads a persisted session key from disk, decrypting if encrypted.
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

    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      console.error('[Security] Symlink detected at session file, refusing to read');
      return null;
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    let data: any;

    const parsed = JSON.parse(raw);
    if (parsed._encrypted && sessionFileKey) {
      // Decrypt at-rest encryption
      const nonce = decodeBase64(parsed.nonce);
      const ciphertext = decodeBase64(parsed.ciphertext);
      const decrypted = nacl.secretbox.open(ciphertext, nonce, sessionFileKey);
      if (!decrypted) {
        console.error('[Security] Session file decryption failed — key may have changed');
        fs.unlinkSync(filePath);
        return null;
      }
      data = JSON.parse(new TextDecoder().decode(decrypted));
    } else if (parsed._encrypted && !sessionFileKey) {
      // Encrypted but no key available — skip
      console.error('[Security] Session file is encrypted but decryption key not available');
      return null;
    } else {
      // Legacy unencrypted format
      data = parsed;
    }

    // Check if session is expired (older than 24 hours)
    const timestamp = new Date(data.timestamp);
    const now = new Date();
    const hoursSinceCreation = (now.getTime() - timestamp.getTime()) / (1000 * 60 * 60);

    if (hoursSinceCreation > 24) {
      fs.unlinkSync(filePath);
      return null;
    }

    return {
      sharedKey: new Uint8Array(data.sharedKey),
      sessionId: data.sessionId,
      deviceId: data.deviceId || targetDeviceId,
      messageCounter: data.messageCounter || 0,
      lastReceivedCounter: data.lastReceivedCounter || -1,
    };
  } catch (error) {
    console.error('Failed to load persisted session key:', (error as Error).message);
    return null;
  }
}

/**
 * Deletes a persisted session
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
    console.error('Failed to delete persisted session:', (error as Error).message);
  }
}

/**
 * Deletes all persisted sessions for a device
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
    console.error('Failed to delete all persisted sessions:', (error as Error).message);
  }
}

/**
 * Lists all persisted sessions for a device
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
      .map((file) => file.substring(prefix.length, file.length - 5));
  } catch (error) {
    console.error('Failed to list persisted sessions:', (error as Error).message);
    return [];
  }
}
