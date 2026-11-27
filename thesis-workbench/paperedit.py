"""PaperEditer CLI. Active documents use the API; explicit inactive files use the same locked core."""
import argparse
import difflib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import server
from document import Document, objects, object_value, revision, recover_document


class APIError(RuntimeError):
    def __init__(self, status, message):
        self.status = status
        super().__init__("HTTP " + str(status) + ": " + message)


class Client:
    def __init__(self, filename, url, offline=False):
        self.url = url.rstrip("/")
        self.info = None
        self.doc = None
        self.scoped = False
        if filename is not None:
            filename = str(server.workspace_path(filename))
        local_url = urllib.parse.urlparse(self.url).hostname in ("127.0.0.1", "localhost", "::1")
        if not offline:
            try:
                if filename and local_url:
                    result = self.request("/api/document", {"path": filename, "action": "state"})
                    self.info = result["workspace"]
                    self.scoped = True
                else:
                    active = self.request("/api/state")
                    if active.get("workspace", {}).get("history"):
                        info = active["workspace"]
                        if filename is None or Path(filename).resolve() == Path(info["path"]).resolve():
                            self.info = info
                    if self.info is None:
                        raise ValueError("No active single-file document; specify --workspace")
            except urllib.error.URLError as exc:
                # Only a refused local connection may fall back to the core.
                if not local_url or not isinstance(exc.reason, ConnectionRefusedError):
                    raise
        if self.info is None:
            filename = filename or server.settings_load().get("workspace")
            if not filename:
                raise ValueError("Specify --workspace with an absolute JSON path")
            self.doc = Document(server.workspace_path(str(filename)), server.validate_document_state)
            self.info = dict(id=self.doc.id, path=str(self.doc.filename), name=self.doc.filename.name, history=True)

    def request(self, endpoint, payload=None):
        headers = {"Accept": "application/json"}
        if self.info:
            headers["X-PaperEditer-Workspace"] = self.info["id"]
        if payload is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.url + endpoint, data=json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            try:
                result = json.load(e)
                message = json.dumps(result, ensure_ascii=False) if result.get("conflicts") else result.get("error", str(e))
            except Exception:
                message = str(e)
            raise APIError(e.code, message) from e

    def query(self, endpoint, **params):
        return self.request(endpoint + "?" + urllib.parse.urlencode(dict(workspace=self.info["id"], **{k:v for k,v in params.items() if v is not None})))

    def scoped_request(self, action, **params):
        return self.request("/api/document", dict(path=self.info["path"], id=self.info["id"], action=action, **params))

    def state(self):
        if self.scoped:return self.scoped_request("state")
        if self.doc:
            return self.doc.state()
        state = self.request("/api/state")
        if state.get("workspace", {}).get("id") != self.info["id"]:
            raise RuntimeError("Active workspace changed; use --workspace and retry")
        return state

    def history(self, offset=0, limit=100, object_id=None):
        if self.scoped:return self.scoped_request("history", offset=offset, limit=limit, object=object_id)
        if self.doc:
            return self.doc.history_list(offset, limit, object_id)
        return self.query("/api/history", offset=offset, limit=limit, object=object_id)

    def item(self, oid):
        if self.scoped:return self.scoped_request("item", version=oid)
        return self.doc.history_item(oid) if self.doc else self.query("/api/history/item", id=oid)

    def edit(self, operations, expected, message):
        if self.scoped:return self.scoped_request("edit", operations=operations, revision=expected, message=message)
        if self.doc:
            code, result = self.doc.edit(operations, expected, message)
            if code != 200:
                raise RuntimeError(json.dumps(result, ensure_ascii=False))
            return result
        return self.request("/api/cli/edit", dict(operations=operations, revision=expected, message=message))

    def tag(self, oid=None, name=None, clear=False, expected=None):
        if self.scoped:return self.scoped_request("tag", version=oid, name=name, clear=clear, revision=expected)["tag"]
        if self.doc:
            return self.doc.tag(oid, name, clear, expected)
        return self.request("/api/history/tag", dict(id=oid, name=name, clear=clear, revision=expected))["tag"]

    def restore(self, oid, expected, object_id):
        if self.scoped:return self.scoped_request("restore", version=oid, revision=expected, object=object_id)
        if self.doc:
            code, result = self.doc.restore(oid, expected, object_id)
            if code != 200:
                raise RuntimeError(result["error"])
            return result
        return self.request("/api/history/restore", dict(id=oid, revision=expected, object=object_id))


def emit(value):
    # Windows PowerShell 5 decodes native pipes using its console codepage.
    # Escaped JSON remains lossless even if the caller does not select UTF-8.
    escaped = os.name == "nt" and not sys.stdout.isatty()
    sys.stdout.buffer.write((json.dumps(value, ensure_ascii=escaped, indent=2) + "\n").encode("utf-8"))


def main():
    parser = argparse.ArgumentParser(prog="paperedit", description=__doc__)
    parser.add_argument("--workspace", help="Absolute server-side path; does not change web selection")
    parser.add_argument("--url", default=os.environ.get("PAPEREDITER_URL", "http://127.0.0.1:" + os.environ.get("PAPEREDITER_PORT", "8191")))
    parser.add_argument("--offline", action="store_true", help="Use the shared locked document core directly")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("open", help="Explicitly change active web workspace")
    p.add_argument("path")
    p = sub.add_parser("new", help="Create and open an example document; omit path to use the private project workspaces directory")
    p.add_argument("path", nargs="?", default="")
    p.add_argument("--background", action="store_true", help="Register without switching the web document")
    p.add_argument("--blank", action="store_true", help="Create an empty delivery document")
    p = sub.add_parser("register", help="Register an existing document without switching the web document")
    p.add_argument("path")
    p = sub.add_parser("forget", help="Remove an exact path from recent opens without deleting the file")
    p.add_argument("path")
    sub.add_parser("status", help="Show current workspace, revision and history head")
    p = sub.add_parser("list", help="List sections, blocks, paragraphs and objects")
    p.add_argument("--space", choices=["thesis", "blocks"])
    p = sub.add_parser("search", help="Search document content")
    p.add_argument("query")
    p.add_argument("--space", choices=["thesis", "blocks"])
    p = sub.add_parser("read", help="Read an object by ID, optionally at a history commit")
    p.add_argument("id")
    p.add_argument("--version")
    p = sub.add_parser("edit", help="Apply an atomic revision-checked JSON batch")
    p.add_argument("--file", required=True, help="JSON operation batch with revision and operations; - for stdin")
    p.add_argument("--revision")
    p.add_argument("-m", "--message")
    p = sub.add_parser("history", help="List document or object history")
    p.add_argument("id", nargs="?")
    p.add_argument("--offset", type=int, default=0)
    p.add_argument("--limit", type=int, default=100)
    p = sub.add_parser("diff", help="Compare two versions, or a version with current content")
    p.add_argument("version")
    p.add_argument("other", nargs="?")
    p.add_argument("--object")
    p = sub.add_parser("tag", help="Name, rename or clear a version")
    p.add_argument("version", nargs="?")
    p.add_argument("--name")
    p.add_argument("--clear", action="store_true")
    p.add_argument("--revision")
    p = sub.add_parser("restore", help="Restore a document or object with revision verification")
    p.add_argument("version")
    p.add_argument("--object")
    p.add_argument("--revision", required=True)
    p = sub.add_parser("recover", help="Explicit recovery of a damaged or missing document; retains original bytes")
    p.add_argument("--version")
    if len(sys.argv) == 1:
        parser.print_help()
        return
    args = parser.parse_args()
    if args.command in ("open", "new", "forget", "register"):
        if args.offline:
            if args.command != "new":
                raise ValueError("Opening a web workspace requires the service")
            doc = server.create_workspace(args.path, args.blank)
            emit(dict(id=doc.id, path=str(doc.filename), name=doc.filename.name, history=True))
            return
        c = object.__new__(Client)
        c.url, c.info = args.url.rstrip("/"), None
        payload = {"path": args.path}
        if args.command == "new":
            payload.update(background=args.background, blank=args.blank)
        emit(c.request("/api/workspaces/" + args.command, payload))
        return
    if args.command == "recover":
        if not args.workspace:
            raise ValueError("Recover requires --workspace with an explicit absolute path")
        emit(recover_document(server.workspace_path(args.workspace), server.validate_document_state, args.version))
        return
    c = Client(args.workspace, args.url, args.offline)
    cmd = args.command
    if cmd == "status":
        state = c.state()
        history = c.history(limit=1)
        emit(dict(workspace=c.info, revision=state["revision"], head=history["items"][0] if history["items"] else None, mode="local-core" if c.doc else "api", protected=True))
    elif cmd in ("list", "search"):
        state = c.state()
        rows = []
        for obj in objects(state):
            if args.space and obj["space"] != args.space:
                continue
            body = obj.pop("body")
            if cmd == "search":
                haystack = (obj.get("title", "") + "\n" + body)
                index = haystack.casefold().find(args.query.casefold())
                if index < 0:
                    continue
                obj["excerpt"] = haystack[max(0, index - 80):index + len(args.query) + 120]
            rows.append(obj)
        emit(dict(revision=state["revision"], items=rows))
    elif cmd == "read":
        state = c.item(args.version) if args.version else c.state()
        value = object_value(state, args.id)
        if value is None:
            raise ValueError("Object not found")
        emit(dict(revision=revision(state) if args.version else state["revision"], value=value))
    elif cmd == "edit":
        # Decode the byte stream as JSON (UTF-8/16/32 with optional BOM),
        # independently of the Windows console's legacy text encoding.
        batch = json.loads(sys.stdin.buffer.read()) if args.file == "-" else json.loads(Path(args.file).read_text(encoding="utf-8-sig"))
        operations = batch if isinstance(batch, list) else batch["operations"]
        expected = args.revision or (batch.get("revision") if isinstance(batch, dict) else None)
        if not expected:
            raise ValueError("Edit requires the revision returned by read/list/status; do not guess")
        emit(c.edit(operations, expected, args.message))
    elif cmd == "history":
        emit(c.history(max(0, args.offset), min(200, max(1, args.limit)), args.id))
    elif cmd == "diff":
        a, b = c.item(args.version), c.item(args.other) if args.other else c.state()
        if args.object:
            a, b = object_value(a, args.object), object_value(b, args.object)
        else:
            a, b = {k:a[k] for k in ("thesis", "blocks", "trash")}, {k:b[k] for k in ("thesis", "blocks", "trash")}
        text = "".join(difflib.unified_diff(json.dumps(a, ensure_ascii=False, indent=2).splitlines(True), json.dumps(b, ensure_ascii=False, indent=2).splitlines(True), fromfile=args.version, tofile=args.other or "current"))
        emit({"diff": text})
    elif cmd == "tag":
        expected = args.revision
        if not args.version and not expected:
            expected = c.state()["revision"]
        emit({"tag": c.tag(args.version, args.name, args.clear, expected)})
    elif cmd == "restore":
        emit(c.restore(args.version, args.revision, args.object))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        message = str(e)
        if os.name == "nt" and not sys.stderr.isatty():
            message = message.encode("ascii", "backslashreplace").decode("ascii")
        sys.stderr.buffer.write((message + "\n").encode("utf-8"))
        sys.exit(1)
