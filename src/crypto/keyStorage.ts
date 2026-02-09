import * as keytar from 'keytar';
import { SessionKeys } from './types';

const SERVICE_NAME = 'forkoff-cli';

// In-memory storage for session keys (not persisted)
const sessionKeyStore = new Map<string, SessionKeys>();

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
    console.error('Failed to store private key in keychain:', error);
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
    console.error('Failed to retrieve private key from keychain:', error);
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
    console.error('Failed to delete private key from keychain:', error);
    throw error;
  }
}

/**
 * Stores session encryption key in memory
 * Session keys are ephemeral and not persisted to disk
 *
 * @param deviceId - Target device ID
 * @param encryptionKey - AES-256-GCM encryption key (32 bytes)
 * @param sessionId - Unique session identifier
 */
export function storeSessionKey(
  deviceId: string,
  encryptionKey: Uint8Array,
  sessionId: string
): void {
  sessionKeyStore.set(deviceId, {
    encryptionKey,
    sessionId,
  });
}

/**
 * Retrieves session encryption key from memory
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
