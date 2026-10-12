/**
 * Stage 3b (plan r1.4 R4.3): the model-client wrapper. Everything else of the scoped inner run lives in lib/why-scope.ts
 * (re-exported here), so modules that only capture or skip logs never reach client code.
 */
import { assertModelAllowed } from "./why-scope";

export * from "./why-scope";

type MessagesLike = { messages: { create: (...a: never[]) => unknown } };
/** Wrap a model client so every `messages.create` passes the guard first. */
export function guardModelClient<T extends MessagesLike>(client: T): T {
  const messages = new Proxy(client.messages, {
    get(target, prop, receiver) {
      if (prop === "create") {
        return (...a: never[]) => { assertModelAllowed("model invocation"); return (target.create as (...x: never[]) => unknown).apply(target, a); };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return new Proxy(client, { get: (target, prop, receiver) => (prop === "messages" ? messages : Reflect.get(target, prop, receiver)) });
}
