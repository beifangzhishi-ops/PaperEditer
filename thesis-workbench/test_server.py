import tempfile
import json
import sqlite3
import contextlib
import hashlib
import unittest
from pathlib import Path
from unittest.mock import patch

import server
from workspace import Package, pack, unpack, migrate


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='.test-data-', dir=Path(__file__).resolve().parent)
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "data"
        self.context = patch.object(server, "DATA", self.data)
        self.context.start()
        self.addCleanup(self.context.stop)

    def test_initialization_and_save(self):
        server.initialize_data()
        state = server.state()
        self.assertEqual(len(state["thesis"]), 1)
        self.assertEqual(state["blocks"], [])
        state["thesis"][0]["body"] = "Example edit.\n"
        code, result = server.save(state)
        self.assertEqual(code, 200)
        self.assertNotEqual(result["revision"], state["revision"])
        self.assertEqual(server.state()["thesis"][0]["body"], "Example edit.\n")
        self.assertEqual(len(list((self.data / "history").glob("*.json"))), 1)
        server.initialize_data()
        self.assertEqual(server.state()["thesis"][0]["body"], "Example edit.\n")
        self.assertEqual(server.save(state)[0], 409)

    def test_incomplete_workspace_is_not_overwritten(self):
        self.data.mkdir()
        sentinel = self.data / "outline.json"
        sentinel.write_text("[]", encoding="utf-8")
        with self.assertRaises(RuntimeError):
            server.initialize_data()
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "[]")
        self.assertFalse((self.data / "blocks.json").exists())

    def test_blank_thesis_node_round_trip(self):
        server.initialize_data()
        package=pack(self.data,Path(self.tmp.name)/'blank.paper')
        with patch.object(server,'PACKAGE',package):
            s=server.state()
            s['thesis'].append(dict(id='blank',title='',body='',parent='demo-start',level=2,order=1,file='thesis/blank.md'))
            self.assertEqual(server.save(s)[0],200)
        with patch.object(server,'PACKAGE',Package(package.filename)):
            s=server.state()
            self.assertEqual((s['thesis'][-1]['title'],s['thesis'][-1]['body']),('',''))
            s['thesis'][-1]['title']='Filled title'
            self.assertEqual(server.save(s)[0],200)

    def test_invalid_path(self):
        server.initialize_data()
        with self.assertRaises(ValueError):
            server.path({"file": "../outside.md"}, "thesis")

    def test_trash_persists_in_paper_and_restores(self):
        server.initialize_data()
        package=pack(self.data,Path(self.tmp.name)/"trash.paper")
        with patch.object(server,"PACKAGE",package):
            s=server.state()
            n=dict(id='note',title='Note',parent=None,level=1,order=0,file='blocks/note.md',body='Content')
            s['blocks']=[n]
            self.assertEqual(server.save(s)[0],200)
            s=server.state();s['trash']=[dict(id='deleted',deletedAt='2026-11-25T00:00:00Z',nodes=s['blocks'],anchors=[dict(owner='demo-start',at=0,left='',right='',token='[[ref:note]][[eqref:note-eq]][[embed:note]]')],bindings=[dict(owner='other-note',field='objectBindings',values=[dict(targetId='note-eq')])])]
            s['blocks']=[]
            self.assertEqual(server.save(s)[0],200)
        with patch.object(server,"PACKAGE",Package(package.filename)):
            s=server.state();self.assertEqual(s['trash'][0]['nodes'][0]['body'],'Content')
            self.assertEqual(s['trash'][0]['anchors'][0]['token'],'[[ref:note]][[eqref:note-eq]][[embed:note]]')
            self.assertEqual(s['trash'][0]['bindings'][0]['values'],[{'targetId':'note-eq'}])
            s['blocks']=s['trash'][0]['nodes'];s['trash']=[]
            self.assertEqual(server.save(s)[0],200)
            self.assertEqual(server.state()['blocks'][0]['id'],'note')
            self.assertEqual(server.state()['trash'],[])

    def test_package_save_and_round_trip(self):
        server.initialize_data()
        original=server.state()
        package=pack(self.data,Path(self.tmp.name)/"example.paper")
        self.assertEqual(package.manifest(),{
            f.relative_to(self.data).as_posix():__import__('hashlib').sha256(f.read_bytes()).hexdigest()
            for f in self.data.rglob("*") if f.is_file()
        })
        index = json.loads(package.filename.read_text(encoding="utf-8"))
        self.assertEqual(index["format"], "paperediter")
        self.assertTrue((package.filename.parent / index["files"]["thesis/demo-start.md"]).is_file())
        self.assertTrue(any(o["type"] == "section" for o in index["objects"]))
        with patch.object(server,"PACKAGE",package):
            self.assertEqual(server.state(),original)
            original["thesis"][0]["body"]="Saved in referenced Markdown.\n"
            self.assertEqual(server.save(original)[0],200)
            self.assertEqual(server.save(original)[0],409)
            self.assertEqual(len(server.glob_data(self.data/"history","*.json")),1)
            self.assertEqual(server.state()["thesis"][0]["body"],"Saved in referenced Markdown.\n")
        export=Path(self.tmp.name)/"export"
        unpack(Package(package.filename),export)
        self.assertEqual((export/"thesis/demo-start.md").read_text(encoding="utf-8"),"Saved in referenced Markdown.\n")

    def test_direct_reference_and_rollback(self):
        server.initialize_data()
        root=Path(self.tmp.name)
        external=root/"existing.md"
        external.write_text("Existing text",encoding="utf-8")
        p=pack(self.data,root/"test.paper")
        p.reference("blocks/existing.md",external)
        self.assertEqual(p.read("blocks/existing.md"),b"Existing text")
        with self.assertRaises(RuntimeError):
            with p.transaction(True):
                p.write("blocks/existing.md",b"Not saved")
                p.write("blocks/new.md",b"Not saved")
                raise RuntimeError("abort")
        self.assertEqual(external.read_bytes(),b"Existing text")
        self.assertFalse(p.exists("blocks/new.md"))
        p.write("blocks/existing.md",b"Edited directly")
        self.assertEqual(external.read_bytes(),b"Edited directly")
        with self.assertRaises(ValueError):
            p.read("../outside")

    def test_legacy_migration_preserves_bytes_and_reuses_image(self):
        server.initialize_data()
        root=Path(self.tmp.name)
        existing=root/"existing.png"
        existing.write_bytes(b"image bytes")
        (self.data/"assets"/"a.png").write_bytes(existing.read_bytes())
        (self.data/"assets.json").write_text(json.dumps({"a.png":"existing.png"}),encoding="utf-8")
        (self.data/"import-report.json").write_text(json.dumps({"source":str(root)}),encoding="utf-8")
        legacy=root/"old.paper"
        rows={f.relative_to(self.data).as_posix():f.read_bytes() for f in self.data.rglob("*") if f.is_file()}
        with contextlib.closing(sqlite3.connect(legacy)) as db, db:
            db.execute("PRAGMA application_id=1346458693")
            db.execute("CREATE TABLE entries(name TEXT PRIMARY KEY,data BLOB NOT NULL)")
            db.executemany("INSERT INTO entries VALUES (?,?)",rows.items())
        p=migrate(legacy,root/"new.paper")
        self.assertEqual(p.manifest(),{k:hashlib.sha256(v).hexdigest() for k,v in rows.items()})
        index=json.loads(p.filename.read_text(encoding="utf-8"))
        self.assertEqual(index["files"]["assets/a.png"],"existing.png")
        self.assertTrue(legacy.read_bytes().startswith(b"SQLite format 3"))
        with self.assertRaises(ValueError):
            p.write("assets/a.png",b"replacement")

    def test_open_remembers_file_and_rejects_invalid(self):
        server.initialize_data()
        root=Path(self.tmp.name)
        first=pack(self.data,root/"first.paper")
        second=pack(self.data,root/"second.paper")
        with patch.object(server,"PACKAGE",first),patch.object(server,"CONFIG",root/"settings.json"),patch.object(server,"WORKSPACE_ERROR",None):
            result=server.open_workspace(str(second.filename))
            self.assertEqual(result["name"],"second.paper")
            self.assertEqual(server.load(root/"settings.json")["workspace"],str(second.filename))
            self.assertEqual([x['path'] for x in server.workspace_catalog()['files']],[str(second.filename)])
            position={'view':'thesis','active':0,'open':[],'panes':[{'id':'demo-start','reading':{'top':120}}]}
            server.save_reading(position)
            self.assertEqual(server.reading_position(),position)
            with self.assertRaises(ValueError):
                server.open_workspace("../first.paper")
            with self.assertRaises(FileNotFoundError):
                server.open_workspace(str(root/"missing.paper"))
            self.assertEqual(server.workspace_info()["name"],"second.paper")
            server.open_workspace(str(first.filename))
            self.assertIsNone(server.reading_position())
            server.open_workspace(str(second.filename))
            self.assertEqual(server.reading_position(),position)
            self.assertEqual([x['path'] for x in server.workspace_catalog()['files']],[str(second.filename),str(first.filename)])
            self.assertNotIn('roots',server.settings_load())


if __name__ == "__main__":
    unittest.main()
