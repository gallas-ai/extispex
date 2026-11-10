import { useMemo, useRef } from "react";

/**
 * Gives each series label a color slot that it keeps while the chart shows it, so that a filter
 * which removes other series never repaints the ones that stay. A new label takes the first slot
 * that no shown series holds. `resetKey` starts afresh, for example for another metric.
 */
export function assignColorSlots(
  labels: string[],
  previousSlots: Map<string, number>,
  slotCount: number,
): Map<string, number> {
  const assignedSlots = new Map<string, number>();
  for (const label of labels) {
    const previousSlot = previousSlots.get(label);
    if (previousSlot !== undefined) assignedSlots.set(label, previousSlot);
  }
  const takenSlots = new Set(assignedSlots.values());
  for (const label of labels) {
    if (assignedSlots.has(label)) continue;
    let freeSlot = 0;
    while (takenSlots.has(freeSlot) && freeSlot < slotCount) freeSlot++;
    assignedSlots.set(label, freeSlot);
    takenSlots.add(freeSlot);
  }
  return assignedSlots;
}

export function useStableColorSlots(
  labels: string[],
  resetKey: string,
  slotCount: number,
): Map<string, number> {
  const memoryRef = useRef<{ resetKey: string; slots: Map<string, number> }>({
    resetKey,
    slots: new Map(),
  });
  const labelsKey = JSON.stringify(labels);
  return useMemo(() => {
    const memory = memoryRef.current;
    const previousSlots = memory.resetKey === resetKey ? memory.slots : new Map<string, number>();
    const slots = assignColorSlots(JSON.parse(labelsKey) as string[], previousSlots, slotCount);
    memoryRef.current = { resetKey, slots: new Map([...previousSlots, ...slots]) };
    return slots;
  }, [labelsKey, resetKey, slotCount]);
}
