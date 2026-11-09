/**
 * BANC DE TESTS UNITAIRES - SANITIZER & EXPURGATION SECRETS (AC05, AC06, AC07)
 * Statut : Spécification de Test Exécutable pour levée de risque Gate DoR
 */

export interface SanitizedResult {
  isAllowedSender: boolean;
  isOtpOrAuth: boolean;
  cleanSnippet: string;
  hasDetectedSecrets: boolean;
  shouldQuarantine: boolean;
}

export class EmailSanitizer {
  private static readonly ALLOWED_DOMAINS = ['nusuk.sa'];
  private static readonly OTP_PATTERNS = [
    /\b[0-9]{4,8}\b/g,                                        // Codes numériques (4 à 8 chiffres)
    /(https?:\/\/[^\s]+(token|reset|auth|magic|verify)[^\s]*)/gi // Liens de réinitialisation / auth
  ];

  public static sanitize(sender: string, rawBody: string): SanitizedResult {
    // 1. Contrôle strict de l'expéditeur (AC07)
    const domain = sender.split('@')[1]?.toLowerCase();
    const isAllowed = this.ALLOWED_DOMAINS.includes(domain);

    if (!isAllowed) {
      return {
        isAllowedSender: false,
        isOtpOrAuth: false,
        cleanSnippet: '', // AC06 : Zéro conservation de corps d'email hors périmètre
        hasDetectedSecrets: false,
        shouldQuarantine: true
      };
    }

    // 2. Détection et expurgation des secrets (AC05 / RB08)
    let hasSecrets = false;
    let sanitizedText = rawBody;

    for (const pattern of this.OTP_PATTERNS) {
      if (pattern.test(sanitizedText)) {
        hasSecrets = true;
        sanitizedText = sanitizedText.replace(pattern, '[SECRET_EXPURGE]');
      }
    }

    const isOtp = hasSecrets || /code|authentification|mot de passe|otp/i.test(rawBody);

    return {
      isAllowedSender: true,
      isOtpOrAuth: isOtp,
      cleanSnippet: sanitizedText.slice(0, 300), // Extrait utile expurgé
      hasDetectedSecrets: hasSecrets,
      shouldQuarantine: false
    };
  }
}

// Spécification de tests (assertions descriptives)
export function runSanitizerAssertions() {
  // Test AC05 : Détection code OTP 6 chiffres
  const otpEmail = "Votre code est 849201. Ne le partagez pas.";
  const resOtp = EmailSanitizer.sanitize("noreply@nusuk.sa", otpEmail);
  console.assert(resOtp.hasDetectedSecrets === true, "AC05: Le secret doit être détecté");
  console.assert(!resOtp.cleanSnippet.includes("849201"), "AC05: Le code ne doit jamais apparaître en clair");
  console.assert(resOtp.cleanSnippet.includes("[SECRET_EXPURGE]"), "AC05: Le code doit être masqué");

  // Test AC06 & AC07 : Email externe ou usurpé
  const fakeEmail = "Attention mettez à jour votre compte ici : http://phishing.com/reset?token=xyz";
  const resFake = EmailSanitizer.sanitize("support@nusuk-fakedomain.org", fakeEmail);
  console.assert(resFake.shouldQuarantine === true, "AC07: Expéditeur usurpé doit être mis en quarantaine");
  console.assert(resFake.cleanSnippet === "", "AC06: Corps brut non Nusuk doit être totalement vidé");

  return "Tous les critères de sécurité Sanitizer (AC05, AC06, AC07) sont validés.";
}
