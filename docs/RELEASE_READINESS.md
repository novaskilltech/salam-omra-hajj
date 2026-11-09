# Dossier de Release Readiness - Assistance Hajj Nusuk (Lot 1)
**Commanditaire** : La Agence salamomra / Salah Eddine Lamkhannet  
**Version** : v0.1.0-RC1  
**Gate B - Release Readiness**  

---

## 1. Revue & Verdicts par Rôle (Gate B)

### QA (Quality Assurance) : 🟢 OK
- **Motif** : Couverture intégrale des critères AC01, AC02 (idempotence doublons), AC05 (neutralisation OTP), AC18 (76 dossiers synthétiques).
- **Actions** :
  - Rejeu continu du script `tests/run-tests.js` en pré-déploiement.
  - Phase pilote recommandée avec 5 à 10 dossiers volontaires avant ouverture complète.

### SEC (Sécurité & Antifraude) : 🟢 OK-with-risks
- **Motif** : Absence totale de stockage d'OTP ou de secrets en base de données applicative (`evenements_emails_expurges` sans colonne secret). Sanitizer actif en amont de toute persistance.
- **Risque résiduel** : La validation formelle OAuth Google (Restricted Scopes pour lecture de messagerie) exige un audit CASA Tier 2 avant mise en production grand public ouverte.
- **Actions** :
  - Conserver le mode test/interne GCP avec comptes déclarés pendant la phase pilote.
  - Activer la journalisation WAF et la limitation de débit (rate limiting) sur l'endpoint `/api/v1/ingestion/webhook`.

### DPO (Protection des Données & RGPD) : 🟢 OK-with-risks
- **Motif** : Stricte minimisation respectée. Les emails hors périmètre `nusuk.sa` sont purgés sans conservation du corps brut (AC06). Le corps brut d'email utile n'est pas persistant.
- **Risque résiduel** : Registre des traitements et DPA avec les sous-traitants d'hébergement à formaliser avant chargement des vraies pièces d'identité (passeports des 76 pèlerins).
- **Actions** :
  - Formaliser le consentement explicite du pèlerin lors de la liaison de sa boîte mail (SCR06).
  - Définir le cycle de purge automatique des extraits à Clôture + 90 jours (AC20).

### DEVOPS (Infrastructure & Observabilité) : 🟢 OK
- **Motif** : Application légère, conteneurisable, sans dépendances lourdes, configuration externalisée via variables d'environnement (`PORT`, etc.).
- **Actions** :
  - Mettre en place un reverse-proxy (Nginx / Cloud Run / Traefik) avec TLS 1.3 et en-têtes de sécurité HSTS.
  - Alerter sur métrique d'erreurs 5xx et latence de traitement webhook > 60s (AC18).

### LEGAL (Droit du Produit & Prestation) : 🟢 OK-with-risks
- **Motif** : Découplage strict entre les 250 € d'honoraires de Agence et les fonds du pèlerinage Hajj (RB11). Pas de promesse illégale de place ou de visa garanti (RB13).
- **Risque résiduel** : Les CGV de la Agence doivent explicitement mentionner l'obligation de moyens (et non de résultat) concernant l'obtention d'un pack lors des ouvertures de vente Nusuk.
- **Actions** :
  - Faire valider le texte des CGV/CGU affiché aux pèlerins avant encaissement des premiers 250 €.

### MOB (Stores & Mobile) : ⚪ NON APPLICABLE (V1 Web Responsive)
- **Motif** : L'application V1 est une Web App responsive (ordinateur et mobile) ; aucune soumission Apple App Store ou Google Play Store requise pour ce jalon.

---

## 2. Procédure de Déploiement & Runbook Opérationnel

### A. Démarrage & Variables d'Environnement
```bash
# Variables minimales requises
PORT=3002
NODE_ENV=production
APP_SECRET_KEY=***
GCP_PUB_SUB_TOPIC=projects/salamomra-hajj/topics/gmail-notifications
```

### B. Plan de Rollback Immédiat
1. En cas de dysfonctionnement du parseur ou d'erreur sur l'ingestion :
   - Basculer le flag `INGESTION_SUSPENDED=true` : les webhooks sont acquittés en file de stockage tampon (DLQ) sans mise à jour des dossiers.
   - Les conseillers continuent de travailler en mode manuel sécurisé sans régression d'état (RB04).
2. Retour à la version antérieure (tag Git `v0.1.0-stable`) en moins de 3 minutes via le pipeline CI/CD.

### C. Supervision & SLO
- **SLO Latence Ingestion** : 95 % des événements traités en < 60s après réception du webhook.
- **SLO Disponibilité** : 99.5 % pendant les créneaux d'ouverture de vente officielle Nusuk.
- **Alerte Critique** : Perte de connectivité OAuth ou expiration de token $\rightarrow$ Notification prioritaire coordinateur.
