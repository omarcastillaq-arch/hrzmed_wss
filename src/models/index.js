/**
 * @module models
 * @description Central export for all Mongoose models.
 */

'use strict';

const Patient = require('./Patient');
const ECGSession = require('./ECGSession');
const ECGSignal = require('./ECGSignal');

module.exports = { Patient, ECGSession, ECGSignal };
