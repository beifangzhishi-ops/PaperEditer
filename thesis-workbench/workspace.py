"""UTF-8 .paper project index with direct relative file references."""
import argparse
import contextlib
import copy
import hashlib
import json
import os
import re
import sqlite3
import threading
import uuid
from pathlib import Path, PurePosixPath

FORMAT = "paperediter"
VERSION = 2
REQUIRED = ("outline.json", "blocks.json", "original_labels.json", "import-report.json")
OBJECT = re.compile(r"^:::(equation|figure|table)\s+([^\s]+)(?:[ \t]+([^\n]*))?\r?\n([\s\S]*?)^:::[ \t]*$", re.M)
IMAGE = re.compile(r'!\[([^\]]*)\]\((/assets/[^\s)]+)(?:\s+"([^"]*)")?\)')


def safe_name(name):
    if not isinstance(name, str) or not name or "\\" in name or ":" in name or any(x in ("", ".", "..") for x in name.split("/")):
        raise ValueError("Invalid workspace path")
    return PurePosixPath(name).as_posix()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def replace_bytes(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name("." + path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temp.open("xb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


class Package:
    """Logical workspace paths resolve to ordinary files beside the manifest."""
    def __init__(self, filename, create=False, data_directory=None):
        self.filename = Path(filename).expanduser().resolve()
        self.root = self.filename.parent
        self.local = threading.local()
        self.lock = threading.RLock()
        self._validated_raw = None
        self._validated_index = None
        if create:
            directory = safe_name(data_directory or self.filename.stem + "-data")
            if self.filename.exists() or self.resolve(directory).exists():
                raise FileExistsError("Workspace or data directory already exists")
            self.root.mkdir(parents=True, exist_ok=True)
            with self.filename.open("xb") as f:
                f.write(json_bytes(dict(format=FORMAT, version=VERSION, dataDirectory=directory, files={}, objects=[])))
        else:
            self.load_index()

    def resolve(self, relative):
        p = (self.root / safe_name(relative)).resolve()
        if not p.is_relative_to(self.root) or p == self.filename:
            raise ValueError("Workspace path escapes project or targets index")
        return p

    def load_index(self, raw=None):
        raw = self.filename.read_bytes() if raw is None else raw
        if raw == self._validated_raw:
            return copy.deepcopy(self._validated_index)
        try:
            index = json.loads(raw.decode("utf-8"))
        except UnicodeError as e:
            raise ValueError("Legacy SQLite workspace: run workspace.py migrate first") from e
        if not isinstance(index, dict) or index.get("format") != FORMAT or index.get("version") != VERSION or not isinstance(index.get("files"), dict):
            raise ValueError("Not a supported PaperEditer workspace")
        self.resolve(index["dataDirectory"])
        seen = set()
        for name, relative in index["files"].items():
            safe_name(name)
            target = self.resolve(relative)
            if target in seen:
                raise ValueError("Duplicate workspace file target")
            seen.add(target)
        for relative in index.get("sourceFiles", []):
            self.resolve(relative)
        if index.get("sourceRoot") not in (None, "."):
            self.resolve(index["sourceRoot"])
        self._validated_raw = raw
        self._validated_index = copy.deepcopy(index)
        return index

    @contextlib.contextmanager
    def transaction(self, write=False):
        existing = getattr(self.local, "tx", None)
        if existing is not None:
            if write and not existing["write"]:
                raise RuntimeError("Cannot promote read transaction")
            yield existing
            return
        with self.lock:
            raw = self.filename.read_bytes()
            tx = dict(index=self.load_index(raw), pending={}, write=write, index_bytes=raw)
            self.local.tx = tx
            try:
                yield tx
                if write and (tx["pending"] or tx.get("changed")):
                    tx["index"]["objects"] = self.object_index(tx["index"])
                    self.commit(tx)
            finally:
                self.local.tx = None

    def commit(self, tx):
        if self.filename.read_bytes() != tx["index_bytes"]:
            raise RuntimeError("Workspace index changed externally")
        originals = {}
        try:
            for name, data in tx["pending"].items():
                target = self.resolve(tx["index"]["files"][name])
                originals[target] = target.read_bytes() if target.exists() else None
                replace_bytes(target, data)
            replace_bytes(self.filename, json_bytes(tx["index"]))
        except BaseException:
            for target, old in reversed(list(originals.items())):
                if old is None:
                    target.unlink(missing_ok=True)
                else:
                    replace_bytes(target, old)
            raise

    def read(self, name):
        name = safe_name(name)
        with self.transaction() as tx:
            if name in tx["pending"]:
                return tx["pending"][name]
            if name not in tx["index"]["files"]:
                raise FileNotFoundError(name)
            return self.resolve(tx["index"]["files"][name]).read_bytes()

    def write(self, name, data):
        name = safe_name(name)
        with self.transaction(True) as tx:
            index = tx["index"]
            if name not in index["files"]:
                relative = index["dataDirectory"] + "/" + name
                target = self.resolve(relative)
                if target.exists() or relative in index["files"].values():
                    raise FileExistsError(target)
                index["files"][name] = relative
            else:
                # External source images are references, not editable originals.
                target = self.resolve(index["files"][name])
                if not target.is_relative_to(self.resolve(index["dataDirectory"])):
                    editable = name in ("outline.json", "blocks.json") or (name.startswith(("thesis/", "blocks/")) and name.endswith(".md"))
                    if not editable or target.suffix.lower() != Path(name).suffix.lower():
                        raise ValueError("Cannot overwrite referenced external source file")
            tx["pending"][name] = bytes(data)

    def reference(self, name, path):
        name = safe_name(name)
        with self.transaction(True) as tx:
            path = Path(path).resolve()
            relative = path.relative_to(self.root).as_posix()
            if self.resolve(relative) != path or not path.is_file():
                raise ValueError("Invalid reference")
            if name in tx["index"]["files"] or relative in tx["index"]["files"].values():
                raise ValueError("Duplicate reference")
            tx["index"]["files"][name] = relative
            tx["changed"] = True

    def exists(self, name):
        name = safe_name(name)
        with self.transaction() as tx:
            return name in tx["pending"] or (name in tx["index"]["files"] and self.resolve(tx["index"]["files"][name]).is_file())

    def names(self, prefix=""):
        with self.transaction() as tx:
            return sorted(n for n in tx["index"]["files"] if n.startswith(prefix))

    def refresh(self):
        with self.transaction(True) as tx:
            tx["changed"] = True

    def manifest(self):
        with self.transaction():
            return {name: hashlib.sha256(self.read(name)).hexdigest() for name in self.names()}

    def object_index(self, index):
        files = index["files"]
        if not all(n in files for n in REQUIRED):
            return []
        def load(name):
            return json.loads(self.read(name))
        report = load("import-report.json")
        if "sourceRoot" in index:
            source = self.root if index["sourceRoot"] == "." else self.resolve(index["sourceRoot"])
        else:
            source = Path(report.get("source", ""))
            if not source.is_absolute():
                source = self.root / source
            source = source.resolve()
            if source.is_relative_to(self.root) and source.is_dir():
                index["sourceRoot"] = source.relative_to(self.root).as_posix()
        def source_path(name):
            if not name or not source.is_relative_to(self.root):
                return None
            p = (source / name).resolve()
            if p.is_relative_to(self.root) and p.is_file():
                return p.relative_to(self.root).as_posix()
            return None
        assets = load("assets.json") if "assets.json" in files else {}
        result = []
        for key, kind in (("outline.json", "section"), ("blocks.json", "block")):
            for node in load(key):
                logical = node["file"]
                path = files[logical]
                record = dict(id=node["id"], type=kind, path=path)
                for k in ("title", "parent", "order", "annotation", "objectBindings", "freePlacements"):
                    if k in node:
                        record[k] = node[k]
                original = "original/" + PurePosixPath(logical).stem + ".tex"
                if original in files:
                    record["originalPath"] = files[original]
                src = source_path(node.get("source"))
                if src:
                    record["sourcePath"] = src
                result.append(record)
                body = self.read(logical).decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
                # Prose has no persistent IDs in the editor. Record positional
                # locators, without inventing permanent IDs or altering Markdown.
                def prose(start, end):
                    for part in re.finditer(r"[^\s][\s\S]*?(?=\r?\n[ \t]*\r?\n|\Z)", body[start:end]):
                        text = part.group().strip()
                        if not text or re.fullmatch(r"\[\[embed:[^\]\n]+\]\]", text):
                            continue
                        line = body.count("\n", 0, start + part.start()) + 1
                        result.append(dict(type="paragraph", owner=node["id"], path=path, line=line))
                end = 0
                for m in OBJECT.finditer(body):
                    prose(end, m.start())
                    end = m.end()
                    t, oid, _, content = m.groups()
                    result.append(dict(id=oid, type=t, owner=node["id"], path=path, marker=":::" + t + " " + oid))
                    if t == "figure":
                        for i, img in enumerate(IMAGE.finditer(content), 1):
                            name = img[2].lstrip("/")
                            match = re.search(r'(?:^|\s)wb-id:([^\s"]+)', img[3] or "")
                            sid = match[1] if match else "subfig-" + oid + "-" + str(i)
                            image = dict(id=sid, type="image", owner=oid, path=files.get(name, name), documentPath=path)
                            src = source_path(assets.get(PurePosixPath(name).name))
                            if src:
                                image["sourcePath"] = src
                            if name not in files:
                                image["missing"] = True
                            result.append(image)
                prose(end, len(body))
        return result


def pack(data, filename):
    data = Path(data).resolve()
    if not all((data / x).is_file() for x in REQUIRED):
        raise ValueError("Incomplete source workspace")
    p = Package(filename, create=True)
    with p.transaction(True):
        for f in sorted(data.rglob("*")):
            if f.is_file() and f.relative_to(data).parts[0] != "figure-sources":
                p.write(f.relative_to(data).as_posix(), f.read_bytes())
    return p


def unpack(p, dest):
    dest = Path(dest).resolve()
    if dest.exists() and any(dest.iterdir()):
        raise ValueError("Export destination must be empty")
    with p.transaction():
        for name in p.names():
            target = dest / safe_name(name)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(p.read(name))


def migrate(source, destination, data_directory=None):
    """Create a text index; reuse original image/bib files only when byte-identical."""
    source = Path(source).resolve()
    destination = Path(destination).resolve()
    if source == destination:
        raise ValueError("Use a separate staging index before replacing legacy file")
    with contextlib.closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as db:
        if db.execute("PRAGMA application_id").fetchone()[0] != 1346458693:
            raise ValueError("Not a legacy PaperEditer SQLite workspace")
        rows = dict(db.execute("SELECT name,data FROM entries ORDER BY name"))
    if not all(n in rows for n in REQUIRED):
        raise ValueError("Incomplete legacy workspace")
    if any(n.startswith("figure-sources/") for n in rows):
        raise ValueError("Extract drawing sources separately before migration")
    report = json.loads(rows["import-report.json"])
    asset_map = json.loads(rows.get("assets.json", b"{}"))
    src = Path(report.get("source", "")).resolve()
    p = Package(destination, create=True, data_directory=data_directory)
    with p.transaction(True) as tx:
        drawings = p.root / "figure-sources"
        if drawings.is_dir():
            tx["index"]["sourceFiles"] = [
                f.resolve().relative_to(p.root).as_posix()
                for f in sorted(drawings.rglob("*"))
                if f.is_file() and f.resolve().is_relative_to(p.root)
            ]
        for name, data in rows.items():
            candidate = None
            if name.startswith("assets/"):
                original = asset_map.get(PurePosixPath(name).name)
                if original:
                    candidate = (src / original).resolve()
            elif name == "references.bib":
                candidate = src / "refs.bib"
            if candidate and candidate.is_relative_to(p.root) and candidate.is_file() and candidate.read_bytes() == data and candidate.relative_to(p.root).as_posix() not in p.local.tx["index"]["files"].values():
                p.reference(name, candidate)
            else:
                p.write(name, data)
    expected = {n: hashlib.sha256(d).hexdigest() for n,d in rows.items()}
    if p.manifest() != expected:
        raise RuntimeError("Migration byte verification failed")
    return p


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    c = sub.add_parser("pack")
    c.add_argument("data", type=Path)
    c.add_argument("file", type=Path)
    c = sub.add_parser("unpack")
    c.add_argument("file", type=Path)
    c.add_argument("destination", type=Path)
    c = sub.add_parser("list")
    c.add_argument("file", type=Path)
    c = sub.add_parser("refresh")
    c.add_argument("file", type=Path)
    c = sub.add_parser("migrate")
    c.add_argument("source", type=Path)
    c.add_argument("file", type=Path)
    c.add_argument("--data-directory")
    args = parser.parse_args()
    if args.command == "pack":
        p = pack(args.data, args.file)
        print("Indexed", len(p.names()), "entries")
    elif args.command == "unpack":
        unpack(Package(args.file), args.destination)
    elif args.command == "refresh":
        Package(args.file).refresh()
    elif args.command == "migrate":
        p = migrate(args.source, args.file, args.data_directory)
        print("Migrated", len(p.names()), "entries")
    else:
        print(json.dumps(Package(args.file).names(), ensure_ascii=False, indent=2))

