import { AppFailure } from './errors';

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new AppFailure('cold_vector_dimension');
  let value = 0;
  for (let i = 0; i < a.length; i++) value += a[i] * b[i];
  return value;
}
export function normalized(values: ArrayLike<number>): Float32Array {
  const norm = Math.sqrt(dot(values, values));
  if (!Number.isFinite(norm) || norm < 1e-12) throw new AppFailure('cold_vector_norm');
  return Float32Array.from(values, n => n / norm);
}
export function encodeVector(values: ArrayLike<number>, sum = false): Buffer {
  const bytes = Buffer.alloc(values.length * (sum ? 8 : 4));
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) throw new AppFailure('cold_vector_finite');
    if (sum) bytes.writeDoubleLE(values[i], i * 8); else bytes.writeFloatLE(values[i], i * 4);
  }
  return bytes;
}
export function decodeVector(value: Uint8Array, dimensions: number, sum = false): Float64Array {
  const bytes = Buffer.from(value);
  if (bytes.length !== dimensions * (sum ? 8 : 4)) throw new AppFailure('cold_vector_dimension');
  const vector = new Float64Array(dimensions);
  for (let i = 0; i < dimensions; i++) {
    vector[i] = sum ? bytes.readDoubleLE(i * 8) : bytes.readFloatLE(i * 4);
    if (!Number.isFinite(vector[i])) throw new AppFailure('cold_vector_finite');
  }
  if (!sum && Math.abs(Math.sqrt(dot(vector, vector)) - 1) > 1e-3) throw new AppFailure('cold_vector_norm');
  return vector;
}

export interface ClusterPolicy { version: 'centroid_anchor_v1'; centroid: number; anchor: number }
export const clusterPolicy: ClusterPolicy = { version: 'centroid_anchor_v1', centroid: 0.75, anchor: 0.65 };
export function validateClusterPolicy(policy: ClusterPolicy) {
  if (policy.version !== 'centroid_anchor_v1' || !Number.isFinite(policy.centroid) || !Number.isFinite(policy.anchor)
    || policy.centroid < 0 || policy.centroid > 1 || policy.anchor < 0 || policy.anchor > policy.centroid) {
    throw new AppFailure('cold_cluster_policy');
  }
}
