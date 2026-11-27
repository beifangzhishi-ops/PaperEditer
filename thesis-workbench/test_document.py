import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server
from document import Document, readonly, revision, content, recover_document, annotation_locations
from workspace import pack


class CLIHelpTests(unittest.TestCase):
    def test_no_arguments_prints_help(self):
        script = Path(__file__).with_name("paperedit.py")
        empty = subprocess.run([sys.executable, str(script)], capture_output=True)
        explicit = subprocess.run([sys.executable, str(script), "--help"], capture_output=True)
        self.assertEqual(empty.returncode, 0)
        self.assertEqual(empty.stderr, b"")
        self.assertEqual(empty.stdout, explicit.stdout)
        self.assertIn(b"usage: paperedit", empty.stdout)


class DocumentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix=".test-v3-", dir=Path(__file__).resolve().parent)
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        scope = patch.dict(os.environ, {"PAPEREDITER_HISTORY_DIR": str(self.root / "history")})
        scope.start(); self.addCleanup(scope.stop)
        self.data = self.root / "data"
        p = patch.object(server, "DATA", self.data)
        p.start()
        self.addCleanup(p.stop)
        server.initialize_data()
        self.file = self.root / "demo.json"
        self.old = pack(self.data, self.file)
        with patch.object(server, "PACKAGE", self.old):
            state = server.state()
            state["thesis"][0]["body"] = "First.\n\n:::equation eq-test\nx=1\n:::\n"
            self.assertEqual(server.save(state)[0], 200)
            state = server.state()
            state["thesis"][0]["body"] += "\nLast.\n"
            self.assertEqual(server.save(state)[0], 200)
        self.original = self.file.read_bytes()
        self.doc = Document(self.file, server.validate_document_state)

    def test_migration_history_and_tag(self):
        doc = json.loads(self.file.read_bytes())
        self.assertEqual(doc["version"], 3)
        self.assertNotIn("id", doc)
        self.assertEqual(self.doc.historypath.parent,self.root / "history")
        self.assertTrue(doc["thesis"][0]["body"].endswith("Last.\n"))
        self.assertEqual(len(list(self.root.glob("*.backup"))), 1)
        self.assertEqual(next(self.root.glob("*.backup")).read_bytes(), self.original)
        rows = self.doc.history_list()["items"]
        self.assertEqual(len(rows), 3)
        self.assertEqual(self.doc.history_item(rows[0]["id"]), doc)
        self.assertEqual(len(self.doc.history_list(object_id="eq-test")["items"]), 1)
        self.assertEqual(self.doc.history.run("remote"), b"")
        self.doc.history.run("fsck", "--full")
        tag = self.doc.tag(name="Named version")
        self.assertEqual(self.doc.tag()["id"], tag["id"])
        renamed = self.doc.tag(rows[0]["id"], "Renamed")
        self.assertEqual(renamed["id"], tag["id"])
        self.assertEqual(self.doc.history_list()["items"][0]["tag"]["name"], "Renamed")
        self.doc.tag(rows[0]["id"], clear=True)
        self.assertIsNone(self.doc.history_list()["items"][0]["tag"])
        self.assertFalse(self.file.stat().st_mode & stat.S_IWUSR)

    def test_save_edit_restore_and_external_scan(self):
        initial = self.doc.state()
        old_head = self.doc.history_list()["items"][0]["id"]
        code, result = self.doc.edit([{"op":"update","id":"eq-test","body":"x=2"}], initial["revision"], "Equation change")
        self.assertEqual(code, 200)
        self.assertEqual(self.doc.edit([{"op":"update","id":"eq-test","body":"x=3"}], initial["revision"])[0], 409)
        other = Document(self.file, server.validate_document_state)
        self.assertIn("x=2", other.state()["thesis"][0]["body"])
        self.assertEqual(other.restore(old_head, result["revision"], "eq-test")[0], 200)
        self.assertIn("x=1", self.doc.state()["thesis"][0]["body"])
        self.assertEqual(len(self.doc.history_list()["items"]), 5)
        current = json.loads(self.file.read_bytes())
        current["thesis"][0]["body"] += "\nExternal edit."
        readonly(self.file, False)
        self.file.write_text(json.dumps(current), encoding="utf-8")
        self.doc.scan()
        self.assertEqual(self.doc.history_list()["items"][0]["source"], "external")
        self.assertFalse(self.file.stat().st_mode & stat.S_IWUSR)
        latest = self.doc.state()
        self.assertEqual(self.doc.save(latest)[0], 200)
        self.assertEqual(len(self.doc.history_list()["items"]), 6)
        self.assertEqual(self.doc.restore(old_head, latest["revision"])[0], 200)
        self.assertNotIn("External edit", self.doc.state()["thesis"][0]["body"])

    def test_shared_merge_paragraph_identity_and_stale_agent(self):
        initial = self.doc.state()
        owner = initial["thesis"][0]["id"]
        paragraph = initial["paragraphs"][owner][0]["id"]
        self.assertEqual(self.doc.edit([dict(op="update",id="eq-test",body="x=5")],initial["revision"])[0],200)
        # A stale but disjoint change can merge without clobbering the equation.
        self.assertEqual(self.doc.edit([dict(op="update",id=paragraph,body="Edited paragraph.")],initial["revision"])[0],200)
        state = self.doc.state()
        self.assertIn("x=5",state["thesis"][0]["body"])
        self.assertIn("Edited paragraph.",state["thesis"][0]["body"])
        self.assertEqual(state["paragraphs"][owner][0]["id"],paragraph)
        self.assertGreaterEqual(self.doc.history_list(object_id=paragraph)["total"],2)
        self.assertEqual(self.doc.edit([dict(op="update",id=paragraph,body="Other edit.")],initial["revision"])[0],409)

    def test_cli_offline_and_batch(self):
        script = Path(__file__).with_name("paperedit.py")
        def cli(*args):
            p = subprocess.run([sys.executable, str(script), "--offline", "--workspace", str(self.file), *args], capture_output=True, check=True)
            return json.loads(p.stdout)
        state = cli("status")
        batch = self.root / "batch.json"
        batch.write_text(json.dumps(dict(revision=state["revision"], operations=[
            dict(op="create", space="blocks", id="note", title="Note", body="A note"),
            dict(op="bind", id="note", target="eq-test"),
        ])), encoding="utf-8")
        cli("edit", "--file", str(batch), "-m", "Create note")
        self.assertEqual(cli("read", "note")["value"]["node"]["objectBindings"], [{"targetId":"eq-test"}])
        self.assertEqual(cli("history", "note")["total"], 1)
        self.assertEqual(cli("status")["head"]["message"], "Create note")
        before = self.doc.state()
        with self.assertRaises(ValueError):
            self.doc.edit([dict(op="update",id="note",body="Not committed"),dict(op="move",id="note",parent="note")], before["revision"])
        self.assertEqual(self.doc.state(), before)

    def test_annotation_single_placement_and_legacy_migration(self):
        initial = self.doc.state()
        chapter = initial['thesis'][0]['id']
        operations = [dict(op='create', space='blocks', id='single-note', title='Note', body='Note content'), dict(op='bind', id='single-note', target='eq-test')]
        self.assertEqual(self.doc.edit(operations, initial['revision'])[0], 200)
        before = self.doc.state()
        with self.assertRaisesRegex(ValueError, 'only one placement'):
            self.doc.edit([dict(op='bind', id='single-note', target=chapter)], before['revision'])
        duplicate = content(before)
        duplicate['revision'] = before['revision']
        duplicate['thesis'][0]['body'] += '\n\n[[embed:single-note]]\n'
        with self.assertRaisesRegex(ValueError, 'only one placement'):
            self.doc.save(duplicate)
        self.assertEqual(self.doc.state(), before)
        # Simulate a legacy on-disk document in the isolated test directory.
        raw = json.loads(self.file.read_bytes())
        raw['thesis'][0]['body'] += '\n\n[[embed:single-note]]\n'
        readonly(self.file, False)
        self.file.write_text(json.dumps(raw), encoding='utf-8')
        opened = Document(self.file, server.validate_document_state)
        result = opened.state()
        copies = [n for n in result['blocks'] if n['body'] == 'Note content']
        self.assertEqual(len(copies), 2)
        self.assertEqual({len(annotation_locations(result)[n['id']]) for n in copies}, {1})
        self.assertEqual(opened.history_list()['items'][0]['source'], 'migration')

    def test_legacy_v3_history_migration_preserves_commits_and_tags(self):
        from document import History
        import uuid
        path=self.root/'legacy.json'
        doc=json.loads(self.file.read_bytes())
        doc['id']=uuid.uuid4().hex
        path.write_text(json.dumps(doc),encoding='utf-8')
        legacy=path.with_name(path.name+'.history.git')
        repo=History(legacy)
        oid=repo.append(doc,'old version')
        tag=repo.tag(oid,'old tag')
        migrated=Document(path,server.validate_document_state)
        self.assertEqual(migrated.id,doc['id'])
        self.assertFalse(legacy.exists())
        self.assertNotIn('id',json.loads(path.read_bytes()))
        self.assertEqual(migrated.history.item(oid),doc)
        self.assertEqual(migrated.history.tags()[oid],tag)
        self.assertEqual(migrated.restore(oid,migrated.state()['revision'])[0],200)
        self.assertNotIn('id',json.loads(path.read_bytes()))
        migrated.history.run('fsck','--full')

    def test_resource_registration_and_invalid_external_change(self):
        image = self.root / "image.png"
        image.write_bytes(b"test")
        self.doc.edit([dict(op="resource",name="x.png",path=str(image))],self.doc.state()["revision"])
        self.assertEqual(self.doc.asset("x.png"), b"test")
        self.assertEqual(json.loads(self.file.read_bytes())["assets"]["x.png"], str(image))
        with self.assertRaises(FileNotFoundError):
            self.doc.asset("other.png")
        readonly(self.file, False)
        self.file.write_bytes(b"invalid")
        with self.assertRaises(ValueError):
            self.doc.scan()
        self.assertEqual(self.file.read_bytes(), b"invalid")
        result = recover_document(self.file, server.validate_document_state)
        self.assertEqual(Path(result["backup"]).read_bytes(), b"invalid")
        self.assertEqual(self.doc.state()["revision"],result["revision"])


if __name__ == "__main__":
    unittest.main()
