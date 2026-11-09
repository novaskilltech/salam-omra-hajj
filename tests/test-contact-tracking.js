/**
 * TEST AUTOMATISÉ : SUIVI ET TRAÇABILITÉ DES CONTACTS (WHATSAPP, EMAIL, APPELS)
 * Vérifie :
 * 1. Blocage 401 si non authentifié sur /api/v1/pelerins/:id/interactions
 * 2. Enregistrement d'un message WhatsApp sur le dossier pèlerin
 * 3. Enregistrement d'un Email de suivi sur le dossier pèlerin
 * 4. Ajout d'une note manuelle d'échange
 * 5. Présence et intégrité de l'historique et du dernier contact dans les données du pèlerin
 */

const http = require('http');
const assert = require('assert');

const PORT = 3002;
const ADMIN_KEY = 'hajj_live_e4d73d355d4941c999aad7eaca099c8a756616c080744f998ccf4738553dd66f';

function post(path, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const req = http.request({
      hostname: 'localhost',
      port: PORT,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers
      }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({ status: res.statusCode, data: json, raw: body });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({
      hostname: 'localhost',
      port: PORT,
      path: path,
      headers: headers
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({ status: res.statusCode, data: json });
      });
    }).on('error', reject);
  });
}

async function runTests() {
  console.log("==========================================================");
  console.log("=== [NOVA-QA] TEST SUIVI DES CONTACTS WHATSAPP & EMAIL ===");
  console.log("==========================================================\n");

  // Récupérer un pèlerin existant
  const pelerinsRes = await get('/api/v1/pelerins', {
    'Authorization': `Bearer ${ADMIN_KEY}`
  });
  assert.strictEqual(pelerinsRes.status, 200, "Doit pouvoir récupérer les pèlerins");
  const target = pelerinsRes.data[0];
  assert.ok(target, "Au moins un pèlerin doit être présent");
  console.log(`[INFO] Test sur le dossier : ${target.nomComplet || target.fullName} (ID: ${target.id})`);

  // 1. Test sécurité : sans auth -> 401
  console.log("\n--- TEST 1 : Sécurité du point de contact (HTTP 401 attendu) ---");
  const unauthRes = await post(`/api/v1/pelerins/${target.id}/interactions`, {
    canal: "WHATSAPP"
  });
  assert.strictEqual(unauthRes.status, 401, "L'accès sans auth doit être refusé");
  console.log("✓ TEST 1 VALIDE : Accès non authentifié bloqué avec succès.");

  // 2. Test traçage WhatsApp
  console.log("\n--- TEST 2 : Enregistrement d'un envoi WhatsApp ---");
  const waRes = await post(`/api/v1/pelerins/${target.id}/interactions`, {
    canal: "WHATSAPP",
    auteur: "Salah",
    note: "Message d'accompagnement envoyé via WhatsApp"
  }, {
    'Authorization': `Bearer ${ADMIN_KEY}`
  });
  assert.strictEqual(waRes.status, 201, "Doit renvoyer HTTP 201 Created");
  assert.strictEqual(waRes.data.success, true);
  assert.strictEqual(waRes.data.dernierContact.canal, "WHATSAPP");
  assert.strictEqual(waRes.data.dernierContact.auteur, "Salah");
  assert.ok(Array.isArray(waRes.data.historiqueContacts));
  console.log("✓ TEST 2 VALIDE : Message WhatsApp tracé avec succès sur le dossier.");

  // 3. Test traçage Email
  console.log("\n--- TEST 3 : Enregistrement d'un envoi d'Email ---");
  const emailRes = await post(`/api/v1/pelerins/${target.id}/interactions`, {
    canal: "EMAIL",
    auteur: "Salah",
    note: "Email récapitulatif du forfait 390 € envoyé"
  }, {
    'Authorization': `Bearer ${ADMIN_KEY}`
  });
  assert.strictEqual(emailRes.status, 201, "Doit renvoyer HTTP 201");
  assert.strictEqual(emailRes.data.dernierContact.canal, "EMAIL");
  console.log("✓ TEST 3 VALIDE : Envoi d'email tracé avec succès.");

  // 4. Test note manuelle d'échange
  console.log("\n--- TEST 4 : Ajout d'une note manuelle d'échange client ---");
  const noteRes = await post(`/api/v1/pelerins/${target.id}/interactions`, {
    canal: "NOTE",
    auteur: "Salah",
    note: "Appel téléphonique : le client valide son choix pour le forfait Assistance"
  }, {
    'Authorization': `Bearer ${ADMIN_KEY}`
  });
  assert.strictEqual(noteRes.status, 201, "Doit renvoyer HTTP 201");
  assert.strictEqual(noteRes.data.dernierContact.canal, "NOTE");
  console.log("✓ TEST 4 VALIDE : Note manuelle d'échange enregistrée.");

  // 5. Vérification de la persistance sur le dossier pèlerin
  console.log("\n--- TEST 5 : Vérification de la persistance dans le dossier complet ---");
  const checkRes = await get('/api/v1/pelerins', {
    'Authorization': `Bearer ${ADMIN_KEY}`
  });
  const updatedTarget = checkRes.data.find(p => p.id === target.id);
  assert.ok(updatedTarget.dernierContact, "Le champ dernierContact doit exister");
  assert.strictEqual(updatedTarget.dernierContact.canal, "NOTE");
  assert.ok(updatedTarget.historiqueContacts.length >= 3, "Au moins 3 interactions doivent être archivées");
  console.log(`✓ TEST 5 VALIDE : ${updatedTarget.historiqueContacts.length} échanges archivés et visibles sur le dossier.`);

  console.log("\n==========================================================");
  console.log("=== [NOVA-QA] TOUS LES TESTS DE SUIVI DE CONTACT SONT OK (5/5) ===");
  console.log("==========================================================");
}

runTests().catch(err => {
  console.error("❌ ÉCHEC DES TESTS :", err);
  process.exit(1);
});
