<p align="center">
  <img src="https://www.forkoff.app/images/logo.png" alt="ForkOff Logo" width="200"/>
</p>

<h1 align="center">ForkOff CLI</h1>

<p align="center">
  <strong>Control your AI coding sessions from your phone</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/forkoff"><img src="https://img.shields.io/npm/v/forkoff.svg" alt="npm version"></a>
  <a href="https://github.com/Forkoff-app/forkoff-cli/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/forkoff.svg" alt="MIT License"></a>
  <a href="https://www.npmjs.com/package/forkoff"><img src="https://img.shields.io/npm/dm/forkoff.svg" alt="npm downloads"></a>
</p>

<p align="center">
  <a href="https://forkoff.app">Website</a> &bull;
  <a href="#installation">Installation</a> &bull;
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#commands">Commands</a> &bull;
  <a href="#programmatic-usage">API</a> &bull;
  <a href="#security">Security</a>
</p>

---

ForkOff CLI connects [Claude Code](https://claude.ai/code) on your laptop to the ForkOff mobile app, giving you real-time monitoring, interactive approvals, and usage analytics from anywhere.

> **Open Source** &mdash; MIT licensed. Contributions welcome!

## Installation

```bash
npm install -g forkoff
```

## Quick Start

### 1. Pair with your phone

```bash
forkoff pair
```

Scan the QR code with the ForkOff mobile app to link your device.

### 2. Stay connected

```bash
forkoff connect
```

Keep this running to stream sessions to your phone in real-time.

---

## Features

- **Real-time session monitoring** &mdash; See Claude Code output on your phone as it happens
- **Interactive approvals** &mdash; Approve or deny tool use (file edits, bash commands) from mobile
- **Configurable permission rules** &mdash; Auto-approve safe tools, require approval for destructive ones
- **End-to-end encryption** &mdash; All session data encrypted between CLI and mobile
- **Usage analytics** &mdash; Track token usage, session counts, and streaks across devices
- **Multi-device support** &mdash; Connect multiple CLI instances, analytics aggregate automatically
- **Auto-start** &mdash; Optionally launch on login so your phone is always connected
- **Local relay option** &mdash; Run with `--local` for a direct P2P connection without cloud dependency

## Commands

| Command | Description |
|---------|-------------|
| `forkoff pair [--local]` | Generate QR code to pair with mobile app |
| `forkoff connect [--local]` | Reconnect to ForkOff (for previously paired devices) |
| `forkoff status` | Check connection status |
| `forkoff disconnect` | Disconnect and unpair device |
| `forkoff config` | View/modify configuration |
| `forkoff startup` | Manage automatic startup on login |
| `forkoff tools` | Detect AI tools, install/uninstall hooks |
| `forkoff logs` | List, view, or clean debug logs |

### Configuration

```bash
forkoff config --show            # Show current config
forkoff config --name "My MBP"   # Set device name
forkoff config --port 8080       # Set relay server port
forkoff config --reset           # Reset to defaults
```

### Tools

```bash
forkoff tools --detect           # Detect installed AI tools
forkoff tools --install-hooks    # Install ForkOff hooks for Claude Code
forkoff tools --uninstall-hooks  # Remove ForkOff hooks
forkoff tools --watch            # Watch tool status changes
```

### Logs

```bash
forkoff logs                     # List debug log files
forkoff logs --latest            # Print path to most recent log
forkoff logs --clean             # Delete all log files
```

### Global Options

| Option | Description |
|--------|-------------|
| `-q, --quiet` | Suppress all output (for background operation) |
| `--debug` | Enable debug logging to file (`~/.forkoff-cli/logs/`) |

### Automatic Startup

Startup is enabled by default &mdash; `forkoff pair` and `forkoff connect` register the CLI to launch on login.

- **Windows**: Registry key (`HKCU\...\Run`)
- **macOS**: launchd agent (`~/Library/LaunchAgents/app.forkoff.cli.plist`)

```bash
forkoff startup --disable   # Disable auto-start
forkoff startup --enable    # Re-enable
forkoff startup --status    # Check registration
```

---

## Security

ForkOff uses end-to-end encryption (X25519 ECDH + XSalsa20-Poly1305) so the relay server never sees your code, prompts, or approvals &mdash; only opaque encrypted blobs routed between device UUIDs.

| Layer | Implementation |
|-------|---------------|
| **Key exchange** | X25519 ECDH with HKDF-SHA256 directional key derivation |
| **Authentication** | Ed25519 identity signatures on ephemeral keys (MITM protection) |
| **Encryption** | XSalsa20-Poly1305 authenticated encryption (NaCl secretbox) |
| **Identity** | TOFU (Trust On First Use) with key pinning |
| **Replay protection** | Per-peer monotonic message counters |
| **Session expiry** | Automatic re-key every 24 hours or 10,000 messages |
| **Key storage** | OS keychain (macOS Keychain, Windows Credential Manager, Linux libsecret) |
| **Enforcement** | 24 sensitive event types encrypted; plaintext fallback only when E2EE unavailable |

No additional setup required &mdash; E2EE is enabled automatically when you pair.

---

## Programmatic Usage

Integrate ForkOff into your own AI coding tools:

```typescript
import { createIntegration } from 'forkoff';

const forkoff = createIntegration();
await forkoff.connect();

// Request approval for code changes
const approval = await forkoff.requestApproval(
  sessionId, messageId, 'CODE_CHANGE',
  'Add auth middleware',
  { filePath: 'src/middleware/auth.ts', diff: '...' }
);

// Stream terminal output
forkoff.sendTerminalOutput(sessionId, '> npm install\nDone', 'stdout');
```

---

## Configuration Files

| Platform | Location |
|----------|----------|
| **Windows** | `%APPDATA%\forkoff-cli\config.json` |
| **macOS** | `~/.config/forkoff-cli/config.json` |
| **Linux** | `~/.config/forkoff-cli/config.json` |

## Development

```bash
git clone https://github.com/Forkoff-app/forkoff-cli.git
cd forkoff-cli
npm install
npm run dev       # Run with ts-node
npm run build     # Compile TypeScript
npm test          # Run tests
```

## Requirements

- Node.js 18+
- [ForkOff mobile app](https://github.com/Forkoff-app/forkoff-react-native) (iOS/Android)

## License

[MIT](LICENSE)
