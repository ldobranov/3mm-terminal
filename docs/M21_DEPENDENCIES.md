
# M21 Dependencies

3mm Terminal consumes the M21 Interactive Session Platform.

This document describes required capabilities, not
an assertion that these APIs are already implemented.

## Required for Local v1.0

- Create an authorized interactive session
- Attach a browser client to a session
- Send and receive binary data
- Send structured control messages
- Resize terminal through provider-specific controls
- Close and terminate sessions
- Detect disconnects
- Enforce idle/session timeouts
- Discover local session providers
- Enforce user permissions
- Provide session audit events

## Required for Fleet

- Discover authorized remote session providers
- Route sessions through the existing Hub/Agent identity
- Transport bidirectional streams
- Handle remote disconnect/reconnect
- Enforce device-specific authorization
- Revoke active remote access

## Required for Cloud

- Approved cross-installation delegation
- Authorized remote target discovery
- Outbound authenticated transport
- Tenant isolation
- Remote session revocation
- Secure stream relay

## Required security guarantees

- Session identity cannot be forged
- Session ID alone never grants access
- Permissions are checked throughout the lifecycle
- Revocation terminates active access
- Bounded buffers and backpressure
- No unrestricted command execution through Core
- No implicit root privileges
- No Core secrets exposed to providers
- Safe cleanup on crash, rollback and service shutdown

## Integration policy

The extension must not implement temporary
Core API replacements or security bypasses.

M21 contract names and versions are pinned
only after their official acceptance.

Missing universal capabilities are reported
to the M21 development track.
