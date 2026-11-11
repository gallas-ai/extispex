export function targetPagePath(targetName: string): string {
  return `/targets/${encodeURIComponent(targetName)}`;
}
