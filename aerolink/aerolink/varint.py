"""Unsigned LEB128 variable-length integers.

Small numbers (the common case: channel ids, sequence numbers, short
lengths) cost a single byte on the wire instead of a fixed 4 or 8.
"""

from __future__ import annotations

__all__ = ["NeedMoreData", "encode_uvarint", "decode_uvarint", "encode_bytes", "decode_bytes"]


class NeedMoreData(Exception):
    """The buffer ends in the middle of a value; feed more bytes and retry."""


def encode_uvarint(value: int) -> bytes:
    """Encode a non-negative integer as LEB128."""
    if value < 0:
        raise ValueError("uvarint cannot encode negative values")
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def decode_uvarint(buf, offset: int = 0) -> tuple[int, int]:
    """Decode a LEB128 integer from ``buf`` at ``offset``.

    Returns ``(value, next_offset)``. Raises :class:`NeedMoreData` if the
    buffer ends mid-value, ``ValueError`` if the value overflows 64 bits.
    """
    result = 0
    shift = 0
    pos = offset
    while True:
        if pos >= len(buf):
            raise NeedMoreData("truncated uvarint")
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not (byte & 0x80):
            return result, pos
        shift += 7
        if shift > 63:
            raise ValueError("uvarint longer than 64 bits")


def encode_bytes(data: bytes) -> bytes:
    """Length-prefix ``data`` with a uvarint."""
    return encode_uvarint(len(data)) + data


def decode_bytes(buf, offset: int = 0) -> tuple[bytes, int]:
    """Decode a uvarint-length-prefixed byte string. Returns ``(data, next_offset)``."""
    length, pos = decode_uvarint(buf, offset)
    end = pos + length
    if end > len(buf):
        raise NeedMoreData("truncated byte string")
    return bytes(buf[pos:end]), end
