"""HTTP API for devices, plus the PC's own status page.

Devices (private network addresses only):
  GET    /api/hello                          who is this, is my token still good
  POST   /api/pair-request {deviceId, deviceName, deviceKind}  ask; the PC shows Allow
  GET    /api/pair-request/<id>?wait=<s>     the answer (waits up to 15 s); a token once allowed
  DELETE /api/pair-request/<id>              stop asking
  POST   /api/pair      {code, deviceId, deviceName}  -> {token}   (QR code / typed code)
  DELETE /api/pair                            forget this device
  GET    /api/cover/<id>                      a small cover image
  GET    /api/library?since=<generation>      series and volumes
  GET    /api/volume/<id>                     warm up a file before downloading it
  GET    /api/file/<id>?v=<version>           the file; Range supported
  PUT    /api/upload?folder=&file=&size=      send a volume from the device to the PC
Every /api call but hello, pair-request and pair needs `Authorization: Bearer <token>`.

The status page and /admin/* answer only on this PC (loopback, a loopback Host header and a
per-run admin key embedded in the page), so a web page elsewhere can't drive the hub.
"""
from __future__ import annotations

import ipaddress
import json
import re
import secrets
import shutil
import socket
import time
import urllib.parse
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import API_VERSION, BUILD, VERSION, brand
from .files import Busy, is_inside
from .packer import Changed
from .library import ARCHIVE_EXTS, mime_of, page_bytes, read_panels_doc, volume_id, volume_pages

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
CHUNK = 1 << 20
MAX_JSON = 64 * 1024
MAX_CATALOG = 16 * 1024 * 1024  # a device's whole library list
MAX_COVER = 40 * 1024 * 1024
FREE_SPACE_MARGIN = 200 * 1024 * 1024
DRAIN_LIMIT = 8 * 1024 * 1024  # read up to this much of a refused upload before answering
_BAD_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")
_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
}
_STATIC = re.compile(r"(fonts/)?[a-z0-9_-]+\.(html|js|css|svg|png|woff2|txt)")


_TAILSCALE = ipaddress.ip_network("100.64.0.0/10")


def allowed_client(ip, away: bool = True) -> bool:
    """Home-network and this-PC addresses, and Tailscale ones while "Away from home" is on.
    Never the open internet."""
    if ip is None:
        return False
    if ip in _TAILSCALE:
        return away
    return ip.is_private or ip.is_loopback or ip.is_link_local


_DEVICE_NAMES = {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


def safe_name(name: str) -> bool:
    """A single file or folder name that is safe on Windows and can't climb out of the root."""
    return (
        bool(name)
        and name not in (".", "..")
        and len(name.encode("utf-8")) <= 200
        and not _BAD_NAME.search(name)
        and not name.startswith((".", " "))
        and not name.endswith((".", " "))
        and name.split(".")[0].rstrip().upper() not in _DEVICE_NAMES  # "NUL.cbz" is a device on Windows
    )


class HubServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False
    request_queue_size = 64

    def __init__(self, address, hub):
        self.hub = hub
        super().__init__(address, Handler)

    def server_bind(self):
        # On Windows SO_REUSEADDR lets a second process steal the port; insist on exclusive use.
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class Handler(BaseHTTPRequestHandler):
    server_version = f"{brand.NAME}Hub/{VERSION}"
    protocol_version = "HTTP/1.0"
    timeout = 60  # a stalled device can't hold a thread forever

    def log_message(self, fmt, *args):  # the hub prints its own plain-English events
        pass

    # ------------------------------------------------------------------ helpers
    @property
    def hub(self):
        return self.server.hub

    def _ip(self):
        try:
            ip = ipaddress.ip_address(self.client_address[0])
        except ValueError:
            return None
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        return ip

    def _local_only(self) -> bool:
        ip = self._ip()
        host = self.headers.get("Host", "").rsplit(":", 1)[0].strip("[]").lower()
        return ip is not None and ip.is_loopback and host in ("127.0.0.1", "localhost", "::1")

    def send_json(self, code: int, obj, headers: dict | None = None) -> None:
        body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self, limit: int = MAX_JSON) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        if n > limit:
            raise ValueError("request too large")
        data = json.loads(self.rfile.read(n).decode("utf-8"))
        return data if isinstance(data, dict) else {}

    def _token(self) -> str | None:
        auth = self.headers.get("Authorization", "")
        return auth[7:].strip() if auth.lower().startswith("bearer ") else None

    def device(self):
        """The paired device making this request, or None after answering 401."""
        d = self.hub.pairing.device_for(self._token())
        if d is None:
            self.send_json(401, {"error": "not_paired"})
        else:
            self.hub.seen[d["id"]] = time.time()
            ip = self._ip()
            if ip is not None and not ip.is_loopback:
                self.hub.note_reached()
        return d

    # ------------------------------------------------------------------ routing
    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PUT(self):
        self._route("PUT")

    def do_DELETE(self):
        self._route("DELETE")

    def _route(self, method: str) -> None:
        ip = self._ip()
        if not allowed_client(ip, self.hub.config.away):
            if ip is not None and ip in _TAILSCALE:
                self.close_connection = True  # "Away from home" is off: as if this PC were out of reach
                return
            self.send_json(403, {"error": "private_network_only"})
            return
        url = urllib.parse.urlsplit(self.path)
        path = url.path.rstrip("/") or "/"
        q = {k: v[-1] for k, v in urllib.parse.parse_qs(url.query).items()}
        try:
            if path.startswith("/api/"):
                self._api(method, path[5:], q)
            elif path.startswith("/admin/"):
                key = self.headers.get("X-Admin-Key") or q.get("k", "")
                if not self._local_only() or not secrets.compare_digest(key, self.hub.admin_key):
                    self.send_json(403, {"error": "this_pc_only"})
                    return
                self._admin(method, path[7:], q)
            elif method == "GET":
                self._static(path)
            else:
                self.send_json(405, {"error": "method"})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, socket.timeout):
            pass
        except ValueError as e:
            self.send_json(400, {"error": "bad_request", "detail": str(e)})
        except Exception as e:  # noqa: BLE001 - one bad request must not stop the hub
            self.hub.log(f"Error handling {method} {url.path}: {type(e).__name__}: {e}")
            try:
                self.send_json(500, {"error": "server", "detail": type(e).__name__})
            except OSError:
                pass

    # ------------------------------------------------------------------ device API
    def _api(self, method: str, path: str, q: dict) -> None:
        hub = self.hub
        if path == "hello" and method == "GET":
            d = hub.pairing.device_for(self._token())
            self.send_json(200, {
                "service": "mangarino-hub", "api": API_VERSION, "version": VERSION, "build": BUILD, "brand": brand.NAME,
                "serverId": hub.config.server_id, "name": hub.config.name,
                "serverMs": int(time.time() * 1000), "paired": d is not None,
                "features": ["library", "download", "upload", "panels", "progress", "approve", "covers", "catalog", "panel-data"],
            })
            return
        if path == "pair-request" and method == "POST":
            body = self.read_json()
            ip = self._ip()
            res = hub.pairing.request(
                str(body.get("deviceId", "")), str(body.get("deviceName", "")), str(ip), str(body.get("deviceKind", "")),
            )
            if "error" in res:
                self.send_json(429 if res["error"] in ("denied_recently", "too_soon") else 503, res)
            else:
                self.send_json(202, {**res, "serverId": hub.config.server_id, "name": hub.config.name})
            return
        if path.startswith("pair-request/"):
            rid = path[len("pair-request/"):]
            if method == "GET":
                wait = int(q["wait"]) if q.get("wait", "").isdigit() else 0
                res = hub.pairing.wait(rid, wait)
                if res["state"] == "approved":
                    res.update(serverId=hub.config.server_id, name=hub.config.name)
                    hub.log("A device was allowed to connect.")
                self.send_json(200, res)
            elif method == "DELETE":
                hub.pairing.cancel(rid)
                self.send_json(200, {"ok": True})
            else:
                self.send_json(405, {"error": "method"})
            return
        if path == "pair" and method == "POST":
            body = self.read_json()
            res = hub.pairing.pair(
                str(body.get("code", "")), str(body.get("deviceId", "")), str(body.get("deviceName", "")), str(body.get("deviceKind", "")),
                str(self._ip()),
            )
            if res.get("error") == "too_many_tries":
                self.send_json(429, res)
                return
            if "token" in res:
                hub.log(f"Paired with {str(body.get('deviceName') or 'a device')}.")
                self.send_json(200, {"token": res["token"], "serverId": hub.config.server_id, "name": hub.config.name})
            else:
                self.send_json(403, res)
            return
        d = self.device()
        if d is None:
            return
        if path == "pair" and method == "DELETE":
            hub.forget_device(d["id"])
            self.send_json(200, {"ok": True})
        elif path == "library" and method == "GET":
            hub.library.ensure_fresh(5.0)
            since = q.get("since")
            if since and since.isdigit() and int(since) == hub.library.generation:
                self.send_json(200, {"generation": hub.library.generation, "unchanged": True})
            else:
                listing = hub.library.listing()
                listing["panels"] = hub.panels.brief()
                self.send_json(200, listing)
        elif path.startswith("volume/") and method == "GET":
            self._volume(path[7:])
        elif path.startswith("cover/") and method == "GET":
            self._cover(path[6:])
        elif path.startswith("panels/") and method == "GET":
            self._panels(path[7:])
        elif path.startswith("file/") and method == "GET":
            self._file(path[5:], q, d)
        elif path == "upload" and method == "PUT":
            self._upload(q, d)
        elif path == "progress" and method == "GET":
            since = int(q["since"]) if q.get("since", "").isdigit() else 0
            self.send_json(200, hub.progress.since(since))
        elif path == "progress" and method == "POST":
            accepted = hub.progress.merge(self.read_json(MAX_CATALOG).get("rows", []))
            self.send_json(200, {"rev": hub.progress.rev, "accepted": accepted})
        elif path == "catalog" and method == "POST":
            missing = hub.remote.set_catalog(d["id"], self.read_json(MAX_CATALOG).get("series"))
            self.send_json(200, {"missingCovers": missing})
        elif path.startswith("device-cover/") and method == "PUT":
            self._device_cover(d, path[len("device-cover/"):])
        elif path == "requests" and method == "GET":
            wait = int(q["wait"]) if q.get("wait", "").isdigit() else 0
            self.send_json(200, {"requests": hub.remote.take_requests(d["id"], wait)})
        else:
            self.send_json(404, {"error": "not_found"})

    def _device_cover(self, device: dict, vid: str) -> None:
        """A device's cover image for one of its volumes (shrunk and kept on this PC)."""
        try:
            n = int(self.headers.get("Content-Length") or -1)
        except ValueError:
            n = -1
        if not vid.isdigit() or n <= 0 or n > MAX_COVER:
            self._refuse(400, {"error": "bad_cover"})
            return
        raw = self.rfile.read(n)
        ok = self.hub.remote.save_cover(device["id"], int(vid), raw)
        self.send_json(200 if ok else 404, {"ok": ok})

    def _lookup(self, vid: str):
        v = self.hub.library.get(vid)
        if v is None:
            self.hub.library.ensure_fresh(5.0)  # at most one rescan every few seconds, however many misses
            v = self.hub.library.get(vid)
        if v is None:
            self.send_json(404, {"error": "gone"})
        return v

    def _cover(self, vid: str) -> None:
        v = self._lookup(vid)
        if v is None:
            return
        try:
            body, ctype = self.hub.thumbs.cover(v)
        except IndexError:
            self.send_json(404, {"error": "no_page"})
            return
        except (OSError, zipfile.BadZipFile):
            self.send_json(409, {"error": "unreadable"})
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "private, max-age=604800")  # URLs carry the version
        self.end_headers()
        self.wfile.write(body)

    def _panels(self, vid: str) -> None:
        """Just the panel boxes of a volume, once this PC has made them with the speech-bubble
        fix, so a device with the same volume can use them without downloading it again."""
        v = self._lookup(vid)
        if v is None:
            return
        state = self.hub.library.panels_of(v)
        doc = read_panels_doc(v) if state == "ready" else None
        if doc is None:
            self.send_json(409, {"error": "not_ready", "state": state})
            return
        self.send_json(200, {"version": v.version, "doc": doc})

    def _volume(self, vid: str) -> None:
        """Touch the file (first megabyte and the zip directory) so a sleeping disk or an
        antivirus scan happens now, not during the device's download with its short timeout."""
        v = self._lookup(vid)
        if v is None:
            return
        try:
            path = self.hub.packer.ensure(v) if v.kind == "folder" else v.path
            with self.hub.gate.reading(path):
                with open(path, "rb") as f:
                    f.read(CHUNK)
                with zipfile.ZipFile(path) as z:
                    z.namelist()
        except Changed:
            self.hub.library.scan()
            self.send_json(412, {"error": "changed"})
            return
        except Busy:
            self.send_json(503, {"error": "busy"}, {"Retry-After": "5"})
            return
        except (OSError, zipfile.BadZipFile):
            self.send_json(409, {"error": "unreadable"})
            return
        self.send_json(200, {"id": v.id, "size": v.size, "version": v.version, "panels": self.hub.library.panels_of(v)})

    def _file(self, vid: str, q: dict, device: dict) -> None:
        v = self._lookup(vid)
        if v is None:
            return
        want = q.get("v")
        if want and want != v.version:
            self.hub.library.scan()
            self.send_json(412, {"error": "changed"})
            return
        if v.kind == "folder":
            try:
                path = self.hub.packer.ensure(v)
            except (Changed, OSError):
                self.hub.library.scan()
                self.send_json(412, {"error": "changed"})
                return
            size = v.size
        else:
            path = v.path
            try:
                st = path.stat()
            except OSError:
                self.send_json(404, {"error": "gone"})
                return
            if f"{st.st_size}-{st.st_mtime_ns}" != v.version:
                self.hub.library.scan()
                self.send_json(412, {"error": "changed"})
                return
            size = st.st_size
        start, end, status = 0, size - 1, 200
        rng = self.headers.get("Range")
        if rng:
            m = _RANGE.match(rng.strip())
            if not m or (not m.group(1) and not m.group(2)):
                self.send_json(416, {"error": "range"}, {"Content-Range": f"bytes */{size}"})
                return
            if m.group(1):
                start = int(m.group(1))
                end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
            else:  # suffix range: the last N bytes
                start = max(0, size - int(m.group(2)))
            if start > end or start >= size:
                self.send_json(416, {"error": "range"}, {"Content-Range": f"bytes */{size}"})
                return
            status = 206
        try:
            with self.hub.gate.reading(path):
                tid = self.hub.transfers.start("to device", v.rel, end - start + 1, device.get("name", ""))
                ok, err = False, "stopped"
                try:
                    with open(path, "rb") as f:
                        self.send_response(status)
                        self.send_header("Content-Type", "application/vnd.comicbook+zip")
                        self.send_header("Content-Length", str(end - start + 1))
                        self.send_header("Accept-Ranges", "bytes")
                        self.send_header("ETag", f'"{v.version}"')
                        if status == 206:
                            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                        self.end_headers()
                        f.seek(start)
                        left = end - start + 1
                        while left > 0:
                            chunk = f.read(min(CHUNK, left))
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            left -= len(chunk)
                            self.hub.transfers.progress(tid, len(chunk))
                        ok, err = left == 0, None if left == 0 else "short read"
                finally:
                    self.hub.transfers.finish(tid, ok, err)
                    if ok:
                        self.hub.log(f"Sent {v.rel} to {device.get('name', 'a device')}.")
        except Busy:
            self.send_json(503, {"error": "busy"}, {"Retry-After": "5"})

    def _upload(self, q: dict, device: dict) -> None:
        hub = self.hub
        folder, name = q.get("folder", ""), q.get("file", "")
        if (folder and not safe_name(folder)) or not safe_name(name) or not name.lower().endswith(ARCHIVE_EXTS):
            self._refuse(400, {"error": "bad_name"})
            return
        try:
            size = int(q.get("size", ""))
            length = int(self.headers.get("Content-Length") or -1)
        except ValueError:
            self._refuse(400, {"error": "bad_size"})
            return
        if length < 0:
            self.send_json(411, {"error": "length_required"})
            return
        if length != size or size <= 0:
            self._refuse(400, {"error": "size_mismatch"})
            return
        root = hub.library.root
        if not root.is_dir():
            root.mkdir(parents=True, exist_ok=True)
        target_dir = root / folder if folder else root
        dest = target_dir / name
        if not is_inside(root, target_dir):
            self._refuse(400, {"error": "bad_name"})
            return
        if shutil.disk_usage(root).free < size + FREE_SPACE_MARGIN:
            self._refuse(507, {"error": "pc_full"})
            return
        target_dir.mkdir(parents=True, exist_ok=True)
        rel = f"{folder}/{name}" if folder else name
        if dest.exists() and dest.stat().st_size == size:
            # Same name and size: the PC already has it. Drain the body so the device sees success.
            self._drain(length)
            self.send_json(200, {"status": "exists", "id": volume_id(rel)})
            return
        tmp = target_dir / f".mangarino-upload-{secrets.token_hex(6)}.part"
        tid = hub.transfers.start("to PC", rel, size, device.get("name", ""))
        ok, err = False, "stopped"
        try:
            with open(tmp, "wb") as f:
                left = length
                while left > 0:
                    chunk = self.rfile.read(min(CHUNK, left))
                    if not chunk:
                        break
                    f.write(chunk)
                    left -= len(chunk)
                    hub.transfers.progress(tid, len(chunk))
            if left:
                err = "connection dropped"
                return
            try:
                with zipfile.ZipFile(tmp) as z:
                    z.namelist()
            except zipfile.BadZipFile:
                err = "not a zip"
                self.send_json(422, {"error": "not_a_zip"})
                return
            hub.gate.replace(tmp, dest)
            hub.library.mark_complete(rel)
            ok, err = True, None
            hub.log(f"Received {rel} from {device.get('name', 'a device')}.")
            hub.after_upload()
            self.send_json(201, {"status": "stored", "id": volume_id(rel)})
        finally:
            hub.transfers.finish(tid, ok, err)
            if tmp.exists():
                try:
                    tmp.unlink()
                except OSError:
                    pass

    def _refuse(self, code: int, obj: dict) -> None:
        """Answer an upload that won't be stored. A small body is read first: closing on a device
        that is still sending makes Windows reset the connection, and the device would see a
        network error instead of the reason."""
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if 0 < n <= DRAIN_LIMIT:
            self._drain(n)
        self.send_json(code, obj)

    def _drain(self, n: int) -> None:
        while n > 0:
            chunk = self.rfile.read(min(CHUNK, n))
            if not chunk:
                break
            n -= len(chunk)

    # ------------------------------------------------------------------ this PC only
    def _admin(self, method: str, path: str, q: dict) -> None:
        hub = self.hub
        if path == "status" and method == "GET":
            self.send_json(200, hub.status())
        elif path == "library" and method == "GET":
            hub.library.ensure_fresh(5.0)
            self.send_json(200, hub.library.listing())
        elif path == "progress" and method == "GET":
            since = int(q["since"]) if q.get("since", "").isdigit() else 0
            self.send_json(200, hub.progress.since(since))
        elif path == "progress" and method == "POST":
            accepted = hub.progress.merge(self.read_json(MAX_CATALOG).get("rows", []))
            self.send_json(200, {"rev": hub.progress.rev, "accepted": accepted})
        elif path.startswith("pages/") and method == "GET":
            v = self._lookup(path[6:])
            if v is None:
                return
            try:
                self.send_json(200, {"id": v.id, "folder": v.folder, "file": v.file, "pages": volume_pages(v)})
            except (OSError, zipfile.BadZipFile) as e:
                self.send_json(409, {"error": "unreadable", "detail": type(e).__name__})
        elif path.startswith("cover/") and method == "GET":
            self._cover(path[6:])
        elif path.startswith("page/") and method == "GET":
            self._page_image(path, q)
        elif path == "qr.svg" and method == "GET":
            scale = int(q["scale"]) if q.get("scale", "").isdigit() else 8
            self.send_bytes(200, hub.qr_svg(q.get("ip"), scale), "image/svg+xml")
        elif path == "remote" and method == "GET":
            self.send_json(200, {"devices": hub.remote_overview()})
        elif path.startswith("remote/"):
            self._remote(method, path.split("/")[1:])
        elif method != "POST":
            self.send_json(405, {"error": "method"})
        elif path == "folder":
            body = self.read_json()
            p = Path(str(body.get("path", ""))).expanduser()
            if not p.is_dir():
                self.send_json(400, {"error": "not_a_folder"})
                return
            hub.set_root(str(p))
            self.send_json(200, {"ok": True})
        elif path == "choose-folder":
            chosen = hub.choose_folder()
            if chosen:
                hub.set_root(chosen)
            self.send_json(200, {"ok": bool(chosen), "path": chosen})
        elif path == "panels":
            mode = str(self.read_json().get("mode", ""))
            if mode not in ("auto", "on", "off"):
                self.send_json(400, {"error": "mode"})
                return
            hub.config.update(panels=mode)
            hub.panels.poke(reload=True)
            self.send_json(200, {"ok": True})
        elif path == "panelizer":
            body = self.read_json()
            folder = str(body.get("path") or "")
            if body.get("choose"):
                folder = hub.choose_folder(title="Choose the panelizer folder (tools\\panelizer)")
                if not folder:
                    self.send_json(200, {"ok": False, "cancelled": True})
                    return
            ok = hub.panels.use_panelizer(folder)
            self.send_json(200 if ok else 400, {"ok": ok, "path": folder})
        elif path == "panels/upgrade":
            hub.panels.request_upgrade()
            self.send_json(200, {"ok": True})
        elif path == "panels/retry":
            hub.panels.retry_failed()
            self.send_json(200, {"ok": True})
        elif path == "pair-request":
            body = self.read_json()
            ok = hub.pairing.decide(str(body.get("id", "")), bool(body.get("allow")))
            self.send_json(200 if ok else 410, {"ok": ok})
        elif path == "forget":
            hub.forget_device(str(self.read_json().get("deviceId", "")))
            self.send_json(200, {"ok": True})
        elif path == "new-code":
            hub.pairing.new_code()
            self.send_json(200, {"ok": True})
        elif path == "show":
            if hub.desktop is not None:
                hub.desktop.show()
            self.send_json(200, {"ok": hub.desktop is not None})
        elif path == "autostart":
            on = bool(self.read_json().get("on"))
            ok = hub.desktop is not None and hub.desktop.set_autostart(on)
            self.send_json(200 if ok else 409, {"ok": ok})
        elif path == "window/fullscreen":
            ok = hub.desktop is not None and hub.desktop.toggle_fullscreen()
            self.send_json(200, {"ok": bool(ok)})
        elif path == "away":
            hub.set_away(bool(self.read_json().get("on")))
            self.send_json(200, {"ok": True})
        elif path == "name" and method == "POST":
            # What devices see when they look for this PC (the Windows name until changed).
            name = " ".join(str(self.read_json().get("name", "")).split())[:40]
            if not name or any(ord(c) < 32 for c in name):
                self.send_json(400, {"error": "bad_name"})
            else:
                hub.config.update(name=name)
                hub.log(f"PC name: {name}")
                self.send_json(200, {"ok": True, "name": name})
        elif path == "open-url":
            url = str(self.read_json().get("url", ""))
            ok = url.startswith(("https://tailscale.com/", "https://login.tailscale.com/"))  # only pages the hub links to
            if ok:
                import webbrowser

                webbrowser.open(url)
            self.send_json(200 if ok else 400, {"ok": ok})
        elif path == "open-logs":
            ok = hub.desktop is not None and hub.desktop.open_log_folder()
            self.send_json(200 if ok else 409, {"ok": ok})
        elif path == "firewall/fix":
            self.send_json(200, hub.firewall_fix())
        elif path == "firewall/check":
            self.send_json(200, hub.firewall_check())
        elif path == "stop":
            self.send_json(200, {"ok": True})
            hub.stop_soon()
        else:
            self.send_json(404, {"error": "not_found"})

    def _remote(self, method: str, parts: list[str]) -> None:
        """/admin/remote/<device>/cover/<id>, GET or POST /admin/remote/<device>/want/<id>."""
        hub = self.hub
        if len(parts) != 3 or not parts[2].isdigit():
            self.send_json(404, {"error": "not_found"})
            return
        dev, what, vid = parts[0], parts[1], int(parts[2])
        if what == "cover" and method == "GET":
            body = hub.remote.cover(dev, vid)
            if body is None:
                self.send_json(404, {"error": "no_cover"})
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "private, max-age=604800")  # URLs carry the cover version
            self.end_headers()
            self.wfile.write(body)
        elif what == "want" and method == "GET":
            self.send_json(200, hub.remote_status(dev, vid))
        elif what == "want" and method == "POST":
            self.send_json(200, hub.remote_want(dev, vid))
        else:
            self.send_json(404, {"error": "not_found"})

    def _page_image(self, path: str, q: dict) -> None:
        """/admin/page/<id>/<n>, for the PC reader."""
        parts = path.split("/")
        v = self._lookup(parts[1]) if len(parts) >= 2 else None
        if v is None:
            return
        try:
            pages = volume_pages(v)
            n = int(parts[2])
            name = pages[n]["name"]
            body = page_bytes(v, name)
        except (IndexError, ValueError, KeyError):
            self.send_json(404, {"error": "no_page"})
            return
        except (OSError, zipfile.BadZipFile):
            self.send_json(409, {"error": "unreadable"})
            return
        self.send_response(200)
        self.send_header("Content-Type", mime_of(name))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "private, max-age=86400")  # URLs carry the version
        self.end_headers()
        self.wfile.write(body)

    def _static(self, path: str) -> None:
        if not self._local_only():
            body = (f"<!doctype html><title>{brand.HUB}</title><p>{brand.HUB} is running. "
                    f"Open {brand.NAME} on your device to connect.</p>").encode("utf-8")
            self.send_bytes(200, body, "text/html; charset=utf-8")
            return
        name = {"/": "index.html", "/read": "index.html"}.get(path, path.lstrip("/"))
        if not _STATIC.fullmatch(name):
            self.send_json(404, {"error": "not_found"})
            return
        f = WEB_DIR / name
        if not f.is_file():
            self.send_json(404, {"error": "not_found"})
            return
        body = f.read_bytes()
        if name == "index.html":
            body = body.replace(b"__ADMIN_KEY__", self.hub.admin_key.encode("ascii"))
        if brand.NAME != "Mangarino" and f.suffix in (".html", ".js"):
            body = body.replace(b"Mangarino", brand.NAME.encode("utf-8"))  # the test build's name on screen
        self.send_bytes(200, body, _CONTENT_TYPES[f.suffix])
