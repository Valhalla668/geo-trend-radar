"""Numeric helpers that reproduce JavaScript's rounding.

``Math.round`` rounds halves toward +∞; Python's built-in :func:`round` rounds
halves to even. Every score, share and ratio in this package goes through these
helpers so the Python and JavaScript implementations agree digit for digit.
"""

from __future__ import annotations

import math


def js_round(value: float) -> int:
    """``Math.round`` for the non-negative values used here."""
    return math.floor(value + 0.5)


def _tidy(value: float) -> float | int:
    """Return an int for integral values, the way JavaScript prints 50 not 50.0."""
    return int(value) if float(value).is_integer() else value


def round_1k(value: float) -> float | int:
    """``Math.round(value * 1000) / 10`` — one decimal place."""
    return _tidy(js_round(value * 1000) / 10)


def round_2(value: float) -> float | int:
    """``Math.round(value * 100) / 100`` — two decimal places."""
    return _tidy(js_round(value * 100) / 100)


def round_3(value: float) -> float | int:
    """``Math.round(value * 1000) / 1000`` — three decimal places."""
    return _tidy(js_round(value * 1000) / 1000)
