"""Bounded, path-safe NIROPS archive inventory; source archives remain unchanged."""

from pathlib import Path, PurePosixPath
import hashlib
import json
import shutil
import stat
import time
import zipfile

MAX_EXPANDED = 16 * 1024**3
MAX_ENTRIES = 10000


def file_hash(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for block in iter(lambda: f.read(8 * 1024**2), b""):
            h.update(block)
    return h.hexdigest()


def inspect_zip(archive):
    """Reject traversal/symlinks/encryption/implausible resource requests before extraction."""
    with zipfile.ZipFile(archive) as z:
        entries = z.infolist()
        if len({i.filename for i in entries}) != len(entries):
            raise ValueError("duplicate ZIP member names")
        if len(entries) > MAX_ENTRIES or sum(i.file_size for i in entries) > MAX_EXPANDED:
            raise ValueError("archive exceeds declared resource bound")
        for i in entries:
            p = PurePosixPath(i.filename)
            if (
                p.is_absolute()
                or ".." in p.parts
                or "\\" in i.filename
                or ":" in i.filename
                or stat.S_ISLNK(i.external_attr >> 16)
                or i.flag_bits & 1
            ):
                raise ValueError(f"unsafe ZIP member {i.filename}")
            if i.file_size > 1024**2 and i.file_size / max(1, i.compress_size) > 2000:
                raise ValueError("suspicious ZIP expansion ratio")
        return [
            {"name": i.filename, "expanded_bytes": i.file_size, "compressed_bytes": i.compress_size}
            for i in entries
        ]


def prepare_archive(archive, output):
    started = time.monotonic()
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    sha = file_hash(archive)
    receipt = output / "inventory.json"
    if receipt.exists():
        previous = json.loads(receipt.read_text())
        if previous["archive_sha256"] != sha:
            raise ValueError("immutable raw directory belongs to different archive")
        for name, expected in previous["source_hashes"].items():
            if file_hash(output / name) != expected:
                raise ValueError("raw companion checksum mismatch")
        return previous
    outer = inspect_zip(archive)
    with zipfile.ZipFile(archive) as z:
        if z.testzip() is not None:
            raise ValueError("outer ZIP CRC failed")
        matches = [i for i in z.infolist() if PurePosixPath(i.filename).name == "NIROPS_2020_2024_R1_R6.zip"]
        if len(matches) != 1:
            raise ValueError("expected one NIROPS vector archive")
        nested = output / "NIROPS_2020_2024_R1_R6.zip"
        if not nested.exists():
            pending = nested.with_suffix(".zip.partial")
            with z.open(matches[0]) as source, pending.open("wb") as target:
                shutil.copyfileobj(source, target, 8 * 1024**2)
            pending.replace(nested)
    inner = inspect_zip(nested)
    with zipfile.ZipFile(nested) as z:
        if z.testzip() is not None:
            raise ValueError("vector ZIP CRC failed")
        selected = [
            i
            for i in z.infolist()
            if PurePosixPath(i.filename).suffix.lower() in {".shp", ".dbf", ".shx", ".prj", ".cpg"}
        ]
        if len({PurePosixPath(i.filename).name for i in selected}) != len(selected):
            raise ValueError("duplicate flattened shapefile companion names")
        if {PurePosixPath(i.filename).suffix.lower() for i in selected} != {
            ".shp",
            ".dbf",
            ".shx",
            ".prj",
            ".cpg",
        }:
            raise ValueError("missing shapefile companions")
        if len(selected) != 5 or len({PurePosixPath(i.filename).stem for i in selected}) != 1:
            raise ValueError("expected one matched shapefile companion set")
        for i in selected:
            name = PurePosixPath(i.filename).name
            # An interrupted extraction has no inventory receipt. Replace any
            # pre-existing companion in that case, never trust a partial file.
            pending = output / (name + ".partial")
            with z.open(i) as source, pending.open("wb") as target:
                shutil.copyfileobj(source, target, 8 * 1024**2)
            pending.replace(output / name)
    result = {
        "schema_version": "nirops-inventory-v1",
        "archive": str(Path(archive).resolve()),
        "archive_sha256": sha,
        "outer_crc": "passed",
        "nested_crc": "passed",
        "outer_entries": outer,
        "inner_entries": inner,
        "nested_sha256": file_hash(nested),
        "source_hashes": {
            PurePosixPath(i.filename).name: file_hash(output / PurePosixPath(i.filename).name)
            for i in selected
        },
        "preflight_elapsed_s": time.monotonic() - started,
    }
    receipt.write_text(json.dumps(result, indent=2))
    return result
