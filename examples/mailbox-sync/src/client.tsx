import { useAgent } from "agents/react";
import { useDurableQuery, useDurableMutation } from "agents/sync-react";
import { useState } from "react";

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

export function MailboxApp() {
  const agent = useAgent<MailboxState>({
    agent: "MailboxAgent",
    name: "default"
  });

  const [showUnreadOnly, setShowUnreadOnly] = useState(false);

  const { data: emails, isLoading: emailsLoading } = useDurableQuery<
    { read?: boolean; limit?: number },
    Email
  >(agent, "getEmails", {
    read: showUnreadOnly ? false : undefined,
    limit: 50
  });

  const { data: stats } = useDurableQuery<
    Record<string, never>,
    { total: number; unread: number }
  >(agent, "getStats", {});

  const { mutate: markAsRead } = useDurableMutation<
    { emailId: string; read: boolean },
    { success: boolean }
  >(agent, "markAsRead");

  const { mutate: deleteEmail } = useDurableMutation<
    { emailId: string },
    { success: boolean }
  >(agent, "deleteEmail");

  const { mutate: addEmail } = useDurableMutation<
    { from: string; subject: string; body: string },
    { id: string }
  >(agent, "addEmail");

  const handleMarkAsRead = (emailId: string, read: boolean) => {
    markAsRead({ emailId, read });
  };

  const handleDelete = (emailId: string) => {
    if (confirm("Are you sure you want to delete this email?")) {
      deleteEmail({ emailId });
    }
  };

  const handleAddTestEmail = () => {
    addEmail({
      from: "test@example.com",
      subject: "Test Email " + new Date().toLocaleTimeString(),
      body: "This is a test email body"
    });
  };

  if (emailsLoading) {
    return <div className="p-4">Loading...</div>;
  }

  return (
    <div className="max-w-4xl mx-auto p-4">
      <div className="mb-4 flex justify-between items-center">
        <h1 className="text-2xl font-bold">Mailbox</h1>
        <div className="flex gap-4 items-center">
          {stats?.[0] && (
            <div className="text-sm text-gray-600">
              {stats[0].unread} unread / {stats[0].total} total
            </div>
          )}
          <button
            onClick={handleAddTestEmail}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Add Test Email
          </button>
        </div>
      </div>

      <div className="mb-4">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={showUnreadOnly}
            onChange={(e) => setShowUnreadOnly(e.target.checked)}
          />
          Show unread only
        </label>
      </div>

      <div className="space-y-2">
        {emails?.map((email) => (
          <div
            key={email.id}
            className={`border rounded p-4 ${
              email.read ? "bg-gray-50" : "bg-white font-semibold"
            }`}
          >
            <div className="flex justify-between items-start mb-2">
              <div className="flex-1">
                <div className="text-sm text-gray-600">{email.from}</div>
                <div className="text-lg">{email.subject}</div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleMarkAsRead(email.id, !email.read)}
                  className="text-sm px-3 py-1 border rounded hover:bg-gray-100"
                >
                  {email.read ? "Mark Unread" : "Mark Read"}
                </button>
                <button
                  onClick={() => handleDelete(email.id)}
                  className="text-sm px-3 py-1 border rounded text-red-600 hover:bg-red-50"
                >
                  Delete
                </button>
              </div>
            </div>
            <div className="text-sm text-gray-700">{email.body}</div>
            <div className="text-xs text-gray-500 mt-2">
              {new Date(email.received_at).toLocaleString()}
            </div>
          </div>
        ))}

        {(!emails || emails.length === 0) && (
          <div className="text-center py-8 text-gray-500">
            No emails {showUnreadOnly && "to show"}
          </div>
        )}
      </div>
    </div>
  );
}
