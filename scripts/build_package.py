
"""Build and validate a versioned 3mm Terminal package.

VERSION is the single source of truth for the release version.
No Git operations, installation or Core modifications are performed.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DESCRIPTORS = (
    "manifest.json",
    "application-extension.json",
    "compiled-ui.json",
)
WHEEL_DISTRIBUTION = "three_mm_terminal"


def read_version() -> str:
    version = (ROOT / "VERSION").read_text(
        encoding="utf-8-sig"
    ).strip()

    # Stable SemVer only. Prerelease versions need explicit
    # PEP 440 / SemVer normalization rules.
    pattern = r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"

    if not re.fullmatch(pattern, version):
        raise ValueError(
            f"Unsupported VERSION: {version!r}. "
            "Expected MAJOR.MINOR.PATCH."
        )

    return version


def load_descriptor(name: str) -> dict:
    raw = (ROOT / name).read_bytes()

    if raw.startswith(b"\xef\xbb\xbf"):
        raise ValueError(
            f"{name} contains UTF-8 BOM. "
            "Save as UTF-8 without BOM."
        )

    return json.loads(raw.decode("utf-8"))


def json_bytes(value: dict) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            indent=2,
        ) + "\n"
    ).encode("utf-8")


def build_wheel(workdir: Path, version: str) -> tuple[str, bytes]:
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "wheel",
            ".",
            "--no-deps",
            "--wheel-dir",
            str(workdir),
        ],
        cwd=ROOT,
        check=True,
        env={
            **os.environ,
            "SOURCE_DATE_EPOCH": "1767225600",
        },
    )

    wheels = list(workdir.glob("*.whl"))

    if len(wheels) != 1:
        raise RuntimeError(
            f"Expected exactly one wheel, got {len(wheels)}"
        )

    wheel = wheels[0]
    expected = (
        f"{WHEEL_DISTRIBUTION}-{version}"
        "-py3-none-any.whl"
    )

    if wheel.name != expected:
        raise RuntimeError(
            f"Unexpected wheel: {wheel.name}; "
            f"expected {expected}"
        )

    with zipfile.ZipFile(wheel) as archive:
        if archive.testzip() is not None:
            raise RuntimeError("Generated wheel is corrupt")

        required_files = {
            "terminal/service.py",
            "terminal_provider/__init__.py",
            "terminal_provider/session.py",
        }

        missing = required_files - set(archive.namelist())

        if missing:
            raise RuntimeError(
                "Generated wheel is missing required files: "
                + ", ".join(sorted(missing))
            )

    return wheel.name, wheel.read_bytes()


def assemble_package(files: dict[str, bytes]) -> bytes:
    output = io.BytesIO()

    with zipfile.ZipFile(
        output,
        "w",
        compression=zipfile.ZIP_DEFLATED,
    ) as archive:
        for name in sorted(files):
            info = zipfile.ZipInfo(
                name,
                (2026, 1, 1, 0, 0, 0),
            )
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16

            archive.writestr(info, files[name])

    return output.getvalue()


def prepare_package(version: str, workdir: Path):
    manifest = load_descriptor("manifest.json")
    application = load_descriptor("application-extension.json")
    compiled_ui = load_descriptor("compiled-ui.json")

    module_ids = {
        manifest["module_id"],
        application["module_id"],
        compiled_ui["module_id"],
    }

    if len(module_ids) != 1:
        raise ValueError("Descriptor module IDs do not match")

    wheel_name, wheel_data = build_wheel(
        workdir,
        version,
    )

    wheel_path = f"service/{wheel_name}"
    wheel_sha = hashlib.sha256(wheel_data).hexdigest()

    previous_version = application["version"]
    previous_sha = application["service"]["artifact_sha256"]

    for descriptor in (
        manifest,
        application,
        compiled_ui,
    ):
        descriptor["version"] = version

    application["service"]["artifact"] = wheel_path
    application["service"]["artifact_sha256"] = wheel_sha

    files = {
        "manifest.json": json_bytes(manifest),
        "application-extension.json": json_bytes(application),
        "compiled-ui.json": json_bytes(compiled_ui),
        wheel_path: wheel_data,
    }

    frontend = ROOT / "source" / "frontend"

    for path in sorted(frontend.rglob("*")):
        if path.is_symlink():
            raise ValueError(
                f"Frontend symlink is not allowed: {path}"
            )

        if path.is_file():
            relative = path.relative_to(ROOT).as_posix()
            files[relative] = path.read_bytes()

    package = assemble_package(files)

    return (
        package,
        files,
        wheel_path,
        wheel_sha,
        previous_version,
        previous_sha,
    )


def validate_package(package: bytes, core_root: Path):
    if not (
        core_root / "backend" / "services" /
        "module_packages.py"
    ).is_file():
        raise FileNotFoundError(
            f"3mm Core checkout not found: {core_root}"
        )

    sys.path.insert(0, str(core_root))

    from backend.services.module_packages import (
        validate_module_package,
    )

    return validate_module_package(
        package,
        architecture="any",
        protocol_version="1.0",
    )


def save_file(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def prepare_npm_metadata(version: str) -> dict[str, bytes]:
    """Prepare npm version updates without writing files."""

    package = load_descriptor("package.json")
    lock = load_descriptor("package-lock.json")

    packages = lock.get("packages")

    if (
        lock.get("lockfileVersion") != 3
        or not isinstance(packages, dict)
        or not isinstance(packages.get(""), dict)
    ):
        raise ValueError(
            "Unsupported package-lock.json structure"
        )

    root = packages[""]

    if (
        package.get("name") != "3mm-terminal"
        or lock.get("name") != package["name"]
        or root.get("name") != package["name"]
    ):
        raise ValueError(
            "npm package identities do not match"
        )

    updates: dict[str, bytes] = {}

    if package.get("version") != version:
        package["version"] = version
        updates["package.json"] = json_bytes(package)

    if (
        lock.get("version") != version
        or root.get("version") != version
    ):
        lock["version"] = version
        root["version"] = version

        updates["package-lock.json"] = json_bytes(lock)

    return updates


def main() -> None:
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--output",
        type=Path,
        default=None,
    )
    parser.add_argument(
        "--core-root",
        type=Path,
        default=Path(
            os.environ.get(
                "THREE_MM_CORE_ROOT",
                str(ROOT.parent / "3mm"),
            )
        ),
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="Build and validate without publishing files",
    )

    args = parser.parse_args()

    version = read_version()
    npm_updates = prepare_npm_metadata(version)

    output_path = (
        args.output
        if args.output is not None
        else ROOT / "dist" / f"3mm-terminal-{version}.zip"
    )

    with tempfile.TemporaryDirectory(
        prefix="3mm-terminal-build-"
    ) as directory:
        (
            package,
            files,
            wheel_path,
            wheel_sha,
            previous_version,
            previous_sha,
        ) = prepare_package(
            version,
            Path(directory),
        )

        validated = validate_package(
            package,
            args.core_root.resolve(),
        )

    package_sha = hashlib.sha256(package).hexdigest()

    print("M20 package validation: OK")
    print("Module:", validated.manifest.module_id)
    print("Version:", validated.manifest.version)
    print("Wheel:", wheel_path)
    print("Wheel SHA-256:", wheel_sha)
    print("Size:", len(package), "bytes")
    print("Package SHA-256:", package_sha)

    if args.check_only:
        if npm_updates:
            print(
                "npm metadata requires synchronization:",
                ", ".join(sorted(npm_updates)),
            )
        else:
            print("npm metadata: matches VERSION")

        print("CHECK ONLY: no release files written")
        return

    # Never replace changed code under the same
    # declared version. Installed release identities
    # must remain immutable.
    if (
        previous_version == version
        and previous_sha.lower() != wheel_sha
    ):
        raise RuntimeError(
            "Wheel has changed without a version bump. "
            "Update VERSION before publishing."
        )

    if output_path.exists():
        existing_sha = hashlib.sha256(
            output_path.read_bytes()
        ).hexdigest()

        if existing_sha != package_sha:
            raise RuntimeError(
                "A different ZIP already exists for "
                f"version {version}. Bump VERSION."
            )

    # Write only after successful wheel/package validation.
    for name in DESCRIPTORS:
        save_file(ROOT / name, files[name])

    save_file(
        ROOT / wheel_path,
        files[wheel_path],
    )

    save_file(output_path, package)

    for name, content in npm_updates.items():
        save_file(ROOT / name, content)

    print("npm metadata: synchronized with VERSION")

    print("Package:", output_path)
    print("Build completed successfully")


if __name__ == "__main__":
    main()
