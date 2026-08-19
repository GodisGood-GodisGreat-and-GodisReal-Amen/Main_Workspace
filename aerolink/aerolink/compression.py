"""Adaptive, strictly lossless compression.

Two rules keep AeroLink honest:

1. **Never ship a byte more than raw.** Every batch is compressed with the
   candidate codecs and the smallest result wins; if compression would grow
   the payload (already-compressed media, random data), the raw bytes ship.
2. **Never lose a bit.** Only lossless codecs (DEFLATE, LZMA) are used, so
   ``decompress(compress(x)) == x`` always.

On top of that, both ends of a link maintain a :class:`TrafficDictionary` —
a rolling window of recently exchanged payloads used as a DEFLATE preset
dictionary. Real traffic is repetitive (telemetry keys, JSON field names,
protocol boilerplate), so priming the compressor with recent history makes
small messages dramatically smaller than compressing each one cold.
"""

from __future__ import annotations

import lzma
import zlib

__all__ = [
    "CODEC_RAW",
    "CODEC_ZLIB",
    "CODEC_LZMA",
    "TrafficDictionary",
    "compress_best",
    "decompress",
]

CODEC_RAW = 0
CODEC_ZLIB = 1
CODEC_LZMA = 2

#: zlib preset dictionaries are capped at 32 KiB by the DEFLATE window.
MAX_DICT_BYTES = 32 * 1024

#: LZMA's container overhead (~20 B) and CPU cost only pay off on larger blobs.
DEFAULT_LZMA_MIN_BYTES = 4096

_ZLIB_LEVEL = 6
_LZMA_PRESET = 6


class TrafficDictionary:
    """Rolling window of recent traffic, mirrored on both ends of a link.

    Both peers apply the same ``add()`` calls in the same order, so their
    snapshots stay byte-identical and a blob compressed against the sender's
    snapshot always inflates against the receiver's.
    """

    def __init__(self, capacity: int = MAX_DICT_BYTES) -> None:
        if capacity <= 0:
            raise ValueError("dictionary capacity must be positive")
        self._capacity = min(capacity, MAX_DICT_BYTES)
        self._window = b""

    @property
    def capacity(self) -> int:
        return self._capacity

    def add(self, sample: bytes) -> None:
        """Fold ``sample`` into the window, keeping the most recent bytes."""
        if not sample:
            return
        if len(sample) >= self._capacity:
            self._window = bytes(sample[-self._capacity:])
        else:
            self._window = (self._window + sample)[-self._capacity:]

    def snapshot(self) -> bytes:
        """The current dictionary bytes (may be empty)."""
        return self._window

    def clear(self) -> None:
        self._window = b""


def _zlib_compress(data: bytes, zdict: bytes) -> bytes:
    if zdict:
        comp = zlib.compressobj(_ZLIB_LEVEL, zlib.DEFLATED, zlib.MAX_WBITS, 8,
                                zlib.Z_DEFAULT_STRATEGY, zdict)
    else:
        comp = zlib.compressobj(_ZLIB_LEVEL)
    return comp.compress(data) + comp.flush()


def _zlib_decompress(blob: bytes, zdict: bytes) -> bytes:
    if zdict:
        decomp = zlib.decompressobj(zlib.MAX_WBITS, zdict=zdict)
    else:
        decomp = zlib.decompressobj()
    out = decomp.decompress(blob)
    out += decomp.flush()
    return out


def compress_best(data: bytes, zdict: bytes = b"",
                  lzma_min_bytes: int = DEFAULT_LZMA_MIN_BYTES) -> tuple[int, bool, bytes]:
    """Compress ``data`` with the cheapest codec that actually helps.

    Returns ``(codec, used_dict, blob)`` where ``blob`` is guaranteed to be
    no larger than ``data`` (falling back to ``CODEC_RAW`` otherwise).
    """
    best_codec, best_dict, best_blob = CODEC_RAW, False, data
    if data:
        z = _zlib_compress(data, zdict)
        if len(z) < len(best_blob):
            best_codec, best_dict, best_blob = CODEC_ZLIB, bool(zdict), z
        if len(data) >= lzma_min_bytes:
            x = lzma.compress(data, format=lzma.FORMAT_ALONE, preset=_LZMA_PRESET)
            if len(x) < len(best_blob):
                best_codec, best_dict, best_blob = CODEC_LZMA, False, x
    return best_codec, best_dict, best_blob


def decompress(codec: int, used_dict: bool, blob: bytes, zdict: bytes = b"") -> bytes:
    """Reverse :func:`compress_best`. Byte-exact by construction."""
    if codec == CODEC_RAW:
        return blob
    if codec == CODEC_ZLIB:
        return _zlib_decompress(blob, zdict if used_dict else b"")
    if codec == CODEC_LZMA:
        return lzma.decompress(blob, format=lzma.FORMAT_ALONE)
    raise ValueError(f"unknown codec id {codec}")
