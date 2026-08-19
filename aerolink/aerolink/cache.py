"""Content-addressed payload cache, kept in lockstep on both ends.

If the application sends a payload the peer has already received this
session (a re-shared file, a repeated status blob, a retransmitted message),
AeroLink ships a 16-byte content key instead of the payload — a fixed ~20
bytes on the wire no matter how large the payload is.

Correctness relies on both ends mutating their cache with the **same
operations in the same order** (the link is an ordered reliable stream, so
the sender's post-send bookkeeping and the receiver's post-receive
bookkeeping see identical sequences). That keeps LRU eviction deterministic
and symmetric: the sender only emits a reference for a key it still holds,
which is exactly the set the receiver still holds.
"""

from __future__ import annotations

import hashlib
from collections import OrderedDict

__all__ = ["KEY_BYTES", "content_key", "SyncedCache"]

KEY_BYTES = 16


def content_key(data: bytes) -> bytes:
    """16-byte SHA-256 prefix identifying ``data`` by content."""
    return hashlib.sha256(data).digest()[:KEY_BYTES]


class SyncedCache:
    """Byte-budgeted LRU keyed by :func:`content_key`."""

    def __init__(self, capacity_bytes: int = 4 * 1024 * 1024) -> None:
        if capacity_bytes <= 0:
            raise ValueError("capacity_bytes must be positive")
        self._capacity = capacity_bytes
        self._items: OrderedDict[bytes, bytes] = OrderedDict()
        self._size = 0

    def __contains__(self, key: bytes) -> bool:
        return key in self._items

    def __len__(self) -> int:
        return len(self._items)

    @property
    def size_bytes(self) -> int:
        return self._size

    def keys(self):
        return list(self._items.keys())

    def put(self, key: bytes, payload: bytes) -> None:
        """Insert or refresh ``payload``. Oversized payloads are skipped on
        both ends alike, preserving symmetry."""
        if len(payload) > self._capacity:
            return
        if key in self._items:
            self._items.move_to_end(key)
            return
        self._items[key] = payload
        self._size += len(payload)
        while self._size > self._capacity:
            _, evicted = self._items.popitem(last=False)
            self._size -= len(evicted)

    def get(self, key: bytes) -> bytes | None:
        """Look up ``key``, refreshing its LRU position on a hit."""
        payload = self._items.get(key)
        if payload is not None:
            self._items.move_to_end(key)
        return payload

    def clear(self) -> None:
        self._items.clear()
        self._size = 0
