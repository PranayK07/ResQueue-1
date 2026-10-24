"""Decode SpacetimeDB SATS-JSON values into plain Python.

Rows arrive either positional (`[1, "x", [0, 2.5]]`) or named
(`{"id": 1, ...}`); both are turned into dicts keyed by snake_case column
name. Special products are flattened:

    Identity      -> "0xabc..." (hex str)
    Timestamp     -> int micros since epoch
    TimeDuration  -> int micros
    Option<T>     -> T | None
"""
from __future__ import annotations

from typing import Any

Type = dict[str, Any]

_SPECIAL = {
    "__identity__": "identity",
    "__connection_id__": "connection_id",
    "__timestamp_micros_since_unix_epoch__": "timestamp",
    "__time_duration_micros__": "duration",
}


def _name(el: dict) -> str | None:
    n = el.get("name")
    if isinstance(n, dict):
        return n.get("some")
    return n


def decode(ty: Type, v: Any) -> Any:
    (kind, inner), = ty.items()
    if kind == "Product":
        elements = inner["elements"]
        if len(elements) == 1 and _name(elements[0]) in _SPECIAL:
            if isinstance(v, dict):
                v = next(iter(v.values()))
            elif isinstance(v, list):
                v = v[0]
            return v
        return decode_product(elements, v)
    if kind == "Sum":
        variants = inner["variants"]
        if isinstance(v, dict):
            (vname, payload), = v.items()
            idx = next(i for i, var in enumerate(variants) if _name(var) == vname)
        else:
            idx, payload = v
        names = [_name(var) for var in variants]
        if names == ["some", "none"]:
            return decode(variants[0]["algebraic_type"], payload) if idx == 0 else None
        var = variants[idx]
        if var["algebraic_type"] == {"Product": {"elements": []}}:
            return names[idx]
        return {names[idx]: decode(var["algebraic_type"], payload)}
    if kind == "Array":
        return [decode(inner, x) for x in v]
    return v  # primitives (ints, floats, strings, bools)


def decode_product(elements: list[dict], v: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if isinstance(v, dict):
        for el in elements:
            name = _name(el)
            if name in v:
                out[name] = decode(el["algebraic_type"], v[name])
    else:
        for el, x in zip(elements, v):
            out[_name(el)] = decode(el["algebraic_type"], x)
    return out


def option(value: Any) -> Any:
    """Encode a Python value as a SATS-JSON Option for reducer args."""
    return {"none": []} if value is None else {"some": value}
