/**
 * VERCEL CATCH-ALL API ROUTE
 * Capture tous les endpoints /api/v1/* et délègue au serveur HTTP unifié
 */
const handleRequest = require('../src/server.js');

module.exports = (req, res) => {
  return handleRequest(req, res);
};
