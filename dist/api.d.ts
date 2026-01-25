interface RegisterResponse {
    pairingCode: string;
    expiresAt: string;
    device: {
        id: string;
        name: string;
        status: string;
    };
}
interface DeviceResponse {
    id: string;
    name: string;
    type: string;
    platform: string;
    status: string;
    userId: string | null;
    lastSeenAt: string;
    connectedTools: Array<{
        id: string;
        name: string;
        type: string;
    }>;
}
declare class ApiClient {
    private client;
    constructor();
    private getBaseUrl;
    registerDevice(): Promise<RegisterResponse>;
    refreshPairingCode(deviceId: string): Promise<RegisterResponse>;
    getDeviceStatus(deviceId: string): Promise<DeviceResponse>;
    checkPairingStatus(deviceId: string): Promise<{
        isPaired: boolean;
        userId: string | null;
    }>;
    healthCheck(): Promise<boolean>;
    reportConnectedTools(deviceId: string, tools: Array<{
        type: string;
        name: string;
        version: string | null;
    }>): Promise<void>;
}
export declare const api: ApiClient;
export default api;
//# sourceMappingURL=api.d.ts.map