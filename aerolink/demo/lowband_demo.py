#!/usr/bin/env python3
"""AeroLink demo: a realistic workload over a simulated 16 kbps satellite link.

Run with:  python3 demo/lowband_demo.py

Scenario A — a field station streams telemetry, chat, live GPS fixes and a
collaboratively edited document for one minute. The identical workload is
costed three ways:

  * naive       — newline-delimited JSON, no compression (the default way
                  most apps talk)
  * gzip-each   — every JSON line individually zlib-compressed (the usual
                  first optimization)
  * AeroLink    — coalescing + dedup + delta sync + batching + shared-dict
                  compression + pacing, all lossless

Scenario B — a ~380 KB report is transferred over the same link; the
connection drops mid-transfer and comes back. AeroLink resumes where it
left off instead of starting over.

Every delivered byte is checked against what was sent: zero quality loss.
"""

from __future__ import annotations

import json
import os
import random
import sys
import zlib

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from aerolink import (  # noqa: E402
    AeroLink,
    LinkConfig,
    MessageReceived,
    TransferCompleted,
    TransferProgress,
)

LINK_BYTES_PER_S = 2000          # 16 kbps — think Iridium / 2G / awful hotel Wi-Fi
ONE_WAY_LATENCY = 0.3            # seconds
TICK = 0.1


class DelayedPipe:
    """One direction of a link: delivers bytes ONE_WAY_LATENCY later."""

    def __init__(self) -> None:
        self._queue: list[tuple[float, bytes]] = []

    def write(self, now: float, data: bytes) -> None:
        if data:
            self._queue.append((now + ONE_WAY_LATENCY, data))

    def read(self, now: float) -> bytes:
        out = bytearray()
        remaining = []
        for at, data in self._queue:
            if at <= now:
                out += data
            else:
                remaining.append((at, data))
        self._queue = remaining
        return bytes(out)

    def drop_everything(self) -> None:
        self._queue.clear()


# ---------------------------------------------------------------------------
# Scenario A: mixed interactive workload

CH_TELEMETRY, CH_CHAT, CH_DOC, CH_GPS = 1, 2, 3, 4


def build_document(rng: random.Random) -> bytes:
    paragraphs = []
    for i in range(60):
        words = ["survey", "ridge", "basin", "sensor", "array", "nominal", "flow",
                 "estimate", "sample", "granite", "sediment", "reading", "north"]
        rng.shuffle(words)
        paragraphs.append(f"## Section {i}\n" + " ".join(words * 4) + ".")
    return ("\n\n".join(paragraphs)).encode()


def build_workload():
    """Returns a list of timed sends: (t, channel, payload, coalesce_key)."""
    rng = random.Random(2026)
    events = []

    # Telemetry: 4 snapshots/s for 60 s — values drift slightly each time.
    temp, rpm, pressure = 21.0, 1450, 2.50
    for i in range(240):
        temp += rng.uniform(-0.05, 0.05)
        rpm += rng.randrange(-3, 4)
        pressure += rng.uniform(-0.01, 0.01)
        payload = json.dumps({
            "device": "pump-station-3", "seq": i,
            "temp": round(temp, 3), "rpm": rpm,
            "pressure": round(pressure, 3), "battery": round(87 - i * 0.02, 2),
            "state": "nominal",
        }, separators=(",", ":")).encode()
        events.append((i * 0.25, CH_TELEMETRY, payload, None))

    # Chat: 40 short messages spread over the minute.
    lines = ["copy that", "reading looks stable", "send the north ridge numbers",
             "on my way to the array", "check pump three again please",
             "all nominal here", "weather closing in around 1400"]
    for i in range(40):
        payload = f"{rng.choice(['ana','kofi','mei'])}: {rng.choice(lines)}".encode()
        events.append((rng.uniform(0, 60), CH_CHAT, payload, None))

    # Live document: a ~26 KB report plus 8 small revisions.
    doc = build_document(rng)
    revisions = [doc]
    for r in range(8):
        cut = rng.randrange(1000, len(revisions[-1]) - 1000)
        insert = f"\n\n> field note {r}: revised estimate {rng.random():.4f}\n".encode()
        revisions.append(revisions[-1][:cut] + insert + revisions[-1][cut:])
    for r, rev in enumerate(revisions):
        events.append((r * 7.0, CH_DOC, rev, None))

    # GPS fixes: 20/s for 15 s while a drone circles — only the LATEST matters,
    # which the app declares with a coalesce key.
    lat, lon = 46.5321, 8.1210
    for i in range(300):
        lat += rng.uniform(-1e-4, 1e-4)
        lon += rng.uniform(-1e-4, 1e-4)
        payload = json.dumps({"id": "drone-1", "lat": round(lat, 6),
                              "lon": round(lon, 6), "alt": 120 + i % 7},
                             separators=(",", ":")).encode()
        events.append((20.0 + i * 0.05, CH_GPS, payload, b"drone-1"))

    events.sort(key=lambda e: e[0])
    return events


def naive_wire_bytes(events) -> int:
    total = 0
    for _, ch, payload, _ in events:
        line = json.dumps({"ch": ch, "data": payload.decode("utf-8")}) + "\n"
        total += len(line.encode())
    return total


def gzip_each_wire_bytes(events) -> int:
    total = 0
    for _, ch, payload, _ in events:
        line = json.dumps({"ch": ch, "data": payload.decode("utf-8")}).encode()
        total += len(zlib.compress(line, 6)) + 4  # + a minimal length prefix
    return total


def run_aerolink(events):
    a = AeroLink(LinkConfig(rate_bytes_per_s=LINK_BYTES_PER_S,
                            burst_bytes=LINK_BYTES_PER_S), name="station")
    b = AeroLink(name="base")
    ab, ba = DelayedPipe(), DelayedPipe()
    delivered: dict[int, list[bytes]] = {}
    now, i, last_delivery = 0.0, 0, 0.0
    while True:
        now = round(now + TICK, 4)
        while i < len(events) and events[i][0] <= now:
            _, ch, payload, key = events[i]
            a.send(ch, payload, coalesce_key=key)
            i += 1
        ab.write(now, a.pump(now))
        for ev in b.receive(ab.read(now)):
            if isinstance(ev, MessageReceived):
                delivered.setdefault(ev.channel, []).append(ev.payload)
                last_delivery = now
        ba.write(now, b.pump(now))
        a.receive(ba.read(now))
        if i >= len(events) and a.idle() and b.idle() and now > last_delivery + 2 * ONE_WAY_LATENCY + 1:
            break
        if now > 600:
            raise RuntimeError("simulation failed to drain")
    return a, delivered, last_delivery


def check_fidelity(events, delivered) -> None:
    sent: dict[int, list[bytes]] = {}
    for _, ch, payload, _ in events:
        sent.setdefault(ch, []).append(payload)
    for ch in (CH_TELEMETRY, CH_CHAT, CH_DOC):
        assert delivered[ch] == sent[ch], f"channel {ch} corrupted!"
    got_gps, sent_gps = delivered[CH_GPS], sent[CH_GPS]
    it = iter(sent_gps)
    assert all(p in it for p in got_gps), "GPS updates reordered or corrupted!"
    assert got_gps[-1] == sent_gps[-1], "final GPS state wrong!"


def fmt_row(name, nbytes, note=""):
    secs = nbytes / LINK_BYTES_PER_S
    return f"  {name:<22} {nbytes:>10,} B   {secs:>7.1f} s   {note}"


def scenario_a() -> None:
    print("=" * 74)
    print("SCENARIO A — one minute of field traffic over a 16 kbps link")
    print("=" * 74)
    events = build_workload()
    app_bytes = sum(len(p) for _, _, p, _ in events)
    naive = naive_wire_bytes(events)
    gz = gzip_each_wire_bytes(events)
    a, delivered, last_delivery = run_aerolink(events)
    check_fidelity(events, delivered)
    aero = a.stats.wire_bytes_out

    print(f"\nWorkload: {len(events)} messages, {app_bytes:,} application bytes "
          f"(telemetry, chat, live doc, GPS)\n")
    print(f"  {'sender':<22} {'wire bytes':>12}   {'@16kbps':>7}")
    print(fmt_row("naive JSON", naive))
    print(fmt_row("gzip each message", gz, f"{naive / gz:.1f}x better"))
    print(fmt_row("AeroLink", aero, f"{naive / aero:.1f}x better"))
    print(f"\n  fidelity check: every delivered payload byte-identical  [OK]")
    print(f"  (GPS channel: app opted into latest-value-wins; final state exact)")
    print(f"  last byte delivered at t={last_delivery:.1f}s — AeroLink keeps up with the live")
    print(f"  60s workload in real time; the naive sender needs {naive / LINK_BYTES_PER_S:.0f}s of link")
    print(f"  time for it, falling ~{naive / LINK_BYTES_PER_S - 60:.0f}s behind with every message queued.\n")
    print("  Where AeroLink's savings came from:")
    for line in a.stats.summary().splitlines():
        print(f"    {line}")
    print()


# ---------------------------------------------------------------------------
# Scenario B: resumable transfer through a mid-transfer disconnect

def build_report() -> bytes:
    rng = random.Random(7)
    rows = []
    for i in range(6000):
        rows.append(f"2026-08-19T{i % 24:02d}:{i % 60:02d}:{i % 60:02d}Z "
                    f"site=NR-{i % 14:02d} flow={rng.uniform(1, 9):.3f} "
                    f"head={rng.uniform(100, 300):.1f} status=OK")
    return "\n".join(rows).encode()


def scenario_b() -> None:
    print("=" * 74)
    print("SCENARIO B — 380 KB report transfer, link drops at t=20s for 3s")
    print("=" * 74)
    report = build_report()
    a = AeroLink(LinkConfig(rate_bytes_per_s=LINK_BYTES_PER_S,
                            burst_bytes=LINK_BYTES_PER_S))
    b = AeroLink()
    ab, ba = DelayedPipe(), DelayedPipe()
    a.start_transfer(42, report, meta=b"north-ridge-report.log")

    now, dropped, resumed_from, completed = 0.0, False, None, None
    received = 0
    wire_at_drop = 0
    while completed is None:
        now = round(now + TICK, 4)
        if not dropped and now >= 20.0:
            dropped = True
            wire_at_drop = a.stats.wire_bytes_out
            ab.drop_everything()          # bytes in flight are lost
            ba.drop_everything()
            a.on_reconnect(now + 3.0)     # transport re-established 3 s later
            b.on_reconnect(now + 3.0)
            resumed_from = received
            now = round(now + 3.0, 4)
            print(f"  t={now - 3:5.1f}s  LINK LOST  (receiver holds {received:,} B)")
            print(f"  t={now:5.1f}s  link re-established; peer reports progress, "
                  f"sender resumes at byte {received:,}")
        ab.write(now, a.pump(now))
        for ev in b.receive(ab.read(now)):
            if isinstance(ev, TransferProgress):
                received = ev.received
            elif isinstance(ev, TransferCompleted):
                completed = ev
        ba.write(now, b.pump(now))
        a.receive(ba.read(now))
        if now > 900:
            raise RuntimeError("transfer failed to complete")

    assert completed.data == report, "transfer corrupted!"
    aero_wire = a.stats.wire_bytes_out
    resent = aero_wire - wire_at_drop

    raw = len(report)
    gz_whole = len(zlib.compress(report, 6))
    naive_restart = raw + min(raw, int(20.0 * LINK_BYTES_PER_S))
    print(f"\n  report size          : {raw:,} B "
          f"(would take {raw / LINK_BYTES_PER_S:.0f} s raw, ignoring the drop)")
    print(f"  AeroLink wire bytes  : {aero_wire:,} B "
          f"(compressed chunks; {raw / aero_wire:.1f}x smaller than raw)")
    print(f"  resumed from         : byte {resumed_from:,} — "
          f"only {resent:,} B sent after reconnect")
    print(f"  restart-from-zero    : would have wasted the "
          f"{min(raw, int(20.0 * LINK_BYTES_PER_S)):,} B already sent "
          f"(naive total {naive_restart:,} B)")
    print(f"  delivered at         : t={now:.1f}s, byte-identical, "
          f"checksum verified  [OK]")
    print(f"  (whole-file gzip for reference: {gz_whole:,} B — but a plain "
          f"gzip stream cannot resume mid-file)")
    print()


if __name__ == "__main__":
    scenario_a()
    scenario_b()
    print("Both scenarios delivered byte-exact data. "
          "Lossless, low-bandwidth, still fast.")
