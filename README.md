# Main_Workspace

## Projects

### [AeroLink](aerolink/) ✈️📡

A lossless link engine that keeps applications lightning fast on very-low-bandwidth networks (2G, satellite, congested Wi-Fi) — **without losing any quality**. Every byte delivered is byte-identical to what was sent, verified by checksums.

Measured on a simulated 16 kbps link: **15.5× less bandwidth than naive JSON** (93% of application bytes never cross the wire), interactive traffic stays snappy behind bulk transfers, and dropped connections resume where they left off instead of starting over.

```bash
cd aerolink
python3 -m unittest discover -s tests   # 57 tests
python3 demo/lowband_demo.py            # see the savings live
```

See [aerolink/README.md](aerolink/README.md) for the full tour: how it works, the API, and the guarantees.
