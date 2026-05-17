/**
 * @module openApiSpec
 * @description OpenAPI 3.0 specification for the Horizon Medical REST API.
 */

'use strict';

module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'Horizon Medical REST API',
    version: '2.0.0',
    description: 'Complete REST API for the Horizon Medical IoT Holter EKG platform. Provides endpoints for ECG session management, patient records, medical user (staff) management, device assignments, report generation, and data export in standard medical formats (EDF, HL7 FHIR, CSV).',
    contact: {
      name: 'Horizon Medical',
      url: 'https://github.com/jgrana2/hrzmed_wss',
    },
    license: {
      name: 'MIT',
      url: 'https://opensource.org/licenses/MIT',
    },
  },
  servers: [
    { url: 'http://localhost:9990', description: 'Local development' },
    { url: 'https://syxsens.com', description: 'Production' },
  ],
  tags: [
    { name: 'Sessions', description: 'ECG recording session management' },
    { name: 'Patients', description: 'Patient records management' },
    { name: 'Medical Users', description: 'Medical staff (doctors, nurses, admins) management' },
    { name: 'Device Assignments', description: 'Device-to-patient assignment lifecycle' },
    { name: 'Reports', description: 'Medical report generation (PDF)' },
    { name: 'Export', description: 'ECG data export (EDF, HL7, CSV)' },
    { name: 'Monitoring', description: 'System health and metrics' },
  ],
  paths: {
    // ─── Sessions ──────────────────────────────────────────────
    '/api/v1/sessions': {
      get: {
        tags: ['Sessions'],
        summary: 'List ECG sessions',
        description: 'Returns paginated list of ECG recording sessions with optional filters.',
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['recording', 'completed', 'interrupted', 'error'] } },
          { name: 'patientId', in: 'query', schema: { type: 'string' } },
          { name: 'deviceId', in: 'query', schema: { type: 'string' } },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Start date filter' },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'End date filter' },
          { name: 'sort', in: 'query', schema: { type: 'string' }, description: 'Sort field(s), e.g. -startedAt' },
        ],
        responses: {
          200: { description: 'List of sessions', content: { 'application/json': { schema: { $ref: '#/components/schemas/SessionListResponse' } } } },
        },
      },
    },
    '/api/v1/sessions/{sessionId}': {
      get: {
        tags: ['Sessions'],
        summary: 'Get session by ID',
        parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Session details' },
          404: { description: 'Session not found' },
        },
      },
    },
    '/api/v1/sessions/{sessionId}/signals': {
      get: {
        tags: ['Sessions'],
        summary: 'Get signals for a session',
        parameters: [
          { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'channel', in: 'query', schema: { type: 'string' }, description: 'Filter by channel ID' },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
        ],
        responses: {
          200: { description: 'List of ECG signals' },
        },
      },
    },

    // ─── Patients ──────────────────────────────────────────────
    '/api/v1/patients': {
      get: {
        tags: ['Patients'],
        summary: 'List patients',
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
          { name: 'active', in: 'query', schema: { type: 'boolean' } },
          { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Search by name' },
        ],
        responses: {
          200: { description: 'List of patients' },
        },
      },
      post: {
        tags: ['Patients'],
        summary: 'Create or update patient',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/PatientInput' } } },
        },
        responses: {
          200: { description: 'Patient created/updated' },
          400: { description: 'Validation error' },
        },
      },
    },
    '/api/v1/patients/{patientId}': {
      get: {
        tags: ['Patients'],
        summary: 'Get patient by ID',
        parameters: [{ name: 'patientId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Patient details' },
          404: { description: 'Patient not found' },
        },
      },
    },

    // ─── Medical Users ─────────────────────────────────────────
    '/api/v1/users': {
      get: {
        tags: ['Medical Users'],
        summary: 'List medical users',
        description: 'Returns paginated list of medical staff with optional filters.',
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
          { name: 'role', in: 'query', schema: { type: 'string', enum: ['doctor', 'nurse', 'admin', 'technician'] } },
          { name: 'active', in: 'query', schema: { type: 'boolean' } },
          { name: 'department', in: 'query', schema: { type: 'string' } },
          { name: 'institution', in: 'query', schema: { type: 'string' } },
          { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Search by name or email' },
        ],
        responses: {
          200: {
            description: 'Paginated list of medical users',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/UserListResponse' } } },
          },
        },
      },
      post: {
        tags: ['Medical Users'],
        summary: 'Create a new medical user',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/MedicalUserInput' } } },
        },
        responses: {
          201: { description: 'User created successfully' },
          400: { description: 'Missing required fields or invalid role' },
          409: { description: 'Email already registered' },
        },
      },
    },
    '/api/v1/users/{userId}': {
      get: {
        tags: ['Medical Users'],
        summary: 'Get medical user by ID',
        parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'User details' },
          404: { description: 'User not found' },
        },
      },
      put: {
        tags: ['Medical Users'],
        summary: 'Update medical user',
        parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/MedicalUserUpdate' } } },
        },
        responses: {
          200: { description: 'User updated' },
          404: { description: 'User not found' },
          409: { description: 'Email already registered' },
        },
      },
      delete: {
        tags: ['Medical Users'],
        summary: 'Deactivate (soft-delete) a medical user',
        parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'User deactivated' },
          404: { description: 'User not found' },
        },
      },
    },
    '/api/v1/users/{userId}/patients': {
      post: {
        tags: ['Medical Users'],
        summary: 'Assign patients to a medical user',
        parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['patientIds'],
                properties: {
                  patientIds: { type: 'array', items: { type: 'string' }, description: 'Array of patient IDs to assign' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Patients assigned' },
          400: { description: 'Invalid input' },
          404: { description: 'User not found' },
        },
      },
    },

    // ─── Device Assignments ────────────────────────────────────
    '/api/v1/assignments': {
      get: {
        tags: ['Device Assignments'],
        summary: 'List device assignments',
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'returned', 'lost', 'maintenance'] } },
          { name: 'deviceId', in: 'query', schema: { type: 'string' } },
          { name: 'patientId', in: 'query', schema: { type: 'string' } },
          { name: 'assignedBy', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'List of assignments' } },
      },
      post: {
        tags: ['Device Assignments'],
        summary: 'Create a new device assignment',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/DeviceAssignmentInput' } } },
        },
        responses: {
          201: { description: 'Assignment created' },
          400: { description: 'Missing required fields' },
          404: { description: 'Patient not found' },
          409: { description: 'Device already assigned' },
        },
      },
    },
    '/api/v1/assignments/{assignmentId}': {
      get: {
        tags: ['Device Assignments'],
        summary: 'Get assignment by ID',
        parameters: [{ name: 'assignmentId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Assignment details' }, 404: { description: 'Not found' } },
      },
      put: {
        tags: ['Device Assignments'],
        summary: 'Update assignment',
        parameters: [{ name: 'assignmentId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/DeviceAssignmentUpdate' } } } },
        responses: { 200: { description: 'Updated' }, 404: { description: 'Not found' } },
      },
    },
    '/api/v1/assignments/{assignmentId}/return': {
      post: {
        tags: ['Device Assignments'],
        summary: 'Return a device (close assignment)',
        parameters: [{ name: 'assignmentId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { notes: { type: 'string' } } } } },
        },
        responses: {
          200: { description: 'Device returned' },
          400: { description: 'Assignment not active' },
          404: { description: 'Not found' },
        },
      },
    },
    '/api/v1/devices/{deviceId}/assignments': {
      get: {
        tags: ['Device Assignments'],
        summary: 'Get assignments for a specific device',
        parameters: [
          { name: 'deviceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Device assignments' } },
      },
    },
    '/api/v1/patients/{patientId}/assignments': {
      get: {
        tags: ['Device Assignments'],
        summary: 'Get assignments for a specific patient',
        parameters: [
          { name: 'patientId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Patient assignments' } },
      },
    },

    // ─── Reports & Export ──────────────────────────────────────
    '/api/v1/reports/ecg/pdf': {
      post: {
        tags: ['Reports'],
        summary: 'Generate ECG PDF report',
        description: 'Generates a professional medical PDF report with patient info, session metadata, and ECG waveform charts.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['sessionId'],
                properties: {
                  sessionId: { type: 'string', description: 'ECG session ID' },
                  doctorId: { type: 'string', description: 'Medical user ID of attending physician' },
                  notes: { type: 'string', description: 'Additional clinical notes' },
                  signalLimit: { type: 'integer', default: 1000, description: 'Max signal chunks to include' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'PDF file', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } },
          400: { description: 'Missing sessionId' },
          404: { description: 'Session not found' },
        },
      },
    },
    '/api/v1/export/ecg/{sessionId}/edf': {
      get: {
        tags: ['Export'],
        summary: 'Export ECG data in EDF format',
        description: 'Exports ECG signals in European Data Format (EDF/EDF+), the standard for polysomnographic recordings.',
        parameters: [
          { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'sampleRate', in: 'query', schema: { type: 'integer', default: 250 }, description: 'Sample rate in Hz' },
        ],
        responses: {
          200: { description: 'EDF file', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
          404: { description: 'Session not found' },
        },
      },
    },
    '/api/v1/export/ecg/{sessionId}/hl7': {
      get: {
        tags: ['Export'],
        summary: 'Export ECG data in HL7 FHIR format',
        description: 'Returns ECG data as an HL7 FHIR DiagnosticReport resource (simplified JSON).',
        parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'HL7 FHIR JSON', content: { 'application/json': { schema: { $ref: '#/components/schemas/HL7DiagnosticReport' } } } },
          404: { description: 'Session not found' },
        },
      },
    },
    '/api/v1/export/ecg/{sessionId}/csv': {
      get: {
        tags: ['Export'],
        summary: 'Export ECG data as CSV',
        description: 'Exports ECG signal data as a CSV file with columns per channel.',
        parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'CSV file', content: { 'text/csv': { schema: { type: 'string' } } } },
          404: { description: 'Session not found' },
        },
      },
    },

    // ─── Monitoring ────────────────────────────────────────────
    '/health': {
      get: {
        tags: ['Monitoring'],
        summary: 'Health check',
        responses: { 200: { description: 'Server is healthy' } },
      },
    },
    '/api/v1/monitoring/metrics': {
      get: {
        tags: ['Monitoring'],
        summary: 'Current metrics snapshot',
        responses: { 200: { description: 'Metrics data' } },
      },
    },
    '/api/v1/stats': {
      get: {
        tags: ['Monitoring'],
        summary: 'Aggregated statistics',
        responses: { 200: { description: 'Platform statistics' } },
      },
    },
  },

  // ─── Components ────────────────────────────────────────────────
  components: {
    schemas: {
      MedicalUserInput: {
        type: 'object',
        required: ['email', 'password', 'firstName', 'lastName', 'role'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 8 },
          firstName: { type: 'string', maxLength: 100 },
          lastName: { type: 'string', maxLength: 100 },
          phone: { type: 'string' },
          role: { type: 'string', enum: ['doctor', 'nurse', 'admin', 'technician'] },
          specialty: { type: 'string' },
          licenseNumber: { type: 'string' },
          department: { type: 'string' },
          institution: { type: 'string' },
          permissions: { type: 'array', items: { type: 'string' } },
        },
      },
      MedicalUserUpdate: {
        type: 'object',
        properties: {
          firstName: { type: 'string' },
          lastName: { type: 'string' },
          phone: { type: 'string' },
          role: { type: 'string', enum: ['doctor', 'nurse', 'admin', 'technician'] },
          specialty: { type: 'string' },
          licenseNumber: { type: 'string' },
          department: { type: 'string' },
          institution: { type: 'string' },
          permissions: { type: 'array', items: { type: 'string' } },
          active: { type: 'boolean' },
          password: { type: 'string', minLength: 8 },
          email: { type: 'string', format: 'email' },
        },
      },
      MedicalUser: {
        type: 'object',
        properties: {
          userId: { type: 'string', format: 'uuid' },
          email: { type: 'string', format: 'email' },
          firstName: { type: 'string' },
          lastName: { type: 'string' },
          phone: { type: 'string' },
          role: { type: 'string', enum: ['doctor', 'nurse', 'admin', 'technician'] },
          specialty: { type: 'string' },
          licenseNumber: { type: 'string' },
          department: { type: 'string' },
          institution: { type: 'string' },
          permissions: { type: 'array', items: { type: 'string' } },
          active: { type: 'boolean' },
          assignedPatients: { type: 'array', items: { type: 'string' } },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      UserListResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: { type: 'array', items: { $ref: '#/components/schemas/MedicalUser' } },
          pagination: { $ref: '#/components/schemas/Pagination' },
        },
      },
      PatientInput: {
        type: 'object',
        required: ['patientId'],
        properties: {
          patientId: { type: 'string' },
          firstName: { type: 'string' },
          lastName: { type: 'string' },
          dateOfBirth: { type: 'string', format: 'date' },
          gender: { type: 'string', enum: ['male', 'female', 'other', 'unknown'] },
          medicalRecordNumber: { type: 'string' },
          attendingPhysician: { type: 'string' },
          diagnosis: { type: 'string' },
          notes: { type: 'string' },
        },
      },
      DeviceAssignmentInput: {
        type: 'object',
        required: ['deviceId', 'patientId', 'assignedBy'],
        properties: {
          deviceId: { type: 'string' },
          deviceName: { type: 'string', default: 'IoT Holter' },
          deviceType: { type: 'string', enum: ['holter', 'monitor', 'wearable', 'other'] },
          patientId: { type: 'string' },
          assignedBy: { type: 'string', description: 'userId of assigning medical user' },
          expectedReturnAt: { type: 'string', format: 'date-time' },
          notes: { type: 'string' },
          monitoringConfig: {
            type: 'object',
            properties: {
              duration: { type: 'number', description: 'Hours' },
              channels: { type: 'array', items: { type: 'string' } },
              sampleRate: { type: 'number', default: 250 },
            },
          },
        },
      },
      DeviceAssignmentUpdate: {
        type: 'object',
        properties: {
          notes: { type: 'string' },
          expectedReturnAt: { type: 'string', format: 'date-time' },
          status: { type: 'string', enum: ['active', 'returned', 'lost', 'maintenance'] },
          deviceName: { type: 'string' },
          monitoringConfig: { type: 'object' },
        },
      },
      SessionListResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: { type: 'array', items: { type: 'object' } },
          pagination: { $ref: '#/components/schemas/Pagination' },
        },
      },
      HL7DiagnosticReport: {
        type: 'object',
        properties: {
          resourceType: { type: 'string', example: 'DiagnosticReport' },
          id: { type: 'string' },
          status: { type: 'string' },
          category: { type: 'array', items: { type: 'object' } },
          code: { type: 'object' },
          subject: { type: 'object' },
          effectivePeriod: { type: 'object' },
          result: { type: 'array', items: { type: 'object' } },
        },
      },
      Pagination: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          limit: { type: 'integer' },
          total: { type: 'integer' },
          pages: { type: 'integer' },
        },
      },
    },
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
  },
  security: [{ bearerAuth: [] }],
};
