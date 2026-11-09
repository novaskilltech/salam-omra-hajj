# Architecture Technique & Scaffolding Lot 1
**Projet** : Assistance Hajj - Centre de suivi et gestion des emails Nusuk  
**Organisation** : Salam Omra (Farem Voyage LLC)  
**Statut** : Scaffolding Non Exécutable (DoR OK-with-risks)  

---

## 1. Arborescence du Dépôt

```
HAJJ SUIVI NUSUK/
├── CDC_Hajj_Suivi_Nusuk_v0_1.pdf         # Spécification initiale de référence
├── Tableau de bord d’assistance Hajj.png  # Maquette UI de référence (SCR01)
├── api/
│   └── contracts/
│       └── openapi.json                  # Spécifications OpenAPI 3.0 des endpoints
├── config/
│   └── app.config.example.json           # Template de configuration sans secrets
├── docs/
│   └── ARCHITECTURE.md                   # Ce document
├── schema/
│   └── database.sql                      # Schéma DDL PostgreSQL (18 entités)
└── shared/
    └── types.ts                          # Types TypeScript stricts du domaine
```

---

## 2. Pipeline d'Ingestion & Politique Sécurité "Zéro-OTP"

```
[ Fournisseur Gmail / Outlook ]
               │
               ▼ (Webhook / PubSub)
     [ /api/v1/ingestion ]
               │
               ▼ (Vérification signature & expéditeur officiel)
    [ Sanitizer Synchrone ] ──▶ SUPPRESSION IMMÉDIATE des codes OTP & Magic Links
               │
               ▼ (Contenu expurgé uniquement)
  [ Déduplication message_id ]
               │
               ▼
 [ Base PostgreSQL (Table evenements_emails_expurges) ]
               │
               ▼
   [ Création Tâches & Refresh Dashboard Websocket ]
```

---

## 3. Matrice de Traçabilité des Critères de Recette (AC01 - AC20)

| Critère CDC | Implémentation dans le Scaffolding |
| :--- | :--- |
| **AC01** (Email connu/attribué) | Clés étrangères `dossiers(id)` et `pelerins(id)` dans `schema/database.sql`. |
| **AC02** (Idempotence 3x) | Contrainte unique `uq_message_fournisseur` sur `(connexion_messagerie_id, message_id_fournisseur)`. |
| **AC03** (Homonymes) | Clés primaires UUID stables, attribution par référence dossier et non par nom de famille. |
| **AC05** (Zéro fuite OTP) | Élimination par `Sanitizer`, exclusion absolue des colonnes secrets dans `schema/database.sql`. |
| **AC09** (Révocation OAuth) | Champ `expiration_token_le` et statut inactif immédiat sans rétention de token en DB. |
| **AC14** (Anti-IDOR) | Rôles RBAC et isolation stricte par `organisation_id` et `conseiller_responsable_id`. |
| **AC16** (Verrou de collision) | Champs `verrouille_par_id` et `verrouille_jusqua` dans la table `taches`. |
