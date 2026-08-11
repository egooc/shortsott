"""Export ONE CapCut draft to mp4 by driving the CapCut desktop UI.

CapCut's QML UI exposes no UIA accessibility tree, so this is screen-driven
(fixed coordinates calibrated for this machine: 2880x1800, CapCut maximized).
Verified end-to-end 2026-08-11: home -> search -> open draft -> export dialog
(remembers 1080P/high-bitrate/HEVC/output dir) -> confirm -> file appears in
the export dir. Completion is detected by the OUTPUT FILE appearing and its
size going stable - not by screenshots - so UI skin changes cannot fake
success.

Stateless per draft: CapCut is killed and relaunched for every export.
Requires an unlocked interactive desktop (no screen lock).

Usage
  python scripts/capcut_export_one.py --draft-name <folder name> \
      --export-dir "C:/Users/sejun/Desktop/캡컷아웃풋/CapCut Drafts/_automation factory" \
      [--capcut-exe <path>] [--json OUT]

Output JSON: { status: exported|timeout|error, output_path, elapsed_sec }
"""

import argparse
import ctypes
import json
import os
import subprocess
import sys
import time

ctypes.windll.user32.SetProcessDPIAware()
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import pyautogui  # noqa: E402

pyautogui.FAILSAFE = True  # mouse to top-left corner aborts

CAPCUT_EXE_DEFAULT = os.path.expandvars(r"%LOCALAPPDATA%\CapCut\9.2.0.3931\CapCut.exe")

# Calibrated 2026-08-11 on 2880x1800, CapCut maximized (see session notes).
HOME_LOAD_SEC = 20
COORD_SEARCH_ICON = (2236, 1428)
COORD_FIRST_ROW = (620, 1580)
EDITOR_LOAD_SEC = 15
COORD_EXPORT_BUTTON = (2566, 35)
EXPORT_DIALOG_SEC = 4
COORD_EXPORT_CONFIRM = (1894, 1460)
EXPORT_TIMEOUT_SEC = 420
SIZE_STABLE_CHECKS = 3
SIZE_STABLE_INTERVAL_SEC = 2


def kill_capcut():
    subprocess.run(["taskkill", "/f", "/im", "CapCut.exe"], capture_output=True)
    time.sleep(2)


def set_clipboard(text):
    import ctypes.wintypes as wintypes
    CF_UNICODETEXT = 13
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    # 64-bit: default ctypes restype is a 32-bit int, which truncates the
    # HGLOBAL/pointer and crashes memmove - declare the real types.
    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    user32.OpenClipboard(0)
    try:
        user32.EmptyClipboard()
        data = text.encode("utf-16-le") + b"\x00\x00"
        handle = kernel32.GlobalAlloc(0x2042, len(data))
        locked = kernel32.GlobalLock(handle)
        ctypes.memmove(locked, data, len(data))
        kernel32.GlobalUnlock(handle)
        user32.SetClipboardData(CF_UNICODETEXT, handle)
    finally:
        user32.CloseClipboard()


def snapshot_dir(export_dir):
    try:
        return {name: os.path.getsize(os.path.join(export_dir, name))
                for name in os.listdir(export_dir) if name.lower().endswith(".mp4")}
    except FileNotFoundError:
        return {}


def wait_for_new_export(export_dir, before, timeout_sec):
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        time.sleep(3)
        current = snapshot_dir(export_dir)
        fresh = [name for name in current if name not in before]
        if not fresh:
            continue
        target = fresh[0]
        stable = 0
        last_size = -1
        while stable < SIZE_STABLE_CHECKS and time.time() < deadline:
            size = snapshot_dir(export_dir).get(target, -1)
            stable = stable + 1 if (size == last_size and size > 0) else 0
            last_size = size
            time.sleep(SIZE_STABLE_INTERVAL_SEC)
        if stable >= SIZE_STABLE_CHECKS:
            return os.path.join(export_dir, target)
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--draft-name", required=True)
    parser.add_argument("--export-dir", required=True)
    parser.add_argument("--capcut-exe", default=CAPCUT_EXE_DEFAULT)
    parser.add_argument("--json", dest="json_out")
    args = parser.parse_args()

    started = time.time()
    result = {"status": "error", "draft_name": args.draft_name, "output_path": ""}
    try:
        before = snapshot_dir(args.export_dir)
        kill_capcut()
        subprocess.Popen([args.capcut_exe])
        time.sleep(HOME_LOAD_SEC)

        # Search filters the project list to exactly our draft; paste via
        # clipboard because the names carry CJK that pyautogui cannot type.
        pyautogui.click(*COORD_SEARCH_ICON)
        time.sleep(1.5)
        set_clipboard(args.draft_name)
        pyautogui.hotkey("ctrl", "v")
        time.sleep(2.5)

        pyautogui.doubleClick(*COORD_FIRST_ROW)
        time.sleep(EDITOR_LOAD_SEC)

        pyautogui.click(*COORD_EXPORT_BUTTON)
        time.sleep(EXPORT_DIALOG_SEC)
        pyautogui.click(*COORD_EXPORT_CONFIRM)

        output_path = wait_for_new_export(args.export_dir, before, EXPORT_TIMEOUT_SEC)
        if output_path:
            result["status"] = "exported"
            result["output_path"] = output_path
        else:
            result["status"] = "timeout"
    except Exception as error:  # noqa: BLE001
        result["status"] = "error"
        result["error"] = str(error)[:300]
    finally:
        kill_capcut()
    result["elapsed_sec"] = round(time.time() - started, 1)

    text = json.dumps(result, ensure_ascii=False)
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
    print(text)
    return 0 if result["status"] == "exported" else 1


if __name__ == "__main__":
    sys.exit(main())
