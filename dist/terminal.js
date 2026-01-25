"use strict";
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
exports.terminalManager = void 0;
const child_process_1 = require("child_process");
const events_1 = require("events");
const os = __importStar(require("os"));
const path = __importStar(require("path"));
class TerminalManager extends events_1.EventEmitter {
    constructor() {
        super();
        this.sessions = new Map();
        this.defaultShell = this.getDefaultShell();
    }
    getDefaultShell() {
        if (os.platform() === 'win32') {
            return process.env.COMSPEC || 'cmd.exe';
        }
        return process.env.SHELL || '/bin/bash';
    }
    createSession(terminalSessionId, cwd) {
        // Default to home directory, not process.cwd()
        let resolvedCwd = cwd || os.homedir();
        // Resolve ~ to home directory
        if (resolvedCwd === '~' || resolvedCwd.startsWith('~/')) {
            resolvedCwd = resolvedCwd === '~' ? os.homedir() : resolvedCwd.replace('~', os.homedir());
        }
        const session = {
            id: terminalSessionId,
            process: null,
            cwd: resolvedCwd,
        };
        this.sessions.set(terminalSessionId, session);
        return session;
    }
    async executeCommand(terminalSessionId, command) {
        return new Promise((resolve, reject) => {
            let session = this.sessions.get(terminalSessionId);
            const wasNewSession = !session;
            if (!session) {
                session = this.createSession(terminalSessionId);
                // Emit session_created so websocket can send the initial cwd
                this.emit('session_created', {
                    terminalSessionId,
                    cwd: session.cwd,
                });
            }
            const isWindows = os.platform() === 'win32';
            const shell = isWindows ? 'cmd.exe' : '/bin/bash';
            const shellArgs = isWindows ? ['/c', command] : ['-c', command];
            const proc = (0, child_process_1.spawn)(shell, shellArgs, {
                cwd: session.cwd,
                env: process.env,
                shell: false,
            });
            let stdout = '';
            let stderr = '';
            proc.stdout?.on('data', (data) => {
                const output = data.toString();
                stdout += output;
                this.emit('output', {
                    terminalSessionId,
                    output,
                    type: 'stdout',
                });
            });
            proc.stderr?.on('data', (data) => {
                const output = data.toString();
                stderr += output;
                this.emit('output', {
                    terminalSessionId,
                    output,
                    type: 'stderr',
                });
            });
            proc.on('close', (code) => {
                const exitCode = code ?? 0;
                this.emit('output', {
                    terminalSessionId,
                    output: '',
                    type: 'exit',
                    exitCode,
                });
                // Check for cd command to update cwd
                this.updateCwdFromCommand(terminalSessionId, command);
                resolve({
                    output: stdout + stderr,
                    exitCode,
                });
            });
            proc.on('error', (error) => {
                this.emit('output', {
                    terminalSessionId,
                    output: error.message,
                    type: 'stderr',
                });
                reject(error);
            });
        });
    }
    updateCwdFromCommand(terminalSessionId, command) {
        const session = this.sessions.get(terminalSessionId);
        if (!session)
            return;
        // Simple cd detection
        const cdMatch = command.match(/^\s*cd\s+(.+)$/i);
        if (cdMatch) {
            const newPath = cdMatch[1].trim().replace(/["']/g, '');
            if (path.isAbsolute(newPath)) {
                session.cwd = newPath;
            }
            else {
                session.cwd = path.resolve(session.cwd, newPath);
            }
            this.emit('cwd_changed', {
                terminalSessionId,
                cwd: session.cwd,
            });
        }
    }
    getSession(terminalSessionId) {
        return this.sessions.get(terminalSessionId);
    }
    closeSession(terminalSessionId) {
        const session = this.sessions.get(terminalSessionId);
        if (session?.process) {
            session.process.kill();
        }
        this.sessions.delete(terminalSessionId);
    }
    closeAllSessions() {
        for (const [terminalSessionId] of this.sessions) {
            this.closeSession(terminalSessionId);
        }
    }
}
exports.terminalManager = new TerminalManager();
exports.default = exports.terminalManager;
//# sourceMappingURL=terminal.js.map