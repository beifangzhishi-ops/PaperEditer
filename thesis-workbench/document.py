"""Single-file PaperEditer document, protected atomic writes and local Git history."""
import contextlib
import copy
import datetime
import hashlib
import json
import os
import re
import stat
import subprocess
import threading
import time
import uuid
from pathlib import Path

from workspace import Package, json_bytes, replace_bytes, OBJECT
from merge import merge_content
from paragraphs import paragraph_index_valid, rebuild, paragraph_value

VERSION = 3
SPACES = ("thesis", "blocks")
IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
OID = re.compile(r"[0-9a-f]{40,64}")
ASSET = re.compile(r"[\w.-]+")
TAG = re.compile(r"[0-9a-f]{32}")
REF = re.compile(r"\[\[(ref|eqref|embed|cite):([^\]\n]+)\]\]")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def revision(value):
    return digest(json.dumps(value, sort_keys=True, ensure_ascii=False).encode("utf-8"))


def content(doc):
    return {key: copy.deepcopy(doc[key]) for key in (*SPACES, "trash")}


def readonly(path, enabled=True):
    mode = stat.S_IMODE(path.stat().st_mode)
    wanted = mode & ~(stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH) if enabled else mode | stat.S_IWUSR
    if mode != wanted:
        os.chmod(path, wanted)


@contextlib.contextmanager
def file_lock(path, timeout=15):
    """OS byte-range lock: no stale PID/lock-file existence checks."""
    with path.open("a+b") as f:
        f.seek(0, 2)
        if f.tell() == 0:
            f.write(b"\0")
            f.flush()
        deadline = time.monotonic() + timeout
        while True:
            f.seek(0)
            try:
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("Document is busy")
                time.sleep(.05)
        try:
            yield
        finally:
            f.seek(0)
            if os.name == "nt":
                msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(f, fcntl.LOCK_UN)


class History:
    """Private bare Git repository. Only the canonical document is committed."""
    ref = "refs/heads/main"

    def __init__(self, path):
        self.path = path
        self.env = {k: v for k, v in os.environ.items() if not k.upper().startswith("GIT_")}
        self.env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                        GIT_AUTHOR_NAME="PaperEditer", GIT_AUTHOR_EMAIL="paperediter@localhost",
                        GIT_COMMITTER_NAME="PaperEditer", GIT_COMMITTER_EMAIL="paperediter@localhost",
                        GIT_TERMINAL_PROMPT="0")
        if not path.exists():
            self.run("init", "--bare", "--initial-branch=main", str(path), bare=False)
        if self.run("rev-parse", "--is-bare-repository").strip() != b"true":
            raise ValueError("History is not a bare Git repository")
        if self.run("remote").strip():
            raise ValueError("PaperEditer history must not have remote repositories")

    def run(self, *args, data=None, bare=True, allowed=(0,), env=None):
        cmd = ["git", "-c", "core.hooksPath=" + os.devnull, "-c", "gc.auto=0",
               "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false"]
        if bare:
            cmd += ["--git-dir=" + str(self.path)]
        p = subprocess.run(cmd + list(args), input=data, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, env=env or self.env, timeout=300 if "fast-import" in args else 60,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if p.returncode not in allowed:
            raise RuntimeError("Git history: " + p.stderr.decode("utf-8", "replace").strip())
        return p.stdout

    def head(self):
        # This repository uses the standard files backend. Reading the ref
        # avoids spawning Git during every idle browser poll.
        loose = self.path / self.ref
        if loose.is_file():
            value = loose.read_text(encoding="ascii").strip()
            if OID.fullmatch(value):
                return value
        packed = self.path / "packed-refs"
        if packed.is_file():
            for line in packed.read_text(encoding="ascii").splitlines():
                if line.endswith(" " + self.ref):
                    value = line.split(" ", 1)[0]
                    if OID.fullmatch(value):
                        return value
        return self.run("rev-parse", "--verify", "--quiet", self.ref, allowed=(0, 1)).decode().strip()

    def item(self, oid):
        if not OID.fullmatch(oid):
            raise ValueError("Invalid history commit")
        # Require a commit reachable from our history (not arbitrary blob or ref).
        if oid not in self.run("rev-list", self.ref).decode().splitlines():
            raise ValueError("Unknown history commit")
        return json.loads(self.run("show", oid + ":document.json"))

    def current(self, head=None):
        head = self.head() if head is None else head
        return json.loads(self.run("show", head + ":document.json")) if head else None

    def versions(self, ids):
        if not ids:
            return
        raw = self.run("cat-file", "--batch", data="".join(x + ":document.json\n" for x in ids).encode())
        pos = 0
        for oid in ids:
            end = raw.index(b"\n", pos)
            header = raw[pos:end].split()
            if len(header) != 3 or header[1] != b"blob":
                raise ValueError("Missing history document")
            size = int(header[2])
            pos = end + 1
            yield json.loads(raw[pos:pos + size])
            pos += size + 1

    def append(self, doc, message, source="editor", date=None):
        previous = self.head()
        if previous and self.current(previous) == doc:
            return previous
        blob = self.run("hash-object", "-w", "--stdin", data=json_bytes(doc)).decode().strip()
        tree = self.run("mktree", data=f"100644 blob {blob}\tdocument.json\n".encode()).decode().strip()
        env = dict(self.env)
        if date:
            env.update(GIT_AUTHOR_DATE=date, GIT_COMMITTER_DATE=date)
        msg = (str(message or "Save").replace("\x00", "")[:1000] + "\n\nPaperEditer-Source: " + source + "\nPaperEditer-Revision: " + revision(doc) + "\n")
        args = ["commit-tree", tree] + (["-p", previous] if previous else [])
        commit = self.run(*args, data=msg.encode("utf-8"), env=env).decode().strip()
        self.run("update-ref", self.ref, commit, previous or "0" * len(commit))
        return commit

    def import_snapshots(self, snapshots):
        """One Git process for legacy histories, preserving each distinct state."""
        if self.head():
            raise ValueError("Migration requires empty history")
        stream = bytearray()
        previous = None
        for doc, message, source, date in snapshots:
            if doc == previous:
                continue
            timestamp = int(date.timestamp()) if date else int(time.time())
            msg = (message + "\n\nPaperEditer-Source: " + source + "\nPaperEditer-Revision: " + revision(doc) + "\n").encode("utf-8")
            raw = json_bytes(doc)
            stream.extend(f"commit {self.ref}\ncommitter PaperEditer <paperediter@localhost> {timestamp} +0000\ndata {len(msg)}\n".encode())
            stream.extend(msg)
            stream.extend(f"M 100644 inline document.json\ndata {len(raw)}\n".encode())
            stream.extend(raw)
            stream.extend(b"\n\n")
            previous = doc
        stream.extend(b"done\n")
        self.run("fast-import", "--quiet", "--done", data=bytes(stream))

    def find_revision(self, expected):
        if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
            return None
        oid = self.run("log", "-1", "--format=%H", "--grep=^PaperEditer-Revision: " + expected + "$", self.ref).decode().strip()
        if oid:
            doc = self.current(oid)
            if revision(doc) == expected:
                return doc
        return None

    def tags(self):
        result = {}
        raw = self.run("for-each-ref", "--format=%(refname:short)%00%(objectname)%00%(*objectname)%00%(contents:subject)", "refs/tags")
        for line in raw.decode("utf-8").splitlines():
            name, obj, peeled, label = line.split("\0", 3)
            if name.startswith("version-") and TAG.fullmatch(name[8:]) and peeled:
                result[peeled] = {"id": name, "name": label}
        return result

    def tag(self, oid, name=None, clear=False):
        self.item(oid)
        old = self.tags().get(oid)
        if clear:
            if old:
                self.run("tag", "-d", old["id"])
            return None
        if name is None and old:
            return old
        name = str(name or datetime.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S")).strip()
        if not name or len(name) > 200 or any(c in name for c in "\r\n\x00"):
            raise ValueError("Version name must be 1–200 characters on one line")
        key = old["id"] if old else "version-" + uuid.uuid4().hex
        self.run("tag", "-a", "-f", key, oid, "-F", "-", data=name.encode("utf-8"))
        return {"id": key, "name": name}

    def list(self, offset=0, limit=100, object_id=None):
        tags = self.tags()
        raw = self.run("log", "--format=%H%x00%aI%x00%s%x00%(trailers:key=PaperEditer-Source,valueonly,separator=%x20)%x1e", self.ref)
        rows = []
        for entry in raw.decode("utf-8").split("\x1e"):
            entry = entry.strip("\r\n")
            if not entry:
                continue
            oid, date, message, source = entry.split("\0", 3)
            rows.append(dict(id=oid, time=date, message=message, source=source.strip(), tag=tags.get(oid)))
        if object_id:
            previous = None
            filtered = []
            # Compare older to newer, including creations and deletions.
            chronological = list(reversed(rows))
            for start in range(0, len(chronological), 32):
                batch = chronological[start:start + 32]
                for row, doc in zip(batch, self.versions([r["id"] for r in batch])):
                    value = object_value(doc, object_id)
                    if value != previous:
                        filtered.append(row)
                    previous = value
            rows = list(reversed(filtered))
        return {"items": rows[offset:offset + limit], "more": offset + limit < len(rows), "total": len(rows)}


def object_value(doc, object_id):
    if object_id.startswith("para-"):
        value = paragraph_value(doc, object_id)
        if value:
            # Position changes alone do not make a new text version.
            return {k:v for k,v in value.items() if k not in ("start", "end")}
    for space in SPACES:
        for node in doc[space]:
            if node["id"] == object_id:
                return {"space": space, "node": copy.deepcopy(node)}
            for m in OBJECT.finditer(node["body"]):
                if m[2] == object_id:
                    return {"space": space, "owner": node["id"], "raw": m[0], "kind": m[1]}
    return None


def objects(doc):
    for space in SPACES:
        for n in doc[space]:
            yield {"id": n["id"], "kind": "section" if space == "thesis" else "block", "space": space, "title": n["title"], "parent": n.get("parent"), "body": n["body"]}
            for m in OBJECT.finditer(n["body"]):
                yield {"id": m[2], "kind": m[1], "owner": n["id"], "space": space, "body": m[0]}
            for record in doc.get("paragraphs", {}).get(n["id"], []):
                value = paragraph_value(doc, record["id"])
                if value:
                    yield {"id": record["id"], "kind": "paragraph", "owner": n["id"], "space": space, "body": value["raw"]}


def apply_operations(doc, operations):
    """Atomic batch of ID-based edits. All mutations happen on a private copy."""
    if not isinstance(operations, list) or not operations or len(operations) > 1000:
        raise ValueError("Provide 1–1000 operations")
    doc = copy.deepcopy(doc)
    def locate(id):
        for space in SPACES:
            for n in doc[space]:
                if n["id"] == id:
                    return space, n, None
                for m in OBJECT.finditer(n["body"]):
                    if m[2] == id:
                        return space, n, m
        raise ValueError("Unknown object: " + str(id))
    def normalize(space):
        nodes = doc[space]
        ordered = []
        def visit(parent, level):
            for n in nodes:
                if (n.get("parent") or None) == parent and n not in ordered:
                    ordered.append(n)
                    n["level"] = level
                    visit(n["id"], level + 1)
        visit(None, 1)
        if len(ordered) != len(nodes):
            raise ValueError("Invalid parent/cycle")
        doc[space] = ordered
        for i, n in enumerate(ordered):
            n["order"] = i
    for op in operations:
        before = copy.deepcopy(doc)
        kind = op.get("op")
        para = paragraph_value(doc, op.get("id", "")) if kind in ("update", "delete") else None
        if para:
            n = next(n for n in doc[para["space"]] if n["id"] == para["owner"])
            replacement = op["body"] if kind == "update" else ""
            n["body"] = n["body"][:para["start"]] + replacement + n["body"][para["end"]:]
            doc["paragraphs"] = rebuild(before, doc)
            continue
        if kind == "create":
            space = op.get("space", "thesis")
            if space not in SPACES:
                raise ValueError("Invalid space")
            id = op.get("id") or ("sec-" if space == "thesis" else "block-") + uuid.uuid4().hex
            if any(x["id"] == id for x in objects(doc)):
                raise ValueError("Duplicate object ID")
            body = op.get("body", "")
            n = dict(id=id, title=op.get("title", "" if space == "thesis" else "Knowledge block"),
                     body=body, parent=op.get("parent"), order=len(doc[space]), level=1,
                     file=space + "/" + id + ".md")
            doc[space].append(n)
            normalize(space)
        elif kind == "resource":
            name, path = op["name"], op["path"]
            if not Path(path).is_absolute() or not Path(path).is_file():
                raise ValueError("Resource must be an existing absolute file")
            if op.get("type", "image") == "image":
                if not ASSET.fullmatch(name) or Path(path).suffix.lower() not in IMAGE_TYPES:
                    raise ValueError("Invalid image resource")
                doc["assets"][name] = str(Path(path).resolve())
            else:
                doc["sources"][name] = str(Path(path).resolve())
        elif kind == "upload-directory":
            p = Path(op["path"])
            if not p.is_absolute():
                raise ValueError("Upload directory must be absolute")
            doc["uploadDirectory"] = str(p.resolve())
        elif kind == "repath":
            old, new = Path(op["old"]), Path(op["new"])
            if not old.is_absolute() or not new.is_absolute():
                raise ValueError("Path prefixes must be absolute")
            for key in ("assets", "sources"):
                for name, path in doc[key].items():
                    p = Path(path)
                    if p.is_relative_to(old):
                        doc[key][name] = str(new / p.relative_to(old))
            p = Path(doc["uploadDirectory"])
            if p.is_relative_to(old):
                doc["uploadDirectory"] = str(new / p.relative_to(old))
        else:
            space, n, m = locate(op.get("id"))
            if kind == "update":
                if m:
                    body = op["body"]
                    # Accept a complete explicit object, or replace its content.
                    full = OBJECT.fullmatch(body)
                    if full:
                        if full[1] != m[1] or full[2] != m[2]:
                            raise ValueError("Object identity cannot change")
                        replacement = body
                    else:
                        replacement = ":::" + m[1] + " " + m[2] + ((" " + m[3]) if m[3] else "") + "\n" + body.rstrip("\n") + "\n:::"
                    n["body"] = n["body"][:m.start()] + replacement + n["body"][m.end():]
                else:
                    for k in ("title", "body", "annotation", "objectBindings", "freePlacements"):
                        if k in op:
                            n[k] = copy.deepcopy(op[k])
            elif kind == "move" and m is None:
                n["parent"] = op.get("parent")
                nodes = doc[space]
                nodes.remove(n)
                after = op.get("after")
                if after:
                    i = next((i for i, x in enumerate(nodes) if x["id"] == after and x.get("parent") == n["parent"]), None)
                    if i is None:
                        raise ValueError("Invalid sibling")
                    nodes.insert(i + 1, n)
                else:
                    nodes.append(n)
                normalize(space)
            elif kind == "bind" and m is None and space == "blocks":
                target = op["target"]
                locate(target)
                if target == n["id"]:
                    raise ValueError("Cannot bind to self")
                bindings = n.setdefault("objectBindings", [])
                if not any(b.get("targetId") == target for b in bindings):
                    bindings.append({"targetId": target})
            elif kind == "delete":
                if m:
                    n["body"] = n["body"][:m.start()] + n["body"][m.end():]
                    doc["paragraphs"] = rebuild(before, doc)
                    continue
                ids = {n["id"]}
                while True:
                    more = {x["id"] for x in doc[space] if x.get("parent") in ids}
                    if more <= ids:
                        break
                    ids |= more
                removed = [x for x in doc[space] if x["id"] in ids]
                doc[space] = [x for x in doc[space] if x["id"] not in ids]
                if space == "blocks":
                    targets = ids | {m[2] for x in removed for m in OBJECT.finditer(x["body"])}
                    targets |= {m[1] for x in removed for m in re.finditer(r'wb-id:([^\s"]+)', x["body"])}
                    entry = dict(id=uuid.uuid4().hex, deletedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), nodes=removed, anchors=[], bindings=[])
                    for x in doc["thesis"] + doc["blocks"]:
                        marks = []
                        removed_length = 0
                        def drop(match):
                            nonlocal removed_length
                            if match[1] == "cite" or match[2] not in targets:
                                return match[0]
                            at = match.start() - removed_length
                            removed_length += len(match[0])
                            if marks and marks[-1]["at"] == at:
                                marks[-1]["token"] += match[0]
                            else:
                                marks.append({"at": at, "token": match[0]})
                            return ""
                        x["body"] = REF.sub(drop, x["body"])
                        for mark in marks:
                            at = mark["at"]
                            entry["anchors"].append(dict(mark, owner=x["id"], left=x["body"][max(0, at - 64):at], right=x["body"][at:at + 64]))
                        for field, key, selected in (("objectBindings", "targetId", targets), ("freePlacements", "pageId", ids)):
                            values = x.get(field, [])
                            gone = [b for b in values if b.get(key) in selected]
                            if gone:
                                entry["bindings"].append(dict(owner=x["id"], field=field, values=gone))
                                x[field] = [b for b in values if b.get(key) not in selected]
                        if x.get("annotation", {}).get("owner") in ids:
                            entry["bindings"].append(dict(owner=x["id"], field="annotation", values=[x.pop("annotation")]))
                    doc["trash"].insert(0, entry)
                normalize(space)
            else:
                raise ValueError("Unsupported operation: " + str(kind))
        doc["paragraphs"] = rebuild(before, doc)
    return doc


def check_document(doc, validator):
    if not isinstance(doc, dict) or doc.get("format") != "paperediter" or doc.get("version") != VERSION:
        raise ValueError("Not a single-file PaperEditer document")
    if not isinstance(doc.get("id"), str) or not re.fullmatch(r"[0-9a-f]{32}", doc["id"]):
        raise ValueError("Invalid document ID")
    validator(content(doc))
    for key in ("originalLabels", "importReport", "assets", "sources"):
        if not isinstance(doc.get(key), dict):
            raise ValueError("Invalid document " + key)
    for name, path in doc["assets"].items():
        if not ASSET.fullmatch(name) or Path(name).suffix.lower() not in IMAGE_TYPES or not isinstance(path, str) or not Path(path).is_absolute() or Path(path).suffix.lower() not in IMAGE_TYPES:
            raise ValueError("Invalid image resource")
    for path in doc["sources"].values():
        if not isinstance(path, str) or not Path(path).is_absolute():
            raise ValueError("Invalid source path")
    if not isinstance(doc.get("uploadDirectory"), str) or not Path(doc["uploadDirectory"]).is_absolute():
        raise ValueError("Invalid upload directory")
    return doc


class Document:
    def __init__(self, filename, validator):
        self.filename = Path(filename).resolve()
        self.validator = validator
        self.lock = threading.RLock()
        self.local = threading.local()
        self.lockpath = self.filename.with_name(self.filename.name + ".lock")
        self.historypath = self.filename.with_name(self.filename.name + ".history.git")
        self._known = None
        self._known_head = None
        self._last_gc = time.monotonic()
        self._writes_since_gc = 0
        self._resource_cache = {}
        self._cached_raw = None
        self._cached_doc = None
        with self.lock, file_lock(self.lockpath):
            raw = self.filename.read_bytes()
            index = json.loads(raw)
            if index.get("format") == "paperediter" and index.get("version") == 2:
                self.migrate(raw)
            doc = self.read_doc()
            self.id = doc["id"]
            self.history = History(self.historypath)
            if not paragraph_index_valid(doc):
                old = self.history.current()
                doc["paragraphs"] = rebuild(old, doc)
                self.replace(self.filename.read_bytes(), doc)
            self.record(doc, "Initial version", "initial")
            readonly(self.filename)

    def migrate(self, raw):
        old = Package(self.filename)
        # The old manifest and all referenced files remain untouched except
        # for replacing the manifest only after a verified migration.
        with old.transaction() as tx:
            index = tx["index"]
            def load(name, default=None):
                return json.loads(old.read(name)) if old.exists(name) else default
            doc = dict(format="paperediter", version=VERSION, id=uuid.uuid4().hex,
                       thesis=[], blocks=[], trash=load("trash.json", []),
                       originalLabels=load("original_labels.json", {}), importReport=load("import-report.json", {}),
                       assets={}, sources={}, uploadDirectory=str(self.filename.with_name(self.filename.stem + "-assets")))
            for space, key in (("thesis", "outline.json"), ("blocks", "blocks.json")):
                doc[space] = [dict(n, body=old.read(n["file"]).decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")) for n in load(key)]
            for logical, relative in index["files"].items():
                target = str(old.resolve(relative))
                if logical.startswith("assets/") and Path(target).suffix.lower() in IMAGE_TYPES:
                    doc["assets"][Path(logical).name] = target
                elif logical.startswith("original/") or logical == "references.bib":
                    doc["sources"][logical] = target
            for relative in index.get("sourceFiles", []):
                doc["sources"][relative] = str(old.resolve(relative))
            for obj in index.get("objects", []):
                for key in ("sourcePath", "originalPath"):
                    if obj.get("id") and obj.get(key):
                        doc["sources"][obj["id"] + ":" + key] = str(old.resolve(obj[key]))
            snapshots = []
            previous = None
            for name in old.names("history/"):
                if name.endswith(".json"):
                    prior = load(name)
                    past = {**doc, **{k: prior.get(k, [] if k == "trash" else None) for k in (*SPACES, "trash")}}
                    check_document(past, self.validator)
                    past["paragraphs"] = rebuild(previous, past)
                    snapshots.append((name, past))
                    previous = past
            doc["paragraphs"] = rebuild(previous, doc)
            check_document(doc, self.validator)
        backup = self.filename.with_name(self.filename.name + ".v2-" + uuid.uuid4().hex[:8] + ".backup")
        with backup.open("xb") as f:
            f.write(raw)
            f.flush()
            os.fsync(f.fileno())
        if self.historypath.exists():
            raise FileExistsError("History path already exists; migration was not applied")
        staging = self.historypath.with_name(self.historypath.name + ".migration-" + uuid.uuid4().hex[:8])
        history = History(staging)
        versions = []
        for name, past in snapshots:
            date = None
            try:
                date = datetime.datetime.fromisoformat(Path(name).stem[:10] + "T" + Path(name).stem[11:23].replace("-", ":", 2) + "+00:00")
            except ValueError:
                pass
            versions.append((past, "Migrated " + Path(name).stem, "migration", date))
        versions.append((doc, "Migrated current document", "migration", None))
        history.import_snapshots(versions)
        if history.current() != doc:
            raise RuntimeError("Migration verification failed")
        # Re-read old editable files after the potentially long history import.
        # A legacy editor must not race migration and silently lose a change.
        with old.transaction():
            for space, key in (("thesis", "outline.json"), ("blocks", "blocks.json")):
                actual = [dict(n, body=old.read(n["file"]).decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")) for n in json.loads(old.read(key))]
                if actual != doc[space]:
                    raise RuntimeError("Legacy document changed during migration")
            actual_trash = json.loads(old.read("trash.json")) if old.exists("trash.json") else []
            if actual_trash != doc["trash"]:
                raise RuntimeError("Legacy trash changed during migration")
        if self.filename.read_bytes() != raw:
            raise RuntimeError("Legacy manifest changed during migration")
        staging.rename(self.historypath)
        self.replace(raw, doc)

    def read_doc(self):
        doc = check_document(json.loads(self.filename.read_bytes()), self.validator)
        if hasattr(self, "id") and doc["id"] != self.id:
            raise ValueError("Document identity changed externally")
        return doc

    def record(self, doc, message, source):
        head = self.history.head()
        if self._known == doc and self._known_head == head:
            return head
        previous = self.history.current(head)
        if previous and previous.get("id") != doc["id"]:
            raise ValueError("History belongs to a different document")
        oid = self.history.append(doc, message, source)
        if oid != head:
            self._writes_since_gc += 1
        self._known, self._known_head = copy.deepcopy(doc), oid
        return oid

    @contextlib.contextmanager
    def transaction(self, write=False):
        existing = getattr(self.local, "doc", None)
        if existing is not None:
            yield existing
            return
        with self.lock, file_lock(self.lockpath):
            raw = self.filename.read_bytes()
            if raw == self._cached_raw:
                doc = copy.deepcopy(self._cached_doc)
            else:
                doc = check_document(json.loads(raw), self.validator)
                if doc["id"] != self.id:
                    raise ValueError("Document identity changed externally")
                if not paragraph_index_valid(doc):
                    old = self.history.current()
                    doc["paragraphs"] = rebuild(old, doc)
                    self.replace(raw, doc)
                    raw = self.filename.read_bytes()
                self._cached_raw, self._cached_doc = raw, copy.deepcopy(doc)
            if doc["id"] != self.id:
                raise ValueError("Document identity changed externally")
            readonly(self.filename)
            self.record(doc, "External modification / recovered save", "external")
            self.local.doc = doc
            self.local.raw = raw
            try:
                yield doc
            finally:
                self.local.doc = self.local.raw = None

    def replace(self, expected, doc):
        check_document(doc, self.validator)
        if self.filename.read_bytes() != expected:
            raise RuntimeError("Document changed during save; retry")
        try:
            readonly(self.filename, False)
            replace_bytes(self.filename, json_bytes(doc))
        finally:
            readonly(self.filename)

    def state(self):
        with self.transaction() as doc:
            result = content(doc)
            # Include resource changes in the revision, without returning paths
            # to browser clients or conflating asset bytes with text history.
            result["revision"] = revision(doc)
            result["paragraphs"] = copy.deepcopy(doc["paragraphs"])
            return result

    def save(self, payload, message="Automatic save", source="editor"):
        with self.transaction(True) as doc:
            if payload.get("revision") != revision(doc):
                return 409, {"error": "Document revision changed"}
            next_doc = {**doc, **{k: copy.deepcopy(payload.get(k, doc[k])) for k in (*SPACES, "trash")}}
            for space in SPACES:
                for i, n in enumerate(next_doc[space]):
                    n["order"] = i
            next_doc["paragraphs"] = rebuild(doc, next_doc)
            check_document(next_doc, self.validator)
            if doc != next_doc:
                self.replace(self.local.raw, next_doc)
                # If Git fails, the durable current file remains and the next
                # transaction records it before accepting any other writes.
                self.record(next_doc, message, source)
            return 200, {"revision": revision(next_doc), "paragraphs": next_doc["paragraphs"]}

    def edit(self, operations, expected, message=None):
        with self.transaction(True) as doc:
            if expected == revision(doc):
                next_doc = apply_operations(doc, operations)
            else:
                base = self.history.find_revision(expected)
                if not base:
                    return 409, {"error": "Document revision changed; read and retry"}
                local = apply_operations(base, operations)
                plan = merge_content(content(base), content(local), content(doc))
                if plan["conflicts"]:
                    return 409, {"error": "Concurrent edit conflict; read and resolve", "conflicts": plan["conflicts"]}
                next_doc = {**doc, **plan["state"]}
                next_doc["paragraphs"] = rebuild(doc, next_doc)
                for key in ("assets", "sources", "uploadDirectory"):
                    if local[key] != base[key]:
                        if doc[key] != base[key] and local[key] != doc[key]:
                            return 409, {"error": "Concurrent resource registration conflict"}
                        next_doc[key] = local[key]
            check_document(next_doc, self.validator)
            if next_doc != doc:
                self.replace(self.local.raw, next_doc)
                self.record(next_doc, message or "Agent edit", "agent")
            return 200, {"revision": revision(next_doc)}

    def restore(self, oid, expected, object_id=None):
        with self.transaction(True) as doc:
            if expected != revision(doc):
                return 409, {"error": "Document revision changed; synchronize before restoring"}
            past = self.history.item(oid)
            if past["id"] != doc["id"]:
                raise ValueError("History identity mismatch")
            if object_id:
                old, current = object_value(past, object_id), object_value(doc, object_id)
                if not old or not current:
                    raise ValueError("Object missing in one version; restore whole document for structural changes")
                next_doc = copy.deepcopy(doc)
                if "node" in old and "node" in current:
                    # Restore content/metadata, keep the current tree position.
                    n = next(n for n in next_doc[current["space"]] if n["id"] == object_id)
                    restored = {**old["node"], **{k: n.get(k) for k in ("parent", "level", "order", "file")}}
                    n.clear()
                    n.update(restored)
                    next_doc["paragraphs"][object_id] = copy.deepcopy(past["paragraphs"].get(object_id, []))
                elif old.get("kind") == current.get("kind") == "paragraph":
                    next_doc = apply_operations(doc, [{"op":"update","id":object_id,"body":old["raw"]}])
                elif "raw" in old and "raw" in current and old["kind"] == current["kind"]:
                    n = next(n for n in next_doc[current["space"]] if n["id"] == current["owner"])
                    m = next(m for m in OBJECT.finditer(n["body"]) if m[2] == object_id)
                    n["body"] = n["body"][:m.start()] + old["raw"] + n["body"][m.end():]
                    next_doc["paragraphs"] = rebuild(doc, next_doc)
                else:
                    raise ValueError("Object type changed")
                # Restore referenced resources if no current mapping exists.
                for key in ("assets", "sources"):
                    next_doc[key] = {**past[key], **next_doc[key]}
            else:
                next_doc = past
            if not paragraph_index_valid(next_doc):
                next_doc["paragraphs"] = rebuild(doc, next_doc)
            check_document(next_doc, self.validator)
            if next_doc != doc:
                self.replace(self.local.raw, next_doc)
                self.record(next_doc, "Restore " + (object_id + " " if object_id else "") + oid[:12], "restore")
            return 200, {"revision": revision(next_doc)}

    def upload(self, name, data):
        if not ASSET.fullmatch(name) or Path(name).suffix.lower() not in IMAGE_TYPES:
            raise ValueError("Invalid asset name")
        with self.transaction(True) as doc:
            if name in doc["assets"]:
                target = Path(doc["assets"][name])
                if target.read_bytes() != data:
                    raise ValueError("Asset collision")
                return
            target = Path(doc["uploadDirectory"]) / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                if target.read_bytes() != data:
                    raise ValueError("Asset collision")
            else:
                with target.open("xb") as f:
                    f.write(data)
                    f.flush()
                    os.fsync(f.fileno())
            next_doc = copy.deepcopy(doc)
            next_doc["assets"][name] = str(target.resolve())
            self.replace(self.local.raw, next_doc)
            self.record(next_doc, "Register image", "editor")

    def asset(self, name):
        with self.transaction() as doc:
            path = doc["assets"].get(name)
            if not path:
                raise FileNotFoundError(name)
            return Path(path).read_bytes()

    def history_list(self, offset=0, limit=100, object_id=None):
        with self.transaction():
            return self.history.list(offset, limit, object_id)

    def history_item(self, oid):
        with self.transaction():
            return self.history.item(oid)

    def tag(self, oid=None, name=None, clear=False, expected=None):
        with self.transaction() as doc:
            if expected and expected != revision(doc):
                raise ValueError("Document revision changed; synchronize before tagging")
            return self.history.tag(oid or self.history.head(), name, clear)

    def scan(self):
        with self.transaction(True) as doc:
            hashes = {}
            for name, filename in doc["assets"].items():
                path = Path(filename)
                try:
                    s = path.stat()
                    signature = (filename, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
                    old = self._resource_cache.get(name)
                    if old and old[0] == signature:
                        h = old[1]
                    else:
                        with path.open("rb") as f:
                            h = hashlib.file_digest(f, "sha256").hexdigest() if hasattr(hashlib, "file_digest") else digest(f.read())
                    self._resource_cache[name] = (signature, h)
                    hashes[name] = h
                except OSError:
                    hashes[name] = None
            if hashes != doc.get("assetHashes", {}):
                next_doc = {**doc, "assetHashes": hashes}
                self.replace(self.local.raw, next_doc)
                self.record(next_doc, "External resource fingerprint update", "external")
            # GC on a separate low-frequency schedule, not each save.
            if time.monotonic() - self._last_gc > 86400 or self._writes_since_gc >= 200:
                self.history.run("gc", "--no-detach", "--prune=never")
                self._last_gc = time.monotonic()
                self._writes_since_gc = 0


def recover_document(filename, validator, oid=None):
    """Explicit recovery only: retain a byte-for-byte copy of corrupt input."""
    filename = Path(filename).resolve()
    lockpath = filename.with_name(filename.name + ".lock")
    historypath = filename.with_name(filename.name + ".history.git")
    if not historypath.is_dir():
        raise FileNotFoundError("No document history")
    with file_lock(lockpath):
        history = History(historypath)
        head = history.current()
        target = history.item(oid) if oid else head
        check_document(target, validator)
        if target["id"] != head["id"]:
            raise ValueError("History identity mismatch")
        raw = filename.read_bytes() if filename.exists() else None
        if raw is not None:
            try:
                check_document(json.loads(raw), validator)
            except (ValueError, TypeError, KeyError, UnicodeError):
                pass
            else:
                raise ValueError("Document is valid; use normal restore")
            backup = filename.with_name(filename.name + ".corrupt-" + uuid.uuid4().hex[:8] + ".backup")
            with backup.open("xb") as f:
                f.write(raw)
                f.flush()
                os.fsync(f.fileno())
            if filename.read_bytes() != raw:
                raise RuntimeError("File changed during recovery")
            readonly(filename, False)
        try:
            replace_bytes(filename, json_bytes(target))
        finally:
            if filename.exists():
                readonly(filename)
        history.append(target, "Recover corrupt document", "restore")
        return {"revision": revision(target), "backup": str(backup) if raw is not None else None}
