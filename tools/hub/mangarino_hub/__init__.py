"""Mangarino Hub: shares a PC manga folder with the Mangarino app over the home network."""

VERSION = "1.1.0"
API_VERSION = 1
from .brand import PORT as DEFAULT_PORT  # noqa: E402  6264 ("MANG" on a phone keypad); test builds differ

try:
    from ._build import BUILD  # the release number, written by the "Hub EXE" workflow
except ImportError:
    BUILD = 0

__all__ = ["API_VERSION", "BUILD", "DEFAULT_PORT", "VERSION"]
