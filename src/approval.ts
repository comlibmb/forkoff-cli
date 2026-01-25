import { EventEmitter } from 'events';
import { wsClient } from './websocket';

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

class ApprovalManager extends EventEmitter {
  private pendingApprovals: Map<string, PendingApproval> = new Map();
  private approvalCounter = 0;

  /**
   * Create a new approval request and send to mobile app
   */
  createApprovalRequest(
    sessionId: string,
    messageId: string,
    type: PendingApproval['type'],
    description: string,
    changes: any
  ): PendingApproval {
    const id = `approval_${++this.approvalCounter}_${Date.now()}`;

    const approval: PendingApproval = {
      id,
      sessionId,
      messageId,
      type,
      description,
      changes,
      createdAt: new Date(),
      status: 'pending',
    };

    this.pendingApprovals.set(id, approval);

    // Send to mobile app via WebSocket
    wsClient.sendApprovalRequest({
      sessionId,
      messageId,
      type,
      description,
      changes: {
        ...changes,
        approvalId: id,
      },
    });

    this.emit('approval_created', approval);

    return approval;
  }

  /**
   * Handle approval response from mobile app
   */
  handleApprovalResponse(approvalId: string, status: 'APPROVED' | 'REJECTED'): void {
    const approval = this.pendingApprovals.get(approvalId);

    if (!approval) {
      return;
    }

    approval.status = status === 'APPROVED' ? 'approved' : 'rejected';

    this.emit('approval_resolved', approval);
    this.emit(status === 'APPROVED' ? 'approved' : 'rejected', approval);
  }

  /**
   * Wait for an approval to be resolved
   */
  waitForApproval(approvalId: string, timeoutMs: number = 300000): Promise<PendingApproval> {
    return new Promise((resolve, reject) => {
      const approval = this.pendingApprovals.get(approvalId);

      if (!approval) {
        reject(new Error('Approval not found'));
        return;
      }

      if (approval.status !== 'pending') {
        resolve(approval);
        return;
      }

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Approval request timed out'));
      }, timeoutMs);

      const onResolved = (resolved: PendingApproval) => {
        if (resolved.id === approvalId) {
          cleanup();
          resolve(resolved);
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.off('approval_resolved', onResolved);
      };

      this.on('approval_resolved', onResolved);
    });
  }

  /**
   * Get all pending approvals
   */
  getPendingApprovals(): PendingApproval[] {
    return Array.from(this.pendingApprovals.values()).filter(
      (a) => a.status === 'pending'
    );
  }

  /**
   * Get approval by ID
   */
  getApproval(id: string): PendingApproval | undefined {
    return this.pendingApprovals.get(id);
  }

  /**
   * Clear all approvals
   */
  clear(): void {
    this.pendingApprovals.clear();
    this.approvalCounter = 0;
  }

  /**
   * Clear resolved approvals older than specified age
   */
  clearOldApprovals(maxAgeMs: number = 3600000): void {
    const now = Date.now();

    for (const [id, approval] of this.pendingApprovals) {
      if (
        approval.status !== 'pending' &&
        now - approval.createdAt.getTime() > maxAgeMs
      ) {
        this.pendingApprovals.delete(id);
      }
    }
  }
}

export const approvalManager = new ApprovalManager();
export default approvalManager;
