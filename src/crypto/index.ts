/**
 * E2EE Crypto Module - Barrel Export
 */
export { generateKeyPair } from './keyGeneration';
export { computeSharedKey } from './keyExchange';
export { encrypt, decrypt } from './encryption';
export { storePrivateKey, getPrivateKey, storeSessionKey, getSessionKey, clearSessionKeys } from './keyStorage';
export { E2EEManager } from './e2eeManager';
export type {
  E2EEKeyPair,
  EncryptedPayload,
  EncryptedMessage,
  SessionKeys,
  KeyExchangeInit,
  KeyExchangeAck,
  E2EESessionStatus,
} from './types';
