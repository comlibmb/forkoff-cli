/**
 * Tool Detector - Detects installed AI coding tools
 *
 * Supports:
 * - Claude Code (Anthropic CLI)
 * - Cursor IDE
 * - GitHub Copilot (VS Code extension)
 * - Continue.dev (VS Code extension)
 */
export interface DetectedTool {
    type: 'claude-code' | 'cursor' | 'copilot' | 'continue';
    name: string;
    version: string | null;
    path: string | null;
    isRunning: boolean;
    configPath: string | null;
    status: 'detected' | 'running' | 'configured';
}
export interface ToolDetectionResult {
    tools: DetectedTool[];
    platform: 'windows' | 'macos' | 'linux';
    timestamp: string;
}
declare class ToolDetector {
    private platform;
    private homeDir;
    constructor();
    private detectPlatform;
    /**
     * Detect all supported AI coding tools
     */
    detectAll(): Promise<ToolDetectionResult>;
    /**
     * Detect Claude Code (Anthropic CLI)
     */
    detectClaudeCode(): Promise<DetectedTool | null>;
    /**
     * Detect Cursor IDE
     */
    detectCursor(): Promise<DetectedTool | null>;
    /**
     * Detect GitHub Copilot (VS Code extension)
     */
    detectCopilot(): Promise<DetectedTool | null>;
    /**
     * Detect Continue.dev (VS Code extension)
     */
    detectContinue(): Promise<DetectedTool | null>;
    /**
     * Find a command in PATH
     */
    private findCommand;
    /**
     * Check if a process is running
     */
    private isProcessRunning;
    /**
     * Watch for tool status changes
     */
    watchToolStatus(callback: (tools: DetectedTool[]) => void, intervalMs?: number): () => void;
}
export declare const toolDetector: ToolDetector;
export default toolDetector;
//# sourceMappingURL=detector.d.ts.map