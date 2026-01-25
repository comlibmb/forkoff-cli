"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.api = void 0;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("./config");
class ApiClient {
    constructor() {
        this.client = axios_1.default.create({
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json',
            },
        });
    }
    getBaseUrl() {
        return config_1.config.apiUrl;
    }
    // Register device and get pairing code
    async registerDevice() {
        const deviceInfo = config_1.config.getDeviceInfo();
        const response = await this.client.post(`${this.getBaseUrl()}/devices/register`, deviceInfo);
        return response.data;
    }
    // Refresh pairing code for existing device
    async refreshPairingCode(deviceId) {
        const response = await this.client.post(`${this.getBaseUrl()}/devices/${deviceId}/refresh`);
        return response.data;
    }
    // Get device status
    async getDeviceStatus(deviceId) {
        const response = await this.client.get(`${this.getBaseUrl()}/devices/${deviceId}`);
        return response.data;
    }
    // Check if device is paired (has userId) - uses public endpoint
    async checkPairingStatus(deviceId) {
        try {
            const response = await this.client.get(`${this.getBaseUrl()}/devices/${deviceId}/public`);
            return {
                isPaired: response.data.isPaired,
                userId: response.data.userId,
            };
        }
        catch (error) {
            return { isPaired: false, userId: null };
        }
    }
    // Health check
    async healthCheck() {
        try {
            const response = await this.client.get(`${this.getBaseUrl().replace('/api', '')}/`, {
                validateStatus: () => true, // Accept any status code
            });
            // Server is up if we get any response (even 404)
            return response.status < 500;
        }
        catch {
            return false;
        }
    }
    // Report connected tools for a device
    async reportConnectedTools(deviceId, tools) {
        try {
            await this.client.post(`${this.getBaseUrl()}/devices/${deviceId}/tools`, { tools });
        }
        catch (error) {
            // Non-critical, just log
            console.error('Failed to report connected tools:', error);
        }
    }
}
exports.api = new ApiClient();
exports.default = exports.api;
//# sourceMappingURL=api.js.map