/**
 * Key Storage Service
 * Stores E2EE identity keys via OS keychain (keytar) and session keys in memory.
 * Updated to use NaCl-compatible SessionKeys (sharedKey instead of encryptionKey).
 */
import * as keytar from 'keytar';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionKeys, SigningKeyPair } from './types';

const SERVICE_NAME = 'forkoff-cli';

// In-memory storage for session keys (not persisted)
const sessionKeyStore = new Map<string, SessionKeys>();

// In-memory cache of trusted peer identity keys
const trustedPeerKeys = new Map<string, string>();

// Path to trusted keys file
const TRUSTED_KEYS_DIR = path.join(os.homedir(), '.forkoff-cli');
const TRUSTED_KEYS_FILE = path.join(TRUSTED_KEYS_DIR, 'trusted-keys.json');

/**
 * Stores private key in OS keychain
 * @param deviceId - Device ID
 * @param privateKey - Base64-encoded X25519 private key
 */
export async function storePrivateKey(
  deviceId: string,
  privateKey: string
): Promise<void> {
  try {
    await keytar.setPassword(
      SERVICE_NAME,
      `e2ee-private-key-${deviceId}`,
      privateKey
    );
  } catch (error) {
    console.error('Failed to store private key in keychain:', (error as Error).message);
    throw error;
  }
}

/**
 * Retrieves private key from OS keychain
 * @param deviceId - Device ID
 * @returns Base64-encoded private key or null if not found
 */
export async function getPrivateKey(deviceId: string): Promise<string | null> {
  try {
    const key = await keytar.getPassword(
      SERVICE_NAME,
      `e2ee-private-key-${deviceId}`
    );
    return key;
  } catch (error) {
    console.error('Failed to retrieve private key from keychain:', (error as Error).message);
    return null;
  }
}

/**
 * Deletes private key from OS keychain
 * @param deviceId - Device ID
 */
export async function deletePrivateKey(deviceId: string): Promise<void> {
  try {
    await keytar.deletePassword(
      SERVICE_NAME,
      `e2ee-private-key-${deviceId}`
    );
  } catch (error) {
    console.error('Failed to delete private key from keychain:', (error as Error).message);
    throw error;
  }
}

/**
 * Stores session key in memory
 * Session keys are ephemeral and not persisted to disk
 *
 * @param deviceId - Target device ID
 * @param sharedKey - NaCl secretbox shared key (32 bytes)
 * @param sessionId - Unique session identifier
 */
export function storeSessionKey(
  deviceId: string,
  sharedKey: Uint8Array,
  sessionId: string
): void {
  sessionKeyStore.set(deviceId, {
    sharedKey,
    sessionId,
    deviceId,
    messageCounter: 0,
    lastReceivedCounter: -1,
  });
}

/**
 * Retrieves session key from memory
 * @param deviceId - Target device ID
 * @returns SessionKeys or null if not found
 */
export function getSessionKey(deviceId: string): SessionKeys | null {
  return sessionKeyStore.get(deviceId) ?? null;
}

/**
 * Clears all session keys from memory
 * Called on disconnect or logout
 */
export function clearSessionKeys(): void {
  sessionKeyStore.clear();
}

// --- Ed25519 Signing Key Pair (for identity verification) ---

/**
 * Stores the Ed25519 signing key pair in OS keychain
 */
export async function storeSigningKeyPair(
  deviceId: string,
  keyPair: SigningKeyPair
): Promise<void> {
  try {
    await keytar.setPassword(SERVICE_NAME, `e2ee-signing-public-${deviceId}`, keyPair.publicKey);
    await keytar.setPassword(SERVICE_NAME, `e2ee-signing-secret-${deviceId}`, keyPair.secretKey);
  } catch (error) {
    console.error('Failed to store signing key pair in keychain:', (error as Error).message);
    throw error;
  }
}

/**
 * Retrieves the Ed25519 signing key pair from OS keychain
 */
export async function getSigningKeyPair(deviceId: string): Promise<SigningKeyPair | null> {
  try {
    const publicKey = await keytar.getPassword(SERVICE_NAME, `e2ee-signing-public-${deviceId}`);
    const secretKey = await keytar.getPassword(SERVICE_NAME, `e2ee-signing-secret-${deviceId}`);
    if (!publicKey || !secretKey) return null;
    return { publicKey, secretKey };
  } catch (error) {
    console.error('Failed to retrieve signing key pair from keychain:', (error as Error).message);
    return null;
  }
}

// --- Trusted Peer Identity Keys (TOFU) ---

/**
 * Load trusted peer keys from disk into memory.
 * Called once at init time. Validates file ownership and permissions.
 */
export function loadTrustedPeerKeys(): void {
  try {
    if (!fs.existsSync(TRUSTED_KEYS_FILE)) return;
    const stat = fs.lstatSync(TRUSTED_KEYS_FILE);
    if (stat.isSymbolicLink()) {
      console.error('[Security] Symlink detected at trusted-keys.json, refusing to read');
      return;
    }
    // Verify file permissions — reject if world-readable/writable (non-Windows)
    if (process.platform !== 'win32') {
      const mode = stat.mode & 0o777;
      if (mode & 0o077) {
        console.error(`[Security] trusted-keys.json has unsafe permissions (${mode.toString(8)}), refusing to load. Fix with: chmod 600 ${TRUSTED_KEYS_FILE}`);
        return;
      }
    }
    const data = JSON.parse(fs.readFileSync(TRUSTED_KEYS_FILE, 'utf-8'));
    if (data && typeof data === 'object') {
      let count = 0;
      for (const [deviceId, pubKey] of Object.entries(data)) {
        if (typeof pubKey === 'string' && pubKey.length > 0 && pubKey.length < 256) {
          trustedPeerKeys.set(deviceId, pubKey);
          count++;
        }
      }
      // Loaded trusted peer keys
    }
  } catch {
    // File doesn't exist or is malformed — start fresh
  }
}

/**
 * Save trusted peer keys from memory to disk.
 */
function saveTrustedPeerKeys(): void {
  try {
    if (!fs.existsSync(TRUSTED_KEYS_DIR)) {
      fs.mkdirSync(TRUSTED_KEYS_DIR, { recursive: true, mode: 0o700 });
    }
    const data: Record<string, string> = {};
    for (const [deviceId, pubKey] of trustedPeerKeys) {
      data[deviceId] = pubKey;
    }
    // Atomic write via temp file + rename to prevent TOCTOU race condition
    const tmpPath = TRUSTED_KEYS_FILE + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmpPath, TRUSTED_KEYS_FILE);
  } catch (error) {
    console.error('Failed to save trusted peer keys:', (error as Error).message);
  }
}

/**
 * Get the trusted identity public key for a peer device (TOFU).
 * Returns null if no key is stored (first contact).
 */
export function getTrustedPeerKey(deviceId: string): string | null {
  return trustedPeerKeys.get(deviceId) ?? null;
}

/**
 * Store a peer's identity public key (TOFU — Trust On First Use).
 * Returns false if a DIFFERENT key is already stored (potential MITM).
 */
export function trustPeerKey(deviceId: string, identityPublicKey: string): boolean {
  const existing = trustedPeerKeys.get(deviceId);
  if (existing && existing !== identityPublicKey) {
    return false; // Key mismatch — possible MITM
  }
  if (!existing) {
    trustedPeerKeys.set(deviceId, identityPublicKey);
    saveTrustedPeerKeys();
    // TOFU: trusted new identity key
  }
  return true;
}

/**
 * Remove a peer's trusted identity key (used on re-pair to reset TOFU).
 */
export function removeTrustedPeerKey(deviceId: string): void {
  if (trustedPeerKeys.has(deviceId)) {
    trustedPeerKeys.delete(deviceId);
    saveTrustedPeerKeys();
    // TOFU: removed trusted key for re-pair reset
  }
}
