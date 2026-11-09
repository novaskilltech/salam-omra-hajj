/**
 * TEST AUTOMATISÉ : SYNCHRONISATION BIDIRECTIONNELLE MON OMRA (SSOT)
 * Vérifie :
 * 1. PATCH /api/v1/hajj/pilgrims/:id (mise à jour de statut, paiement, conseiller, nusuk)
 * 2. POST /api/v1/hajj/pilgrims (création directe depuis inscription)
 * 3. Gestion gracieuse des erreurs réseau / indisponibilité sans impact utilisateur
 */

const http = require('http');
const assert = require('assert');
const syncService = require('../src/sync-service');

const MOCK_PORT = 3198;
const MOCK_KEY = 'hajj_live_e4d73d355d4941c999aad7eaca099c8a756616c080744f998ccf4738553dd66f';

let receivedRequests = [];

// Serveur Mock simulant l'API Mon Omra avec les deux nouveaux endpoints d'écriture
const mockServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let parsedBody = null;
    try {
      if (body) parsedBody = JSON.parse(body);
    } catch (_) {}

    const record = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: parsedBody
    };
    receivedRequests.push(record);

    // Vérification authentification Bearer token ou X-API-Key
    const authHeader = req.headers['authorization'];
    const apiKeyHeader = req.headers['x-api-key'];
    if (authHeader !== `Bearer ${MOCK_KEY}` && apiKeyHeader !== MOCK_KEY) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "Non autorisé" }));
      return;
    }

    // 1. PATCH /api/v1/hajj/pilgrims/:id
    if ((req.method === 'PATCH' || req.method === 'PUT') && req.url.startsWith('/api/v1/hajj/pilgrims/')) {
      const id = decodeURIComponent(req.url.replace('/api/v1/hajj/pilgrims/', ''));
      if (id === 'non-existent-id') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Pèlerin non trouvé" }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: "Dossier pèlerin mis à jour avec succès",
        id: id,
        updatedFields: parsedBody,
        updatedAt: new Date().toISOString()
      }));
      return;
    }

    // 2. POST /api/v1/hajj/pilgrims
    if (req.method === 'POST' && req.url === '/api/v1/hajj/pilgrims') {
      const assignedId = `mon-omra-uuid-${Date.now()}`;
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        id: assignedId,
        createdAt: new Date().toISOString(),
        data: {
          id: assignedId,
          ...parsedBody
        }
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: "Route mock non trouvée" }));
  });
});

async function runTests() {
  console.log('=== DÉBUT DES TESTS SYNCHRONISATION BIDIRECTIONNELLE MON OMRA ===\n');

  await new Promise((resolve) => mockServer.listen(MOCK_PORT, resolve));
  console.log(`[TEST] Mock Mon Omra Server démarré sur http://localhost:${MOCK_PORT}`);

  const mockApiUrl = `http://localhost:${MOCK_PORT}/api/v1/hajj/pilgrims`;

  // --- TEST 1 : PATCH mise à jour statut et conseiller ---
  console.log('\n--- TEST 1 : PATCH mise à jour d\'un pèlerin existant ---');
  receivedRequests = [];

  const updateResult = await syncService.updatePilgrimOnMonOmra('uuid-pelerin-01', {
    statut: 'DOCUMENTS_VERIFIES',
    statutPaiement: 'PAYE',
    montantPaye: 390,
    datePaiement: '2026-10-31T01:00:00.000Z',
    conseiller: 'Farid Benali',
    nusukVerificationStatus: 'VERIFIE',
    hasNusukAccount: true,
    adminNotes: 'Documents conformes validés par Farid'
  }, {
    overrideUrl: mockApiUrl,
    overrideKey: MOCK_KEY
  });

  assert.strictEqual(updateResult.success, true, 'La mise à jour doit réussir');
  assert.strictEqual(updateResult.statusCode, 200, 'HTTP 200 attendu');
  assert.strictEqual(receivedRequests.length, 1, 'Une requête HTTP doit avoir été reçue');
  assert.strictEqual(receivedRequests[0].method, 'PATCH', 'Méthode PATCH attendue');
  assert.strictEqual(receivedRequests[0].url, '/api/v1/hajj/pilgrims/uuid-pelerin-01', 'URL correcte avec ID');
  assert.strictEqual(receivedRequests[0].body.status, 'DOCUMENTS_VERIFIES', 'Le statut doit être mappé');
  assert.strictEqual(receivedRequests[0].body.statutPaiement, 'PAYE', 'Paiement synchronisé');
  assert.strictEqual(receivedRequests[0].body.montantPaye, 390, 'Montant synchronisé');
  assert.strictEqual(receivedRequests[0].body.conseiller, 'Farid Benali', 'Conseiller synchronisé');
  assert.strictEqual(receivedRequests[0].body.hasNusukAccount, 'OUI', 'Nusuk OUI synchronisé');
  console.log('✓ TEST 1 VALIDE : PATCH /api/v1/hajj/pilgrims/:id conforme.');

  // --- TEST 2 : POST création directe d\'un pèlerin ---
  console.log('\n--- TEST 2 : POST création d\'un pèlerin depuis inscription ---');
  receivedRequests = [];

  const createResult = await syncService.createPilgrimOnMonOmra({
    firstName: 'Ibrahim',
    familyName: 'Traore',
    email: 'ibrahim.traore@example.com',
    phone: '+33612345678',
    peopleCount: 2,
    hajjYear: 2027,
    hasNusukAccount: true,
    nusukAccountStatus: 'NON_VERIFIE',
    adminNotes: 'Inscription directe en ligne'
  }, {
    overrideUrl: mockApiUrl,
    overrideKey: MOCK_KEY
  });

  assert.strictEqual(createResult.success, true, 'La création doit réussir');
  assert.strictEqual(createResult.statusCode, 201, 'HTTP 201 attendu');
  assert.ok(createResult.id, 'Un ID remote doit être renvoyé');
  assert.strictEqual(receivedRequests.length, 1, 'Une requête reçue');
  assert.strictEqual(receivedRequests[0].method, 'POST', 'Méthode POST attendue');
  assert.strictEqual(receivedRequests[0].url, '/api/v1/hajj/pilgrims', 'URL correcte');
  assert.strictEqual(receivedRequests[0].body.firstName, 'Ibrahim', 'Prénom correct');
  assert.strictEqual(receivedRequests[0].body.familyName, 'Traore', 'Nom correct');
  assert.strictEqual(receivedRequests[0].body.fullName, 'Ibrahim Traore', 'Nom complet généré');
  assert.strictEqual(receivedRequests[0].body.email, 'ibrahim.traore@example.com', 'Email normalisé');
  assert.strictEqual(receivedRequests[0].body.peopleCount, 2, 'Nombre de personnes');
  console.log(`✓ TEST 2 VALIDE : POST /api/v1/hajj/pilgrims conforme (ID retourné: ${createResult.id}).`);

  // --- TEST 3 : Gestion du 404 sans crash ---
  console.log('\n--- TEST 3 : Gestion propre d\'un dossier non trouvé (404) ---');
  const notFoundResult = await syncService.updatePilgrimOnMonOmra('non-existent-id', {
    status: 'CREE'
  }, {
    overrideUrl: mockApiUrl,
    overrideKey: MOCK_KEY
  });

  assert.strictEqual(notFoundResult.success, false, 'Doit retourner success: false');
  assert.strictEqual(notFoundResult.statusCode, 404, 'Code 404 préservé');
  console.log('✓ TEST 3 VALIDE : Code 404 intercepté gracieusement sans exception fatale.');

  // --- TEST 4 : Résilience en cas de coupure réseau / timeout ---
  console.log('\n--- TEST 4 : Résilience réseau (serveur distant inaccessible) ---');
  const unreachableResult = await syncService.updatePilgrimOnMonOmra('uuid-pelerin-01', {
    status: 'CREE'
  }, {
    overrideUrl: 'http://127.0.0.1:39999/api/v1/hajj/pilgrims', // port fermé
    overrideKey: MOCK_KEY
  });

  assert.strictEqual(unreachableResult.success, false, 'Doit échouer en douceur');
  assert.ok(unreachableResult.error, 'Un message d\'erreur explicatif doit être fourni');
  console.log(`✓ TEST 4 VALIDE : Coupure réseau gérée avec succès (${unreachableResult.error}).`);

  await new Promise((resolve) => mockServer.close(resolve));
  console.log('\n=== TOUS LES TESTS SYNCHRONISATION BIDIRECTIONNELLE SONT VALIDES (4/4) ===');
}

runTests().catch(err => {
  console.error('\n❌ ÉCHEC DU TEST SYNCHRONISATION BIDIRECTIONNELLE:', err);
  process.exit(1);
});
