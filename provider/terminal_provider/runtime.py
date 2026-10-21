"""PTY factory for the Core-owned isolated_session_v1 worker only.

No Core DB, credentials, transport selection or device routing. The platform
establishes the per-session OS sandbox before importing this reviewed wheel.
The shell is intentionally an ephemeral restricted work area, not an unrestricted
raspberry/root login or permission to administer the host operating system.
"""

import asyncio
import os
import signal
import sys
import tempfile

from terminal_provider.pty_manager import PtyBackend
from terminal_provider.session import TerminalSessionProvider


class _EphemeralPty(PtyBackend):
    async def close(self, reason):
        await super().close(reason)
        self._directory.cleanup()


async def _open(context):
    # Recheck the platform boundary at the factory, not just an environment flag.
    from three_mm_application_sdk.session import require_isolated_session_process

    require_isolated_session_process()
    directory = tempfile.TemporaryDirectory(prefix="terminal-work-")
    master, slave = os.openpty()
    process = None
    try:
        # The child is its own session leader with a controlling terminal.
        # Python bootstrap avoids preexec_fn in the multithreaded Core process;
        # only this isolated worker launches it. No inherited platform env.
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            "import fcntl,os,termios; fcntl.ioctl(0,termios.TIOCSCTTY,0); "
            'os.execve("/bin/sh",["sh","-i"],dict(os.environ))',
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
            cwd=directory.name,
            env={
                "PATH": "/usr/bin:/bin",
                "TERM": "xterm-256color",
                "HOME": directory.name,
                "PS1": "3mm> ",
                "LANG": "C.UTF-8",
            },
        )
        backend = _EphemeralPty(master, process)
        backend._directory = directory
        await backend.resize(context["options"]["cols"], context["options"]["rows"])
        return backend
    except BaseException:
        os.close(master)
        if process is not None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await process.wait()
        directory.cleanup()
        raise
    finally:
        os.close(slave)


def create_provider():
    return TerminalSessionProvider(_open)
