/**
 * Claude Code Hooks Integration
 *
 * Integrates with Claude Code's hook system to:
 * - Intercept tool usage (PreToolUse, PostToolUse)
 * - Receive notifications
 * - Request approvals before executing dangerous operations
 *
 * Claude Code hooks are configured in ~/.claude/settings.json
 */
import { EventEmitter } from 'events';
export interface ClaudeHookInput {
    hook_type: 'PreToolUse' | 'PostToolUse' | 'Notification' | 'Stop';
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_output?: string;
    session_id: string;
    message?: string;
    transcript_path?: string;
}
export interface ClaudeHookOutput {
    continue: boolean;
    reason?: string;
    modified_input?: Record<string, unknown>;
}
export interface ClaudeSettings {
    hooks?: {
        PreToolUse?: Array<{
            matcher: string;
            hooks: string[];
        }>;
        PostToolUse?: Array<{
            matcher: string;
            hooks: string[];
        }>;
        Notification?: Array<{
            matcher: string;
            hooks: string[];
        }>;
        Stop?: Array<{
            matcher: string;
            hooks: string[];
        }>;
    };
    permissions?: Record<string, unknown>;
}
declare class ClaudeHooksManager extends EventEmitter {
    private claudeDir;
    private settingsPath;
    private hookScriptPath;
    private isConfigured;
    constructor();
    private getHookScriptPath;
    /**
     * Check if Claude Code is installed and hooks can be configured
     */
    canConfigure(): boolean;
    /**
     * Check if ForkOff hooks are already configured
     */
    isHookConfigured(): boolean;
    /**
     * Read Claude settings
     */
    private readSettings;
    /**
     * Write Claude settings
     */
    private writeSettings;
    /**
     * Install ForkOff hooks into Claude Code
     */
    installHooks(): Promise<void>;
    /**
     * Create the hook script that Claude Code will execute
     */
    private createHookScript;
    /**
     * Get the JavaScript hook script content
     */
    private getHookJsScript;
    /**
     * Remove ForkOff hooks from Claude Code
     */
    uninstallHooks(): Promise<void>;
    /**
     * Process a hook event (called by the hook script via local HTTP)
     */
    processHookEvent(hookData: ClaudeHookInput): ClaudeHookOutput;
    private handlePreToolUse;
    private handlePostToolUse;
    private handleNotification;
    private handleStop;
}
export declare const claudeHooksManager: ClaudeHooksManager;
export default claudeHooksManager;
//# sourceMappingURL=claude-hooks.d.ts.map