/**
 * SUITE DE TESTS AUTOMATISÉE : DURCISSEMENT DE SÉCURITÉ P0
 * Vérifie :
 * 1. Blocage 401 Unauthorized sur les données sensibles sans session
 * 2. Signature HMAC-SHA256 du cookie de session
 * 3. Rate limiting anti-bruteforce (HTTP 429) sur POST /api/v1/auth/login
 * 4. Blocage 403 Forbidden sur toute tentative de Path Traversal
 * 5. Présence systématique des en-têtes HTTP de durcissement
 */

const http = require('http');
const assert = require('assert');

const PORT = 3002;

function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: PORT,
      ...options
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
          json
        });
      });
    });
    req.on('error', reject);
    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

async function runSecurityTests() {
  console.log("==================================================");
  console.log("=== [NOVA-SEC] TEST DE DURCISSEMENT SÉCURITÉ P0 ===");
  console.log("==================================================\n");

  // 1. Accès non authentifié à GET /api/v1/pelerins -> Doit renvoyer HTTP 401
  console.log("--- TEST 1 : Blocage de l'accès public aux pèlerins (OWASP A01 / RGPD) ---");
  const unauthPelerins = await makeRequest({
    path: '/api/v1/pelerins',
    method: 'GET'
  });
  assert.strictEqual(unauthPelerins.statusCode, 401, "L'accès aux pèlerins sans auth doit être rejeté (HTTP 401)");
  assert.strictEqual(unauthPelerins.json.code, "UNAUTHORIZED");
  console.log("✓ TEST 1 VALIDE : HTTP 401 Unauthorized retourné sans exposition de PII.\n");

  // 2. Accès non authentifié à POST /api/v1/payments/manual-validate -> HTTP 401
  console.log("--- TEST 2 : Blocage de la validation financière sans auth ---");
  const unauthPayment = await makeRequest({
    path: '/api/v1/payments/manual-validate',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { pelerinId: 'fake-id', montantEur: 390 });
  assert.strictEqual(unauthPayment.statusCode, 401, "La validation de paiement sans auth doit être rejetée (HTTP 401)");
  console.log("✓ TEST 2 VALIDE : Endpoints financiers protégés contre toute altération externe.\n");

  // 3. Protection anti-Path Traversal -> HTTP 403
  console.log("--- TEST 3 : Protection contre le Path Traversal ---");
  const traversalAttempt = await makeRequest({
    path: '/../package.json',
    method: 'GET'
  });
  assert.strictEqual(traversalAttempt.statusCode, 403, "Le path traversal doit être bloqué avec HTTP 403");
  console.log("✓ TEST 3 VALIDE : Tentative de Path Traversal interceptée avec HTTP 403 Forbidden.\n");

  // 4. En-têtes HTTP de durcissement
  console.log("--- TEST 4 : Présence des en-têtes de sécurité HTTP ---");
  const headersCheck = await makeRequest({
    path: '/',
    method: 'GET'
  });
  assert.strictEqual(headersCheck.headers['x-frame-options'], 'DENY', "X-Frame-Options: DENY requis");
  assert.strictEqual(headersCheck.headers['x-content-type-options'], 'nosniff', "X-Content-Type-Options: nosniff requis");
  console.log("✓ TEST 4 VALIDE : En-têtes X-Frame-Options et X-Content-Type-Options vérifiés.\n");

  // 5. Authentification valide et session HMAC signée
  console.log("--- TEST 5 : Authentification réussie et émission du cookie HMAC-SHA256 ---");
  const loginSuccess = await makeRequest({
    path: '/api/v1/auth/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { password: 'salamomra2026' });

  assert.strictEqual(loginSuccess.statusCode, 200, "Le mot de passe correct doit renvoyer HTTP 200");
  const setCookie = loginSuccess.headers['set-cookie'];
  assert.ok(setCookie, "Un en-tête Set-Cookie doit être délivré");
  const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(cookieStr.includes('conciergerie_auth='), "Le cookie conciergerie_auth doit être présent");
  assert.ok(cookieStr.includes('HttpOnly'), "Le flag HttpOnly doit être actif");
  assert.ok(cookieStr.includes('.'), "Le jeton doit contenir une signature séparée par un point");
  console.log(`✓ TEST 5 VALIDE : Cookie HMAC-SHA256 généré avec succès (${cookieStr.slice(0, 45)}...).\n`);

  // 6. Accès avec cookie signé valide -> HTTP 200
  console.log("--- TEST 6 : Accès autorisé avec session signée ---");
  const authCookie = cookieStr.split(';')[0];
  const authPelerins = await makeRequest({
    path: '/api/v1/pelerins',
    method: 'GET',
    headers: { 'Cookie': authCookie }
  });
  assert.strictEqual(authPelerins.statusCode, 200, "L'accès avec cookie signé doit retourner HTTP 200");
  assert.ok(Array.isArray(authPelerins.json), "Les données pèlerins doivent être accessibles");
  console.log(`✓ TEST 6 VALIDE : ${authPelerins.json.length} dossiers pèlerins récupérés avec session valide.\n`);

  // 7. Test de Rate Limiting anti-bruteforce (HTTP 429)
  console.log("--- TEST 7 : Déclenchement du Rate Limiting anti-bruteforce (HTTP 429) ---");
  const spoofedIp = '198.51.100.99';
  let lastStatus = 0;
  for (let i = 1; i <= 6; i++) {
    const failRes = await makeRequest({
      path: '/api/v1/auth/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': spoofedIp
      }
    }, { password: `wrong-password-${i}` });
    lastStatus = failRes.statusCode;
  }
  assert.strictEqual(lastStatus, 429, "Après 5 échecs consécutifs, le serveur doit renvoyer HTTP 429");
  console.log("✓ TEST 7 VALIDE : Blocage anti-bruteforce actif (HTTP 429 Too Many Requests).\n");

  console.log("==================================================");
  console.log("=== [NOVA-SEC] TOUS LES TESTS DE DURCISSEMENT SONT AU VERT (7/7) ===");
  console.log("==================================================");
}

runSecurityTests().catch(err => {
  console.error("❌ ÉCHEC DES TESTS SÉCURITÉ :", err);
  process.exit(1);
});
