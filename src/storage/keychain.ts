/**
 * Keychain-backed `SecretStore` for the Canvas access token and other secrets
 * (PRD v1.6 §3, HANDOFF §3.3). The token lives in the macOS Keychain — never
 * in the SQLite DB or on disk.
 *
 * SECURITY: the macOS `security` CLI is invoked via `execFile('security', [..])`
 * with an ARGUMENT ARRAY — never `exec` with a shell string. No shell is spawned,
 * so secret values containing shell metacharacters cannot be interpreted. The
 * command runner is injectable so tests run fully offline without touching the
 * real Keychain.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SecretStore } from '../contracts/index.js';

/** Output of a command invocation. */
export interface CommandResult {
  stdout: string;
  stderr: string;
}

/** Runs an executable with a discrete argument array (no shell). */
export type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;

export interface KeychainOptions {
  /** Keychain service name (the `-s` value). Defaults to `CanvasAgent`. */
  service?: string;
  /** Injectable command runner; defaults to a real `execFile`-based runner. */
  runner?: CommandRunner;
}

const DEFAULT_SERVICE = 'CanvasAgent';

const execFileAsync = promisify(execFile);

/** Real runner: `execFile` with an arg array (no shell), UTF-8 decoded. */
const defaultRunner: CommandRunner = async (file, args) => {
  const { stdout, stderr } = await execFileAsync(file, [...args], { encoding: 'utf8' });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
};

/** The `security` tool exits 44 (errSecItemNotFound) when an item is missing. */
function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; stderr?: unknown; message?: unknown };
  if (e.code === 44) return true;
  const text = `${typeof e.stderr === 'string' ? e.stderr : ''} ${
    typeof e.message === 'string' ? e.message : ''
  }`;
  return /could not be found/i.test(text);
}

/**
 * Create a `SecretStore` backed by the macOS Keychain via the `security` CLI.
 * Inject `runner` in tests to avoid touching the real Keychain.
 */
export function createKeychainSecretStore(options: KeychainOptions = {}): SecretStore {
  const service = options.service ?? DEFAULT_SERVICE;
  const run = options.runner ?? defaultRunner;

  return {
    async get(key: string): Promise<string | null> {
      try {
        const { stdout } = await run('security', [
          'find-generic-password',
          '-s',
          service,
          '-a',
          key,
          '-w',
        ]);
        // `security -w` prints the password followed by a single newline.
        return stdout.replace(/\n$/, '');
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async set(key: string, value: string): Promise<void> {
      // SECURITY (invariant #4): the secret is passed to `security` as the `-w`
      // argv value. On a write FAILURE the underlying `execFile` rejection embeds
      // the full command line (`err.cmd`) and often the value in `err.message`/
      // `err.stack`. That rejection would otherwise propagate up through ipc.ts →
      // bridge.ts and reach the renderer, leaking the Canvas token. So we catch any
      // failure here and rethrow a REDACTED error that carries no message/cmd/stack
      // from the original — the secret can never cross the IPC boundary on an error.
      //
      // (`-w <value>` argv is kept deliberately: `security add-generic-password -w`
      // with no value prompts the controlling tty twice rather than reading a pipe,
      // so there is no reliable non-interactive stdin path. The residual argv
      // exposure is marginal — a same-user process can already read the stored item
      // prompt-free on this single-user device.)
      try {
        // `-U` updates the item if it already exists (otherwise it errors).
        await run('security', [
          'add-generic-password',
          '-U',
          '-s',
          service,
          '-a',
          key,
          '-w',
          value,
        ]);
      } catch {
        throw new Error(
          'Failed to store the secret in the macOS Keychain (the `security` command exited with an error). ' +
            'Details were redacted to avoid leaking the secret value.',
        );
      }
    },

    async delete(key: string): Promise<void> {
      try {
        await run('security', ['delete-generic-password', '-s', service, '-a', key]);
      } catch (err) {
        // Deleting a missing key is a no-op, not an error.
        if (isNotFound(err)) return;
        throw err;
      }
    },
  };
}

/**
 * In-memory `SecretStore` for tests and for tracks (e.g. canvas) that need a
 * secret store without the real Keychain. Not persisted.
 */
export function createInMemorySecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    async get(key: string): Promise<string | null> {
      return map.has(key) ? map.get(key)! : null;
    },
    async set(key: string, value: string): Promise<void> {
      map.set(key, value);
    },
    async delete(key: string): Promise<void> {
      map.delete(key);
    },
  };
}
