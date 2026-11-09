/**
 * SERVICE DE SYNCHRONISATION MON OMRA -> HAJJ ASSISTANCE CONCIERGERIE
 * 
 * Fonctionnalités :
 * - Synchronisation différentielle via paramètre ?since=ISO8601
 * - Idempotence & UPSERT (pas de doublon par ID, email ou téléphone)
 * - Masquage sécurisé de la clé d'API dans les logs
 * - Sauvegarde de l'état (lastSyncedAt, stats) dans data/sync-state.json
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const syncStatePath = path.join(__dirname, '..', 'data', 'sync-state.json');

// Configuration avec valeurs par défaut
function getConfig() {
  return {
    apiUrl: process.env.MON_OMRA_API_URL || 'https://mon-omra.fr/api/v1/hajj/pilgrims',
    apiKey: process.env.MON_OMRA_HAJJ_API_KEY || 'hajj_live_e4d73d355d4941c999aad7eaca099c8a756616c080744f998ccf4738553dd66f'
  };
}

// Masquage sécurisé d'une clé API pour les logs
function maskKey(key) {
  if (!key || key.length < 12) return '***';
  return key.slice(0, 8) + '...' + key.slice(-4);
}

// Lecture de l'état de synchronisation
function loadSyncState() {
  try {
    if (fs.existsSync(syncStatePath)) {
      return JSON.parse(fs.readFileSync(syncStatePath, 'utf8'));
    }
  } catch (err) {
    console.error('[SYNC] Erreur lecture sync-state:', err.message);
  }
  return {
    lastSyncedAt: '2026-10-30T00:00:00.000Z',
    lastSyncStatus: 'IDLE',
    lastSyncTimestamp: null,
    importedCount: 0,
    updatedCount: 0,
    totalSyncedToDate: 0,
    lastError: null
  };
}

// Écriture de l'état de synchronisation
function saveSyncState(state) {
  try {
    fs.writeFileSync(syncStatePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('[SYNC] Erreur sauvegarde sync-state:', err.message);
  }
}

// Effectue une requête HTTP générique vers l'API Mon Omra
function sendJsonRequest(targetUrl, method, apiKey, payload = null, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(targetUrl);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;

      const payloadString = payload ? JSON.stringify(payload) : null;

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: method || 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'X-API-Key': apiKey,
          'Accept': 'application/json',
          'User-Agent': 'SalamOmraHajjSync/1.0'
        },
        timeout: timeoutMs
      };

      if (payloadString) {
        options.headers['Content-Type'] = 'application/json; charset=utf-8';
        options.headers['Content-Length'] = Buffer.byteLength(payloadString);
      }

      console.log(`[SYNC-API] ${method} ${parsedUrl.hostname}${parsedUrl.pathname} (Token: ${maskKey(apiKey)})`);

      const req = client.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            return reject(new Error(`Authentification refusée (${res.statusCode}) - Clé API invalide.`));
          }

          let json = null;
          try {
            json = body ? JSON.parse(body) : {};
          } catch (_) {
            json = { rawBody: body };
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            const errMsg = (json && (json.error || json.message)) ? (json.error || json.message) : `Erreur HTTP ${res.statusCode}`;
            const err = new Error(errMsg);
            err.statusCode = res.statusCode;
            err.response = json;
            return reject(err);
          }

          resolve({
            statusCode: res.statusCode,
            data: json
          });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Délai d'attente dépassé (timeout ${timeoutMs / 1000}s) vers ${parsedUrl.hostname}.`));
      });

      req.on('error', (err) => {
        reject(new Error(`Connexion impossible à ${parsedUrl.hostname}: ${err.message}`));
      });

      if (payloadString) {
        req.write(payloadString);
      }
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// Effectue la requête HTTP GET vers l'API Mon Omra
function fetchFromApi(endpointUrl, apiKey, sinceDate) {
  const parsedUrl = new URL(endpointUrl);
  if (sinceDate) {
    parsedUrl.searchParams.set('since', sinceDate);
  }
  parsedUrl.searchParams.set('limit', '500');

  return sendJsonRequest(parsedUrl.toString(), 'GET', apiKey, null, 15000)
    .then(res => res.data);
}

/**
 * Met à jour un dossier sur la base centrale Mon Omra (PATCH /api/v1/hajj/pilgrims/:id)
 * @param {string} id - L'ID unique (sourceId ou id)
 * @param {Object} updates - Les modifications
 * @param {Object} options - Options { overrideUrl, overrideKey }
 */
async function updatePilgrimOnMonOmra(id, updates, options = {}) {
  if (!id) {
    return { success: false, skipped: true, reason: "ID pèlerin absent pour synchronisation Mon Omra" };
  }

  const config = getConfig();
  const baseUrl = (options.overrideUrl || config.apiUrl).replace(/\/+$/, '');
  const apiKey = options.overrideKey || config.apiKey;
  const targetUrl = `${baseUrl}/${encodeURIComponent(id)}`;

  // Normaliser le payload pour Mon Omra
  const payload = {};
  if (updates.status !== undefined) payload.status = updates.status;
  if (updates.statut !== undefined) payload.status = updates.statut;
  if (updates.statutPaiement !== undefined) payload.statutPaiement = updates.statutPaiement;
  if (updates.montantPaye !== undefined) payload.montantPaye = Number(updates.montantPaye);
  if (updates.datePaiement !== undefined) payload.datePaiement = updates.datePaiement;
  if (updates.conseiller !== undefined) payload.conseiller = updates.conseiller;
  if (updates.conseillerNom !== undefined) payload.conseiller = updates.conseillerNom;
  if (updates.nusukAccountStatus !== undefined) payload.nusukAccountStatus = updates.nusukAccountStatus;
  if (updates.nusukVerificationStatus !== undefined) payload.nusukAccountStatus = updates.nusukVerificationStatus;
  if (updates.hasNusukAccount !== undefined) {
    payload.hasNusukAccount = updates.hasNusukAccount === true || updates.hasNusukAccount === 'OUI' ? 'OUI' : 'NON';
  }
  if (updates.adminNotes !== undefined) payload.adminNotes = updates.adminNotes;
  if (updates.availabilitySlots !== undefined) payload.availabilitySlots = updates.availabilitySlots;

  try {
    const res = await sendJsonRequest(targetUrl, 'PATCH', apiKey, payload, 10000);
    console.log(`[SYNC-WRITE] Dossier ${id} mis à jour avec succès sur Mon Omra.`);
    return {
      success: true,
      statusCode: res.statusCode,
      data: res.data
    };
  } catch (err) {
    console.warn(`[SYNC-WRITE WARN] Impossible de mettre à jour le pèlerin ${id} sur Mon Omra: ${err.message}`);
    return {
      success: false,
      error: err.message,
      statusCode: err.statusCode || null
    };
  }
}

/**
 * Crée un dossier pèlerin sur la base centrale Mon Omra (POST /api/v1/hajj/pilgrims)
 * @param {Object} pilgrimData - Données du pèlerin
 * @param {Object} options - Options { overrideUrl, overrideKey }
 */
async function createPilgrimOnMonOmra(pilgrimData, options = {}) {
  const config = getConfig();
  const baseUrl = (options.overrideUrl || config.apiUrl).replace(/\/+$/, '');
  const apiKey = options.overrideKey || config.apiKey;

  const prenom = pilgrimData.firstName || pilgrimData.prenom || (pilgrimData.fullName ? pilgrimData.fullName.split(' ')[0] : 'Pèlerin');
  const nom = pilgrimData.familyName || pilgrimData.nom || (pilgrimData.fullName ? pilgrimData.fullName.split(' ').slice(1).join(' ') : 'Dossier');
  const nomComplet = pilgrimData.fullName || pilgrimData.nomComplet || `${prenom} ${nom}`.trim();
  const email = (pilgrimData.email || pilgrimData.emailContact || '').trim().toLowerCase();
  const phone = (pilgrimData.phone || pilgrimData.telephone || '').trim();

  const payload = {
    firstName: prenom,
    familyName: nom,
    fullName: nomComplet,
    email: email,
    phone: phone,
    address: pilgrimData.address || 'Non renseignée',
    nationality: pilgrimData.nationality || 'Française',
    peopleCount: Number(pilgrimData.peopleCount) || 1,
    hajjYear: Number(pilgrimData.hajjYear) || 2027,
    partnerAgency: pilgrimData.partnerAgency || pilgrimData.provider || 'Yusr Al Mashaer',
    hasNusukAccount: (pilgrimData.nusuk && pilgrimData.nusuk.hasAccount) ? 'OUI' : (pilgrimData.hasNusukAccount === true || pilgrimData.hasNusukAccount === 'OUI' || pilgrimData.dejaClient ? 'OUI' : 'NON'),
    nusukAccountStatus: (pilgrimData.nusuk && pilgrimData.nusuk.verificationStatus) || pilgrimData.nusukAccountStatus || 'NON_VERIFIE',
    status: pilgrimData.status || pilgrimData.statut || 'CREE',
    adminNotes: pilgrimData.adminNotes || '[Inscription directe Hajj Suivi Nusuk]'
  };

  try {
    const res = await sendJsonRequest(baseUrl, 'POST', apiKey, payload, 10000);
    const remoteId = (res.data && (res.data.id || (res.data.data && res.data.data.id))) || null;
    console.log(`[SYNC-WRITE] Nouveau dossier créé avec succès sur Mon Omra (ID: ${remoteId}).`);
    return {
      success: true,
      statusCode: res.statusCode,
      id: remoteId,
      data: res.data
    };
  } catch (err) {
    console.warn(`[SYNC-WRITE WARN] Impossible de créer le pèlerin sur Mon Omra: ${err.message}`);
    return {
      success: false,
      error: err.message,
      statusCode: err.statusCode || null
    };
  }
}

/**
 * Exécute la synchronisation complète et applique l'UPSERT
 * @param {Array} pelerinsData - La liste vivante des pèlerins
 * @param {Function} savePelerins - La fonction de sauvegarde persistante
 * @param {Function} getNextAdvisor - La fonction d'attribution round-robin
 * @param {Object} options - Options { overrideUrl, overrideKey, forceAll: boolean }
 */
async function executeSync(pelerinsData, savePelerins, getNextAdvisor, options = {}) {
  const config = getConfig();
  const apiUrl = options.overrideUrl || config.apiUrl;
  const apiKey = options.overrideKey || config.apiKey;

  const state = loadSyncState();
  const sinceParam = options.forceAll ? null : state.lastSyncedAt;

  state.lastSyncStatus = 'SYNCING';
  state.lastSyncTimestamp = new Date().toISOString();
  saveSyncState(state);

  try {
    const apiResponse = await fetchFromApi(apiUrl, apiKey, sinceParam);
    const records = Array.isArray(apiResponse.data) ? apiResponse.data : [];

    let importedCount = 0;
    let updatedCount = 0;

    for (const raw of records) {
      const externalId = raw.id;
      const cleanEmail = (raw.email || '').trim().toLowerCase();
      const cleanPhone = (raw.phone || '').replace(/[^0-9]/g, '');

      // Détection des doublons : Rapprochement par ID externe OU email OU téléphone
      const existingIdx = pelerinsData.findIndex(p => {
        if (externalId && (p.sourceId === externalId || p.id === externalId)) return true;
        if (cleanEmail && p.email && p.email.toLowerCase() === cleanEmail) return true;
        if (cleanPhone && cleanPhone.length >= 8) {
          const pPhone = (p.phone || p.telephone || '').replace(/[^0-9]/g, '');
          if (pPhone && (pPhone.endsWith(cleanPhone) || cleanPhone.endsWith(pPhone))) return true;
        }
        return false;
      });

      const hasNusuk = raw.hasNusukAccount === 'OUI' || raw.hasNusukAccount === true;
      const verificationStatus = raw.nusukAccountStatus || (hasNusuk ? 'NON_VERIFIE' : 'NON_VERIFIE');

      if (existingIdx !== -1) {
        // --- MISE À JOUR (UPDATE) ---
        const target = pelerinsData[existingIdx];
        target.sourceId = target.sourceId || externalId;
        if (raw.peopleCount) target.peopleCount = parseInt(raw.peopleCount, 10) || target.peopleCount;
        if (raw.address) target.address = raw.address;
        if (raw.availabilitySlots) target.availabilitySlots = raw.availabilitySlots;
        if (raw.partnerAgency) target.provider = raw.partnerAgency;
        if (raw.hajjYear) target.hajjYear = raw.hajjYear;
        
        if (target.nusuk) {
          target.nusuk.hasAccount = hasNusuk;
          target.nusuk.rawHasAccount = hasNusuk ? 'OUI' : 'NON';
          if (raw.nusukAccountStatus) target.nusuk.verificationStatus = raw.nusukAccountStatus;
        }

        if (raw.dateEmission) target.dateEmission = raw.dateEmission;
        target.derniereMiseAJour = new Date().toISOString();
        updatedCount++;
      } else {
        // --- INSERTION (INSERT) ---
        const nextIndex = pelerinsData.length + 1;
        const refNumber = String(nextIndex).padStart(3, '0');
        const internalRef = `HAJJ-2026-${refNumber}`;
        const advisor = typeof getNextAdvisor === 'function' ? getNextAdvisor() : 'Conseiller 1';

        const firstName = raw.firstName || (raw.fullName ? raw.fullName.split(' ')[0] : 'Pèlerin');
        const familyName = raw.familyName || (raw.fullName ? raw.fullName.split(' ').slice(1).join(' ') : `${nextIndex}`);
        const fullName = raw.fullName || `${firstName} ${familyName}`;

        const isVerified = verificationStatus === 'VERIFIE';
        const etape = isVerified ? 'Packs' : (hasNusuk ? 'Documents' : 'Inscription');
        const statut = isVerified ? 'PACKS_VALIDES' : (hasNusuk ? 'EN_ATTENTE_DOCUMENTS' : 'CREE');
        const actionAttendue = isVerified ? 'Valider les 3 choix de packs' : (hasNusuk ? "Vérifier les pièces d'identité" : 'Créer le compte Nusuk');

        const newPelerin = {
          id: externalId || `mon-omra-${Date.now()}-${nextIndex}`,
          sourceId: externalId,
          referenceInterne: internalRef,
          firstName: firstName,
          familyName: familyName,
          fullName: fullName,
          nomComplet: fullName,
          nationality: raw.nationality || 'Française',
          phone: raw.phone || '+33600000000',
          telephone: raw.phone || '+33600000000',
          email: cleanEmail,
          emailContact: cleanEmail,
          address: raw.address || 'Non renseignée',
          peopleCount: parseInt(raw.peopleCount, 10) || 1,
          hajjYear: raw.hajjYear || 2027,
          provider: raw.partnerAgency || 'Yusr Al Mashaer',
          availabilitySlots: raw.availabilitySlots || 'Soirée (18h-21h)',
          nusuk: {
            hasAccount: hasNusuk,
            rawHasAccount: hasNusuk ? 'OUI' : 'NON',
            accountYear: raw.nusukAccountYear || '2026_2027',
            verificationStatus: verificationStatus
          },
          etape: etape,
          statut: statut,
          statutProvenance: 'MON_OMRA_API',
          actionAttendue: actionAttendue,
          severiteAction: isVerified ? 'NORMALE' : 'URGENTE',
          conseiller: advisor,
          conseillerNom: advisor,
          statutPaiement: 'EN_ATTENTE',
          tarifType: 'STANDARD',
          tarifMontantEur: 390,
          montantPaye: 0,
          dateEmission: raw.dateEmission || raw.createdAt || new Date().toISOString(),
          creeLe: new Date().toISOString(),
          urgent: !isVerified,
          bloque: false,
          adminNotes: raw.adminNotes || '[Synchronisé depuis l\'API Mon Omra]'
        };

        pelerinsData.unshift(newPelerin);
        importedCount++;
      }
    }

    if (importedCount > 0 || updatedCount > 0) {
      if (typeof savePelerins === 'function') {
        savePelerins();
      }
    }

    // Mise à jour finale de l'état
    state.lastSyncedAt = apiResponse.syncedAt || new Date().toISOString();
    state.lastSyncStatus = 'SUCCESS';
    state.lastSyncTimestamp = new Date().toISOString();
    state.importedCount = importedCount;
    state.updatedCount = updatedCount;
    state.totalSyncedToDate += importedCount;
    state.lastError = null;
    saveSyncState(state);

    console.log(`[SYNC SUCCESS] ${importedCount} nouveau(x) dossier(s) importé(s), ${updatedCount} mis à jour.`);

    return {
      success: true,
      importedCount,
      updatedCount,
      totalRecordsReceived: records.length,
      syncedAt: state.lastSyncedAt
    };

  } catch (err) {
    console.error('[SYNC ERROR]', err.message);
    state.lastSyncStatus = 'ERROR';
    state.lastSyncTimestamp = new Date().toISOString();
    state.lastError = err.message;
    saveSyncState(state);

    return {
      success: false,
      error: err.message,
      lastSyncedAt: state.lastSyncedAt
    };
  }
}

module.exports = {
  loadSyncState,
  saveSyncState,
  executeSync,
  getConfig,
  updatePilgrimOnMonOmra,
  createPilgrimOnMonOmra,
  sendJsonRequest
};
