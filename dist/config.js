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
exports.config = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const node_machine_id_1 = require("node-machine-id");
const uuid_1 = require("uuid");
const defaultConfig = {
    deviceId: null,
    deviceName: os.hostname(),
    apiUrl: 'http://localhost:3000/api',
    wsUrl: 'ws://localhost:3000',
    pairingCode: null,
    pairedAt: null,
    userId: null,
};
class Config {
    constructor() {
        this.configPath = this.getConfigPath();
        this.data = this.load();
    }
    getConfigPath() {
        const configDir = process.platform === 'win32'
            ? path.join(process.env.APPDATA || os.homedir(), 'forkoff-cli')
            : path.join(os.homedir(), '.config', 'forkoff-cli');
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }
        return path.join(configDir, 'config.json');
    }
    load() {
        try {
            if (fs.existsSync(this.configPath)) {
                const content = fs.readFileSync(this.configPath, 'utf-8');
                return { ...defaultConfig, ...JSON.parse(content) };
            }
        }
        catch (error) {
            // If config is corrupted, use defaults
        }
        return { ...defaultConfig };
    }
    save() {
        fs.writeFileSync(this.configPath, JSON.stringify(this.data, null, 2));
    }
    get deviceId() {
        return this.data.deviceId;
    }
    set deviceId(value) {
        this.data.deviceId = value;
        this.save();
    }
    get deviceName() {
        return this.data.deviceName;
    }
    set deviceName(value) {
        this.data.deviceName = value;
        this.save();
    }
    get apiUrl() {
        return this.data.apiUrl;
    }
    set apiUrl(value) {
        this.data.apiUrl = value;
        this.save();
    }
    get wsUrl() {
        return this.data.wsUrl;
    }
    set wsUrl(value) {
        this.data.wsUrl = value;
        this.save();
    }
    get pairingCode() {
        return this.data.pairingCode;
    }
    set pairingCode(value) {
        this.data.pairingCode = value;
        this.save();
    }
    get pairedAt() {
        return this.data.pairedAt;
    }
    set pairedAt(value) {
        this.data.pairedAt = value;
        this.save();
    }
    get userId() {
        return this.data.userId;
    }
    set userId(value) {
        this.data.userId = value;
        this.save();
    }
    get isPaired() {
        return !!this.userId && !!this.deviceId;
    }
    // Get unique machine identifier
    getMachineId() {
        try {
            return (0, node_machine_id_1.machineIdSync)();
        }
        catch {
            // Fallback to stored or new UUID
            if (!this.data.machineId) {
                this.data.machineId = (0, uuid_1.v4)();
                this.save();
            }
            return this.data.machineId;
        }
    }
    // Get device info for registration
    getDeviceInfo() {
        return {
            name: this.deviceName,
            type: 'desktop',
            platform: os.platform(),
            hostname: os.hostname(),
            machineId: this.getMachineId(),
        };
    }
    // Reset all config
    reset() {
        this.data = { ...defaultConfig };
        this.save();
    }
    // Get config file path
    getPath() {
        return this.configPath;
    }
}
exports.config = new Config();
exports.default = exports.config;
//# sourceMappingURL=config.js.map