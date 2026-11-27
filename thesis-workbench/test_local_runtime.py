import json
import os
import socket
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

import local_runtime as rt
import server


class RuntimeTests(unittest.TestCase):
    def test_ports(self):
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            port = occupied.getsockname()[1]
            if port == 65535:
                self.skipTest("Port boundary")
            make = lambda address: server.WorkbenchServer(address, server.Handler)
            with rt.bind_server(make, {"service": {"preferredPort": port}}) as http:
                self.assertNotEqual(http.server_address[1], port)
            with self.assertRaises(OSError):
                rt.bind_server(make, {"service": {"preferredPort": port, "portMode": "fixed"}})
        with rt.bind_server(make, {"service": {"preferredPort": 8191, "lastPort": port}}) as http:
            self.assertEqual(http.server_address[1], port)
        for value in (0, 65536, True, "8191"):
            with self.assertRaises(ValueError):
                rt.validate_port_settings({"portMode": "auto", "preferredPort": value})

    def test_migration_preserves_originals(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "legacy"
            source.mkdir()
            rt.write_json(source / "workspace.local.json", {"favorites": ["C:/example.json"]})
            rt.write_json(source / "history/index.json", {"example": {"path": "C:/example.json"}})
            rt.migrate_legacy(source, root / "profile")
            self.assertEqual((source / "workspace.local.json").read_bytes(), (root / "profile/settings.json").read_bytes())
            self.assertEqual((source / "history/index.json").read_bytes(), (root / "profile/history/index.json").read_bytes())
            with self.assertRaises(FileExistsError):
                rt.migrate_legacy(source, root / "profile")

    def test_discovery_and_admin(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.dict(os.environ, {"PAPEREDITER_USER_DIR": temp}):
                with server.WorkbenchServer(("127.0.0.1", 0), server.Handler) as http:
                    record = {"port": http.server_address[1], "token": "a" * 64, "instance": "test"}
                    rt.write_json(rt.runtime_path(), record)
                    with patch.object(server, "RUNTIME", record), patch.object(server, "CONFIG", Path(temp) / "settings.json"):
                        thread = threading.Thread(target=http.serve_forever, daemon=True)
                        thread.start()
                        try:
                            url = rt.discover()["url"]
                            with self.assertRaises(urllib.error.HTTPError) as result:
                                urllib.request.urlopen(url + "/api/settings/service")
                            self.assertEqual(result.exception.code, 403)
                            req = urllib.request.Request(url + "/api/settings/service", headers={"X-PaperEditer-Admin": record["token"], "Content-Type": "application/json"}, data=b'{"portMode":"fixed","preferredPort":8199}')
                            with urllib.request.urlopen(req) as response:
                                self.assertEqual(json.load(response)["service"]["preferredPort"], 8199)
                            rt.write_json(rt.runtime_path(), dict(record, token="b" * 64))
                            self.assertIsNone(rt.discover())
                        finally:
                            http.shutdown()
                            thread.join()


if __name__ == "__main__":
    unittest.main()
