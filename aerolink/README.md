# AeroLink ✈️📡

**A lossless link engine that keeps applications lightning fast on very-low-bandwidth networks** — 2G, satellite, LoRa-class radios, congested venue Wi-Fi, anything down to a couple of kilobytes per second.

AeroLink never trades quality for speed. Every technique in the pipeline is **strictly lossless** and checksum-verified: the receiver reconstructs *exactly* the bytes the sender gave, or the protocol fails loudly. The speed comes from making every byte earn its place on the wire.

Pure Python, **zero dependencies**, sans-io (bring your own socket).

## Measured results

From `demo/lowband_demo.py` — one minute of realistic field traffic (telemetry, chat, a live-edited 26 KB document, 20 Hz GPS fixes) over a simulated 16 kbps satellite link:

| sender | wire bytes | time @16 kbps | |
|---|---:|---:|---|
| naive newline-JSON | 275,778 B | 137.9 s | falls ~78 s behind live traffic |
| gzip each message | 74,666 B | 37.3 s | 3.7× better |
| **AeroLink** | **17,766 B** | **8.9 s** | **15.5× better — keeps up in real time** |

93% of application bytes never had to cross the wire, and every delivered payload was byte-identical to what was sent.

## How it stays fast without losing quality

Each outbound payload flows through a pipeline where **every stage is lossless**:

| # | technique | what it does | typical win |
|---|---|---|---|
| 1 | **Coalescing** | queued-but-unsent updates with the same `coalesce_key` are superseded in place (opt-in, for latest-value-wins state like positions and gauges); delivered state is always the exact latest payload | pays for bursts: N updates → 1 |
| 2 | **Content dedup** | a payload the peer already holds this session ships as a ~20-byte reference (16-byte SHA-256 prefix), whatever its size | re-sends cost ~nothing |
| 3 | **Delta sync** | a payload similar to the channel's previous one ships as an rsync-style rolling-checksum binary diff, verified with an 8-byte SHA-256 check on reconstruction | 10–100× on revisions & telemetry |
| 4 | **Micro-batching + binary framing** | many small messages share one varint-framed frame (~4-byte per-message overhead) instead of per-message headers | halves small-message traffic |
| 5 | **Shared-dictionary compression** | batches are DEFLATE/LZMA-compressed against a rolling 32 KB dictionary of recent traffic, mirrored on both ends; if compression doesn't help, raw bytes ship — never larger, never lossy | 2–10× on real traffic |
| 6 | **Priority pacing** | a token bucket keeps the backlog inside AeroLink where CONTROL > INTERACTIVE > BULK still applies, and frames stay small — so an urgent message overtakes a bulk transfer instead of sitting behind 100 s of socket buffer | interactive stays snappy under load |
| 7 | **Resumable transfers** | bulk payloads stream in chunks; after a disconnect the peer's HELLO reports how much it holds and the sender resumes from that byte, whole-blob checksum verified at the end | a drop costs seconds, not the file |

## Quick start

```python
from aerolink import AeroLink, LinkConfig, CONTROL, MessageReceived

station = AeroLink(LinkConfig(rate_bytes_per_s=2000))   # pace for ~16 kbps
base    = AeroLink()

# --- station side -------------------------------------------------------
station.send(1, b'{"temp":21.5,"rpm":1450}')            # telemetry channel
station.send(2, b"drone fix", coalesce_key=b"drone-1")  # latest-value-wins
station.send(0, b"EMERGENCY STOP", priority=CONTROL)    # jumps every queue
station.start_transfer(7, open("map.bin", "rb").read(), meta=b"map.bin")

wire_bytes = station.pump(now=time.monotonic())         # -> your transport

# --- base side ----------------------------------------------------------
for event in base.receive(wire_bytes):                  # <- your transport
    if isinstance(event, MessageReceived):
        print(event.channel, event.payload)
```

AeroLink is a *sans-io* engine: `send()` / `start_transfer()` queue work, `pump(now)` returns the bytes to write to any ordered reliable transport (TCP, TLS, WebSocket, serial radio), and `receive(data)` turns incoming bytes into events. Call `pump()` on a short timer (e.g. every 20–100 ms).

**Disconnects:** when the transport drops and comes back, call `on_reconnect(now)` on **both** endpoints. Coding state resets symmetrically and in-flight transfers resume from the receiver's reported offset instead of restarting.

**Adaptive pacing:** feed observed throughput into `BandwidthEstimator` and apply `estimator.suggested_rate()` via `link.set_rate()` to track a link whose capacity moves.

## Guarantees

- **Byte-exact delivery.** Deltas carry an 8-byte SHA-256 check of the reconstructed payload; transfers carry one for the whole blob; framing is validated end to end. Any desync raises `ProtocolError` rather than delivering wrong bytes.
- **Never worse than raw.** Compression falls back to raw bytes whenever it doesn't help, so incompressible data (photos, encrypted blobs) pays only ~2% framing overhead.
- **Per-channel FIFO ordering** within a priority tier.
- Coalescing drops only *queued, not-yet-sent* intermediates, and only on channels where the app opted in with `coalesce_key`.

## Layout

```
aerolink/
  aerolink/            the package (pure stdlib)
    varint.py          LEB128 integers + length-prefixed bytes
    frames.py          wire framing, message codec, ProtocolError
    compression.py     adaptive RAW/DEFLATE/LZMA + shared TrafficDictionary
    delta.py           rsync-style rolling-checksum binary deltas
    cache.py           content-addressed SyncedCache (lockstep LRU)
    pacing.py          TokenBucket + BandwidthEstimator
    link.py            the AeroLink engine (pipeline, priorities, transfers)
    metrics.py         LinkStats — where every saved byte came from
  tests/               57 unit + end-to-end tests
  demo/lowband_demo.py the 16 kbps simulation shown above
```

## Running tests and the demo

```bash
cd aerolink
python3 -m unittest discover -s tests   # 57 tests, < 1 s
python3 demo/lowband_demo.py            # the numbers above
```

Requires Python ≥ 3.9. No third-party packages.

## Design notes & limits (v0.1)

- AeroLink assumes an **ordered reliable byte stream** underneath (TCP-like). It reduces *bytes*; the transport provides delivery. Across a hard disconnect, messages already framed but not yet delivered need application-level re-send if you require exactly-once semantics — bulk transfers, the expensive part, resume automatically.
- Dictionaries, caches and delta bases are session-scoped and reset symmetrically on `on_reconnect()`. Persistent cross-session caches are a natural next step.
- Roadmap: persistent content cache, FEC mode for lossy datagram links, async transport adapters.
