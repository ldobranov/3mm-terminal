
"""Validate 3mm Terminal package descriptors."""

import hashlib
import json
import unittest
from pathlib import Path

from three_mm_protocol.module_manifest import ModuleManifestV2
from three_mm_protocol.application_extension import ApplicationExtensionV1
from three_mm_protocol.compiled_extension import CompiledUiExtensionV1


ROOT = Path(__file__).resolve().parents[1]


def load_json(name):
    return json.loads(
        (ROOT / name).read_text(encoding="utf-8-sig")
    )


class DescriptorTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.manifest = ModuleManifestV2.model_validate(
            load_json("manifest.json")
        )
        cls.application = ApplicationExtensionV1.model_validate(
            load_json("application-extension.json")
        )
        cls.ui = CompiledUiExtensionV1.model_validate(
            load_json("compiled-ui.json")
        )

    def test_identity_and_version(self):
        self.assertEqual(
            self.manifest.module_id,
            self.application.module_id
        )
        self.assertEqual(
            self.application.module_id,
            self.ui.module_id
        )
        self.assertEqual(
            self.manifest.version,
            self.application.version
        )
        self.assertEqual(
            self.application.version,
            self.ui.version
        )

    def test_routes(self):
        ui_entries = {
            entry.entrypoint_id
            for entry in self.ui.entrypoints
        }

        for route in self.application.routes:
            self.assertIn(route.entrypoint_id, ui_entries)

        for entry in self.ui.entrypoints:
            self.assertTrue(
                (ROOT / entry.source).is_file(),
                f"Missing UI source: {entry.source}"
            )

    def test_wheel_integrity(self):
        artifact = ROOT / self.application.service.artifact

        self.assertTrue(artifact.is_file())

        actual = hashlib.sha256(
            artifact.read_bytes()
        ).hexdigest()

        self.assertEqual(
            actual,
            self.application.service.artifact_sha256
        )


if __name__ == "__main__":
    unittest.main()
