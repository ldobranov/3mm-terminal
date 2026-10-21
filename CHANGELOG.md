# Changelog

## 1.0.2 — prepared 2026-10-21

- Splits paste input into ordered frames of at most 16 KiB, matching the local
  worker limit without changing Core's authority or payload limits.
- Synchronizes the fitted xterm screen with the PTY after connect and on container
  changes through the separately approved resize control. Controls are ordered;
  uncertain resize closes the owned session without retry/reconnect.
- Adds component tests for real Terminal.vue wiring and cleanup, plus exact
  byte-boundary and streaming UTF-8 paste regressions. Public host declarations
  now expose the adapter types correctly to TypeScript.
- Uses canonical LF source endings per the existing Git attributes. The earlier
  unpublished 1.0.1 candidate is retained, not replaced under the same version.

- Uses the credential-free public M21 browser host and real M20 resource and
  independent human `terminal_use` grants. Administrators have no bypass.
- Declares the exact local device binding, write/resize contract and a
  self-provided factory in the reviewed service wheel. No synthetic local,
  SSH, Node or Cloud fallback is offered.
- Supports independent PTY output, input and resize in Core's isolated temporary
  process profile. Core/homes/Windows mounts/network and root administration
  are unavailable; close/link loss require owned cgroup cleanup.
- Preserves the xterm.js renderer and one universal session contract. Input/open
  are not automatically retried and uncertain outcomes retain their identities.
- Requires Core 0.3.0-beta.55's local session profile. Manifest v2's coarse
  `>=0.3.0` requirement does not distinguish individual Beta releases.
- Local verification: 38 frontend tests, 38 Python tests, TypeScript and M20 package validation
  pass. Actual isolated PTY/M20 revocation and Core UI-compiler checks are
  separate evidence, not installed-VM, physical or full M21 acceptance.
- Publication, installation, optional worker enablement, native/UI review and
  human/service permission approval remain separate explicit operations.
