import { EventEmitter } from 'events';
export interface PendingApproval {
    id: string;
    sessionId: string;
    messageId: string;
    type: 'CODE_CHANGE' | 'FILE_OPERATION' | 'COMMAND_EXECUTION' | 'OTHER';
    description: string;
    changes: any;
    createdAt: Date;
    status: 'pending' | 'approved' | 'rejected';
}
declare class ApprovalManager extends EventEmitter {
    private pendingApprovals;
    private approvalCounter;
    /**
     * Create a new approval request and send to mobile app
     */
    createApprovalRequest(sessionId: string, messageId: string, type: PendingApproval['type'], description: string, changes: any): PendingApproval;
    /**
     * Handle approval response from mobile app
     */
    handleApprovalResponse(approvalId: string, status: 'APPROVED' | 'REJECTED'): void;
    /**
     * Wait for an approval to be resolved
     */
    waitForApproval(approvalId: string, timeoutMs?: number): Promise<PendingApproval>;
    /**
     * Get all pending approvals
     */
    getPendingApprovals(): PendingApproval[];
    /**
     * Get approval by ID
     */
    getApproval(id: string): PendingApproval | undefined;
    /**
     * Clear all approvals
     */
    clear(): void;
    /**
     * Clear resolved approvals older than specified age
     */
    clearOldApprovals(maxAgeMs?: number): void;
}
export declare const approvalManager: ApprovalManager;
export default approvalManager;
//# sourceMappingURL=approval.d.ts.map