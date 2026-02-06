<p align="center">
  <img src="https://www.forkoff.app/images/logo.png" alt="ForkOff Logo" width="200"/>
</p>

<h1 align="center">ForkOff CLI</h1>

<p align="center">
  <strong>Bridge your AI coding tools to your mobile device</strong>
</p>

<p align="center">
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

## Requirements

- Node.js 18+
- ForkOff mobile app

---

<p align="center">
  Made with ❤️ by the ForkOff team
</p>
