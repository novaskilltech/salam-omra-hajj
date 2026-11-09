/**
 * TYPES DE DONNÉES ET CONTRATS DOMAINE - SUIVI HAJJ NUSUK
 * Statut : Scaffolding TypeScript (Plan Lot 1) - DoR OK-with-risks
 */

export type RoleUtilisateur = 'PELERIN' | 'CONSEILLER' | 'COORDINATEUR' | 'ADMIN_TECHNIQUE';

export type StatutDossier = 
  | 'CREE'
  | 'EN_ATTENTE_DOCUMENTS'
  | 'DOCUMENTS_VERIFIES'
  | 'WALLET_A_CREDITER'
  | 'WALLET_CONFIRME'
  | 'PACKS_VALIDES'
  | 'PRET_POUR_VENTE'
  | 'ACHAT_CONFIRME'
  | 'CLOTURE'
  | 'BLOQUE';

export type SeveriteTache = 'BASSE' | 'NORMALE' | 'URGENTE' | 'CRITIQUE';

export type StatutTache = 'A_TRAITER' | 'EN_COURS' | 'RESOLUE' | 'ESCALADEE';

export type SourceStatut = 'DECLARE_PAR_CLIENT' | 'DETECTE_EMAIL' | 'CONTROLE_CONSEILLER';

export type TypeEvenementEmail = 
  | 'OTP_OU_AUTH'
  | 'DOSSIER_RECU'
  | 'DOSSIER_VALIDE'
  | 'DOSSIER_REFUSE'
  | 'PIECES_COMPLEMENTAIRES'
  | 'CREDIT_WALLET_CONFIRME'
  | 'PAIEMENT_ECHOUE'
  | 'RETRAIT_DEMANDE'
  | 'RETRAIT_CONFIRME'
  | 'PACKS_ANNONCES'
  | 'OUVERTURE_VENTE_ANNONCEE'
  | 'ACHAT_CONFIRME'
  | 'AUTRE_A_REVISER';

export interface Pelerin {
  id: string;
  nom: string;
  prenom: string;
  telephone?: string;
  emailContact: string;
  groupeFamilialId?: string;
}

export interface DossierSuivi {
  id: string;
  referenceInterne: string; // Ex: "HAJJ-2026-001"
  pelerin: Pelerin;
  conseillerResponsableId?: string;
  compteNusukDeclare?: string;
  statut: StatutDossier;
  statutProvenance: SourceStatut;
  bloque: boolean;
  motifBlocage?: string;
  creeLe: string;
  misAJourLe: string;
}

export interface EvenementEmailExpurge {
  id: string;
  connexionMessagerieId: string;
  dossierId?: string;
  messageIdFournisseur: string; // Idempotence (AC02)
  typeEvenement: TypeEvenementEmail;
  expediteurVerifie: string;
  dateReceptionEmail: string;
  dateOperationDeclaree?: string;
  donneesExtraites: Record<string, unknown>;
  extraitPreuveExpurge?: string; // Strictement sans secrets
  misEnQuarantaine: boolean;
  motifQuarantaine?: string;
}

export interface ObservationWallet {
  id: string;
  dossierId: string;
  typeMouvement: 'CREDIT_DEMANDE' | 'CREDIT_CONFIRME' | 'RETRAIT_DEMANDE' | 'RETRAIT_CONFIRME';
  montant?: number;
  devise: string;
  soldeObserveExplicite?: number; // Aucun calcul silencieux (RB03)
  dateOperation: string;
  statutProvenance: SourceStatut;
}

export interface ChoixPack {
  priorite: 1 | 2 | 3;
  nomPack: string;
  categorie?: string;
  prixEstime?: number;
  plafondDepenseValide: number;
  approuveParClientLe?: string;
  versionApprobation: number;
  invalideSuiteChangement: boolean;
}

export interface Tache {
  id: string;
  dossierId: string;
  evenementSourceId?: string;
  conseillerAttribueId?: string;
  titre: string;
  description?: string;
  severite: SeveriteTache;
  statut: StatutTache;
  verrouilleParId?: string;
  verrouilleJusqua?: string;
  dateEcheance?: string;
  creeLe: string;
  resoluLe?: string;
}

// Contrats DTO pour l'écran SCR01 Dashboard (Maquette UI)
export interface DashboardStatsDto {
  totalPelerinsInscrits: number; // 76
  totalDossiersPrets: number;     // 58
  totalActionsATraiter: number;   // 12
  totalDossiersBloques: number;   // 6
  progressionVente: {
    pourcentageComptesValides: number;
    pourcentageWalletsPrets: number;
    pourcentageChoixApprouves: number;
  };
  prochaineVenteTexte: string; // "date officielle à confirmer"
}

export interface DossierResumeDto {
  dossierId: string;
  pelerinNomComplet: string; // Ex: "Amine B."
  etape: 'Inscription' | 'Documents' | 'Wallet' | 'Packs';
  actionAttendue: string;
  severiteAction: SeveriteTache;
  conseillerNom: string;
  urgent: boolean;
}

export interface EvenementRecentDto {
  id: string;
  titre: string;
  description: string;
  horodatageRelatif: string; // Ex: "Aujourd'hui 10:24"
  actionRequisePar?: 'CONSEILLER' | 'COORDINATEUR' | 'PELERIN';
}

export interface ConseillerConnecteurDto {
  id: string;
  nom: string;
  disponible: boolean;
  fournisseurMessagerie: 'GMAIL' | 'OUTLOOK';
  connecte: boolean;
}

// DTO pour le formulaire public d'inscription pèlerin (SCR06-A)
export interface InscriptionPelerinDto {
  nom: string;
  prenom: string;
  emailContact: string;
  telephone: string;
  statutNusuk: 'NON_INSCRIT' | 'INSCRIT_A_VERIFIER' | 'INSCRIT_VALIDE';
  compteNusukDeclare?: string;
  nomFamille?: string;
  accepteCgv: boolean;
  accepteRgpd: boolean;
}

export interface InscriptionReponseDto {
  success: boolean;
  dossierId: string;
  referenceInterne: string;
  conseillerAttribue: string;
  lienPaiementStripe?: string;
  message: string;
}

