declare class Config {
    private configPath;
    private data;
    constructor();
    private getConfigPath;
    private load;
    private save;
    get deviceId(): string | null;
    set deviceId(value: string | null);
    get deviceName(): string;
    set deviceName(value: string);
    get apiUrl(): string;
    set apiUrl(value: string);
    get wsUrl(): string;
    set wsUrl(value: string);
    get pairingCode(): string | null;
    set pairingCode(value: string | null);
    get pairedAt(): string | null;
    set pairedAt(value: string | null);
    get userId(): string | null;
    set userId(value: string | null);
    get isPaired(): boolean;
    getMachineId(): string;
    getDeviceInfo(): {
        name: string;
        type: "desktop";
        platform: NodeJS.Platform;
        hostname: string;
        machineId: string;
    };
    reset(): void;
    getPath(): string;
}
export declare const config: Config;
export default config;
//# sourceMappingURL=config.d.ts.map