#!/usr/bin/env python3
"""Throwaway SMTP sink for the smoke drive (matou-app#51 follow-up).

The booking flow's only job is sending a confirmation email, so the backend
answers 500 when nothing listens on MATOU_SMTP_PORT (3525 in test mode —
clean-start gotcha #16). This accepts any SMTP session, swallows the message,
and appends a one-line summary per message to the log file, so the leg log
carries proof the mail was "sent". Stdlib only (aiosmtpd is not installed on
the runner).

usage: smtp-sink.py [--port 3525] [--log FILE]
"""
import argparse
import asyncio
import datetime
import sys


async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, log) -> None:
    peer = writer.get_extra_info("peername")
    mail_from, rcpts, data_lines, in_data = "", [], [], False

    async def send(line: str) -> None:
        writer.write((line + "\r\n").encode())
        await writer.drain()

    await send("220 smtp-sink ESMTP")
    try:
        while True:
            raw = await reader.readline()
            if not raw:
                break
            line = raw.decode(errors="replace").rstrip("\r\n")
            if in_data:
                if line == ".":
                    in_data = False
                    subject = next((l[8:].strip() for l in data_lines if l.lower().startswith("subject:")), "")
                    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                    log.write(f"{stamp} from={mail_from} to={','.join(rcpts)} subject={subject!r} bytes={sum(len(l) for l in data_lines)}\n")
                    log.flush()
                    mail_from, rcpts, data_lines = "", [], []
                    await send("250 OK queued")
                else:
                    data_lines.append(line[1:] if line.startswith("..") else line)
                continue
            verb = line.split(" ", 1)[0].upper()
            if verb in ("EHLO", "HELO"):
                await send("250-smtp-sink\r\n250 8BITMIME")
            elif verb == "MAIL":
                mail_from = line.partition(":")[2].strip()
                await send("250 OK")
            elif verb == "RCPT":
                rcpts.append(line.partition(":")[2].strip())
                await send("250 OK")
            elif verb == "DATA":
                in_data = True
                await send("354 End data with <CR><LF>.<CR><LF>")
            elif verb == "QUIT":
                await send("221 Bye")
                break
            elif verb in ("RSET", "NOOP"):
                mail_from, rcpts, data_lines = "", [], []
                await send("250 OK")
            elif verb == "STARTTLS":
                await send("454 TLS not available")
            else:
                await send("250 OK")
    except (ConnectionError, asyncio.IncompleteReadError):
        pass
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
    log.write(f"# session closed peer={peer}\n")
    log.flush()


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=3525)
    ap.add_argument("--log", default="-")
    args = ap.parse_args()
    log = sys.stdout if args.log == "-" else open(args.log, "a", buffering=1)
    # Bind both loopback families: the backend dials "localhost", which Go
    # resolves to [::1] first.
    server = await asyncio.start_server(
        lambda r, w: handle(r, w, log), host=["127.0.0.1", "::1"], port=args.port, reuse_address=True
    )
    print(f"smtp-sink: listening on 127.0.0.1/::1 port {args.port}", file=sys.stderr, flush=True)
    async with server:
        await server.serve_forever()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        pass
