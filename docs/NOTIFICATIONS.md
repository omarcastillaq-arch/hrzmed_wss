# Fase 16 - Sistema de Notificaciones

## Descripción

Sistema completo de notificaciones para Horizon Medical WSS que detecta eventos críticos del sistema y alerta automáticamente al personal médico mediante email, WebSocket en tiempo real y dashboard.

## Arquitectura

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   WebSocket      │────▶│  Event Detectors  │────▶│  Notification   │
│   (IoT Devices)  │     │  - Arrhythmia     │     │  Service        │
└─────────────────┘     │  - Disconnect     │     │  - Queue        │
                        │  - Battery Low    │     │  - Rate Limit   │
                        │  - Signal Quality │     │  - Suppression  │
                        └──────────────────┘     └────────┬────────┘
                                                          │
                        ┌─────────────────────────────────┼──────────┐
                        │                                 │          │
                   ┌────▼─────┐    ┌─────────────┐  ┌───▼──────┐
                   │  MongoDB  │    │   Email      │  │ WebSocket │
                   │  History  │    │   (SMTP)     │  │ Broadcast │
                   └──────────┘    └─────────────┘  └──────────┘
```

## Componentes Backend

### 1. Notification Service (`src/services/notification-service.js`)

Motor principal con:
- **Priority Queue**: Cola con priorización por severidad (CRITICAL > HIGH > MEDIUM > LOW)
- **Rate Limiter**: Límite configurable de notificaciones por tipo/dispositivo
- **Suppression Tracker**: Supresión de duplicados dentro de ventana temporal
- **Email Templates**: Templates HTML profesionales con soporte multi-destinatario
- **WebSocket Broadcast**: Push en tiempo real a clientes dashboard

### 2. Modelos MongoDB

#### Notification (`src/models/Notification.js`)
```javascript
{
  notificationId: String,      // UUID único
  type: String,                // arrhythmia_detected, device_disconnected, etc.
  severity: String,            // CRITICAL, HIGH, MEDIUM, LOW
  title: String,
  message: String,
  source: {
    deviceId: String,
    patientId: String,
    sessionId: String,
    connectionId: String
  },
  recipients: [{
    email: String,
    deliveryStatus: String,    // pending, sent, failed
  }],
  status: String,              // pending, sent, read, acknowledged, failed, suppressed
  metadata: Mixed,
  retryCount: Number,
  createdAt: Date
}
```

#### NotificationPreference (`src/models/NotificationPreference.js`)
```javascript
{
  userId: String,
  email: String,
  enabled: Boolean,
  channels: { email, websocket, dashboard },
  severityFilter: { CRITICAL, HIGH, MEDIUM, LOW },
  typeFilter: { arrhythmia_detected, ... },
  quietHours: { enabled, start, end, timezone, overrideForCritical }
}
```

### 3. API REST (`src/routes/notificationRoutes.js`)

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/v1/notifications` | Listar con filtros (severity, type, status, fecha) |
| GET | `/api/v1/notifications/:id` | Detalle de notificación |
| GET | `/api/v1/notifications/stats` | Estadísticas (por severidad, tipo, estado) |
| GET | `/api/v1/notifications/unread-count` | Contador de no leídas |
| POST | `/api/v1/notifications/test` | Enviar notificación de prueba |
| PUT | `/api/v1/notifications/:id/read` | Marcar como leída |
| PUT | `/api/v1/notifications/:id/acknowledge` | Confirmar/reconocer |
| GET | `/api/v1/notifications/preferences` | Obtener preferencias |
| PUT | `/api/v1/notifications/preferences` | Actualizar preferencias |

### 4. Event Detectors

- **Arrhythmia**: Detecta clasificaciones peligrosas (VFib, VTach, asistolia, anormal) del Edge AI
- **Device Disconnection**: Dispara al cerrar conexión WebSocket de dispositivo
- **Battery Low**: Monitorea nivel <20% (HIGH <5%, MEDIUM 5-20%)
- **Signal Quality**: Monitorea SNR bajo y quality score degradado

## Componentes Dashboard

### Página de Notificaciones (`/notifications`)
- Lista con filtros por severidad, tipo y estado
- Paginación
- Vista detallada en modal
- Marcar como leída / confirmar

### Tabs
- **Notificaciones**: Lista principal
- **Estadísticas**: Métricas por severidad, tipo y estado
- **Preferencias**: Configuración de alertas por usuario

### NotificationBell (Header)
- Contador de no leídas
- Dropdown con notificaciones recientes
- Animación de campanilla para nuevas notificaciones

### Real-time
- WebSocket listener para notificaciones en vivo
- Toast notifications (Sonner) según severidad
- Auto-prepend de nuevas notificaciones a la lista

## Configuración (.env)

```bash
# SMTP
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=user@example.com
SMTP_PASS=password
SMTP_FROM=Horizon Medical <noreply@horizon-medical.com>
SMTP_SECURE=false

# Destinatario por defecto
NOTIF_DEFAULT_EMAIL=admin@hospital.com

# Rate limiting
NOTIF_RATE_LIMIT_WINDOW_MS=300000   # 5 min
NOTIF_RATE_LIMIT_MAX=10             # max por ventana

# Reintentos
NOTIF_MAX_RETRIES=3
NOTIF_RETRY_DELAY_MS=30000

# Procesamiento de cola
NOTIF_QUEUE_INTERVAL_MS=2000

# Supresión de duplicados
NOTIF_SUPPRESSION_WINDOW_MS=60000
```

## Tests

52 tests nuevos en `tests/notifications.test.js`:

```bash
npm run test:notifications
```

Cobertura:
- NotificationQueue (5 tests)
- NotificationRateLimiter (4 tests)
- SuppressionTracker (5 tests)
- Severity System (2 tests)
- Email Templates (4 tests)
- Event Detectors - Battery (3 tests)
- Event Detectors - Arrhythmia (3 tests)
- Event Detectors - Disconnection (2 tests)
- Event Detectors - Signal Quality (2 tests)
- WebSocket Broadcast (3 tests)
- Notification Model Schema (4 tests)
- NotificationPreference Model Schema (5 tests)
- API Route Handlers (10 tests)

## Severidad de Notificaciones

| Severidad | Uso | Acción |
|-----------|-----|--------|
| CRITICAL | VFib, asistolia | Email inmediato + toast rojo + sonido |
| HIGH | VTach, desconexión en sesión, batería <5% | Email + toast naranja |
| MEDIUM | Batería 5-20%, desconexión sin sesión | Email (si configurado) |
| LOW | Señal degradada (SNR > 5), pruebas | Solo dashboard |
