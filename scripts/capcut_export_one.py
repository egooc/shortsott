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
      --export-dir "%USERPROFILE%/Desktop/캡컷아웃풋/CapCut Drafts/_automation factory" \
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

# Fail-safe OFF for unattended production: a mouse parked in any screen
# corner (the natural "hands-off" position) aborted every export at ~25s
# (observed 2026-08-12). The run is short and CapCut is killed in finally.
pyautogui.FAILSAFE = False

def _default_capcut_exe():
    """CapCut's install layout differs by version: newer builds ship a stub
    launcher at Apps\\CapCut.exe that picks the current version, older ones
    only have <version>\\CapCut.exe. The N100 machine has 6.8.1.2758 under
    Apps\\ while the previous machine had 9.2.0.3931 at the top level, so probe
    instead of hardcoding either."""
    root = os.path.expandvars(r"%LOCALAPPDATA%\CapCut")
    launcher = os.path.join(root, "Apps", "CapCut.exe")
    if os.path.exists(launcher):
        return launcher
    apps = os.path.join(root, "Apps")
    candidates = []
    for base in (apps, root):
        if not os.path.isdir(base):
            continue
        for name in os.listdir(base):
            exe = os.path.join(base, name, "CapCut.exe")
            if os.path.exists(exe):
                candidates.append((name, exe))
    if candidates:
        # Highest version string wins.
        candidates.sort(key=lambda c: [int(p) for p in c[0].split(".") if p.isdigit()] or [0])
        return candidates[-1][1]
    return os.path.join(root, "Apps", "CapCut.exe")


CAPCUT_EXE_DEFAULT = _default_capcut_exe()

HOME_LOAD_SEC = 20
EDITOR_LOAD_SEC = 15
EXPORT_DIALOG_SEC = 4
EXPORT_TIMEOUT_SEC = 420
SIZE_STABLE_CHECKS = 3
SIZE_STABLE_INTERVAL_SEC = 2

COORDS_CONFIG = os.path.join(os.path.dirname(__file__), "capcut_export_coords.json")


def load_coords():
    """Per-resolution coordinate profiles (capcut_export_coords.json).

    An unknown resolution falls back to proportional scaling from the
    reference profile with a warning - calibrate and add a real profile for
    every machine that runs this unattended.
    """
    with open(COORDS_CONFIG, encoding="utf-8") as fh:
        config = json.load(fh)
    width, height = pyautogui.size()
    key = f"{width}x{height}"
    profiles = config["profiles"]
    if key in profiles:
        return profiles[key], key, False
    ref_key = config["reference_resolution"]
    ref = profiles[ref_key]
    ref_w, ref_h = (int(v) for v in ref_key.split("x"))
    scaled = {name: (round(x * width / ref_w), round(y * height / ref_h))
              for name, (x, y) in ref.items()}
    print(f"WARNING: no coordinate profile for {key}; proportionally scaled "
          f"from {ref_key} - verify with a supervised run", file=sys.stderr)
    return scaled, key, True


def kill_capcut():
    subprocess.run(["taskkill", "/f", "/im", "CapCut.exe"], capture_output=True)
    time.sleep(2)


def maximize_capcut(timeout_sec=45):
    """The coordinate profiles assume a MAXIMIZED window, but CapCut opens
    floating (~1428x952 on a 1080p screen) and kill_capcut()'s taskkill /f
    denies it any chance to persist window state - so every run starts
    un-maximized and every calibrated coordinate misses. Maximize explicitly.

    Picks the largest Qt top-level window, since CapCut's modals and tooltips
    carry the same window title.
    """
    try:
        import win32con
        import win32gui
    except ImportError:
        return False

    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        found = []

        def _collect(hwnd, _):
            if not win32gui.IsWindowVisible(hwnd):
                return
            if "capcut" not in (win32gui.GetWindowText(hwnd) or "").lower():
                return
            if not win32gui.GetClassName(hwnd).startswith("Qt"):
                return
            rect = win32gui.GetWindowRect(hwnd)
            found.append((hwnd, (rect[2] - rect[0]) * (rect[3] - rect[1])))

        win32gui.EnumWindows(_collect, None)
        found.sort(key=lambda w: w[1], reverse=True)
        # Ignore splash-sized windows; wait for the real main window.
        if found and found[0][1] > 400_000:
            win32gui.ShowWindow(found[0][0], win32con.SW_MAXIMIZE)
            time.sleep(2)
            return True
        time.sleep(1.5)
    return False


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


def teal_at(x, y):
    """CapCut's primary action buttons are bright teal (~(0,193,205)); the
    editor/home chrome under them is dark. A teal pixel is how we verify a UI
    state actually changed - clicks are occasionally swallowed by CapCut's QML
    window (observed 2026-08-11/12), so every step must be verified, not
    assumed."""
    r, g, b = pyautogui.pixel(x, y)
    return g > 140 and b > 120 and r < 110


def export_dialog_open(coords):
    return teal_at(*coords["export_confirm"])


def editor_open(coords):
    # The editor's own export button is teal; on the home screen this spot is
    # dark window chrome.
    return teal_at(*coords["export_button"])


def wait_for(predicate, timeout_sec, interval_sec=0.5):
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval_sec)
    return False


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
        coords, resolution_key, scaled = load_coords()
        result["resolution"] = resolution_key
        result["coords_scaled_fallback"] = scaled
        before = snapshot_dir(args.export_dir)
        # Park the cursor mid-screen so a corner-parked mouse cannot swallow
        # the first click.
        screen_w, screen_h = pyautogui.size()
        pyautogui.moveTo(screen_w // 2, screen_h // 2)
        kill_capcut()
        subprocess.Popen([args.capcut_exe])
        time.sleep(HOME_LOAD_SEC)
        if not maximize_capcut():
            raise RuntimeError("CapCut main window never appeared to maximize")
        time.sleep(3)

        # Search filters the project list to exactly our draft; paste via
        # clipboard because the names carry CJK that pyautogui cannot type.
        pyautogui.click(*coords["search_icon"])
        time.sleep(1.5)
        set_clipboard(args.draft_name)
        pyautogui.hotkey("ctrl", "v")
        time.sleep(2.5)

        # Double-clicks get swallowed sometimes - verify the editor actually
        # opened (its export button turns teal) and retry if not.
        opened = False
        for _ in range(3):
            pyautogui.doubleClick(*coords["first_row"])
            if wait_for(lambda: editor_open(coords), EDITOR_LOAD_SEC + 10):
                opened = True
                break
        if not opened:
            raise RuntimeError("editor did not open after 3 double-click attempts")
        time.sleep(3)  # let the editor finish layout before poking export

        # Export click can also be swallowed, AND a click outside an already-
        # open dialog dismisses it - so never click export while the dialog is
        # up; poll for the dialog instead of a fixed sleep.
        dialog_open = False
        for _ in range(3):
            if not export_dialog_open(coords):
                pyautogui.click(*coords["export_button"])
            if wait_for(lambda: export_dialog_open(coords), 10):
                dialog_open = True
                break
        if not dialog_open:
            raise RuntimeError("export dialog did not open after 3 attempts")
        pyautogui.click(*coords["export_confirm"])

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
