# agents-sync

State synchronization extension for Cloudflare Agents.

## Installation

```bash
npm install agents agents-sync
```

## Usage

```typescript
import { SyncAgent } from "agents-sync";

export class MyAgent extends SyncAgent<Env, MyState> {
  initialState = { counter: 0 };

  incrementCounter() {
    this.setState({ counter: this.state.counter + 1 });
    // State automatically synced to all connected clients!
  }
}
```

## Agent vs SyncAgent

### Agent (from `agents` package)

Use the base `Agent` class when you don't need automatic state synchronization:

```typescript
import { Agent } from "agents";

export class MyAgent extends Agent<Env> {
  // Manual state management, query/mutation pattern, etc.
}
```

### SyncAgent (from `agents-sync` package)

Use `SyncAgent` when you need real-time state synchronization across all WebSocket clients:

```typescript
import { SyncAgent } from "agents-sync";

export class MyAgent extends SyncAgent<Env, MyState> {
  initialState = { counter: 0 };

  updateState() {
    this.setState({ counter: this.state.counter + 1 });
    // Automatically broadcasts to all connected clients
  }
}
```

## Features

- **Automatic State Broadcasting**: State changes via `setState()` are automatically broadcast to all connected clients
- **Type-Safe**: Full TypeScript support with generic type parameters
- **Zero Configuration**: Just extend `SyncAgent` instead of `Agent`

Note: Both `Agent` and `SyncAgent` send the current state to clients when they first connect. The difference is that `SyncAgent` also broadcasts state changes to all connected clients whenever `setState()` is called.

## License

MIT
