"""AeroLink — a lossless link engine for very-low-bandwidth networks.

AeroLink keeps applications *lightning fast* on thin pipes (2G, satellite,
LoRa-class radios, congested Wi-Fi) by making sure every byte on the wire
earns its place — while guaranteeing the receiver reconstructs exactly the
bytes the sender gave, verified by checksums. No lossy tricks, ever.

Quick start::

    from aerolink import AeroLink, LinkConfig, CONTROL, INTERACTIVE, BULK

    a = AeroLink(LinkConfig(rate_bytes_per_s=2000))   # ~16 kbps uplink
    b = AeroLink()

    a.send(channel=1, payload=b'{"lat": 48.85, "lon": 2.35}')
    wire = a.pump(now=0.1)          # bytes for your socket/serial/websocket
    for event in b.receive(wire):   # events on the far end
        print(event)

See ``aerolink/README.md`` for the full tour.
"""

from .frames import ProtocolError
from .link import (
    BULK,
    CONTROL,
    INTERACTIVE,
    AeroLink,
    LinkConfig,
    MessageReceived,
    PeerHello,
    TransferCompleted,
    TransferProgress,
    TransferStarted,
)
from .metrics import LinkStats
from .pacing import BandwidthEstimator, TokenBucket

__version__ = "0.1.0"

__all__ = [
    "AeroLink",
    "LinkConfig",
    "LinkStats",
    "ProtocolError",
    "CONTROL",
    "INTERACTIVE",
    "BULK",
    "MessageReceived",
    "TransferStarted",
    "TransferProgress",
    "TransferCompleted",
    "PeerHello",
    "TokenBucket",
    "BandwidthEstimator",
    "__version__",
]
