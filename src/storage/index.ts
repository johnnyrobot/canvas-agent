/**
 * Storage track — public surface (PRD v1.6 §3, §16; HANDOFF §3.3).
 *
 * The foundation for the single-user macOS desktop app: a SQLite-backed
 * `Database`, the macOS Keychain-backed `SecretStore`, the local file layout,
 * and the idempotent core schema. Other tracks (knowledge, canvas) depend ONLY
 * on the ports declared in `src/contracts` and receive these implementations by
 * injection — never by importing this module's internals.
 *
 * The five contract functions:
 *  - `openDatabase`               — node:sqlite-backed `Database`
 *  - `createKeychainSecretStore`  — real macOS `security`-backed `SecretStore`
 *  - `createInMemorySecretStore`  — Map-backed `SecretStore` (tests/other tracks)
 *  - `resolveAppPaths`            — pure local-file-layout resolver
 *  - `migrate`                    — idempotent core schema
 */
export { openDatabase } from './database.js';
export { migrate, SCHEMA_VERSION } from './schema.js';
export { resolveAppPaths, ensureAppDirs } from './paths.js';
export {
  createKeychainSecretStore,
  createInMemorySecretStore,
  type CommandRunner,
  type CommandResult,
  type KeychainOptions,
} from './keychain.js';
