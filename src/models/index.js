/**
 * @module models
 * @description Central export for all Mongoose models.
 */

'use strict';

const Patient = require('./Patient');
const ECGSession = require('./ECGSession');
const ECGSignal = require('./ECGSignal');
const MedicalUser = require('./MedicalUser');
const DeviceAssignment = require('./DeviceAssignment');

module.exports = { Patient, ECGSession, ECGSignal, MedicalUser, DeviceAssignment };
