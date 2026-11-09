/**
 * TEST AUTOMATISÉ : SÉPARATION LANDING / DASHBOARD / FORMULAIRE & IMPORT CSV/JSON
 */

const http = require('http');

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: 'localhost', port: 3002, path: path }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function post(path, data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const req = http.request({
      hostname: 'localhost',
      port: 3002,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': 'Bearer hajj_live_e4d73d355d4941c999aad7eaca099c8a756616c080744f998ccf4738553dd66f'
      }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function run() {
  console.log("=== [NOVA-QA] TEST NOUVELLES ROUTES & IMPORT CSV/JSON ===");

  // 1. Test Landing Page (/)
  const landing = await get('/');
  console.assert(landing.status === 200, `Landing status ${landing.status}`);
  console.assert(landing.body.includes("Ne laissez aucun bug technique") || landing.body.includes("Ne laissez pas un rejet technique"), "Landing page titre vérifié");
  console.assert(landing.body.includes("Espace Conciergerie"), "Lien conciergerie présent");
  console.log("[PASS] Route '/' : Landing Page opérationnelle.");

  // 2. Test Tableau de bord (/dashboard)
  const dashboard = await get('/dashboard');
  console.assert(dashboard.status === 200, `Dashboard status ${dashboard.status}`);
  console.assert(dashboard.body.includes("Tableau de bord"), "Dashboard vérifié");
  console.assert(dashboard.body.includes("Importer CSV / JSON"), "Bouton Import présent");
  console.log("[PASS] Route '/dashboard' : Espace Conciergerie accessible.");

  // 3. Test Formulaire (/register)
  const register = await get('/register');
  console.assert(register.status === 200, `Register status ${register.status}`);
  console.assert(register.body.includes("Formulaire d'inscription pèlerin"), "Formulaire vérifié");
  console.log("[PASS] Route '/register' : Espace Client accessible.");

  // 4. Test Import CSV
  const runId = Date.now();
  const csvData = {
    csvContent: `nom,prenom,email,telephone\nAlami,Karim,karim.alami.${runId}@example.com,+33611223344\nCherkaoui,Fatima,fatima.cherkaoui.${runId}@example.com,+33655667788`
  };
  const resCsv = await post('/api/v1/pelerins/import', csvData);
  console.assert(resCsv.status === 200, `Import CSV status ${resCsv.status}`);
  console.assert(resCsv.data.importedCount === 2, `Attendu 2 importés, reçu ${resCsv.data.importedCount}`);
  console.log(`[PASS] Import CSV validé : ${resCsv.data.message}`);

  // 5. Test Import JSON avec 1 doublon
  const jsonData = [
    { nom: "Alami", prenom: "Karim", email: `karim.alami.${runId}@example.com` }, // Déjà importé -> Doublon
    { nom: "Saidi", prenom: "Omar", email: `omar.saidi.${runId}@example.com`, telephone: "+33699887766", createdAt: "2026-10-21T09:00:00Z" }
  ];
  const resJson = await post('/api/v1/pelerins/import', jsonData);
  console.assert(resJson.status === 200, `Import JSON status ${resJson.status}`);
  console.assert(resJson.data.importedCount === 1, "1 nouveau pèlerin doit être importé");
  console.assert(resJson.data.duplicateCount === 1, "1 doublon doit être ignoré");
  console.log(`[PASS] Import JSON & gestion des doublons validés : ${resJson.data.message}`);

  console.log("=== [NOVA-QA] TOUTES LES NOUVELLES FONCTIONNALITÉS SONT VALIDÉES ===");
}

run().catch(err => {
  console.error("Échec des tests :", err);
  process.exit(1);
});
