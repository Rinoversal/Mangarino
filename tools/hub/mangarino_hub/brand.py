"""The product's name: "Mangarino", or "Testarino" for the public test build.

The "Hub EXE" workflow writes _brand.py (NAME = "Testarino") for test builds. A test build has
its own settings folder, network port, installer identity and firewall rule, so it can be
installed on the same PC as Mangarino Hub without either touching the other.
"""
from __future__ import annotations

try:
    from ._brand import NAME  # type: ignore[import-not-found]
except ImportError:
    NAME = "Mangarino"

_PORTS = {"Mangarino": 6264, "Testarino": 6265}  # 6264 is "MANG" on a phone keypad

HUB = f"{NAME} Hub"  # the window, tray icon, installer and firewall rule
FOLDER = NAME  # %APPDATA%\<FOLDER> for settings, and the default manga folder in the home folder
APP_ID = f"{NAME}.Hub"  # Windows' app identity: taskbar button, notifications
SCHEME = NAME.lower()  # the pairing QR code's link: <scheme>://pc?...
PORT = _PORTS.get(NAME, 6264)
