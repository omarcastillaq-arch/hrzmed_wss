/**
 * @module swaggerRoutes
 * @description Serves OpenAPI/Swagger documentation as JSON and HTML UI.
 *
 * Routes:
 *   GET /api/docs          - Swagger UI HTML page
 *   GET /api/docs/openapi  - OpenAPI 3.0 JSON specification
 */

'use strict';

const openApiSpec = require('./openApiSpec');

// ─── Swagger UI HTML ─────────────────────────────────────────────────────────

function getSwaggerHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Horizon Medical API — Documentation</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
  <style>
    body { margin: 0; background: #fafafa; }
    .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/api/docs/openapi',
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
    });
  </script>
</body>
</html>`;
}

// ─── Route Handler ───────────────────────────────────────────────────────────

function handleSwaggerRoutes(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/api/docs/openapi' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(openApiSpec));
    return true;
  }

  if (path === '/api/docs' && req.method === 'GET') {
    const html = getSwaggerHTML();
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(html);
    return true;
  }

  return null; // not handled
}

module.exports = handleSwaggerRoutes;
