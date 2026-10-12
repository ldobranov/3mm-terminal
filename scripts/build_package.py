
"""Build and validate the 3mm Terminal installation package."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

CORE_ROOT = Path.home() / "Desktop" / "3mm"
sys.path.insert(0, str(CORE_ROOT))

from backend.services.module_packages import validate_module_package


def build_package() -> bytes:
    descriptor = json.loads(
        (ROOT / "application-extension.json").read_text(encoding="utf-8-sig")
    )

    artifact = descriptor["service"]["artifact"]

    files = [
        "manifest.json",
        "application-extension.json",
        "compiled-ui.json",
        artifact,
    ]

    files.extend(
        path.relative_to(ROOT).as_posix()
        for path in sorted((ROOT / "source" / "frontend").rglob("*"))
        if path.is_file()
    )

    for name in (
        "manifest.json",
        "application-extension.json",
        "compiled-ui.json",
    ):
        if (ROOT / name).read_bytes().startswith(b"\xef\xbb\xbf"):
            raise ValueError(
                f"{name} contains UTF-8 BOM. Save as UTF-8 without BOM."
            )

    output = io.BytesIO()

    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in files:
            path = ROOT / name

            if not path.is_file():
                raise FileNotFoundError(name)

            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED

            archive.writestr(info, path.read_bytes())

    return output.getvalue()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "dist" / "3mm-terminal-1.0.0.zip",
    )
    args = parser.parse_args()

    package = build_package()

    validated = validate_module_package(
        package,
        architecture="any",
        protocol_version="1.0",
        core_version="0.1.0",
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(package)

    print("M20 package validation: OK")
    print("Module:", validated.manifest.module_id)
    print("Version:", validated.manifest.version)
    print("Size:", len(package), "bytes")
    print("SHA-256:", hashlib.sha256(package).hexdigest())
    print("Package:", args.output)


if __name__ == "__main__":
    main()
