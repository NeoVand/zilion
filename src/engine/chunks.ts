// Chunk planning against device limits (pure; unit-tested without a GPU).
//
// A dispatch covers at most maxComputeWorkgroupsPerDimension × workgroupSize lanes (65,535 × 64 = 4,194,240 by
// default: 0.2's run() failed above that), and every storage binding at most maxStorageBufferBindingSize bytes
// (128 MiB by default: 524,288 lanes of 256 bytes) and maxBufferSize, and the staging buffer that reads a chunk
// back (memory and records together) at most maxBufferSize. A chunk is the largest lane count that respects all; batches larger than a chunk are processed as several chunks with an advancing lane base.

export interface ChunkLimits {
  readonly maxStorageBufferBindingSize: number;
  readonly maxBufferSize: number;
  readonly maxComputeWorkgroupsPerDimension: number;
}

export const DEFAULT_LIMITS: ChunkLimits = {
  maxStorageBufferBindingSize: 134217728,
  maxBufferSize: 268435456,
  maxComputeWorkgroupsPerDimension: 65535,
};

export interface ChunkPlanOptions {
  readonly workgroupSize: number;
  /** Bytes per lane of each per-lane storage binding. */
  readonly bytesPerLane: readonly number[];
  /** Bytes per lane of the staging buffer a read of one chunk needs (memory + record); bounded by maxBufferSize. */
  readonly stagingBytesPerLane?: number;
  readonly limits: ChunkLimits;
  /** Host shaders that run several lanes per invocation. */
  readonly lanesPerInvocation?: number;
  /** An extra cap (tests, memory budgets). */
  readonly maxLanes?: number;
}

/** The largest number of lanes one dispatch can cover (a multiple of the workgroup size when ≥ one workgroup). */
export function maxLanesPerChunk(o: ChunkPlanOptions): number {
  const lpi = o.lanesPerInvocation ?? 1;
  const perGroup = o.workgroupSize * lpi;
  let n = o.limits.maxComputeWorkgroupsPerDimension * perGroup;
  const binding = Math.min(o.limits.maxStorageBufferBindingSize, o.limits.maxBufferSize);
  for (const b of o.bytesPerLane) if (b > 0) n = Math.min(n, Math.floor(binding / b));
  if (o.stagingBytesPerLane) n = Math.min(n, Math.floor(o.limits.maxBufferSize / o.stagingBytesPerLane));
  if (o.maxLanes !== undefined) n = Math.min(n, Math.floor(o.maxLanes));
  if (n >= perGroup) n -= n % perGroup;
  if (!(n >= 1)) throw new Error(`zilion: one lane does not fit the device limits (bytes per lane: ${o.bytesPerLane.join(", ")})`);
  return n;
}

/** Split `lanes` into consecutive chunks of at most `perChunk` lanes. */
export function planChunks(lanes: number, perChunk: number): { start: number; count: number }[] {
  if (!Number.isInteger(lanes) || lanes < 0) throw new Error(`lanes must be a non-negative integer (got ${lanes})`);
  const out: { start: number; count: number }[] = [];
  for (let s = 0; s < lanes; s += perChunk) out.push({ start: s, count: Math.min(perChunk, lanes - s) });
  return out;
}
