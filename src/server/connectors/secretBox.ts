import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Encrypts OAuth tokens before they touch the database (AES-256-GCM).
 *
 * The key lives OUTSIDE the project and the database: ~/.config/agent-command-center/token.key
 * (mode 0600, directory 0700), or ACC_KEY_FILE. Someone who copies data/acc.sqlite alone gets
 * ciphertext. Limitation (documented): anyone who can read files as your OS user can read both;
 * an OS keyring would be the next step.
 *
 * The service id is bound as additional authenticated data, so a Gmail token cannot be swapped
 * into the Calendar row (or vice versa) without failing decryption.
 */

const VERSION = "v1";

export function keyPath() {
  return process.env.ACC_KEY_FILE ?? path.join(homedir(), ".config", "agent-command-center", "token.key");
}

let cachedKey: Buffer | undefined;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const file = keyPath();
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600, flag: "wx" });
    } catch (err) {
      // The web server and the worker started together and the other one wrote it first: use theirs.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  chmodSync(file, 0o600);
  const key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  if (key.length !== 32) throw new Error(`Token key at ${file} is invalid (expected 32 bytes, base64).`);
  cachedKey = key;
  return key;
}

export function seal(plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", loadKey(), iv);
  cipher.setAAD(Buffer.from(context));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;
}

export function open(sealed: string, context: string): string {
  const [version, body] = sealed.split(":");
  if (version !== VERSION || !body) throw new Error("Unknown token format");
  const raw = Buffer.from(body, "base64");
  const decipher = createDecipheriv("aes-256-gcm", loadKey(), raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}
