"""GEO hot-topic radar — Python port of the DSH plugin.

The package is usable two ways:

    from geo_radar import scan, topics, alerts
    geo-radar scan --label daily

Both halves share one data directory with the JavaScript implementation
(``~/.dsh/geo-trend-radar`` by default), and every file written here keeps the
same JSON shape, so the two can run alternately over the same snapshots.
"""

from __future__ import annotations

__version__ = "1.0.0"

__all__ = ["__version__"]
