/**
 * SERVEUR BACKEND & API REST - CENTRE DE SUIVI HAJJ NUSUK
 * Conforme OpenAPI 3.0 (api/contracts/openapi.json)
 * Zéro-OTP strict & Traitement idempotent
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const syncService = require('./sync-service.js');

const PORT = process.env.PORT || 3002;

// Chemins des données
const realDataPath = path.join(__dirname, '..', 'data', 'pelerins-hajj.json');
const syntheticDataPath = path.join(__dirname, '..', 'tests', 'fixtures', 'synthetic_pelerins.json');
const emailsCorpusPath = path.join(__dirname, '..', 'tests', 'fixtures', 'corpus_emails_nusuk.json');
const appointmentsPath = path.join(__dirname, '..', 'data', 'appointments.json');
const stripeConfigPath = path.join(__dirname, '..', 'data', 'stripe-config.json');
const paymentsLedgerPath = path.join(__dirname, '..', 'data', 'payments-ledger.json');

// Mot de passe et secrets de la agence
const CONCIERGERIE_PASSWORD = process.env.CONCIERGERIE_PASSWORD || 'salamomra2026';
const SESSION_SECRET = process.env.SESSION_SECRET || 'salam-omra-hajj-secure-session-salt-2026';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || process.env.MON_OMRA_HAJJ_API_KEY || 'hajj_live_e4d73d355d4941c999aad7eaca099c8a756616c080744f998ccf4738553dd66f';

// Génère un jeton de session cryptographique signé par HMAC-SHA256
function signSessionToken(payload) {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${signature}`;
}

// Vérifie et décode un jeton de session signé
function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, signature] = parts;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  if (signature.length !== expectedSig.length) return null;
  const match = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig));
  if (!match) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

// Extrait la session authentifiée depuis l'en-tête Authorization ou le Cookie
function getAuthenticatedSession(req) {
  // 1. Bearer Token ou Header X-API-Key
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token === ADMIN_API_KEY) {
      return { role: 'API_ADMIN', sub: 'api_key' };
    }
    const session = verifySessionToken(token);
    if (session) return session;
  }
  const xApiKey = req.headers['x-api-key'];
  if (xApiKey && xApiKey === ADMIN_API_KEY) {
    return { role: 'API_ADMIN', sub: 'api_key' };
  }

  // 2. Cookie agence_auth
  const cookieHeader = req.headers['cookie'] || '';
  const match = cookieHeader.match(/agence_auth=([^;]+)/);
  if (match) {
    const session = verifySessionToken(match[1]);
    if (session) return session;
  }
  return null;
}

// Protection anti-bruteforce en mémoire vive (max 5 échecs par tranche de 15 minutes par IP)
const loginFailureTracker = new Map();

function isLoginRateLimited(ip) {
  const record = loginFailureTracker.get(ip);
  if (!record) return false;
  if (Date.now() > record.resetTime) {
    loginFailureTracker.delete(ip);
    return false;
  }
  return record.attempts >= 5;
}

function registerLoginFailure(ip) {
  const now = Date.now();
  const record = loginFailureTracker.get(ip) || { attempts: 0, resetTime: now + 15 * 60 * 1000 };
  record.attempts++;
  loginFailureTracker.set(ip, record);
}

function clearLoginFailures(ip) {
  loginFailureTracker.delete(ip);
}

let pelerinsData = [];
let appointmentsData = [];
let stripeConfig = {
  productName: "Assistance & Agence Hajj Nusuk 2026",
  unitAmountEur: 390.0,
  currency: "EUR",
  billingType: "one_time",
  statementDescriptor: "FAREM SALAM OMRA",
  paymentLinkUrl: "",
  description: "Accompagnement administratif & technique pour l'inscription Nusuk Hajj 2026 : audit passeports, préparation wallet, conseil forfaits et veille live.",
  isLive: false
};
let paymentsLedgerData = [];

function loadStripeConfig() {
  try {
    if (fs.existsSync(stripeConfigPath)) {
      stripeConfig = JSON.parse(fs.readFileSync(stripeConfigPath, 'utf8'));
    }
  } catch (e) {
    console.error("Erreur chargement stripeConfig :", e);
  }
}

function saveStripeConfig() {
  try {
    fs.writeFileSync(stripeConfigPath, JSON.stringify(stripeConfig, null, 2), 'utf8');
  } catch (e) {
    console.error("Erreur sauvegarde stripeConfig :", e);
  }
}

function loadPaymentsLedger() {
  try {
    if (fs.existsSync(paymentsLedgerPath)) {
      paymentsLedgerData = JSON.parse(fs.readFileSync(paymentsLedgerPath, 'utf8'));
    }
  } catch (e) {
    console.error("Erreur chargement paymentsLedger :", e);
  }
}

function savePaymentsLedger() {
  try {
    fs.writeFileSync(paymentsLedgerPath, JSON.stringify(paymentsLedgerData, null, 2), 'utf8');
  } catch (e) {
    console.error("Erreur sauvegarde paymentsLedger :", e);
  }
}

function loadAppointments() {
  try {
    if (fs.existsSync(appointmentsPath)) {
      appointmentsData = JSON.parse(fs.readFileSync(appointmentsPath, 'utf8'));
    } else {
      // Données de départ par défaut
      appointmentsData = [
        {
          id: "rdv-01",
          pelerinId: "2e9066e9-8cf6-49f4-8eb8-f489953e1dce",
          pelerinNom: "Rachid Diouri",
          phone: "+33669719933",
          dateHeure: "2026-10-31T18:30",
          sujet: "Point sur la création du compte Nusuk & audit passeport",
          conseiller: "Conseiller 1",
          statut: "PLANIFIE"
        },
        {
          id: "rdv-02",
          pelerinId: "913e8fa9-f2ca-48ff-a36d-5f2823b43c99",
          pelerinNom: "MOHAMMED EL AISATI",
          phone: "+33669719933",
          dateHeure: "2026-11-01T19:00",
          sujet: "Validation du dossier famille (5 personnes) & choix des packs",
          conseiller: "Conseiller 1",
          statut: "PLANIFIE"
        }
      ];
      fs.writeFileSync(appointmentsPath, JSON.stringify(appointmentsData, null, 2), 'utf8');
    }
  } catch (e) {
    console.error("Erreur chargement rendez-vous :", e);
    appointmentsData = [];
  }
}

function saveAppointments() {
  try {
    fs.writeFileSync(appointmentsPath, JSON.stringify(appointmentsData, null, 2), 'utf8');
  } catch (e) {
    console.error("Erreur sauvegarde rendez-vous :", e);
  }
}

loadAppointments();
loadStripeConfig();
loadPaymentsLedger();

// Fonction de normalisation des pèlerins pour unifier les formats
function normalizePelerin(raw, index) {
  const id = raw.id || `pelerin-${index + 1}`;
  const firstName = raw.firstName || (raw.nomComplet ? raw.nomComplet.split(' ')[0] : 'Pèlerin');
  const familyName = raw.familyName || (raw.nomComplet ? raw.nomComplet.split(' ').slice(1).join(' ') : `${index + 1}`);
  const fullName = raw.fullName || `${firstName} ${familyName}`;
  const peopleCount = parseInt(raw.peopleCount, 10) || 1;
  const nationality = raw.nationality || 'Française';
  const phone = raw.phone || raw.telephone || '+33600000000';
  const email = (raw.email || raw.emailContact || '').trim().toLowerCase();
  const address = raw.address || 'Non renseignée';
  const provider = raw.provider || 'Yusr Al Mashaer';
  const hajjYear = raw.hajjYear || 2027;
  const availabilitySlots = raw.availabilitySlots || 'Soirée (18h - 21h)';
  const adminNotes = raw.adminNotes || `[Provider: ${provider}]`;
  const referenceInterne = raw.referenceInterne || `HAJJ-2026-${String(index + 1).padStart(3, '0')}`;

  const hasNusukAccount = raw.nusuk ? (raw.nusuk.hasAccount === true || raw.nusuk.rawHasAccount === 'OUI') : (raw.statut !== 'CREE');
  const verificationStatus = raw.nusuk ? raw.nusuk.verificationStatus : (raw.statut === 'PACKS_VALIDES' || raw.statut === 'PRET_POUR_VENTE' ? 'VERIFIE' : 'NON_VERIFIE');

  let etape = "Inscription";
  let statut = "CREE";
  let actionAttendue = "Créer le compte Nusuk";
  let severiteAction = "URGENTE";
  let urgent = true;
  let bloque = false;

  if (verificationStatus === 'VERIFIE') {
    etape = "Packs";
    statut = "PACKS_VALIDES";
    actionAttendue = "Valider les 3 choix";
    severiteAction = "NORMALE";
    urgent = false;
  } else if (hasNusukAccount) {
    etape = "Documents";
    statut = "EN_ATTENTE_DOCUMENTS";
    actionAttendue = "Vérifier les pièces d'identité";
    severiteAction = "URGENTE";
    urgent = true;
  } else {
    etape = "Inscription";
    statut = "CREE";
    actionAttendue = "Créer le compte Nusuk";
    severiteAction = "URGENTE";
    urgent = true;
  }

  const conseiller = raw.conseiller || (index % 2 === 0 ? "Conseiller 1" : "Conseiller 2");

  const rawDate = raw.createdAt || raw.created_at || raw.creeLe || raw.dateInscription || raw.date_inscription || raw.dateFormulaire || raw.dateEcriture || raw.date || raw.submissionDate || raw.timestamp || raw.horodatage || raw.submittedAt;
  let dateIso = new Date().toISOString();
  if (rawDate) {
    const parsed = new Date(rawDate);
    if (!isNaN(parsed.getTime())) {
      dateIso = parsed.toISOString();
    }
  }

  return {
    ...raw,
    id,
    referenceInterne,
    firstName,
    familyName,
    fullName,
    nomComplet: fullName,
    peopleCount,
    nationality,
    phone,
    telephone: phone,
    email,
    emailContact: email,
    address,
    provider,
    hajjYear,
    availabilitySlots,
    adminNotes,
    nusuk: {
      hasAccount: hasNusukAccount,
      rawHasAccount: hasNusukAccount ? 'OUI' : 'NON',
      accountYear: raw.nusuk?.accountYear || (hasNusukAccount ? "2026_2027" : "NON_APPLICABLE"),
      verificationStatus: verificationStatus
    },
    etape,
    statut,
    statutProvenance: raw.statutProvenance || "DECLARE_PAR_CLIENT",
    actionAttendue,
    severiteAction,
    conseiller,
    conseillerNom: conseiller,
    statutPaiement: raw.statutPaiement || (statut === 'PACKS_VALIDES' || statut === 'PRET_POUR_VENTE' ? 'PAYE' : 'EN_ATTENTE'),
    montantPaye: raw.montantPaye || (raw.statutPaiement === 'PAYE' || statut === 'PACKS_VALIDES' ? 390 : 0),
    datePaiement: raw.datePaiement || (raw.statutPaiement === 'PAYE' ? '2026-10-30T10:00:00Z' : null),
    tarifType: raw.tarifType || (raw.dejaClient || raw.ancienClient ? "ANCIEN_CLIENT" : "STANDARD"),
    tarifMontantEur: raw.tarifMontantEur || (raw.dejaClient || raw.ancienClient || raw.tarifType === 'ANCIEN_CLIENT' ? 350 : 390),
    urgent,
    bloque,
    creeLe: raw.creeLe || dateIso,
    createdAt: raw.createdAt || dateIso
  };
}

// Chargement initial des données
function loadPelerins() {
  try {
    if (fs.existsSync(realDataPath)) {
      console.log(`[NOVA-SQUAD] Chargement des données réelles depuis ${realDataPath}`);
      const raw = JSON.parse(fs.readFileSync(realDataPath, 'utf8'));
      pelerinsData = raw.map(normalizePelerin);
    } else if (fs.existsSync(syntheticDataPath)) {
      console.log(`[NOVA-SQUAD] Chargement des données de secours depuis ${syntheticDataPath}`);
      const raw = JSON.parse(fs.readFileSync(syntheticDataPath, 'utf8'));
      pelerinsData = raw.map(normalizePelerin);
    }
    console.log(`[NOVA-SQUAD] ${pelerinsData.length} dossiers pèlerins chargés avec succès.`);
  } catch (err) {
    console.error("[NOVA-SQUAD] Erreur lors du chargement des données pèlerins :", err);
    pelerinsData = [];
  }
}

// Sauvegarde persistante des pèlerins
function savePelerins() {
  try {
    fs.writeFileSync(realDataPath, JSON.stringify(pelerinsData, null, 2), 'utf8');
    console.log(`[NOVA-SQUAD] Sauvegarde effectuée dans ${realDataPath} (${pelerinsData.length} dossiers).`);
  } catch (err) {
    console.error("[NOVA-SQUAD] Erreur lors de la sauvegarde :", err);
  }
}

loadPelerins();

let eventsCorpus = [];
try {
  eventsCorpus = JSON.parse(fs.readFileSync(emailsCorpusPath, 'utf8'));
} catch (e) {
  console.error("Erreur de chargement du corpus:", e);
}

// Table de verrouillage des tâches en mémoire (AC16 / RB09)
const taskLocks = new Map();

// Mémoire des messages dédupliqués (AC02)
const processedMessageIds = new Set();

// Gestion de l'équipe de agence (persistance dans data/team-members.json)
const teamMembersPath = path.join(__dirname, '..', 'data', 'team-members.json');
let teamMembers = [];

function loadTeamMembers() {
  try {
    if (fs.existsSync(teamMembersPath)) {
      teamMembers = JSON.parse(fs.readFileSync(teamMembersPath, 'utf8'));
    } else {
      teamMembers = [
        {
          id: "team-1",
          identifiant: "Conseiller 1",
          nom: "Salah Lamkhannet",
          prenom: "Salah",
          role: "Responsable Agence & Accompagnement Hajj",
          email: "faremvoyage@outlook.fr",
          telephone: "+33612345678",
          statut: "DISPONIBLE",
          boiteSync: "Gmail API (Pub/Sub)",
          creeLe: "2026-10-28T09:00:00.000Z"
        },
        {
          id: "team-2",
          identifiant: "Conseiller 2",
          nom: "Youssef Amrani",
          prenom: "Youssef",
          role: "Assistance Technique & Ventes",
          email: "faremvoyage@outlook.fr",
          telephone: "+33687654321",
          statut: "DISPONIBLE",
          boiteSync: "Microsoft Graph Outlook",
          creeLe: "2026-10-28T09:00:00.000Z"
        }
      ];
      saveTeamMembers();
    }
  } catch (err) {
    console.error("[NOVA-SQUAD] Erreur chargement équipe :", err);
    teamMembers = [];
  }
}

function saveTeamMembers() {
  try {
    fs.writeFileSync(teamMembersPath, JSON.stringify(teamMembers, null, 2), 'utf8');
  } catch (err) {
    console.error("[NOVA-SQUAD] Erreur sauvegarde équipe :", err);
  }
}

loadTeamMembers();

function getAvailableAdvisorList() {
  const active = teamMembers.filter(m => m.statut !== 'INACTIF' && m.statut !== 'EN_CONGE');
  if (active.length > 0) {
    return active.map(m => m.identifiant || m.nom);
  }
  return ["Conseiller 1", "Conseiller 2"];
}

// Compteur pour attribution des conseillers à la ronde (Round-Robin dynamique)
let nextAdvisorIndex = 0;

function getNextAdvisor() {
  const availableAdvisors = getAvailableAdvisorList();
  const assigned = availableAdvisors[nextAdvisorIndex % availableAdvisors.length];
  nextAdvisorIndex++;
  return assigned;
}
const STRIPE_PRODUCT_PAYMENT_URL = "";

// Événements récents en direct
let recentEvents = [
  {
    id: "evt-01",
    titre: "Crédit wallet détecté",
    description: "Montant à contrôler",
    horodatageRelatif: "Aujourd'hui 10:24",
    actionRequisePar: "CONSEILLER"
  },
  {
    id: "evt-02",
    titre: "Documents demandés",
    description: "Dossier à compléter",
    horodatageRelatif: "Aujourd'hui 09:17",
    actionRequisePar: "CONSEILLER"
  },
  {
    id: "evt-03",
    titre: "Annonce de packs reçue",
    description: "À vérifier par le coordinateur",
    horodatageRelatif: "Hier 18:46",
    actionRequisePar: "COORDINATEUR"
  },
  {
    id: "evt-04",
    titre: "Code de connexion reçu",
    description: "Action réservée au pèlerin",
    horodatageRelatif: "Hier 14:12",
    actionRequisePar: "PELERIN"
  }
];

// Sanitizer anti-OTP synchrone (AC05, AC06, AC07)
function sanitizeEmail(sender, rawBody) {
  const allowedDomains = ['nusuk.sa'];
  const domain = (sender.split('@')[1] || '').toLowerCase();
  
  if (!allowedDomains.includes(domain)) {
    return {
      allowed: false,
      quarantine: true,
      cleanSnippet: ''
    };
  }

  // Purge stricte des OTP (4 à 8 chiffres) et tokens d'authentification
  let clean = rawBody.replace(/\b[0-9]{4,8}\b/g, '[SECRET_EXPURGE]');
  clean = clean.replace(/(https?:\/\/[^\s]+(token|reset|auth|magic|verify)[^\s]*)/gi, '[LIEN_EXPURGE]');

  return {
    allowed: true,
    quarantine: false,
    cleanSnippet: clean.slice(0, 300)
  };
}

function handleRequest(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // Headers de durcissement HTTP et CORS sécurisé
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  const origin = req.headers.origin;
  const allowedOrigins = ['https://salam-omra-hajj.vercel.app', 'https://hajj-suivi-nusuk.vercel.app', 'http://localhost:3002', 'http://localhost:3000'];
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else if (!origin) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- ROUTES API REST ---
  // Authentification de la agence avec protection anti-bruteforce et jeton HMAC
  if (pathname === '/api/v1/auth/login' && method === 'POST') {
    const clientIp = (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : (req.socket && req.socket.remoteAddress)) || '127.0.0.1';

    if (isLoginRateLimited(clientIp)) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ 
        error: "Trop de tentatives de connexion échouées. Compte temporairement verrouillé pour 15 minutes.",
        code: "RATE_LIMITED"
      }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { password } = payload;

        if (password === CONCIERGERIE_PASSWORD) {
          clearLoginFailures(clientIp);

          // Génération du jeton cryptographique HMAC-SHA256
          const sessionToken = signSessionToken({
            role: 'CONCIERGE_ADMIN',
            sub: 'agence',
            iat: Date.now(),
            exp: Date.now() + 86400 * 1000 // 24h
          });

          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Set-Cookie': `agence_auth=${sessionToken}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`
          });
          res.end(JSON.stringify({ success: true, message: "Authentification réussie." }));
        } else {
          registerLoginFailure(clientIp);
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: "Mot de passe de la agence incorrect." }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: "Requête invalide." }));
      }
    });
    return;
  }

  // Vérification de session signée
  if (pathname === '/api/v1/auth/check' && method === 'GET') {
    const session = getAuthenticatedSession(req);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ 
      authenticated: !!session,
      role: session ? session.role : null 
    }));
    return;
  }

  // Déconnexion
  if (pathname === '/api/v1/auth/logout' && method === 'POST') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': 'agence_auth=; Path=/; HttpOnly; Max-Age=0'
    });
    res.end(JSON.stringify({ success: true, message: "Déconnecté." }));
    return;
  }

  // --- CONTRÔLE D'ACCÈS RBAC (OWASP A01 / RGPD Art. 32) ---
  // Protection systématique des routes d'administration et d'accès aux dossiers
  const isProtectedRoute = (
    pathname === '/api/v1/pelerins' ||
    (pathname.startsWith('/api/v1/pelerins/') && pathname !== '/api/v1/pelerins/register') ||
    pathname === '/api/v1/payments/ledger' ||
    pathname === '/api/v1/payments/manual-validate' ||
    pathname === '/api/v1/team' ||
    pathname.startsWith('/api/v1/team/') ||
    pathname === '/api/v1/dashboard/summary' ||
    pathname === '/api/v1/events/recent' ||
    pathname === '/api/v1/appointments' ||
    pathname === '/api/v1/sync/run'
  );

  if (isProtectedRoute) {
    const session = getAuthenticatedSession(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ 
        error: "Accès refusé. Authentification requise pour accéder aux dossiers et fonctions de agence.",
        code: "UNAUTHORIZED"
      }));
      return;
    }
  }

  // Liste complète des pèlerins réels pour la rubrique Pèlerins
  if (pathname === '/api/v1/pelerins' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(pelerinsData));
    return;
  }

  // Modification du statut ou des données d'un pèlerin
  if (pathname.startsWith('/api/v1/pelerins/') && method === 'PUT') {
    const pelerinId = pathname.split('/')[4];
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const updates = JSON.parse(body);
        const idx = pelerinsData.findIndex(p => p.id === pelerinId || p.referenceInterne === pelerinId);

        if (idx === -1) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: "Pèlerin non trouvé." }));
          return;
        }

        const current = pelerinsData[idx];

        // Mettre à jour les champs
        if (updates.statut !== undefined) current.statut = updates.statut;
        if (updates.etape !== undefined) current.etape = updates.etape;
        if (updates.actionAttendue !== undefined) current.actionAttendue = updates.actionAttendue;
        if (updates.conseiller !== undefined) {
          current.conseiller = updates.conseiller;
          current.conseillerNom = updates.conseiller;
        }
        if (updates.urgent !== undefined) current.urgent = updates.urgent;
        if (updates.bloque !== undefined) current.bloque = updates.bloque;
        if (updates.adminNotes !== undefined) current.adminNotes = updates.adminNotes;
        if (updates.nusukVerificationStatus !== undefined) {
          if (!current.nusuk) current.nusuk = {};
          current.nusuk.verificationStatus = updates.nusukVerificationStatus;
          if (updates.nusukVerificationStatus === 'VERIFIE') {
            current.nusuk.hasAccount = true;
            current.nusuk.rawHasAccount = 'OUI';
          }
        }
        if (updates.hasNusukAccount !== undefined) {
          if (!current.nusuk) current.nusuk = {};
          current.nusuk.hasAccount = updates.hasNusukAccount;
          current.nusuk.rawHasAccount = updates.hasNusukAccount ? 'OUI' : 'NON';
        }
        if (updates.statutPaiement !== undefined) {
          const wasPaid = current.statutPaiement === 'PAYE';
          current.statutPaiement = updates.statutPaiement;
          if (updates.statutPaiement === 'PAYE') {
            current.montantPaye = Number(updates.montantPaye) || 390;
            current.datePaiement = current.datePaiement || new Date().toISOString();

            if (!wasPaid) {
              const ledgerEntry = {
                id: `pay-upd-${Date.now()}`,
                timestamp: new Date().toISOString(),
                pelerinId: current.id,
                nomComplet: current.nomComplet || `${current.firstName} ${current.familyName}`,
                email: current.emailContact || current.email,
                phone: current.phone || current.telephone,
                montantEur: current.montantPaye,
                statut: "PAYE",
                methode: updates.methodePaiement || "VALIDATION_CONSEILLER",
                referencePaiement: updates.referencePaiement || "MANUELLE",
                note: updates.notePaiement || "Paiement 390 € validé lors de la mise à jour dossier",
                referenceInterne: current.referenceInterne || current.id,
                conseiller: current.conseiller || "Conseiller 1"
              };
              paymentsLedgerData.unshift(ledgerEntry);
              savePaymentsLedger();
            }
          }
        }

        if (updates.tarifType !== undefined) {
          current.tarifType = updates.tarifType;
          if (updates.tarifType === 'ANCIEN_CLIENT') {
            current.tarifMontantEur = 350;
          } else if (updates.tarifType === 'STANDARD') {
            current.tarifMontantEur = 390;
          }
        }
        if (updates.tarifMontantEur !== undefined) {
          current.tarifMontantEur = Number(updates.tarifMontantEur) || current.tarifMontantEur;
        }

        savePelerins();

        // Synchronisation bidirectionnelle vers la source unique de vérité Mon Omra (PATCH)
        const remoteTargetId = current.sourceId || current.id;
        syncService.updatePilgrimOnMonOmra(remoteTargetId, {
          status: current.statut,
          statutPaiement: current.statutPaiement,
          montantPaye: current.montantPaye,
          datePaiement: current.datePaiement,
          conseiller: current.conseiller,
          nusukAccountStatus: current.nusuk ? current.nusuk.verificationStatus : undefined,
          hasNusukAccount: current.nusuk ? current.nusuk.hasAccount : undefined,
          adminNotes: current.adminNotes,
          availabilitySlots: current.availabilitySlots
        }).catch(syncErr => {
          console.warn(`[SYNC-WARN] Échec de la réplication vers Mon Omra pour ${remoteTargetId}:`, syncErr.message);
        });

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, message: "Dossier pèlerin mis à jour avec succès.", pelerin: current }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: "Payload invalide." }));
      }
    });
    return;
  }

  // Enregistrement d'un échange ou interaction (WhatsApp, Email, Appel, Note)
  if (pathname.match(/^\/api\/v1\/pelerins\/[^\/]+\/interactions$/) && method === 'POST') {
    const pelerinId = pathname.split('/')[4];
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        const idx = pelerinsData.findIndex(p => p.id === pelerinId || p.referenceInterne === pelerinId);
        if (idx === -1) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: "Pèlerin non trouvé." }));
          return;
        }

        const p = pelerinsData[idx];
        if (!Array.isArray(p.historiqueContacts)) {
          p.historiqueContacts = [];
        }

        const nowIso = new Date().toISOString();
        const canal = (payload.canal || 'WHATSAPP').toUpperCase();
        const auteur = payload.auteur || p.conseiller || 'Conseiller';
        const note = payload.note || (canal === 'WHATSAPP' ? "Message d'accompagnement envoyé via WhatsApp" : (canal === 'EMAIL' ? "Email de suivi envoyé" : "Contact client enregistré"));

        const interaction = {
          id: `cnt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          canal: canal,
          date: nowIso,
          auteur: auteur,
          note: note
        };

        p.historiqueContacts.unshift(interaction);
        p.dernierContact = {
          canal: canal,
          date: nowIso,
          auteur: auteur,
          note: note
        };

        // Ajout au journal d'événements récents pour observabilité en direct
        recentEvents.unshift({
          id: `evt-cnt-${Date.now()}`,
          titre: `${canal === 'WHATSAPP' ? '💬 WhatsApp' : (canal === 'EMAIL' ? '✉️ Email' : '📞 Contact')} : ${p.nomComplet || p.fullName || 'Pèlerin'}`,
          description: `${note} (par ${auteur})`,
          horodatageRelatif: "À l'instant",
          actionRequisePar: auteur
        });

        savePelerins();

        // Réplication discrète vers la source Mon Omra
        const remoteTargetId = p.sourceId || p.id;
        syncService.updatePilgrimOnMonOmra(remoteTargetId, {
          adminNotes: `[Contact ${canal} le ${new Date().toLocaleDateString('fr-FR')}] ${note}`
        }).catch(err => {
          console.warn('[SYNC-INTERACTION WARN]', err.message);
        });

        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          success: true,
          message: "Échange enregistré sur le dossier avec succès.",
          interaction: interaction,
          dernierContact: p.dernierContact,
          historiqueContacts: p.historiqueContacts
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: "Payload invalide : " + err.message }));
      }
    });
    return;
  }

  // --- RENDEZ-VOUS TÉLÉPHONIQUES & AGENDA ---
  if (pathname === '/api/v1/appointments' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(appointmentsData));
    return;
  }

  if (pathname === '/api/v1/appointments' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { pelerinId, pelerinNom, phone, dateHeure, sujet, conseiller } = payload;

        if (!pelerinNom || !dateHeure) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: "Pèlerin et date/heure sont obligatoires." }));
          return;
        }

        const newRdv = {
          id: `rdv-${Date.now()}`,
          pelerinId: pelerinId || null,
          pelerinNom,
          phone: phone || "+33600000000",
          dateHeure,
          sujet: sujet || "Point d'assistance Nusuk",
          conseiller: conseiller || "Conseiller 1",
          statut: "PLANIFIE",
          creeLe: new Date().toISOString()
        };

        appointmentsData.push(newRdv);
        // Trier par date
        appointmentsData.sort((a, b) => new Date(a.dateHeure) - new Date(b.dateHeure));
        saveAppointments();

        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, message: "Rendez-vous téléphonique planifié.", appointment: newRdv }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: "Requête invalide." }));
      }
    });
    return;
  }

  if (pathname.startsWith('/api/v1/appointments/') && method === 'DELETE') {
    const rdvId = pathname.split('/')[4];
    appointmentsData = appointmentsData.filter(r => r.id !== rdvId);
    saveAppointments();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, message: "Rendez-vous supprimé ou clôturé." }));
    return;
  }

  // --- 4. CONFIGURATION STRIPE & FICHE PRODUIT ---
  if (pathname === '/api/v1/stripe/config' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      config: stripeConfig,
      ficheProduit: {
        nom: stripeConfig.productName,
        montantEur: stripeConfig.unitAmountEur || 390,
        montantTexte: "390,00 € TTC",
        preferentialAmountEur: stripeConfig.preferentialAmountEur || 350,
        preferentialMontantTexte: "350,00 € TTC",
        devise: stripeConfig.currency,
        type: "Paiement unique (One-time)",
        statementDescriptor: stripeConfig.statementDescriptor,
        paymentLinkUrl: stripeConfig.paymentLinkUrl,
        preferentialPaymentLinkUrl: stripeConfig.preferentialPaymentLinkUrl || "",
        promoCode: stripeConfig.promoCode || "FIDELITE40",
        isLive: stripeConfig.isLive,
        description: stripeConfig.description,
        collecteDonnees: [
          "Nom complet du pèlerin",
          "Adresse email",
          "Numéro de téléphone mobile",
          "Adresse de facturation (TVA B2C)"
        ],
        mentionsLegales: "Honoraires de agence et d'assistance administrative & technique. La prestation ne comprend pas l'achat du pack de voyage sur le portail officiel saoudien Nusuk."
      }
    }));
    return;
  }

  if (pathname === '/api/v1/stripe/config' && method === 'PUT') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        if (payload.paymentLinkUrl) stripeConfig.paymentLinkUrl = payload.paymentLinkUrl.trim();
        if (payload.packCompletPaymentLinkUrl) {
          stripeConfig.packCompletPaymentLinkUrl = payload.packCompletPaymentLinkUrl.trim();
          stripeConfig.paymentLinkUrl = payload.packCompletPaymentLinkUrl.trim();
        }
        if (payload.module1PaymentLinkUrl) stripeConfig.module1PaymentLinkUrl = payload.module1PaymentLinkUrl.trim();
        if (payload.module2PaymentLinkUrl) stripeConfig.module2PaymentLinkUrl = payload.module2PaymentLinkUrl.trim();
        if (payload.module3PaymentLinkUrl) stripeConfig.module3PaymentLinkUrl = payload.module3PaymentLinkUrl.trim();
        if (payload.preferentialPaymentLinkUrl) stripeConfig.preferentialPaymentLinkUrl = payload.preferentialPaymentLinkUrl.trim();
        if (payload.promoCode) stripeConfig.promoCode = payload.promoCode.trim().toUpperCase();
        if (payload.preferentialAmountEur) stripeConfig.preferentialAmountEur = Number(payload.preferentialAmountEur);
        if (payload.unitAmountEur) stripeConfig.unitAmountEur = Number(payload.unitAmountEur);
        if (payload.module1AmountEur) stripeConfig.module1AmountEur = Number(payload.module1AmountEur);
        if (payload.module2AmountEur) stripeConfig.module2AmountEur = Number(payload.module2AmountEur);
        if (payload.module3AmountEur) stripeConfig.module3AmountEur = Number(payload.module3AmountEur);
        if (payload.packCompletAmountEur) {
          stripeConfig.packCompletAmountEur = Number(payload.packCompletAmountEur);
          stripeConfig.unitAmountEur = Number(payload.packCompletAmountEur);
        }
        if (typeof payload.isLive === 'boolean') stripeConfig.isLive = payload.isLive;
        if (payload.productName) stripeConfig.productName = payload.productName;
        if (payload.statementDescriptor) stripeConfig.statementDescriptor = payload.statementDescriptor;
        stripeConfig.updatedAt = new Date().toISOString();
        saveStripeConfig();

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, config: stripeConfig }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Payload invalide." }));
      }
    });
    return;
  }

  // --- 5. REGISTRE FINANCIER & LEDGER DE PAIEMENT (IMMUTABLE) ---
  if (pathname === '/api/v1/payments/ledger' && method === 'GET') {
    const totalAmount = paymentsLedgerData.reduce((acc, p) => acc + (p.montantEur || 0), 0);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      totalPayments: paymentsLedgerData.length,
      totalAmountEur: totalAmount,
      totalAmountEurFormatted: `${totalAmount.toLocaleString('fr-FR')} €`,
      ledger: paymentsLedgerData
    }));
    return;
  }

  // Validation manuelle par un conseiller
  if (pathname === '/api/v1/payments/manual-validate' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { pelerinId, methode, montantEur, referencePaiement, note } = payload;
        const target = pelerinsData.find(p => p.id === pelerinId);
        if (!target) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: "Dossier pèlerin introuvable." }));
          return;
        }

        target.statutPaiement = "PAYE";
        target.montantPaye = Number(montantEur) || 390;
        target.datePaiement = new Date().toISOString();
        savePelerins();

        // Réplication du paiement vers la source unique de vérité Mon Omra (PATCH)
        const remoteTargetId = target.sourceId || target.id;
        syncService.updatePilgrimOnMonOmra(remoteTargetId, {
          statutPaiement: "PAYE",
          montantPaye: target.montantPaye,
          datePaiement: target.datePaiement,
          adminNotes: target.adminNotes ? `${target.adminNotes} | Paiement validé manuellement` : "Paiement honoraires 390 € validé."
        }).catch(syncErr => {
          console.warn(`[SYNC-WARN] Échec de la réplication du paiement vers Mon Omra pour ${remoteTargetId}:`, syncErr.message);
        });

        const ledgerEntry = {
          id: `pay-man-${Date.now()}`,
          timestamp: new Date().toISOString(),
          pelerinId: target.id,
          nomComplet: target.nomComplet || `${target.firstName} ${target.familyName}`,
          email: target.emailContact || target.email,
          phone: target.phone || target.telephone,
          montantEur: target.montantPaye,
          statut: "PAYE",
          methode: methode || "STRIPE_MANUEL",
          referencePaiement: referencePaiement || "CONFIRMATION_CONSEILLER",
          note: note || "Paiement honoraires 390 € validé.",
          referenceInterne: target.referenceInterne || target.id,
          conseiller: target.conseillerAttribue || "Conseiller 1"
        };

        paymentsLedgerData.unshift(ledgerEntry);
        savePaymentsLedger();

        recentEvents.unshift({
          id: `evt-payman-${Date.now()}`,
          titre: `Paiement 390 € validé : ${ledgerEntry.nomComplet}`,
          description: `Méthode : ${ledgerEntry.methode}`,
          horodatageRelatif: "À l'instant",
          actionRequisePar: "AUCUNE"
        });

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, message: "Paiement validé avec succès.", entry: ledgerEntry }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Payload invalide." }));
      }
    });
    return;
  }

  // Webhook Stripe (ex: checkout.session.completed)
  if (pathname === '/api/v1/webhooks/stripe' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const event = JSON.parse(body);

        if (event.type === 'checkout.session.completed') {
          const session = event.data?.object || {};
          const customerEmail = (session.customer_details?.email || session.customer_email || '').toLowerCase().trim();
          const customerName = session.customer_details?.name || 'Pèlerin Inconnu';
          const customerPhone = session.customer_details?.phone || '';
          const amountEur = (session.amount_total || 39000) / 100;
          const sessionId = session.id;

          // Recherche du dossier correspondant
          let matchedPelerin = pelerinsData.find(p => 
            (p.emailContact && p.emailContact.toLowerCase().trim() === customerEmail) ||
            (p.email && p.email.toLowerCase().trim() === customerEmail)
          );

          if (matchedPelerin) {
            matchedPelerin.statutPaiement = "PAYE";
            matchedPelerin.montantPaye = amountEur;
            matchedPelerin.datePaiement = new Date().toISOString();
            matchedPelerin.stripeSessionId = sessionId;
            savePelerins();
          }

          const ledgerEntry = {
            id: `pay-stripe-${Date.now()}`,
            timestamp: new Date().toISOString(),
            pelerinId: matchedPelerin ? matchedPelerin.id : null,
            nomComplet: matchedPelerin ? matchedPelerin.nomComplet : customerName,
            email: customerEmail,
            phone: customerPhone,
            montantEur: amountEur,
            statut: "PAYE",
            methode: "STRIPE_CHECKOUT",
            stripeSessionId: sessionId,
            referenceInterne: matchedPelerin ? (matchedPelerin.referenceInterne || matchedPelerin.id) : "EXTERNE_STRIPE",
            conseiller: matchedPelerin ? matchedPelerin.conseillerAttribue : "Conseiller 1"
          };

          paymentsLedgerData.unshift(ledgerEntry);
          savePaymentsLedger();

          recentEvents.unshift({
            id: `evt-stripe-${Date.now()}`,
            titre: `Paiement Stripe reçu (390 €)`,
            description: `${ledgerEntry.nomComplet} (${customerEmail})`,
            horodatageRelatif: "À l'instant",
            actionRequisePar: "AUCUNE"
          });

          console.log(`[NOVA-SQUAD] Webhook Stripe validé : ${customerName} (${amountEur} €)`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Payload webhook Stripe invalide." }));
      }
    });
    return;
  }

  if (pathname === '/api/v1/dashboard/summary' && method === 'GET') {
    const totalDossiers = pelerinsData.length;
    const totalPelerinsPersonnes = pelerinsData.reduce((acc, p) => acc + (p.peopleCount || 1), 0);
    const totalPrets = pelerinsData.filter(p => p.statut === 'PACKS_VALIDES' || p.nusuk?.verificationStatus === 'VERIFIE').length;
    const totalUrgents = pelerinsData.filter(p => p.urgent).length;
    const totalBloques = pelerinsData.filter(p => p.bloque || p.nusuk?.verificationStatus === 'REJETE').length;

    const summary = {
      totalDossiers: totalDossiers,
      totalPelerinsInscrits: totalPelerinsPersonnes, // Total des 77 personnes réelles
      totalDossiersPrets: totalPrets,
      totalActionsATraiter: totalUrgents,
      totalDossiersBloques: totalBloques,
      progressionVente: {
        pourcentageComptesValides: Math.round((pelerinsData.filter(p => p.nusuk?.hasAccount).length / (totalDossiers || 1)) * 100),
        pourcentageWalletsPrets: Math.round((totalPrets / (totalDossiers || 1)) * 100),
        pourcentageChoixApprouves: Math.round((totalPrets / (totalDossiers || 1)) * 100)
      },
      prochaineVenteTexte: "date officielle à confirmer"
    };

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(summary));
    return;
  }

  if (pathname === '/api/v1/dossiers' && method === 'GET') {
    const filtre = (parsedUrl.query.filtre || 'TOUS').toUpperCase();
    const recherche = (parsedUrl.query.recherche || '').toLowerCase();

    let resultats = pelerinsData;

    if (filtre === 'URGENTS') {
      resultats = resultats.filter(p => p.urgent);
    } else if (filtre === 'MON_EQUIPE') {
      resultats = resultats.filter(p => p.conseiller === 'Conseiller 1');
    }

    if (recherche) {
      resultats = resultats.filter(p => 
        p.nomComplet.toLowerCase().includes(recherche) ||
        p.referenceInterne.toLowerCase().includes(recherche)
      );
    }

    const dtos = resultats.map(p => ({
      dossierId: p.id,
      pelerinNomComplet: p.nomComplet,
      referenceInterne: p.referenceInterne,
      etape: p.etape,
      actionAttendue: p.actionAttendue,
      severiteAction: p.severiteAction,
      conseillerNom: p.conseiller,
      urgent: p.urgent,
      bloque: p.bloque,
      motifBlocage: p.motifBlocage
    }));

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(dtos));
    return;
  }

  if (pathname === '/api/v1/events/recent' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(recentEvents));
    return;
  }

  if (pathname.startsWith('/api/v1/tasks/') && pathname.endsWith('/lock') && method === 'POST') {
    const parts = pathname.split('/');
    const taskId = parts[4];
    const now = Date.now();

    const existingLock = taskLocks.get(taskId);
    if (existingLock && existingLock.expiresAt > now) {
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: "Tâche actuellement verrouillée par un autre conseiller." }));
      return;
    }

    taskLocks.set(taskId, { lockedBy: "Conseiller 1", expiresAt: now + 5 * 60 * 1000 });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, message: "Verrouillage acquis pour 5 minutes." }));
    return;
  }

  // --- GESTION DE L'ÉQUIPE & RÉPARTITION DES DOSSIERS ---
  if (pathname === '/api/v1/team' && method === 'GET') {
    const list = teamMembers.map(m => {
      const dossiersCount = pelerinsData.filter(p => p.conseiller === m.identifiant || p.conseiller === m.nom).length;
      const urgentsCount = pelerinsData.filter(p => (p.conseiller === m.identifiant || p.conseiller === m.nom) && p.urgent).length;
      return {
        ...m,
        dossiersCount,
        urgentsCount
      };
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(list));
    return;
  }

  if (pathname === '/api/v1/team' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const nextNum = teamMembers.length + 1;
        const defaultIdentifiant = `Conseiller ${nextNum}`;
        const newMember = {
          id: `team-${Date.now()}`,
          identifiant: (payload.identifiant || defaultIdentifiant).trim(),
          nom: (payload.nom || defaultIdentifiant).trim(),
          prenom: (payload.prenom || (payload.nom || defaultIdentifiant).split(' ')[0]).trim(),
          role: (payload.role || "Conseiller Hajj & Assistance Nusuk").trim(),
          email: (payload.email || '').trim().toLowerCase(),
          telephone: (payload.telephone || '').trim(),
          statut: payload.statut || "DISPONIBLE",
          boiteSync: payload.boiteSync || "Gmail API (Pub/Sub)",
          creeLe: new Date().toISOString()
        };

        teamMembers.push(newMember);
        saveTeamMembers();

        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, member: newMember, message: "Membre d'équipe ajouté avec succès." }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Payload invalide." }));
      }
    });
    return;
  }

  if (pathname.startsWith('/api/v1/team/') && method === 'PUT') {
    const memberId = pathname.replace('/api/v1/team/', '');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const member = teamMembers.find(m => m.id === memberId);
        if (!member) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: "Membre d'équipe introuvable." }));
          return;
        }

        const oldIdentifiant = member.identifiant;
        const oldNom = member.nom;

        if (payload.identifiant) member.identifiant = payload.identifiant.trim();
        if (payload.nom) member.nom = payload.nom.trim();
        if (payload.prenom) member.prenom = payload.prenom.trim();
        if (payload.role) member.role = payload.role.trim();
        if (payload.email !== undefined) member.email = payload.email.trim();
        if (payload.telephone !== undefined) member.telephone = payload.telephone.trim();
        if (payload.statut) member.statut = payload.statut;
        if (payload.boiteSync) member.boiteSync = payload.boiteSync;

        // Mise à jour en cascade des dossiers pèlerins si l'identifiant a changé
        if (payload.identifiant && payload.identifiant !== oldIdentifiant) {
          pelerinsData.forEach(p => {
            if (p.conseiller === oldIdentifiant || p.conseiller === oldNom) {
              p.conseiller = member.identifiant;
              p.conseillerNom = member.identifiant;
            }
          });
          savePelerins();
        }

        saveTeamMembers();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, member: member, message: "Membre d'équipe mis à jour." }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Payload invalide." }));
      }
    });
    return;
  }

  if (pathname.startsWith('/api/v1/team/') && method === 'DELETE') {
    const memberId = pathname.replace('/api/v1/team/', '');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        let payload = {};
        if (body.trim()) payload = JSON.parse(body);

        const targetIdx = teamMembers.findIndex(m => m.id === memberId);
        if (targetIdx === -1) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: "Membre d'équipe introuvable." }));
          return;
        }

        const removed = teamMembers[targetIdx];
        teamMembers.splice(targetIdx, 1);
        saveTeamMembers();

        // Réattribution des dossiers du membre supprimé
        const available = getAvailableAdvisorList();
        const fallbackAdvisor = payload.reassignTo || (available[0] || "Conseiller 1");
        let reassigned = 0;

        pelerinsData.forEach(p => {
          if (p.conseiller === removed.identifiant || p.conseiller === removed.nom) {
            p.conseiller = fallbackAdvisor;
            p.conseillerNom = fallbackAdvisor;
            reassigned++;
          }
        });

        if (reassigned > 0) savePelerins();

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ 
          success: true, 
          message: `Membre ${removed.identifiant} (${removed.nom}) supprimé. ${reassigned} dossier(s) réattribué(s) à ${fallbackAdvisor}.` 
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Erreur lors de la suppression." }));
      }
    });
    return;
  }

  // RÉPARTITION ÉQUITABLE (DISPATCH ÉGAL DES DOSSIERS ENTRE TOUS LES CONSEILLERS DISPONIBLES)
  if (pathname === '/api/v1/team/repartir' && method === 'POST') {
    const activeMembers = teamMembers.filter(m => m.statut !== 'INACTIF' && m.statut !== 'EN_CONGE');
    if (activeMembers.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: "Aucun conseiller actif disponible pour la répartition." }));
      return;
    }

    // Répartition équitable Round-Robin sur l'ensemble des pèlerins
    pelerinsData.forEach((p, idx) => {
      const assigned = activeMembers[idx % activeMembers.length];
      p.conseiller = assigned.identifiant || assigned.nom;
      p.conseillerNom = assigned.identifiant || assigned.nom;
    });

    savePelerins();

    const counts = activeMembers.map(m => ({
      identifiant: m.identifiant,
      nom: m.nom,
      dossiersCount: pelerinsData.filter(p => p.conseiller === m.identifiant).length
    }));

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      success: true,
      totalDossiers: pelerinsData.length,
      advisorsCount: activeMembers.length,
      distribution: counts,
      message: `Répartition équitable effectuée avec succès : ${pelerinsData.length} dossiers répartis entre ${activeMembers.length} conseillers.`
    }));
    return;
  }

  // --- SYNCHRONISATION MON OMRA (API EXTERNE) ---
  if (pathname === '/api/v1/sync/status' && method === 'GET') {
    const state = syncService.loadSyncState();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(state));
    return;
  }

  if (pathname === '/api/v1/sync/mon-omra' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        let opts = {};
        if (body && body.trim()) {
          try { opts = JSON.parse(body); } catch (_) {}
        }
        const result = await syncService.executeSync(pelerinsData, savePelerins, getNextAdvisor, opts);
        
        if (result.success && result.importedCount > 0) {
          recentEvents.unshift({
            id: `evt-sync-${Date.now()}`,
            titre: `Synchronisation Mon Omra : +${result.importedCount} pèlerin(s)`,
            description: `${result.updatedCount} mise(s) à jour`,
            horodatageRelatif: "À l'instant",
            actionRequisePar: "CONSEILLER"
          });
        }
        
        res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // --- NOUVEAU : IMPORT EN LOT (CSV / JSON) ---
  if (pathname === '/api/v1/pelerins/import' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        let items = [];

        // Supporte { pelerins: [...] } ou directement un tableau [...]
        if (Array.isArray(payload)) {
          items = payload;
        } else if (Array.isArray(payload.pelerins)) {
          items = payload.pelerins;
        } else if (payload.csvContent) {
          // Parseur CSV léger intégré
          const lines = payload.csvContent.split(/\r?\n/).filter(l => l.trim().length > 0);
          if (lines.length > 1) {
            const separator = lines[0].includes(';') ? ';' : ',';
            const headers = lines[0].split(separator).map(h => h.trim().toLowerCase().replace(/["']/g, ''));
            
            for (let i = 1; i < lines.length; i++) {
              const values = lines[i].split(separator).map(v => v.trim().replace(/["']/g, ''));
              if (values.length >= headers.length) {
                const row = {};
                headers.forEach((h, idx) => { row[h] = values[idx]; });
                items.push(row);
              }
            }
          }
        }

        if (items.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: "Aucun pèlerin valide trouvé dans le payload JSON ou CSV." }));
          return;
        }

        let importedCount = 0;
        let duplicateCount = 0;
        const importedDossiers = [];

        for (const item of items) {
          const cleanPrenom = (item.prenom || item.firstname || (item.nomComplet ? item.nomComplet.split(' ')[0] : 'Pèlerin')).trim();
          const cleanNom = (item.nom || item.lastname || (item.nomComplet ? item.nomComplet.split(' ').slice(1).join(' ') : 'Inconnu')).trim();
          const email = (item.emailContact || item.email || item.mail || '').trim().toLowerCase();
          const telephone = (item.telephone || item.phone || item.tel || '+33600000000').trim();

          if (!email) continue;

          // Détection doublon
          const exists = pelerinsData.some(p => p.emailContact && p.emailContact.trim().toLowerCase() === email);
          if (exists) {
            duplicateCount++;
            continue;
          }

          // Détection de la date d'écriture du formulaire
          const rawDate = item.createdAt || item.created_at || item.creeLe || item.dateInscription || item.date_inscription || item.dateFormulaire || item.dateEcriture || item.date || item.submissionDate || item.timestamp || item.horodatage || item.submittedAt;
          let dateIso = new Date().toISOString();
          if (rawDate) {
            const parsed = new Date(rawDate);
            if (!isNaN(parsed.getTime())) {
              dateIso = parsed.toISOString();
            }
          }

          // Attribution conseiller (Round-Robin dynamique sur l'équipe active)
          const availableAdvisors = getAvailableAdvisorList();
          const conseiller = availableAdvisors[nextAdvisorIndex % availableAdvisors.length];
          nextAdvisorIndex++;

          const newIndex = pelerinsData.length + 1;
          const refIndexStr = String(newIndex).padStart(3, '0');
          const ref = `HAJJ-2026-${refIndexStr}`;
          const newId = `11111111-0000-0000-0000-${String(newIndex).padStart(12, '0')}`;

          const isAncien = item.dejaClient === true || item.ancienClient === true || item.tarifType === 'ANCIEN_CLIENT';
          const montantEur = item.tarifMontantEur ? Number(item.tarifMontantEur) : (isAncien ? 350 : 390);

          const newPelerin = {
            id: newId,
            referenceInterne: ref,
            firstName: cleanPrenom,
            familyName: cleanNom,
            fullName: `${cleanPrenom} ${cleanNom}`,
            nomComplet: `${cleanPrenom} ${cleanNom}`,
            telephone: telephone,
            phone: telephone,
            email: email,
            emailContact: email,
            dejaClient: isAncien,
            ancienClient: isAncien,
            tarifType: isAncien ? "ANCIEN_CLIENT" : "STANDARD",
            tarifMontantEur: montantEur,
            tarifAssistance: montantEur,
            provider: item.provider || "Yusr Al Mashaer",
            nationality: item.nationality || "Française",
            peopleCount: item.peopleCount ? Number(item.peopleCount) : 1,
            compteNusukDeclare: (item.compteNusukDeclare || email).trim(),
            etape: item.etape || "Inscription",
            statut: item.statut || "CREE",
            statutProvenance: "DECLARE_PAR_CLIENT",
            actionAttendue: item.actionAttendue || "Contrôler le dossier importé",
            severiteAction: "URGENTE",
            conseiller: conseiller,
            urgent: true,
            bloque: false,
            nusuk: item.nusuk || {
              hasAccount: item.compteNusukDeclare ? true : false,
              verificationStatus: "NON_VERIFIE"
            },
            creeLe: dateIso,
            createdAt: dateIso
          };

          pelerinsData.unshift(newPelerin);
          importedDossiers.push(newPelerin);
          importedCount++;
        }

        savePelerins();

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          success: true,
          importedCount: importedCount,
          duplicateCount: duplicateCount,
          totalPelerins: pelerinsData.length,
          message: `${importedCount} pèlerin(s) importé(s) avec succès. ${duplicateCount} doublon(s) ignoré(s).`
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: "Erreur de traitement de l'import : " + err.message }));
      }
    });
    return;
  }

  // --- NOUVEAU : INSCRIPTION AUTONOME PÈLERIN (SCR06-A) ---
  if (pathname === '/api/v1/pelerins/register' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { nom, prenom, emailContact, telephone, dejaClient, statutNusuk, compteNusukDeclare, nomFamille, accepteCgv, accepteRgpd } = payload;

        // Validation des champs obligatoires
        if (!nom || !prenom || !emailContact || !telephone) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: "Nom, prénom, email et téléphone sont obligatoires." }));
          return;
        }

        // Vérification CGV & RGPD obligatoires
        if (!accepteCgv || !accepteRgpd) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: "L'acceptation des CGV et le consentement RGPD sont requis." }));
          return;
        }

        const isAncienClient = dejaClient === true || dejaClient === 'true' || dejaClient === 'OUI';
        const tarifAssistance = isAncienClient ? 350 : 390;
        const normalizedEmail = emailContact.trim().toLowerCase();

        // Détection de doublon
        const exists = pelerinsData.some(p => p.emailContact && p.emailContact.trim().toLowerCase() === normalizedEmail);
        if (exists) {
          res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ 
            error: "Un dossier existe déjà avec cette adresse email. Veuillez contacter votre conseiller ou demander un lien d'accès." 
          }));
          return;
        }

        // Attribution du conseiller disponible (Round-Robin dynamique sur l'équipe)
        const availableAdvisors = getAvailableAdvisorList();
        const conseillerAttribue = availableAdvisors[nextAdvisorIndex % availableAdvisors.length];
        nextAdvisorIndex++;

        // Génération ID et référence interne
        const newIndex = pelerinsData.length + 1;
        const refIndexStr = String(newIndex).padStart(3, '0');
        const referenceInterne = `HAJJ-2026-${refIndexStr}`;
        const newId = `11111111-0000-0000-0000-${String(newIndex).padStart(12, '0')}`;

        const cleanPrenom = prenom.trim();
        const cleanNom = nom.trim();

        const nouveauPelerin = {
          id: newId,
          referenceInterne: referenceInterne,
          firstName: cleanPrenom,
          familyName: cleanNom,
          fullName: `${cleanPrenom} ${cleanNom}`,
          nomComplet: `${cleanPrenom} ${cleanNom}`,
          telephone: telephone.trim(),
          phone: telephone.trim(),
          email: normalizedEmail,
          emailContact: normalizedEmail,
          dejaClient: isAncienClient,
          ancienClient: isAncienClient,
          tarifAssistance: tarifAssistance,
          provider: "Yusr Al Mashaer",
          compteNusukDeclare: (compteNusukDeclare || normalizedEmail).trim(),
          etape: "Inscription",
          statut: "CREE",
          statutProvenance: "DECLARE_PAR_CLIENT",
          actionAttendue: "Contrôler la validation",
          severiteAction: "URGENTE",
          conseiller: conseillerAttribue,
          urgent: true,
          bloque: false,
          nomFamille: nomFamille || null,
          statutNusuk: statutNusuk || "NON_INSCRIT",
          creeLe: new Date().toISOString()
        };

        // Ajout immédiat en mémoire vive (visible instantanément sur le dashboard)
        pelerinsData.unshift(nouveauPelerin);
        savePelerins();

        // Création synchrone/asynchrone sur la base centrale Mon Omra (POST)
        syncService.createPilgrimOnMonOmra(nouveauPelerin).then(syncResult => {
          if (syncResult && syncResult.success && syncResult.id) {
            nouveauPelerin.sourceId = syncResult.id;
            savePelerins();
            console.log(`[SYNC-REGISTER] Dossier ${nouveauPelerin.referenceInterne} synchronisé sur Mon Omra (UUID: ${syncResult.id})`);
          }
        }).catch(syncErr => {
          console.warn(`[SYNC-WARN] Échec de la création sur Mon Omra pour ${nouveauPelerin.referenceInterne}:`, syncErr.message);
        });

        // Ajout d'un événement récent
        recentEvents.unshift({
          id: `evt-reg-${Date.now()}`,
          titre: `Nouvelle inscription : ${nouveauPelerin.nomComplet} (${isAncienClient ? 'Ancien client - 350 €' : 'Nouveau client - 390 €'})`,
          description: `Attribué à ${conseillerAttribue}`,
          horodatageRelatif: "À l'instant",
          actionRequisePar: "CONSEILLER"
        });

        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          success: true,
          dossierId: newId,
          referenceInterne: referenceInterne,
          conseillerAttribue: conseillerAttribue,
          dejaClient: isAncienClient,
          tarifAssistance: tarifAssistance,
          lienPaiementStripe: stripeConfig.paymentLinkUrl,
          message: "Inscription enregistrée avec succès. Votre dossier a été créé et transmis à votre conseiller."
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: "Payload invalide." }));
      }
    });
    return;
  }


  if (pathname === '/api/v1/ingestion/webhook' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { provider, messageId, sender, rawBody } = payload;

        if (!messageId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: "messageId requis." }));
          return;
        }

        // AC02 : Test d'idempotence
        if (processedMessageIds.has(messageId)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: "DEJA_TRAITE", message: "Message ignoré (idempotence AC02)." }));
          return;
        }

        // AC05, AC06, AC07 : Sanitizer synchrone
        const sanitization = sanitizeEmail(sender || '', rawBody || '');
        if (sanitization.quarantine) {
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: "QUARANTAINE", motif: "Expéditeur non reconnu (AC07)." }));
          return;
        }

        processedMessageIds.add(messageId);

        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          status: "ACCEPTE", 
          sanitizedSnippet: sanitization.cleanSnippet,
          otpPurged: true 
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Payload JSON invalide." }));
      }
    });
    return;
  }

  // --- SERVIR FICHIERS STATIQUES (UI) ---
  // Protection contre le Path Traversal
  if (/(^|\/)\.\.(\/|$)/.test(pathname) || pathname.includes('%2e') || pathname.includes('%2E')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Accès interdit : Path traversal détecté.');
    return;
  }

  let targetFile = pathname.slice(1);
  if (pathname === '/' || pathname === '/accueil') {
    targetFile = 'index.html';
  } else if (pathname === '/dashboard' || pathname === '/agence') {
    targetFile = 'dashboard.html';
  } else if (pathname === '/register' || pathname === '/inscription') {
    targetFile = 'register.html';
  } else if (pathname === '/login') {
    targetFile = 'login.html';
  } else if (pathname === '/favicon.ico') {
    targetFile = 'favicon.ico';
  }

  // Candidats de chemins pour compatibilité locale ET conteneurs serverless
  const candidatePaths = [
    path.join(__dirname, '..', 'public', targetFile),
    path.join(__dirname, 'public', targetFile),
    path.join(process.cwd(), 'public', targetFile),
    path.join(process.cwd(), targetFile)
  ];

  // Si targetFile n'a pas d'extension ou pointe vers un dossier, tester les variantes .html et /index.html
  if (!path.extname(targetFile)) {
    candidatePaths.push(
      path.join(__dirname, '..', 'public', targetFile + '.html'),
      path.join(__dirname, 'public', targetFile + '.html'),
      path.join(process.cwd(), 'public', targetFile + '.html'),
      path.join(__dirname, '..', 'public', targetFile, 'index.html'),
      path.join(__dirname, 'public', targetFile, 'index.html'),
      path.join(process.cwd(), 'public', targetFile, 'index.html')
    );
  } else if (targetFile.endsWith('.html')) {
    // Si c'est un fichier .html, tester aussi dans son sous-dossier (ex: login/index.html)
    const baseName = path.basename(targetFile, '.html');
    candidatePaths.push(
      path.join(__dirname, '..', 'public', baseName, 'index.html'),
      path.join(__dirname, 'public', baseName, 'index.html'),
      path.join(process.cwd(), 'public', baseName, 'index.html')
    );
  }

  let filePath = candidatePaths.find(p => {
    try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch (_) { return false; }
  });

  // Si le fichier HTML physique est absent du conteneur serverless, rediriger vers le CDN Vercel
  if (!filePath) {
    if (targetFile.endsWith('.html')) {
      res.writeHead(302, { 'Location': '/' + targetFile });
      res.end();
      return;
    }
    if (!path.extname(targetFile)) {
      res.writeHead(302, { 'Location': '/' + targetFile + '.html' });
      res.end();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Fichier non trouvé');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp'
  };

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (targetFile.endsWith('.html')) {
        res.writeHead(302, { 'Location': '/' + targetFile });
        res.end();
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Fichier non trouvé');
    } else {
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      res.end(content);
    }
  });
}

const server = http.createServer(handleRequest);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[NOVA-SQUAD] Serveur démarré avec succès sur http://localhost:${PORT}`);
    
    // Synchronisation automatique en arrière-plan toutes les X minutes (défaut : 30 min)
    const autoSyncMinutes = parseInt(process.env.MON_OMRA_AUTO_SYNC_MINUTES || '30', 10);
    if (autoSyncMinutes > 0 && process.env.NODE_ENV !== 'test') {
      console.log(`[SYNC AUTO] Service de synchronisation automatique activé (intervalle: ${autoSyncMinutes} minutes)`);
      setInterval(async () => {
        console.log(`[SYNC AUTO] Déclenchement de la synchronisation périodique (${autoSyncMinutes} min)...`);
        try {
          const res = await syncService.executeSync(pelerinsData, savePelerins, getNextAdvisor);
          if (res.success && res.importedCount > 0) {
            recentEvents.unshift({
              id: `evt-sync-${Date.now()}`,
              titre: `Auto-Synchro Mon Omra : +${res.importedCount} dossier(s)`,
              description: `${res.updatedCount} mise(s) à jour`,
              horodatageRelatif: "À l'instant",
              actionRequisePar: "CONSEILLER"
            });
          }
        } catch (e) {
          console.error('[SYNC AUTO] Erreur :', e.message);
        }
      }, autoSyncMinutes * 60 * 1000);
    }
  });

  process.on('uncaughtException', (err) => {
    console.error('[NOVA-SQUAD CRITICAL] Uncaught exception:', err);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('[NOVA-SQUAD CRITICAL] Unhandled rejection at:', promise, 'reason:', reason);
  });

  // Maintenir le process Node actif en tâche de fond
  if (process.stdin.isTTY === false) {
    process.stdin.resume();
  }
}

module.exports = handleRequest;
