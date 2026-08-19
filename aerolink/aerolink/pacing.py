"""Outbound pacing: token bucket + bandwidth estimation.

On a thin link the enemy is queue bloat: if you stuff 200 KB into the socket
of a 2 KB/s link, every subsequent interactive message sits behind 100
seconds of backlog. AeroLink instead holds traffic in its own priority
queues and releases bytes at (just under) the link rate, so urgent frames
overtake bulk ones at every pump.
"""

from __future__ import annotations

__all__ = ["TokenBucket", "BandwidthEstimator"]


class TokenBucket:
    """Classic token bucket in bytes. ``rate=None`` means unlimited."""

    def __init__(self, rate_bytes_per_s: float | None = None, burst_bytes: int = 4096) -> None:
        if burst_bytes <= 0:
            raise ValueError("burst_bytes must be positive")
        self._rate = rate_bytes_per_s
        self._burst = float(burst_bytes)
        self._tokens = float(burst_bytes)
        self._last: float | None = None

    @property
    def rate_bytes_per_s(self) -> float | None:
        return self._rate

    def set_rate(self, rate_bytes_per_s: float | None) -> None:
        if rate_bytes_per_s is not None and rate_bytes_per_s <= 0:
            raise ValueError("rate must be positive or None")
        self._rate = rate_bytes_per_s

    def take(self, want: int, now: float) -> int:
        """Grant up to ``want`` bytes of budget at time ``now``."""
        if want <= 0:
            return 0
        if self._rate is None:
            return want
        if self._last is None:
            self._last = now
        elapsed = max(0.0, now - self._last)
        self._last = now
        self._tokens = min(self._burst, self._tokens + elapsed * self._rate)
        grant = min(want, int(self._tokens))
        self._tokens -= grant
        return grant


class BandwidthEstimator:
    """EWMA of observed throughput, for feeding :meth:`TokenBucket.set_rate`.

    Feed it ``observe(delivered_bytes, elapsed_seconds)`` samples from
    whatever ground truth the integration has (socket drain, peer progress
    reports) and pace at ``suggested_rate()`` — slightly under the estimate,
    so queues drain toward AeroLink where priorities still apply.
    """

    def __init__(self, alpha: float = 0.3, initial_bytes_per_s: float | None = None) -> None:
        if not 0.0 < alpha <= 1.0:
            raise ValueError("alpha must be in (0, 1]")
        self._alpha = alpha
        self._estimate = initial_bytes_per_s

    @property
    def bytes_per_s(self) -> float | None:
        return self._estimate

    def observe(self, nbytes: int, elapsed: float) -> None:
        if nbytes <= 0 or elapsed <= 1e-6:
            return
        sample = nbytes / elapsed
        if self._estimate is None:
            self._estimate = sample
        else:
            self._estimate += self._alpha * (sample - self._estimate)

    def suggested_rate(self, safety: float = 0.9) -> float | None:
        if self._estimate is None:
            return None
        return max(1.0, self._estimate * safety)
