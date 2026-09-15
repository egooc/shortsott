#!/usr/bin/env python3
"""Prove each capability actually works, before a run spends anything on it.

Why this exists: the portrait face anchor was dead for an unknown length of time. It imported
fine, it was configured on, it reported "no face detected" for every cut and quietly framed dead
centre - and nothing in the pipeline was in a position to notice, because nothing asked it to
produce a result. The two preflights we had check the *material* and the *plan*; neither checks
whether the tools are alive.

So every check here is an OUTCOME test, not a presence test. Importing cv2 proves nothing; finding
a face in a frame that has one proves something. A check that cannot run says so and why, and the
exit code separates "this run will fail" from "this run will be worse than it should be".

    python midform/scripts/doctor.py              # free checks only
    python midform/scripts/doctor.py --paid       # also spends a few characters on a TTS probe
    python midform/scripts/doctor.py --json       # machine-readable

Exit 0 = every required capability answered. Exit 1 = something required is broken. Exit 2 = only
optional capabilities are degraded.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "midform" / "scripts"))
sys.path.insert(0, str(ROOT / "scripts"))

REQUIRED = "required"
OPTIONAL = "optional"


class Result:
    def __init__(self, name, level, ok, detail, fix=""):
        self.name = name
        self.level = level
        self.ok = ok
        self.detail = detail
        self.fix = fix

    def as_dict(self):
        return {"name": self.name, "level": self.level, "ok": self.ok,
                "detail": self.detail, "fix": self.fix}


def sample_frame_with_a_face():
    """A frame from our own footage that is known to contain a face.

    Uses whatever test_runs source is on disk rather than a checked-in image, so the probe is
    against the material this machine actually processes.
    """
    for candidate in sorted((ROOT / "midform" / "test_runs").glob("*/source.mp4")):
        return candidate
    return None


def check_face_detector():
    try:
        import face_detector
    except Exception as error:  # noqa: BLE001
        return Result("face_detector", REQUIRED, False, "import failed: %s" % error,
                      "midform/scripts/face_detector.py is missing or broken")
    detector = face_detector.load_detector()
    if detector is None:
        return Result("face_detector", REQUIRED, False, face_detector.unavailable_reason(),
                      "fetch face_detection_yunet_2023mar.onnx into midform/assets/models/ "
                      "(git-lfs media url; the raw url returns a 131-byte pointer)")
    source = sample_frame_with_a_face()
    if source is None:
        return Result("face_detector", OPTIONAL, False, "%s loaded, but no sample footage to test on"
                      % detector.describe(), "put a source.mp4 under midform/test_runs/*/")
    try:
        import cv2
        capture = cv2.VideoCapture(str(source))
        fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
        frames = capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0
        hits = seen = 0
        for index in range(8):
            capture.set(cv2.CAP_PROP_POS_MSEC, (frames / fps) * (index + 0.5) / 8 * 1000.0)
            ok, frame = capture.read()
            if not ok:
                continue
            seen += 1
            if detector.detect(frame):
                hits += 1
        capture.release()
    except Exception as error:  # noqa: BLE001
        return Result("face_detector", REQUIRED, False, "detection raised: %s" % error, "")
    if seen == 0:
        return Result("face_detector", OPTIONAL, False, "could not decode %s" % source.name, "")
    # A detector that answers zero on ordinary footage is the failure this file exists for. It is
    # not proof of "no faces in this film" - it is proof that nothing is looking.
    if hits == 0:
        return Result("face_detector", REQUIRED, False,
                      "%s found 0 faces in %d frames of %s" % (detector.describe(), seen, source.name),
                      "the detector loads but never answers - check the model file and cv2 build")
    return Result("face_detector", REQUIRED, True,
                  "%s found faces in %d/%d frames" % (detector.describe(), hits, seen))


def check_forced_alignment():
    try:
        import torch  # noqa: F401
        import torchaudio
    except Exception as error:  # noqa: BLE001
        return Result("forced_alignment", OPTIONAL, False, "torch/torchaudio missing: %s" % error,
                      "pip install torch torchaudio (dialogue timing falls back to the plan's guess)")
    if not hasattr(torchaudio.pipelines, "MMS_FA"):
        return Result("forced_alignment", OPTIONAL, False,
                      "torchaudio %s has no MMS_FA pipeline" % torchaudio.__version__, "")
    return Result("forced_alignment", OPTIONAL, True,
                  "torchaudio %s, MMS_FA available" % torchaudio.__version__)


def check_binaries():
    out = []
    # ffmpeg and ffprobe take -version with ONE dash; --version makes them exit non-zero after
    # printing the banner, which reads as a broken install when nothing is wrong.
    for name, level, flag in (("ffmpeg", REQUIRED, "-version"), ("ffprobe", REQUIRED, "-version"),
                              ("yt-dlp", REQUIRED, "--version")):
        env_override = os.environ.get("%s_PATH" % name.upper().replace("-", "_"))
        found = env_override or shutil.which(name)
        if not found:
            out.append(Result(name, level, False, "not on PATH", "install it or set %s_PATH"
                              % name.upper().replace("-", "_")))
            continue
        try:
            proc = subprocess.run([found, flag], capture_output=True, text=True, timeout=30)
            first = (proc.stdout or proc.stderr or "").splitlines()
            out.append(Result(name, level, proc.returncode == 0,
                              (first[0] if first else "(no version output)")[:70],
                              "" if proc.returncode == 0 else "exits %d" % proc.returncode))
        except Exception as error:  # noqa: BLE001
            out.append(Result(name, level, False, "could not run: %s" % error, ""))
    return out


def check_capcut():
    try:
        import pycapcut  # noqa: F401
        backend = "pycapcut"
    except ImportError:
        try:
            import pyCapCut  # noqa: F401
            backend = "pyCapCut"
        except ImportError:
            return [Result("pycapcut", REQUIRED, False, "neither pycapcut nor pyCapCut importable",
                           "pip install pyCapCut")]
    results = [Result("pycapcut", REQUIRED, True, "%s importable" % backend)]
    try:
        import capcut_draft
        found = capcut_draft.find_capcut_template_files()
    except Exception as error:  # noqa: BLE001
        results.append(Result("capcut_template", OPTIONAL, False, "lookup raised: %s" % error, ""))
        return results
    if not found:
        results.append(Result("capcut_template", OPTIONAL, False,
                              "no draft_content.json under templates/capcut/channel_default",
                              "drafts fall back to generated styling and lose the channel's look"))
    else:
        results.append(Result("capcut_template", OPTIONAL, True,
                              "depth %s" % found.get("depth")))
    return results


# True when the server accepts the login on file. Returns (live, detail). A revoked or expired
# token answers 401 on the model refresh that every invocation starts with, so this costs a
# round trip and no inference; anything else - including a timeout - is treated as live, because
# a slow network must not be reported as a dead login.
def codex_auth_is_live(binary):
    try:
        probe = subprocess.run([binary, "exec", "--sandbox", "read-only", "-"],
                               input="reply with: ok", capture_output=True, text=True,
                               timeout=25, encoding="utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        return True, "auth probe timed out - treating the login as live"
    except Exception as error:  # noqa: BLE001
        return True, "auth probe could not run (%s) - treating the login as live" % error
    noise = (probe.stderr or "") + " " + (probe.stdout or "")
    if "token_revoked" in noise or "refresh_token_invalidated" in noise:
        return False, "the login was revoked - the server says the session has ended"
    if "401 Unauthorized" in noise or "auth error: 401" in noise:
        return False, "the server rejected the login (401)"
    return True, ""


def check_codex():
    binary = shutil.which("codex") or shutil.which("codex.cmd")
    if not binary:
        return [Result("codex", REQUIRED, False, "codex not on PATH", "install the Codex CLI")]
    home = os.environ.get("CODEX_HOME") or str(Path.home() / ".codex")
    auth = Path(home) / "auth.json"
    if not auth.exists():
        return [Result("codex", REQUIRED, False, "no auth.json under %s" % home,
                       "codex login --device-auth")]
    try:
        record = json.loads(auth.read_text(encoding="utf-8-sig"))
        account = (record.get("tokens") or {}).get("account_id") or "(no account_id)"
    except Exception as error:  # noqa: BLE001
        return [Result("codex", REQUIRED, False, "auth.json unreadable: %s" % error, "")]
    # An auth.json that parses is not a login. On 2026-09-15 this check reported "ok" for an
    # account whose refresh token had been revoked, the run rotated INTO it, and the batch died
    # at the vision step with "GPT CLI exited with code 1". `codex login status` is no better -
    # it reads the same file and says "Logged in using ChatGPT" for a dead token. The only thing
    # that knows is the server, and it says so on the model-refresh call within a second, before
    # any inference is billed.
    live, detail = codex_auth_is_live(binary)
    if not live:
        return [Result("codex", REQUIRED, False, "%s: %s" % (account, detail),
                       "codex login  (then: node scripts/codex-accounts.js save <name>)")]
    results = [Result("codex", REQUIRED, True, "%s (CODEX_HOME=%s)" % (account, home))]
    state = Path(home) / "accounts" / ".rotation-state.json"
    saved = list((Path(home) / "accounts").glob("*.json")) if (Path(home) / "accounts").is_dir() else []
    saved = [p for p in saved if not p.name.startswith(".")]
    spent = ""
    try:
        if state.exists():
            marks = json.loads(state.read_text(encoding="utf-8-sig"))
            import datetime
            until = (marks.get(account) or {}).get("exhausted_until")
            if until and datetime.datetime.fromisoformat(until.replace("Z", "+00:00")) > \
                    datetime.datetime.now(datetime.timezone.utc):
                spent = " - the ACTIVE account is marked spent until %s" % until
    except Exception:  # noqa: BLE001
        pass
    results.append(Result("codex_accounts", OPTIONAL, not spent,
                          "%d login(s) on file for rotation%s" % (len(saved), spent),
                          "node scripts/codex-accounts.js save <name>" if len(saved) < 2 else ""))
    return results


def check_elevenlabs(spend):
    try:
        import assemble_slot_draft_input as A
    except Exception as error:  # noqa: BLE001
        return [Result("tts_config", REQUIRED, False, "assemble_slot_draft_input import: %s" % error, "")]
    config = A.load_tts_config()
    A.set_active_tts_config(config)
    if config.get("provider") != "elevenlabs":
        return [Result("tts", OPTIONAL, True, "provider=%s (ElevenLabs checks skipped)"
                       % config.get("provider"))]
    key = os.environ.get("ELEVENLABS_API_KEY") or A.read_env_file_value("ELEVENLABS_API_KEY")
    if not key:
        return [Result("tts", REQUIRED, False, "ELEVENLABS_API_KEY not set",
                       "put it in the project .env - the whole run dies at synthesis without it")]
    results = []
    try:
        request = urllib.request.Request(
            "%s/v1/user/subscription" % str(config.get("api_base") or "https://api.elevenlabs.io").rstrip("/"),
            headers={"xi-api-key": key, "User-Agent": "curl/8.5.0", "Accept": "application/json"})
        with urllib.request.urlopen(request, timeout=30) as response:
            sub = json.loads(response.read().decode("utf-8"))
        used = int(sub.get("character_count") or 0)
        limit = int(sub.get("character_limit") or 0)
        left = max(0, limit - used)
        # Four nights died on quota_exceeded; knowing the remainder before a run is the cheap half.
        results.append(Result("tts_quota", REQUIRED, left > 0,
                              "%s chars left of %s" % (f"{left:,}", f"{limit:,}"),
                              "top up or rotate the key" if left <= 0 else ""))
    except urllib.error.HTTPError as error:
        results.append(Result("tts_quota", REQUIRED, False, "HTTP %s from /v1/user/subscription"
                              % error.code, "the key may be wrong or revoked"))
    except Exception as error:  # noqa: BLE001
        results.append(Result("tts_quota", OPTIONAL, False, "could not query: %s" % error, ""))
    if spend:
        import asyncio
        import tempfile
        try:
            out = tempfile.mkdtemp()
            unit = {"caption_id": "doctor_probe", "segment_id": "doctor", "text": "확인"}
            got = asyncio.run(A.synthesize_unit_elevenlabs(unit, out))
            aligned = len((got.get("character_alignment") or {}).get("characters") or [])
            results.append(Result("tts_probe", REQUIRED, got.get("duration_sec", 0) > 0,
                                  "synthesised %.2fs, %d aligned chars%s"
                                  % (got.get("duration_sec") or 0, aligned,
                                     "" if aligned else " (with_timestamps off or refused)")))
        except Exception as error:  # noqa: BLE001
            results.append(Result("tts_probe", REQUIRED, False, str(error)[:110], ""))
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--paid", action="store_true", help="also synthesise one probe sentence")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    results = []
    results.extend(check_binaries())
    results.append(check_face_detector())
    results.append(check_forced_alignment())
    results.extend(check_capcut())
    results.extend(check_codex())
    results.extend(check_elevenlabs(args.paid))

    if args.json:
        print(json.dumps([r.as_dict() for r in results], ensure_ascii=False, indent=1))
    else:
        width = max(len(r.name) for r in results)
        for r in results:
            mark = "ok  " if r.ok else ("FAIL" if r.level == REQUIRED else "warn")
            print("%-4s %-*s  %s" % (mark, width, r.name, r.detail))
            if not r.ok and r.fix:
                print("%-4s %-*s  -> %s" % ("", width, "", r.fix))

    broken = [r for r in results if not r.ok and r.level == REQUIRED]
    degraded = [r for r in results if not r.ok and r.level == OPTIONAL]
    if not args.json:
        print()
        if broken:
            print("%d required capability/ies broken - a run will fail" % len(broken))
        elif degraded:
            print("%d optional capability/ies degraded - a run will be worse than it should be"
                  % len(degraded))
        else:
            print("all capabilities answered")
    return 1 if broken else (2 if degraded else 0)


if __name__ == "__main__":
    sys.exit(main())
