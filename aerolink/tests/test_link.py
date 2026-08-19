import os
import random
import unittest

from aerolink import (
    BULK,
    CONTROL,
    INTERACTIVE,
    AeroLink,
    LinkConfig,
    MessageReceived,
    ProtocolError,
    TransferCompleted,
    TransferProgress,
    TransferStarted,
)
from aerolink.compression import CODEC_RAW
from aerolink.frames import RefMsg, DeltaMsg, encode_frame, encode_message


def drain(a, b, start=0.0, steps=200):
    """Pump both directions until both links are idle; return events per side."""
    ev_a, ev_b = [], []
    now = start
    for _ in range(steps):
        now += 1.0
        wa = a.pump(now)
        ev_b += b.receive(wa)
        wb = b.pump(now)
        ev_a += a.receive(wb)
        if a.idle() and b.idle() and not wa and not wb:
            break
    return ev_a, ev_b, now


def messages(events, channel=None):
    return [e for e in events
            if isinstance(e, MessageReceived) and (channel is None or e.channel == channel)]


class LosslessDeliveryTests(unittest.TestCase):
    def test_mixed_workload_delivered_byte_exact_in_order(self):
        a, b = AeroLink(name="a"), AeroLink(name="b")
        rng = random.Random(31)
        sent_ab = {1: [], 2: []}
        sent_ba = {3: []}
        corpus = [
            b"",
            b"x",
            "héllo wörld ✓".encode("utf-8"),
            b'{"k":"v","n":123}',
            os.urandom(500),
            os.urandom(20_000),          # bigger than one batch
            b"repeat" * 300,
        ]
        for i in range(60):
            ch = rng.choice([1, 2])
            payload = rng.choice(corpus) + str(i).encode()
            sent_ab[ch].append(payload)
            a.send(ch, payload)
            if i % 3 == 0:
                p = rng.choice(corpus) + b"~" + str(i).encode()
                sent_ba[3].append(p)
                b.send(3, p)
        ev_a, ev_b, _ = drain(a, b)
        for ch, sent in sent_ab.items():
            got = [m.payload for m in messages(ev_b, ch)]
            self.assertEqual(got, sent, f"channel {ch} corrupted or reordered")
        got = [m.payload for m in messages(ev_a, 3)]
        self.assertEqual(got, sent_ba[3])

    def test_compressible_traffic_shrinks_dramatically(self):
        a, b = AeroLink(), AeroLink()
        rng = random.Random(8)
        sent = []
        for i in range(200):
            payload = (
                f'{{"device":"pump-station-3","seq":{i},'
                f'"temp":{21 + rng.random():.3f},"rpm":{1450 + rng.randrange(20)},'
                f'"pressure":{2.5 + rng.random():.3f},"state":"nominal"}}'
            ).encode()
            sent.append(payload)
            a.send(1, payload)
        _, ev_b, _ = drain(a, b)
        self.assertEqual([m.payload for m in messages(ev_b, 1)], sent)
        stats = a.stats
        self.assertLess(stats.wire_bytes_out, stats.logical_bytes_out * 0.35,
                        f"expected >65% savings, got {stats.wire_savings_pct:.1f}%")


class DedupTests(unittest.TestCase):
    def test_repeated_payload_costs_only_a_reference(self):
        a, b = AeroLink(), AeroLink()
        payload = os.urandom(2000)  # incompressible: only dedup can help
        a.send(1, payload)
        drain(a, b)
        first_wire = a.stats.wire_bytes_out
        a.send(1, payload)
        a.send(2, payload)
        _, ev_b, _ = drain(a, b, start=10.0)
        self.assertEqual(a.stats.ref_hits, 2)
        self.assertLess(a.stats.wire_bytes_out - first_wire, 120,
                        "re-sends should cost ~20 bytes each, not the payload")
        got = [m.payload for m in messages(ev_b)]
        self.assertEqual(got, [payload, payload])


class DeltaSyncTests(unittest.TestCase):
    def test_document_revision_sends_only_the_change(self):
        a, b = AeroLink(), AeroLink()
        doc = os.urandom(12_000)  # incompressible: only the delta can help
        a.send(5, doc)
        drain(a, b)
        wire_first = a.stats.wire_bytes_out
        revised = doc[:6000] + b"[EDIT]" + doc[6000:]
        a.send(5, revised)
        _, ev_b, _ = drain(a, b, start=10.0)
        self.assertEqual(a.stats.delta_messages, 1)
        self.assertLess(a.stats.wire_bytes_out - wire_first, 3000,
                        "revision should ship as a small delta, not 12 KB")
        self.assertEqual(messages(ev_b, 5)[-1].payload, revised)


class CoalescingTests(unittest.TestCase):
    def test_superseded_updates_collapse_to_latest(self):
        a, b = AeroLink(), AeroLink()
        for i in range(30):
            a.send(3, f"pos={i}".encode(), coalesce_key=b"pos")
        _, ev_b, _ = drain(a, b)
        got = messages(ev_b, 3)
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0].payload, b"pos=29")
        self.assertEqual(a.stats.coalesced_messages, 29)

    def test_coalescing_never_drops_flushed_state(self):
        a, b = AeroLink(), AeroLink()
        a.send(3, b"v1", coalesce_key=b"k")
        drain(a, b)  # v1 flushed and delivered
        a.send(3, b"v2", coalesce_key=b"k")
        a.send(3, b"v3", coalesce_key=b"k")
        _, ev_b, _ = drain(a, b, start=10.0)
        # v1 was already on the wire; of v2/v3 only the latest travels
        self.assertEqual([m.payload for m in messages(ev_b, 3)], [b"v3"])


class PriorityTests(unittest.TestCase):
    def test_control_message_overtakes_bulk_backlog(self):
        a = AeroLink(LinkConfig(rate_bytes_per_s=2000, burst_bytes=1000))
        b = AeroLink()
        data = os.urandom(60_000)
        a.start_transfer(1, data)
        now = 0.0
        received = 0
        control_seen_at = None
        completed = None
        for i in range(200):
            now += 1.0
            if i == 2:
                a.send(0, b"EMERGENCY STOP", priority=CONTROL)
            for ev in b.receive(a.pump(now)):
                if isinstance(ev, MessageReceived):
                    control_seen_at = received
                elif isinstance(ev, TransferProgress):
                    received = ev.received
                elif isinstance(ev, TransferCompleted):
                    completed = ev
            a.receive(b.pump(now))
            if completed and control_seen_at is not None:
                break
        self.assertIsNotNone(control_seen_at, "control message never arrived")
        self.assertLess(control_seen_at, len(data) // 2,
                        "control message should not wait behind the bulk transfer")
        self.assertIsNotNone(completed)
        self.assertEqual(completed.data, data)


class TransferResumeTests(unittest.TestCase):
    def test_transfer_resumes_after_disconnect_without_resending(self):
        a = AeroLink(LinkConfig(rate_bytes_per_s=4000, burst_bytes=2000))
        b = AeroLink()
        data = os.urandom(50_000)
        a.start_transfer(7, data, meta=b"blob.bin")
        now = 0.0
        received = 0
        while received < 20_000:
            now += 1.0
            for ev in b.receive(a.pump(now)):
                if isinstance(ev, TransferProgress):
                    received = ev.received
            a.receive(b.pump(now))
        # The link drops: whatever was in flight is gone.
        a.on_reconnect(now)
        b.on_reconnect(now)
        wire_before_resume = a.stats.wire_bytes_out
        completed = None
        started_again = 0
        for _ in range(200):
            now += 1.0
            for ev in b.receive(a.pump(now)):
                if isinstance(ev, TransferCompleted):
                    completed = ev
                elif isinstance(ev, TransferStarted):
                    started_again += 1
            a.receive(b.pump(now))
            if completed:
                break
        self.assertIsNotNone(completed, "transfer never completed after resume")
        self.assertEqual(completed.data, data)
        self.assertEqual(completed.meta, b"blob.bin")
        self.assertEqual(started_again, 0, "resume must not re-announce the transfer")
        resent = a.stats.wire_bytes_out - wire_before_resume
        self.assertLess(resent, (len(data) - received) + 8000,
                        "resume resent far more than the missing remainder")
        self.assertGreater(resent, len(data) - received - 8000)

    def test_reconnect_after_completion_does_not_resend(self):
        a, b = AeroLink(), AeroLink()
        data = os.urandom(10_000)
        a.start_transfer(1, data)
        _, ev_b, now = drain(a, b)
        self.assertTrue(any(isinstance(e, TransferCompleted) for e in ev_b))
        a.on_reconnect(now)
        b.on_reconnect(now)
        wire_before = a.stats.wire_bytes_out
        ev_a2, ev_b2, _ = drain(a, b, start=now)
        self.assertFalse(any(isinstance(e, (TransferStarted, TransferCompleted))
                             for e in ev_b2))
        self.assertLess(a.stats.wire_bytes_out - wire_before, 200)

    def test_zero_length_transfer(self):
        a, b = AeroLink(), AeroLink()
        a.start_transfer(4, b"", meta=b"empty")
        _, ev_b, _ = drain(a, b)
        done = [e for e in ev_b if isinstance(e, TransferCompleted)]
        self.assertEqual(len(done), 1)
        self.assertEqual(done[0].data, b"")
        self.assertEqual(done[0].meta, b"empty")


class SessionAfterReconnectTests(unittest.TestCase):
    def test_messaging_still_lossless_after_reconnect(self):
        a, b = AeroLink(), AeroLink()
        a.send(1, b"before drop " * 20)
        _, ev1, now = drain(a, b)
        a.on_reconnect(now)
        b.on_reconnect(now)
        payloads = [f"after drop {i}".encode() * 5 for i in range(20)]
        for p in payloads:
            a.send(1, p)
        _, ev2, _ = drain(a, b, start=now)
        self.assertEqual([m.payload for m in messages(ev2, 1)], payloads)


class ProtocolSafetyTests(unittest.TestCase):
    def test_reference_to_unknown_key_fails_loudly(self):
        b = AeroLink()
        batch = encode_message(RefMsg(1, 1, bytes(16)))
        with self.assertRaises(ProtocolError):
            b.receive(encode_frame(CODEC_RAW, False, batch))

    def test_delta_against_unknown_base_fails_loudly(self):
        b = AeroLink()
        batch = encode_message(DeltaMsg(1, 2, 1, bytes(8), b""))
        with self.assertRaises(ProtocolError):
            b.receive(encode_frame(CODEC_RAW, False, batch))

    def test_input_validation(self):
        a = AeroLink()
        with self.assertRaises(ValueError):
            a.send(-1, b"x")
        with self.assertRaises(ValueError):
            a.send(1, b"x", priority=9)
        a.start_transfer(1, b"data")
        with self.assertRaises(ValueError):
            a.start_transfer(1, b"other")


if __name__ == "__main__":
    unittest.main()
