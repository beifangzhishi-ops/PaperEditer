from pathlib import Path
import sys
import runpy
import traceback

root = Path(__file__).resolve().parent
with (root / 'server.log').open('a', encoding='utf-8', buffering=1) as log, (root / 'server.err.log').open('a', encoding='utf-8', buffering=1) as err:
    sys.stdout, sys.stderr = log, err
    try:
        runpy.run_path(str(root / 'server.py'), run_name='__main__')
    except Exception:
        traceback.print_exc(file=err)
        raise SystemExit(1)
