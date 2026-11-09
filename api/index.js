/**
 * VERCEL SERVERLESS FUNCTION HANDLER
 * Redirige toutes les requêtes /api vers le serveur backend centralisé.
 */
const handleRequest = require('../src/server.js');

module.exports = (req, res) => {
  return handleRequest(req, res);
};
