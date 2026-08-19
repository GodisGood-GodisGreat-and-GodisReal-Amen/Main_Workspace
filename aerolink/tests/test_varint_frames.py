import unittest

from aerolink.frames import (
    FrameDecoder,
    Hello,
    Msg,
    DeltaMsg,
    ProtocolError,
    RefMsg,
    TransferChunk,
    TransferStart,
    decode_messages,
    encode_frame,
    encode_message,
)
from aerolink.varint import (
    NeedMoreData,
    decode_bytes,
    decode_uvarint,
    encode_bytes,
    encode_uvarint,
)


class VarintTests(unittest.TestCase):
    def test_round_trip(self):
        for value in [0, 1, 127, 128, 255, 300, 16383, 16384, 2**32, 2**63 - 1]:
            encoded = encode_uvarint(value)
            decoded, pos = decode_uvarint(encoded)
            self.assertEqual(decoded, value)
            self.assertEqual(pos, len(encoded))

    def test_small_values_cost_one_byte(self):
        self.assertEqual(len(encode_uvarint(0)), 1)
        self.assertEqual(len(encode_uvarint(127)), 1)
        self.assertEqual(len(encode_uvarint(128)), 2)

    def test_negative_rejected(self):
        with self.assertRaises(ValueError):
            encode_uvarint(-1)

    def test_truncated_raises_need_more_data(self):
        with self.assertRaises(NeedMoreData):
            decode_uvarint(b"\x80")
        with self.assertRaises(NeedMoreData):
            decode_bytes(encode_uvarint(10) + b"abc")

    def test_bytes_round_trip(self):
        blob = b"hello low-bandwidth world"
        data, pos = decode_bytes(encode_bytes(blob))
        self.assertEqual(data, blob)


class FrameTests(unittest.TestCase):
    def test_frame_round_trip(self):
        frame = encode_frame(1, True, b"payload")
        decoder = FrameDecoder()
        frames = decoder.feed(frame)
        self.assertEqual(frames, [(1, True, b"payload")])
        self.assertEqual(decoder.pending_bytes, 0)

    def test_byte_by_byte_feeding(self):
        frames_bytes = encode_frame(0, False, b"a" * 300) + encode_frame(2, False, b"bb")
        decoder = FrameDecoder()
        collected = []
        for i in range(len(frames_bytes)):
            collected += decoder.feed(frames_bytes[i:i + 1])
        self.assertEqual(collected, [(0, False, b"a" * 300), (2, False, b"bb")])

    def test_bad_version_rejected(self):
        bad = bytes([0xF0]) + b"\x00"
        with self.assertRaises(ProtocolError):
            FrameDecoder().feed(bad)

    def test_oversized_frame_rejected(self):
        from aerolink.varint import encode_uvarint as enc
        bad = bytes([0x10]) + enc((1 << 20) + 1)
        with self.assertRaises(ProtocolError):
            FrameDecoder().feed(bad)


class MessageCodecTests(unittest.TestCase):
    def test_all_kinds_round_trip(self):
        msgs = [
            Hello(((3, 100), (7, 0))),
            Msg(1, 5, b"payload"),
            DeltaMsg(2, 9, 8, b"12345678", b"\x01\x03abc"),
            RefMsg(4, 2, bytes(range(16))),
            TransferStart(11, 5000, b"abcdefgh", b"photo.jpg"),
            TransferChunk(11, 2048, b"x" * 100),
        ]
        batch = b"".join(encode_message(m) for m in msgs)
        self.assertEqual(decode_messages(batch), msgs)

    def test_empty_batch(self):
        self.assertEqual(decode_messages(b""), [])

    def test_truncated_batch_rejected(self):
        batch = encode_message(Msg(1, 1, b"hello"))
        with self.assertRaises(ProtocolError):
            decode_messages(batch[:-2])

    def test_unknown_kind_rejected(self):
        with self.assertRaises(ProtocolError):
            decode_messages(b"\xff")

    def test_small_message_overhead_is_tiny(self):
        # kind + channel + seq + length = 4 bytes for small values
        encoded = encode_message(Msg(1, 1, b""))
        self.assertLessEqual(len(encoded), 4)


if __name__ == "__main__":
    unittest.main()
