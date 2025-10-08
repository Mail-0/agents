import { SyncAgent } from "agents/sync-agent";
import type { AgentContext } from "agents";

interface Env {
  MailboxAgent: DurableObjectNamespace;
}

interface Email {
  id: string;
  from: string;
  subject: string;
  body: string;
  received_at: number;
  read: boolean;
}

interface MailboxState {
  unreadCount: number;
}

/**
 * Example MailboxAgent that extends SyncAgent
 * Demonstrates how to use query/mutation sync for a mailbox application
 */
export class MailboxAgent extends SyncAgent<Env, MailboxState> {
  initialState: MailboxState = {
    unreadCount: 0
  };

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    this.sql`
      CREATE TABLE IF NOT EXISTS emails (
        id TEXT PRIMARY KEY,
        from_address TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        read INTEGER NOT NULL DEFAULT 0
      )
    `;

    this.registerQuery<{ read?: boolean; limit?: number }, Email>(
      "getEmails",
      (args) => {
        const limit = args.limit || 50;
        const readFilter =
          args.read !== undefined ? `read = ${args.read ? 1 : 0}` : "1=1";

        return this.sql<Email>`
          SELECT 
            id,
            from_address as from,
            subject,
            body,
            received_at,
            read
          FROM emails
          WHERE ${readFilter}
          ORDER BY received_at DESC
          LIMIT ${limit}
        `;
      },
      { dependencies: ["emails"] }
    );

    this.registerQuery<{ emailId: string }, Email>(
      "getEmail",
      (args) => {
        return this.sql<Email>`
          SELECT 
            id,
            from_address as from,
            subject,
            body,
            received_at,
            read
          FROM emails
          WHERE id = ${args.emailId}
        `;
      },
      { dependencies: ["emails"] }
    );

    this.registerQuery<
      Record<string, never>,
      { total: number; unread: number }
    >(
      "getStats",
      () => {
        const [stats] = this.sql<{ total: number; unread: number }>`
          SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as unread
          FROM emails
        `;
        return [stats];
      },
      { dependencies: ["emails"] }
    );

    this.registerMutation<
      { emailId: string; read: boolean },
      { success: boolean }
    >(
      "markAsRead",
      (args) => {
        this.sql`
          UPDATE emails
          SET read = ${args.read ? 1 : 0}
          WHERE id = ${args.emailId}
        `;

        const [stats] = this.sql<{ unread: number }>`
          SELECT COUNT(*) as unread FROM emails WHERE read = 0
        `;
        this.setState({ unreadCount: stats.unread });

        return { success: true };
      },
      { invalidates: ["getEmails", "getEmail", "getStats"] }
    );

    this.registerMutation<{ emailId: string }, { success: boolean }>(
      "deleteEmail",
      (args) => {
        this.sql`
          DELETE FROM emails WHERE id = ${args.emailId}
        `;

        const [stats] = this.sql<{ unread: number }>`
          SELECT COUNT(*) as unread FROM emails WHERE read = 0
        `;
        this.setState({ unreadCount: stats.unread });

        return { success: true };
      },
      { invalidates: ["getEmails", "getStats"] }
    );

    this.registerMutation<
      { from: string; subject: string; body: string },
      { id: string }
    >(
      "addEmail",
      (args) => {
        const id = crypto.randomUUID();
        const received_at = Date.now();

        this.sql`
          INSERT INTO emails (id, from_address, subject, body, received_at, read)
          VALUES (${id}, ${args.from}, ${args.subject}, ${args.body}, ${received_at}, 0)
        `;

        const [stats] = this.sql<{ unread: number }>`
          SELECT COUNT(*) as unread FROM emails WHERE read = 0
        `;
        this.setState({ unreadCount: stats.unread });

        return { id };
      },
      { invalidates: ["getEmails", "getStats"] }
    );

    this.schedule("0 * * * *", "cleanupOldData", {});
  }

  /**
   * Override extractUserId to implement your authentication logic
   * For this example, we'll use a simple connection-based ID
   */
  protected override async extractUserId(
    connection: import("agents").Connection
  ): Promise<string | null> {
    return connection.id;
  }

  protected override extractUserIdSync(
    connection: import("agents").Connection
  ): string | null {
    return connection.id;
  }

  async onStart() {
    await super.onStart();

    const [stats] = this.sql<{ unread: number }>`
      SELECT COUNT(*) as unread FROM emails WHERE read = 0
    `;
    if (stats) {
      this.setState({ unreadCount: stats.unread });
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    const id = env.MailboxAgent.idFromName("default");
    const agent = env.MailboxAgent.get(id);

    return agent.fetch(request);
  }
};
