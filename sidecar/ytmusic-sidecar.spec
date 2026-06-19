# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for the YouTube Music sidecar.
#
# Produces a self-contained `ytmusic-sidecar` executable (one-dir) so packaged
# builds don't require Python or any pip packages on the user's machine. Run from
# the sidecar/ directory, e.g. (see scripts/build-sidecar.* for the wrapper):
#
#   pyinstaller ytmusic-sidecar.spec --noconfirm \
#       --distpath ../src-tauri/sidecar-dist --workpath ../build/pyinstaller
#
# The `collect_all` calls pull in the data files, dynamic submodules and binary
# extensions these packages load at runtime (ytmusicapi locales, yt-dlp extractors,
# uvicorn protocol loops, pydantic-core, the maxminddb reader), which a plain import
# scan would miss.

import glob
import os

from PyInstaller.utils.hooks import collect_all

datas, binaries, hiddenimports = [], [], []
for _pkg in ("ytmusicapi", "yt_dlp", "uvicorn", "fastapi", "pydantic", "geoip2",
             "imageio_ffmpeg"):
    _d, _b, _h = collect_all(_pkg)
    datas += _d
    binaries += _b
    hiddenimports += _h

# Bundle the on-device GeoIP DB (coarse location for the first-login compliance
# record). collect_all only grabs the geoip2 *package*, not our data/ file — so add it
# explicitly into a "data" subdir, matching data.py's `_HERE / "data"` lookup. Glob so
# monthly DB-IP refreshes are picked up automatically without editing this spec.
for _mmdb in glob.glob(os.path.join("data", "*.mmdb")):
    datas.append((_mmdb, "data"))

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter"],   # never used by the sidecar; drop it to slim the bundle
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="ytmusic-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,           # console subprocess; the Rust shell hides the window
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="ytmusic-sidecar",
)
