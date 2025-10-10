import { Agent, type Connection } from "agents";

const MessageType = {
  CF_AGENT_STATE: "cf_agent_state"
} as const;

/**
 * Agent with automatic state synchronization to all connected clients.
 * Extends the base Agent class with real-time state broadcasting capabilities.
 *
 * Use this when you need:
 * - Real-time state updates across all WebSocket connections
 * - Automatic state synchronization when calling setState()
 *
 * Note: The base Agent already sends state to clients on connection.
 * SyncAgent adds broadcasting of state changes to all connected clients.
 *
 * @example
 * ```typescript
 * export class MyAgent extends SyncAgent<Env, MyState> {
 *   initialState = { counter: 0 };
 *
 *   incrementCounter() {
 *     this.setState({ counter: this.state.counter + 1 });
 *     // State automatically synced to all connected clients! (important-comment)
 *   }
 * }
 * ```
 */
export class SyncAgent<
  Env = unknown,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends Agent<Env, State, Props> {
  /**
   * Broadcasts state updates to all connected clients except the source.
   * Called automatically by the base Agent when setState() is used.
   *
   * @param state - The new state to broadcast
   * @param source - The source of the update ("server" or a Connection)
   */
  protected _broadcastStateUpdate(state: State, source: Connection | "server") {
    this.broadcast(
      JSON.stringify({
        state: state,
        type: MessageType.CF_AGENT_STATE
      }),
      source !== "server" ? [source.id] : []
    );
  }
}

export { type Agent, type Connection } from "agents";
