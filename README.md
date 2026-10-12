
# 3mm Terminal

Interactive Linux terminal extension for the 3mm platform.

## Overview

3mm Terminal provides browser-based interactive shell sessions
through the 3mm Interactive Session Platform (M21).

The extension is independent of Fleet and Cloud.

## Operating modes

### Local
Access the Linux host running the local 3mm installation.

### Fleet
Access authorized Linux nodes managed by the local Hub.

### Cloud
Access authorized remote installations through an approved
Cloud session transport.

Remote targets are displayed only when discovery confirms
an available, compatible and authorized terminal provider.

## Components

- Frontend: Vue 3 and xterm.js
- Application service: Session management client
- Agent provider: Linux PTY and shell process lifecycle
- Platform integration: M20 package contracts and M21 Session SDK

## Requirements

- Compatible 3mm Core
- M20 Module Manifest v2
- M21 Interactive Session Platform
- Linux host with an approved terminal provider

Fleet and Cloud are optional.

## Security

- Deny-by-default access
- No root shell by default
- Separate process identity
- Session authorization and audit
- Bounded resources and session lifetime
- No direct access to Core secrets
- No independent SSH or device pairing system

## Development status

Planning and initial project structure.

No production terminal functionality is implemented yet.
