/**
 * An error whose message is written for the user and safe to show as is (no secrets, no internals).
 * The API returns it with its status; any other unexpected error becomes a generic 500.
 */
export class UserError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
