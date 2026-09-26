#!/usr/bin/env python3
"""Mangarino Hub: share this PC's manga with the Mangarino app over your home network.

It opens as a window (and keeps running in the tray when you close it). To connect a device,
open Mangarino on it, tap PC, tap this PC's name, then choose Allow here.

    hub.py [--port 6264] [--root <folder>] [--background] [--no-window] [--no-panels]
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mangarino_hub import DEFAULT_PORT, VERSION, brand  # noqa: E402
from mangarino_hub import desktop  # noqa: E402
from mangarino_hub.app import Hub  # noqa: E402
from mangarino_hub.config import Config  # noqa: E402


def start_hub(config: Config, args, log) -> Hub | None:
    """The hub, or None when another copy is running (it was shown) or the port is taken."""
    instance = desktop.instance_file(config.path)
    for attempt in range(3):
        try:
            return Hub(config, host=args.host, log=log, panels=not args.no_panels)
        except OSError:
            if attempt:
                time.sleep(1.0)
                continue
            outcome = desktop.hand_over(config.port, instance, log)
            if outcome == "shown":
                log(f"{brand.HUB} is already running: showed its window.")
                return None
            if outcome == "foreign":
                break
    log(f"Port {config.port} is in use by another program.")
    desktop.message_box(
        f"{brand.HUB} can't start: another program is using network port {config.port}.\n\n"
        f"Close that program, or restart the PC, then open {brand.HUB} again.",
        error=True,
    )
    return None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, help=f"network port (default {DEFAULT_PORT})")
    ap.add_argument("--root", help="manga folder to share (remembered)")
    ap.add_argument("--background", action="store_true", help="start in the tray, without showing the window")
    ap.add_argument("--no-window", action="store_true", help="no window or tray icon: just the server")
    ap.add_argument("--no-browser", action="store_true", help=argparse.SUPPRESS)  # older name for --no-window
    ap.add_argument("--no-panels", action="store_true", help="never run panel detection")
    ap.add_argument("--quit", action="store_true", help="stop the running hub, then exit (for the installer)")
    ap.add_argument("--allow-devices", action="store_true", help=argparse.SUPPRESS)  # run as administrator by "Allow devices"
    ap.add_argument("--config", help="settings file (default: hub.json in the Mangarino or Testarino folder under %%APPDATA%%)")
    ap.add_argument("--host", default="0.0.0.0", help="address to listen on (127.0.0.1 = this PC only)")
    args = ap.parse_args(argv)
    if args.allow_devices:  # started with administrator rights by the hub's "Allow devices"
        from mangarino_hub import winutil

        return 0 if winutil.allow_devices(args.port or DEFAULT_PORT) else 1

    config = Config(Path(args.config) if args.config else None)
    if args.quit:
        return 0 if desktop.stop_running(config.port, desktop.instance_file(config.path)) else 1
    log_path = Path(config.path).with_name("hub.log")
    log = desktop.LogFile(log_path)
    if sys.stderr is None:  # the windowed .exe has no console: keep error details for troubleshooting
        try:
            sys.stderr = open(log_path.with_name("hub-errors.log"), "a", encoding="utf-8", buffering=1)
        except OSError:
            pass
    if args.port:
        config.update(port=args.port)
    if args.root:
        config.update(library_root=str(Path(args.root).expanduser().resolve()))

    hub = start_hub(config, args, log)
    if hub is None:
        return 0
    hub.start()
    instance = desktop.instance_file(config.path)
    desktop.write_instance(instance, hub.port, hub.admin_key)
    url = f"http://127.0.0.1:{hub.port}/"
    status = hub.status()
    lib = status["library"]
    log(f"{brand.HUB} {VERSION} is running on port {hub.port}.")
    log(f"  Library: {lib['root']} ({lib['series']} series, {lib['volumes']} volumes)" if lib["exists"] else f"  Library: {lib['root']} (not found yet)")
    for ip in status["addresses"]:
        log(f"  Devices on this network reach it at {ip}:{hub.port}")
    for ip in status["tailscale"]:
        log(f"  Away from home (Tailscale): {ip}:{hub.port}")
    try:
        if args.no_window or args.no_browser:
            log(f"  On this PC: {url}  (Ctrl+C stops it)")
            hub.wait()
        else:
            desktop.set_app_id()
            desktop.DesktopApp(hub, url, log, log_path, background=args.background).run()
            hub.shutdown()
    finally:
        desktop.clear_instance(instance)
    return 0


if __name__ == "__main__":
    sys.exit(main())
