#!/usr/bin/env python3
"""Verify a Windows 7 launcher binary and the packaging files that produce it."""

from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path


FORBIDDEN_IMPORTS = {
    ("bcryptprimitives.dll", "ProcessPrng"),
    ("kernel32.dll", "SetProcessMitigationPolicy"),
    ("kernel32.dll", "GetPackagesByPackageFamily"),
    ("kernel32.dll", "CreateFile2"),
    ("ole32.dll", "CoIncrementMTAUsage"),
    ("api-ms-win-core-synch-l1-2-0.dll", "WaitOnAddress"),
    ("api-ms-win-core-synch-l1-2-0.dll", "WakeByAddressSingle"),
    ("api-ms-win-core-synch-l1-2-0.dll", "WakeByAddressAll"),
}

FORBIDDEN_IMPORT_DLLS = {
    "api-ms-win-core-synch-l1-2-0.dll",
    "bcryptprimitives.dll",
}

REQUIRED_PACKAGING_FILES = [
    "tauri-app/src-tauri/win7.config.json",
    "tauri-app/src-tauri/windows/win7-hooks.nsh",
    "tauri-app/src-tauri/scripts/prepare-win7-runtime.ps1",
    "tauri-app/src-tauri/scripts/verify-win7-pe.py",
    "tauri-app/src-tauri/src/win7_compat.rs",
    "tauri-app/src-tauri/win7-runtime/README.md",
    "docs/windows7.md",
]

REQUIRED_HOOK_MARKERS = [
    "NSIS_HOOK_PREINSTALL",
    "NSIS_HOOK_POSTINSTALL",
    "win7-runtime",
    "ucrtbase.dll",
    "vc_redist.x64.exe",
    "KB2999226",
    "EmbeddedBrowserWebView.dll",
]


class PeError(Exception):
    pass


def _u16(data: bytes, offset: int) -> int:
    return struct.unpack_from("<H", data, offset)[0]


def _u32(data: bytes, offset: int) -> int:
    return struct.unpack_from("<I", data, offset)[0]


def _read_cstr(data: bytes, offset: int) -> str:
    end = data.find(b"\0", offset)
    if end < 0:
        end = len(data)
    return data[offset:end].decode("ascii", errors="replace")


def parse_pe(data: bytes) -> dict:
    if data[:2] != b"MZ":
        raise PeError("not a PE file (missing MZ)")
    e_lfanew = _u32(data, 0x3C)
    if data[e_lfanew : e_lfanew + 4] != b"PE\0\0":
        raise PeError("not a PE file (missing PE signature)")

    coff = e_lfanew + 4
    machine = _u16(data, coff)
    section_count = _u16(data, coff + 2)
    optional_size = _u16(data, coff + 16)
    optional = coff + 20
    magic = _u16(data, optional)
    if magic != 0x20B:
        raise PeError(f"expected PE32+ optional header, got magic 0x{magic:x}")

    os_major = _u16(data, optional + 40)
    os_minor = _u16(data, optional + 42)
    subsystem_major = _u16(data, optional + 48)
    subsystem_minor = _u16(data, optional + 50)
    subsystem = _u16(data, optional + 68)
    rva_count = _u32(data, optional + 108)
    import_rva = _u32(data, optional + 120) if rva_count >= 2 else 0
    import_size = _u32(data, optional + 124) if rva_count >= 2 else 0

    sections = []
    section_table = optional + optional_size
    for index in range(section_count):
        start = section_table + index * 40
        name = data[start : start + 8].split(b"\0", 1)[0].decode("ascii", errors="replace")
        virtual_size = _u32(data, start + 8)
        virtual_address = _u32(data, start + 12)
        raw_size = _u32(data, start + 16)
        raw_ptr = _u32(data, start + 20)
        sections.append(
            {
                "name": name,
                "virtual_size": virtual_size,
                "virtual_address": virtual_address,
                "raw_size": raw_size,
                "raw_ptr": raw_ptr,
            }
        )

    return {
        "machine": machine,
        "os_version": (os_major, os_minor),
        "subsystem_version": (subsystem_major, subsystem_minor),
        "subsystem": subsystem,
        "import_rva": import_rva,
        "import_size": import_size,
        "sections": sections,
        "imports": read_imports(data, sections, import_rva, import_size),
    }


def rva_to_offset(sections: list[dict], rva: int) -> int | None:
    for section in sections:
        start = section["virtual_address"]
        size = max(section["virtual_size"], section["raw_size"])
        if start <= rva < start + size:
            return section["raw_ptr"] + (rva - start)
    return None


def read_imports(
    data: bytes, sections: list[dict], import_rva: int, import_size: int
) -> list[tuple[str, str]]:
    if not import_rva or not import_size:
        return []
    start = rva_to_offset(sections, import_rva)
    if start is None:
        return []

    imports: list[tuple[str, str]] = []
    descriptor = start
    while descriptor + 20 <= len(data):
        lookup_rva = _u32(data, descriptor)
        name_rva = _u32(data, descriptor + 12)
        thunk_rva = _u32(data, descriptor + 16)
        if lookup_rva == 0 and name_rva == 0 and thunk_rva == 0:
            break
        name_off = rva_to_offset(sections, name_rva)
        if name_off is None:
            break
        dll = _read_cstr(data, name_off).lower()
        thunk = lookup_rva or thunk_rva
        thunk_off = rva_to_offset(sections, thunk)
        if thunk_off is None:
            descriptor += 20
            continue
        entry = thunk_off
        while entry + 8 <= len(data):
            value = struct.unpack_from("<Q", data, entry)[0]
            if value == 0:
                break
            if value & (1 << 63):
                imports.append((dll, f"#{value & 0xFFFF}"))
            else:
                hint_off = rva_to_offset(sections, value)
                if hint_off is not None and hint_off + 2 < len(data):
                    imports.append((dll, _read_cstr(data, hint_off + 2)))
            entry += 8
        descriptor += 20
    return imports


def version_is_win7_compatible(version: tuple[int, int]) -> bool:
    return version < (6, 2)


def verify_binary(path: Path) -> list[str]:
    errors: list[str] = []
    pe = parse_pe(path.read_bytes())
    if pe["machine"] != 0x8664:
        errors.append(f"expected AMD64 machine type, got 0x{pe['machine']:x}")
    if not version_is_win7_compatible(pe["os_version"]):
        errors.append(
            f"PE MajorOperatingSystemVersion is {pe['os_version'][0]}.{pe['os_version'][1]} "
            "(need 6.0 or 6.1 for Windows 7)"
        )
    if not version_is_win7_compatible(pe["subsystem_version"]):
        errors.append(
            f"PE MajorSubsystemVersion is {pe['subsystem_version'][0]}.{pe['subsystem_version'][1]} "
            "(need 6.0 or 6.1 for Windows 7)"
        )

    imported_dlls = {dll for dll, _name in pe["imports"]}
    for dll in sorted(imported_dlls & FORBIDDEN_IMPORT_DLLS):
        errors.append(f"hard-imports Windows 10-only DLL {dll}")

    imported = {(dll, name) for dll, name in pe["imports"]}
    for dll, name in sorted(FORBIDDEN_IMPORTS):
        if (dll, name) in imported:
            errors.append(f"hard-imports {dll}!{name}")

    raw = path.read_bytes()
    if b"ProcessPrng" in raw:
        errors.append("binary still contains the ProcessPrng symbol (Windows 10-only)")
    return errors


def verify_packaging(repo_root: Path) -> list[str]:
    errors: list[str] = []
    for relative in REQUIRED_PACKAGING_FILES:
        if not (repo_root / relative).is_file():
            errors.append(f"missing {relative}")

    config_path = repo_root / "tauri-app/src-tauri/win7.config.json"
    if config_path.is_file():
        config = json.loads(config_path.read_text(encoding="utf-8"))
        windows = config.get("bundle", {}).get("windows", {})
        webview = windows.get("webviewInstallMode", {})
        if webview.get("type") != "fixedRuntime":
            errors.append("win7.config.json must use webviewInstallMode.type=fixedRuntime")
        path = str(webview.get("path", ""))
        if "109.0.1518.78" not in path:
            errors.append("win7.config.json must pin WebView2 fixed runtime 109.0.1518.78")
        hooks = windows.get("nsis", {}).get("installerHooks", "")
        if "win7-hooks.nsh" not in hooks:
            errors.append("win7.config.json must register windows/win7-hooks.nsh")
        resources = config.get("bundle", {}).get("resources", [])
        required_resources = {
            "win7-runtime/ucrtbase.dll",
            "win7-runtime/vcruntime140.dll",
            "win7-runtime/**/*",
        }
        missing = required_resources.difference(resources)
        if missing:
            errors.append(f"win7.config.json resources missing {sorted(missing)}")

    hooks_path = repo_root / "tauri-app/src-tauri/windows/win7-hooks.nsh"
    if hooks_path.is_file():
        text = hooks_path.read_text(encoding="utf-8")
        for marker in REQUIRED_HOOK_MARKERS:
            if marker not in text:
                errors.append(f"win7-hooks.nsh is missing {marker}")

    workflow = repo_root / ".github/workflows/ci-release.yml"
    if workflow.is_file():
        text = workflow.read_text(encoding="utf-8")
        for marker in (
            "prepare-win7-runtime.ps1",
            "verify-win7-pe.py",
            "x86_64-win7-windows-msvc",
            "109.0.1518.78",
        ):
            if marker not in text:
                errors.append(f"ci-release.yml is missing {marker}")
    return errors


def contains_text(data: bytes, text: str) -> bool:
    return text.encode("ascii") in data or text.encode("utf-16le") in data


def verify_installer_strings(path: Path) -> list[str]:
    data = path.read_bytes()
    errors = []
    for needle in (
        "ucrtbase.dll",
        "EmbeddedBrowserWebView.dll",
        "win7-runtime",
        "vc_redist.x64.exe",
        "KB2999226",
    ):
        if not contains_text(data, needle):
            errors.append(f"NSIS installer does not contain {needle}")
    return errors


def build_minimal_pe(os_version: tuple[int, int] = (6, 1)) -> bytes:
    dos = bytearray(64)
    dos[0:2] = b"MZ"
    struct.pack_into("<I", dos, 0x3C, 64)
    coff = bytearray(20)
    struct.pack_into("<H", coff, 0, 0x8664)
    struct.pack_into("<H", coff, 16, 240)
    optional = bytearray(240)
    struct.pack_into("<H", optional, 0, 0x20B)
    struct.pack_into("<H", optional, 40, os_version[0])
    struct.pack_into("<H", optional, 42, os_version[1])
    struct.pack_into("<H", optional, 48, os_version[0])
    struct.pack_into("<H", optional, 50, os_version[1])
    struct.pack_into("<H", optional, 68, 2)
    struct.pack_into("<I", optional, 108, 16)
    return bytes(dos + b"PE\0\0" + coff + optional)


def self_test() -> None:
    compatible = parse_pe(build_minimal_pe((6, 1)))
    assert compatible["os_version"] == (6, 1)
    assert version_is_win7_compatible(compatible["os_version"])
    too_new = parse_pe(build_minimal_pe((10, 0)))
    assert not version_is_win7_compatible(too_new["os_version"])
    sample = "win7-runtime".encode("utf-16le")
    assert contains_text(sample, "win7-runtime")
    print("self-test ok")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary")
    parser.add_argument("--installer")
    parser.add_argument("--check-packaging")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()

    errors: list[str] = []
    if args.check_packaging:
        errors.extend(verify_packaging(Path(args.check_packaging)))
    if args.binary:
        errors.extend(verify_binary(Path(args.binary)))
    if args.installer:
        errors.extend(verify_installer_strings(Path(args.installer)))
    if not (args.self_test or args.check_packaging or args.binary or args.installer):
        parser.error("specify --check-packaging, --binary, --installer, or --self-test")

    if errors:
        print("Windows 7 verification failed:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1
    print("Windows 7 verification passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
