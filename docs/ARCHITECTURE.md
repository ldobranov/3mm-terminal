
# 3mm Terminal Architecture

## Principles

1. Core remains unaware of Terminal-specific behavior.
2. Terminal uses M21 Interactive Session APIs.
3. M20 manages package validation, approval and lifecycle.
4. Fleet and Cloud are optional discovery/transport sources.
5. The same session interface is used for local and remote targets.
6. No custom authentication or device registry.
7. No direct exposure of unrestricted Agent APIs.

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
