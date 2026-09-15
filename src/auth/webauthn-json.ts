/**
 * The WebAuthn Level 3 JSON forms the organiser sign-in exchange carries.
 *
 * Declared here, with no import, because they appear in the published router
 * type (`@kippurocks/api`): a client must compile against them without the server's
 * WebAuthn library. They mirror the JSON that browser helpers such as
 * `@simplewebauthn/browser` consume and produce.
 */

/** Unpadded base64url. */
export type Base64URLString = string;

export type AuthenticatorTransport =
  | "ble"
  | "cable"
  | "hybrid"
  | "internal"
  | "nfc"
  | "smart-card"
  | "usb";

export interface PublicKeyCredentialDescriptorJSON {
  id: Base64URLString;
  type: "public-key";
  transports?: AuthenticatorTransport[];
}

/** What `navigator.credentials.create` needs, as JSON. */
export interface PublicKeyCredentialCreationOptionsJSON {
  rp: { id?: string; name: string };
  user: { id: Base64URLString; name: string; displayName: string };
  challenge: Base64URLString;
  pubKeyCredParams: { alg: number; type: "public-key" }[];
  timeout?: number;
  excludeCredentials?: PublicKeyCredentialDescriptorJSON[];
  authenticatorSelection?: {
    authenticatorAttachment?: "cross-platform" | "platform";
    requireResidentKey?: boolean;
    residentKey?: "discouraged" | "preferred" | "required";
    userVerification?: "discouraged" | "preferred" | "required";
  };
  attestation?: "direct" | "enterprise" | "indirect" | "none";
}

/** What `navigator.credentials.get` needs, as JSON. */
export interface PublicKeyCredentialRequestOptionsJSON {
  challenge: Base64URLString;
  timeout?: number;
  rpId?: string;
  allowCredentials?: PublicKeyCredentialDescriptorJSON[];
  userVerification?: "discouraged" | "preferred" | "required";
}

/** The result of `navigator.credentials.create`, as JSON. */
export interface RegistrationResponseJSON {
  id: Base64URLString;
  rawId: Base64URLString;
  type: "public-key";
  response: {
    clientDataJSON: Base64URLString;
    attestationObject: Base64URLString;
    authenticatorData?: Base64URLString;
    transports?: string[];
    publicKeyAlgorithm?: number;
    publicKey?: Base64URLString;
  };
  authenticatorAttachment?: "cross-platform" | "platform";
  /**
   * Extension outputs. Typed loosely, so that browser helpers' own interfaces —
   * which declare known extensions and no index signature — are accepted.
   */
  clientExtensionResults: object;
}

/** The result of `navigator.credentials.get`, as JSON. */
export interface AuthenticationResponseJSON {
  id: Base64URLString;
  rawId: Base64URLString;
  type: "public-key";
  response: {
    clientDataJSON: Base64URLString;
    authenticatorData: Base64URLString;
    signature: Base64URLString;
    userHandle?: Base64URLString;
  };
  authenticatorAttachment?: "cross-platform" | "platform";
  /**
   * Extension outputs. Typed loosely, so that browser helpers' own interfaces —
   * which declare known extensions and no index signature — are accepted.
   */
  clientExtensionResults: object;
}
