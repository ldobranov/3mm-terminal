
"""Tests for the M21 Terminal Session Provider."""

import asyncio
import unittest
from unittest.mock import AsyncMock

from three_mm_application_sdk.session import (
    SessionProvider,
    SessionProviderError,
    SessionTargetLimits,
    validate_session_provider_metadata,
)

from terminal_provider.session import (
    CAPABILITY_ID,
    CONTRACT_VERSION,
    PROVIDER_ID,
    TerminalSessionProvider,
    get_provider_declaration,
)


SESSION_1 = "ses_" + "1" * 32
SESSION_2 = "ses_" + "2" * 32
SESSION_3 = "ses_" + "3" * 32
DEVICE_ID = "dev_" + "a" * 32


def context(session_id=SESSION_1, **changes):
    value = {
        "session_id": session_id,
        "device_id": DEVICE_ID,
        "capability_id": CAPABILITY_ID,
        "access_mode": "write",
        "options": {"cols": 80, "rows": 24},
    }
    value.update(changes)
    return value


class FakeBackend:
    def __init__(self):
        self.receive = AsyncMock(
            side_effect=lambda data: b"output:" + data
        )
        self.resize = AsyncMock()
        self.close = AsyncMock()


class ProviderTests(unittest.IsolatedAsyncioTestCase):

    def setUp(self):
        self.backend = FakeBackend()
        self.factory = AsyncMock(
            return_value=self.backend
        )
        self.provider = TerminalSessionProvider(
            self.factory
        )

    def test_official_provider_declaration(self):
        declaration = get_provider_declaration()

        self.assertEqual(
            declaration["provider_id"],
            PROVIDER_ID,
        )

        contract = declaration["session_contract"]

        self.assertEqual(
            contract["contract"],
            "interactive-session.v1",
        )
        self.assertEqual(
            contract["contract_version"],
            CONTRACT_VERSION,
        )
        self.assertEqual(
            contract["capability_ids"],
            [CAPABILITY_ID],
        )
        self.assertEqual(
            contract["control_actions"],
            ["resize"],
        )

    async def test_cancelled_close_during_open_still_cleans_up(self):
        started = asyncio.Event()
        release = asyncio.Event()
        backend = FakeBackend()

        async def slow_factory(options):
            started.set()
            await release.wait()
            return backend

        provider = TerminalSessionProvider(
            slow_factory
        )

        opening = asyncio.create_task(
            provider.open(context(SESSION_1))
        )

        await asyncio.wait_for(
            started.wait(), timeout=2
        )

        closing = asyncio.create_task(
            provider.close(
                SESSION_1, "client_disconnected"
            )
        )

        await asyncio.sleep(0)
        self.assertFalse(closing.done())

        closing.cancel()

        try:
            with self.assertRaises(
                asyncio.CancelledError
            ):
                await closing
        finally:
            release.set()

        with self.assertRaises(
            SessionProviderError
        ):
            await asyncio.wait_for(
                opening, timeout=2
            )

        backend.close.assert_awaited_once_with(
            "client_disconnected"
        )

        with self.assertRaises(
            SessionProviderError
        ):
            await provider.receive(
                SESSION_1, b"after-disconnect"
            )

    async def test_slow_session_does_not_block_another(self):
        started = asyncio.Event()
        release = asyncio.Event()

        first = FakeBackend()
        second = FakeBackend()

        async def slow_receive(data):
            started.set()
            await release.wait()
            return b"first:" + data

        first.receive.side_effect = slow_receive

        factory = AsyncMock(
            side_effect=[first, second]
        )

        provider = TerminalSessionProvider(
            factory,
            limits=SessionTargetLimits(
                max_sessions=2
            ),
        )

        await provider.open(context(SESSION_1))
        await provider.open(context(SESSION_2))

        first_task = asyncio.create_task(
            provider.receive(SESSION_1, b"slow")
        )

        try:
            await asyncio.wait_for(
                started.wait(),
                timeout=1,
            )

            # Session 2 must work even while
            # session 1 is waiting for I/O.
            result = await asyncio.wait_for(
                provider.receive(SESSION_2, b"hello"),
                timeout=1,
            )

            self.assertEqual(
                result, b"output:hello"
            )
        finally:
            release.set()
            await first_task


    async def test_close_during_pending_open(self):
        started = asyncio.Event()
        release = asyncio.Event()
        backend = FakeBackend()

        async def slow_factory(options):
            started.set()
            await release.wait()
            return backend

        provider = TerminalSessionProvider(
            slow_factory
        )

        opening = asyncio.create_task(
            provider.open(context(SESSION_1))
        )

        closing = None

        try:
            await asyncio.wait_for(
                started.wait(), timeout=2
            )

            closing = asyncio.create_task(
                provider.close(SESSION_1, "closed")
            )

            await asyncio.sleep(0)

        finally:
            release.set()

        await asyncio.wait_for(
            asyncio.gather(
                opening,
                closing,
                return_exceptions=True,
            ),
            timeout=2,
        )

        # An opening session must not survive
        # a close request issued while it was pending.
        backend.close.assert_awaited_once_with(
            "closed"
        )

        with self.assertRaises(SessionProviderError):
            await provider.receive(
                SESSION_1, b"after-close"
            )

    def test_public_sdk_contract(self):
        self.assertIsInstance(
            self.provider, SessionProvider
        )

        validate_session_provider_metadata(
            provider_id=PROVIDER_ID,
            contract_version=CONTRACT_VERSION,
            capability_ids=(CAPABILITY_ID,),
            control_actions=("resize",),
        )

    async def test_no_backend_before_open(self):
        self.factory.assert_not_awaited()

        with self.assertRaises(SessionProviderError):
            await self.provider.receive(
                SESSION_1, b"hello"
            )

    async def test_open_session(self):
        await self.provider.open(context())

        self.factory.assert_awaited_once()

        arguments = self.factory.await_args.args[0]

        self.assertEqual(
            arguments["session_id"], SESSION_1
        )
        self.assertEqual(
            arguments["options"],
            {"cols": 80, "rows": 24},
        )

    async def test_receive_bytes(self):
        await self.provider.open(context())

        result = await self.provider.receive(
            SESSION_1, b"hello"
        )

        self.assertEqual(
            result, b"output:hello"
        )

        self.backend.receive.assert_awaited_once_with(
            b"hello"
        )

    async def test_resize(self):
        await self.provider.open(context())

        await self.provider.control(
            SESSION_1,
            {
                "action": "resize",
                "arguments": {
                    "cols": 120,
                    "rows": 40,
                },
            },
        )

        self.backend.resize.assert_awaited_once_with(
            120, 40
        )

    async def test_invalid_resize(self):
        await self.provider.open(context())

        for cols, rows in [
            (0, 24),
            (501, 24),
            (80, 201),
            (True, 24),
            ("80", 24),
        ]:
            with self.subTest(cols=cols, rows=rows):
                with self.assertRaises(
                    SessionProviderError
                ):
                    await self.provider.control(
                        SESSION_1,
                        {
                            "action": "resize",
                            "arguments": {
                                "cols": cols,
                                "rows": rows,
                            },
                        },
                    )

        self.backend.resize.assert_not_awaited()

    async def test_reject_unauthorized_context(self):
        invalid = [
            {"access_mode": "read"},
            {"capability_id": "unknown"},
            {"device_id": "invalid"},
            {"options": {"shell": "/bin/bash"}},
        ]

        for changes in invalid:
            with self.subTest(changes=changes):
                with self.assertRaises(
                    SessionProviderError
                ):
                    await self.provider.open(
                        context(**changes)
                    )

        self.factory.assert_not_awaited()

    async def test_reject_duplicate_session(self):
        await self.provider.open(context())

        with self.assertRaises(
            SessionProviderError
        ):
            await self.provider.open(context())

        self.assertEqual(
            self.factory.await_count, 1
        )

    async def test_session_limit(self):
        await self.provider.open(context())

        with self.assertRaises(
            SessionProviderError
        ):
            await self.provider.open(
                context(SESSION_2)
            )

        self.assertEqual(
            self.factory.await_count, 1
        )

    async def test_independent_sessions(self):
        first = FakeBackend()
        second = FakeBackend()

        factory = AsyncMock(
            side_effect=[first, second]
        )

        provider = TerminalSessionProvider(
            factory,
            limits=SessionTargetLimits(
                max_sessions=2
            ),
        )

        await provider.open(context(SESSION_1))
        await provider.open(context(SESSION_2))

        await provider.close(
            SESSION_1, "closed"
        )

        first.close.assert_awaited_once_with(
            "closed"
        )
        second.close.assert_not_awaited()

        result = await provider.receive(
            SESSION_2, b"still-active"
        )

        self.assertEqual(
            result, b"output:still-active"
        )

    async def test_close_and_reuse_capacity(self):
        await self.provider.open(context())

        await self.provider.close(
            SESSION_1, "closed"
        )

        self.backend.close.assert_awaited_once_with(
            "closed"
        )

        await self.provider.open(
            context(SESSION_2)
        )

        self.assertEqual(
            self.factory.await_count, 2
        )

    async def test_failed_close_can_retry(self):
        self.backend.close.side_effect = [
            RuntimeError("Cleanup failed"),
            None,
        ]

        await self.provider.open(context())

        with self.assertRaises(RuntimeError):
            await self.provider.close(
                SESSION_1, "closed"
            )

        with self.assertRaises(
            SessionProviderError
        ):
            await self.provider.open(
                context(SESSION_2)
            )

        await self.provider.close(
            SESSION_1, "closed"
        )

        await self.provider.open(
            context(SESSION_2)
        )

        self.assertEqual(
            self.backend.close.await_count, 2
        )

    async def test_buffer_limits(self):
        backend = FakeBackend()

        provider = TerminalSessionProvider(
            AsyncMock(return_value=backend),
            limits=SessionTargetLimits(
                max_buffer_bytes=1024
            ),
        )

        await provider.open(context())

        with self.assertRaises(
            SessionProviderError
        ):
            await provider.receive(
                SESSION_1, b"x" * 1025
            )

        backend.receive.assert_not_awaited()

        backend.receive.return_value = b"x" * 1025
        backend.receive.side_effect = None

        with self.assertRaises(
            SessionProviderError
        ):
            await provider.receive(
                SESSION_1, b"hello"
            )

    async def test_concurrent_duplicate_open(self):
        results = await asyncio.gather(
            self.provider.open(context()),
            self.provider.open(context()),
            return_exceptions=True,
        )

        self.assertEqual(
            self.factory.await_count, 1
        )

        self.assertEqual(
            sum(
                isinstance(
                    item, SessionProviderError
                )
                for item in results
            ),
            1,
        )


    async def test_concurrent_close_runs_cleanup_once(self):
        started = asyncio.Event()
        release = asyncio.Event()

        backend = FakeBackend()

        async def slow_close(reason):
            started.set()
            await release.wait()

        backend.close.side_effect = slow_close

        provider = TerminalSessionProvider(
            AsyncMock(return_value=backend)
        )

        await provider.open(context())

        first = asyncio.create_task(
            provider.close(SESSION_1, "closed")
        )

        await asyncio.wait_for(
            started.wait(), timeout=2
        )

        second = asyncio.create_task(
            provider.close(SESSION_1, "closed")
        )

        try:
            backend.close.assert_awaited_once()
        finally:
            release.set()

        await asyncio.wait_for(
            asyncio.gather(first, second),
            timeout=2,
        )

        backend.close.assert_awaited_once_with(
            "closed"
        )

    async def test_cancelled_open_releases_capacity(self):
        started = asyncio.Event()
        release = asyncio.Event()

        async def factory(options):
            if options["session_id"] == SESSION_1:
                started.set()
                await release.wait()

            return FakeBackend()

        provider = TerminalSessionProvider(factory)

        opening = asyncio.create_task(
            provider.open(context(SESSION_1))
        )

        await asyncio.wait_for(
            started.wait(), timeout=2
        )

        opening.cancel()

        with self.assertRaises(asyncio.CancelledError):
            await opening

        # Cancellation must release the reservation.
        await asyncio.wait_for(
            provider.open(context(SESSION_2)),
            timeout=2,
        )

        await provider.close(SESSION_2, "closed")

    async def test_close_waits_for_running_io(self):
        started = asyncio.Event()
        release = asyncio.Event()

        backend = FakeBackend()

        async def slow_receive(data):
            started.set()
            await release.wait()
            return b"output:" + data

        backend.receive.side_effect = slow_receive

        provider = TerminalSessionProvider(
            AsyncMock(return_value=backend)
        )

        await provider.open(context())

        receiving = asyncio.create_task(
            provider.receive(SESSION_1, b"hello")
        )

        await asyncio.wait_for(
            started.wait(), timeout=2
        )

        closing = asyncio.create_task(
            provider.close(SESSION_1, "closed")
        )

        # Give close() a chance to reach the lock.
        await asyncio.sleep(0)

        # Cleanup must wait for the running operation.
        backend.close.assert_not_awaited()

        release.set()

        result = await asyncio.wait_for(
            receiving, timeout=2
        )

        await asyncio.wait_for(
            closing, timeout=2
        )

        self.assertEqual(result, b"output:hello")
        backend.close.assert_awaited_once_with(
            "closed"
        )

        with self.assertRaises(SessionProviderError):
            await provider.receive(
                SESSION_1, b"after-close"
            )

if __name__ == "__main__":
    unittest.main()
