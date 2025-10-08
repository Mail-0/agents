# SyncAgent Guide

`SyncAgent` is a specialized Agent class that provides built-in query/mutation synchronization capabilities, making it easy to build real-time collaborative applications with automatic data sync across all connected clients.

## Quick Start

### 1. Create Your Agent

```typescript
import { SyncAgent } from "agents/sync-agent";
import type { AgentContext } from "agents";

interface Env {
  MyAgent: DurableObjectNamespace;
}

export class MyAgent extends SyncAgent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    // Create your database tables
    this.sql`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        completed INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `;

    // Register queries that clients can subscribe to
    this.registerQuery<{ completed?: boolean }, Todo>(
      "getTodos",
      (args) => {
        const filter =
          args.completed !== undefined
            ? `completed = ${args.completed ? 1 : 0}`
            : "1=1";

        return this.sql<Todo>`
          SELECT * FROM todos 
          WHERE ${filter}
          ORDER BY created_at DESC
        `;
      },
      { dependencies: ["todos"] }
    );

    // Register mutations that clients can execute
    this.registerMutation<{ id: string; text: string }, { success: boolean }>(
      "updateTodo",
      (args) => {
        this.sql`
          UPDATE todos 
          SET text = ${args.text}
          WHERE id = ${args.id}
        `;
        return { success: true };
      },
      { invalidates: ["getTodos"] } // Automatically refreshes this query for all clients
    );
  }
}
```

### 2. Use in React

```typescript
import { useAgent } from "agents/react";
import { useDurableQuery, useDurableMutation } from "agents/sync-react";

function TodoApp() {
  const agent = useAgent({ agent: "MyAgent", name: "default" });

  // Subscribe to todos - automatically updates when data changes
  const { data: todos, isLoading } = useDurableQuery(
    agent,
    "getTodos",
    { completed: false }
  );

  // Execute mutations - automatically triggers query refresh
  const { mutate: updateTodo } = useDurableMutation(
    agent,
    "updateTodo"
  );

  return (
    <div>
      {todos?.map(todo => (
        <div key={todo.id}>
          <input
            value={todo.text}
            onChange={(e) => updateTodo({
              id: todo.id,
              text: e.target.value
            })}
          />
        </div>
      ))}
    </div>
  );
}
```

## Key Concepts

### Queries

Queries are read-only operations that clients can subscribe to. When the underlying data changes (via mutations), all subscribed clients receive automatic updates.

```typescript
this.registerQuery<ArgsType, ResultType>(
  "queryName",
  (args) => {
    // Must return an array
    return this.sql`SELECT * FROM table WHERE ...`;
  },
  {
    dependencies: ["table1", "table2"], // Tables this query depends on
    pagination: {
      strategy: "cursor", // or "offset"
      keyField: "created_at"
    }
  }
);
```

**Key Points:**

- Queries must return arrays
- `dependencies` are used for documentation (not currently enforced)
- Clients can pass arguments to filter/customize results
- Multiple clients can subscribe to the same query with different args

### Mutations

Mutations are write operations that modify data and automatically trigger updates to affected queries.

```typescript
this.registerMutation<ArgsType, ResultType>(
  "mutationName",
  (args) => {
    this.sql`UPDATE table SET ...`;
    return { success: true, id: "..." };
  },
  {
    invalidates: ["queryName1", "queryName2"] // Queries to refresh
  }
);
```

**Key Points:**

- Mutations can return any data
- `invalidates` lists which queries should be refreshed
- All clients subscribed to invalidated queries receive updates automatically
- Mutations are idempotent by default (mutationId tracked server-side)

## Advanced Features

### Authentication

Override `extractUserId()` to implement authentication:

```typescript
export class MyAgent extends SyncAgent<Env> {
  protected override async extractUserId(
    connection: Connection
  ): Promise<string | null> {
    const token = connection.request?.headers
      ?.get("authorization")
      ?.replace("Bearer ", "");
    if (!token) return null;

    try {
      const payload = await verifyJWT(token);
      return payload.userId;
    } catch {
      return null;
    }
  }

  protected override extractUserIdSync(connection: Connection): string | null {
    // Sync version for onConnect/onClose
    // If you can't extract synchronously, return connection.id
    return connection.id;
  }
}
```

### State Management

SyncAgent extends Agent, so you can still use `setState()` for application-level state:

```typescript
interface MyState {
  activeUsers: number;
  lastActivity: number;
}

export class MyAgent extends SyncAgent<Env, MyState> {
  initialState: MyState = {
    activeUsers: 0,
    lastActivity: Date.now()
  };

  override onConnect(connection: Connection, ctx: ConnectionContext) {
    super.onConnect(connection, ctx);

    this.setState({
      ...this.state,
      activeUsers: this.getConnections().length
    });
  }
}
```

### Data Cleanup

SyncAgent includes automatic cleanup for historical data:

```typescript
export class MyAgent extends SyncAgent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    // Schedule cleanup to run hourly
    this.schedule("0 * * * *", "cleanupOldData", {});
  }
}
```

You can customize retention periods:

```typescript
export class MyAgent extends SyncAgent<Env> {
  // Override default retention periods
  protected readonly QUERY_UPDATE_RETENTION = 48 * 60 * 60 * 1000; // 48 hours
  protected readonly MUTATION_RETENTION = 14 * 24 * 60 * 60 * 1000; // 14 days
  protected readonly RATE_LIMIT_RETENTION = 2 * 60 * 60 * 1000; // 2 hours
}
```

### Pagination

For large datasets, use pagination:

```typescript
// Cursor-based (recommended)
this.registerQuery<{ cursor?: string; limit?: number }, Todo>(
  "getTodosPaginated",
  (args) => {
    const limit = args.limit || 20;
    const cursorCondition = args.cursor ? `created_at < ${args.cursor}` : "1=1";

    return this.sql`
      SELECT * FROM todos
      WHERE ${cursorCondition}
      ORDER BY created_at DESC
      LIMIT ${limit + 1}
    `;
  },
  {
    dependencies: ["todos"],
    pagination: {
      strategy: "cursor",
      keyField: "created_at"
    }
  }
);
```

### Complex Queries

Queries can be as complex as needed:

```typescript
this.registerQuery<
  { userId: string; startDate: number; endDate: number },
  Report
>(
  "getUserReport",
  (args) => {
    return this.sql`
      SELECT 
        u.name,
        COUNT(t.id) as total_tasks,
        SUM(CASE WHEN t.completed = 1 THEN 1 ELSE 0 END) as completed_tasks,
        AVG(t.priority) as avg_priority
      FROM users u
      LEFT JOIN tasks t ON t.user_id = u.id
      WHERE u.id = ${args.userId}
        AND t.created_at BETWEEN ${args.startDate} AND ${args.endDate}
      GROUP BY u.id
    `;
  },
  { dependencies: ["users", "tasks"] }
);
```

## Client-Side Hooks

### useDurableQuery

Subscribe to a query with real-time updates:

```typescript
const {
  data, // Query results
  isLoading, // Initial loading state
  error, // Error if query failed
  refetch, // Manual refetch function
  isFetching, // Loading state (including refetch)
  isStale // Whether data is considered stale
} = useDurableQuery(
  agent,
  "queryName",
  { arg1: "value" },
  {
    // All TanStack Query options available
    staleTime: 5000,
    refetchOnWindowFocus: true,
    enabled: true
  }
);
```

### useDurableMutation

Execute mutations with automatic query invalidation:

```typescript
const {
  mutate, // Execute mutation (fire-and-forget)
  mutateAsync, // Execute mutation (returns promise)
  isPending, // Whether mutation is in progress
  error, // Error if mutation failed
  data // Mutation result
} = useDurableMutation(agent, "mutationName", {
  onSuccess: (result) => {
    console.log("Mutation succeeded:", result);
  },
  onError: (error) => {
    console.error("Mutation failed:", error);
  }
});

// Fire-and-forget
mutate({ arg1: "value" });

// Async/await
const result = await mutateAsync({ arg1: "value" });
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│              React Components                        │
│  useDurableQuery / useDurableMutation               │
└──────────────┬──────────────────────────────────────┘
               │
               │ WebSocket (Query/Mutation Protocol)
               │
┌──────────────▼──────────────────────────────────────┐
│              SyncAgent                               │
│  - Query Registry                                    │
│  - Mutation Registry                                 │
│  - QuerySubscriptionManager                          │
│  - Automatic Broadcasting                            │
└──────────────┬──────────────────────────────────────┘
               │
               │ SQLite / SQL API
               │
┌──────────────▼──────────────────────────────────────┐
│         Durable Object Storage                       │
│  - Application Tables                                │
│  - Subscription Tracking                             │
│  - Query Update History                              │
│  - Mutation Idempotency                              │
└─────────────────────────────────────────────────────┘
```

## Benefits

1. **No Manual Broadcasting**: Mutations automatically broadcast to affected queries
2. **Real-time Sync**: All clients always have the latest data
3. **Type-Safe**: Full TypeScript support for queries and mutations
4. **Hibernation-Aware**: Subscriptions survive Durable Object hibernation
5. **Idempotent**: Mutations automatically deduplicated by ID
6. **Version Control**: Out-of-order updates prevented
7. **Built on TanStack Query**: Leverage battle-tested caching and state management

## Examples

See the [mailbox-sync example](../examples/mailbox-sync) for a complete working application.

## Migration from Manual State Management

If you're currently using manual `setState()` and `broadcast()`:

**Before:**

```typescript
async updateTodo(id: string, text: string) {
  this.sql`UPDATE todos SET text = ${text} WHERE id = ${id}`;

  // Manual: fetch updated data
  const todos = this.sql`SELECT * FROM todos`;

  // Manual: broadcast to all clients
  this.broadcast(JSON.stringify({ type: "todos_updated", todos }));
}
```

**After:**

```typescript
constructor(ctx: AgentContext, env: Env) {
  super(ctx, env);

  this.registerQuery("getTodos", () => {
    return this.sql`SELECT * FROM todos`;
  }, { dependencies: ["todos"] });

  this.registerMutation("updateTodo", (args) => {
    this.sql`UPDATE todos SET text = ${args.text} WHERE id = ${args.id}`;
    return { success: true };
  }, { invalidates: ["getTodos"] });
}
```

The framework handles fetching, broadcasting, and keeping clients in sync automatically!
