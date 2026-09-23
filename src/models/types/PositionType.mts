/**
 * The one GeoJSON geometry `type` this platform ever stores: every point on the map is a `Point`, never
 * a `LineString` or a `Polygon`.
 *
 * ⚠️ **`as const`, matching `Tier.mts` and `ReuseEventAction.mts`.** Without it `typeof PositionType.Point`
 * widens to plain `string` — which is what every address interface asks it for: `IShopOwnerAddress`,
 * `ICompanyAddress` and `IUserAddress` all declare `position.type` as `typeof PositionType.Point`, so a
 * widened type would let any of them accept `type: 'point'` or `type: 'LineString'` and still compile.
 * GeoJSON itself requires the literal string `"Point"` for a Point geometry (RFC 7946); the literal type
 * is not a stricter rule this platform is inventing, it is the one the format already has.
 */
export const PositionType = {
	Point: 'Point'
} as const

export type PositionType = typeof PositionType // { readonly Point: "Point" }
