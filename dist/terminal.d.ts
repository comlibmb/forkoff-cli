import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
interface TerminalSession {
    id: string;
    process: ChildProcess | null;
    cwd: string;
}
declare class TerminalManager extends EventEmitter {
    private sessions;
    private defaultShell;
    constructor();
    private getDefaultShell;
    createSession(terminalSessionId: string, cwd?: string): TerminalSession;
    executeCommand(terminalSessionId: string, command: string): Promise<{
        output: string;
        exitCode: number;
    }>;
    private updateCwdFromCommand;
    getSession(terminalSessionId: string): TerminalSession | undefined;
    closeSession(terminalSessionId: string): void;
    closeAllSessions(): void;
}
export declare const terminalManager: TerminalManager;
export default terminalManager;
//# sourceMappingURL=terminal.d.ts.map