# WebSocket + MongoDB Server

[![CI - Tests & Linting](https://github.com/jgrana2/hrzmed_wss/actions/workflows/ci.yml/badge.svg)](https://github.com/jgrana2/hrzmed_wss/actions/workflows/ci.yml)
[![Docker Build & Push](https://github.com/jgrana2/hrzmed_wss/actions/workflows/docker.yml/badge.svg)](https://github.com/jgrana2/hrzmed_wss/actions/workflows/docker.yml)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Coverage](https://img.shields.io/badge/coverage-90%25-brightgreen)](./docs/CI_CD.md)

This project sets up a scalable and secure WebSocket server using Node.js, integrated with a MongoDB database. It leverages Docker Compose to orchestrate services, including NGINX for reverse proxying and Certbot for SSL certificate management. This setup ensures real-time communication with connected clients while maintaining secure data transmission.

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
  - [1. Clone the Repository](#1-clone-the-repository)
  - [2. Configure Environment Variables](#2-configure-environment-variables)
  - [3. Docker Compose Setup](#3-docker-compose-setup)
  - [4. Build and Run the Services](#4-build-and-run-the-services)
- [Usage](#usage)
- [Logging](#logging)
- [License](#license)
- [Acknowledgments](#acknowledgments)
- [Troubleshooting](#troubleshooting)

## Features

- **Real-Time Communication:** Implements WebSockets for seamless real-time data exchange.
- **Secure Connections:** Utilizes NGINX as a reverse proxy with SSL certificates managed by Certbot.
- **Scalable Architecture:** Docker Compose orchestrates multiple services for easy scalability and management.
- **Persistent Storage:** MongoDB data is persisted using Docker volumes.
- **Automated Restarts:** Services are configured to always restart, ensuring high availability.
- **Monitoring & Health Checks:** Real-time system monitoring with dashboard, metrics collection, and configurable alerts. See [docs/MONITORING.md](docs/MONITORING.md) for full documentation.
  - `GET /health` — Simple health check for load balancers
  - `GET /health/detailed` — Detailed health with all metrics and alerts
  - `GET /monitoring` — Interactive monitoring dashboard
  - ECG signal quality tracking (packet loss, SNR estimation)
  - Configurable alert thresholds for connections, errors, memory, and ECG quality

## Prerequisites

- **Docker:** Ensure Docker is installed on your system. [Install Docker](https://docs.docker.com/get-docker/)
- **Docker Compose:** Typically included with Docker Desktop. Verify installation with:
  ```bash
  docker-compose --version
  ```
- **Node.js:** Required if you plan to develop or modify the server outside of Docker. [Install Node.js](https://nodejs.org/en/download/)

## Getting Started

### 1. Clone the Repository

Clone the repository to your local machine:

```bash
git clone https://github.com/jgrana2/hrzmed_wss.git
cd hrzmed_wss
```

### 2. Configure Environment Variables

Create a `.env` file in the root directory to define necessary environment variables. This file will be used by Docker Compose to configure the services.

```bash
# .env

# MongoDB Configuration
MONGO_INITDB_ROOT_USERNAME=your_mongo_root_username
MONGO_INITDB_ROOT_PASSWORD=your_mongo_root_password
DBNAME=your_database_name
MONGO_USER=your_mongo_username
MONGO_PASSWORD=your_mongo_password
MONGO_URI=mongodb://mongo:27017/${DBNAME}

# WebSocket Server Configuration
PORT=3000

# NGINX Configuration
DOMAIN=yourdomain.com
EMAIL=youremail@example.com
```

**Note:** Replace the placeholder values with your actual configuration details.

### 3. Docker Compose Setup

Ensure that the `docker-compose.yml` file is properly configured. The provided `docker-compose.yml` sets up the following services:

- **nginx:** Serves as a reverse proxy, handling HTTP/HTTPS requests and managing SSL certificates with Certbot.
- **websocket-server:** The Node.js WebSocket server.
- **mongo:** MongoDB database service.
- **certbot:** Manages SSL certificate issuance and renewal.

Here is the provided `docker-compose.yml` for reference:

```yaml
version: '3.8'

services:
  nginx:
    image: nginx:alpine
    container_name: nginx
    depends_on:
      - websocket-server
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/conf.d:/etc/nginx/conf.d
      - certbot-etc:/etc/letsencrypt
      - certbot-var:/var/lib/letsencrypt
      - certbot-www:/var/www/certbot
    restart: always

  websocket-server:
    build: .
    container_name: node-websocket
    depends_on:
      - mongo
    expose:
      - "3000"
    environment:
      MONGO_URI: ${MONGO_URI}
      PORT: ${PORT}
    restart: always

  mongo:
    image: mongo:8.0
    container_name: mongodb
    environment:
      MONGO_INITDB_ROOT_USERNAME: ${MONGO_INITDB_ROOT_USERNAME}
      MONGO_INITDB_ROOT_PASSWORD: ${MONGO_INITDB_ROOT_PASSWORD}
      DBNAME: ${DBNAME}
      MONGO_USER: ${MONGO_USER}
      MONGO_PASSWORD: ${MONGO_PASSWORD}
    volumes:
      - mongo-data:/data/db
      - ./mongo-init:/docker-entrypoint-initdb.d
    restart: always

  certbot:
    image: certbot/certbot:latest
    container_name: certbot
    volumes:
      - certbot-etc:/etc/letsencrypt
      - certbot-var:/var/lib/letsencrypt
      - certbot-www:/var/www/certbot

volumes:
  certbot-etc:
  certbot-var:
  certbot-www:
  mongo-data:
```

**Directory Structure:**

Ensure your project directory has the following structure:

```
hrzmed_wss/
├── docker-compose.yml
├── .env
├── nginx/
│   └── conf.d/
│       └── default.conf
├── mongo-init/
│   └── init-script.js
├── src/
│   └── index.js
├── package.json
└── ...
```

**NGINX Configuration (`nginx/conf.d/default.conf`):**

Configure NGINX to proxy WebSocket connections and handle SSL termination. Here's a basic example:

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://websocket-server:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

**Note:** Replace `yourdomain.com` with your actual domain name.

### 4. Build and Run the Services

Ensure Docker Compose is up-to-date and build the services:

```bash
docker-compose up -d --build
```

This command will:

- Build the `websocket-server` Docker image.
- Start all services (`nginx`, `websocket-server`, `mongo`, `certbot`) in detached mode.
- Automatically restart services if they crash or on system reboot.

### 5. Obtain SSL Certificates

Initially, Certbot needs to obtain SSL certificates. You can execute the Certbot command within the `certbot` service container:

```bash
docker-compose run --rm certbot certonly --webroot --webroot-path=/var/www/certbot -d yourdomain.com --email youremail@example.com --agree-tos --no-eff-email
```

**Note:** Replace `yourdomain.com` and `youremail@example.com` with your actual domain and email.

After obtaining the certificates, reload NGINX to apply them:

```bash
docker-compose exec nginx nginx -s reload
```

## Usage

Once all services are running, your WebSocket server is accessible via your domain with secure WebSocket (WSS) connections.

**Connecting to the WebSocket Server:**

Use a WebSocket client to connect to the server. Here's an example using the browser console:

```javascript
const socket = new WebSocket('wss://yourdomain.com');

socket.onopen = function(event) {
    console.log('Connected to WebSocket server.');
    socket.send('Hello Server!');
};

socket.onmessage = function(event) {
    console.log('Message from server:', event.data);
};

socket.onclose = function(event) {
    console.log('Disconnected from WebSocket server.');
};

socket.onerror = function(error) {
    console.error('WebSocket error:', error);
};
```

**Server Behavior:**

- **On Connection:** Logs a message indicating a new client has connected.
- **On Message:** Logs received messages and can respond accordingly.
- **On Disconnection:** Logs when a client disconnects.

## Logging

- **WebSocket Server Logs:** Accessible via Docker logs.
  ```bash
  docker-compose logs -f websocket-server
  ```

- **NGINX Logs:**
  ```bash
  docker-compose logs -f nginx
  ```

- **MongoDB Logs:**
  ```bash
  docker-compose logs -f mongodb
  ```

These logs provide real-time insights into the operations and can aid in debugging.

## License

This project is licensed under the [MIT License](LICENSE). See the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [ws](https://github.com/websockets/ws) - WebSocket library for Node.js
- [Mongoose](https://mongoosejs.com/) - MongoDB object modeling for Node.js
- [NGINX](https://nginx.org/) - High-performance HTTP server and reverse proxy
- [Certbot](https://certbot.eff.org/) - SSL certificate automation tool

## Troubleshooting

If you encounter issues, consider the following steps:

1. **Check Service Status:**
   ```bash
   docker-compose ps
   ```

2. **View Logs:**
   Inspect logs for specific services to identify errors.
   ```bash
   docker-compose logs -f <service-name>
   ```

3. **Verify Environment Variables:**
   Ensure all required environment variables are correctly set in the `.env` file.

4. **Network Configuration:**
   - Ensure that your domain's DNS records point to the server hosting the Docker containers.
   - Verify that ports `80` and `443` are open and not blocked by a firewall.

5. **SSL Certificate Issues:**
   - Ensure that Certbot has successfully obtained the certificates.
   - Check the NGINX configuration for correct paths to SSL certificates.

6. **MongoDB Connectivity:**
   - Ensure MongoDB is running and accessible by the `websocket-server`.
   - Verify MongoDB credentials and connection URI.

7. **Rebuild Services:**
   If changes are made to the Dockerfile or dependencies, rebuild the services.
   ```bash
   docker-compose up -d --build
   ```

8. **Renew SSL Certificates:**
   Certbot certificates are valid for 90 days. Set up a cron job or use Docker to automate renewal.

   Example renewal command:
   ```bash
   docker-compose run --rm certbot renew
   docker-compose exec nginx nginx -s reload
   ```

For further assistance, refer to the specific service documentation or open an issue in the repository.