
"""Initial storage migration for 3mm Terminal."""

from three_mm_application_sdk import ApplicationMigration


def get_migrations():
    return [
        ApplicationMigration(
            "0001",
            lambda connection: None,
        ),
    ]
