"""End-to-end CLI tests through the installed entry point and a real isolated HTTP server."""
import contextlib
import json
import os
import shutil
import stat
import subprocess
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

import server
from document import Document, readonly
from install_cli import install
from paperedit import Client, APIError
from workspace import pack


class CLITests(unittest.TestCase):
    def setUp(self):
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        self.root = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix=".test-cli-", dir=Path(__file__).resolve().parent)))
        stack.enter_context(patch.dict(os.environ, {"PAPEREDITER_HISTORY_DIR": str(self.root / "history")}))
        self.cwd = self.root / "caller dir"
        self.cwd.mkdir()
        for name, value in (("DATA", self.root / "data"), ("CONFIG", self.root / "config.json"), ("DEFAULT_WORKSPACE_DIR", self.root / "workspaces"), ("PACKAGE", None), ("WORKSPACE_ERROR", None)):
            stack.enter_context(patch.object(server, name, value))
        server.initialize_data()
        self.file = self.root / "论文 & 测试.json"
        self.other = self.root / "另一个.json"
        pack(server.DATA, self.file)
        pack(server.DATA, self.other)
        server.open_workspace(str(self.file))
        self.launcher = install(self.root / "bin")
        self.assertEqual(install(self.root / "bin"), self.launcher)
        self.env = dict(os.environ, PATH=str(self.launcher.parent) + os.pathsep + os.environ["PATH"])
        # Exercise the real bare command (CreateProcess searches the parent
        # PATH on Windows, not just the env argument of subprocess.run).
        stack.enter_context(patch.dict(os.environ, {"PATH": self.env["PATH"]}))
        self.assertEqual(Path(shutil.which("paperedit")).resolve(), self.launcher.resolve())

        class QuietHandler(server.Handler):
            def log_message(self, *_):
                pass

        self.http = server.WorkbenchServer(("127.0.0.1", 0), QuietHandler)
        stack.callback(self.http.server_close)
        thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        thread.start()
        stack.callback(thread.join, 5)
        stack.callback(self.http.shutdown)
        self.url = "http://127.0.0.1:" + str(self.http.server_address[1])

    def run_cli(self, *args, raw=None, success=True, explicit=True, offline=False):
        command = ["paperedit", "--url", self.url]
        if offline:
            command.append("--offline")
        if explicit:
            command.extend(["--workspace", str(self.file)])
        result = subprocess.run(command + list(args), cwd=self.cwd, env=self.env, input=raw,
                                capture_output=True, timeout=90)
        if not success:
            self.assertNotEqual(result.returncode, 0)
            return result.stderr.decode("utf-8")
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        if os.name == "nt":
            # A legacy PowerShell code page must not corrupt piped JSON.
            result.stdout.decode("ascii")
        return json.loads(result.stdout)

    def batch(self, revision, operations, *, stdin=False, message="修改说明", success=True, offline=False):
        raw = json.dumps({"revision": revision, "operations": operations}, ensure_ascii=False).encode("utf-8")
        if stdin:
            return self.run_cli("edit", "--file", "-", "-m", message, raw=raw, success=success, offline=offline)
        (self.cwd / "changes 中文.json").write_bytes(raw)
        return self.run_cli("edit", "--file", "changes 中文.json", "-m", message, success=success, offline=offline)

    def test_background_delivery_and_register(self):
        target=self.root/'delivery.json'
        current=self.run_cli('status',explicit=False)['workspace']['id']
        result=self.run_cli('new',str(target),'--background','--blank',explicit=False)
        self.assertNotEqual(result['id'],current)
        self.assertEqual(self.run_cli('status',explicit=False)['workspace']['id'],current)
        self.assertEqual(json.loads(target.read_bytes())['thesis'],[])
        self.run_cli('forget',str(target),explicit=False)
        registered=self.run_cli('register',str(target),explicit=False)
        self.assertEqual(registered['id'],result['id'])
        self.assertEqual(self.run_cli('status',explicit=False)['workspace']['id'],current)

    def test_new_example_and_offline_creation(self):
        target=self.root/'new document.json'
        new=self.run_cli('new',str(target),explicit=False)
        self.assertEqual(self.run_cli('status',explicit=False)['workspace']['id'],new['id'])
        self.assertTrue(self.run_cli('list',explicit=False)['items'])
        self.run_cli('new',str(target),explicit=False,success=False)
        self.run_cli('example',explicit=False,success=False)
        self.run_cli('forget',str(target),explicit=False)
        self.assertTrue(target.exists())
        self.assertEqual(self.run_cli('status',explicit=False)['workspace']['id'],new['id'])
        offline=self.run_cli('new',str(self.root/'offline.json'),explicit=False,offline=True)
        self.assertNotEqual(offline['id'],new['id'])
        self.assertEqual(self.run_cli('status',explicit=False)['workspace']['id'],new['id'])
        auto=self.run_cli('new',explicit=False)
        self.assertEqual(Path(auto['path']).parent,self.root/'workspaces')
        self.assertTrue(Path(auto['path']).is_file())
        self.assertEqual(self.run_cli('status',explicit=False)['workspace']['id'],auto['id'])

    def test_full_online_and_offline_workflow(self):
        for args in ([], ["--help"], ["edit", "--help"], ["restore", "--help"]):
            p = subprocess.run(["paperedit", *args], cwd=self.cwd, env=self.env, capture_output=True, timeout=30)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertIn(b"usage: paperedit", p.stdout)
        initial = self.run_cli("status", explicit=False)
        self.assertEqual(initial["mode"], "api")
        first = initial["head"]["id"]
        rev = initial["revision"]
        # Chinese, emoji and shell metacharacters must survive intact.
        title = "中文 & %PATH% ! 测试"
        body = "第一段😀。\n\n:::equation eq-test\nx=1\n:::\n\n第二段。"
        result = self.batch(rev, [
            {"op":"create", "id":"child", "parent":"demo-start", "title":title, "body":body},
            {"op":"create", "id":"note", "space":"blocks", "title":"知识块", "body":"原始笔记"},
            {"op":"bind", "id":"note", "target":"eq-test"},
        ], message="中文提交 & %PATH% !")
        rev = result["revision"]
        self.assertEqual(self.run_cli("status")["head"]["message"], "中文提交 & %PATH% !")
        self.assertEqual(self.run_cli("read", "child")["value"]["node"]["body"], body)
        self.assertEqual(self.run_cli("read", "child")["value"]["node"]["title"], title)
        self.assertTrue(self.run_cli("search", title)["items"])
        self.assertEqual(self.run_cli("read", "note")["value"]["node"]["objectBindings"], [{"targetId":"eq-test"}])
        items = self.run_cli("list", "--space", "thesis")["items"]
        para = next(x["id"] for x in items if x["kind"] == "paragraph" and x.get("owner") == "child")
        self.assertIn("第一段", self.run_cli("read", para)["value"]["raw"])
        saved = self.run_cli("status")["head"]["id"]
        second = self.batch(rev, [{"op":"update","id":"eq-test","body":"x=2"}], stdin=True)
        # A second writer with an older revision, editing a disjoint object.
        merged = self.batch(rev, [{"op":"update","id":para,"body":"修订段落😀。"}], stdin=True)
        rev2 = merged["revision"]
        self.assertIn("x=2", self.run_cli("read","eq-test")["value"]["raw"])
        self.assertEqual(self.run_cli("read",para)["value"]["raw"], "修订段落😀。")
        self.assertNotEqual(second["revision"],rev2)
        self.assertIn("409", self.batch(rev, [{"op":"update","id":para,"body":"冲突"}], success=False))
        self.assertEqual(self.run_cli("status")["revision"], rev2)
        self.assertIn("第一段", self.run_cli("read",para,"--version",saved)["value"]["raw"])
        self.assertIn("修订段落", self.run_cli("diff",saved,"--object",para)["diff"])
        self.assertGreaterEqual(self.run_cli("history",para)["total"],2)
        self.assertTrue(self.run_cli("history","--limit","1")["more"])
        self.assertEqual(len(self.run_cli("history","--offset","1","--limit","1")["items"]),1)
        # Tag creation, rename and clear must not create a document commit.
        head = self.run_cli("status")["head"]["id"]
        tag = self.run_cli("tag","--name","阶段一😀")["tag"]
        self.assertEqual(tag["name"],"阶段一😀")
        self.assertEqual(self.run_cli("tag",head,"--name","重命名")["tag"]["id"],tag["id"])
        self.assertIsNone(self.run_cli("tag",head,"--clear")["tag"])
        self.assertEqual(self.run_cli("status")["head"]["id"],head)
        # Restore one object without reverting unrelated changes.
        rev3 = self.run_cli("restore",saved,"--object",para,"--revision",rev2)["revision"]
        self.assertIn("第一段", self.run_cli("read",para)["value"]["raw"])
        self.assertIn("x=2", self.run_cli("read","eq-test")["value"]["raw"])
        # Resource operations and tree movement; offline core must also work.
        old = self.root / "resources"
        new = self.root / "moved resources"
        old.mkdir()
        (old / "demo.png").write_bytes(b"synthetic resource")
        (old / "demo.tex").write_text("synthetic", encoding="utf-8")
        rev4 = self.batch(rev3, [
            {"op":"resource","name":"demo.png","path":str(old / "demo.png")},
            {"op":"resource","type":"source","name":"demo.tex","path":str(old / "demo.tex")},
            {"op":"upload-directory","path":str(old / "uploads")},
            {"op":"move","id":"child","parent":None},
        ], offline=True)["revision"]
        self.assertIsNone(self.run_cli("read","child")["value"]["node"]["parent"])
        old.rename(new)
        rev5 = self.batch(rev4, [{"op":"repath","old":str(old),"new":str(new)}])["revision"]
        disk = json.loads(self.file.read_bytes())
        self.assertEqual(Path(disk["assets"]["demo.png"]), new / "demo.png")
        self.assertEqual(Path(disk["sources"]["demo.tex"]), new / "demo.tex")
        self.assertEqual(Path(disk["uploadDirectory"]), new / "uploads")
        # Failed transaction must not leave a partial write.
        self.batch(rev5,[{"op":"update","id":"note","body":"不得保存"},{"op":"move","id":"child","parent":"child"}],success=False)
        self.assertEqual(self.run_cli("read","note")["value"]["node"]["body"],"原始笔记")
        rev6 = self.batch(rev5,[{"op":"update","id":"child","body":body+"\n\n[[embed:note]]"},{"op":"delete","id":"note"}])["revision"]
        disk = json.loads(self.file.read_bytes())
        self.assertEqual(disk["trash"][0]["nodes"][0]["id"],"note")
        self.assertNotIn("[[embed:note]]",self.run_cli("read","child")["value"]["node"]["body"])
        # Delete paragraph/object/section, then restore whole document.
        self.run_cli("read","note",success=False)
        rev7 = self.batch(rev6,[{"op":"delete","id":"eq-test"},{"op":"delete","id":"child"}])["revision"]
        self.run_cli("read","child",success=False)
        self.run_cli("restore",first,"--revision",rev7)
        self.assertEqual(self.run_cli("list","--space","blocks")["items"],[])
        # Explicit inactive file does not switch the online workspace.
        other = Document(self.other, server.validate_document_state)
        p = subprocess.run(["paperedit","--url",self.url,"--workspace",str(self.other),"status"], cwd=self.cwd, env=self.env, capture_output=True, check=True, timeout=90)
        other_status = json.loads(p.stdout)
        self.assertEqual(other_status["mode"],"api")
        self.assertEqual(other_status["revision"],other.state()["revision"])
        r = self.run_cli("status",explicit=False)
        self.assertEqual(Path(r["workspace"]["path"]),self.file)
        switched = self.run_cli("open",str(self.other),explicit=False)
        self.assertEqual(Path(switched["path"]),self.other)
        self.assertEqual(Path(self.run_cli("status",explicit=False)["workspace"]["path"]),self.other)
        self.assertEqual(self.run_cli("status")["mode"],"api")
        # Corruption recovery saves original bytes, and never touches the other document.
        before = self.file.read_bytes()
        readonly(self.file,False)
        self.file.write_bytes(b"broken test JSON")
        result = self.run_cli("recover")
        self.assertEqual(Path(result["backup"]).read_bytes(),b"broken test JSON")
        self.assertEqual(self.file.read_bytes(),before)
        self.assertFalse(self.file.stat().st_mode & stat.S_IWUSR)
        self.run_cli("recover",success=False)

    def test_connection_failures_and_invalid_workspaces(self):
        before = self.file.read_bytes()
        with patch.object(Client, "request", side_effect=APIError(500,"test error")):
            with self.assertRaises(APIError):
                Client(str(self.file), self.url)
        with patch.object(Client, "request", side_effect=APIError(409,"no active document")):
            with self.assertRaises(APIError):
                Client(None,self.url)
        with patch.object(Client, "request", side_effect=urllib.error.URLError(TimeoutError("test timeout"))):
            with self.assertRaises(urllib.error.URLError):
                Client(str(self.file),self.url)
        with patch.object(Client, "request", side_effect=urllib.error.URLError(ConnectionRefusedError("test refusal"))):
            self.assertIsNotNone(Client(str(self.file),self.url).doc)
            with self.assertRaises(urllib.error.URLError):
                Client(str(self.file),"http://192.0.2.1:8191")
        with patch.object(Client, "request", return_value={"workspace":{"id":"directory"}}):
            with self.assertRaises(ValueError):
                Client(None,self.url)
        with self.assertRaises(ValueError):
            Client("relative.json",self.url)
        self.run_cli("open",str(self.root / "missing.json"),success=False,explicit=False)
        self.assertEqual(Path(self.run_cli("status",explicit=False)["workspace"]["path"]),self.file)
        self.assertEqual(self.file.read_bytes(),before)

    def test_encoding_loss_rejected_atomically(self):
        initial = self.run_cli("status")
        original = self.run_cli("read","demo-start")["value"]["node"]["body"]
        corrupted = original.encode("ascii","replace").decode("ascii")
        self.assertNotEqual(original,corrupted)
        for offline in (False, True):
            error = self.batch(initial["revision"],[
                {"op":"create","id":"would-be-partial","title":"Do not save"},
                {"op":"update","id":"demo-start","body":corrupted},
            ],stdin=True,success=False,offline=offline)
            self.assertIn("Possible encoding loss",error)
            self.assertEqual(self.run_cli("status")["head"]["id"],initial["head"]["id"])
            self.assertEqual(self.run_cli("read","demo-start")["value"]["node"]["body"],original)
        self.run_cli("read","would-be-partial",success=False)
        good = original + "\n\n中文与普通问号？ ?? OK?"
        rev = self.batch(initial["revision"],[{"op":"update","id":"demo-start","body":good}],stdin=True)["revision"]
        self.assertEqual(self.run_cli("read","demo-start")["value"]["node"]["body"],good)
        # Browser saves use the same guard; no revision or history change.
        s = server.state()
        s["thesis"][0]["body"] = good.encode("ascii","replace").decode("ascii")
        with self.assertRaisesRegex(ValueError,"Possible encoding loss"):
            server.save(s)
        self.assertEqual(self.run_cli("status")["revision"],rev)


if __name__ == "__main__":
    unittest.main()
