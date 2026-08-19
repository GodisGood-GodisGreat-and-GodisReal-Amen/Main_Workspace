"""AeroLink wire format: compact binary frames and messages.

Layout on the byte stream::

    frame  := flags(1B) | uvarint(len) | blob
    flags  := version(bits 4-7) | dict_used(bit 2) | codec(bits 0-1)
    blob   := compress(batch)                  # see compression.py
    batch  := message*                         # concatenated messages
    message:= kind(1B) | kind-specific fields  # uvarints + length-prefixed bytes

A batch packs many small messages into one frame so the per-message wire
overhead is a few bytes instead of a whole header, and so the compressor
sees them together. Compared with the ubiquitous newline-JSON framing this
alone typically halves small-message traffic before compression even starts.
"""

from __future__ import annotations

from dataclasses import dataclass

from .varint import NeedMoreData, decode_bytes, decode_uvarint, encode_bytes, encode_uvarint

__all__ = [
    "PROTOCOL_VERSION",
    "MAX_FRAME_PAYLOAD",
    "ProtocolError",
    "encode_frame",
    "FrameDecoder",
    "Msg",
    "DeltaMsg",
    "RefMsg",
    "TransferStart",
    "TransferChunk",
    "Hello",
    "encode_message",
    "decode_messages",
]

PROTOCOL_VERSION = 1

#: Upper bound accepted by the decoder; guards against corrupt lengths.
MAX_FRAME_PAYLOAD = 1 << 20

_K_HELLO = 0
_K_MSG = 1
_K_DELTA = 2
_K_REF = 3
_K_TSTART = 4
_K_TCHUNK = 5

_CHECK_BYTES = 8
_KEY_BYTES = 16


class ProtocolError(Exception):
    """The byte stream violates the AeroLink wire protocol."""


def encode_frame(codec: int, used_dict: bool, blob: bytes) -> bytes:
    if not 0 <= codec <= 3:
        raise ValueError("codec must fit in 2 bits")
    flags = (PROTOCOL_VERSION << 4) | (0x04 if used_dict else 0) | codec
    return bytes([flags]) + encode_uvarint(len(blob)) + blob


class FrameDecoder:
    """Incremental frame parser tolerant of arbitrary byte-stream chopping."""

    def __init__(self) -> None:
        self._buf = bytearray()

    @property
    def pending_bytes(self) -> int:
        return len(self._buf)

    def reset(self) -> None:
        self._buf.clear()

    def feed(self, data: bytes) -> list[tuple[int, bool, bytes]]:
        """Absorb ``data``; return every complete ``(codec, used_dict, blob)``."""
        self._buf += data
        frames: list[tuple[int, bool, bytes]] = []
        while self._buf:
            flags = self._buf[0]
            version = flags >> 4
            if version != PROTOCOL_VERSION:
                raise ProtocolError(f"unsupported protocol version {version}")
            try:
                length, pos = decode_uvarint(self._buf, 1)
            except NeedMoreData:
                break
            if length > MAX_FRAME_PAYLOAD:
                raise ProtocolError(f"frame payload of {length} bytes exceeds limit")
            end = pos + length
            if end > len(self._buf):
                break
            blob = bytes(self._buf[pos:end])
            del self._buf[:end]
            frames.append((flags & 0x03, bool(flags & 0x04), blob))
        return frames


@dataclass(frozen=True)
class Msg:
    """A full application payload on a channel."""
    channel: int
    seq: int
    payload: bytes


@dataclass(frozen=True)
class DeltaMsg:
    """A payload encoded as a delta against the channel's previous payload."""
    channel: int
    seq: int
    base_seq: int
    check: bytes  # sha256(payload)[:8], verified after reconstruction
    delta: bytes


@dataclass(frozen=True)
class RefMsg:
    """A payload the receiver already holds, addressed by content key."""
    channel: int
    seq: int
    key: bytes


@dataclass(frozen=True)
class TransferStart:
    """Announces a resumable bulk transfer."""
    tid: int
    total: int
    check: bytes  # sha256(data)[:8], verified on completion
    meta: bytes


@dataclass(frozen=True)
class TransferChunk:
    tid: int
    offset: int
    data: bytes


@dataclass(frozen=True)
class Hello:
    """Session (re)start marker; lists in-progress transfer offsets so the
    peer resumes instead of resending."""
    transfers: tuple[tuple[int, int], ...]  # (tid, contiguous bytes received)


Message = object  # documentation alias; decode_messages returns the classes above


def encode_message(msg) -> bytes:
    out = bytearray()
    if isinstance(msg, Msg):
        out.append(_K_MSG)
        out += encode_uvarint(msg.channel)
        out += encode_uvarint(msg.seq)
        out += encode_bytes(msg.payload)
    elif isinstance(msg, DeltaMsg):
        if len(msg.check) != _CHECK_BYTES:
            raise ValueError("delta check must be 8 bytes")
        out.append(_K_DELTA)
        out += encode_uvarint(msg.channel)
        out += encode_uvarint(msg.seq)
        out += encode_uvarint(msg.base_seq)
        out += msg.check
        out += encode_bytes(msg.delta)
    elif isinstance(msg, RefMsg):
        if len(msg.key) != _KEY_BYTES:
            raise ValueError("content key must be 16 bytes")
        out.append(_K_REF)
        out += encode_uvarint(msg.channel)
        out += encode_uvarint(msg.seq)
        out += msg.key
    elif isinstance(msg, TransferStart):
        if len(msg.check) != _CHECK_BYTES:
            raise ValueError("transfer check must be 8 bytes")
        out.append(_K_TSTART)
        out += encode_uvarint(msg.tid)
        out += encode_uvarint(msg.total)
        out += msg.check
        out += encode_bytes(msg.meta)
    elif isinstance(msg, TransferChunk):
        out.append(_K_TCHUNK)
        out += encode_uvarint(msg.tid)
        out += encode_uvarint(msg.offset)
        out += encode_bytes(msg.data)
    elif isinstance(msg, Hello):
        out.append(_K_HELLO)
        out += encode_uvarint(len(msg.transfers))
        for tid, received in msg.transfers:
            out += encode_uvarint(tid)
            out += encode_uvarint(received)
    else:
        raise TypeError(f"cannot encode {type(msg).__name__}")
    return bytes(out)


def _take_fixed(batch: bytes, pos: int, count: int) -> tuple[bytes, int]:
    end = pos + count
    if end > len(batch):
        raise ProtocolError("truncated message field")
    return batch[pos:end], end


def decode_messages(batch: bytes) -> list:
    """Decode a full batch back into message objects."""
    msgs: list = []
    pos = 0
    n = len(batch)
    try:
        while pos < n:
            kind = batch[pos]
            pos += 1
            if kind == _K_MSG:
                channel, pos = decode_uvarint(batch, pos)
                seq, pos = decode_uvarint(batch, pos)
                payload, pos = decode_bytes(batch, pos)
                msgs.append(Msg(channel, seq, payload))
            elif kind == _K_DELTA:
                channel, pos = decode_uvarint(batch, pos)
                seq, pos = decode_uvarint(batch, pos)
                base_seq, pos = decode_uvarint(batch, pos)
                check, pos = _take_fixed(batch, pos, _CHECK_BYTES)
                delta, pos = decode_bytes(batch, pos)
                msgs.append(DeltaMsg(channel, seq, base_seq, check, delta))
            elif kind == _K_REF:
                channel, pos = decode_uvarint(batch, pos)
                seq, pos = decode_uvarint(batch, pos)
                key, pos = _take_fixed(batch, pos, _KEY_BYTES)
                msgs.append(RefMsg(channel, seq, key))
            elif kind == _K_TSTART:
                tid, pos = decode_uvarint(batch, pos)
                total, pos = decode_uvarint(batch, pos)
                check, pos = _take_fixed(batch, pos, _CHECK_BYTES)
                meta, pos = decode_bytes(batch, pos)
                msgs.append(TransferStart(tid, total, check, meta))
            elif kind == _K_TCHUNK:
                tid, pos = decode_uvarint(batch, pos)
                offset, pos = decode_uvarint(batch, pos)
                data, pos = decode_bytes(batch, pos)
                msgs.append(TransferChunk(tid, offset, data))
            elif kind == _K_HELLO:
                count, pos = decode_uvarint(batch, pos)
                transfers = []
                for _ in range(count):
                    tid, pos = decode_uvarint(batch, pos)
                    received, pos = decode_uvarint(batch, pos)
                    transfers.append((tid, received))
                msgs.append(Hello(tuple(transfers)))
            else:
                raise ProtocolError(f"unknown message kind {kind}")
    except NeedMoreData as exc:
        raise ProtocolError("truncated message in batch") from exc
    return msgs
