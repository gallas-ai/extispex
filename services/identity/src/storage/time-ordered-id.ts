/**
 * A UUID version 7: a millisecond timestamp followed by random bits, so that IDs sort by creation
 * time and new rows land at the end of the primary key index.
 */
export function generateTimeOrderedId(createdAt: Date): string {
  const idBytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = createdAt.getTime();
  for (let byteIndex = 5; byteIndex >= 0; byteIndex--) {
    idBytes[byteIndex] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }
  idBytes[6] = 0x70 | (idBytes[6] & 0x0f);
  idBytes[8] = 0x80 | (idBytes[8] & 0x3f);
  const hex = Array.from(idBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${
    hex.slice(20)
  }`;
}
