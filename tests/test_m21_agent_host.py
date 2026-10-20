
"""Integration tests against the actual M21 AgentSessionHost."""

import json
import unittest
from unittest.mock import AsyncMock

from agent.session_transport import (
    AgentSessionHost,
    AgentSessionTransportError,
)

from three_mm_protocol.interactive_session import (
    decode_session_frame,
    encode_session_frame,
)

from terminal_provider.session import (
    CAPABILITY_ID,
    PROVIDER_ID,
    TerminalSessionProvider,
)


DEVICE_ID = "dev_" + "a" * 32


class FakeBackend:
    def __init__(self):
        self.receive = AsyncMock(
            side_effect=lambda data: b"reply:" + data
        )
        self.resize = AsyncMock()
        self.close = AsyncMock()


class AgentIntegrationTests(unittest.IsolatedAsyncioTestCase):

    def setUp(self):
        self.backend = FakeBackend()
        self.factory = AsyncMock(
            return_value=self.backend
        )

        self.provider = TerminalSessionProvider(
            self.factory
        )

        self.host = AgentSessionHost()
        self.host.register_provider(self.provider)

    def open_request(self):
        return {
            "op": "open",
            "request": {
                "request_id": "terminal_test_1",
                "provider_id": PROVIDER_ID,
                "capability_id": CAPABILITY_ID,
                "device_id": DEVICE_ID,
                "access_mode": "write",
                "options": {
                    "cols": 80,
                    "rows": 24,
                },
            },
        }

    async def open_session(self):
        response = json.loads(
            await self.host.handle_text(
                json.dumps(self.open_request())
            )
        )

        self.assertEqual(response["op"], "opened")
        return response["acceptance"]["session_id"]

    def test_provider_discovery(self):
        hello = json.loads(
            self.host.hello("Test Agent")
        )

        self.assertEqual(hello["op"], "hello")
        self.assertIn(
            CAPABILITY_ID,
            hello["capability_ids"],
        )

    async def test_binary_session_data(self):
        session_id = await self.open_session()

        outbound = encode_session_frame(
            op="data",
            seq=1,
            session_id=session_id,
            payload=b"hello",
            payload_kind="binary",
        )

        inbound = await self.host.handle_binary(
            outbound
        )

        header, payload = decode_session_frame(
            inbound
        )

        self.assertEqual(header.op, "data")
        self.assertEqual(header.seq, 1)
        self.assertEqual(
            header.session_id, session_id
        )
        self.assertEqual(payload, b"reply:hello")

    async def test_resize_through_agent(self):
        session_id = await self.open_session()

        response = json.loads(
            await self.host.handle_text(
                json.dumps({
                    "op": "control",
                    "control": {
                        "session_id": session_id,
                        "control_id": "resize_1",
                        "action": "resize",
                        "arguments": {
                            "cols": 120,
                            "rows": 40,
                        },
                    },
                })
            )
        )

        self.assertEqual(response["op"], "ok")

        self.backend.resize.assert_awaited_once_with(
            120, 40
        )

    async def test_close_prevents_further_data(self):
        session_id = await self.open_session()

        response = json.loads(
            await self.host.handle_text(
                json.dumps({
                    "op": "close",
                    "session_id": session_id,
                })
            )
        )

        self.assertEqual(response["op"], "ok")
        self.backend.close.assert_awaited_once()

        frame = encode_session_frame(
            op="data",
            seq=2,
            session_id=session_id,
            payload=b"after-close",
            payload_kind="binary",
        )

        with self.assertRaises(
            AgentSessionTransportError
        ):
            await self.host.handle_binary(frame)

    async def test_unknown_provider_rejected(self):
        host = AgentSessionHost()

        response = json.loads(
            await host.handle_text(
                json.dumps(self.open_request())
            )
        )

        self.assertEqual(response["op"], "error")
        self.factory.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
