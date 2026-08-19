"""Rsync-style binary delta encoding.

When a channel re-sends something similar to what it sent before (a
telemetry snapshot, a document revision, a state blob), shipping the whole
payload again wastes the link. Instead the sender diffs the new payload
against the previous one — which the receiver already holds — and ships only
the changes.

The algorithm is the classic rolling-checksum block match:

* the *base* (previous payload) is indexed in fixed-size blocks by a weak
  Adler-style checksum plus a strong 8-byte SHA-256 prefix;
* the *target* (new payload) is scanned with a rolling weak checksum, so a
  matching block is found at **any** byte offset (insertions and deletions
  don't break alignment);
* matches are greedily extended byte-by-byte and merged, unmatched bytes
  become literals.

The result decodes byte-exactly: ``apply_delta(base, make_delta(base, t)) == t``.
"""

from __future__ import annotations

import hashlib

from .varint import decode_bytes, decode_uvarint, encode_bytes, encode_uvarint

__all__ = ["DEFAULT_BLOCK_SIZE", "make_delta", "apply_delta"]

DEFAULT_BLOCK_SIZE = 1024

_MOD = 65521  # largest prime below 2**16, as in Adler-32

_OP_COPY = 0
_OP_LIT = 1


def _weak_ab(data: bytes) -> tuple[int, int]:
    """Weak rolling checksum components over ``data``.

    ``a`` is the plain byte sum; ``b`` weights each byte by its distance from
    the window end, which is what makes O(1) rolling possible.
    """
    a = 0
    b = 0
    length = len(data)
    for j, x in enumerate(data):
        a += x
        b += (length - j) * x
    return a % _MOD, b % _MOD


def _strong(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()[:8]


def _serialize(ops: list[tuple]) -> bytes:
    out = bytearray()
    for op in ops:
        if op[0] == _OP_COPY:
            out.append(_OP_COPY)
            out += encode_uvarint(op[1])
            out += encode_uvarint(op[2])
        else:
            out.append(_OP_LIT)
            out += encode_bytes(op[1])
    return bytes(out)


def make_delta(base: bytes, target: bytes, block_size: int = DEFAULT_BLOCK_SIZE) -> bytes:
    """Encode ``target`` as copy/literal ops against ``base``."""
    if block_size <= 0:
        raise ValueError("block_size must be positive")
    n = len(target)
    if not base or n < block_size or len(base) < block_size:
        return _serialize([(_OP_LIT, target)] if target else [])

    index: dict[int, list[tuple[int, bytes]]] = {}
    for off in range(0, len(base) - block_size + 1, block_size):
        block = base[off:off + block_size]
        a, b = _weak_ab(block)
        index.setdefault((b << 16) | a, []).append((off, _strong(block)))

    ops: list[tuple] = []
    lit = bytearray()
    pos = 0
    a = b = 0
    need_init = True
    while pos + block_size <= n:
        if need_init:
            a, b = _weak_ab(target[pos:pos + block_size])
            need_init = False
        match_off = -1
        bucket = index.get((b << 16) | a)
        if bucket:
            strong = _strong(target[pos:pos + block_size])
            for cand_off, cand_strong in bucket:
                if cand_strong == strong:
                    match_off = cand_off
                    break
        if match_off >= 0:
            if lit:
                ops.append((_OP_LIT, bytes(lit)))
                lit.clear()
            # Extend the match beyond the block for as long as bytes agree.
            length = block_size
            while (match_off + length < len(base) and pos + length < n
                   and base[match_off + length] == target[pos + length]):
                length += 1
            if ops and ops[-1][0] == _OP_COPY and ops[-1][1] + ops[-1][2] == match_off:
                ops[-1] = (_OP_COPY, ops[-1][1], ops[-1][2] + length)
            else:
                ops.append((_OP_COPY, match_off, length))
            pos += length
            need_init = True
        else:
            out_byte = target[pos]
            lit.append(out_byte)
            pos += 1
            if pos + block_size <= n:
                in_byte = target[pos + block_size - 1]
                a = (a - out_byte + in_byte) % _MOD
                b = (b - block_size * out_byte + a) % _MOD
            else:
                need_init = True
    if pos < n:
        lit.extend(target[pos:])
    if lit:
        ops.append((_OP_LIT, bytes(lit)))
    return _serialize(ops)


def apply_delta(base: bytes, delta: bytes) -> bytes:
    """Rebuild the target from ``base`` and a delta produced by :func:`make_delta`."""
    out = bytearray()
    pos = 0
    n = len(delta)
    while pos < n:
        tag = delta[pos]
        pos += 1
        if tag == _OP_COPY:
            offset, pos = decode_uvarint(delta, pos)
            length, pos = decode_uvarint(delta, pos)
            end = offset + length
            if end > len(base):
                raise ValueError("delta copy op out of base bounds")
            out += base[offset:end]
        elif tag == _OP_LIT:
            chunk, pos = decode_bytes(delta, pos)
            out += chunk
        else:
            raise ValueError(f"unknown delta op tag {tag}")
    return bytes(out)
