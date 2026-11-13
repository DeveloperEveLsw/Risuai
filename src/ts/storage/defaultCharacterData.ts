const defaultSdData: [string, string][] = [
  ["always", "solo, 1girl"],
  ["negative", ""],
  ["|character\'s appearance", ""],
  ["current situation", ""],
  ["$character's pose", ""],
  ["$character's emotion", ""],
  ["current location", ""],
];

export function getDefaultSdData(clone: <T>(value: T) => T = structuredClone) {
  return clone(defaultSdData);
}
