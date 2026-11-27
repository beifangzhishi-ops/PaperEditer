"""User-owned data and process discovery for source and future packaged builds."""
import argparse
import hashlib
import hmac
from functools import lru_cache
import json
import os
import platform
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
FROZEN = bool(getattr(sys, "frozen", False))


def user_dir():
    override = os.environ.get("PAPEREDITER_USER_DIR")
    if override:
        return Path(override).expanduser().resolve()
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "PaperEditer"
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/PaperEditer"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "PaperEditer"


def read_json(path):
    return json.loads(path.read_bytes()) if path.is_file() else {}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    from workspace import replace_bytes
    replace_bytes(path, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def service_settings(settings):
    return {"portMode": "auto", "preferredPort": 8191, "lastPort": None,
            **settings.get("service", {})}


def validate_port_settings(payload):
    if not isinstance(payload, dict) or set(payload) != {"portMode", "preferredPort"}:
        raise ValueError("Invalid service settings")
    if payload["portMode"] not in ("auto", "fixed") or type(payload["preferredPort"]) is not int or not 1024 <= payload["preferredPort"] <= 65535:
        raise ValueError("Port must be an integer from 1024 to 65535")
    return payload


def bind_server(factory, settings, override=None):
    cfg = service_settings(settings)
    validate_port_settings({k: cfg[k] for k in ("portMode", "preferredPort")})
    preferred = cfg["preferredPort"]
    if override is not None:
        return factory(("127.0.0.1", int(override)))
    if cfg["portMode"] == "fixed":
        return factory(("127.0.0.1", preferred))
    candidates = dict.fromkeys([cfg["lastPort"], preferred, *range(preferred, min(65536, preferred + 100)), 0])
    for port in candidates:
        if port is None or not 0 <= port <= 65535:
            continue
        try:
            return factory(("127.0.0.1", port))
        except OSError as exc:
            if exc.errno not in (48, 98, 10048, 10013, 13):
                raise
    raise OSError("No available local port")


def runtime_path():
    return user_dir() / "runtime.json"


def discover():
    try:
        record = read_json(runtime_path())
    except (OSError, ValueError):
        return None
    if not isinstance(record, dict):
        return None
    port = record.get("port")
    token = record.get("token")
    if type(port) is not int or not 0 < port <= 65535 or not isinstance(token, str) or not re.fullmatch(r"[a-f0-9]{64}", token):
        return None
    url = f"http://127.0.0.1:{port}"
    nonce = secrets.token_hex(32)
    req = urllib.request.Request(url + "/api/runtime/identity?nonce=" + nonce)
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=2) as response:
            result = json.load(response)
            proof = hmac.new(token.encode(), nonce.encode(), hashlib.sha256).hexdigest()
            if result.get("instance") == record.get("instance") and isinstance(result.get("proof"), str) and hmac.compare_digest(result["proof"], proof):
                return dict(record, url=url)
    except (OSError, ValueError):
        pass
    return None


def git_executable():
    configured = os.environ.get("PAPEREDITER_GIT")
    managed = user_dir() / "runtime/git"
    portable = str(managed / "cmd/git.exe") if (managed / ".paperediter-ready").is_file() else None
    candidates = [configured] if configured else [shutil.which("git"), portable]
    return _find_git(tuple(candidates))


@lru_cache(maxsize=8)
def _find_git(candidates):
    for candidate in candidates:
        if not candidate:
            continue
        try:
            result = subprocess.run([candidate, "--version"], capture_output=True, timeout=10, creationflags=NO_WINDOW)
            version = re.search(rb"git version (\d+)\.(\d+)", result.stdout)
            if result.returncode == 0 and version and tuple(map(int, version.groups())) >= (2, 28):
                return candidate
        except (OSError, subprocess.TimeoutExpired):
            pass
    raise RuntimeError("Git >= 2.28 is required; run launcher to provision Git")


def ensure_git():
    try:
        return git_executable()
    except RuntimeError:
        if os.name != "nt" or os.environ.get("PAPEREDITER_GIT"):
            raise
    from document import file_lock
    parent = user_dir() / "runtime"
    parent.mkdir(parents=True, exist_ok=True)
    with file_lock(parent / "git-install.lock", timeout=600):
        return _ensure_git_locked()


def _ensure_git_locked():
    try:
        return git_executable()
    except RuntimeError:
        if os.name != "nt" or os.environ.get("PAPEREDITER_GIT"):
            raise
    # Official release metadata includes a SHA-256 digest. Never execute an
    # unverified download or replace an existing runtime in place.
    parent = user_dir() / "runtime"
    parent.mkdir(parents=True, exist_ok=True)
    target = parent / "git"
    installing = target / ".paperediter-installing"
    ready = target / ".paperediter-ready"
    if target.exists():
        if target.is_symlink() or not installing.is_file() or ready.exists():
            raise RuntimeError("Existing Portable Git is invalid; repair it first")
        shutil.rmtree(target)
    arch = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "64-bit"
    if platform.machine().lower() not in ("amd64", "x86_64", "arm64", "aarch64"):
        raise RuntimeError("Automatic Portable Git requires 64-bit Windows")
    with urllib.request.urlopen("https://api.github.com/repos/git-for-windows/git/releases/latest", timeout=30) as response:
        release = json.load(response)
    asset = next((a for a in release["assets"] if re.fullmatch(r"PortableGit-[0-9.]+-" + arch + r"\.7z\.exe", a["name"])), None)
    if not asset or not re.fullmatch(r"sha256:[a-f0-9]{64}", asset.get("digest") or ""):
        raise RuntimeError("No verified Portable Git asset available")
    url = asset["browser_download_url"]
    if not url.startswith("https://github.com/git-for-windows/git/releases/download/"):
        raise RuntimeError("Unexpected Portable Git download URL")
    with tempfile.TemporaryDirectory(dir=parent, prefix="g-") as temp:
        temp = Path(temp)
        archive = temp / asset["name"]
        digest = hashlib.sha256()
        with urllib.request.urlopen(url, timeout=60) as response, archive.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != asset["digest"][7:]:
            raise RuntimeError("Portable Git checksum mismatch")
        # Windows scanners and the SFX post-install processes can keep files
        # open, making a directory rename unreliable. Publish readiness only
        # after extracting to the private final directory and validating Git.
        target.mkdir()
        installing.touch()
        subprocess.run([str(archive), "-y", "-o" + str(target)], check=True, timeout=600, creationflags=NO_WINDOW)
        result = subprocess.run([str(target / "cmd/git.exe"), "--version"], check=True, capture_output=True, timeout=10, creationflags=NO_WINDOW)
        if b"git version " not in result.stdout:
            raise RuntimeError("Portable Git validation failed")
        write_json(ready, {"release": release["tag_name"], "sha256": digest.hexdigest()})
        installing.unlink()
    _find_git.cache_clear()
    return git_executable()


def migrate_legacy(source, destination):
    """Copy only editor-owned data; caller must stop legacy service first."""
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if destination.exists():
        raise FileExistsError("User data already exists; refusing to merge")
    destination.mkdir(parents=True, mode=0o700)
    marker = destination / ".migration-in-progress"
    marker.touch()
    if (source / "history").exists():
        shutil.copytree(source / "history", destination / "history", ignore=shutil.ignore_patterns("*.lock"))
    if (source / "data").exists():
        shutil.copytree(source / "data", destination / "data")
    if (source / "workspace.local.json").exists():
        shutil.copy2(source / "workspace.local.json", destination / "settings.json")
    marker.unlink()


def check_profile():
    directory = user_dir()
    if (directory / ".migration-in-progress").exists():
        raise RuntimeError("User data migration is incomplete; original data is retained")
    if not os.environ.get("PAPEREDITER_USER_DIR") and not (directory / "settings.json").exists() and not (directory / "history/index.json").exists() and ((ROOT / "workspace.local.json").exists() or (ROOT / "history/index.json").exists()):
        raise RuntimeError("Stop the legacy service and run local_runtime.py --migrate-legacy first")


def stop():
    from document import file_lock
    directory = user_dir()
    if not directory.exists():
        return False
    with file_lock(directory / "launch.lock", timeout=120):
        record = discover()
        if not record:
            return False
        req = urllib.request.Request(record["url"] + "/api/settings/stop", data=b"{}", headers={"X-PaperEditer-Admin": record["token"], "Content-Type": "application/json"})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=15) as response:
            json.load(response)
        with file_lock(directory / "service.lock", timeout=20):
            pass
        return True


def service_command():
    env = os.environ.copy()
    if FROZEN:
        executable = Path(sys.executable).with_name("PaperEditer.exe")
        env["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
        return [str(executable), "--serve"], env
    if os.name != "nt":
        return [sys.executable, str(ROOT / "start.pyw")], env
    base = Path(sys.base_prefix)
    original = base / "pythonw.exe"
    if not original.is_file():
        raise RuntimeError("Windows source mode requires pythonw.exe")
    fingerprint = hashlib.sha256(str(base).encode("utf-8") + original.read_bytes()).hexdigest()[:16]
    host = user_dir() / "runtime" / "dev-python" / fingerprint
    host.mkdir(parents=True, exist_ok=True)
    executable = host / "PaperEditer.exe"
    for source, target in [(original, executable), *[(dll, host / dll.name) for dll in base.glob("*.dll")]]:
        if not target.exists():
            temp = target.with_suffix(target.suffix + ".tmp")
            shutil.copy2(source, temp)
            os.replace(temp, target)
    env["PYTHONHOME"] = str(base)
    env["PYTHONPATH"] = str(ROOT)
    env["PATH"] = str(base) + os.pathsep + env.get("PATH", "")
    return [str(executable), str(ROOT / "start.pyw")], env


def run_logged_service():
    import traceback
    if FROZEN and os.name == "nt":
        # Only the installed executable needs to block replacement by Setup.
        # The actual service exclusivity is enforced by the profile file lock.
        import ctypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateMutexW.restype = ctypes.c_void_p
        handle = kernel.CreateMutexW(None, False, "PaperEditerReleaseService")
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
    check_profile()
    logs = user_dir() / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    with (logs / "server.log").open("a", encoding="utf-8", buffering=1) as log, (logs / "server.err.log").open("a", encoding="utf-8", buffering=1) as err:
        sys.stdout, sys.stderr = log, err
        try:
            import server
            server.run_service()
        except Exception:
            traceback.print_exc(file=err)
            return 1
    return 0


def launch(background=False):
    from document import file_lock
    check_profile()
    directory = user_dir()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with file_lock(directory / "launch.lock", timeout=120):
        record = discover()
        if not record:
            ensure_git()
            command, env = service_command()
            child = subprocess.Popen(command, cwd=ROOT, env=env,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, creationflags=NO_WINDOW,
                             start_new_session=os.name != "nt")
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                record = discover()
                if record:
                    break
                if child.poll() is not None:
                    raise RuntimeError("Service exited; check user data logs")
                time.sleep(.25)
            if not record:
                raise RuntimeError("Service failed to start; check user data logs")
    if not background:
        webbrowser.open(record["url"] + "/#admin=" + record["token"])
    return record["url"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--background", action="store_true")
    parser.add_argument("--stop", action="store_true", help="Stop the running local service")
    parser.add_argument("--migrate-legacy", action="store_true", help="Copy legacy settings/history after stopping old service")
    args = parser.parse_args()
    if args.migrate_legacy:
        migrate_legacy(ROOT, user_dir())
    elif args.stop:
        print("Stopped" if stop() else "No verified local service")
    else:
        print(launch(args.background))


if __name__ == "__main__":
    main()
