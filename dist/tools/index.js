"use strict";
/**
 * Tools Module - Detection and integration with AI coding tools
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.claudeProcessManager = exports.claudeSessionDetector = exports.claudeHooksManager = exports.toolDetector = void 0;
var detector_1 = require("./detector");
Object.defineProperty(exports, "toolDetector", { enumerable: true, get: function () { return detector_1.toolDetector; } });
var claude_hooks_1 = require("./claude-hooks");
Object.defineProperty(exports, "claudeHooksManager", { enumerable: true, get: function () { return claude_hooks_1.claudeHooksManager; } });
var claude_sessions_1 = require("./claude-sessions");
Object.defineProperty(exports, "claudeSessionDetector", { enumerable: true, get: function () { return claude_sessions_1.claudeSessionDetector; } });
var claude_process_1 = require("./claude-process");
Object.defineProperty(exports, "claudeProcessManager", { enumerable: true, get: function () { return claude_process_1.claudeProcessManager; } });
//# sourceMappingURL=index.js.map