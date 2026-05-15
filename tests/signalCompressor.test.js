/**
 * Tests for signalCompressor module.
 *
 * Validates delta encoding, RLE, binary serialization, and the
 * high-level compress/decompress pipeline for ECG signal data.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  deltaEncode,
  deltaDecode,
  rleEncode,
  rleDecode,
  serializeRLE,
  deserializeRLE,
  compress,
  decompress,
} = require('../src/services/signalCompressor');

// ─── Delta Encoding ──────────────────────────────────────────────────────────

describe('deltaEncode', () => {
  it('should encode simple ascending sequence', () => {
    const { first, deltas } = deltaEncode([100, 103, 107, 110]);
    assert.equal(first, 100);
    assert.deepEqual(deltas, [3, 4, 3]);
  });

  it('should handle empty array', () => {
    const { first, deltas } = deltaEncode([]);
    assert.equal(first, 0);
    assert.deepEqual(deltas, []);
  });

  it('should handle single sample', () => {
    const { first, deltas } = deltaEncode([42]);
    assert.equal(first, 42);
    assert.deepEqual(deltas, []);
  });

  it('should handle negative values (24-bit ADC range)', () => {
    const { first, deltas } = deltaEncode([-8388608, -8388600, -8388590]);
    assert.equal(first, -8388608);
    assert.deepEqual(deltas, [8, 10]);
  });

  it('should handle constant signal (all same value)', () => {
    const { first, deltas } = deltaEncode([500, 500, 500, 500]);
    assert.equal(first, 500);
    assert.deepEqual(deltas, [0, 0, 0]);
  });
});

describe('deltaDecode', () => {
  it('should reconstruct original from deltas', () => {
    const result = deltaDecode(100, [3, 4, 3]);
    assert.deepEqual(result, [100, 103, 107, 110]);
  });

  it('should handle empty deltas', () => {
    const result = deltaDecode(42, []);
    assert.deepEqual(result, [42]);
  });

  it('should roundtrip with deltaEncode', () => {
    const original = [1000, 1005, 1003, 998, 1002, 1010];
    const { first, deltas } = deltaEncode(original);
    const result = deltaDecode(first, deltas);
    assert.deepEqual(result, original);
  });
});

// ─── Run-Length Encoding ─────────────────────────────────────────────────────

describe('rleEncode', () => {
  it('should collapse runs of identical values', () => {
    const runs = rleEncode([0, 0, 0, 5, 5, 3]);
    assert.deepEqual(runs, [
      { value: 0, count: 3 },
      { value: 5, count: 2 },
      { value: 3, count: 1 },
    ]);
  });

  it('should handle empty array', () => {
    assert.deepEqual(rleEncode([]), []);
  });

  it('should handle all unique values', () => {
    const runs = rleEncode([1, 2, 3]);
    assert.deepEqual(runs, [
      { value: 1, count: 1 },
      { value: 2, count: 1 },
      { value: 3, count: 1 },
    ]);
  });

  it('should handle single long run', () => {
    const arr = new Array(100).fill(7);
    const runs = rleEncode(arr);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].value, 7);
    assert.equal(runs[0].count, 100);
  });
});

describe('rleDecode', () => {
  it('should expand RLE pairs', () => {
    const result = rleDecode([
      { value: 0, count: 3 },
      { value: 5, count: 2 },
      { value: 3, count: 1 },
    ]);
    assert.deepEqual(result, [0, 0, 0, 5, 5, 3]);
  });

  it('should roundtrip with rleEncode', () => {
    const original = [1, 1, 2, 2, 2, 3, 3, 3, 3];
    const result = rleDecode(rleEncode(original));
    assert.deepEqual(result, original);
  });
});

// ─── Binary Serialization ────────────────────────────────────────────────────

describe('serializeRLE / deserializeRLE', () => {
  it('should roundtrip RLE pairs through binary', () => {
    const runs = [
      { value: -100, count: 5 },
      { value: 0, count: 65535 },
      { value: 8388607, count: 1 },
    ];
    const buf = serializeRLE(runs);
    const result = deserializeRLE(buf);
    assert.deepEqual(result, runs);
  });

  it('should handle empty runs', () => {
    const buf = serializeRLE([]);
    assert.equal(buf.length, 4); // just the header
    const result = deserializeRLE(buf);
    assert.deepEqual(result, []);
  });

  it('should produce compact buffer', () => {
    const runs = [{ value: 42, count: 1 }];
    const buf = serializeRLE(runs);
    // 4 (header) + 6 (one pair) = 10 bytes
    assert.equal(buf.length, 10);
  });
});

// ─── High-Level Compress/Decompress ──────────────────────────────────────────

describe('compress / decompress', () => {
  it('should roundtrip realistic ECG data', () => {
    // Simulate a quasi-periodic ECG signal (small deltas with occasional spikes)
    const samples = [];
    let val = 0;
    for (let i = 0; i < 500; i++) {
      val += Math.floor(Math.random() * 20) - 10; // small random walk
      samples.push(val);
    }

    const { buffer, meta } = compress(samples);
    assert.equal(meta.algorithm, 'delta-rle');
    assert.ok(meta.compressedBytes > 0);
    assert.equal(meta.firstSample, samples[0]);

    const result = decompress(buffer, meta.firstSample);
    assert.deepEqual(result, samples);
  });

  it('should achieve good compression for constant signal', () => {
    const samples = new Array(1000).fill(12345);
    const { buffer, meta } = compress(samples);

    // Constant signal → 1 delta (0) repeated 999 times = 1 RLE pair
    // Should be extremely compact: 4 (header) + 6 (one pair) = 10 bytes
    // vs original: 1000 * 4 = 4000 bytes
    assert.equal(buffer.length, 10);
    assert.ok(meta.originalBytes / meta.compressedBytes > 10);

    const result = decompress(buffer, meta.firstSample);
    assert.deepEqual(result, samples);
  });

  it('should handle empty samples', () => {
    const { buffer, meta } = compress([]);
    assert.equal(buffer.length, 0);
    assert.deepEqual(decompress(buffer, 0), []);
  });

  it('should handle single sample', () => {
    const { buffer, meta } = compress([42]);
    assert.equal(meta.firstSample, 42);
    const result = decompress(buffer, meta.firstSample);
    assert.deepEqual(result, [42]);
  });

  it('should handle negative ADC values', () => {
    const samples = [-8388608, -8388600, -8388590, -8388608];
    const { buffer, meta } = compress(samples);
    const result = decompress(buffer, meta.firstSample);
    assert.deepEqual(result, samples);
  });

  it('should handle full ADC range', () => {
    const samples = [-8388608, 0, 8388607, -8388608, 8388607];
    const { buffer, meta } = compress(samples);
    const result = decompress(buffer, meta.firstSample);
    assert.deepEqual(result, samples);
  });
});
