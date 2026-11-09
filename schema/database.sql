-- =====================================================================
-- SCHEMA RELATIONNEL POSTGRESQL - CENTRE DE SUIVI HAJJ (OMRAYANAIR)
-- Statut : Scaffolding DDL (Plan Lot 1) - DoR OK-with-risks
-- =====================================================================

-- Enums métier
CREATE TYPE role_utilisateur AS ENUM (
    'PELERIN', 
    'CONSEILLER', 
    'COORDINATEUR', 
    'ADMIN_TECHNIQUE'
);

CREATE TYPE statut_dossier AS ENUM (
    'CREE',
    'EN_ATTENTE_DOCUMENTS',
    'DOCUMENTS_VERIFIES',
    'WALLET_A_CREDITER',
    'WALLET_CONFIRME',
    'PACKS_VALIDES',
    'PRET_POUR_VENTE',
    'ACHAT_CONFIRME',
    'CLOTURE',
    'BLOQUE'
);

CREATE TYPE severite_tache AS ENUM (
    'BASSE', 
    'NORMALE', 
    'URGENTE', 
    'CRITIQUE'
);

CREATE TYPE statut_tache AS ENUM (
    'A_TRAITER', 
    'EN_COURS', 
    'RESOLUE', 
    'ESCALADEE'
);

CREATE TYPE type_evenement_email AS ENUM (
    'OTP_OU_AUTH',
    'DOSSIER_RECU',
    'DOSSIER_VALIDE',
    'DOSSIER_REFUSE',
    'PIECES_COMPLEMENTAIRES',
    'CREDIT_WALLET_CONFIRME',
    'PAIEMENT_ECHOUE',
    'RETRAIT_DEMANDE',
    'RETRAIT_CONFIRME',
    'PACKS_ANNONCES',
    'OUVERTURE_VENTE_ANNONCEE',
    'ACHAT_CONFIRME',
    'AUTRE_A_REVISER'
);

CREATE TYPE source_statut AS ENUM (
    'DECLARE_PAR_CLIENT',
    'DETECTE_EMAIL',
    'CONTROLE_CONSEILLER'
);

-- 1. Organisations & Utilisateurs (RBAC)
CREATE TABLE organisations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nom VARCHAR(255) NOT NULL,
    cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE utilisateurs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    email VARCHAR(255) UNIQUE NOT NULL,
    nom VARCHAR(100) NOT NULL,
    prenom VARCHAR(100) NOT NULL,
    role role_utilisateur NOT NULL,
    mfa_active BOOLEAN NOT NULL DEFAULT FALSE,
    actif BOOLEAN NOT NULL DEFAULT TRUE,
    cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Pèlerins & Groupes Familiaux
CREATE TABLE groupes_familiaux (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    nom_famille VARCHAR(150) NOT NULL,
    cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE pelerins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    utilisateur_id UUID REFERENCES utilisateurs(id) ON DELETE SET NULL,
    groupe_familial_id UUID REFERENCES groupes_familiaux(id) ON DELETE SET NULL,
    nom VARCHAR(100) NOT NULL,
    prenom VARCHAR(100) NOT NULL,
    telephone VARCHAR(30),
    email_contact VARCHAR(255) NOT NULL,
    cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Dossiers d'Assistance Hajj
CREATE TABLE dossiers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reference_interne VARCHAR(50) UNIQUE NOT NULL, -- Ex: HAJJ-2026-001
    organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    pelerin_id UUID NOT NULL REFERENCES pelerins(id) ON DELETE RESTRICT,
    conseiller_responsable_id UUID REFERENCES utilisateurs(id) ON DELETE SET NULL,
    compte_nusuk_declare VARCHAR(255),
    statut statut_dossier NOT NULL DEFAULT 'CREE',
    statut_provenance source_statut NOT NULL DEFAULT 'DECLARE_PAR_CLIENT',
    bloque BOOLEAN NOT NULL DEFAULT FALSE,
    motif_blocage TEXT,
    cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    mis_a_jour_le TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Connexions Messagerie (OAuth - Tokens chiffrés hors DB applicative principale)
CREATE TABLE connexions_messagerie (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dossier_id UUID NOT NULL REFERENCES dossiers(id) ON DELETE CASCADE,
    fournisseur VARCHAR(50) NOT NULL, -- 'GMAIL' ou 'OUTLOOK'
    adresse_email_connectee VARCHAR(255) NOT NULL,
    actif BOOLEAN NOT NULL DEFAULT TRUE,
    derniere_sync_le TIMESTAMPTZ,
    expiration_token_le TIMESTAMPTZ,
    reference_secret_coffre VARCHAR(255) NOT NULL, -- ID dans KMS/Vault (AUCUN secret en clair ici)
    cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Événements Emails Expurgés (Conformité RGPD & Zéro-OTP stricte)
CREATE TABLE evenements_emails_expurges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connexion_messagerie_id UUID NOT NULL REFERENCES connexions_messagerie(id) ON DELETE CASCADE,
    dossier_id UUID REFERENCES dossiers(id) ON DELETE SET NULL,
    message_id_fournisseur VARCHAR(255) NOT NULL, -- Pour déduplication (AC02)
    type_evenement type_evenement_email NOT NULL,
    expediteur_verifie VARCHAR(255) NOT NULL,
    date_reception_email TIMESTAMPTZ NOT NULL,
    date_operation_declaree TIMESTAMPTZ,
    donnees_extraites JSONB NOT NULL DEFAULT '{}'::jsonb, -- Champs structurés expurgés
    extrait_preuve_expurge TEXT, -- Strictement sans OTP, lien de reset ni token
    mis_en_quarantaine BOOLEAN NOT NULL DEFAULT FALSE,
    motif_quarantaine VARCHAR(255),
    cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_message_fournisseur UNIQUE (connexion_messagerie_id, message_id_fournisseur)
);

-- 6. Observations Wallet (RB03 - Suivi observationnel, pas de faux solde calculé)
CREATE TABLE observations_wallet (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dossier_id UUID NOT NULL REFERENCES dossiers(id) ON DELETE CASCADE,
    evenement_email_id UUID REFERENCES evenements_emails_expurges(id) ON DELETE SET NULL,
    type_mouvement VARCHAR(50) NOT NULL, -- 'CREDIT_DEMANDE', 'CREDIT_CONFIRME', 'RETRAIT_DEMANDE', 'RETRAIT_CONFIRME'
    montant NUMERIC(10, 2),
    devise VARCHAR(10) DEFAULT 'SAR',
    solde_observe_explicite NUMERIC(10, 2), -- Rempli UNIQUEMENT si explicitement mentionné dans l'email
    date_operation TIMESTAMPTZ NOT NULL,
    statut_provenance source_statut NOT NULL DEFAULT 'DETECTE_EMAIL',
    cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Préférences & Choix des Packs (RB05 - 3 choix max + plafond approuvé)
CREATE TABLE choix_packs_dossier (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dossier_id UUID NOT NULL REFERENCES dossiers(id) ON DELETE CASCADE,
    priorite INT NOT NULL CHECK (priorite BETWEEN 1 AND 3), -- 1er, 2ème ou 3ème choix
    nom_pack VARCHAR(255) NOT NULL,
    categorie VARCHAR(100),
    prix_estime NUMERIC(10, 2),
    plafond_depense_valide NUMERIC(10, 2) NOT NULL,
    approuve_par_client_le TIMESTAMPTZ,
    version_approbation INT NOT NULL DEFAULT 1,
    invalide_suite_changement BOOLEAN NOT NULL DEFAULT FALSE,
    cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. Tâches Opérationnelles & File de travail
CREATE TABLE taches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dossier_id UUID NOT NULL REFERENCES dossiers(id) ON DELETE CASCADE,
    evenement_source_id UUID REFERENCES evenements_emails_expurges(id) ON DELETE SET NULL,
    conseiller_attribue_id UUID REFERENCES utilisateurs(id) ON DELETE SET NULL,
    titre VARCHAR(255) NOT NULL,
    description TEXT,
    severite severite_tache NOT NULL DEFAULT 'NORMALE',
    statut statut_tache NOT NULL DEFAULT 'A_TRAITER',
    verrouille_par_id UUID REFERENCES utilisateurs(id) ON DELETE SET NULL,
    verrouille_jusqua TIMESTAMPTZ, -- Anti-collision entre conseillers (AC16)
    date_echeance TIMESTAMPTZ,
    cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolu_le TIMESTAMPTZ
);

-- 9. Journal d'Audit Immuable (Traçabilité légale & RGPD)
CREATE TABLE journal_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    utilisateur_id UUID REFERENCES utilisateurs(id) ON DELETE SET NULL,
    entite_cible VARCHAR(100) NOT NULL,
    entite_id UUID NOT NULL,
    action VARCHAR(100) NOT NULL, -- 'LECTURE', 'MODIFICATION', 'REVOCATION_OAUTH', 'EXPURGATION_OTP', etc.
    details_modifications JSONB,
    adresse_ip VARCHAR(45),
    cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index critiques pour la performance et l'isolation
CREATE INDEX idx_dossiers_organisation ON dossiers(organisation_id);
CREATE INDEX idx_dossiers_conseiller ON dossiers(conseiller_responsable_id);
CREATE INDEX idx_evenements_dossier ON evenements_emails_expurges(dossier_id);
CREATE INDEX idx_taches_dossier ON taches(dossier_id);
CREATE INDEX idx_taches_conseiller_statut ON taches(conseiller_attribue_id, statut);
CREATE INDEX idx_journal_audit_entite ON journal_audit(entite_cible, entite_id);
