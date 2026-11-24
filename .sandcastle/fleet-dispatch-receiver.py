#!/usr/bin/env python3
"""fleet-dispatch-receiver.py — the fleet dispatcher's report receiver (ADR 0009,
slice 2 / #355).

ADR 0009 ruling A: a host PUSHES its slot report over the mesh to the dispatcher
(no ssh pull, so the dispatcher needs no key onto any host). This is the small
authenticated endpoint that terminates that push. It is DELIBERATELY dumb: it
checks the bearer token, writes the POST body verbatim into the inbox spool as
one file, answers 200, and does nothing else. All validation and keying happen
in tested bash (fleet-dispatch-lib.sh's fleet_dispatch_ingest, which the loop
runs over the inbox each pass), so a malformed or hostile body can at worst leave
one junk file the next drain drops — it can never corrupt a per-host report or
make the dispatcher decide on garbage.

Keeping the receiver this thin is the "no state of its own" posture (decision 2)
at the edge: the inbox is a handoff, not a store. The acknowledgement this
returns is a plain 200 in slice 2; the host does NOT yet act on it — consuming
the ack to fall back to the per-host tick is decision 4 / slice 3 (#356).

Env:
  FLEET_DISPATCH_INBOX   where report bodies are spooled (required)
  FLEET_DISPATCH_TOKEN   optional bearer; when set, a POST must carry
                         `Authorization: Bearer <token>` or it is 401
  FLEET_DISPATCH_BIND    bind address (default 127.0.0.1 — the operator points
                         it at the host's mesh address; never 0.0.0.0)
  FLEET_DISPATCH_PORT    bind port (default 8790)

The session lane (ADR 0010) adds one READ endpoint, as dumb as the write one:
`GET <base>/session-offers?host=<h>&wait=<s>` is a host's long poll. The receiver
stamps the poll (the proof that host's offer waiter is connected), then hands over
whatever offer files the dispatcher loop has written into that host's outbox,
deleting each as it is delivered; with none waiting it holds the request open up
to <s> seconds. It decides nothing — the loop wrote the offers. The session half
of the acknowledgement (`session_acting`) is true only for a host the lane is
live for AND whose poll is connected, so a host whose waiter died goes back to its
own session tick.

Env (session lane):
  FLEET_DISPATCH_SESSION_MODE        off|shadow|live (default off)
  FLEET_DISPATCH_SESSION_LIVE_HOSTS  optional allowlist (empty = every host)
  FLEET_DISPATCH_SESSION_OUTBOX      <dir>/<host>/*.json offers (the loop writes)
  FLEET_DISPATCH_SESSION_WAITERS     <dir>/<host> poll stamps (this writes)
  FLEET_DISPATCH_SESSION_WAITER_TTL  seconds a stamp proves a connected waiter (150)

This binds a socket and so is runtime glue not run in the offline bash suite
(the main-mts-offline rule); its real behaviour — auth gate + spool one file — is
the `--write-stdin` path, which tests/fleet-dispatch-receiver-test.sh drives with
no socket. The loop that consumes the inbox is the tested bash half.
"""
import json
import os
import re
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

MAX_BODY = 256 * 1024  # a slot report is a few KB; cap the read so a bad client cannot OOM us


def inbox_dir():
    d = os.environ.get("FLEET_DISPATCH_INBOX")
    if not d:
        sys.stderr.write("fleet-dispatch-receiver: FLEET_DISPATCH_INBOX is unset\n")
        sys.exit(2)
    return d


def host_is_live(host):
    """Mirror of fleet-dispatch-lib.sh's _fleet_dispatch_host_is_live: True iff a
    run placed on <host> is dispatched for real this pass — the dispatcher is LIVE
    AND (the live-host allowlist is empty -> fleet-wide, stage 6c; or <host> is
    named in it -> stage 6b). The ack's `acting` MUST match whether this host's
    slots are really being taken, so a stage-6b dispatcher stands down only the one
    host it dispatches to and leaves every other host on its own tick. A host we
    cannot name (None, from an unparseable body) is never live under a non-empty
    allowlist — the safe direction: never stand a host down for a dispatcher that
    is not actually taking its slots."""
    if os.environ.get("FLEET_DISPATCH_MODE", "shadow") != "live":
        return False
    allow = os.environ.get("FLEET_DISPATCH_LIVE_HOSTS", "").split()
    if not allow:
        return True
    return host in allow


def ack_payload(host=None):
    """The acknowledgement the receiver returns on every accepted report (ADR
    0009 decision 4 / #356). `acting` is true iff this dispatcher is LIVE and
    actually allocating THIS host's free slots (host_is_live); in shadow it
    dispatches nothing (decision 6a) and in stage 6b it is live for one host only,
    so it only asks that host to stand down. The host's slot-report producer reads
    `acting` off the 2xx body and defers its own tick while the ack is fresh. Mode
    and the allowlist are read from the two env vars the dispatcher loop reads
    (FLEET_DISPATCH_MODE, FLEET_DISPATCH_LIVE_HOSTS); `fleet-dispatch.sh serve`
    exports both so this subprocess and the loop never disagree. Mirrors
    fleet_dispatch_host_mode, so the ack and the real dispatch flip together."""
    mode = os.environ.get("FLEET_DISPATCH_MODE", "shadow")
    return {"ok": True, "acting": host_is_live(host), "mode": mode,
            "session_acting": session_acting(host)}


# ── the session lane (ADR 0010) ──────────────────────────────────────────────
MAX_WAIT = 55          # the longest one poll is held open (seconds)
SAFE_HOST = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]*$")


def safe_host(host):
    """A host name usable as ONE path component — never a separator, never a
    leading dot. Anything else is refused before it reaches the filesystem."""
    return isinstance(host, str) and bool(SAFE_HOST.match(host))


def session_host_is_live(host):
    """Mirror of fleet-session-lib.sh's _fleet_session_host_is_live."""
    if os.environ.get("FLEET_DISPATCH_SESSION_MODE", "off") != "live":
        return False
    allow = os.environ.get("FLEET_DISPATCH_SESSION_LIVE_HOSTS", "").split()
    if not allow:
        return True
    return host in allow


def waiter_fresh(host):
    """True iff <host>'s offer poll reached us within the waiter TTL."""
    d = os.environ.get("FLEET_DISPATCH_SESSION_WAITERS", "")
    if not d or not safe_host(host):
        return False
    try:
        ttl = int(os.environ.get("FLEET_DISPATCH_SESSION_WAITER_TTL", "150"))
        return (time.time() - os.stat(os.path.join(d, host)).st_mtime) < ttl
    except (OSError, ValueError):
        return False


def session_acting(host):
    """The session half of the acknowledgement (ADR 0010 decision 5): true iff
    the dispatcher is allocating session work for THIS host — the lane is live
    for it AND its offer poll is connected. A host that could not be handed an
    offer must keep picking for itself, so a dead waiter reads false."""
    return bool(host) and session_host_is_live(host) and waiter_fresh(host)


def stamp_waiter(host):
    d = os.environ.get("FLEET_DISPATCH_SESSION_WAITERS", "")
    if not d:
        return
    try:
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, host)
        with open(path, "a"):
            pass
        os.utime(path, None)
    except OSError:
        pass


def take_offers(host):
    """Hand over every offer waiting for <host>, oldest first, deleting each
    file as it is taken (an offer is delivered at most once; one that is lost
    after this point simply times out in the dispatcher and is offered again).
    An expired or unreadable file is dropped, never delivered."""
    d = os.environ.get("FLEET_DISPATCH_SESSION_OUTBOX", "")
    if not d or not safe_host(host):
        return []
    hd = os.path.join(d, host)
    try:
        names = sorted(n for n in os.listdir(hd) if n.endswith(".json"))
    except OSError:
        return []
    out = []
    now = time.time()
    for name in names:
        path = os.path.join(hd, name)
        try:
            with open(path, "rb") as fh:
                offer = json.loads(fh.read())
            os.unlink(path)
        except Exception:  # noqa: BLE001 — a bad file is dropped, never served
            try:
                os.unlink(path)
            except OSError:
                pass
            continue
        if not isinstance(offer, dict) or offer.get("expires", 0) <= now:
            continue
        out.append(offer)
    return out


def poll_offers(host, wait):
    """One long poll: stamp the waiter, then return the offers for <host> as soon
    as there are any, or an empty list after <wait> seconds. The stamp is
    refreshed while the request is held, so a connected waiter never reads stale."""
    deadline = time.time() + max(0, min(wait, MAX_WAIT))
    while True:
        stamp_waiter(host)
        offers = take_offers(host)
        if offers or time.time() >= deadline:
            return offers
        time.sleep(1)


def parse_host(body):
    """Best-effort: the reporting host's key off the JSON body, for the per-host
    ack only. The spool stays verbatim (the receiver does not otherwise parse);
    a parse failure or a non-string host yields None, which under a scoped-live
    allowlist acks acting=false — the safe direction host_is_live documents."""
    try:
        obj = json.loads(body)
    except Exception:  # noqa: BLE001 — any malformed body just means "no host"
        return None
    if not isinstance(obj, dict):
        return None
    h = obj.get("host")
    return h if isinstance(h, str) else None


def authorized(auth_header):
    """True iff the request may spool. With no FLEET_DISPATCH_TOKEN set the
    endpoint is open (the mesh is the only reachable path); with one set, the
    header must be exactly `Bearer <token>`."""
    token = os.environ.get("FLEET_DISPATCH_TOKEN", "")
    if not token:
        return True
    return auth_header == "Bearer " + token


def spool(body):
    """Write one report body into the inbox atomically (tmp + rename), so the
    draining loop never reads a half-written file. Returns the final path."""
    d = inbox_dir()
    os.makedirs(d, exist_ok=True)
    # A monotonic, collision-free name: epoch-nanos + pid. Content is opaque here.
    name = "%d-%d.json" % (time.time_ns(), os.getpid())
    fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(body)
        final = os.path.join(d, name)
        os.rename(tmp, final)
        return final
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class Handler(BaseHTTPRequestHandler):
    def _reply(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if not authorized(self.headers.get("Authorization", "")):
            self._reply(401, {"ok": False, "error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self._reply(413, {"ok": False, "error": "bad or missing Content-Length"})
            return
        body = self.rfile.read(length)
        try:
            spool(body)
        except Exception as exc:  # noqa: BLE001 — never leak a stack to the wire
            sys.stderr.write("fleet-dispatch-receiver: could not spool a report: %s\n" % exc)
            self._reply(500, {"ok": False, "error": "spool failed"})
            return
        # The 200 carries the acknowledgement (slice 3 / #356): the host reads
        # `acting` off it to decide whether to stand its own tick down (decision 4).
        # `acting` is per-host (stage 6b), so the host is parsed off the body it
        # just spooled; an unparseable body acks acting=false (the safe direction).
        self._reply(200, ack_payload(parse_host(body)))

    def do_GET(self):
        # The session lane's offer poll (ADR 0010 decision 3). Same bearer gate as
        # a report; any other path is a 404.
        if not authorized(self.headers.get("Authorization", "")):
            self._reply(401, {"ok": False, "error": "unauthorized"})
            return
        url = urlparse(self.path)
        if not url.path.rstrip("/").endswith("/session-offers"):
            self._reply(404, {"ok": False, "error": "not found"})
            return
        q = parse_qs(url.query)
        host = (q.get("host") or [""])[0]
        if not safe_host(host):
            self._reply(400, {"ok": False, "error": "bad or missing host"})
            return
        try:
            wait = int((q.get("wait") or ["0"])[0])
        except ValueError:
            wait = 0
        self._reply(200, {"ok": True, "session_acting": session_host_is_live(host),
                          "offers": poll_offers(host, wait)})

    def log_message(self, *args):  # quiet: the dispatcher's own log is the record
        pass


def serve():
    bind = os.environ.get("FLEET_DISPATCH_BIND", "127.0.0.1")
    port = int(os.environ.get("FLEET_DISPATCH_PORT", "8790"))
    inbox_dir()  # fail fast if unset
    httpd = ThreadingHTTPServer((bind, port), Handler)
    sys.stderr.write("fleet-dispatch-receiver: listening on %s:%d\n" % (bind, port))
    httpd.serve_forever()


def write_stdin(auth_header):
    """Test seam: spool one body read from stdin, applying the same auth gate as
    a POST, without binding a socket. Exit 0 and print the spooled path; exit 1
    when the auth header is rejected."""
    if not authorized(auth_header):
        sys.stderr.write("fleet-dispatch-receiver: unauthorized\n")
        return 1
    path = spool(sys.stdin.buffer.read())
    print(path)
    return 0


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--write-stdin":
        auth = ""
        if "--auth" in sys.argv:
            auth = sys.argv[sys.argv.index("--auth") + 1]
        sys.exit(write_stdin(auth))
    # --ack [--host H]: print the exact acknowledgement body a 200 would carry for
    # host H (reading FLEET_DISPATCH_MODE + FLEET_DISPATCH_LIVE_HOSTS) and exit,
    # without binding a socket. The both-ends contract test
    # (fleet-dispatch-ack-contract-test.sh) feeds this verbatim to the host's
    # slot-report send, proving the two ends share one ack shape — including that a
    # stage-6b dispatcher stands down only the host it names.
    # --offers --host H: the body one offer poll for H returns (no wait, no
    # socket) — the session lane's test seam, and the other end of the waiter's
    # contract test.
    if len(sys.argv) >= 2 and sys.argv[1] == "--offers":
        host = sys.argv[sys.argv.index("--host") + 1] if "--host" in sys.argv else ""
        if not safe_host(host):
            sys.stderr.write("fleet-dispatch-receiver: bad or missing host\n")
            sys.exit(1)
        print(json.dumps({"ok": True, "session_acting": session_host_is_live(host),
                          "offers": poll_offers(host, 0)}))
        sys.exit(0)
    if len(sys.argv) >= 2 and sys.argv[1] == "--ack":
        host = None
        if "--host" in sys.argv:
            host = sys.argv[sys.argv.index("--host") + 1]
        print(json.dumps(ack_payload(host)))
        sys.exit(0)
    serve()
