/**
 * @module edfExporter
 * @description Exports ECG signal data in European Data Format (EDF/EDF+).
 *
 * EDF is the standard format for exchanging polysomnographic and ECG recordings.
 * Reference: https://www.edfplus.info/specs/edf.html
 *
 * This implements the EDF specification:
 *   - 256-byte header record
 *   - ns × 256-byte signal headers
 *   - Data records with 16-bit integer samples
 */

'use strict';

const logger = require('../utils/logger');

// ─── EDF Constants ───────────────────────────────────────────────────────────

const HEADER_BYTES = 256;
const SIGNAL_HEADER_BYTES = 256;

const CHANNEL_LABELS = {
  '8171': 'EEG Lead_I',
  '8172': 'EEG Lead_II',
  '8173': 'EEG Lead_III',
  '8174': 'EEG aVR',
  '8175': 'EEG aVL',
  '8176': 'EEG aVF',
  '8177': 'EEG V1',
  '8178': 'EEG V2',
};

// ─── Helper: Pad/Truncate string to exact length ─────────────────────────────

function edfString(str, length) {
  const s = (str || '').toString();
  if (s.length >= length) return s.substring(0, length);
  return s + ' '.repeat(length - s.length);
}

// ─── Helper: Format date for EDF header ──────────────────────────────────────

function edfDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear() % 100).padStart(2, '0');
  return `${dd}.${mm}.${yy}`;
}

function edfTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}.${mm}.${ss}`;
}

// ─── Main Export Function ────────────────────────────────────────────────────

/**
 * Export ECG signals to EDF format.
 *
 * @param {Object} options
 * @param {Object} options.patient        - Patient document
 * @param {Object} options.session        - ECGSession document
 * @param {Array}  options.signals        - Array of ECGSignal documents
 * @param {number} [options.sampleRate]   - Sample rate in Hz (default 250)
 * @param {number} [options.recordDuration] - Duration of each data record in seconds (default 1)
 * @returns {Buffer} EDF file as a Buffer
 */
function exportToEDF({ patient, session, signals, sampleRate = 250, recordDuration = 1 }) {
  // Group signals by channel
  const channelMap = {};
  for (const sig of signals) {
    const ch = sig.channelId || 'unknown';
    if (!channelMap[ch]) channelMap[ch] = [];
    channelMap[ch].push(...(sig.samples || []));
  }

  const channelIds = Object.keys(channelMap).sort();
  const ns = channelIds.length; // number of signals

  if (ns === 0) {
    throw new Error('No signal data available for EDF export');
  }

  // Normalize all channels to same length
  const maxLen = Math.max(...channelIds.map(ch => channelMap[ch].length));
  for (const ch of channelIds) {
    while (channelMap[ch].length < maxLen) {
      channelMap[ch].push(0);
    }
  }

  const samplesPerRecord = sampleRate * recordDuration;
  const numRecords = Math.ceil(maxLen / samplesPerRecord);

  // Pad all channels to fill complete records
  const totalSamples = numRecords * samplesPerRecord;
  for (const ch of channelIds) {
    while (channelMap[ch].length < totalSamples) {
      channelMap[ch].push(0);
    }
  }

  // Find physical min/max per channel (for 24-bit ADC data)
  const physMins = {};
  const physMaxs = {};
  for (const ch of channelIds) {
    const samples = channelMap[ch];
    physMins[ch] = Math.min(...samples);
    physMaxs[ch] = Math.max(...samples);
    // Ensure range is not zero
    if (physMins[ch] === physMaxs[ch]) {
      physMins[ch] -= 1;
      physMaxs[ch] += 1;
    }
  }

  // Digital range: 16-bit signed integers
  const digMin = -32768;
  const digMax = 32767;

  // ─── Build Header ─────────────────────────────────────────────────

  const startDate = session?.startedAt ? new Date(session.startedAt) : new Date();
  const patientName = patient
    ? `${patient.lastName || 'X'} ${patient.firstName || 'X'}`.trim()
    : 'X X';
  const patientId = patient?.patientId || 'X';

  let header = '';
  // Version (8 bytes)
  header += edfString('0', 8);
  // Patient ID (80 bytes): code sex DOB name
  const patientInfo = `${patientId} ${patient?.gender === 'male' ? 'M' : patient?.gender === 'female' ? 'F' : 'X'} ${patient?.dateOfBirth ? edfDate(patient.dateOfBirth) : 'X'} ${patientName}`;
  header += edfString(patientInfo, 80);
  // Recording ID (80 bytes)
  const recordingId = `Startdate ${edfDate(startDate)} X X Horizon_Medical_ECG`;
  header += edfString(recordingId, 80);
  // Start date (8 bytes)
  header += edfString(edfDate(startDate), 8);
  // Start time (8 bytes)
  header += edfString(edfTime(startDate), 8);
  // Number of bytes in header (8 bytes)
  const headerSize = HEADER_BYTES + ns * SIGNAL_HEADER_BYTES;
  header += edfString(headerSize.toString(), 8);
  // Reserved (44 bytes) — 'EDF+C' for EDF+ continuous
  header += edfString('EDF+C', 44);
  // Number of data records (8 bytes)
  header += edfString(numRecords.toString(), 8);
  // Duration of data record in seconds (8 bytes)
  header += edfString(recordDuration.toString(), 8);
  // Number of signals (4 bytes)
  header += edfString(ns.toString(), 4);

  // ─── Signal Headers (each field for all signals, then next field) ─

  // Labels (16 bytes each)
  for (const ch of channelIds) {
    header += edfString(CHANNEL_LABELS[ch] || `ECG_CH_${ch}`, 16);
  }
  // Transducer type (80 bytes each)
  for (let i = 0; i < ns; i++) {
    header += edfString('AgAgCl electrode', 80);
  }
  // Physical dimension (8 bytes each)
  for (let i = 0; i < ns; i++) {
    header += edfString('uV', 8);
  }
  // Physical minimum (8 bytes each)
  for (const ch of channelIds) {
    header += edfString(physMins[ch].toString(), 8);
  }
  // Physical maximum (8 bytes each)
  for (const ch of channelIds) {
    header += edfString(physMaxs[ch].toString(), 8);
  }
  // Digital minimum (8 bytes each)
  for (let i = 0; i < ns; i++) {
    header += edfString(digMin.toString(), 8);
  }
  // Digital maximum (8 bytes each)
  for (let i = 0; i < ns; i++) {
    header += edfString(digMax.toString(), 8);
  }
  // Prefiltering (80 bytes each)
  for (let i = 0; i < ns; i++) {
    header += edfString('HP:0.05Hz LP:150Hz', 80);
  }
  // Number of samples per data record (8 bytes each)
  for (let i = 0; i < ns; i++) {
    header += edfString(samplesPerRecord.toString(), 8);
  }
  // Reserved (32 bytes each)
  for (let i = 0; i < ns; i++) {
    header += edfString('', 32);
  }

  // ─── Build Data Records ───────────────────────────────────────────

  const dataSize = numRecords * ns * samplesPerRecord * 2; // 2 bytes per sample (Int16)
  const buffer = Buffer.alloc(headerSize + dataSize);

  // Write header (ASCII)
  buffer.write(header, 0, headerSize, 'ascii');

  // Write data records
  let offset = headerSize;
  for (let rec = 0; rec < numRecords; rec++) {
    for (const ch of channelIds) {
      const physMin = physMins[ch];
      const physMax = physMaxs[ch];
      const physRange = physMax - physMin;
      const digRange = digMax - digMin;

      for (let s = 0; s < samplesPerRecord; s++) {
        const sampleIdx = rec * samplesPerRecord + s;
        const physVal = channelMap[ch][sampleIdx];
        // Linear scaling: physical -> digital
        let digVal = Math.round(((physVal - physMin) / physRange) * digRange + digMin);
        digVal = Math.max(digMin, Math.min(digMax, digVal));
        buffer.writeInt16LE(digVal, offset);
        offset += 2;
      }
    }
  }

  logger.info('EDF export completed', {
    channels: ns,
    records: numRecords,
    totalSamples: totalSamples * ns,
    fileSize: buffer.length,
  });

  return buffer;
}

/**
 * Export ECG data in a simple HL7-inspired JSON format.
 * (Full HL7 FHIR would require a dedicated library; this provides
 * a structured representation compatible with HL7 concepts.)
 *
 * @param {Object} options Same as exportToEDF
 * @returns {Object} HL7-compatible JSON object
 */
function exportToHL7({ patient, session, signals }) {
  const channelMap = {};
  for (const sig of signals) {
    const ch = sig.channelId || 'unknown';
    if (!channelMap[ch]) channelMap[ch] = [];
    channelMap[ch].push(...(sig.samples || []));
  }

  const observation = {
    resourceType: 'DiagnosticReport',
    id: session?.sessionId || 'unknown',
    status: session?.status === 'completed' ? 'final' : 'preliminary',
    category: [{
      coding: [{
        system: 'http://terminology.hl7.org/CodeSystem/v2-0074',
        code: 'CG',
        display: 'Cardiac Electrophysiology',
      }],
    }],
    code: {
      coding: [{
        system: 'http://loinc.org',
        code: '11524-6',
        display: 'EKG study',
      }],
    },
    subject: patient ? {
      reference: `Patient/${patient.patientId}`,
      display: `${patient.firstName || ''} ${patient.lastName || ''}`.trim(),
    } : undefined,
    effectivePeriod: {
      start: session?.startedAt ? new Date(session.startedAt).toISOString() : undefined,
      end: session?.endedAt ? new Date(session.endedAt).toISOString() : undefined,
    },
    device: session?.device ? {
      display: `Holter Device ${session.device.deviceId}`,
    } : undefined,
    result: Object.entries(channelMap).map(([chId, samples]) => ({
      channelId: chId,
      label: CHANNEL_LABELS[chId] || `Channel ${chId}`,
      sampleCount: samples.length,
      unit: 'uV',
      data: samples.slice(0, 10000), // Limit for JSON response
    })),
    meta: {
      generatedAt: new Date().toISOString(),
      generator: 'Horizon Medical Platform',
      format: 'HL7 FHIR DiagnosticReport (simplified)',
    },
  };

  return observation;
}

module.exports = { exportToEDF, exportToHL7 };
