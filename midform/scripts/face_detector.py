"""Face detection for portrait framing - YuNet first, Haar cascades only as a legacy fallback.

Why this module exists: `capcut_draft.load_opencv_face_cascades()` built its detector from
`cv2.data.haarcascades` and wrapped the whole thing in `except Exception: return []`. On OpenCV 5
that path is gone - `cv2.CascadeClassifier` is no longer an attribute and the bundled cascade
directory ships empty - so the loader returned `[]`, `detect_primary_face_anchor` reported
"no face detected", and every cut silently took the centred fallback anchor. Nothing logged, nothing
failed; the framing feature was simply off.

Measured on this machine (40 frames sampled per source, OpenCV 5.0.0):

    source                      Haar      YuNet
    banshees   1920x1080         0%        90%
    run_013    1920x1080         0%        90%
    run_010    1280x720          0%        75%

So the fix is not "load the cascades harder" - the legacy API is gone and the old detector was a
2001 algorithm that misses profile and low-light faces anyway. YuNet ships inside OpenCV
(`cv2.FaceDetectorYN`) and needs one 230KB ONNX file.

The other half of the fix is that a detector which cannot be built is *reported*, never swallowed.
`load_detector()` returns None and records `unavailable_reason()` so the caller can decide between
degrading and stopping - it does not get to look like "there were no faces in this shot".

    python midform/scripts/face_detector.py --selftest <video> [--samples 40]
"""
import os
import sys

try:
    import cv2
except ImportError:  # pragma: no cover - callers already degrade when cv2 is missing
    cv2 = None

MODEL_ENV = "MIDFORM_YUNET_MODEL"
MODEL_RELPATH = os.path.join("midform", "assets", "models", "face_detection_yunet_2023mar.onnx")
# YuNet's own defaults. Raising score_threshold trades recall for precision; 0.6 was picked because
# 0.9 dropped the profile/over-the-shoulder shots this footage is mostly made of.
SCORE_THRESHOLD = 0.6
NMS_THRESHOLD = 0.3
TOP_K = 5000
HAAR_NAMES = ("haarcascade_frontalface_default.xml", "haarcascade_profileface.xml")

_UNAVAILABLE_REASON = "not attempted"


def unavailable_reason():
    """Why the last load_detector() call produced nothing. Never empty after a failed load."""
    return _UNAVAILABLE_REASON


def model_path():
    override = os.environ.get(MODEL_ENV)
    if override:
        return override
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(root, MODEL_RELPATH)


class _YuNet:
    """cv2.FaceDetectorYN wrapper. Input size must be re-declared whenever the frame size changes."""

    backend = "yunet"

    def __init__(self, detector, path):
        self._detector = detector
        self._size = None
        self.model = path

    def describe(self):
        return "yunet(%s)" % os.path.basename(self.model)

    def detect(self, frame):
        height, width = frame.shape[:2]
        if self._size != (width, height):
            self._detector.setInputSize((width, height))
            self._size = (width, height)
        _, faces = self._detector.detect(frame)
        if faces is None:
            return []
        out = []
        for row in faces:
            x, y, w, h = (float(row[0]), float(row[1]), float(row[2]), float(row[3]))
            if w <= 0 or h <= 0:
                continue
            out.append({
                "x": int(round(max(0.0, x))),
                "y": int(round(max(0.0, y))),
                "w": int(round(w)),
                "h": int(round(h)),
                "score": float(row[-1]),
                "detector": "yunet",
                "flipped_profile": False,
            })
        return out


class _Haar:
    """Legacy path, kept so an OpenCV 4.x machine behaves exactly as it did before."""

    backend = "haar"

    def __init__(self, cascades):
        self._cascades = cascades

    def describe(self):
        return "haar(%s)" % ",".join(name for name, _ in self._cascades)

    def detect(self, frame):
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)
        width = frame.shape[1]
        out = []
        for name, classifier in self._cascades:
            for x, y, w, h in classifier.detectMultiScale(
                    gray, scaleFactor=1.08, minNeighbors=4, minSize=(36, 36)):
                out.append({"x": int(x), "y": int(y), "w": int(w), "h": int(h), "score": None,
                            "detector": name, "flipped_profile": False})
            if "profile" in name:
                flipped = cv2.flip(gray, 1)
                for x, y, w, h in classifier.detectMultiScale(
                        flipped, scaleFactor=1.08, minNeighbors=4, minSize=(36, 36)):
                    out.append({"x": int(width - x - w), "y": int(y), "w": int(w), "h": int(h),
                                "score": None, "detector": name, "flipped_profile": True})
        return out


def _load_yunet():
    global _UNAVAILABLE_REASON
    if not hasattr(cv2, "FaceDetectorYN"):
        _UNAVAILABLE_REASON = "cv2.FaceDetectorYN missing (OpenCV %s)" % cv2.__version__
        return None
    path = model_path()
    if not os.path.exists(path):
        _UNAVAILABLE_REASON = ("yunet model not found at %s - fetch "
                               "face_detection_yunet_2023mar.onnx from opencv_zoo (git-lfs media "
                               "url, the raw url returns a 131-byte pointer)" % path)
        return None
    try:
        detector = cv2.FaceDetectorYN.create(path, "", (320, 320), SCORE_THRESHOLD,
                                             NMS_THRESHOLD, TOP_K)
    except Exception as error:  # noqa: BLE001 - reported, not swallowed
        _UNAVAILABLE_REASON = "yunet create failed: %s" % error
        return None
    return _YuNet(detector, path)


def _load_haar():
    global _UNAVAILABLE_REASON
    if not hasattr(cv2, "CascadeClassifier"):
        _UNAVAILABLE_REASON = "cv2.CascadeClassifier removed in OpenCV %s" % cv2.__version__
        return None
    base = getattr(cv2, "data", None)
    root = getattr(base, "haarcascades", "") if base is not None else ""
    cascades = []
    for name in HAAR_NAMES:
        path = os.path.join(root, name) if root else name
        try:
            classifier = cv2.CascadeClassifier(path)
        except Exception:  # noqa: BLE001
            continue
        if not classifier.empty():
            cascades.append((name, classifier))
    if not cascades:
        _UNAVAILABLE_REASON = "no haar cascade xml under %r" % (root or "(no cv2.data)")
        return None
    return _Haar(cascades)


def load_detector():
    """Best available detector, or None with unavailable_reason() explaining why."""
    global _UNAVAILABLE_REASON
    _UNAVAILABLE_REASON = "not attempted"
    if cv2 is None:
        _UNAVAILABLE_REASON = "opencv unavailable"
        return None
    reasons = []
    detector = _load_yunet()
    if detector is not None:
        return detector
    reasons.append(_UNAVAILABLE_REASON)
    detector = _load_haar()
    if detector is not None:
        return detector
    reasons.append(_UNAVAILABLE_REASON)
    _UNAVAILABLE_REASON = " / ".join(reasons)
    return None


def _selftest(path, samples):
    detector = load_detector()
    if detector is None:
        print("no detector: %s" % unavailable_reason())
        return 3
    capture = cv2.VideoCapture(path)
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = frames / fps if fps else 0.0
    hit = read = 0
    for index in range(samples):
        capture.set(cv2.CAP_PROP_POS_MSEC, duration * (index + 0.5) / samples * 1000.0)
        ok, frame = capture.read()
        if not ok:
            continue
        read += 1
        if detector.detect(frame):
            hit += 1
    capture.release()
    print("%s  %s  %.0fs  detected %d/%d = %.0f%%"
          % (os.path.basename(path), detector.describe(), duration, hit, read,
             100.0 * hit / max(1, read)))
    return 0


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--selftest", metavar="VIDEO")
    parser.add_argument("--samples", type=int, default=40)
    args = parser.parse_args()
    if args.selftest:
        sys.exit(_selftest(args.selftest, args.samples))
    found = load_detector()
    print(found.describe() if found else "no detector: %s" % unavailable_reason())
