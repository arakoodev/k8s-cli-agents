import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';

const secret = new TextEncoder().encode(process.env.SESSION_JWT_SECRET || 'dev-secret-change-me');

export async function createSessionJWT(opts:{sub:string;sid:string;aud:string;expSec:number}){
  const { sub, sid, aud, expSec } = opts;
  const now = Math.floor(Date.now()/1000);
  const jti = randomUUID();
  return await new SignJWT({ sid })
    .setProtectedHeader({ alg:'HS256', typ:'JWT' })
    .setSubject(sub).setAudience(aud).setJti(jti)
    .setIssuedAt(now).setExpirationTime(now+expSec)
    .sign(secret);
}
export async function verifySessionJWT(token:string, aud:string){
  const { payload } = await jwtVerify(token, secret, { audience: aud });
  return payload;
}
