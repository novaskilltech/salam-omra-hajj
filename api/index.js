/**
 * VERCEL SERVERLESS FUNCTION HANDLER
 * Redirige toutes les requêtes /api vers le serveur backend centralisé.
 */
const handleRequest = require('../src/server.js');

module.exports = (req, res) => {
  if (req.url && req.url.includes('debug-env')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      url: req.url,
      matchedPath: req.headers['x-matched-path'],
      vercelMatchedPath: req.headers['x-vercel-matched-path'],
      forwardedUri: req.headers['x-forwarded-uri'],
      headers: req.headers
    }, null, 2));
    return;
  }
  return handleRequest(req, res);
};
