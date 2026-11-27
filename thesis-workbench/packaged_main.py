"""Windowed entry point for the standalone distribution."""
import argparse
import ctypes
from local_runtime import launch, stop, run_logged_service


def main():
    parser = argparse.ArgumentParser(prog="PaperEditer")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--serve", action="store_true")
    mode.add_argument("--background", action="store_true")
    mode.add_argument("--stop", action="store_true")
    args = parser.parse_args()
    if args.serve:
        return run_logged_service()
    if args.stop:
        stop()
    else:
        launch(args.background)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        ctypes.windll.user32.MessageBoxW(None, str(exc), "PaperEditer", 0x10)
        raise SystemExit(1)
