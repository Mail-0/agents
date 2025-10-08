import { Agent, type AgentContext, type Connection, type WSMessage } from "./";
import { MessageType } from "./ai-types";
import { nanoid } from "nanoid";

/**
 * Protocol version for compatibility checking
 */
export const CURRENT_PROTOCOL_VERSION = "1.0.0";

/**
 * Timeout constants for consistency
 */
export const QUERY_TIMEOUT = 30000; // 30 seconds
export const MUTATION_TIMEOUT = 30000; // 30 seconds

/**
 * Pagination strategy for queries
 */
export type PaginationStrategy = "cursor" | "offset" | "stable-cursor";

/**
 * Query definition for registering queries
 */
export type QueryDefinition<TArgs = unknown, TResult = unknown> = {
  name: string;
  execute: (
    args: TArgs,
    agent: Agent<unknown>
  ) => TResult[] | Promise<TResult[]>;
  dependencies?: string[]; // Table names that affect this query
  pagination?: {
    strategy: PaginationStrategy;
    keyField: string; // Field to use for cursor (e.g., "created_at", "id")
  };
};

/**
 * Mutation definition for registering mutations
 */
export type MutationDefinition<TArgs = unknown, TResult = unknown> = {
  name: string;
  execute: (
    args: TArgs & { mutationId: string },
    agent: Agent<unknown>
  ) => TResult | Promise<TResult>;
  invalidates?: string[]; // Query names to invalidate after mutation
};

/**
 * Subscription manager for tracking query subscriptions
 */
class QuerySubscriptionManager {
  private heartbeatInterval = 45000; // 45s to beat corporate proxies
  private connectionGroups = new Map<string, Set<string>>();
  private readonly MAX_SUBSCRIPTIONS_PER_USER = 100;
  private heartbeatTimer?: number;

  constructor(private agent: Agent<unknown>) {
    this.setupHeartbeat();
  }

  private setupHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      this.agent.broadcast(
        JSON.stringify({
          type: MessageType.CF_AGENT_HEARTBEAT,
          timestamp: Date.now()
        })
      );
    }, this.heartbeatInterval) as unknown as number;
  }

  cleanup() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
  }

  subscribe(
    connectionId: string,
    userId: string,
    queryName: string,
    args: unknown
  ) {
    const userSubs = this.agent.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_query_subscriptions 
      WHERE user_id = ${userId}
    `[0];

    if (userSubs && userSubs.count >= this.MAX_SUBSCRIPTIONS_PER_USER) {
      throw new Error("Subscription limit exceeded");
    }

    if (!this.connectionGroups.has(userId)) {
      this.connectionGroups.set(userId, new Set());
    }
    this.connectionGroups.get(userId)!.add(connectionId);

    const dedupeKey = `${userId}:${queryName}:${JSON.stringify(args)}`;
    this.agent.sql`
      INSERT OR REPLACE INTO cf_agents_query_subscriptions 
      (dedupe_key, user_id, query_name, query_args, connection_ids, subscribed_at)
      VALUES (${dedupeKey}, ${userId}, ${queryName}, ${JSON.stringify(args)}, 
              ${JSON.stringify([...this.connectionGroups.get(userId)!])}, ${Date.now()})
    `;
  }

  unsubscribe(
    connectionId: string,
    userId: string,
    queryName: string,
    args: unknown
  ) {
    const dedupeKey = `${userId}:${queryName}:${JSON.stringify(args)}`;
    this.connectionGroups.get(userId)?.delete(connectionId);

    if (
      !this.connectionGroups.get(userId) ||
      this.connectionGroups.get(userId)!.size === 0
    ) {
      this.agent.sql`
        DELETE FROM cf_agents_query_subscriptions 
        WHERE dedupe_key = ${dedupeKey}
      `;
    } else {
      this.agent.sql`
        UPDATE cf_agents_query_subscriptions 
        SET connection_ids = ${JSON.stringify([...this.connectionGroups.get(userId)!])}
        WHERE dedupe_key = ${dedupeKey}
      `;
    }
  }

  getSubscriptions(userId: string) {
    return this.agent.sql<{
      query_name: string;
      query_args: string;
    }>`
      SELECT query_name, query_args 
      FROM cf_agents_query_subscriptions 
      WHERE user_id = ${userId}
    `;
  }

  getSubscribersForQuery(queryName: string) {
    return this.agent.sql<{
      user_id: string;
      connection_ids: string;
      query_args: string;
    }>`
      SELECT user_id, connection_ids, query_args 
      FROM cf_agents_query_subscriptions 
      WHERE query_name = ${queryName}
    `;
  }

  cleanupConnection(connectionId: string, userId: string) {
    this.connectionGroups.get(userId)?.delete(connectionId);

    const activeConnections = this.connectionGroups.get(userId);
    if (activeConnections && activeConnections.size > 0) {
      this.agent.sql`
        UPDATE cf_agents_query_subscriptions 
        SET connection_ids = ${JSON.stringify([...activeConnections])}
        WHERE user_id = ${userId}
      `;
    } else {
      this.agent.sql`
        DELETE FROM cf_agents_query_subscriptions 
        WHERE user_id = ${userId}
      `;
      this.connectionGroups.delete(userId);
    }
  }

  addConnectionToUser(connectionId: string, userId: string) {
    if (!this.connectionGroups.has(userId)) {
      this.connectionGroups.set(userId, new Set());
    }
    this.connectionGroups.get(userId)!.add(connectionId);

    this.agent.sql`
      UPDATE cf_agents_query_subscriptions 
      SET connection_ids = ${JSON.stringify([...this.connectionGroups.get(userId)!])}
      WHERE user_id = ${userId}
    `;
  }
}

/**
 * SyncAgent extends Agent with query/mutation sync capabilities
 * @template Env Environment type containing bindings
 * @template State State type to store within the Agent
 */
export class SyncAgent<
  Env = unknown,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends Agent<Env, State, Props> {
  protected queries = new Map<string, QueryDefinition>();
  protected mutations = new Map<string, MutationDefinition>();
  protected subscriptionManager: QuerySubscriptionManager;
  private globalVersion = 0;

  protected readonly QUERY_UPDATE_RETENTION = 24 * 60 * 60 * 1000; // 24 hours
  protected readonly MUTATION_RETENTION = 7 * 24 * 60 * 60 * 1000; // 7 days
  protected readonly RATE_LIMIT_RETENTION = 60 * 60 * 1000; // 1 hour

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    this.subscriptionManager = new QuerySubscriptionManager(this);

    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_query_subscriptions (
        dedupe_key TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        query_name TEXT NOT NULL,
        query_args TEXT NOT NULL,
        connection_ids TEXT NOT NULL,
        subscribed_at INTEGER NOT NULL
      )
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_mutations (
        mutation_id TEXT PRIMARY KEY,
        mutation_name TEXT NOT NULL,
        args TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_query_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query_name TEXT NOT NULL,
        query_args TEXT NOT NULL,
        version INTEGER NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_rate_limits (
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `;

    this
      .sql`CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON cf_agents_query_subscriptions(user_id)`;
    this
      .sql`CREATE INDEX IF NOT EXISTS idx_subscriptions_query ON cf_agents_query_subscriptions(query_name)`;
    this
      .sql`CREATE INDEX IF NOT EXISTS idx_updates_query ON cf_agents_query_updates(query_name, query_args)`;
    this
      .sql`CREATE INDEX IF NOT EXISTS idx_updates_version ON cf_agents_query_updates(version)`;
    this
      .sql`CREATE INDEX IF NOT EXISTS idx_rate_limits_user ON cf_agents_rate_limits(user_id, created_at)`;

    const versionRow = this.sql<{ value: string }>`
      SELECT value FROM cf_agents_metadata WHERE key = 'global_version'
    `[0];
    if (versionRow) {
      this.globalVersion = parseInt(versionRow.value, 10);
    }
  }

  /**
   * Register a query that clients can subscribe to
   */
  protected registerQuery<TArgs, TResult>(
    name: string,
    execute: (args: TArgs) => TResult[] | Promise<TResult[]>,
    options?: {
      dependencies?: string[];
      pagination?: QueryDefinition["pagination"];
    }
  ) {
    this.queries.set(name, {
      name,
      execute: execute as (
        args: unknown,
        agent: Agent<unknown>
      ) => unknown[] | Promise<unknown[]>,
      dependencies: options?.dependencies,
      pagination: options?.pagination
    });
  }

  /**
   * Register a mutation that clients can execute
   */
  protected registerMutation<TArgs, TResult>(
    name: string,
    execute: (
      args: TArgs & { mutationId: string }
    ) => TResult | Promise<TResult>,
    options?: { invalidates?: string[] }
  ) {
    this.mutations.set(name, {
      name,
      execute: execute as (
        args: unknown & { mutationId: string },
        agent: Agent<unknown>
      ) => unknown | Promise<unknown>,
      invalidates: options?.invalidates
    });
  }

  /**
   * Execute a query
   */
  private async executeQuery(queryName: string, args: unknown) {
    const queryDef = this.queries.get(queryName);
    if (!queryDef) {
      throw new Error(`Query ${queryName} not found`);
    }
    return await queryDef.execute(args, this);
  }

  /**
   * Broadcast query updates to all subscribed clients
   */
  private async broadcastQueryUpdate(queryName: string, version: number) {
    const subscribers =
      this.subscriptionManager.getSubscribersForQuery(queryName);

    for (const sub of subscribers) {
      const args = JSON.parse(sub.query_args);
      const data = await this.executeQuery(queryName, args);

      this.sql`
        INSERT INTO cf_agents_query_updates (query_name, query_args, version, data, created_at)
        VALUES (${queryName}, ${sub.query_args}, ${version}, ${JSON.stringify(data)}, ${Date.now()})
      `;

      const connectionIds = JSON.parse(sub.connection_ids);
      for (const connectionId of connectionIds) {
        const connection = this.getConnections().find(
          (c) => c.id === connectionId
        );
        if (connection) {
          try {
            connection.send(
              JSON.stringify({
                type: MessageType.CF_AGENT_QUERY_DATA,
                queryName,
                args,
                data,
                version,
                timestamp: Date.now()
              })
            );
          } catch (error) {
            console.warn(
              `Failed to send to connection ${connectionId}:`,
              error
            );
          }
        }
      }
    }
  }

  /**
   * Execute a mutation with idempotency
   */
  private async executeMutation(
    mutationName: string,
    args: unknown & { mutationId: string }
  ) {
    const existing = this.sql<{ result: string }>`
      SELECT result FROM cf_agents_mutations
      WHERE mutation_id = ${args.mutationId}
    `[0];

    if (existing) {
      return JSON.parse(existing.result); // Return cached result
    }

    const mutationDef = this.mutations.get(mutationName);
    if (!mutationDef) {
      throw new Error(`Mutation ${mutationName} not found`);
    }

    const result = await mutationDef.execute(args, this);

    this.sql`
      INSERT INTO cf_agents_mutations (mutation_id, mutation_name, args, result, created_at)
      VALUES (${args.mutationId}, ${mutationName}, ${JSON.stringify(args)}, ${JSON.stringify(result)}, ${Date.now()})
    `;

    this.globalVersion++;
    this.sql`
      INSERT OR REPLACE INTO cf_agents_metadata (key, value)
      VALUES ('global_version', ${this.globalVersion.toString()})
    `;

    if (mutationDef.invalidates) {
      for (const queryName of mutationDef.invalidates) {
        await this.broadcastQueryUpdate(queryName, this.globalVersion);
      }
    }

    return result;
  }

  /**
   * Override onMessage to handle sync protocol messages
   */
  override async onMessage(connection: Connection, message: WSMessage) {
    if (typeof message === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message);
      } catch (_e) {
        return super.onMessage(connection, message);
      }

      const msg = parsed as { type: string; [key: string]: unknown };

      if (msg.type === MessageType.CF_AGENT_QUERY_SUBSCRIBE) {
        const { queryName, args, subscriptionId } = msg as {
          queryName: string;
          args: unknown;
          subscriptionId: string;
        };

        const userId = await this.extractUserId(connection);
        if (!userId) {
          connection.send(
            JSON.stringify({
              type: MessageType.CF_AGENT_QUERY_ERROR,
              error: "Authentication required"
            })
          );
          return;
        }

        this.subscriptionManager.subscribe(
          connection.id,
          userId,
          queryName,
          args
        );

        try {
          const data = await this.executeQuery(queryName, args);
          connection.send(
            JSON.stringify({
              type: MessageType.CF_AGENT_QUERY_DATA,
              queryName,
              args,
              subscriptionId,
              data,
              version: this.globalVersion,
              timestamp: Date.now()
            })
          );
        } catch (error) {
          connection.send(
            JSON.stringify({
              type: MessageType.CF_AGENT_QUERY_ERROR,
              error:
                error instanceof Error
                  ? error.message
                  : "Query execution failed"
            })
          );
        }
        return;
      }

      if (msg.type === MessageType.CF_AGENT_QUERY_UNSUBSCRIBE) {
        const { queryName, args } = msg as { queryName: string; args: unknown };
        const userId = await this.extractUserId(connection);
        if (userId) {
          this.subscriptionManager.unsubscribe(
            connection.id,
            userId,
            queryName,
            args
          );
        }
        return;
      }

      if (msg.type === MessageType.CF_AGENT_MUTATION) {
        const { mutationName, args, mutationId } = msg as {
          mutationName: string;
          args: unknown;
          mutationId: string;
        };

        const userId = await this.extractUserId(connection);
        if (!userId) {
          connection.send(
            JSON.stringify({
              type: MessageType.CF_AGENT_MUTATION_RESULT,
              mutationId,
              success: false,
              error: "Authentication required"
            })
          );
          return;
        }

        try {
          const result = await this.executeMutation(mutationName, {
            ...args,
            mutationId
          } as unknown & {
            mutationId: string;
          });
          connection.send(
            JSON.stringify({
              type: MessageType.CF_AGENT_MUTATION_RESULT,
              mutationId,
              success: true,
              result,
              timestamp: Date.now()
            })
          );
        } catch (error) {
          connection.send(
            JSON.stringify({
              type: MessageType.CF_AGENT_MUTATION_RESULT,
              mutationId,
              success: false,
              error: error instanceof Error ? error.message : String(error)
            })
          );
        }
        return;
      }
    }

    return super.onMessage(connection, message);
  }

  /**
   * Override onConnect to handle reconnection after hibernation
   */
  override onConnect(
    connection: Connection,
    ctx: import("partyserver").ConnectionContext
  ) {
    super.onConnect(connection, ctx);

    const userId = this.extractUserIdSync(connection);
    if (userId) {
      const subscriptions = this.subscriptionManager.getSubscriptions(userId);
      if (subscriptions.length > 0) {
        this.subscriptionManager.addConnectionToUser(connection.id, userId);
      }
    }
  }

  /**
   * Override onClose to clean up subscriptions
   */
  override onClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ) {
    const userId = this.extractUserIdSync(connection);
    if (userId) {
      this.subscriptionManager.cleanupConnection(connection.id, userId);
    }
    super.onClose(connection, code, reason, wasClean);
  }

  /**
   * Cleanup method
   */
  override destroy() {
    this.subscriptionManager.cleanup();
    super.destroy();
  }

  /**
   * Extract userId from connection - async version
   * Override this method to implement your authentication logic
   */
  protected async extractUserId(
    connection: Connection
  ): Promise<string | null> {
    console.warn(
      "extractUserId not implemented - returning connection.id as userId"
    );
    return connection.id;
  }

  /**
   * Extract userId from connection - sync version for onConnect/onClose
   * Override this method to implement your authentication logic
   */
  protected extractUserIdSync(connection: Connection): string | null {
    console.warn(
      "extractUserIdSync not implemented - returning connection.id as userId"
    );
    return connection.id;
  }

  /**
   * Clean up old data from historical tables
   * Call this periodically (e.g., via schedule) to prevent unbounded growth
   */
  async cleanupOldData() {
    const now = Date.now();

    const updatesCutoff = now - this.QUERY_UPDATE_RETENTION;
    this.sql`
      DELETE FROM cf_agents_query_updates
      WHERE created_at < ${updatesCutoff}
    `;

    const mutationsCutoff = now - this.MUTATION_RETENTION;
    this.sql`
      DELETE FROM cf_agents_mutations
      WHERE created_at < ${mutationsCutoff}
    `;

    const rateLimitCutoff = now - this.RATE_LIMIT_RETENTION;
    this.sql`
      DELETE FROM cf_agents_rate_limits
      WHERE created_at < ${rateLimitCutoff}
    `;

    console.log("Cleanup completed", {
      timestamp: now,
      retentionPolicies: {
        queryUpdates: `${this.QUERY_UPDATE_RETENTION / (60 * 60 * 1000)}h`,
        mutations: `${this.MUTATION_RETENTION / (24 * 60 * 60 * 1000)}d`,
        rateLimits: `${this.RATE_LIMIT_RETENTION / (60 * 60 * 1000)}h`
      }
    });
  }
}
