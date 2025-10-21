import http from 'http';
import WebSocket from 'ws';
import { app } from '../server'; // Assuming server exports app
import { pool } from '../db';
import * as jose from 'jose';

let server: http.Server;
let port: number;

// We need a real key for JWT signing in tests
let privateKey: jose.KeyLike;
let jwksHost: string;

describe('WebSocket Gateway', () => {
    beforeAll(async () => {
        const { privateKey: pk, publicKey } = await jose.generateKeyPair('RS256');
        privateKey = pk;

        // Mock JWKS endpoint
        const jwksApp = express();
        jwksApp.get('/.well-known/jwks.json', async (req, res) => {
            res.json({ keys: [(await jose.exportJWK(publicKey))] });
        });
        const jwksServer = jwksApp.listen(0);
        jwksHost = `http://localhost:${(jwksServer.address() as any).port}`;
        process.env.CONTROLLER_URL = jwksHost;
    });

    beforeEach((done) => {
        server = app.listen(0, () => {
            port = (server.address() as any).port;
            done();
        });
    });

    afterEach((done) => {
        server.close(done);
    });

    async function generateTestJWT(sessionId: string, jti: string) {
        return await new jose.SignJWT({ sid: sessionId, aud: 'ws' })
            .setProtectedHeader({ alg: 'RS256' })
            .setJti(jti)
            .setSubject('test-user')
            .setIssuedAt()
            .setExpirationTime('1m')
            .sign(privateKey);
    }

    it('should allow a valid WebSocket connection', async () => {
        const sessionId = 'test-session-1';
        const jti = 'test-jti-1';
        const token = await generateTestJWT(sessionId, jti);

        // Setup the database state
        await pool.query('INSERT INTO sessions (session_id, pod_ip) VALUES ($1, $2)', [sessionId, '1.2.3.4']);
        await pool.query('INSERT INTO token_jti (jti, session_id) VALUES ($1, $2)', [jti, sessionId]);

        const ws = new WebSocket(`ws://localhost:${port}/ws/${sessionId}`, {
            headers: { 'Sec-WebSocket-Protocol': `bearer,${token}` }
        });

        await new Promise((resolve, reject) => {
            ws.on('open', resolve);
            ws.on('error', reject);
        });

        ws.close();
    });

    it('should reject a connection with a replayed JTI', async () => {
        const sessionId = 'test-session-2';
        const jti = 'test-jti-2';
        const token = await generateTestJWT(sessionId, jti);

        await pool.query('INSERT INTO sessions (session_id, pod_ip) VALUES ($1, $2)', [sessionId, '1.2.3.4']);
        await pool.query('INSERT INTO token_jti (jti, session_id) VALUES ($1, $2)', [jti, sessionId]);

        // First connection should succeed and delete the JTI
        const ws1 = new WebSocket(`ws://localhost:${port}/ws/${sessionId}`, {
            headers: { 'Sec-WebSocket-Protocol': `bearer,${token}` }
        });
        await new Promise(res => ws1.on('open', res));
        ws1.close();

        // Second connection should fail
        const ws2 = new WebSocket(`ws://localhost:${port}/ws/${sessionId}`, {
            headers: { 'Sec-WebSocket-Protocol': `bearer,${token}` }
        });

        const error = await new Promise(res => ws2.on('error', res));
        expect(error).toBeInstanceOf(Error);
    });

    it('should reject a connection with a mismatched session ID', async () => {
        const token = await generateTestJWT('wrong-session', 'jti-3');
        const ws = new WebSocket(`ws://localhost:${port}/ws/correct-session`, {
            headers: { 'Sec-WebSocket-Protocol': `bearer,${token}` }
        });
        const error = await new Promise(res => ws.on('error', res));
        expect(error).toBeInstanceOf(Error);
    });
});
