"""Streaming is optional, independent of input and safe during backend close."""

import asyncio
import unittest
from unittest.mock import AsyncMock

from three_mm_application_sdk.session import SessionOutputProvider, SessionProviderError
from three_mm_protocol.interactive_session import MAX_SESSION_PAYLOAD_BYTES
from terminal_provider.session import CAPABILITY_ID, TerminalSessionProvider

SESSION = "ses_" + "a" * 32


class StreamingProviderTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.outputs = asyncio.Queue()
        self.backend = type("Backend", (), {})()
        self.backend.read_output = AsyncMock(side_effect=self.outputs.get)
        self.backend.receive = AsyncMock(return_value=b"")
        self.backend.resize = AsyncMock()
        self.backend.close = AsyncMock()
        self.provider = TerminalSessionProvider(AsyncMock(return_value=self.backend))
        await self.provider.open(
            {
                "session_id": SESSION,
                "device_id": "dev_" + "a" * 32,
                "capability_id": CAPABILITY_ID,
                "access_mode": "write",
            }
        )

    async def test_output_await_does_not_block_input_and_resize(self):
        self.assertIsInstance(self.provider, SessionOutputProvider)
        pending = asyncio.create_task(self.provider.read_output(SESSION))
        await asyncio.sleep(0)
        self.assertEqual(
            await asyncio.wait_for(self.provider.receive(SESSION, b"a"), 1), b""
        )
        await asyncio.wait_for(
            self.provider.control(
                SESSION, {"action": "resize", "arguments": {"cols": 90, "rows": 30}}
            ),
            1,
        )
        self.outputs.put_nowait(b"prompt> ")
        self.assertEqual(await asyncio.wait_for(pending, 1), b"prompt> ")
        await self.provider.close(SESSION, "test_complete")

    async def test_empty_mutable_or_oversized_output_is_rejected(self):
        for output in (b"", bytearray(b"a"), b"a" * (MAX_SESSION_PAYLOAD_BYTES + 1)):
            self.outputs.put_nowait(output)
            with self.assertRaises(SessionProviderError):
                await self.provider.read_output(SESSION)
        self.outputs.put_nowait(None)
        self.assertIsNone(await self.provider.read_output(SESSION))
        await self.provider.close(SESSION, "test_complete")

    async def test_close_interrupts_blocked_streaming_write_and_cleans_up_once(self):
        writing, closed = asyncio.Event(), asyncio.Event()

        async def blocked_write(data):
            writing.set()
            await closed.wait()
            raise RuntimeError("backend closed")

        async def close(reason):
            closed.set()

        self.backend.receive.side_effect = blocked_write
        self.backend.close.side_effect = close
        writer = asyncio.create_task(self.provider.receive(SESSION, b"a"))
        await asyncio.wait_for(writing.wait(), 1)
        await asyncio.wait_for(
            asyncio.gather(
                self.provider.close(SESSION, "revoked"),
                self.provider.close(SESSION, "revoked"),
            ),
            1,
        )
        with self.assertRaisesRegex(RuntimeError, "backend closed"):
            await writer
        self.backend.close.assert_awaited_once_with("revoked")
        self.assertFalse(self.provider._sessions)


if __name__ == "__main__":
    unittest.main(verbosity=2)
