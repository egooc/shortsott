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
# A cold-started CapCut paints its chrome before the Projects grid; searching
# too early filters nothing and the row double-click lands on empty canvas.
HOME_GRID_SETTLE_SEC = 12
SIZE_STABLE_CHECKS = 3
SIZE_STABLE_INTERVAL_SEC = 2
RENAME_ATTEMPTS = 10
RENAME_RETRY_SEC = 3

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


def maximize_capcut(timeout_sec=45, title_hints=("capcut",)):
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
            title = (win32gui.GetWindowText(hwnd) or "").lower()
            if not any(hint and hint.lower() in title for hint in title_hints):
                return
            if not win32gui.GetClassName(hwnd).startswith("Qt"):
                return
            rect = win32gui.GetWindowRect(hwnd)
            found.append((hwnd, (rect[2] - rect[0]) * (rect[3] - rect[1])))

        win32gui.EnumWindows(_collect, None)
        found.sort(key=lambda w: w[1], reverse=True)
        # Ignore splash-sized windows; wait for the real main window.
        if found and found[0][1] > 400_000:
            hwnd = found[0][0]
            win32gui.ShowWindow(hwnd, win32con.SW_MAXIMIZE)
            time.sleep(1)
            # SW_MAXIMIZE alone is silently ignored by this frameless Qt window:
            # measured 2026-08-15, the window stayed 1450x850 after it, so the
            # editor's Export button sat at (1288, 18) while the coordinate
            # profile looked for it at (1769, 17) - every export then failed with
            # "editor did not open" even though the draft opened perfectly by
            # hand. Force the geometry instead of asking for it.
            try:
                import win32api
                width = win32api.GetSystemMetrics(0)
                height = win32api.GetSystemMetrics(1)
                win32gui.SetWindowPos(hwnd, 0, 0, 0, width, height, 0x0004)
                time.sleep(1)
            except Exception:
                pass
            rect = win32gui.GetWindowRect(hwnd)
            print(json.dumps({
                "step": "maximize",
                "width": rect[2] - rect[0],
                "height": rect[3] - rect[1]
            }, ensure_ascii=False), flush=True)
            time.sleep(1)
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


# CapCut names the mp4 after the project title, which it truncates - a draft
# folder ending in " H01" exports as "...工程.mp4" with the suffix gone. Every
# consumer downstream identifies a video by its draft name: the producer treats
# a draft with no matching mp4 as still pending, and the uploader finds the
# metadata TXT by that name. So a truncated name made one highlight draft look
# permanently unexported, and the fill loop re-exported it 18 times before
# anyone noticed (2026-08-15).
#
# The exported file is therefore renamed to the draft name here, at the one
# place that knows both.
def normalize_export_name(output_path, draft_name):
    if not output_path:
        return output_path, ""
    export_dir = os.path.dirname(output_path)
    desired = os.path.join(export_dir, draft_name + ".mp4")
    if os.path.normcase(desired) == os.path.normcase(output_path):
        return output_path, ""
    # CapCut can still hold the file open for a moment after the size settles,
    # and the rename then fails with a sharing violation. Swallowing that put the
    # truncated name back in play: the next attempt found it already there and
    # CapCut wrote "name(1).mp4" beside it. Retry, and if it truly cannot be
    # renamed say so in the result instead of reporting a path nothing matches.
    last = ""
    for _ in range(RENAME_ATTEMPTS):
        try:
            os.replace(output_path, desired)
            return desired, ""
        except OSError as error:
            last = str(error)
            time.sleep(RENAME_RETRY_SEC)
    return output_path, last


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
        #
        # The window existing does not mean the home screen is usable: on a cold
        # start CapCut paints its chrome well before the Projects grid, and a
        # search typed into a half-built page filters nothing, so the
        # double-click below lands on empty canvas and every export died with
        # "editor did not open" (2026-08-15). Give the grid time, and report
        # each step so a failure says where it stopped.
        time.sleep(HOME_GRID_SETTLE_SEC)
        print(json.dumps({"step": "home_ready"}, ensure_ascii=False), flush=True)

        pyautogui.click(*coords["search_icon"])
        time.sleep(1.5)
        set_clipboard(args.draft_name)
        pyautogui.hotkey("ctrl", "v")
        time.sleep(3.5)
        print(json.dumps({"step": "searched"}, ensure_ascii=False), flush=True)

        # Double-clicks get swallowed sometimes - verify the editor actually
        # opened (its export button turns teal) and retry if not.
        # Opening a project gives CapCut a NEW window at its own default size
        # (1450x850 measured 2026-08-15), so the home screen's maximize does not
        # carry over. The editor really was opening every time; the teal check
        # just looked at (1769, 17), which by then was desktop. Re-force the
        # geometry on the editor window - its title is the draft name, not
        # "CapCut", so it has to be matched by that too.
        opened = False
        for attempt in range(3):
            # Re-search before each retry. The grid settle is a fixed wait, and
            # when the machine is busy - a batch running ffmpeg alongside this -
            # CapCut can still be painting the Projects list when the search is
            # typed, so nothing filters and the double-click lands on an empty
            # slot. Retrying the same click could never recover from that; the
            # search has to be redone now that the grid exists.
            if attempt:
                pyautogui.click(*coords["search_icon"])
                time.sleep(1.5)
                set_clipboard(args.draft_name)
                pyautogui.hotkey("ctrl", "v")
                time.sleep(3.5)
                print(json.dumps({"step": "researched", "attempt": attempt}, ensure_ascii=False), flush=True)
            pyautogui.doubleClick(*coords["first_row"])
            time.sleep(EDITOR_LOAD_SEC)
            maximize_capcut(timeout_sec=20, title_hints=("capcut", args.draft_name[-24:]))
            if wait_for(lambda: editor_open(coords), 20):
                opened = True
                break
        if not opened:
            # Screenshot from inside the run: watching from another shell kept
            # showing a bare desktop while the step log said the search had just
            # succeeded, which told us nothing about what the click actually hit.
            try:
                shot = os.path.join(os.path.dirname(args.export_dir), "_export_failure.png")
                pyautogui.screenshot(shot)
                print(json.dumps({"step": "failure_shot", "path": shot}, ensure_ascii=False), flush=True)
            except Exception:
                pass
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
            # CapCut sits on the export-complete dialog holding the file open, so
            # renaming it there fails with a sharing violation for as long as the
            # app is up - retrying alone never won. Close CapCut first; the file
            # is finished by this point and the finally-block kill is harmless
            # once it is already gone.
            kill_capcut()
            time.sleep(2)
            output_path, rename_error = normalize_export_name(output_path, args.draft_name)
            if rename_error:
                raise RuntimeError(f"could not rename export to draft name: {rename_error}")
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
