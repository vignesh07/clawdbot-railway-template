#!/usr/bin/env node
// Health check script for Docker HEALTHCHECK
// Verifies that the wrapper server is responding on the health endpoint

const http = require('http');

const options = {
  hostname: 'localhost',
  port: 8080,
  path: '/setup/healthz',
  method: 'GET',
  timeout: 3000
};

const req = http.request(options, (res) => {
  if (res.statusCode === 200) {
    process.exit(0);
  } else {
    console.error(`Health check failed: HTTP ${res.statusCode}`);
    process.exit(1);
  }
});

req.on('error', (error) => {
  console.error(`Health check error: ${error.message}`);
  process.exit(1);
});

req.on('timeout', () => {
  console.error('Health check timeout');
  req.destroy();
  process.exit(1);
});

req.end();
