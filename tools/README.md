# Bundled Runtime Tools

Place optional runtime binaries here before building the Electron app.

Recommended Windows layout:

```txt
tools/
  bin/
    ffmpeg.exe
    ffprobe.exe
    yt-dlp.exe
  python/
    python.exe
    python311.dll
    Lib/
    Scripts/
```

The app resolves tools in this order:

1. Explicit environment variable
   - `FFMPEG_PATH`
   - `FFPROBE_PATH`
   - `YT_DLP_PATH`
   - `PYTHON_PATH`
2. Electron packaged resource path
   - `resources/tools/bin/*.exe`
   - `resources/tools/python/python.exe`
3. Project-local path during development
   - `tools/bin/*.exe`
   - `tools/python/python.exe`
4. System `PATH`

Notes:

- `ffmpeg.exe` and `ffprobe.exe` should come from the same FFmpeg build.
- `yt-dlp.exe` can be the standalone Windows binary.
- Python bundling is optional if the target machine already has Python and required packages installed.
- If bundling Python, install any required Python packages into that bundled Python environment.
- CapCut itself is not bundled. The generated draft folders are still opened in the user's installed CapCut.
