
# 3mm Terminal

Interactive Linux terminal extension for the 3mm platform.

## Overview

3mm Terminal provides browser-based interactive shell sessions
through the 3mm Interactive Session Platform (M21).

The extension is independent of Fleet and Cloud. **Version 1.0.2 is prepared for
the Core 0.3.0-beta.55 local trial**, not a general host-administration release.
Core and this package must be published/updated separately before installed tests.

## Operating modes

### Local — first experimental profile
Use an isolated, temporary workspace on the Linux machine running Core. The
session has a separate dynamic identity, no network/Core-private/home access,
and no `raspberry` or root administration. It is not a normal host-user shell.

### Fleet — not enabled by 1.0.2
Future platform transport to authorized Linux nodes through the same contract.

### Cloud — not enabled by 1.0.2
Future approved platform transport through the same contract, not a second
Terminal extension or an extension-owned SSH/pairing system.

Remote targets are displayed only when discovery confirms
an available, compatible and authorized terminal provider.

## Components

- Frontend: Vue 3 and xterm.js; rendering does not grant host authority
- Application service: Session management client
- Session provider: Linux PTY in the platform-owned isolated process
- Platform integration: M20 package contracts and M21 Session SDK

## Requirements

- Core **0.3.0-beta.55 or newer** with the explicitly enabled local session profile
- M20 Module Manifest v2
- M21 Interactive Session Platform
- Linux/systemd/cgroup-v2 host with the optional session-worker socket enabled

The manifest's `>=0.3.0` floor cannot encode Beta numbers. It does not mean that
beta.54 or older supports this package's new session declarations.

Fleet and Cloud are optional.

## Security

- Deny-by-default access
- No root shell or host-maintenance access in this profile
- Separate process identity
- Session authorization and audit
- Bounded resources and session lifetime
- No direct access to Core secrets
- No independent SSH or device pairing system

## Development status

The public M21 provider adapter and transport-neutral frontend adapter are in
experimental integration. The provider supports independent asynchronous output through
the additive SDK `SessionOutputProvider` contract. Its PTY adapter operates on an
already launched, unprivileged child supplied by the trusted platform runtime;
it does not choose a transport, start a shell or establish OS isolation.

Disposable Linux integration tests exercise a real shell prompt, delayed output,
resize, EOF and cleanup through the generic Agent host. Their authorization
checker is a test adapter, not the production M20 grant connector.

The development frontend now consumes the credential-free
`useApplicationHost().sessions` public host. It has no independent HTTP client,
WebSocket, Core token, SSH login or routing decision. Discovery uses reviewed
binding IDs; no invented `local` target is offered. Connect is enabled only for
an available, authorized provider, and opening uses the exact M20-reviewed
80×24 options. The fitted renderer then synchronizes through the separately
approved resize control, including container changes. Paste input is split into
ordered frames of at most 16 KiB with backpressure; uncertain input/resize is not
replayed and an uncertain resize closes the owned session.

The descriptor now requests `session:console:open` through a saved
`SESSION_DEVICE_ID`, the `org.3mm.terminal.shell` capability and the separately
granted `terminal_use` human permission. `sessions.open` in the manifest is
only a declaration, not executable permission. Existing administrators also
need the human application grant.

Core now has an explicitly enabled local browser connector tested against actual
sealed M20 grants and current logins, bounded streaming and metadata-only audit.
The descriptor's `session_providers` factory uses the same reviewed service wheel.
The first runtime profile is **local, self-provided, isolated and ephemeral**:
the platform resolves its existing local Agent identity and launches each session
under a separate systemd dynamic user/cgroup. It is not the `raspberry` account,
root, host maintenance, an SSH client or a writable copy of Core.

The wheel factory `terminal_provider.runtime:create_provider` starts `/bin/sh -i`
only AFTER the platform's OS boundary has been checked. No Core credentials or
filesystem paths are supplied by the browser. Core data, host homes and Windows
mounts are inaccessible; network access is disabled. Session scratch space and
memory/process/descriptor/lifetime limits are platform-owned. Close and link loss
wait for cgroup cleanup, not merely the shell leader's exit. The legacy prototype
router remains disabled; Node/Fleet/Cloud routing is not activated by this work.

See Core's `docs/M21_LOCAL_TERMINAL_TEST.md` for the next-release acceptance flow.
The optional worker socket and `THREE_MM_LOCAL_SESSIONS=1` are explicit owner
setup, not automatic permissions. Native/UI review, resource Review/Approve/Apply
and the independent human `terminal_use` grant are still required.
The current xterm frontend passes 38 tests (including the Terminal screen),
38 Python tests and TypeScript checking. The actual
Core UI compiler also compiles its source and binds the whole output to the
reviewed build. Synthetic browser previews are not installed-VM acceptance;
renderer support is not proof of transport authority or OS isolation.

## Package preparation

From this checkout, using a development Python environment with Core's test
dependencies and the sibling Core checkout:

```sh
npm ci
npm test -- --maxWorkers=1
npm run typecheck
python scripts/build_package.py --core-root ../3mm --check-only
```

`--check-only` validates without writing release files. The normal versioned
builder prepares `dist/3mm-terminal-1.0.2.zip` and matching descriptor/wheel
snapshots; it does not publish, install or approve them. Never replace the old
1.0.0 ZIP in place. The prepared package and built UI need fresh native/resource
review and the independent human `terminal_use` grant before a session can open.
The earlier unpublished 1.0.1 candidate is preserved; do not replace it in place.
See [CHANGELOG](CHANGELOG.md) for the bounded 1.0.2 scope.
