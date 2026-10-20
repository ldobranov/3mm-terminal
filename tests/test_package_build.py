
"""Verify the generated M20/M21 package before publication."""

import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from scripts.build_package import (
    ROOT,
    prepare_package,
    read_version,
)


DESCRIPTORS = (
    "manifest.json",
    "application-extension.json",
    "compiled-ui.json",
)


class PackageBuildTests(unittest.TestCase):

    def test_generated_package_contract(self):
        version = read_version()

        originals = {
            name: (ROOT / name).read_bytes()
            for name in DESCRIPTORS
        }

        with tempfile.TemporaryDirectory() as directory:
            (
                package,
                _files,
                wheel_path,
                wheel_sha,
                *_,
            ) = prepare_package(
                version,
                Path(directory),
            )

        # Preparation must not rewrite release descriptors.
        for name, original in originals.items():
            self.assertEqual(
                (ROOT / name).read_bytes(),
                original,
            )

        with zipfile.ZipFile(io.BytesIO(package)) as archive:
            descriptors = [
                json.loads(archive.read(name))
                for name in DESCRIPTORS
            ]

            manifest, application, ui = descriptors

            self.assertTrue(
                all(
                    item["version"] == version
                    for item in descriptors
                )
            )

            self.assertEqual(
                manifest["module_id"],
                application["module_id"],
            )
            self.assertEqual(
                application["module_id"],
                ui["module_id"],
            )

            self.assertEqual(
                application["service"]["sdk_version"],
                "1.3",
            )

            self.assertEqual(
                application["service"]["artifact"],
                wheel_path,
            )

            wheel_bytes = archive.read(wheel_path)

            self.assertEqual(
                hashlib.sha256(wheel_bytes).hexdigest(),
                wheel_sha,
            )
            self.assertEqual(
                application["service"]["artifact_sha256"],
                wheel_sha,
            )

        with zipfile.ZipFile(io.BytesIO(wheel_bytes)) as wheel:
            names = set(wheel.namelist())

            self.assertIn(
                "terminal/service.py",
                names,
            )
            self.assertIn(
                "terminal_provider/session.py",
                names,
            )


if __name__ == "__main__":
    unittest.main()
