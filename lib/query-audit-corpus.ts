export const AUDIT_MUST_FLAG: Record<number, string[]> = {
  7881: ["D1"],
  7772: ["D2"], 7773: ["D2"],
  7845: ["D3"], 2305: ["D3"],
  7780: ["D6"],
  7855: ["D7"], 7900: ["D7"],
  1413: ["D5"], 5524: ["D5"], 7518: ["D5"], 7463: ["D5"],
  2849: ["D5"], 2822: ["D5"], 2031: ["D5"], 1939: ["D5"],
};

export const AUDIT_MUST_NOT_FLAG = [
  3736, 3234, 3133, 2872, 2591, 2535, 2534, 2533,
  1937, 1936, 1935, 1934, 7920, 7915,
];

export const AUDIT_CORPUS_IDS = [
  ...Object.keys(AUDIT_MUST_FLAG).map(Number),
  ...AUDIT_MUST_NOT_FLAG,
];
