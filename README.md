# ForkOff CLI

Connect your AI coding tools to the ForkOff mobile app.

## Installation

```bash
# Install globally
npm install -g .

# Or link for development
npm link
```

## Usage

### Configure (optional)

```bash
# Show current configuration
forkoff config --show

# Set custom API URL
forkoff config --api http://your-server.com/api

# Set custom WebSocket URL
forkoff config --ws ws://your-server.com

# Set device name
forkoff config --name "My Workstation"

# Reset all configuration
forkoff config --reset
```

### Pair with Mobile App

```bash
forkoff pair
```

This will:
1. Register your device with the ForkOff server
2. Display a QR code to scan with the mobile app
3. Wait for pairing confirmation

### Connect

After pairing, stay connected to receive commands:

```bash
forkoff connect
```

### Check Status

```bash
forkoff status
```

### Disconnect

```bash
forkoff disconnect
```

## Programmatic Usage

For integrating with AI coding tools:

```typescript
import { createIntegration } from 'forkoff-cli';

const forkoff = createIntegration();

// Connect to ForkOff
await forkoff.connect();

// Listen for messages from mobile app
forkoff.onMessageReceived((sessionId, content, requestedBy) => {
  console.log(`Message from ${requestedBy}: ${content}`);

  // Send response
  forkoff.sendMessage(sessionId, 'Processing your request...');
});

// Stream a response
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
  'Add new function to utils.ts',
  { filePath: 'utils.ts', diff: '...' }
);

if (approval.status === 'approved') {
  // Apply the changes
}

// Send terminal output
forkoff.sendTerminalOutput(sessionId, 'npm install output...', 'stdout');
forkoff.sendTerminalExit(sessionId, 0);

// Update status
forkoff.setStatus('busy');
```

## Configuration Location

Configuration is stored at:
- Windows: `%APPDATA%/forkoff-cli/config.json`
- macOS: `~/Library/Preferences/forkoff-cli/config.json`
- Linux: `~/.config/forkoff-cli/config.json`
