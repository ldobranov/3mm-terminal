"""Real disposable Linux PTY → public SDK → generic Agent output frames.

The harness alone launches an unprivileged shell in a temporary directory with
a scrubbed environment. It is NOT the production isolated process launcher.
No device/service, Core database, key or installed extension is changed.
"""

import asyncio
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

from agent.session_transport import AgentSessionHost
from three_mm_application_sdk.session import SessionOutputProvider
from three_mm_protocol.interactive_session import (
    decode_session_frame,
    encode_session_frame,
)
from three_mm_runtime.session_output import SessionOutputError
from terminal_provider.pty_manager import PtyBackend
from terminal_provider.session import (
    CAPABILITY_ID,
    PROVIDER_ID,
    TerminalSessionProvider,
)

LINUX_UNPRIVILEGED = sys.platform == "linux" and os.geteuid() != 0


@unittest.skipUnless(LINUX_UNPRIVILEGED, "Real PTY tests need unprivileged Linux")
class PtyStreamTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import tty

        self.directory = tempfile.TemporaryDirectory(prefix="3mm-pty-sdk-test-")
        master, slave = os.openpty()
        tty.setraw(slave)
        bootstrap = (
            "import fcntl,os,termios; "
            "fcntl.ioctl(0,termios.TIOCSCTTY,0); "
            'os.execve("/bin/sh",["sh","-i"],dict(os.environ))'
        )
        try:
            self.process = await asyncio.create_subprocess_exec(
                sys.executable,
                "-c",
                bootstrap,
                stdin=slave,
                stdout=slave,
                stderr=slave,
                start_new_session=True,
                cwd=self.directory.name,
                env={
                    "PATH": "/usr/bin:/bin",
                    "TERM": "dumb",
                    "PS1": "M21> ",
                    "HOME": self.directory.name,
                },
            )
        finally:
            os.close(slave)
        self.backend = PtyBackend(master, self.process)

        async def factory(context):
            return self.backend

        self.provider = TerminalSessionProvider(factory)
        self.host = AgentSessionHost()
        self.host.register_provider(self.provider)
        reply = json.loads(
            await self.host.handle_text(
                json.dumps(
                    {
                        "op": "open",
                        "request": {
                            "request_id": "real_pty_sdk",
                            "provider_id": PROVIDER_ID,
                            "capability_id": CAPABILITY_ID,
                            "device_id": "dev_" + "a" * 32,
                            "access_mode": "write",
                            "options": {"cols": 80, "rows": 24},
                        },
                    }
                )
            )
        )
        self.session_id = reply["acceptance"]["session_id"]
        self.pump = None

    async def asyncTearDown(self):
        if self.pump is not None and not self.pump.done():
            self.pump.cancel()
        if self.pump is not None:
            await asyncio.gather(self.pump, return_exceptions=True)
        await self.backend.close("test_cleanup")
        self.directory.cleanup()

    async def test_prompt_and_delayed_output_without_additional_input_then_resize_and_close(
        self,
    ):
        self.assertIsInstance(self.provider, SessionOutputProvider)
        output = bytearray()
        changed = asyncio.Event()

        async def send(frame):
            header, payload = decode_session_frame(frame)
            self.assertEqual(header.session_id, self.session_id)
            output.extend(payload)
            changed.set()

        async def authorize():
            return None

        async def wait_for(marker):
            while marker not in output:
                changed.clear()
                await changed.wait()

        self.pump = asyncio.create_task(
            self.host.pump_output(self.session_id, send, authorize=authorize)
        )
        await asyncio.wait_for(
            wait_for(b"M21> "), 3
        )  # No keystroke sent to get the prompt.
        frame = encode_session_frame(
            op="data",
            seq=1,
            session_id=self.session_id,
            payload=b"sleep 0.05; printf 'SDK_ASYNC_OK\\n'\n",
            payload_kind="binary",
        )
        response = await self.host.handle_binary(frame)
        self.assertEqual(
            decode_session_frame(response)[1], b""
        )  # No duplicate request/response output.
        await asyncio.wait_for(wait_for(b"SDK_ASYNC_OK\n"), 3)
        resized = json.loads(
            await self.host.handle_text(
                json.dumps(
                    {
                        "op": "control",
                        "control": {
                            "session_id": self.session_id,
                            "control_id": "resize_sdk",
                            "action": "resize",
                            "arguments": {"cols": 100, "rows": 35},
                        },
                    }
                )
            )
        )
        self.assertEqual(resized["op"], "ok")
        self.assertEqual(os.get_terminal_size(self.backend._fd), (100, 35))
        closed = json.loads(
            await self.host.handle_text(
                json.dumps({"op": "close", "session_id": self.session_id})
            )
        )
        self.assertEqual(closed["op"], "ok")
        self.assertIsNotNone(self.process.returncode)
        self.assertTrue(self.pump.cancelled())

    async def test_revocation_while_prompt_waits_terminates_real_process(self):
        observed = asyncio.Event()
        revoked = False

        async def send(frame):
            observed.set()

        async def authorize():
            if revoked:
                raise PermissionError("revoked test binding")

        self.pump = asyncio.create_task(
            self.host.pump_output(
                self.session_id, send, authorize=authorize, check_interval=0.01
            )
        )
        await asyncio.wait_for(observed.wait(), 3)
        revoked = True
        with self.assertRaises(SessionOutputError):
            await asyncio.wait_for(self.pump, 3)
        self.assertIsNotNone(self.process.returncode)
        self.assertFalse(self.host._sessions)

    async def test_blocked_read_does_not_block_input_or_backend_cleanup(self):
        async def drain_prompt():
            while b"M21> " not in (await self.backend.read_output() or b""):
                pass

        await asyncio.wait_for(drain_prompt(), 3)
        waiting = asyncio.create_task(self.backend.read_output())
        await asyncio.sleep(0)
        await asyncio.wait_for(self.backend.close("test_close_pending_read"), 3)
        self.assertIsNone(await asyncio.wait_for(waiting, 1))
        with self.assertRaises(RuntimeError):
            await self.backend.receive(b"")

    async def test_root_or_non_pty_attachment_is_refused_without_taking_ownership(self):
        with patch("terminal_provider.pty_manager.os.geteuid", return_value=0):
            with self.assertRaisesRegex(RuntimeError, "Root"):
                PtyBackend(self.backend._fd, self.process)
        read_fd, write_fd = os.pipe()
        try:
            with self.assertRaises(ValueError):
                PtyBackend(read_fd, self.process)
            os.fstat(read_fd)  # A refused attachment must not close the caller's fd.
        finally:
            os.close(read_fd)
            os.close(write_fd)
        os.fstat(self.backend._fd)
        self.assertIsNone(self.process.returncode)

    async def test_real_shell_exit_reaches_eof_without_polling(self):
        await self.backend.receive(b"exit\n")

        async def until_eof():
            while await self.backend.read_output() is not None:
                pass

        await asyncio.wait_for(until_eof(), 3)
        await asyncio.wait_for(self.process.wait(), 3)
        await self.backend.close("shell_eof")
        with self.assertRaises(OSError):
            os.fstat(self.backend._fd)


if __name__ == "__main__":
    unittest.main(verbosity=2)
