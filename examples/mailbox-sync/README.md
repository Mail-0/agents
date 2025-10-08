# Mailbox Sync Example

This example demonstrates how to use `SyncAgent` to build a real-time synchronized mailbox application.

## Features

- **Real-time sync**: All connected clients see the same emails instantly
- **Query subscriptions**: Subscribe to email lists that auto-update when data changes
- **Mutations**: Mark emails as read/unread, delete emails, add new emails
- **Automatic invalidation**: Mutations automatically trigger query updates
- **State management**: Track unread count across all clients
- **Hibernation support**: Subscriptions survive Durable Object hibernation

## Architecture

```
┌─────────────────┐
│  React Client   │
│  (MailboxApp)   │
└────────┬────────┘
         │
         │ WebSocket + Query/Mutation Protocol
         │
┌────────▼────────┐
│  MailboxAgent   │
│  extends        │
│  SyncAgent      │
└────────┬────────┘
         │
         │ SQLite Storage
         │
┌────────▼────────┐
│  emails table   │
└─────────────────┘
```

## Usage

### Server-Side

```typescript
export class MailboxAgent extends SyncAgent<Env, MailboxState> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    // Register queries
    this.registerQuery(
      "getEmails",
      (args) => {
        return this.sql`SELECT * FROM emails WHERE ...`;
      },
      { dependencies: ["emails"] }
    );

    // Register mutations
    this.registerMutation(
      "markAsRead",
      (args) => {
        this.sql`UPDATE emails SET read = 1 WHERE id = ${args.emailId}`;
        return { success: true };
      },
      { invalidates: ["getEmails", "getStats"] }
    );
  }
}
```

### Client-Side

```typescript
function MailboxApp() {
  const agent = useAgent({ agent: "MailboxAgent", name: "default" });

  // Subscribe to emails - auto-updates when data changes
  const { data: emails } = useDurableQuery(
    agent,
    "getEmails",
    { read: false }
  );

  // Execute mutations
  const { mutate: markAsRead } = useDurableMutation(agent, "markAsRead");

  return (
    <div>
      {emails?.map(email => (
        <div key={email.id}>
          <button onClick={() => markAsRead({ emailId: email.id, read: true })}>
            Mark as Read
          </button>
        </div>
      ))}
    </div>
  );
}
```

## Running Locally

```bash
npm install
npm run dev
```

## Deploying

```bash
npm run deploy
```

## Key Concepts

### Queries

Queries are functions that return data from your database. Clients can subscribe to queries and receive automatic updates when the underlying data changes.

```typescript
this.registerQuery<ArgsType, ResultType>(
  "queryName",
  (args) => {
    // Return array of results
    return this.sql`SELECT * FROM table WHERE ...`;
  },
  { dependencies: ["table"] } // Tables this query depends on
);
```

### Mutations

Mutations modify data and automatically invalidate affected queries, triggering real-time updates to all subscribed clients.

```typescript
this.registerMutation<ArgsType, ResultType>(
  "mutationName",
  (args) => {
    this.sql`UPDATE table SET ...`;
    return { success: true };
  },
  { invalidates: ["queryName1", "queryName2"] } // Queries to refresh
);
```

### Authentication

Override `extractUserId()` to implement your authentication logic:

```typescript
protected override async extractUserId(connection: Connection): Promise<string | null> {
  const token = connection.request?.headers?.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const payload = await verifyJWT(token);
  return payload.userId;
}
```

## Benefits Over Manual State Management

1. **No manual broadcasting**: Mutations automatically broadcast to subscribed clients
2. **No stale data**: Clients always have the latest data
3. **No duplicate subscriptions**: Framework handles deduplication
4. **Hibernation-aware**: Subscriptions restored automatically after hibernation
5. **Type-safe**: Full TypeScript support for queries and mutations
