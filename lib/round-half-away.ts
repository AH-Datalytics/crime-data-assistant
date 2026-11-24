/**
 * One decimal, a tie rounds away from zero for both signs (Jeff 2026-11-24): -6.25 shows -6.3 and 6.25 shows 6.3.
 * Math.round alone rounds -62.5 toward +infinity (-62), so a drop landing exactly on a half showed one tenth too small.
 */
export const roundHalfAway1 = (x: number): number => {
  const r = Math.floor(Math.abs(x) * 10 + 0.5 + 1e-9) / 10;
  return x < 0 && r !== 0 ? -r : r;
};
