/**
 * TEST AUTOMATISÉ : Synchronisation différentielle Mon Omra -> Omrayanair Hajj
 */

const http = require('http');
const assert = require('assert');
const syncService = require('../src/sync-service');

const MOCK_PORT = 3099;
const MOCK_KEY = 'hajj_live_test_key_1234567890abcdef12345678';

let lastRequestedUrl = '';
let lastAuthHeader = '';

// Serveur HTTP Mock simulant l'API Mon Omra
const mockServer = http.createServer((req, res) => {
  lastRequestedUrl = req.url;
  lastAuthHeader = req.headers['authorization'];

  if (lastAuthHeader !== `Bearer ${MOCK_KEY}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: "Non autorisé" }));
    return;
  }

  // Renvoie un mock conforme au contrat de données
  const mockPayload = {
    success: true,
    count: 2,
    limit: 100,
    syncedAt: "2026-10-30T19:00:00.000Z",
    filters: {
      since: req.url.includes('since=') ? req.url.split('since=')[1].split('&')[0] : null
    },
    data: [
      {
        id: "mock-uuid-pelerin-01",
        fullName: "Karim Zenati",
        firstName: "Karim",
        familyName: "Zenati",
        nationality: "Française",
        phone: "+33611223344",
        email: "karim.zenati@test-sync.com",
        address: "15 rue Victor Hugo, 69002 Lyon",
        peopleCount: 2,
        hajjYear: 2027,
        partnerAgency: "Al Bait Guests",
        hasNusukAccount: "OUI",
        nusukAccountYear: "2026_2027",
        nusukAccountStatus: "VERIFIE",
        availabilitySlots: "Matinée (9h-12h)",
        status: "PENDING",
        dateEmission: "2026-10-30T18:30:00.000Z"
      },
      {
        id: "mock-uuid-pelerin-02",
        fullName: "Samira Mansouri",
        firstName: "Samira",
        familyName: "Mansouri",
        nationality: "Française",
        phone: "+33655667788",
        email: "samira.mansouri@test-sync.com",
        address: "4 bd Haussmann, 75009 Paris",
        peopleCount: 1,
        hajjYear: 2027,
        partnerAgency: "Yusr Al Mashaer",
        hasNusukAccount: "NON",
        nusukAccountStatus: "NON_VERIFIE",
        availabilitySlots: "Soirée (18h-21h)",
        status: "PENDING",
        dateEmission: "2026-10-30T18:40:00.000Z"
      }
    ]
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(mockPayload));
});

async function runTests() {
  console.log('=== DÉBUT DES TESTS SYNCHRONISATION MON OMRA ===\n');

  await new Promise((resolve) => mockServer.listen(MOCK_PORT, resolve));
  console.log(`[TEST] Mock API Server démarré sur http://localhost:${MOCK_PORT}`);

  const mockApiUrl = `http://localhost:${MOCK_PORT}/api/v1/hajj/pilgrims`;

  // TEST 1 : Import initial (2 nouveaux pèlerins)
  console.log('\n--- TEST 1 : Import initial de 2 dossiers ---');
  let testPelerins = [];
  let saveCount = 0;
  const mockSave = () => { saveCount++; };
  const mockAdvisor = () => 'Salah Lamkhannet';

  const res1 = await syncService.executeSync(testPelerins, mockSave, mockAdvisor, {
    overrideUrl: mockApiUrl,
    overrideKey: MOCK_KEY,
    forceAll: true
  });

  assert.strictEqual(res1.success, true, 'La synchronisation doit réussir');
  assert.strictEqual(res1.importedCount, 2, '2 dossiers doivent être importés');
  assert.strictEqual(res1.updatedCount, 0, '0 mise à jour sur import initial');
  assert.strictEqual(testPelerins.length, 2, 'testPelerins doit contenir 2 dossiers');
  assert.strictEqual(saveCount, 1, 'savePelerins doit avoir été appelé');
  console.log('✓ TEST 1 VALIDE : 2 dossiers importés avec succès.');

  // TEST 2 : Idempotence & Anti-doublons (ré-exécution identique)
  console.log('\n--- TEST 2 : Idempotence (anti-doublons) ---');
  const res2 = await syncService.executeSync(testPelerins, mockSave, mockAdvisor, {
    overrideUrl: mockApiUrl,
    overrideKey: MOCK_KEY
  });

  assert.strictEqual(res2.success, true, 'La synchronisation doit réussir');
  assert.strictEqual(res2.importedCount, 0, '0 nouveau dossier car déjà présents (pas de doublon)');
  assert.strictEqual(res2.updatedCount, 2, 'Les 2 dossiers existants ont été mis à jour');
  assert.strictEqual(testPelerins.length, 2, 'La taille du tableau reste strictement égale à 2');
  console.log('✓ TEST 2 VALIDE : Idempotence respectée, aucun doublon créé.');

  // TEST 3 : Transmission du paramètre ?since=
  console.log('\n--- TEST 3 : Vérification du paramètre différentiel ?since= ---');
  assert(lastRequestedUrl.includes('since='), `L'URL requêtée doit contenir le paramètre since: ${lastRequestedUrl}`);
  console.log(`✓ TEST 3 VALIDE : Paramètre différentiel détecté (${lastRequestedUrl}).`);

  // TEST 4 : Rejet en cas de mauvaise clé API
  console.log('\n--- TEST 4 : Sécurité & Clé API invalide ---');
  const res4 = await syncService.executeSync(testPelerins, mockSave, mockAdvisor, {
    overrideUrl: mockApiUrl,
    overrideKey: 'cle_invalide_xyz',
    forceAll: true
  });

  assert.strictEqual(res4.success, false, 'Doit échouer avec une mauvaise clé');
  assert(res4.error.includes('Authentification refusée'), 'Message d\'erreur explicite');
  console.log('✓ TEST 4 VALIDE : Clé invalide rejetée avec code 401.');

  mockServer.close();
  console.log('\n=== TOUS LES TESTS SYNCHRONISATION SONT VALIDES (4/4) ===');
}

runTests().catch(err => {
  console.error('[TEST ERROR]', err);
  if (mockServer.listening) mockServer.close();
  process.exit(1);
});
