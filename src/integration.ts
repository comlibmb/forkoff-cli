/**
 * ForkOff Integration Module
 *
 * This module provides a simple API for AI coding tools to integrate with ForkOff.
 * It handles approval requests and terminal output streaming.
 */

import { wsClient } from './websocket';
import { approvalManager, PendingApproval } from './approval';
import { config } from './config';
import { claudeSessionDetector } from './tools';

export interface ForkOffIntegration {
  // Connection
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;

  // Approvals
  requestApproval(
    sessionId: string,
    messageId: string,
    type: PendingApproval['type'],
    description: string,
    changes: any
  ): Promise<PendingApproval>;
  onApprovalResolved(callback: (approval: PendingApproval) => void): void;

  // Terminal
  sendTerminalOutput(sessionId: string, output: string, type: 'stdout' | 'stderr'): void;
  sendTerminalExit(sessionId: string, exitCode: number): void;

  // Status
  setStatus(status: 'online' | 'busy' | 'syncing'): void;

  // Claude Sessions
  getClaudeSessions(): ReturnType<typeof claudeSessionDetector.getSessions>;
}

/**
 * Create a ForkOff integration instance
 */
export function createIntegration(): ForkOffIntegration {
  let approvalCallback: ((approval: PendingApproval) => void) | null = null;

  approvalManager.on('approval_resolved', (approval) => {
    if (approvalCallback) {
      approvalCallback(approval);
    }
  });

  return {
    connect: async () => {
      if (!config.deviceId) {
        throw new Error('Device not registered. Run "forkoff pair" first.');
      }
      if (!config.isPaired) {
        throw new Error('Device not paired. Run "forkoff pair" and scan the QR code.');
      }
      await wsClient.startServer(config.relayPort);
    },

    disconnect: () => {
      wsClient.disconnect();
    },

    isConnected: () => {
      return wsClient.isConnected;
    },

    requestApproval: async (sessionId, messageId, type, description, changes) => {
      const approval = approvalManager.createApprovalRequest(
        sessionId,
        messageId,
        type,
        description,
        changes
      );

      return approvalManager.waitForApproval(approval.id);
    },

    onApprovalResolved: (callback) => {
      approvalCallback = callback;
    },

    sendTerminalOutput: (sessionId: string, output: string, type: 'stdout' | 'stderr') => {
      wsClient.sendTerminalOutput({
        terminalSessionId: sessionId,
        output,
        type,
      });
    },

    sendTerminalExit: (sessionId: string, exitCode: number) => {
      wsClient.sendTerminalOutput({
        terminalSessionId: sessionId,
        output: '',
        type: 'exit',
        exitCode,
      });
    },

    setStatus: (status: 'online' | 'busy' | 'syncing') => {
      wsClient.updateStatus(status);
    },

    getClaudeSessions: () => {
      return claudeSessionDetector.getSessions();
    },
  };
}

// Export individual modules for advanced usage
export { wsClient } from './websocket';
export { approvalManager } from './approval';
export { terminalManager } from './terminal';
export { config } from './config';
export { claudeSessionDetector } from './tools';
