/**
 * ICOS mark for generated PNG icons (next/og). Plain boxes only: the image
 * renderer supports a CSS subset. `inset` shrinks the mark into the maskable
 * safe zone so launchers can crop to any shape.
 */
export function BrandMark({ size, inset = 0 }: { size: number; inset?: number }) {
  const ring = size * (1 - inset) * 0.62;
  const core = ring * 0.36;
  return (
    <div
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "radial-gradient(circle at 50% 40%, #1e1b4b 0%, #04060c 70%)",
      }}
    >
      <div
        style={{
          width: ring,
          height: ring,
          borderRadius: ring,
          border: `${Math.max(2, size / 40)}px solid #a78bfa`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: `0 0 ${size / 10}px #7c3aed`,
        }}
      >
        <div
          style={{
            width: core,
            height: core,
            borderRadius: core,
            background: "radial-gradient(circle at 35% 30%, #ddd6fe, #7c3aed)",
            boxShadow: `0 0 ${size / 14}px #38bdf8`,
          }}
        />
      </div>
    </div>
  );
}
