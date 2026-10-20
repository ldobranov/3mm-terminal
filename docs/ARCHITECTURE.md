
# 3mm Terminal Architecture

## Principles

1. Core remains unaware of Terminal-specific behavior.
2. Terminal uses M21 Interactive Session APIs.
3. M20 manages package validation, approval and lifecycle.
4. Fleet and Cloud are optional discovery/transport sources.
5. The same session interface is used for local and remote targets.
6. No custom authentication or device registry.
7. No direct exposure of unrestricted Agent APIs.

Local, Fleet and Cloud are routing contexts of ONE extension and ONE public
M21 session contract, not separate terminal implementations. The extension
selects an authorized target; the platform selects its transport. Local-first
verification must not introduce a separate local API or a Fleet/Cloud-specific
client inside the terminal.

## Components

### Frontend

Responsibilities:
- xterm.js rendering
- Terminal tabs
- Target selection
- User interaction
- Connection state
- Responsive layout
- Theme and localization support

The frontend never executes shell commands directly.

### Application service

Responsibilities:
- Integrate with supported M21 Session SDK
- Request authorized sessions
- Retrieve permitted targets
- Handle application configuration

The service must not bypass the Core Session Gateway.

### Agent provider

Responsibilities:
- Allocate Linux PTY
- Start approved shell process
- Process input/output
- Handle terminal resize
- Enforce local process resource limits
- Terminate and clean up sessions

The provider does not implement its own
device authentication or remote transport.

## Deployment

### Standalone

Browser -> Core -> Local Agent -> Terminal Provider

### Fleet

Browser -> Hub -> Remote Agent -> Terminal Provider

### Cloud

Browser -> Cloud transport -> Authorized Hub
        -> Agent -> Terminal Provider

Cloud never becomes a second command authority
for a Node managed by a Hub.

## Target discovery

The UI uses the M21 capability/session discovery API.

Rules:
- Always offer authorized local terminal access.
- Show remote targets only when available and permitted.
- Never require Fleet or Cloud for local use.
- Never infer access from device presence alone.
- Offline targets cannot start a new session.

## Security

Session authorization is enforced by Core and Agent.

The local Linux process runs under a dedicated,
unprivileged identity.

Privilege elevation is outside the v1.0 scope.

Terminal input/output is not recorded by default.

Audit records include session metadata,
authorization events and lifecycle changes.

## Compatibility

M20:
- Module Manifest v2
- Application Extension v1
- Compiled UI v1

M21:
- Interactive Session contract
- Session Provider SDK
- Session Gateway
- Local and Remote Session Transport

Actual M21 versions and API names must be verified
before integration. No assumed API is implemented.

## Current SDK integration boundary — 2026-10-20

The provider uses the additive SDK 1.3 `SessionOutputProvider.read_output` method
for independent output, with `None` meaning EOF. Existing receive/control/close
and `interactive-session.v1` frames are preserved. Platform-owned output pumps
await each bounded send, require an explicit current-authority checker and stop
on denial, disconnect or failed cleanup. No terminal name is added to Core.

The PTY adapter only owns I/O and cleanup for an already launched child; it
refuses root attachment and does not implement a shell launcher or isolation.
The test harness launches a temporary unprivileged shell with a scrubbed
environment; these tests do NOT prove filesystem/cgroup isolation or M20 rights.
Production registration, exact reviewed resource grants, browser/Agent connector
and isolation must be connected before enabling the terminal. The prototype
WebSocket router is still not a production session-authority boundary.
