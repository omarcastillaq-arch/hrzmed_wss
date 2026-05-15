/**
 * @module signalCompressor
 * @description Compression utilities for ECG signal data.
 *
 * Implements a two-stage compression pipeline optimized for 24-bit ADC data:
 *
 *   1. **Delta Encoding**: Stores differences between consecutive samples.
 *      ECG signals are quasi-periodic, so deltas are small and cluster near zero.
 *      This reduces the effective bit-width of most values.
 *
 *   2. **Run-Length Encoding (RLE)**: Collapses consecutive identical deltas
 *      into (value, count) pairs. Common during flat-line segments or when
 *      the ADC reads the same value repeatedly.
 *
 * The compressed representation is serialized to a compact binary Buffer:
 *   - Header: 4 bytes (uint32 = number of RLE pairs)
 *   - Each pair: 4 bytes (int32 delta value) + 2 bytes (uint16 run count)
 *
 * Typical compression ratios for ECG data: 1.5x to 4x depending on signal activity.
 */

'use strict';

// ─── Delta Encoding ──────────────────────────────────────────────────────────

/**
 * Delta-encode an array of integer samples.
 * @param {number[]} samples - Raw ADC samples
 * @returns {{ first: number, deltas: number[] }} First sample + delta array
 */
function deltaEncode(samples) {
  if (!samples || samples.length === 0) {
    return { first: 0, deltas: [] };
  }
  const first = samples[0];
  const deltas = new Array(samples.length - 1);
  for (let i = 1; i < samples.length; i++) {
    deltas[i - 1] = samples[i] - samples[i - 1];
  }
  return { first, deltas };
}

/**
 * Decode delta-encoded data back to original samples.
 * @param {number} first - First sample value (anchor)
 * @param {number[]} deltas - Delta values
 * @returns {number[]} Reconstructed samples
 */
function deltaDecode(first, deltas) {
  const samples = new Array(deltas.length + 1);
  samples[0] = first;
  for (let i = 0; i < deltas.length; i++) {
    samples[i + 1] = samples[i] + deltas[i];
  }
  return samples;
}

// ─── Run-Length Encoding ─────────────────────────────────────────────────────

/**
 * Run-length encode an array of values.
 * @param {number[]} values - Array of integers (typically deltas)
 * @returns {{ value: number, count: number }[]} RLE pairs
 */
function rleEncode(values) {
  if (!values || values.length === 0) return [];

  const runs = [];
  let currentValue = values[0];
  let currentCount = 1;

  for (let i = 1; i < values.length; i++) {
    if (values[i] === currentValue && currentCount < 65535) {
      // Max count per run = 65535 (uint16)
      currentCount++;
    } else {
      runs.push({ value: currentValue, count: currentCount });
      currentValue = values[i];
      currentCount = 1;
    }
  }
  runs.push({ value: currentValue, count: currentCount });
  return runs;
}

/**
 * Decode RLE pairs back to an array.
 * @param {{ value: number, count: number }[]} runs - RLE pairs
 * @returns {number[]} Expanded values
 */
function rleDecode(runs) {
  const values = [];
  for (const run of runs) {
    for (let i = 0; i < run.count; i++) {
      values.push(run.value);
    }
  }
  return values;
}

// ─── Binary Serialization ────────────────────────────────────────────────────

/**
 * Serialize RLE pairs to a compact binary Buffer.
 * Format: [uint32 numPairs] [int32 value, uint16 count] × numPairs
 * @param {{ value: number, count: number }[]} runs
 * @returns {Buffer}
 */
function serializeRLE(runs) {
  // Header: 4 bytes for run count
  // Each pair: 4 bytes (int32) + 2 bytes (uint16) = 6 bytes
  const buf = Buffer.alloc(4 + runs.length * 6);
  buf.writeUInt32LE(runs.length, 0);
  let offset = 4;
  for (const run of runs) {
    buf.writeInt32LE(run.value, offset);
    buf.writeUInt16LE(run.count, offset + 4);
    offset += 6;
  }
  return buf;
}

/**
 * Deserialize binary Buffer back to RLE pairs.
 * @param {Buffer} buf
 * @returns {{ value: number, count: number }[]}
 */
function deserializeRLE(buf) {
  const numPairs = buf.readUInt32LE(0);
  const runs = new Array(numPairs);
  let offset = 4;
  for (let i = 0; i < numPairs; i++) {
    runs[i] = {
      value: buf.readInt32LE(offset),
      count: buf.readUInt16LE(offset + 4),
    };
    offset += 6;
  }
  return runs;
}

// ─── High-Level API ──────────────────────────────────────────────────────────

/**
 * Compress an array of ECG samples using delta + RLE encoding.
 * @param {number[]} samples - Raw ADC samples (integers)
 * @returns {{ buffer: Buffer, meta: object }} Compressed buffer and metadata
 */
function compress(samples) {
  if (!samples || samples.length === 0) {
    return {
      buffer: Buffer.alloc(0),
      meta: {
        algorithm: 'delta-rle',
        originalBytes: 0,
        compressedBytes: 0,
        firstSample: 0,
      },
    };
  }

  const originalBytes = samples.length * 4; // 32-bit per sample in JSON/memory
  const { first, deltas } = deltaEncode(samples);
  const runs = rleEncode(deltas);
  const buffer = serializeRLE(runs);

  return {
    buffer,
    meta: {
      algorithm: 'delta-rle',
      originalBytes,
      compressedBytes: buffer.length,
      firstSample: first,
    },
  };
}

/**
 * Decompress a buffer back to original ECG samples.
 * @param {Buffer} buffer - Compressed binary data
 * @param {number} firstSample - First sample value (anchor for delta decoding)
 * @returns {number[]} Reconstructed samples
 */
function decompress(buffer, firstSample) {
  if (!buffer || buffer.length === 0) {
    return [];
  }

  const runs = deserializeRLE(buffer);
  const deltas = rleDecode(runs);
  return deltaDecode(firstSample, deltas);
}

module.exports = {
  compress,
  decompress,
  // Expose internals for testing
  deltaEncode,
  deltaDecode,
  rleEncode,
  rleDecode,
  serializeRLE,
  deserializeRLE,
};
