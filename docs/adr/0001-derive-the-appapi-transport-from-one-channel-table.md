---
status: accepted
---

# Derive the AppApi transport from one channel table

Every `AppApi` capability is hand-written into eight places, and the two transport
files escape the contract's compiler enforcement entirely: `CHANNELS`
(`src/app/channels.ts`) is a bare object literal with no `satisfies` constraint, and
`registerIpc(ipcMain, api: AppApi)` (`src/app/ipc.ts`) takes `AppApi` as a
*parameter*, which constrains its callers rather than its body — nothing forces it
to handle every member. We will make the channel table compiler-checked for
completeness against `AppApi`'s member list and derive the mechanical
`ipcMain.handle` registrations from it.

**Derivation stops there.** `bridge.ts` stays hand-written: `createBridge(): AppApi`
is already `AppApi`-typed at its return position, so it cannot drift, and its
handlers do real work a table cannot express — error-envelope unwrapping, and
minting/tearing down the streaming subscriptions for `runTurn`, `pullModel`, and
`pullIngestModel`.

## Shape

`CHANNELS` gains `satisfies Record<keyof AppApi, string>`. The three streaming
handlers are registered explicitly first; the remaining twenty — all uniformly
`(…args) => envelope(() => api.method(...args))` — are derived by looping the table
and skipping what is already registered. No flag field on the table entries.

The three one-way event channels (`CHUNK`, `PULL_PROGRESS`, `INGEST_PULL_PROGRESS`)
are already excluded from `CHANNELS` and stay that way — they are `send`, never
`handle`, so they have no handler to derive.

## Consequences

This does not touch the AppApi growth law. `AppApi` keeps zero optional members and
all four implementers keep their explicit methods. The change only extends compiler
enforcement to `channels.ts` and `ipc.ts`, which today have none.

Three transport tests are deleted as part of this, because the compiler subsumes
them — recorded here so a future reader doesn't read the deletion as lost coverage:

- `channels.test.ts` — compared `CHANNELS` to its own constituent constants.
- `ipc.test.ts` — asserted a handler per channel. Covered by the `satisfies`
  constraint once it lands, *including* its `!handlers.has(CHUNK)` assertion, since
  an excess key now fails to compile. Delete only after the constraint is in.
- `bridge.test.ts` — asserted the exact key list of the preload surface. TypeScript
  already applies excess-property checking to the object literal returned from
  `createBridge(): AppApi`. This escapes the compiler only if someone rewrites that
  return to use a spread, so leave a comment on the return saying so.

All behaviour tests are kept.
