"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.approvalManager = void 0;
const events_1 = require("events");
const websocket_1 = require("./websocket");
class ApprovalManager extends events_1.EventEmitter {
    constructor() {
        super(...arguments);
        this.pendingApprovals = new Map();
        this.approvalCounter = 0;
    }
    /**
     * Create a new approval request and send to mobile app
     */
    createApprovalRequest(sessionId, messageId, type, description, changes) {
        const id = `approval_${++this.approvalCounter}_${Date.now()}`;
        const approval = {
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
        websocket_1.wsClient.sendApprovalRequest({
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
    handleApprovalResponse(approvalId, status) {
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
    waitForApproval(approvalId, timeoutMs = 300000) {
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
            const onResolved = (resolved) => {
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
    getPendingApprovals() {
        return Array.from(this.pendingApprovals.values()).filter((a) => a.status === 'pending');
    }
    /**
     * Get approval by ID
     */
    getApproval(id) {
        return this.pendingApprovals.get(id);
    }
    /**
     * Clear all approvals
     */
    clear() {
        this.pendingApprovals.clear();
        this.approvalCounter = 0;
    }
    /**
     * Clear resolved approvals older than specified age
     */
    clearOldApprovals(maxAgeMs = 3600000) {
        const now = Date.now();
        for (const [id, approval] of this.pendingApprovals) {
            if (approval.status !== 'pending' &&
                now - approval.createdAt.getTime() > maxAgeMs) {
                this.pendingApprovals.delete(id);
            }
        }
    }
}
exports.approvalManager = new ApprovalManager();
exports.default = exports.approvalManager;
//# sourceMappingURL=approval.js.map