/**
 * ForkOff Integration Module
 *
 * This module provides a simple API for AI coding tools to integrate with ForkOff.
 * It handles approval requests and terminal output streaming.
 */
import { PendingApproval } from './approval';
import { claudeSessionDetector } from './tools';
export interface ForkOffIntegration {
    connect(): Promise<void>;
    disconnect(): void;
    isConnected(): boolean;
    requestApproval(sessionId: string, messageId: string, type: PendingApproval['type'], description: string, changes: any): Promise<PendingApproval>;
    onApprovalResolved(callback: (approval: PendingApproval) => void): void;
    sendTerminalOutput(sessionId: string, output: string, type: 'stdout' | 'stderr'): void;
    sendTerminalExit(sessionId: string, exitCode: number): void;
    setStatus(status: 'online' | 'busy' | 'syncing'): void;
    getClaudeSessions(): ReturnType<typeof claudeSessionDetector.getSessions>;
}
/**
 * Create a ForkOff integration instance
 */
export declare function createIntegration(): ForkOffIntegration;
export { wsClient } from './websocket';
export { approvalManager } from './approval';
export { terminalManager } from './terminal';
export { config } from './config';
export { api } from './api';
export { claudeSessionDetector } from './tools';
//# sourceMappingURL=integration.d.ts.map