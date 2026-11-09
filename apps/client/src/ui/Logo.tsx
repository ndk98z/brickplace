// The brand mark (a wall of bricks in running bond) and the logotype, the same on every screen.
// The mark is /logo.svg, which the static pages use too; docs/brand holds the other exports.

export function LogoMark({ size = 28 }: { size?: number }) {
  return <img class="logo-mark" src="/logo.svg" alt="" width={size} height={size} />;
}

/** Mark and name, for a header. */
export function Logo() {
  return (
    <>
      <LogoMark />
      <span class="logo-name">BrickPlace</span>
    </>
  );
}
