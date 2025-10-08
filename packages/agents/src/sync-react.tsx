import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
  type UseMutationOptions
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { nanoid } from "nanoid";
import type { useAgent } from "./react";
import { MessageType } from "./ai-types";
import {
  CURRENT_PROTOCOL_VERSION,
  QUERY_TIMEOUT,
  MUTATION_TIMEOUT
} from "./sync-agent";

/**
 * Hook to subscribe to a query from a SyncAgent
 * Provides real-time updates when data changes on the server
 */
export function useDurableQuery<TArgs, TResult>(
  agent: ReturnType<typeof useAgent>,
  queryName: string,
  args: TArgs,
  options?: Omit<UseQueryOptions<TResult[], Error>, "queryKey" | "queryFn">
) {
  const queryClient = useQueryClient();
  const subscriptionRef = useRef<{
    id: string;
    cleanup: () => void;
  } | null>(null);

  const isStrictMode = useRef(false);
  useEffect(() => {
    if (isStrictMode.current) return;
    isStrictMode.current = true;

    return () => {
      isStrictMode.current = false;
    };
  }, []);

  const queryKey = [
    "durable",
    agent.agent,
    agent.name,
    queryName,
    args
  ] as const;

  const query = useQuery<TResult[], Error>({
    queryKey,
    queryFn: async ({ signal }) => {
      if (subscriptionRef.current) {
        subscriptionRef.current.cleanup();
      }

      const subscriptionId = nanoid();
      let isSubscribed = true;

      const cleanup = () => {
        isSubscribed = false;
        if (subscriptionRef.current?.id === subscriptionId) {
          subscriptionRef.current = null;
        }
        agent.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_QUERY_UNSUBSCRIBE,
            queryName,
            args,
            subscriptionId
          })
        );
      };

      subscriptionRef.current = { id: subscriptionId, cleanup };

      signal?.addEventListener("abort", cleanup);

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (isSubscribed) {
            cleanup();
            reject(new Error("Query timeout"));
          }
        }, QUERY_TIMEOUT);

        const handleMessage = (event: MessageEvent) => {
          if (!isSubscribed || typeof event.data !== "string") return;

          try {
            const message = JSON.parse(event.data);

            if (message.type === MessageType.CF_AGENT_VERSION_MISMATCH) {
              cleanup();
              reject(
                new Error(
                  `Protocol version mismatch: ${message.clientVersion} vs ${message.supportedVersion}`
                )
              );
              return;
            }

            if (message.type === MessageType.CF_AGENT_QUERY_ERROR) {
              cleanup();
              reject(new Error(message.error));
              return;
            }

            if (
              message.type === MessageType.CF_AGENT_QUERY_DATA &&
              message.subscriptionId === subscriptionId
            ) {
              clearTimeout(timeout);
              resolve(message.data);

              const handleUpdates = (updateEvent: MessageEvent) => {
                if (!isSubscribed || typeof updateEvent.data !== "string")
                  return;

                try {
                  const updateMessage = JSON.parse(updateEvent.data);

                  if (
                    updateMessage.type === MessageType.CF_AGENT_QUERY_DATA &&
                    updateMessage.queryName === queryName &&
                    JSON.stringify(updateMessage.args) === JSON.stringify(args)
                  ) {
                    const currentData = queryClient.getQueryData(queryKey) as
                      | (TResult[] & { version?: number })
                      | undefined;
                    const currentVersion = (currentData as any)?.version || 0;
                    if (updateMessage.version > currentVersion) {
                      queryClient.setQueryData(queryKey, {
                        ...updateMessage.data,
                        version: updateMessage.version
                      });
                    }
                  }
                } catch (err) {
                  console.error("Error handling query update:", err);
                }
              };

              agent.addEventListener("message", handleUpdates);

              const originalCleanup = cleanup;
              subscriptionRef.current!.cleanup = () => {
                originalCleanup();
                agent.removeEventListener("message", handleUpdates);
              };
            }
          } catch (err) {
            if (isSubscribed) {
              cleanup();
              reject(err);
            }
          }
        };

        agent.addEventListener("message", handleMessage);

        agent.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_QUERY_SUBSCRIBE,
            queryName,
            args,
            subscriptionId,
            version: CURRENT_PROTOCOL_VERSION
          })
        );
      });
    },
    ...options
  });

  useEffect(() => {
    return () => {
      subscriptionRef.current?.cleanup();
    };
  }, []);

  return query;
}

/**
 * Hook to execute mutations on a SyncAgent
 * Mutations automatically trigger query invalidations on the server
 */
export function useDurableMutation<TArgs, TResult>(
  agent: ReturnType<typeof useAgent>,
  mutationName: string,
  options?: Omit<UseMutationOptions<TResult, Error, TArgs>, "mutationFn">
) {
  const pendingMutationsRef = useRef(
    new Map<
      string,
      {
        resolve: (value: TResult) => void;
        reject: (error: Error) => void;
      }
    >()
  );

  const mutation = useMutation<TResult, Error, TArgs>({
    mutationFn: async (args: TArgs) => {
      return new Promise((resolve, reject) => {
        const mutationId = nanoid();
        pendingMutationsRef.current.set(mutationId, { resolve, reject });

        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Mutation timeout"));
        }, MUTATION_TIMEOUT);

        const handleMessage = (event: MessageEvent) => {
          if (typeof event.data !== "string") return;

          try {
            const message = JSON.parse(event.data);

            if (
              message.type === MessageType.CF_AGENT_MUTATION_RESULT &&
              message.mutationId === mutationId
            ) {
              clearTimeout(timeout);
              cleanup();
              pendingMutationsRef.current.delete(mutationId);

              if (message.success) {
                resolve(message.result);
              } else {
                reject(new Error(message.error));
              }
            }
          } catch (err) {
            cleanup();
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        };

        const cleanup = () => {
          agent.removeEventListener("message", handleMessage);
        };

        agent.addEventListener("message", handleMessage);

        agent.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_MUTATION,
            mutationName,
            args,
            mutationId
          })
        );
      });
    },
    ...options,
    onSuccess: (data, variables, context) => {
      options?.onSuccess?.(data, variables, context);
    }
  });

  return mutation;
}
