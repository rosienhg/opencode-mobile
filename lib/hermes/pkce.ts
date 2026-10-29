import { base64url } from '@scure/base';
import * as Crypto from 'expo-crypto';

// RFC 7636 PKCE with the same parameters MyHermit uses: a 32-byte verifier,
// base64url without padding, and an S256 challenge.
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const bytes = Crypto.getRandomValues(new Uint8Array(32));
  // @scure/base keeps RFC 4648 padding; PKCE verifiers must be unpadded.
  const verifier = base64url.encode(bytes).replace(/=+$/, '');
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 });
  // digestStringAsync(BASE64) returns standard base64; re-spell it as base64url
  // without padding to match the S256 challenge format Hermes expects.
  const challenge = digest.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier, challenge };
}
