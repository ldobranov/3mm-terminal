"""Async PTY I/O for a process ALREADY launched by the trusted runtime.

This adapter does not choose a device/transport, start a shell, grant rights or
establish isolation. The runtime must provision the restricted identity,
filesystem/cgroup policy and process session BEFORE handing over this PTY.
Construction requires an owned, unprivileged child in its own process session.
On construction failure the caller retains ownership of the descriptor/process.
"""

from __future__ import annotations

import asyncio
import errno
import os
import signal

from three_mm_protocol.interactive_session import MAX_SESSION_PAYLOAD_BYTES


class PtyBackend:
    """One owned master descriptor; independent input/output without polling."""

    def __init__(self, master_fd: int, process: asyncio.subprocess.Process) -> None:
        if os.name != "posix" or not hasattr(os, "geteuid"):
            raise RuntimeError("PTY sessions require Linux")
        if os.geteuid() == 0:
            raise RuntimeError("Root terminal sessions are not supported")
        if type(master_fd) is not int or master_fd < 0 or not os.isatty(master_fd):
            raise ValueError("An owned PTY descriptor is required")
        if (
            not isinstance(process, asyncio.subprocess.Process)
            or process.returncode is not None
            or process.pid <= 1
            or os.getpgid(process.pid) != process.pid
            or os.getsid(process.pid) != process.pid
            or os.stat(f"/proc/{process.pid}").st_uid != os.geteuid()
        ):
            raise ValueError("An owned child in a separate process session is required")
        os.set_blocking(master_fd, False)
        os.set_inheritable(master_fd, False)
        self._fd = master_fd
        self._process = process
        self._closed = False
        self._close_task: asyncio.Task | None = None
        self._reading = asyncio.Lock()
        self._writing = asyncio.Lock()
        self._waiters: set[asyncio.Future] = set()

    async def _ready(self, *, reading: bool) -> None:
        loop = asyncio.get_running_loop()
        ready = loop.create_future()
        self._waiters.add(ready)

        def wake() -> None:
            if not ready.done():
                ready.set_result(None)

        add = loop.add_reader if reading else loop.add_writer
        remove = loop.remove_reader if reading else loop.remove_writer
        try:
            add(self._fd, wake)
            await ready
        finally:
            if not self._closed:
                remove(self._fd)
            self._waiters.discard(ready)

    async def receive(self, data: bytes) -> bytes:
        if type(data) is not bytes or len(data) > MAX_SESSION_PAYLOAD_BYTES:
            raise ValueError("PTY input exceeds session bounds")
        async with self._writing:
            if self._closed:
                raise RuntimeError("PTY session is closed")
            pending = memoryview(data)
            while pending:
                if self._closed:
                    raise RuntimeError("PTY session is closed")
                try:
                    written = os.write(self._fd, pending)
                except BlockingIOError:
                    await self._ready(reading=False)
                    continue
                if written <= 0:
                    raise RuntimeError("PTY input was not written")
                pending = pending[written:]
        # All output is consumed independently by read_output, never duplicated.
        return b""

    async def read_output(self) -> bytes | None:
        async with self._reading:
            while not self._closed:
                try:
                    chunk = os.read(self._fd, MAX_SESSION_PAYLOAD_BYTES)
                    return chunk or None
                except BlockingIOError:
                    await self._ready(reading=True)
                except OSError as exc:
                    # Linux PTY masters report EIO when the final slave closes.
                    if exc.errno == errno.EIO:
                        return None
                    raise
            return None

    async def resize(self, cols: int, rows: int) -> None:
        import fcntl
        import struct
        import termios

        if (
            type(cols) is not int
            or type(rows) is not int
            or not 1 <= cols <= 500
            or not 1 <= rows <= 200
        ):
            raise ValueError("Terminal dimensions are invalid")
        if self._closed:
            raise RuntimeError("PTY session is closed")
        fcntl.ioctl(self._fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    async def close(self, reason: str) -> None:
        if self._close_task is None:
            self._closed = True
            self._close_task = asyncio.create_task(self._close())
        # One caller's cancellation must not abandon process cleanup.
        await asyncio.shield(self._close_task)

    async def _close(self) -> None:
        loop = asyncio.get_running_loop()
        loop.remove_reader(self._fd)
        loop.remove_writer(self._fd)
        for ready in tuple(self._waiters):
            if not ready.done():
                ready.set_result(None)
        os.close(self._fd)
        # The constructor verified this child is its own session/group leader.
        # Kill the owned group, not the platform's group or an arbitrary PID.
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(self._process.pid, sig)
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(self._process.wait(), timeout=2)
                return
            except asyncio.TimeoutError:
                continue
        raise RuntimeError("PTY process cleanup is unconfirmed")
