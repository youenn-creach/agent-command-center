import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The background request a piece of work belongs to, with its cancel signal. runInBackground (agents/command.ts) runs each
 * request's work inside a scope; every model call made for it (local or cloud) picks the signal up here, so "Cancel" stops the
 * model mid-answer without touching other work, and actions and reminders refuse to be created once it is cancelled.
 */
const scope = new AsyncLocalStorage<{ id: string; signal: AbortSignal }>();

export class RequestCancelledError extends Error {
  constructor() {
    super("Cancelled by you.");
  }
}

export function runInRequestScope<T>(id: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return scope.run({ id, signal }, fn);
}

/** The cancel signal of the request this code runs for, if any. */
export function requestSignal(): AbortSignal | undefined {
  return scope.getStore()?.signal;
}

/** Throws if the request this code runs for was cancelled: nothing new is created for a cancelled request. */
export function assertNotCancelled() {
  if (scope.getStore()?.signal.aborted) throw new RequestCancelledError();
}
