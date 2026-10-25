"""Initial-observation-only projected domains, compatible with core Grid.

Masks use row0south/column0west; positive affine y. Projected localUTM meters
are used for rasterization, distances and areas; geographic resident lookup
uses exact PyProj transforms rather than a latitude approximation.
"""

from dataclasses import dataclass
from functools import lru_cache
import math

from affine import Affine
from pyproj import Transformer
from rasterio.features import rasterize
from shapely.ops import transform

from ..core.geo import Grid


@lru_cache(maxsize=128)
def transformer(source, destination):
    return Transformer.from_crs(source, destination, always_xy=True)


@dataclass(frozen=True)
class ProjectedGrid(Grid):
    crs: str
    x_min: float
    y_min: float

    def center(self, cell_id):
        r, c = self.rc(cell_id)
        lon, lat = transformer(self.crs, "EPSG:4326").transform(
            self.x_min + (c + 0.5) * self.cell_size_m, self.y_min + (r + 0.5) * self.cell_size_m
        )
        return lat, lon

    def locate_rc(self, lat, lon):
        x, y = transformer("EPSG:4326", self.crs).transform(lon, lat)
        r, c = (
            math.floor((y - self.y_min) / self.cell_size_m),
            math.floor((x - self.x_min) / self.cell_size_m),
        )
        return (r, c) if 0 <= r < self.rows and 0 <= c < self.cols else None

    @property
    def affine(self):
        return Affine(self.cell_size_m, 0, self.x_min, 0, self.cell_size_m, self.y_min)


def grid_from_record(value):
    return ProjectedGrid(
        **{
            k: value[k]
            for k in ("origin_lat", "origin_lon", "cell_size_m", "rows", "cols", "crs", "x_min", "y_min")
        }
    )


def initial_domain(geometry, size=128):
    """Square128 grid: marginclip(.5*initialextent,2km,10km), mppceil10m.

    No later observation contributes to this domain or to raster resolution.
    """
    lon, lat = geometry.representative_point().coords[0]
    zone = max(1, min(60, int((lon + 180) // 6) + 1))
    crs = f"EPSG:{32600 + zone if lat >= 0 else 32700 + zone}"
    projected = transform(transformer("EPSG:4326", crs).transform, geometry)
    xmin, ymin, xmax, ymax = projected.bounds
    extent = max(xmax - xmin, ymax - ymin, 1)
    margin = max(2000, min(10000, 0.5 * extent))
    cell = max(10, math.ceil((extent + 2 * margin) / size / 10) * 10)
    cx, cy = (xmin + xmax) / 2, (ymin + ymax) / 2
    left, bottom = cx - size * cell / 2, cy - size * cell / 2
    origin_lon, origin_lat = transformer(crs, "EPSG:4326").transform(left, bottom)
    return ProjectedGrid(origin_lat, origin_lon, cell, size, size, crs, left, bottom)


def raster_geometry(geometry, grid):
    projected = transform(transformer("EPSG:4326", grid.crs).transform, geometry)
    mask = rasterize(
        [(projected, 1)],
        out_shape=(grid.rows, grid.cols),
        transform=grid.affine,
        fill=0,
        all_touched=True,
        dtype="uint8",
    ).astype(bool)
    from shapely.geometry import box

    domain = box(
        grid.x_min,
        grid.y_min,
        grid.x_min + grid.cols * grid.cell_size_m,
        grid.y_min + grid.rows * grid.cell_size_m,
    )
    area = projected.area
    # GEOS area roundoff can exceed1 by1e-14 for geometries wholly inside.
    coverage = max(0.0, min(1.0, projected.intersection(domain).area / area)) if area > 0 else 0.0
    return mask, float(coverage), float(area)
