
"""M21 Terminal Session Provider.

Implements the public M21 SessionProvider SDK contract.

A trusted runtime must explicitly supply the backend factory.
This module does not launch processes, bind sockets,
authenticate users or grant terminal permissions.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Mapping, Protocol

from three_mm_application_sdk.session import (
    SessionProviderError,
    SessionTargetLimits,
    validate_session_provider_metadata,
)
from three_mm_protocol.interactive_session import (
    DEVICE_ID_PATTERN,
    MAX_SESSION_PAYLOAD_BYTES,
    SESSION_ID_PATTERN,
    provider_declaration,
)


PROVIDER_ID = "org.3mm.terminal"
CAPABILITY_ID = "org.3mm.terminal.shell"
CONTRACT_VERSION = "1.0"

MAX_COLS = 500
MAX_ROWS = 200


class TerminalBackend(Protocol):
    """Backend owned by one terminal session."""

    async def receive(self, data: bytes) -> bytes:
        ...

    async def read_output(self) -> bytes | None:
        ...

    async def resize(
        self,
        cols: int,
        rows: int,
    ) -> None:
        ...

    async def close(self, reason: str) -> None:
        ...


BackendFactory = Callable[
    [Mapping[str, object]],
    Awaitable[TerminalBackend],
]


@dataclass(slots=True)
class _OwnedSession:
    """Independent lifecycle and I/O synchronization."""

    backend: TerminalBackend
    lock: asyncio.Lock = field(
        default_factory=asyncio.Lock,
    )
    read_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    cleanup_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    closing: bool = False


@dataclass(slots=True)
class _PendingOpen:
    """Tracks creation and deferred close requests."""

    done: asyncio.Event = field(
        default_factory=asyncio.Event,
    )
    close_reason: str | None = None


def _terminal_size(
    cols: object,
    rows: object,
) -> tuple[int, int]:
    if (
        type(cols) is not int
        or type(rows) is not int
        or not 1 <= cols <= MAX_COLS
        or not 1 <= rows <= MAX_ROWS
    ):
        raise SessionProviderError(
            "Terminal dimensions are invalid"
        )

    return cols, rows


class TerminalSessionProvider:
    """M21 adapter for independently owned PTY backends."""

    provider_id = PROVIDER_ID
    contract_version = CONTRACT_VERSION
    capability_ids = (CAPABILITY_ID,)
    control_actions = ("resize",)

    def __init__(
        self,
        backend_factory: BackendFactory,
        *,
        limits: SessionTargetLimits | None = None,
    ) -> None:
        if not callable(backend_factory):
            raise TypeError(
                "An explicit backend factory is required"
            )

        validate_session_provider_metadata(
            provider_id=self.provider_id,
            contract_version=self.contract_version,
            capability_ids=self.capability_ids,
            control_actions=self.control_actions,
        )

        self._factory = backend_factory
        self._limits = limits or SessionTargetLimits()

        self._sessions: dict[
            str, _OwnedSession
        ] = {}

        # Reservations prevent concurrent opens from
        # exceeding capacity while factories are awaiting.
        self._opening: dict[str, _PendingOpen] = {}

        # Never hold this lock during backend I/O.
        self._registry_lock = asyncio.Lock()

    def _session(
        self,
        session_id: str,
    ) -> _OwnedSession:
        if not isinstance(session_id, str):
            raise SessionProviderError(
                "Terminal session ID is invalid"
            )

        session = self._sessions.get(session_id)

        if session is None:
            raise SessionProviderError(
                "Terminal session is unavailable"
            )

        return session

    async def open(
        self,
        context: Mapping[str, object],
    ) -> None:
        if not isinstance(context, Mapping):
            raise SessionProviderError(
                "Session context is invalid"
            )

        session_id = context.get("session_id")
        device_id = context.get("device_id")
        capability_id = context.get("capability_id")
        access_mode = context.get("access_mode")
        options = context.get("options", {})

        if (
            not isinstance(session_id, str)
            or re.fullmatch(
                SESSION_ID_PATTERN, session_id
            ) is None
            or not isinstance(device_id, str)
            or re.fullmatch(
                DEVICE_ID_PATTERN, device_id
            ) is None
            or capability_id != CAPABILITY_ID
            or access_mode != "write"
            or not isinstance(options, Mapping)
            or set(options) - {"cols", "rows"}
        ):
            raise SessionProviderError(
                "Terminal session context is unsupported"
            )

        cols, rows = _terminal_size(
            options.get("cols", 80),
            options.get("rows", 24),
        )

        async with self._registry_lock:
            if (
                session_id in self._sessions
                or session_id in self._opening
            ):
                raise SessionProviderError(
                    "Terminal session already exists"
                )

            occupied = (
                len(self._sessions)
                + len(self._opening)
            )

            if occupied >= self._limits.max_sessions:
                raise SessionProviderError(
                    "Terminal session limit reached"
                )

            pending = _PendingOpen()
            self._opening[session_id] = pending

        backend: TerminalBackend | None = None

        try:
            # No global lock during backend creation.
            backend = await self._factory({
                "session_id": session_id,
                "device_id": device_id,
                "capability_id": capability_id,
                "access_mode": access_mode,
                "options": {
                    "cols": cols,
                    "rows": rows,
                },
            })

            if backend is None:
                raise SessionProviderError(
                    "Terminal backend is unavailable"
                )

            async with self._registry_lock:
                self._sessions[session_id] = (
                    _OwnedSession(backend=backend)
                )

        except BaseException:
            # If creation succeeded but registration did not,
            # prevent an orphaned backend where possible.
            if (
                backend is not None
                and session_id not in self._sessions
            ):
                try:
                    await backend.close("open_failed")
                except Exception:
                    pass
            raise

        finally:
            self._opening.pop(session_id, None)
            pending.done.set()

        # A close request received during backend creation
        # must not leave a live session behind.
        if pending.close_reason is not None:
            await self.close(
                session_id,
                pending.close_reason,
            )
            raise SessionProviderError(
                "Terminal session was closed during opening"
            )

    async def receive(
        self,
        session_id: str,
        data: bytes,
    ) -> bytes:
        if type(data) is not bytes:
            raise SessionProviderError(
                "Terminal input must be bytes"
            )

        limit = min(
            self._limits.max_buffer_bytes,
            MAX_SESSION_PAYLOAD_BYTES,
        )

        if len(data) > limit:
            raise SessionProviderError(
                "Terminal input exceeds session limit"
            )

        session = self._session(session_id)

        # Only this session is locked during I/O.
        async with session.lock:
            if (
                session.closing
                or self._sessions.get(session_id)
                is not session
            ):
                raise SessionProviderError(
                    "Terminal session is closing"
                )

            result = await session.backend.receive(data)

            if (
                type(result) is not bytes
                or len(result) > limit
            ):
                raise SessionProviderError(
                    "Terminal output exceeds session limit"
                )

            return result

    async def read_output(self, session_id: str) -> bytes | None:
        """Await independent output without blocking input/resize/close."""
        session = self._session(session_id)
        read = getattr(session.backend, 'read_output', None)
        if not callable(read):
            raise SessionProviderError('Terminal backend does not support streaming output')
        async with session.read_lock:
            if session.closing or self._sessions.get(session_id) is not session:
                raise SessionProviderError('Terminal session is closing')
            result = await read()
            if session.closing or self._sessions.get(session_id) is not session:
                return None
            if result is not None and (
                type(result) is not bytes or not 1 <= len(result) <= min(
                    self._limits.max_buffer_bytes, MAX_SESSION_PAYLOAD_BYTES)
            ):
                raise SessionProviderError('Terminal output exceeds session limit')
            return result

    async def control(
        self,
        session_id: str,
        message: Mapping[str, object],
    ) -> None:
        if not isinstance(message, Mapping):
            raise SessionProviderError(
                "Terminal control is invalid"
            )

        if (
            message.get("action") != "resize"
            or set(message) != {
                "action",
                "arguments",
            }
        ):
            raise SessionProviderError(
                "Unsupported terminal control"
            )

        arguments = message.get("arguments")

        if (
            not isinstance(arguments, Mapping)
            or set(arguments) != {
                "cols",
                "rows",
            }
        ):
            raise SessionProviderError(
                "Terminal resize arguments are invalid"
            )

        cols, rows = _terminal_size(
            arguments["cols"],
            arguments["rows"],
        )

        session = self._session(session_id)

        async with session.lock:
            if (
                session.closing
                or self._sessions.get(session_id)
                is not session
            ):
                raise SessionProviderError(
                    "Terminal session is closing"
                )

            await session.backend.resize(cols, rows)

    async def close(
        self,
        session_id: str,
        reason: str,
    ) -> None:
        pending = self._opening.get(session_id)

        if pending is not None:
            # Record the first close request. Even if this
            # close task is cancelled, open() will see it.
            if pending.close_reason is None:
                pending.close_reason = reason

            # Wait until backend creation has settled.
            # Do not hold the registry lock while waiting.
            await pending.done.wait()

        session = self._sessions.get(session_id)

        if session is None:
            return

        # Refuse new I/O immediately. Existing operations
        # may complete before backend cleanup begins.
        session.closing = True

        # Serialize cleanup independently of read/write. A streaming backend
        # must be able to interrupt blocked PTY I/O when authority is revoked.
        async with session.cleanup_lock:
            # Another close may have completed already.
            if self._sessions.get(session_id) is not session:
                return
            streaming = callable(getattr(session.backend, 'read_output', None))
            if streaming:
                await session.backend.close(reason)
            async with session.lock:
                # Preserve legacy request/response cleanup ordering. On failure
                # retain ownership and capacity for explicit cleanup review.
                if not streaming:
                    await session.backend.close(reason)
                del self._sessions[session_id]

def get_provider_declaration() -> dict[str, object]:
    """Describe this provider using the official M21 contract.

    This is metadata, not registration or authorization.
    """
    return provider_declaration(
        provider_id=TerminalSessionProvider.provider_id,
        contract_version=TerminalSessionProvider.contract_version,
        capability_ids=TerminalSessionProvider.capability_ids,
        control_actions=TerminalSessionProvider.control_actions,
    )
