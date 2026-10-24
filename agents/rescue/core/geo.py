"""Grid geometry: cell ids <-> lat/lon, distances."""
from __future__ import annotations

import math
from dataclasses import dataclass

M_PER_DEG_LAT = 111_320.0


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


@dataclass(frozen=True)
class Grid:
    """Row 0 is the SOUTH edge, col 0 the WEST edge. cell_id = row*cols+col.
    Mirrors the `grid` singleton table in SpacetimeDB."""

    origin_lat: float
    origin_lon: float
    cell_size_m: float
    rows: int
    cols: int

    @classmethod
    def from_row(cls, row: dict) -> "Grid":
        return cls(row["origin_lat"], row["origin_lon"], row["cell_size_m"], row["rows"], row["cols"])

    @property
    def valid(self) -> bool:
        return self.rows > 0 and self.cols > 0 and self.cell_size_m > 0

    @property
    def size(self) -> int:
        return self.rows * self.cols

    @property
    def m_per_deg_lon(self) -> float:
        return M_PER_DEG_LAT * math.cos(math.radians(self.origin_lat))

    def cell_id(self, row: int, col: int) -> int:
        return row * self.cols + col

    def rc(self, cell_id: int) -> tuple[int, int]:
        return divmod(cell_id, self.cols)

    def center(self, cell_id: int) -> tuple[float, float]:
        r, c = self.rc(cell_id)
        lat = self.origin_lat + (r + 0.5) * self.cell_size_m / M_PER_DEG_LAT
        lon = self.origin_lon + (c + 0.5) * self.cell_size_m / self.m_per_deg_lon
        return lat, lon

    def locate_rc(self, lat: float, lon: float) -> tuple[int, int] | None:
        r = int((lat - self.origin_lat) * M_PER_DEG_LAT // self.cell_size_m)
        c = int((lon - self.origin_lon) * self.m_per_deg_lon // self.cell_size_m)
        if 0 <= r < self.rows and 0 <= c < self.cols:
            return r, c
        return None

    def locate(self, lat: float, lon: float) -> int | None:
        rc = self.locate_rc(lat, lon)
        return None if rc is None else self.cell_id(*rc)

    def bbox(self) -> tuple[float, float, float, float]:
        """(west, south, east, north) in degrees."""
        north = self.origin_lat + self.rows * self.cell_size_m / M_PER_DEG_LAT
        east = self.origin_lon + self.cols * self.cell_size_m / self.m_per_deg_lon
        return self.origin_lon, self.origin_lat, east, north

    def segment_cells(self, lat1: float, lon1: float, lat2: float, lon2: float) -> set[int]:
        """Cells a straight segment passes through (for road closures)."""
        a, b = self.locate_rc(lat1, lon1), self.locate_rc(lat2, lon2)
        if a is None and b is None:
            return set()
        a = a or b
        b = b or a
        steps = max(abs(b[0] - a[0]), abs(b[1] - a[1]), 1) * 2
        out = set()
        for i in range(steps + 1):
            r = round(a[0] + (b[0] - a[0]) * i / steps)
            c = round(a[1] + (b[1] - a[1]) * i / steps)
            out.add(self.cell_id(r, c))
        return out


def compass(deg: float) -> str:
    return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][round(deg / 45) % 8]
