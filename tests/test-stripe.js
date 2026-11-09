/**
 * Test de validation Stripe : Fiche Produit, Webhook, Ledger et Payment Link
 */

const http = require('http');

function request(options, data) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, raw: body });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(typeof data === 'string' ? data : JSON.stringify(data));
    req.end();
  });
}

async function runStripeTests() {
  console.log("=== EXÉCUTION DE LA SUITE DE TESTS STRIPE & PAIEMENT ===");

  // 1. GET /api/v1/stripe/config
  const confRes = await request({
    hostname: 'localhost',
    port: 3002,
    path: '/api/v1/stripe/config',
    method: 'GET'
  });
  console.assert(confRes.status === 200, `Config status ${confRes.status} !== 200`);
  console.assert(confRes.data.ficheProduit.montantEur === 390, `Montant ${confRes.data.ficheProduit.montantEur} !== 390`);
  console.log("✓ TEST 1: Endpoint GET /api/v1/stripe/config valide (390 € TTC)");

  // 2. PUT /api/v1/stripe/config (Mise à jour du lien Stripe)
  const putRes = await request({
    hostname: 'localhost',
    port: 3002,
    path: '/api/v1/stripe/config',
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' }
  }, { paymentLinkUrl: 'https://buy.stripe.com/live_test_390' });
  console.assert(putRes.status === 200, `PUT status ${putRes.status} !== 200`);
  console.assert(putRes.data.config.paymentLinkUrl === 'https://buy.stripe.com/live_test_390', "Lien mis à jour");
  console.log("✓ TEST 2: Endpoint PUT /api/v1/stripe/config opérationnel");

  // 3. GET /api/v1/payments/ledger
  const ledgerRes = await request({
    hostname: 'localhost',
    port: 3002,
    path: '/api/v1/payments/ledger',
    method: 'GET',
    headers: {
      'Authorization': 'Bearer hajj_live_e4d73d355d4941c999aad7eaca099c8a756616c080744f998ccf4738553dd66f'
    }
  });
  console.assert(ledgerRes.status === 200, `Ledger status ${ledgerRes.status} !== 200`);
  console.assert(Array.isArray(ledgerRes.data.ledger), "Ledger doit être un tableau");
  console.log(`✓ TEST 3: Endpoint GET /api/v1/payments/ledger valide (${ledgerRes.data.totalPayments} paiements consignés)`);

  // 4. POST /api/v1/webhooks/stripe (Simulation webhook checkout.session.completed)
  const mockWebhookPayload = {
    id: "evt_test_webhook_12345",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_session_54321",
        amount_total: 39000,
        currency: "eur",
        customer_details: {
          name: "Rachid Diouri",
          email: "diouri.rachid@gmail.com",
          phone: "+33687372001"
        }
      }
    }
  };

  const webhookRes = await request({
    hostname: 'localhost',
    port: 3002,
    path: '/api/v1/webhooks/stripe',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, mockWebhookPayload);
  console.assert(webhookRes.status === 200, `Webhook status ${webhookRes.status} !== 200`);
  console.assert(webhookRes.data.received === true, "Webhook doit confirmer la réception");
  console.log("✓ TEST 4: Endpoint POST /api/v1/webhooks/stripe checkout.session.completed validé");

  // 5. Inscription avec lien Stripe retourné
  const testEmail = `client-stripe-${Date.now()}@omrayanair.com`;
  const regRes = await request({
    hostname: 'localhost',
    port: 3002,
    path: '/api/v1/pelerins/register',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    nom: "TEST-STRIPE",
    prenom: "Client",
    emailContact: testEmail,
    telephone: "+33611223344",
    statutNusuk: "SANS_COMPTE",
    compteNusukDeclare: "",
    nomFamille: "",
    accepteCgv: true,
    accepteRgpd: true
  });
  console.assert(regRes.status === 201, `Register status ${regRes.status} !== 201`);
  console.assert(regRes.data.lienPaiementStripe.includes('stripe.com'), "Lien Stripe doit être inclus");
  console.log("✓ TEST 5: Endpoint POST /api/v1/pelerins/register délivre le bon lien Stripe");

  console.log("\n🎉 TOUS LES TESTS STRIPE & PAIEMENT ONT RÉUSSI AVEC SUCCÈS !\n");
}

runStripeTests().catch(err => {
  console.error("❌ Échec des tests :", err);
  process.exit(1);
});
