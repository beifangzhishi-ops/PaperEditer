"""Install a user-level paperedit launcher pointing at this source checkout."""
import argparse
import os
import shlex
import sys
import tempfile
import zipfile
from pathlib import Path


def windows_launcher(script, bin_dir):
    # Use the same native console-launcher mechanism as pip's entry points.
    # No compiler, shell command string or separately installed runtime.
    try:
        from distlib.scripts import ScriptMaker
    except ImportError:
        from pip._vendor.distlib.scripts import ScriptMaker
    launcher = bin_dir / "paperedit.exe"
    source = (
        "#!python\n"
        "# PaperEditer managed native launcher\n"
        "import runpy, sys\n"
        f"sys.path.insert(0, {str(script.parent)!r})\n"
        f"runpy.run_path({str(script)!r}, run_name='__main__')\n"
    )
    with tempfile.TemporaryDirectory(prefix="paperedit-launcher-") as temp:
        root = Path(temp)
        stub = root / "paperedit.py"
        stub.write_text(source, encoding="utf-8")
        output = root / "output"
        output.mkdir()
        maker = ScriptMaker(str(root), str(output), add_launchers=True)
        maker.executable = sys.executable
        paths = maker.make(stub.name)
        generated = output / "paperedit.exe"
        if not generated.is_file():
            raise RuntimeError("Native launcher generation failed")
        data = generated.read_bytes()
        if launcher.exists():
            # Compare the executable prefix and Python payload, ignoring ZIP
            # timestamps. Never overwrite an unrelated existing executable.
            try:
                with zipfile.ZipFile(launcher) as old, zipfile.ZipFile(generated) as new:
                    a = old.getinfo("__main__.py")
                    b = new.getinfo("__main__.py")
                    same = (old.read(a) == new.read(b)
                            and launcher.read_bytes()[:a.header_offset] == data[:b.header_offset])
            except (OSError, KeyError, zipfile.BadZipFile):
                same = False
            if not same:
                raise FileExistsError("A different launcher already exists: " + str(launcher))
        else:
            with launcher.open("xb") as f:
                f.write(data)
    return launcher


def install(bin_dir):
    script = Path(__file__).resolve().with_name("paperedit.py")
    if not script.is_file():
        raise FileNotFoundError(script)
    bin_dir = Path(bin_dir).expanduser().resolve()
    bin_dir.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        return windows_launcher(script, bin_dir)
    else:
        launcher = bin_dir / "paperedit"
        data = ("#!/bin/sh\n# PaperEditer managed launcher\nexec "
                + shlex.quote(sys.executable) + " " + shlex.quote(str(script))
                + ' "$@"\n').encode("utf-8")
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
