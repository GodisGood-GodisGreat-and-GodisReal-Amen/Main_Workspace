"""Link statistics: where every saved byte came from."""

from __future__ import annotations

from dataclasses import dataclass, field

__all__ = ["LinkStats"]


@dataclass
class LinkStats:
    """Counters for one :class:`~aerolink.link.AeroLink` endpoint.

    ``logical_bytes_out`` is what the application asked to send;
    ``wire_bytes_out`` is what actually left after coalescing, dedup,
    delta encoding, batching and compression.
    """

    logical_bytes_out: int = 0
    wire_bytes_out: int = 0
    logical_bytes_in: int = 0
    wire_bytes_in: int = 0

    messages_out: int = 0
    messages_in: int = 0
    frames_out: int = 0
    frames_in: int = 0

    coalesced_messages: int = 0
    ref_hits: int = 0
    ref_bytes_saved: int = 0
    delta_messages: int = 0
    delta_bytes_saved: int = 0
    compression_bytes_saved: int = 0

    extra: dict = field(default_factory=dict)

    @property
    def wire_savings_pct(self) -> float:
        """Percent of application bytes that never had to cross the wire."""
        if self.logical_bytes_out <= 0:
            return 0.0
        return 100.0 * (1.0 - self.wire_bytes_out / self.logical_bytes_out)

    def summary(self) -> str:
        lines = [
            f"app bytes out     : {self.logical_bytes_out:,}",
            f"wire bytes out    : {self.wire_bytes_out:,} "
            f"({self.wire_savings_pct:.1f}% saved)",
            f"messages / frames : {self.messages_out:,} / {self.frames_out:,}",
            f"coalesced msgs    : {self.coalesced_messages:,}",
            f"dedup ref hits    : {self.ref_hits:,} (saved {self.ref_bytes_saved:,} B)",
            f"delta messages    : {self.delta_messages:,} (saved {self.delta_bytes_saved:,} B)",
            f"compression saved : {self.compression_bytes_saved:,} B",
        ]
        return "\n".join(lines)
