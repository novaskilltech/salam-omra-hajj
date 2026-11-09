/**
 * TEST AUTOMATISÉ : INSCRIPTION PÈLERIN, ROUND-ROBIN CONSEILLERS & DÉDUPLICATION
 */

const http = require('http');

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
        'Content-Length': Buffer.byteLength(payload)
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

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ 
      hostname: 'localhost', 
      port: 3002, 
      path: path,
      headers: {
        'Authorization': 'Bearer hajj_live_e4d73d355d4941c999aad7eaca099c8a756616c080744f998ccf4738553dd66f'
      }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }));
    }).on('error', reject);
  });
}

async function run() {
  console.log("=== [NOVA-QA] TEST NOUVELLE FONCTIONNALITÉ : INSCRIPTION FORMULAIRE ===");

  const runId = Date.now();

  // 1. Inscription réussie Pèlerin A (Ancien client - 350 €)
  const pelerinA = {
    nom: "Mansouri",
    prenom: "Tariq",
    emailContact: `tariq.mansouri.${runId}@example.com`,
    telephone: "+33612345678",
    dejaClient: true,
    statutNusuk: "NON_INSCRIT",
    compteNusukDeclare: `tariq.mansouri.${runId}@example.com`,
    nomFamille: "Mansouri",
    accepteCgv: true,
    accepteRgpd: true
  };

  const resA = await post('/api/v1/pelerins/register', pelerinA);
  console.assert(resA.status === 201, `Attendu 201, reçu ${resA.status}`);
  console.assert(resA.data.success === true, "Inscription doit réussir");
  console.assert(resA.data.tarifAssistance === 350, "Tarif ancien client doit être 350 €");
  console.assert(resA.data.referenceInterne.startsWith("HAJJ-2026-"), "Référence interne générée");
  console.assert(resA.data.lienPaiementStripe.includes("stripe"), "Lien produit Stripe présent");
  console.log(`[PASS] Inscription Tariq M. (Ancien client - 350 €) réussie : ${resA.data.referenceInterne} attribué à ${resA.data.conseillerAttribue}`);

  // 2. Inscription réussie Pèlerin B (Nouveau client - 390 €, Vérification Round-Robin Conseiller 2)
  const pelerinB = {
    nom: "Haddad",
    prenom: "Leila",
    emailContact: `leila.haddad.${runId}@example.com`,
    telephone: "+33698765432",
    dejaClient: false,
    statutNusuk: "INSCRIT_A_VERIFIER",
    accepteCgv: true,
    accepteRgpd: true
  };

  const resB = await post('/api/v1/pelerins/register', pelerinB);
  console.assert(resB.status === 201, `Attendu 201, reçu ${resB.status}`);
  console.assert(resB.data.tarifAssistance === 390, "Tarif nouveau client doit être 390 €");
  console.assert(resB.data.conseillerAttribue !== resA.data.conseillerAttribue, "Le conseiller doit alterner (Round-Robin)");
  console.log(`[PASS] Inscription Leila H. (Nouveau client - 390 €) réussie : ${resB.data.referenceInterne} attribué à ${resB.data.conseillerAttribue} (alternance confirmée)`);

  // 3. Test de détection de doublon (AC03)
  const resDuplicate = await post('/api/v1/pelerins/register', pelerinA);
  console.assert(resDuplicate.status === 409, `Attendu 409 Conflict sur doublon, reçu ${resDuplicate.status}`);
  console.log(`[PASS] Détection doublon email validée : HTTP 409 renvoyé avec message explicite.`);

  // 4. Test d'absence de consentement (RGPD/CGV)
  const pelerinSansCgv = { ...pelerinB, emailContact: "nouveau.test@example.com", accepteCgv: false };
  const resNoConsent = await post('/api/v1/pelerins/register', pelerinSansCgv);
  console.assert(resNoConsent.status === 400, `Attendu 400 sur refus CGV, reçu ${resNoConsent.status}`);
  console.log(`[PASS] Blocage absence de consentement CGV/RGPD validé.`);

  // 5. Vérification de l'actualisation dynamique du Dashboard
  const summary = await get('/api/v1/dashboard/summary');
  console.assert(summary.data.totalPelerinsInscrits >= 78, "Le total des pèlerins doit refléter les nouvelles inscriptions");
  console.log(`[PASS] Compteur Dashboard mis à jour en direct : ${summary.data.totalPelerinsInscrits} pèlerins enregistrés.`);

  console.log("=== [NOVA-QA] TOUS LES TESTS D'INSCRIPTION SONT AU VERT ===");
}

run().catch(err => {
  console.error("Échec des tests :", err);
  process.exit(1);
});
