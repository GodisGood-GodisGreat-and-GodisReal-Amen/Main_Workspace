import os
import random
import unittest

from aerolink.compression import (
    CODEC_LZMA,
    CODEC_RAW,
    CODEC_ZLIB,
    TrafficDictionary,
    compress_best,
    decompress,
)


def round_trip(data, zdict=b""):
    codec, used_dict, blob = compress_best(data, zdict)
    return codec, blob, decompress(codec, used_dict, blob, zdict)


class CompressionTests(unittest.TestCase):
    def test_lossless_round_trip_all_paths(self):
        cases = [
            b"",
            b"x",
            b"hello " * 500,                      # zlib territory
            (b"the quick brown fox " * 4096),     # large: lzma candidate
            os.urandom(2048),                     # incompressible: raw
        ]
        for data in cases:
            codec, blob, back = round_trip(data)
            self.assertEqual(back, data)

    def test_never_larger_than_raw(self):
        rng = random.Random(7)
        for _ in range(20):
            data = bytes(rng.getrandbits(8) for _ in range(rng.randrange(0, 3000)))
            codec, used_dict, blob = compress_best(data)
            self.assertLessEqual(len(blob), len(data))

    def test_random_data_ships_raw(self):
        data = os.urandom(4096)
        codec, used_dict, blob = compress_best(data)
        self.assertEqual(codec, CODEC_RAW)
        self.assertEqual(blob, data)

    def test_repetitive_data_compresses_hard(self):
        data = b'{"sensor":"pump-3","temp":21.5,"rpm":1450}' * 100
        codec, used_dict, blob = compress_best(data)
        self.assertIn(codec, (CODEC_ZLIB, CODEC_LZMA))
        self.assertLess(len(blob), len(data) // 10)

    def test_dictionary_beats_cold_compression_on_similar_messages(self):
        message = b'{"sensor":"pump-3","temp":21.53,"rpm":1450,"state":"nominal"}'
        similar = b'{"sensor":"pump-3","temp":21.61,"rpm":1447,"state":"nominal"}'
        _, _, cold = compress_best(similar)
        d = TrafficDictionary()
        d.add(message)
        codec, used_dict, warm = compress_best(similar, d.snapshot())
        self.assertLess(len(warm), len(cold))
        self.assertTrue(used_dict)
        self.assertEqual(decompress(codec, used_dict, warm, d.snapshot()), similar)

    def test_dictionary_window_is_bounded_and_keeps_recent(self):
        d = TrafficDictionary(capacity=100)
        d.add(b"a" * 80)
        d.add(b"b" * 50)
        window = d.snapshot()
        self.assertEqual(len(window), 100)
        self.assertTrue(window.endswith(b"b" * 50))

    def test_oversized_sample_keeps_tail(self):
        d = TrafficDictionary(capacity=10)
        d.add(b"0123456789ABCDEF")
        self.assertEqual(d.snapshot(), b"6789ABCDEF")

    def test_unknown_codec_rejected(self):
        with self.assertRaises(ValueError):
            decompress(9, False, b"blob")


if __name__ == "__main__":
    unittest.main()
