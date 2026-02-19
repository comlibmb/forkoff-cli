<p align="center">
  <img src="https://www.forkoff.app/images/logo.png" alt="ForkOff Logo" width="200"/>
</p>

<h1 align="center">ForkOff CLI</h1>

<p align="center">
  <strong>Bridge your AI coding tools to your mobile device</strong>
</p>

> ## 🚀 **OPEN BETA**
>
> ForkOff is now in **open beta**! Download the mobile app and get started:
>
> 📱 **[Join the TestFlight Beta](https://testflight.apple.com/join/dhh5FrN7)**

---

<p align="center">
  <a href="https://forkoff.app">Website</a> •
  <a href="#installation">Installation</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#commands">Commands</a> •
  <a href="#programmatic-usage">API</a> •
  <a href="#configuration">Configuration</a>
</p>

---

## Overview

ForkOff CLI connects your development machine to the ForkOff mobile app, enabling you to:

- **Control AI coding sessions** from your phone
- **Approve code changes** on the go
- **Send prompts** to Claude, Cursor, and other AI tools
- **Monitor progress** in real-time
- **Get notifications** for permission requests

## Installation

```bash
npm install -g forkoff
```

## Quick Start

### 1. Pair with Mobile App

```bash
forkoff pair
```

Scan the QR code with your ForkOff mobile app to link your device.

### 2. Stay Connected

```bash
forkoff connect
```

Keep this running to receive commands from your mobile app.

---

## Commands

| Command | Description |
|---------|-------------|
| `forkoff pair` | Generate QR code to pair with mobile app |
| `forkoff connect` | Connect and listen for commands |
| `forkoff status` | Check connection status |
| `forkoff disconnect` | Disconnect from server |
| `forkoff config` | View/modify configuration |
| `forkoff startup` | Manage automatic startup on login |
| `forkoff startup --enable` | Enable automatic startup |
| `forkoff startup --disable` | Disable automatic startup |
| `forkoff startup --status` | Show startup registration status |
| `forkoff help` | Show available commands and usage |

### Configuration Options

```bash
# Show current configuration
forkoff config --show

# Set custom API URL
forkoff config --api https://your-server.com/api

# Set custom WebSocket URL
forkoff config --ws wss://your-server.com

# Set device name
forkoff config --name "My MacBook Pro"

# Reset all configuration
forkoff config --reset
```

### Global Options

| Option | Description |
|--------|-------------|
| `-q, --quiet` | Suppress all output (for background operation) |

### Background Operation

Run ForkOff silently in the background with no console output:

```bash
forkoff connect --quiet
```

This is used by the automatic startup feature and is useful for running ForkOff as a background service.

### Automatic Startup

ForkOff automatically starts on login so your device stays connected without manual intervention. Startup is **enabled by default** — when you run `forkoff pair` or `forkoff connect`, it registers itself to launch `forkoff connect --quiet` on login.

- **Windows**: Adds a `ForkOffCLI` entry to the `HKCU\...\Run` registry key (no admin required)
- **macOS**: Installs a launchd agent (`~/Library/LaunchAgents/app.forkoff.cli.plist`) with the explicit node binary path for nvm/fnm compatibility

To disable automatic startup:

```bash
forkoff startup --disable
```

Once disabled, `pair` and `connect` will not re-register startup. To re-enable:

```bash
forkoff startup --enable
```

Running `forkoff disconnect` also removes the startup registration.

---

## Programmatic Usage

Integrate ForkOff into your AI coding tools:

```typescript
import { createIntegration } from 'forkoff';

const forkoff = createIntegration();

// Connect to ForkOff server
await forkoff.connect();

// Handle incoming messages from mobile app
forkoff.onMessageReceived((sessionId, content, requestedBy) => {
  console.log(`Message from ${requestedBy}: ${content}`);

  // Send a response
  forkoff.sendMessage(sessionId, 'Processing your request...');
});

// Stream responses in real-time
const stream = forkoff.startStreaming(sessionId);
stream.write('Here is ');
stream.write('a streaming ');
stream.write('response.');
stream.end();

// Request approval for code changes
const approval = await forkoff.requestApproval(
  sessionId,
  messageId,
  'CODE_CHANGE',
  'Add authentication middleware',
  { filePath: 'src/middleware/auth.ts', diff: '...' }
);

if (approval.status === 'approved') {
  // Apply the changes
}

// Send terminal output
forkoff.sendTerminalOutput(sessionId, '> npm install\n Done', 'stdout');
forkoff.sendTerminalExit(sessionId, 0);

// Update device status
forkoff.setStatus('busy');
```

---

## Configuration

Configuration files are stored at:

| Platform | Location |
|----------|----------|
| **Windows** | `%APPDATA%\forkoff-cli\config.json` |
| **macOS** | `~/Library/Preferences/forkoff-cli/config.json` |
| **Linux** | `~/.config/forkoff-cli/config.json` |

---

## Security

Your data stays yours. All communication between the ForkOff CLI and your mobile device is protected with **end-to-end encryption (E2EE)**:

- Messages, code, and commands are encrypted on-device before leaving your machine
- The ForkOff server never sees your plaintext data — it only relays encrypted payloads
- Each device pair establishes a unique encrypted channel using ephemeral key exchange
- Session keys are derived per-connection, so even if one session is compromised, others remain secure

No additional setup required — E2EE is enabled automatically when you pair your device.

## Requirements

- Node.js 18+
- ForkOff mobile app

---

<p align="center">
  Made with ❤️ by the ForkOff team
</p>
