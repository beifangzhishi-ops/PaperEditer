"""Install a user-level paperedit launcher pointing at this source checkout."""
import argparse
import os
import shlex
import sys
from pathlib import Path


def install(bin_dir):
    script = Path(__file__).resolve().with_name("paperedit.py")
    if not script.is_file():
        raise FileNotFoundError(script)
    bin_dir = Path(bin_dir).expanduser().resolve()
    if os.name == "nt":
        launcher = bin_dir / "paperedit.cmd"
        def quote(path):
            return '"' + str(path).replace("%", "%%") + '"'
        # cmd.exe uses the active legacy code page for batch files. Fail
        # rather than silently producing an unusable path.
        data = ("@echo off\r\nsetlocal DisableDelayedExpansion\r\n"
                + "rem PaperEditer managed launcher\r\n"
                + quote(Path(sys.executable).resolve()) + " " + quote(script)
                + " %*\r\nexit /b %errorlevel%\r\n").encode("mbcs")
    else:
        launcher = bin_dir / "paperedit"
        data = ("#!/bin/sh\n# PaperEditer managed launcher\nexec "
                + shlex.quote(sys.executable) + " " + shlex.quote(str(script))
                + ' "$@"\n').encode("utf-8")
    bin_dir.mkdir(parents=True, exist_ok=True)
    if launcher.exists() and launcher.read_bytes() != data:
        raise FileExistsError("A different launcher already exists: " + str(launcher))
    if not launcher.exists():
        with launcher.open("xb") as f:
            f.write(data)
    if os.name != "nt":
        launcher.chmod(0o755)
    return launcher


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    default = Path(sys.executable).parent / "Scripts" if os.name == "nt" else Path.home() / ".local" / "bin"
    parser.add_argument("--bin-dir", type=Path, default=default, help="User-writable directory on PATH")
    args = parser.parse_args()
    launcher = install(args.bin_dir)
    print("Installed:", launcher)
    paths = {os.path.normcase(os.path.abspath(os.path.expandvars(p.strip('"')))) for p in os.environ.get("PATH", "").split(os.pathsep) if p}
    if os.path.normcase(str(launcher.parent)) not in paths:
        print("Add this directory to your user PATH:", launcher.parent)
    print("Run paperedit --help from any directory.")


if __name__ == "__main__":
    main()
