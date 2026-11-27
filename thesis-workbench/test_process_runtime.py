"""Isolated end-to-end startup, reuse, offline CLI and forced-stop smoke test."""
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from unittest.mock import patch

import local_runtime as rt


ROOT = Path(__file__).resolve().parent


def main():
    release = os.environ.get("PAPEREDITER_RELEASE_DIR")
    release = Path(release).resolve() if release else None
    source = [sys.executable, str(ROOT / "local_runtime.py"), "--background"]
    source_cli = [sys.executable, str(ROOT / "paperedit.py")]
    launcher = [str(release / "PaperEditer.exe"), "--background"] if release else source
    cli = [str(release / "paperedit.exe")] if release else source_cli
    with tempfile.TemporaryDirectory(prefix="paperedit-smoke-") as temp:
        profile = Path(temp) / "profile"
        env = {k: v for k, v in os.environ.items() if not k.startswith("PAPEREDITER_") and k not in ("PYTHONHOME", "PYTHONPATH")}
        env["PAPEREDITER_USER_DIR"] = str(profile)
        env["PAPEREDITER_PORT"] = "0"
        with patch.dict(os.environ, {"PAPEREDITER_USER_DIR": str(profile)}):
            doc = Path(temp) / "sample.json"

            def run(command):
                result = subprocess.run(command, env=env, cwd=temp, capture_output=True, timeout=120)
                assert result.returncode == 0, (command, result.returncode, result.stderr)
                return result.stdout

            def get(endpoint):
                record = rt.discover()
                assert record, "No verified running service"
                with urllib.request.urlopen(record["url"] + endpoint, timeout=15) as response:
                    return response.read()

            try:
                created = json.loads(run(cli + ["--offline", "new", str(doc)]))
                assert doc.exists()
                run(launcher)
                first = rt.discover()
                assert first and first["buildType"] == ("release" if release else "source"), first
                if os.name == "nt":
                    names = subprocess.check_output(["tasklist", "/FI", "PID eq " + str(first["pid"]), "/FO", "CSV", "/NH"]).decode("utf-8", "replace")
                    assert "PaperEditer.exe" in names, names
                # Multiple launches (including source -> release and vice versa) must reuse the same PID.
                run(launcher)
                run(source)
                assert rt.discover()["pid"] == first["pid"]
                run(cli + ["open", str(doc)])
                assert json.loads(get("/api/state"))["workspace"]["id"] == created["id"]
                assert b"PaperEditer" in get("/")
                assert len(get("/workbench.js")) > 10000
                if release:
                    for path in ("/vendor/katex/dist/katex.min.js", "/vendor/mathlive/mathlive.min.js", "/vendor/marked/lib/marked.umd.js", "/vendor/dompurify/dist/purify.min.js", "/vendor/diff/dist/diff.min.js"):
                        assert len(get(path)) > 1000, path
                processes = [subprocess.Popen(cli + ["--workspace", str(doc), "status"], env=env, cwd=temp, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(3)]
                for process in processes:
                    output, err = process.communicate(timeout=60)
                    assert process.returncode == 0, err
                    assert json.loads(output)["workspace"]["id"] == created["id"]
                # Simulate Task Manager End Task without a graceful cleanup.
                os.kill(first["pid"], signal.SIGTERM if os.name == "nt" else signal.SIGKILL)
                for _ in range(100):
                    if rt.discover() is None:
                        break
                    time.sleep(.1)
                assert rt.discover() is None
                assert rt.runtime_path().is_file(), "Expected stale runtime file"
                offline = json.loads(run(cli + ["--workspace", str(doc), "status"]))
                assert offline["mode"] == "local-core"
                run(source if release else launcher)
                second = rt.discover()
                assert second and second["instance"] != first["instance"]
                assert json.loads(get("/api/state"))["workspace"]["id"] == created["id"]
                if release:
                    run(launcher)
                    assert rt.discover()["pid"] == second["pid"]
                assert rt.stop()
                assert rt.discover() is None and not rt.runtime_path().exists()
                print("PASS: named service, reuse, offline CLI, concurrent CLI, force stop, restart, graceful exit", flush=True)
            finally:
                if rt.discover():
                    rt.stop()


if __name__ == "__main__":
    main()
