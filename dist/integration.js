"use strict";
/**
 * ForkOff Integration Module
 *
 * This module provides a simple API for AI coding tools to integrate with ForkOff.
 * It handles approval requests and terminal output streaming.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.claudeSessionDetector = exports.api = exports.config = exports.terminalManager = exports.approvalManager = exports.wsClient = void 0;
exports.createIntegration = createIntegration;
const websocket_1 = require("./websocket");
const approval_1 = require("./approval");
const config_1 = require("./config");
const tools_1 = require("./tools");
/**
 * Create a ForkOff integration instance
 */
function createIntegration() {
    let approvalCallback = null;
    approval_1.approvalManager.on('approval_resolved', (approval) => {
        if (approvalCallback) {
            approvalCallback(approval);
        }
    });
    return {
        connect: async () => {
            if (!config_1.config.deviceId) {
                throw new Error('Device not registered. Run "forkoff pair" first.');
            }
            if (!config_1.config.isPaired) {
                throw new Error('Device not paired. Run "forkoff pair" and scan the QR code.');
            }
            await websocket_1.wsClient.connect();
        },
        disconnect: () => {
            websocket_1.wsClient.disconnect();
        },
        isConnected: () => {
            return websocket_1.wsClient.isConnected;
        },
        requestApproval: async (sessionId, messageId, type, description, changes) => {
            const approval = approval_1.approvalManager.createApprovalRequest(sessionId, messageId, type, description, changes);
            return approval_1.approvalManager.waitForApproval(approval.id);
        },
        onApprovalResolved: (callback) => {
            approvalCallback = callback;
        },
        sendTerminalOutput: (sessionId, output, type) => {
            websocket_1.wsClient.sendTerminalOutput({
                terminalSessionId: sessionId,
                output,
                type,
            });
        },
        sendTerminalExit: (sessionId, exitCode) => {
            websocket_1.wsClient.sendTerminalOutput({
                terminalSessionId: sessionId,
                output: '',
                type: 'exit',
                exitCode,
            });
        },
        setStatus: (status) => {
            websocket_1.wsClient.updateStatus(status);
        },
        getClaudeSessions: () => {
            return tools_1.claudeSessionDetector.getSessions();
        },
    };
}
// Export individual modules for advanced usage
var websocket_2 = require("./websocket");
Object.defineProperty(exports, "wsClient", { enumerable: true, get: function () { return websocket_2.wsClient; } });
var approval_2 = require("./approval");
Object.defineProperty(exports, "approvalManager", { enumerable: true, get: function () { return approval_2.approvalManager; } });
var terminal_1 = require("./terminal");
Object.defineProperty(exports, "terminalManager", { enumerable: true, get: function () { return terminal_1.terminalManager; } });
var config_2 = require("./config");
Object.defineProperty(exports, "config", { enumerable: true, get: function () { return config_2.config; } });
var api_1 = require("./api");
Object.defineProperty(exports, "api", { enumerable: true, get: function () { return api_1.api; } });
var tools_2 = require("./tools");
Object.defineProperty(exports, "claudeSessionDetector", { enumerable: true, get: function () { return tools_2.claudeSessionDetector; } });
//# sourceMappingURL=integration.js.map