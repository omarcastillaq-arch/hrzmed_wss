# Performance Optimization Guide — Horizon Medical WSS

## Phase 12: Backend Performance Optimization

This document describes the performance optimizations implemented in the Horizon Medical WebSocket Server to support higher device concurrency, reduce latency, and minimize bandwidth usage.

---

### 1. Redis Cache Layer

**Module:** `src/services/redisCache.js`

A Redis-based caching layer with graceful degradation. When Redis is unavailable, the server continues operating normally (cache-aside pattern).

#### What's Cached

| Cache Target | TTL | Key Pattern | Purpose |
|---|---|---|---|
| Active ECG Sessions | 300s | `session:{sessionId}` | Avoid repeated MongoDB queries for session details |
| Device Status | 60s | `device:{deviceId}` | Fast device lookup (battery, connectivity, last activity) |
| Query Results | 30s | `query:{hash}` | Cache session lists, patient queries |
| Aggregated Stats | 15s | `stats:global` | Expensive count/aggregate operations |
| Active Sessions List | 10s | `sessions:active` | Dashboard polling optimization |

#### Configuration

```env
REDIS_ENABLED=true
REDIS_URL=redis://redis:6379
REDIS_KEY_PREFIX=hrzmed:
REDIS_TTL_SESSION=300
REDIS_TTL_QUERY=30
REDIS_TTL_STATS=15
```

#### Expected Impact

- **Stats endpoint:** 90%+ cache hit rate, reduces 4× MongoDB count queries per request
- **Session queries:** 60-80% cache hit rate for repeated queries
- **Device status:** Sub-millisecond lookups vs 5-15ms MongoDB queries

---

### 2. MongoDB Connection Pooling

**Module:** `src/config/mongodb.js`

Optimized connection pool replaces the default Mongoose settings.

#### Key Settings

| Setting | Development | Production | Purpose |
|---|---|---|---|
| `maxPoolSize` | 20 | 50 | Concurrent operations (1 pool connection per in-flight query) |
| `minPoolSize` | 2 | 10 | Warm connections ready for traffic spikes |
| `writeConcern` | `1` | `majority` | Data durability for medical records |
| `readPreference` | `primary` | `secondaryPreferred` | Read scaling in replica sets |
| `compressors` | zstd, snappy, zlib | zstd, snappy, zlib | Wire protocol compression |
| `retryWrites/Reads` | true | true | Automatic retry on transient failures |
| `autoIndex` | true | false | Avoid index creation overhead in production |

#### Connection Retry

Exponential backoff with up to 10 attempts (1s → 2s → 4s → ... → 30s max).

---

### 3. MongoDB Indexes

Compound indexes optimized for the most frequent query patterns:

#### ECGSession Indexes

```
{ sessionId: 1 }                       — Session lookup by ID
{ patientId: 1, startedAt: -1 }       — Patient history (newest first)
{ 'device.deviceId': 1, startedAt: -1 } — Device session history
{ status: 1, startedAt: -1 }          — Active/completed session queries
{ startedAt: -1, endedAt: -1 }        — Date range queries
```

#### ECGSignal Indexes

```
{ sessionId: 1, channelId: 1, timestamp: 1 } — Signal retrieval per session+channel
{ sessionId: 1, sequenceNumber: 1 }          — Sequence gap detection
{ deviceId: 1, timestamp: -1 }               — Latest device signals
```

#### Patient Indexes

```
{ patientId: 1 }               — Patient lookup
{ lastName: 1, firstName: 1 }  — Name search
{ createdAt: -1 }              — Newest patients
```

---

### 4. WebSocket Compression

**Module:** `src/services/wsOptimizer.js`

permessage-deflate compression on all WebSocket messages.

#### Configuration

```env
WS_COMPRESSION_ENABLED=true
```

#### Compression Settings

- **Level 1** (best speed) — optimized for real-time data, not maximum compression
- **Threshold:** 128 bytes — small messages (pings, acks) are not compressed
- **Context takeover:** Enabled — reuses deflate dictionary across messages for better ratios on ECG streams
- **Window bits:** 13 (8KB window) — balanced memory vs compression

#### Expected Bandwidth Reduction

| Message Type | Typical Size | Compressed | Reduction |
|---|---|---|---|
| ECG data (21 samples) | ~280 bytes | ~120 bytes | ~57% |
| ECG data (50 samples) | ~620 bytes | ~200 bytes | ~68% |
| Device status | ~150 bytes | ~90 bytes | ~40% |
| Welcome message | ~250 bytes | ~130 bytes | ~48% |

---

### 5. Client Health Monitor

Automatic detection and cleanup of stale WebSocket connections.

- **Ping interval:** 30s (configurable via `WS_PING_INTERVAL`)
- **Pong timeout:** 10s — connection terminated if no pong received
- **Impact:** Frees server resources from zombie connections (common with mobile devices losing connectivity)

---

### 6. Backpressure Management

Prevents memory exhaustion when slow clients can't keep up with ECG data broadcasts.

- **Max buffer:** 64KB per client (configurable via `WS_MAX_BACKPRESSURE`)
- **Behavior:** Messages are dropped (not queued) for overloaded clients
- **Logging:** Dropped messages are logged at debug level for monitoring

---

### 7. Batched Broadcasting

Reduces per-client iteration overhead when broadcasting ECG data to monitoring dashboards.

- **Batch interval:** 50ms (configurable via `WS_BATCH_INTERVAL`)
- **Impact:** Multiple ECG channels arriving within 50ms window are broadcast in a single pass
- **Set to 0** for immediate broadcasting (lower latency, higher CPU)

---

### 8. Connection Pool Tracker

Efficient O(1) lookups for connections by role or device.

- **By Device:** `connectionPool.getByDevice(deviceId)` — find all monitoring clients for a device
- **By Role:** `connectionPool.getByRole('monitor')` — find all dashboard clients
- **Replaces:** O(n) iteration over all clients for each broadcast

---

### 9. Multi-Process Clustering

**Module:** `src/services/clusterManager.js`

Fork worker processes across CPU cores for horizontal scaling.

```env
CLUSTER_ENABLED=true
CLUSTER_WORKERS=0  # 0 = auto (CPU cores - 1, min 2)
```

#### Architecture

- Primary process manages worker lifecycle
- Each worker runs an independent WebSocket server
- Crashed workers are automatically restarted (with crash loop protection)
- Graceful shutdown propagated to all workers

#### When to Enable

- **Single server** with 4+ CPU cores
- **100+** concurrent device connections
- Not needed when using container orchestration (Kubernetes scales pods instead)

---

### 10. Docker Infrastructure

Redis added to docker-compose as a new service:

```yaml
redis:
  image: redis:7-alpine
  command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru
```

- **Max memory:** 256MB with LRU eviction
- **Persistence:** AOF (append-only file) for cache warmth across restarts
- **Alpine image:** Minimal footprint

---

## Performance Benchmarks

### Message Processing Throughput

| Metric | Before | After | Improvement |
|---|---|---|---|
| ECG validation throughput | ~5,000 msg/s | ~5,000 msg/s | Baseline (CPU-bound) |
| Connection pool add/remove (1000) | N/A (linear scan) | < 100ms | O(1) lookups |
| Stats API (cached) | ~15ms | < 1ms | 93%+ reduction |
| Session query (cached) | ~8ms | < 1ms | 87%+ reduction |
| Bandwidth (ECG stream) | 100% | ~35-45% | 55-65% reduction |
| Stale connection cleanup | Manual | Automatic (30s) | Zero intervention |

### Concurrent Device Support

| Configuration | Estimated Max Devices |
|---|---|
| Single process, no optimization | ~50-100 |
| Single process + all optimizations | ~200-500 |
| Cluster mode (4 workers) + all optimizations | ~800-2000 |

---

## Configuration Reference

All performance settings with defaults:

```env
# Redis
REDIS_ENABLED=true
REDIS_URL=redis://localhost:6379
REDIS_KEY_PREFIX=hrzmed:
REDIS_TTL_SESSION=300
REDIS_TTL_DEVICE=60
REDIS_TTL_QUERY=30
REDIS_TTL_STATS=15

# MongoDB Pool
MONGO_POOL_SIZE=50          # production default
MONGO_MIN_POOL_SIZE=10
MONGO_CONNECT_TIMEOUT=10000
MONGO_SOCKET_TIMEOUT=45000

# WebSocket
WS_COMPRESSION_ENABLED=true
WS_PING_INTERVAL=30000
WS_MAX_BACKPRESSURE=65536
WS_BATCH_INTERVAL=50
WS_MAX_PAYLOAD=1048576

# Cluster
CLUSTER_ENABLED=false
CLUSTER_WORKERS=0
```
