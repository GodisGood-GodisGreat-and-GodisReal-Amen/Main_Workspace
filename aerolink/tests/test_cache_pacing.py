import unittest

from aerolink.cache import SyncedCache, content_key
from aerolink.pacing import BandwidthEstimator, TokenBucket


class SyncedCacheTests(unittest.TestCase):
    def test_put_get(self):
        c = SyncedCache(1000)
        key = content_key(b"hello")
        c.put(key, b"hello")
        self.assertEqual(c.get(key), b"hello")
        self.assertIn(key, c)

    def test_lru_eviction_by_bytes(self):
        c = SyncedCache(100)
        keys = []
        for i in range(5):
            payload = bytes([i]) * 40
            keys.append(content_key(payload))
            c.put(keys[-1], payload)
        # 5 * 40 = 200 bytes demanded, only the 2 most recent fit
        self.assertEqual(c.keys(), keys[-2:])
        self.assertLessEqual(c.size_bytes, 100)

    def test_get_refreshes_lru_position(self):
        c = SyncedCache(100)
        a, b = content_key(b"A" * 40), content_key(b"B" * 40)
        c.put(a, b"A" * 40)
        c.put(b, b"B" * 40)
        c.get(a)  # A becomes most recent
        c.put(content_key(b"C" * 40), b"C" * 40)  # evicts B, not A
        self.assertIn(a, c)
        self.assertNotIn(b, c)

    def test_two_caches_stay_in_lockstep(self):
        import random
        rng = random.Random(5)
        left, right = SyncedCache(500), SyncedCache(500)
        payloads = [bytes([i]) * rng.randrange(10, 120) for i in range(30)]
        for _ in range(200):
            p = rng.choice(payloads)
            k = content_key(p)
            for c in (left, right):
                if k in c:
                    c.get(k)
                else:
                    c.put(k, p)
        self.assertEqual(left.keys(), right.keys())

    def test_oversized_payload_skipped(self):
        c = SyncedCache(10)
        k = content_key(b"X" * 50)
        c.put(k, b"X" * 50)
        self.assertNotIn(k, c)


class TokenBucketTests(unittest.TestCase):
    def test_unlimited_by_default(self):
        b = TokenBucket()
        self.assertEqual(b.take(10**9, now=0.0), 10**9)

    def test_rate_limits_over_time(self):
        b = TokenBucket(rate_bytes_per_s=1000, burst_bytes=500)
        got = b.take(10_000, now=0.0)   # only the initial burst
        self.assertEqual(got, 500)
        for i in range(1, 5):           # drain frequently: +1 s at 1000 B/s
            got += b.take(10_000, now=i * 0.25)
        self.assertEqual(got, 1500)
        got += b.take(10_000, now=1.5)
        self.assertEqual(got, 2000)

    def test_burst_caps_accumulation(self):
        b = TokenBucket(rate_bytes_per_s=1000, burst_bytes=300)
        b.take(300, now=0.0)
        self.assertEqual(b.take(10_000, now=100.0), 300)


class BandwidthEstimatorTests(unittest.TestCase):
    def test_converges_toward_observed_rate(self):
        e = BandwidthEstimator(alpha=0.5)
        for _ in range(20):
            e.observe(2000, 1.0)
        self.assertAlmostEqual(e.bytes_per_s, 2000, delta=10)
        self.assertLess(e.suggested_rate(), 2000)

    def test_ignores_degenerate_samples(self):
        e = BandwidthEstimator()
        e.observe(0, 1.0)
        e.observe(100, 0.0)
        self.assertIsNone(e.bytes_per_s)
        self.assertIsNone(e.suggested_rate())


if __name__ == "__main__":
    unittest.main()
