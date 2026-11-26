import tempfile
import json
import sqlite3
import contextlib
import hashlib
import threading
import urllib.request
import urllib.parse
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

    def test_create_and_open_builtin_example(self):
        from document import EXAMPLE_IMAGE, EXAMPLE_IMAGE_PATH, objects
        root=Path(self.tmp.name)
        template=server.ROOT/'example.json'
        original=template.read_bytes()
        with patch.object(server,'CONFIG',root/'settings.json'), patch.object(server,'PACKAGE',None), patch.object(server,'WORKSPACE_ERROR',None):
            new=root/'new.json'
            info=server.new_workspace(str(new))
            self.assertEqual(info['path'],str(new))
            self.assertEqual(len(server.state()['thesis']),2)
            self.assertEqual(len(server.state()['blocks']),4)
            self.assertEqual(server.state()['trash'],[])
            self.assertEqual(server.PACKAGE.history_list()['total'],1)
            before=new.read_bytes()
            for invalid in (str(new),'relative.json',str(root/'missing'/'new.json'),str(root/'bad.txt')):
                with self.assertRaises((ValueError,FileExistsError,FileNotFoundError)):
                    server.new_workspace(invalid)
                self.assertEqual(server.workspace_info(),info)
            self.assertEqual(new.read_bytes(),before)
            orphan=root/'orphan.json'
            orphan.with_name(orphan.name+'.history.git').mkdir()
            with self.assertRaises(FileExistsError):server.new_workspace(str(orphan))
            self.assertFalse(orphan.exists())
            second=root/'second.json'
            example=server.new_workspace(str(second))
            self.assertNotEqual(example['id'],info['id'])
            sample=server.state()
            self.assertEqual({x['kind'] for x in objects(sample)}, {'section','block','paragraph','equation','figure','table'})
            self.assertIn('wb-id:demo-subfig-2',sample['thesis'][0]['body'])
            self.assertIn('[[embed:demo-independent]]',sample['thesis'][1]['body'])
            self.assertTrue(any(n.get('objectBindings') for n in sample['blocks']))
            self.assertTrue(any(n.get('annotation') for n in sample['blocks']))
            self.assertTrue(any(n.get('freePlacements') for n in sample['blocks']))
            self.assertEqual(server.PACKAGE.asset(EXAMPLE_IMAGE),EXAMPLE_IMAGE_PATH.read_bytes())
            self.assertEqual(json.loads(new.read_bytes())['thesis'],sample['thesis'])
            self.assertEqual(template.read_bytes(),original)
            server.open_workspace(str(new))
            state=server.state();state['thesis']=[dict(id='copied',title='',body=sample['thesis'][0]['body'],parent=None,level=1,order=0,file='thesis/copied.md')]
            self.assertEqual(server.PACKAGE.asset(EXAMPLE_IMAGE),EXAMPLE_IMAGE_PATH.read_bytes())
            self.assertEqual(server.save(state)[0],200)
            self.assertEqual(json.loads(new.read_bytes())['assets'][EXAMPLE_IMAGE],str(EXAMPLE_IMAGE_PATH.resolve()))
            self.assertEqual(server.workspace_catalog()['files'][0]['path'],str(new))
            self.assertEqual(server.PACKAGE.history_list()['total'],2)
            saved=new.read_bytes()
            server.forget_workspace(str(second))
            self.assertTrue(second.is_file())
            self.assertTrue(second.with_name(second.name+'.history.git').is_dir())
            self.assertEqual([f['path'] for f in server.workspace_catalog()['files']],[str(new)])
            server.forget_workspace(str(new))
            self.assertEqual(server.workspace_catalog()['files'],[])
            self.assertEqual(server.workspace_info()['id'],info['id'])
            self.assertEqual(server.settings_load()['workspace'],str(new))
            server.open_workspace(str(new),remember=False)
            self.assertEqual(server.workspace_catalog()['files'],[])
            self.assertEqual(new.read_bytes(),saved)
            server.open_workspace(str(new))
            self.assertEqual(len(server.workspace_catalog()['files']),1)

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

    def test_shared_shortcuts_http(self):
        config=Path(self.tmp.name)/'settings.json'
        with patch.object(server,'CONFIG',config), patch.object(server,'WORKSPACE_ERROR','No document open'):
            server.settings_save({'recent':['synthetic.json'],'reading':{'demo':{'view':'thesis'}}})
            with server.WorkbenchServer(('127.0.0.1',0),server.Handler) as http:
                thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
                try:
                    url=f'http://127.0.0.1:{http.server_port}/api/shortcuts'
                    def request(payload=None,workspace='a'):
                        req=urllib.request.Request(url,data=None if payload is None else json.dumps(payload).encode(),headers={'Content-Type':'application/json','X-PaperEditer-Workspace':workspace})
                        try:
                            with urllib.request.urlopen(req,timeout=5) as r:return r.status,json.load(r)
                        except urllib.error.HTTPError as r:return r.code,json.load(r)
                    empty={'revision':None,'shortcuts':None}
                    self.assertEqual(request(),(200,empty))
                    values=dict.fromkeys(server.SHORTCUT_TOOLS)
                    values['复制']={'ctrl':True,'alt':True,'shift':False,'key':'b'}
                    code,first=request({'revision':None,'shortcuts':values});self.assertEqual(code,200)
                    self.assertEqual(request(workspace='b'),(200,first))
                    self.assertEqual(server.shortcut_settings(server.settings_load()),first)
                    self.assertEqual(request({'revision':None,'shortcuts':values},'b')[0],409)
                    for invalid in ({**values,'剪切':values['复制']},{**values,'复制':{'ctrl':True,'alt':False,'shift':False,'key':'s'}},{**values,'复制':{'ctrl':1,'alt':True,'shift':False,'key':'b'}},{}):
                        self.assertEqual(request({'revision':first['revision'],'shortcuts':invalid})[0],400)
                    self.assertEqual(request(),(200,first))
                    code,second=request({'revision':first['revision'],'shortcuts':dict.fromkeys(values)},'b')
                    self.assertEqual(code,200);self.assertNotEqual(second['revision'],first['revision'])
                    self.assertEqual(request(),(200,second))
                    self.assertEqual(server.settings_load()['recent'],['synthetic.json'])
                    self.assertEqual(server.settings_load()['reading'],{'demo':{'view':'thesis'}})
                finally:
                    http.shutdown();thread.join(timeout=5)

    def test_conditional_state_detects_external_edits(self):
        server.initialize_data()
        with patch.object(server,'CONFIG',Path(self.tmp.name)/'settings.json'), patch.object(server,'PACKAGE',None), patch.object(server,'WORKSPACE_ERROR',None):
            with server.WorkbenchServer(('127.0.0.1',0),server.Handler) as http:
                thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
                try:
                    url=f'http://127.0.0.1:{http.server_port}/api/state'
                    def get(suffix=''):
                        with urllib.request.urlopen(url+suffix,timeout=5) as response:return json.load(response)
                    initial=get();query='?'+urllib.parse.urlencode({'since':initial['revision'],'workspace':initial['workspace']['id']})
                    self.assertEqual(get(query),{'unchanged':True,'revision':initial['revision'],'workspace':initial['workspace']})
                    server.path(initial['thesis'][0],'thesis').write_text('External agent update.\n',encoding='utf-8')
                    changed=get(query)
                    self.assertNotEqual(changed['revision'],initial['revision'])
                    self.assertEqual(changed['thesis'][0]['body'],'External agent update.\n')
                    self.assertEqual(server.save(initial)[0],409)
                    self.assertNotIn('unchanged',get('?'+urllib.parse.urlencode({'since':changed['revision'],'workspace':'wrong'})))
                finally:
                    http.shutdown();thread.join(timeout=5)

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
        package=pack(self.data,Path(self.tmp.name)/'blank.json')
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
        package=pack(self.data,Path(self.tmp.name)/"trash.json")
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
        package=pack(self.data,Path(self.tmp.name)/"example.json")
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
        p=pack(self.data,root/"test.json")
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
        p=migrate(legacy,root/"new.json")
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
        second=pack(self.data,root/"second.json")
        with patch.object(server,"PACKAGE",first),patch.object(server,"CONFIG",root/"settings.json"),patch.object(server,"WORKSPACE_ERROR",None):
            result=server.open_workspace(str(second.filename))
            self.assertEqual(result["name"],"second.json")
            self.assertEqual(server.load(root/"settings.json")["workspace"],str(second.filename))
            self.assertEqual([x['path'] for x in server.workspace_catalog()['files']],[str(second.filename)])
            position={'view':'thesis','active':0,'open':[],'panes':[{'id':'demo-start','reading':{'top':120}}]}
            server.save_reading(position)
            self.assertEqual(server.reading_position(),position)
            with self.assertRaises(ValueError):
                server.open_workspace("../first.paper")
            with self.assertRaises(FileNotFoundError):
                server.open_workspace(str(root/"missing.json"))
            invalid=root/"invalid.json"
            invalid.write_text("{}",encoding="utf-8")
            with self.assertRaises(ValueError):
                server.open_workspace(str(invalid))
            self.assertEqual(server.workspace_info()["name"],"second.json")
            server.open_workspace(str(first.filename))
            self.assertIsNone(server.reading_position())
            server.open_workspace(str(second.filename))
            self.assertEqual(server.reading_position(),position)
            self.assertEqual([x['path'] for x in server.workspace_catalog()['files']],[str(second.filename),str(first.filename)])
            self.assertNotIn('roots',server.settings_load())


if __name__ == "__main__":
    unittest.main()
