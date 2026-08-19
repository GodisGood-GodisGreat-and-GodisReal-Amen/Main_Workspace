import random
import unittest

from aerolink.delta import _MOD, _weak_ab, apply_delta, make_delta


def rt(base, target, block=64):
    return apply_delta(base, make_delta(base, target, block))


class RollingChecksumTests(unittest.TestCase):
    def test_rolling_matches_recompute(self):
        rng = random.Random(42)
        data = bytes(rng.getrandbits(8) for _ in range(2000))
        block = 48
        a, b = _weak_ab(data[0:block])
        for pos in range(1, len(data) - block + 1):
            out_byte = data[pos - 1]
            in_byte = data[pos + block - 1]
            a = (a - out_byte + in_byte) % _MOD
            b = (b - block * out_byte + a) % _MOD
            ra, rb = _weak_ab(data[pos:pos + block])
            self.assertEqual((a, b), (ra, rb), f"divergence at pos {pos}")


class DeltaRoundTripTests(unittest.TestCase):
    def setUp(self):
        rng = random.Random(1234)
        words = [b"alpha", b"bravo", b"charlie", b"delta", b"echo", b"foxtrot"]
        self.base = b" ".join(rng.choice(words) for _ in range(4000))

    def test_identical(self):
        self.assertEqual(rt(self.base, self.base), self.base)

    def test_small_edit(self):
        target = self.base[:5000] + b"[EDITED]" + self.base[5010:]
        self.assertEqual(rt(self.base, target), target)

    def test_insert_and_delete(self):
        target = self.base[:100] + b"NEW CONTENT HERE " * 3 + self.base[100:9000] + self.base[9500:]
        self.assertEqual(rt(self.base, target), target)

    def test_prepend(self):
        target = b"PREFIX " * 10 + self.base
        self.assertEqual(rt(self.base, target), target)

    def test_completely_different(self):
        import os
        target = os.urandom(3000)
        self.assertEqual(rt(self.base, target), target)

    def test_empty_cases(self):
        self.assertEqual(rt(b"", b"hello"), b"hello")
        self.assertEqual(rt(self.base, b""), b"")
        self.assertEqual(rt(b"", b""), b"")

    def test_target_smaller_than_block(self):
        self.assertEqual(rt(self.base, b"tiny", 64), b"tiny")

    def test_random_edit_storm(self):
        rng = random.Random(99)
        target = bytearray(self.base)
        for _ in range(25):
            op = rng.randrange(3)
            pos = rng.randrange(max(1, len(target)))
            if op == 0:
                target[pos:pos] = bytes(rng.getrandbits(8) for _ in range(rng.randrange(1, 40)))
            elif op == 1:
                del target[pos:pos + rng.randrange(1, 40)]
            else:
                end = min(len(target), pos + rng.randrange(1, 20))
                target[pos:end] = bytes(rng.getrandbits(8) for _ in range(end - pos))
        target = bytes(target)
        self.assertEqual(rt(self.base, target), target)

    def test_small_edit_produces_small_delta(self):
        target = self.base[:8000] + b"*" + self.base[8000:]
        delta = make_delta(self.base, target, 64)
        self.assertLess(len(delta), len(target) // 10)

    def test_bad_delta_rejected(self):
        with self.assertRaises(ValueError):
            apply_delta(b"short", b"\x00\xff\x01\x10")  # copy far out of bounds
        with self.assertRaises(ValueError):
            apply_delta(b"", b"\x07")  # unknown tag


if __name__ == "__main__":
    unittest.main()
