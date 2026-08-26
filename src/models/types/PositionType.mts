export const PositionType = {
	Point: 'Point'
}

export type PositionType = typeof PositionType // { Point: "Point" }

/*
const PositionType = { Point: "Point" };
type PositionType = typeof PositionType; // { readonly Point: "Point" }  <---

// Now you can use PositionType as a type:
function foo(p: PositionType) { ... } // accepts the whole object shape <---
*/
