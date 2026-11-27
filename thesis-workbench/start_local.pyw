"""Double-click entry point for the source application."""
import sys
from local_runtime import launch

try:
    launch()
except Exception as exc:
    if sys.platform == "win32":
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, str(exc), "PaperEditer", 0x10)
    else:
        raise
