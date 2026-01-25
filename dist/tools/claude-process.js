"use strict";
/**
 * Claude Process Manager
 * Spawns and manages Claude CLI processes for terminal sessions
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.claudeProcessManager = void 0;
const child_process_1 = require("child_process");
const events_1 = require("events");
const os = __importStar(require("os"));
const path = __importStar(require("path"));
class ClaudeProcessManager extends events_1.EventEmitter {
    constructor() {
        super(...arguments);
        this.processes = new Map();
    }
    /**
     * Start a new Claude session in the specified directory
     */
    async startSession(directory, terminalSessionId) {
        const resolvedDir = this.resolvePath(directory);
        const proc = (0, child_process_1.spawn)('claude', [], {
            cwd: resolvedDir,
            env: { ...process.env, TERM: 'xterm-256color' },
            shell: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.setupProcessHandlers(terminalSessionId, proc, resolvedDir);
        this.processes.set(terminalSessionId, { terminalSessionId, process: proc, directory: resolvedDir });
        return { cwd: resolvedDir };
    }
    /**
     * Resume an existing Claude session
     */
    async resumeSession(sessionKey, directory, terminalSessionId) {
        const resolvedDir = this.resolvePath(directory);
        const proc = (0, child_process_1.spawn)('claude', ['--resume'], {
            cwd: resolvedDir,
            env: { ...process.env, TERM: 'xterm-256color' },
            shell: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.setupProcessHandlers(terminalSessionId, proc, resolvedDir, sessionKey);
        this.processes.set(terminalSessionId, { terminalSessionId, process: proc, directory: resolvedDir, sessionKey });
        return { cwd: resolvedDir };
    }
    /**
     * Send input to a Claude process
     */
    sendInput(terminalSessionId, input) {
        const info = this.processes.get(terminalSessionId);
        if (info?.process?.stdin) {
            info.process.stdin.write(input);
        }
    }
    /**
     * Check if a session is a Claude session
     */
    isClaudeSession(terminalSessionId) {
        return this.processes.has(terminalSessionId);
    }
    /**
     * Set up event handlers for the spawned process
     */
    setupProcessHandlers(terminalSessionId, proc, directory, sessionKey) {
        proc.stdout?.on('data', (data) => {
            const output = {
                terminalSessionId,
                output: data.toString(),
                type: 'stdout',
            };
            this.emit('output', output);
        });
        proc.stderr?.on('data', (data) => {
            const output = {
                terminalSessionId,
                output: data.toString(),
                type: 'stderr',
            };
            this.emit('output', output);
        });
        proc.on('close', (code) => {
            const exitCode = code ?? 0;
            // Emit exit event
            const exitOutput = {
                terminalSessionId,
                output: '',
                type: 'exit',
                exitCode,
            };
            this.emit('output', exitOutput);
            // Emit session ended event
            const endedEvent = {
                terminalSessionId,
                directory,
                sessionKey,
                exitCode,
            };
            this.emit('session_ended', endedEvent);
            // Clean up
            this.processes.delete(terminalSessionId);
        });
        proc.on('error', (error) => {
            console.error(`[Claude Process] Error for ${terminalSessionId}:`, error.message);
            const output = {
                terminalSessionId,
                output: `Error: ${error.message}\n`,
                type: 'stderr',
            };
            this.emit('output', output);
        });
    }
    /**
     * Resolve path (handle ~ for home directory)
     */
    resolvePath(dir) {
        if (dir === '~' || dir.startsWith('~/')) {
            return dir === '~' ? os.homedir() : dir.replace('~', os.homedir());
        }
        return path.resolve(dir);
    }
    /**
     * Kill a Claude process
     */
    killProcess(terminalSessionId) {
        const info = this.processes.get(terminalSessionId);
        if (info?.process) {
            info.process.kill('SIGTERM');
        }
    }
    /**
     * Get all active process IDs
     */
    getActiveProcessIds() {
        return Array.from(this.processes.keys());
    }
}
exports.claudeProcessManager = new ClaudeProcessManager();
exports.default = exports.claudeProcessManager;
//# sourceMappingURL=claude-process.js.map