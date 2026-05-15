/**
 * @module pdfReportGenerator
 * @description Generates medical PDF reports with ECG signal graphs.
 *
 * Uses PDFKit to create professional medical reports including:
 *   - Patient demographics
 *   - Session metadata
 *   - ECG signal waveform charts
 *   - Quality metrics and clinical notes
 */

'use strict';

const PDFDocument = require('pdfkit');
const logger = require('../utils/logger');

// ─── Colors & Styles ─────────────────────────────────────────────────────────

const COLORS = {
  primary: '#1a5276',
  secondary: '#2e86c1',
  accent: '#e74c3c',
  text: '#2c3e50',
  lightGray: '#ecf0f1',
  gridLine: '#d5dbdb',
  ecgLine: '#e74c3c',
  channelColors: [
    '#e74c3c', '#2e86c1', '#27ae60', '#f39c12',
    '#8e44ad', '#1abc9c', '#d35400', '#34495e',
  ],
};

// ─── ECG Chart Drawing ───────────────────────────────────────────────────────

function drawECGGrid(doc, x, y, width, height) {
  doc.save();
  doc.lineWidth(0.3).strokeColor(COLORS.gridLine);

  // Vertical grid lines (small squares)
  const gridSize = 10;
  for (let gx = x; gx <= x + width; gx += gridSize) {
    doc.moveTo(gx, y).lineTo(gx, y + height).stroke();
  }
  for (let gy = y; gy <= y + height; gy += gridSize) {
    doc.moveTo(x, gy).lineTo(x + width, gy).stroke();
  }

  // Major grid lines (5x5 squares)
  doc.lineWidth(0.6).strokeColor('#bdc3c7');
  for (let gx = x; gx <= x + width; gx += gridSize * 5) {
    doc.moveTo(gx, y).lineTo(gx, y + height).stroke();
  }
  for (let gy = y; gy <= y + height; gy += gridSize * 5) {
    doc.moveTo(x, gy).lineTo(x + width, gy).stroke();
  }

  doc.restore();
}

function drawECGWaveform(doc, x, y, width, height, samples, color) {
  if (!samples || samples.length === 0) return;

  doc.save();

  // Normalize samples to fit chart height
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const range = max - min || 1;
  const midY = y + height / 2;
  const scaleY = (height * 0.8) / 2;
  const stepX = width / samples.length;

  doc.lineWidth(1.2).strokeColor(color);

  doc.moveTo(x, midY - ((samples[0] - (min + range / 2)) / (range / 2)) * scaleY);
  for (let i = 1; i < samples.length; i++) {
    const px = x + i * stepX;
    const normalized = (samples[i] - (min + range / 2)) / (range / 2);
    const py = midY - normalized * scaleY;
    doc.lineTo(px, py);
  }
  doc.stroke();
  doc.restore();
}

// ─── Main Report Generator ──────────────────────────────────────────────────

/**
 * Generate a medical ECG report as a PDF buffer.
 *
 * @param {Object} options
 * @param {Object} options.patient     - Patient document
 * @param {Object} options.session     - ECGSession document
 * @param {Array}  options.signals     - Array of ECGSignal documents
 * @param {Object} [options.doctor]    - MedicalUser who generates the report
 * @param {string} [options.notes]     - Additional clinical notes
 * @returns {Promise<Buffer>} PDF file as buffer
 */
async function generateReport({ patient, session, signals, doctor, notes }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'LETTER',
        margins: { top: 40, bottom: 40, left: 50, right: 50 },
        info: {
          Title: `ECG Report - ${patient?.patientId || 'Unknown'}`,
          Author: doctor ? `Dr. ${doctor.firstName} ${doctor.lastName}` : 'Horizon Medical',
          Subject: 'ECG Medical Report',
          Creator: 'Horizon Medical Platform',
        },
      });

      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // ─── Header ────────────────────────────────────────────────────────
      doc.fontSize(20).fillColor(COLORS.primary).text('HORIZON MEDICAL', { align: 'center' });
      doc.fontSize(12).fillColor(COLORS.secondary).text('ECG / Holter Report', { align: 'center' });
      doc.moveDown(0.5);

      // Header line
      doc.lineWidth(2).strokeColor(COLORS.primary)
        .moveTo(50, doc.y).lineTo(562, doc.y).stroke();
      doc.moveDown(0.5);

      // ─── Report Metadata ──────────────────────────────────────────────
      const reportDate = new Date().toISOString().split('T')[0];
      doc.fontSize(9).fillColor(COLORS.text);
      doc.text(`Report Date: ${reportDate}`, { align: 'right' });
      if (session) {
        doc.text(`Session ID: ${session.sessionId}`, { align: 'right' });
      }
      doc.moveDown(0.5);

      // ─── Patient Information ──────────────────────────────────────────
      doc.fontSize(13).fillColor(COLORS.primary).text('Patient Information');
      doc.lineWidth(0.5).strokeColor(COLORS.secondary)
        .moveTo(50, doc.y).lineTo(300, doc.y).stroke();
      doc.moveDown(0.3);

      doc.fontSize(10).fillColor(COLORS.text);
      if (patient) {
        const fields = [
          ['Patient ID', patient.patientId],
          ['Name', `${patient.firstName || ''} ${patient.lastName || ''}`.trim() || 'N/A'],
          ['Date of Birth', patient.dateOfBirth ? new Date(patient.dateOfBirth).toISOString().split('T')[0] : 'N/A'],
          ['Gender', patient.gender || 'N/A'],
          ['MRN', patient.medicalRecordNumber || 'N/A'],
          ['Diagnosis', patient.diagnosis || 'N/A'],
        ];
        for (const [label, value] of fields) {
          doc.font('Helvetica-Bold').text(`${label}: `, { continued: true });
          doc.font('Helvetica').text(value);
        }
      } else {
        doc.text('Patient information not available');
      }
      doc.moveDown(0.5);

      // ─── Session Information ──────────────────────────────────────────
      if (session) {
        doc.fontSize(13).fillColor(COLORS.primary).text('Session Information');
        doc.lineWidth(0.5).strokeColor(COLORS.secondary)
          .moveTo(50, doc.y).lineTo(300, doc.y).stroke();
        doc.moveDown(0.3);

        doc.fontSize(10).fillColor(COLORS.text);
        const sessionFields = [
          ['Device ID', session.device?.deviceId || 'N/A'],
          ['Started', session.startedAt ? new Date(session.startedAt).toISOString() : 'N/A'],
          ['Ended', session.endedAt ? new Date(session.endedAt).toISOString() : 'In progress'],
          ['Status', session.status || 'N/A'],
          ['Duration', session.durationMs ? `${Math.round(session.durationMs / 1000)}s` : 'N/A'],
          ['Total Samples', session.quality?.totalSamples?.toString() || 'N/A'],
          ['Signal Quality', session.quality?.avgSignalQuality ? `${session.quality.avgSignalQuality}%` : 'N/A'],
        ];
        for (const [label, value] of sessionFields) {
          doc.font('Helvetica-Bold').text(`${label}: `, { continued: true });
          doc.font('Helvetica').text(value);
        }
        doc.moveDown(0.5);
      }

      // ─── ECG Waveforms ────────────────────────────────────────────────
      if (signals && signals.length > 0) {
        doc.addPage();
        doc.fontSize(13).fillColor(COLORS.primary).text('ECG Waveforms');
        doc.lineWidth(0.5).strokeColor(COLORS.secondary)
          .moveTo(50, doc.y).lineTo(300, doc.y).stroke();
        doc.moveDown(0.5);

        // Group signals by channel
        const channelMap = {};
        for (const sig of signals) {
          const ch = sig.channelId || 'unknown';
          if (!channelMap[ch]) channelMap[ch] = [];
          channelMap[ch].push(...(sig.samples || []));
        }

        const channelNames = {
          '8171': 'Lead I',   '8172': 'Lead II',  '8173': 'Lead III',
          '8174': 'aVR',      '8175': 'aVL',      '8176': 'aVF',
          '8177': 'V1',       '8178': 'V2',
        };

        const chartWidth = 500;
        const chartHeight = 60;
        let chartY = doc.y;
        let colorIdx = 0;

        for (const [chId, samples] of Object.entries(channelMap)) {
          if (chartY + chartHeight + 30 > doc.page.height - 50) {
            doc.addPage();
            chartY = 50;
          }

          // Channel label
          doc.fontSize(9).fillColor(COLORS.text)
            .text(channelNames[chId] || `Channel ${chId}`, 50, chartY);
          chartY += 12;

          // Draw grid and waveform
          drawECGGrid(doc, 50, chartY, chartWidth, chartHeight);
          const displaySamples = samples.slice(0, 2000); // Limit for rendering
          drawECGWaveform(doc, 50, chartY, chartWidth, chartHeight,
            displaySamples, COLORS.channelColors[colorIdx % 8]);

          chartY += chartHeight + 15;
          colorIdx++;
        }
      }

      // ─── Clinical Notes ───────────────────────────────────────────────
      if (notes || patient?.notes) {
        if (doc.y > doc.page.height - 150) doc.addPage();
        doc.moveDown(1);
        doc.fontSize(13).fillColor(COLORS.primary).text('Clinical Notes');
        doc.lineWidth(0.5).strokeColor(COLORS.secondary)
          .moveTo(50, doc.y).lineTo(300, doc.y).stroke();
        doc.moveDown(0.3);
        doc.fontSize(10).fillColor(COLORS.text);
        doc.text(notes || patient?.notes || 'No clinical notes provided.');
      }

      // ─── Attending Physician ──────────────────────────────────────────
      if (doctor) {
        if (doc.y > doc.page.height - 120) doc.addPage();
        doc.moveDown(2);
        doc.fontSize(13).fillColor(COLORS.primary).text('Attending Physician');
        doc.lineWidth(0.5).strokeColor(COLORS.secondary)
          .moveTo(50, doc.y).lineTo(300, doc.y).stroke();
        doc.moveDown(0.3);
        doc.fontSize(10).fillColor(COLORS.text);
        doc.text(`Dr. ${doctor.firstName} ${doctor.lastName}`);
        if (doctor.specialty) doc.text(`Specialty: ${doctor.specialty}`);
        if (doctor.licenseNumber) doc.text(`License: ${doctor.licenseNumber}`);
        if (doctor.institution) doc.text(`Institution: ${doctor.institution}`);
      }

      // ─── Footer ───────────────────────────────────────────────────────
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.fontSize(8).fillColor('#999')
          .text(
            `Horizon Medical Platform — Page ${i + 1} of ${range.count} — Generated ${reportDate}`,
            50, doc.page.height - 30,
            { align: 'center', width: 512 },
          );
      }

      doc.end();
    } catch (err) {
      logger.error('PDF generation error', { error: err.message });
      reject(err);
    }
  });
}

module.exports = { generateReport };
