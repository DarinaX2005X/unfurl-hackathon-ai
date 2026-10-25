import type { PythonRepairResponse } from "@/domain/mechanic-families/v3/python";

/** Adjacent selected lines form one inclusive region; toggling inside a region splits it. */
export function toggleFaultLine(regions: PythonRepairResponse["locations"], line: number): PythonRepairResponse["locations"] {
  const selected = new Set<number>();
  for (const region of regions) for (let value = region.startLine; value <= region.endLine; value++) selected.add(value);
  if (selected.has(line)) selected.delete(line); else selected.add(line);
  const result: PythonRepairResponse["locations"] = [];
  for (const value of [...selected].sort((a, b) => a - b)) {
    const last = result.at(-1);
    if (last?.endLine === value - 1) last.endLine = value;
    else result.push({ startLine: value, endLine: value });
  }
  return result;
}
