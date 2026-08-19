"""The AeroLink engine.

``AeroLink`` is a *sans-io* protocol engine: it never touches sockets. You
hand it application payloads with :meth:`AeroLink.send`, pull wire bytes out
with :meth:`AeroLink.pump`, and push received wire bytes into
:meth:`AeroLink.receive` on the far end. That makes it trivial to bolt onto
TCP, TLS, WebSockets, serial radios — anything that behaves like an ordered
reliable byte stream — and just as trivial to test deterministically.

Why it stays fast when the pipe gets thin
-----------------------------------------

Every payload runs through a pipeline in which **each stage is lossless**:

1. **Coalescing** — queued-but-unsent updates with the same
   ``coalesce_key`` are superseded in place, so a burst of 50 cursor moves
   costs one message. (Only *unsent* intermediates are replaced; delivered
   state is always the exact latest payload.)
2. **Dedup** — a payload the peer already holds this session is sent as a
   ~20-byte content reference instead of being re-shipped.
3. **Delta sync** — a payload similar to the channel's previous one is sent
   as an rsync-style binary diff, checksum-verified on reconstruction.
4. **Micro-batching + binary framing** — many small messages share one
   compact varint-framed frame instead of paying per-message overhead.
5. **Shared-dictionary compression** — batches are DEFLATE/LZMA compressed
   against a rolling dictionary of recent traffic mirrored on both ends;
   if compression doesn't help, raw bytes ship (never larger, never lossy).
6. **Priority pacing** — control/interactive frames overtake bulk frames,
   and a token bucket keeps the backlog inside AeroLink (where priorities
   still apply) instead of inside the kernel's socket buffer.
7. **Resumable transfers** — bulk payloads stream in chunks; after a
   disconnect the receiver's HELLO reports how much it has, and the sender
   resumes from that offset instead of starting over.

Integrity: deltas carry an 8-byte SHA-256 check of the reconstructed
payload and transfers carry one for the whole blob, so any desync fails
loudly (:class:`ProtocolError`) instead of delivering corrupt data.
"""

from __future__ import annotations

import hashlib
from collections import deque
from dataclasses import dataclass, field

from .cache import SyncedCache, content_key
from .compression import TrafficDictionary, compress_best, decompress
from .delta import apply_delta, make_delta
from .frames import (
    DeltaMsg,
    FrameDecoder,
    Hello,
    Msg,
    ProtocolError,
    RefMsg,
    TransferChunk,
    TransferStart,
    decode_messages,
    encode_frame,
    encode_message,
)
from .metrics import LinkStats
from .pacing import TokenBucket
from .varint import encode_uvarint

__all__ = [
    "CONTROL",
    "INTERACTIVE",
    "BULK",
    "LinkConfig",
    "AeroLink",
    "ProtocolError",
    "MessageReceived",
    "TransferStarted",
    "TransferProgress",
    "TransferCompleted",
    "PeerHello",
]

CONTROL = 0
INTERACTIVE = 1
BULK = 2
_TIERS = (CONTROL, INTERACTIVE, BULK)


def _check8(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()[:8]


@dataclass(frozen=True)
class LinkConfig:
    """Tuning knobs. The defaults are sane for links from ~1 kB/s up."""

    block_size: int = 1024            # delta block size for large payloads
    chunk_bytes: int = 2048           # transfer chunk payload size
    max_batch_bytes: int = 4096       # plaintext batch cap (keeps frames small
                                      # so urgent traffic never waits long)
    max_batch_msgs: int = 64
    flush_delay: tuple[float, float, float] = (0.0, 0.02, 0.05)  # per tier
    cache_bytes: int = 4 * 1024 * 1024
    dict_bytes: int = 32 * 1024
    lzma_min_bytes: int = 4096
    delta_min_payload: int = 64       # below this a diff can't beat the raw bytes
    delta_max_payload: int = 256 * 1024
    delta_max_ratio: float = 0.85     # delta must be at least 15% smaller
    ref_min_payload: int = 33         # a content ref costs ~20 B
    dict_sample_bytes: int = 2048     # per-payload cap fed to the dictionary
    bulk_backlog_frames: int = 4      # transfer chunk generation backpressure
    rate_bytes_per_s: float | None = None
    burst_bytes: int = 4096


# --------------------------------------------------------------------------
# Events surfaced by AeroLink.receive()

@dataclass(frozen=True)
class MessageReceived:
    channel: int
    seq: int
    payload: bytes


@dataclass(frozen=True)
class TransferStarted:
    tid: int
    total: int
    meta: bytes


@dataclass(frozen=True)
class TransferProgress:
    tid: int
    received: int
    total: int


@dataclass(frozen=True)
class TransferCompleted:
    tid: int
    data: bytes
    meta: bytes


@dataclass(frozen=True)
class PeerHello:
    transfers: tuple[tuple[int, int], ...]


# --------------------------------------------------------------------------
# Internal bookkeeping records

@dataclass(eq=False)
class _Pending:
    enqueued_at: float
    tier: int = INTERACTIVE
    channel: int = 0
    payload: bytes | None = None
    coalesce_key: bytes | None = None
    encoded: bytes | None = None  # pre-encoded (HELLO / TSTART) bypasses pipeline

    def size_hint(self) -> int:
        body = self.payload if self.payload is not None else self.encoded
        return len(body or b"") + 8


@dataclass
class _OutTransfer:
    tid: int
    data: bytes
    meta: bytes
    check: bytes
    next_offset: int = 0
    paused: bool = False

    @property
    def remaining(self) -> int:
        return len(self.data) - self.next_offset


@dataclass
class _InTransfer:
    tid: int
    total: int
    check: bytes
    meta: bytes
    buf: bytearray = field(default_factory=bytearray)

    @property
    def received(self) -> int:
        return len(self.buf)


class AeroLink:
    """One endpoint of a low-bandwidth link. See the module docstring."""

    def __init__(self, config: LinkConfig | None = None, name: str = "") -> None:
        self._cfg = config or LinkConfig()
        self.name = name
        self.stats = LinkStats()
        self._now_hint = 0.0

        # Outbound coding state (mirrored by the peer's inbound state).
        self._out_seq: dict[int, int] = {}
        self._out_prev: dict[int, tuple[int, bytes]] = {}
        self._out_dict = TrafficDictionary(self._cfg.dict_bytes)
        self._out_cache = SyncedCache(self._cfg.cache_bytes)

        # Inbound coding state (mirrors the peer's outbound state).
        self._in_prev: dict[int, tuple[int, bytes]] = {}
        self._in_dict = TrafficDictionary(self._cfg.dict_bytes)
        self._in_cache = SyncedCache(self._cfg.cache_bytes)

        # Logical outbound queues, one per priority tier.
        self._pending: tuple[deque, deque, deque] = (deque(), deque(), deque())
        self._pending_bytes = [0, 0, 0]
        self._coalesce: dict[tuple[int, bytes], _Pending] = {}

        # Framed wire output, one queue per tier, plus the frame mid-emission.
        self._wire: tuple[deque, deque, deque] = (deque(), deque(), deque())
        self._inflight: bytes = b""
        self._bucket = TokenBucket(self._cfg.rate_bytes_per_s, self._cfg.burst_bytes)

        self._decoder = FrameDecoder()

        self._out_transfers: dict[int, _OutTransfer] = {}
        self._in_transfers: dict[int, _InTransfer] = {}
        self._in_completed: dict[int, int] = {}
        self._rr = 0  # round-robin cursor across concurrent transfers

    # ------------------------------------------------------------------
    # Application-facing API

    def send(self, channel: int, payload: bytes, *, priority: int = INTERACTIVE,
             coalesce_key: bytes | None = None) -> None:
        """Queue ``payload`` on ``channel``.

        ``coalesce_key``: updates sharing a key are superseded while still
        queued — use it for latest-value-wins state (positions, gauges).
        """
        if channel < 0:
            raise ValueError("channel must be non-negative")
        if priority not in _TIERS:
            raise ValueError("priority must be CONTROL, INTERACTIVE or BULK")
        payload = bytes(payload)
        self.stats.logical_bytes_out += len(payload)
        if coalesce_key is not None:
            slot = self._coalesce.get((channel, coalesce_key))
            if slot is not None and slot.payload is not None:
                self.stats.coalesced_messages += 1
                self._pending_bytes[slot.tier] += len(payload) - len(slot.payload)
                slot.payload = payload
                return
        entry = _Pending(enqueued_at=self._now_hint, tier=priority, channel=channel,
                         payload=payload, coalesce_key=coalesce_key)
        if coalesce_key is not None:
            self._coalesce[(channel, coalesce_key)] = entry
        self._enqueue(priority, entry)

    def start_transfer(self, tid: int, data: bytes, meta: bytes = b"") -> None:
        """Begin a resumable bulk transfer of ``data`` identified by ``tid``."""
        if tid in self._out_transfers:
            raise ValueError(f"transfer id {tid} already in use")
        data = bytes(data)
        record = _OutTransfer(tid=tid, data=data, meta=bytes(meta), check=_check8(data))
        self._out_transfers[tid] = record
        self.stats.logical_bytes_out += len(data)
        self._enqueue_transfer_start(record)

    def set_rate(self, rate_bytes_per_s: float | None) -> None:
        """Adjust outbound pacing, e.g. from a :class:`~aerolink.pacing.BandwidthEstimator`."""
        self._bucket.set_rate(rate_bytes_per_s)

    def pump(self, now: float) -> bytes:
        """Flush due batches and return the bytes to write to the transport."""
        self._now_hint = now
        for tier in _TIERS:
            if self._flush_due(tier, now):
                self._flush_tier(tier)
        self._generate_transfer_frames()
        return self._emit(now)

    def receive(self, data: bytes) -> list:
        """Process transport bytes; returns the events they produced."""
        if not data:
            return []
        self.stats.wire_bytes_in += len(data)
        events: list = []
        for codec, used_dict, blob in self._decoder.feed(data):
            self.stats.frames_in += 1
            zdict = self._in_dict.snapshot() if used_dict else b""
            batch = decompress(codec, used_dict, blob, zdict)
            samples: list[bytes] = []
            for msg in decode_messages(batch):
                self._handle_message(msg, events, samples)
            for sample in samples:
                self._in_dict.add(sample)
        return events

    def on_reconnect(self, now: float) -> None:
        """Call on **both** endpoints when the underlying transport dropped
        and was re-established.

        Bytes in flight are gone, so the mirrored coding state (dictionary,
        cache, per-channel delta bases) is reset symmetrically; incomplete
        outbound transfers pause until the peer's HELLO reports how much it
        already has, then resume from there.
        """
        self._now_hint = now
        for q in self._wire:
            q.clear()
        self._inflight = b""
        self._decoder.reset()
        self._out_prev.clear()
        self._out_dict.clear()
        self._out_cache.clear()
        self._in_prev.clear()
        self._in_dict.clear()
        self._in_cache.clear()
        for t in self._out_transfers.values():
            if t.remaining > 0 or t.next_offset == len(t.data):
                t.paused = True
        progress = [(t.tid, t.received) for t in self._in_transfers.values()]
        progress += list(self._in_completed.items())
        hello = Hello(tuple(sorted(progress)))
        self._enqueue(CONTROL, _Pending(enqueued_at=now, encoded=encode_message(hello)))

    def idle(self) -> bool:
        """True when nothing remains to flush, emit, or transfer."""
        if any(self._pending) or any(self._wire) or self._inflight:
            return False
        return all(t.remaining == 0 for t in self._out_transfers.values())

    @property
    def wire_backlog_bytes(self) -> int:
        return len(self._inflight) + sum(len(f) for q in self._wire for f in q)

    # ------------------------------------------------------------------
    # Outbound pipeline

    def _enqueue(self, tier: int, entry: _Pending) -> None:
        entry.tier = tier
        self._pending[tier].append(entry)
        self._pending_bytes[tier] += entry.size_hint()

    def _enqueue_transfer_start(self, t: _OutTransfer) -> None:
        msg = TransferStart(t.tid, len(t.data), t.check, t.meta)
        self._enqueue(BULK, _Pending(enqueued_at=self._now_hint, encoded=encode_message(msg)))

    def _flush_due(self, tier: int, now: float) -> bool:
        queue = self._pending[tier]
        if not queue:
            return False
        if self._pending_bytes[tier] >= self._cfg.max_batch_bytes:
            return True
        if len(queue) >= self._cfg.max_batch_msgs:
            return True
        return (now - queue[0].enqueued_at) >= self._cfg.flush_delay[tier]

    def _flush_tier(self, tier: int) -> None:
        queue = self._pending[tier]
        batch = bytearray()
        count = 0
        samples: list[bytes] = []
        while queue:
            entry = queue.popleft()
            self._pending_bytes[tier] -= entry.size_hint()
            if entry.coalesce_key is not None:
                key = (entry.channel, entry.coalesce_key)
                if self._coalesce.get(key) is entry:
                    del self._coalesce[key]
            if entry.encoded is not None:
                encoded, sample = entry.encoded, None
            else:
                encoded, sample = self._encode_channel_message(entry.channel, entry.payload)
            if batch and (len(batch) + len(encoded) > self._cfg.max_batch_bytes
                          or count >= self._cfg.max_batch_msgs):
                self._finish_batch(tier, batch, samples)
                batch = bytearray()
                count = 0
                samples = []
            batch += encoded
            count += 1
            self.stats.messages_out += 1
            # The sample must ride with the frame that carries its message —
            # the receiver feeds its mirrored dictionary strictly per frame.
            if sample is not None:
                samples.append(sample)
        if batch:
            self._finish_batch(tier, batch, samples)
        self._pending_bytes[tier] = 0

    def _encode_channel_message(self, channel: int, payload: bytes) -> tuple[bytes, bytes]:
        cfg = self._cfg
        seq = self._out_seq.get(channel, 0) + 1
        self._out_seq[channel] = seq
        full_len = (1 + len(encode_uvarint(channel)) + len(encode_uvarint(seq))
                    + len(encode_uvarint(len(payload))) + len(payload))
        encoded: bytes | None = None
        key = content_key(payload)

        if len(payload) >= cfg.ref_min_payload and key in self._out_cache:
            encoded = encode_message(RefMsg(channel, seq, key))
            self.stats.ref_hits += 1
            self.stats.ref_bytes_saved += full_len - len(encoded)

        if encoded is None and cfg.delta_min_payload <= len(payload) <= cfg.delta_max_payload:
            prev = self._out_prev.get(channel)
            if prev is not None and len(prev[1]) >= 16:
                base_seq, base = prev
                block = max(16, min(cfg.block_size, len(base) // 4))
                delta = make_delta(base, payload, block)
                candidate = encode_message(
                    DeltaMsg(channel, seq, base_seq, _check8(payload), delta))
                if len(candidate) <= cfg.delta_max_ratio * full_len:
                    encoded = candidate
                    self.stats.delta_messages += 1
                    self.stats.delta_bytes_saved += full_len - len(candidate)

        if encoded is None:
            encoded = encode_message(Msg(channel, seq, payload))

        # Mirrored bookkeeping — the receiver performs the identical updates.
        self._out_cache.put(key, payload)
        self._out_prev[channel] = (seq, payload)
        return encoded, payload[:cfg.dict_sample_bytes]

    def _finish_batch(self, tier: int, batch: bytearray, samples: list[bytes]) -> None:
        plain = bytes(batch)
        zdict = self._out_dict.snapshot()
        codec, used_dict, blob = compress_best(plain, zdict, self._cfg.lzma_min_bytes)
        if len(blob) < len(plain):
            self.stats.compression_bytes_saved += len(plain) - len(blob)
        self._wire[tier].append(encode_frame(codec, used_dict, blob))
        self.stats.frames_out += 1
        for sample in samples:
            self._out_dict.add(sample)

    def _generate_transfer_frames(self) -> None:
        cfg = self._cfg
        while len(self._wire[BULK]) < cfg.bulk_backlog_frames:
            active = [t for t in self._out_transfers.values()
                      if not t.paused and t.remaining > 0]
            if not active:
                return
            active.sort(key=lambda t: t.tid)
            batch = bytearray()
            start = self._rr
            for i in range(len(active)):
                t = active[(start + i) % len(active)]
                while t.remaining > 0:
                    chunk = t.data[t.next_offset:t.next_offset + cfg.chunk_bytes]
                    encoded = encode_message(TransferChunk(t.tid, t.next_offset, chunk))
                    if batch and len(batch) + len(encoded) > cfg.max_batch_bytes:
                        break
                    batch += encoded
                    t.next_offset += len(chunk)
                    self.stats.messages_out += 1
                    self._rr = (start + i + 1) % max(1, len(active))
                    if len(batch) >= cfg.max_batch_bytes:
                        break
                if len(batch) >= cfg.max_batch_bytes:
                    break
            if not batch:
                return
            self._finish_batch(BULK, batch, [])

    def _emit(self, now: float) -> bytes:
        total = self.wire_backlog_bytes
        if total == 0:
            return b""
        budget = self._bucket.take(total, now)
        out = bytearray()
        while budget > 0:
            if self._inflight:
                take = min(budget, len(self._inflight))
                out += self._inflight[:take]
                self._inflight = self._inflight[take:]
                budget -= take
                continue
            frame = None
            for q in self._wire:
                if q:
                    frame = q.popleft()
                    break
            if frame is None:
                break
            self._inflight = frame
        self.stats.wire_bytes_out += len(out)
        return bytes(out)

    # ------------------------------------------------------------------
    # Inbound pipeline

    def _handle_message(self, msg, events: list, samples: list[bytes]) -> None:
        self.stats.messages_in += 1
        if isinstance(msg, Msg):
            self._deliver_payload(msg.channel, msg.seq, msg.payload, events, samples)
        elif isinstance(msg, DeltaMsg):
            prev = self._in_prev.get(msg.channel)
            if prev is None or prev[0] != msg.base_seq:
                raise ProtocolError(
                    f"delta on channel {msg.channel} references unknown base seq {msg.base_seq}")
            payload = apply_delta(prev[1], msg.delta)
            if _check8(payload) != msg.check:
                raise ProtocolError(f"delta checksum mismatch on channel {msg.channel}")
            self._deliver_payload(msg.channel, msg.seq, payload, events, samples)
        elif isinstance(msg, RefMsg):
            payload = self._in_cache.get(msg.key)
            if payload is None:
                raise ProtocolError(f"reference to unknown content key on channel {msg.channel}")
            self._deliver_payload(msg.channel, msg.seq, payload, events, samples)
        elif isinstance(msg, TransferStart):
            self._handle_transfer_start(msg, events)
        elif isinstance(msg, TransferChunk):
            self._handle_transfer_chunk(msg, events)
        elif isinstance(msg, Hello):
            self._handle_hello(msg, events)
        else:  # pragma: no cover — decode_messages only yields the above
            raise ProtocolError(f"unhandled message type {type(msg).__name__}")

    def _deliver_payload(self, channel: int, seq: int, payload: bytes,
                         events: list, samples: list[bytes]) -> None:
        # Mirrored bookkeeping — must match _encode_channel_message exactly.
        self._in_cache.put(content_key(payload), payload)
        self._in_prev[channel] = (seq, payload)
        samples.append(payload[:self._cfg.dict_sample_bytes])
        self.stats.logical_bytes_in += len(payload)
        events.append(MessageReceived(channel, seq, payload))

    def _handle_transfer_start(self, msg: TransferStart, events: list) -> None:
        if msg.tid in self._in_transfers or msg.tid in self._in_completed:
            return  # duplicate announcement after a resume — already tracked
        record = _InTransfer(msg.tid, msg.total, msg.check, msg.meta)
        if msg.total == 0:
            if _check8(b"") != msg.check:
                raise ProtocolError(f"transfer {msg.tid} checksum mismatch")
            self._in_completed[msg.tid] = 0
            events.append(TransferStarted(msg.tid, 0, msg.meta))
            events.append(TransferCompleted(msg.tid, b"", msg.meta))
            return
        self._in_transfers[msg.tid] = record
        events.append(TransferStarted(msg.tid, msg.total, msg.meta))

    def _handle_transfer_chunk(self, msg: TransferChunk, events: list) -> None:
        if msg.tid in self._in_completed:
            return  # stale duplicate
        record = self._in_transfers.get(msg.tid)
        if record is None:
            raise ProtocolError(f"chunk for unknown transfer {msg.tid}")
        if msg.offset != record.received:
            raise ProtocolError(
                f"transfer {msg.tid} chunk at offset {msg.offset}, expected {record.received}")
        record.buf += msg.data
        if record.received > record.total:
            raise ProtocolError(f"transfer {msg.tid} overran its declared size")
        self.stats.logical_bytes_in += len(msg.data)
        events.append(TransferProgress(msg.tid, record.received, record.total))
        if record.received == record.total:
            data = bytes(record.buf)
            if _check8(data) != record.check:
                raise ProtocolError(f"transfer {msg.tid} checksum mismatch")
            del self._in_transfers[msg.tid]
            self._in_completed[msg.tid] = record.total
            events.append(TransferCompleted(msg.tid, data, record.meta))

    def _handle_hello(self, msg: Hello, events: list) -> None:
        reported = dict(msg.transfers)
        for t in self._out_transfers.values():
            if t.tid in reported:
                t.next_offset = min(reported[t.tid], len(t.data))
                t.paused = False
            elif t.paused:
                # The peer lost everything about this transfer: re-announce
                # and restart it from the top.
                t.next_offset = 0
                t.paused = False
                self._enqueue_transfer_start(t)
        events.append(PeerHello(msg.transfers))
