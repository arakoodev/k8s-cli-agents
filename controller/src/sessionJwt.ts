import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createPublicKey, createPrivateKey } from 'node:crypto';
import { exportJWK } from 'jose';

let privateKey:any;
let jwks:any;

async function getKey(){
  if (privateKey) return privateKey;
  const pem = await fs.readFile(process.env.JWT_PRIVATE_KEY_PATH || '/run/secrets/jwt/private.pem', 'utf-8');
  privateKey = createPrivateKey(pem);
  return privateKey;
}

export async function getJWKS(){
  if (jwks) return jwks;
  const key = await getKey();
  const publicKey = createPublicKey(key);
  const jwk = await exportJWK(publicKey);
  jwks = { keys: [{ ...jwk, kid: '1', alg: 'RS256', use: 'sig' }] };
  return jwks;
}

export async function createSessionJWT(opts:{sub:string;sid:string;aud:string;expSec:number}){
  const { sub, sid, aud, expSec } = opts;
  const now = Math.floor(Date.now()/1000);
  const jti = randomUUID();
  const key = await getKey();

  return {
    jti,
    token: await new SignJWT({ sid })
      .setProtectedHeader({ alg:'RS256', typ:'JWT', kid:'1' })
      .setSubject(sub).setAudience(aud).setJti(jti)
      .setIssuedAt(now).setExpirationTime(now+expSec)
      .sign(key)
  };
}

export async function verifySessionJWT(token:string, aud:string, jwksUrl:string){
  const JWKS = createRemoteJWKSet(new URL(jwksUrl));
  const { payload } = await jwtVerify(token, JWKS, { audience: aud });
  return payload;
}