import { jwtVerify, createRemoteJWKSet } from 'jose';

export async function verifySessionJWT(token:string, aud:string, jwksUrl:string){
  const JWKS = createRemoteJWKSet(new URL(jwksUrl));
  const { payload } = await jwtVerify(token, JWKS, { audience: aud });
  return payload;
}
