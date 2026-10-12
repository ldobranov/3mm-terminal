
"""3mm Terminal application service.

M20 application lifecycle entrypoint.

Interactive sessions will be implemented through the
official M21 Session SDK when available.
"""

from __future__ import annotations

from three_mm_application_sdk import (
    ApplicationContext,
    OperationContext,
)


class TerminalService:
    """Application-level terminal integration."""

    def __init__(self, application: ApplicationContext) -> None:
        self.application = application

    def handle(
        self,
        operation_id: str,
        payload: dict,
        context: OperationContext,
    ) -> dict:
        """Handle an authorized M20 application operation."""

        if operation_id == "health":
            return self._health()

        raise ValueError(
            f"Unsupported terminal operation: {operation_id}"
        )

    def _health(self) -> dict:
        """Report application service readiness."""

        return {
            "status": "ready"
        }


def create_service(
    application: ApplicationContext,
) -> TerminalService:
    """Create the M20 application service."""

    return TerminalService(application)
