import axios, { AxiosInstance } from 'axios';
import { config } from './config';

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

class ApiClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  private getBaseUrl(): string {
    return config.apiUrl;
  }

  // Register device and get pairing code
  async registerDevice(): Promise<RegisterResponse> {
    const deviceInfo = config.getDeviceInfo();

    const response = await this.client.post<RegisterResponse>(
      `${this.getBaseUrl()}/devices/register`,
      deviceInfo
    );

    return response.data;
  }

  // Refresh pairing code for existing device
  async refreshPairingCode(deviceId: string): Promise<RegisterResponse> {
    const response = await this.client.post<RegisterResponse>(
      `${this.getBaseUrl()}/devices/${deviceId}/refresh`
    );

    return response.data;
  }

  // Get device status
  async getDeviceStatus(deviceId: string): Promise<DeviceResponse> {
    const response = await this.client.get<DeviceResponse>(
      `${this.getBaseUrl()}/devices/${deviceId}`
    );

    return response.data;
  }

  // Check if device is paired (has userId) - uses public endpoint
  async checkPairingStatus(deviceId: string): Promise<{
    isPaired: boolean;
    userId: string | null;
  }> {
    try {
      const response = await this.client.get<{
        id: string;
        name: string;
        status: string;
        userId: string | null;
        isPaired: boolean;
      }>(`${this.getBaseUrl()}/devices/${deviceId}/public`);

      return {
        isPaired: response.data.isPaired,
        userId: response.data.userId,
      };
    } catch (error) {
      return { isPaired: false, userId: null };
    }
  }

  // Health check
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.client.get(`${this.getBaseUrl().replace(/\/api$/, '')}/`, {
        validateStatus: () => true, // Accept any status code
      });
      // Server is up if we get any response (even 404)
      return response.status < 500;
    } catch {
      return false;
    }
  }

  // Report connected tools for a device
  async reportConnectedTools(deviceId: string, tools: Array<{
    type: string;
    name: string;
    version: string | null;
  }>): Promise<void> {
    try {
      await this.client.post(
        `${this.getBaseUrl()}/devices/${deviceId}/tools`,
        { tools }
      );
    } catch (error) {
      // Non-critical, just log
      console.error('Failed to report connected tools:', error);
    }
  }
}

export const api = new ApiClient();
export default api;
