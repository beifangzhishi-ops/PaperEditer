# PyInstaller onedir build with a shared Python runtime for the GUI and CLI.
import os
import sys
from importlib.metadata import distribution
from pathlib import Path

root = Path(SPECPATH)
vendor = Path(os.environ.get("PAPEREDITER_VENDOR_DIR", str(root / "node_modules"))).resolve()
resources = [(str(root / name), ".") for name in (
    "index.html", "app.js", "visual.js", "style.css", "visual.css",
    "manifest.webmanifest", "app-icon-192.png", "app-icon-512.png", "example.json")]
resources.append((str(root / "example-data"), "example-data"))
python_license = Path(sys.base_prefix) / "LICENSE.txt"
if python_license.is_file():
    resources.append((str(python_license), "licenses/Python"))
for project in ("Pillow", "PyInstaller"):
    dist = distribution(project)
    for item in dist.files or ():
        if item.name.upper().startswith(("LICENSE", "COPYING")) and dist.locate_file(item).is_file():
            resources.append((str(dist.locate_file(item)), "licenses/" + project + "/" + str(item.parent).replace("\\", "/")))

for package in ("diff", "dompurify", "katex", "marked", "mathlive"):
    if not (vendor / package / "package.json").is_file():
        raise RuntimeError("Missing frontend dependency: " + package)
    resources.append((str(vendor / package), "node_modules/" + package))

app = Analysis([str(root / "packaged_main.py")], pathex=[str(root)],
               datas=resources, hiddenimports=["server", "PIL.Image"])
cli = Analysis([str(root / "paperedit.py")], pathex=[str(root)],
               datas=[], hiddenimports=["server", "PIL.Image"])
app_pyz = PYZ(app.pure)
cli_pyz = PYZ(cli.pure)
gui = EXE(app_pyz, app.scripts, [], exclude_binaries=True, name="PaperEditer",
          console=False, upx=False)
console = EXE(cli_pyz, cli.scripts, [], exclude_binaries=True, name="paperedit",
              console=True, upx=False)
coll = COLLECT(gui, console, app.binaries, cli.binaries, app.datas, cli.datas,
               strip=False, upx=False, name="PaperEditer")
