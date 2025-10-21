import http from 'http';
import express from 'express';
import WebSocket from 'ws';
import { app } from '../server'; // Assuming server exports app
import * as jose from 'jose';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/test'
});

let server: http.Server;
let port: number;

// We need a real key for JWT signing in tests
let privateKey: jose.KeyLike;
let jwksHost: string;
let jwksServer: http.Server;

describe('WebSocket Gateway', () => {
    beforeAll(async () => {
        const { privateKey: pk, publicKey } = await jose.generateKeyPair('RS256');
        privateKey = pk;

        // Mock JWKS endpoint
        const jwksApp = express();
        jwksApp.get('/.well-known/jwks.json', async (req: express.Request, res: express.Response) => {
            res.json({ keys: [(await jose.exportJWK(publicKey))] });
        });
        jwksServer = jwksApp.listen(0);
        jwksHost = `http://localhost:${(jwksServer.address() as any).port}`;
        process.env.CONTROLLER_URL = jwksHost;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
        await pool.end();
    });

    beforeEach((done) => {
        server = app.listen(0, () => {
            port = (server.address() as any).port;
            done();
        });
    });

    afterEach(async () => {
        // Close server with timeout to prevent hanging
        await Promise.race([
            new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections?.(); // Close all connections if available
            }),
            new Promise<void>((resolve) => setTimeout(resolve, 100)) // Timeout after 100ms
        ]);
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

        // Setup the database state with all required fields
        const expiresAt = new Date(Date.now() + 600000); // 10 minutes from now
        await pool.query('INSERT INTO sessions (session_id, owner_user_id, job_name, pod_ip, expires_at) VALUES ($1, $2, $3, $4, $5)',
            [sessionId, 'test-user', 'test-job-1', '1.2.3.4', expiresAt]);
        await pool.query('INSERT INTO token_jti (jti, session_id, expires_at) VALUES ($1, $2, $3)',
            [jti, sessionId, expiresAt]);

        const ws = new WebSocket(`ws://localhost:${port}/ws/${sessionId}?token=${token}`);

        // The connection will fail because there's no actual pod at 1.2.3.4:7681
        // But we can verify the gateway accepted the connection by checking if it tried to proxy
        await new Promise((resolve) => {
            ws.on('error', resolve); // Expected - proxy target doesn't exist
            ws.on('close', resolve);
            setTimeout(resolve, 2000); // Timeout after 2 seconds to allow async operations
        });

        // Give the server time to complete the JWT verification and database operations
        await new Promise(res => setTimeout(res, 500));

        // Verify the JTI was deleted (consumed) from the database
        const { rows } = await pool.query('SELECT * FROM token_jti WHERE jti = $1', [jti]);
        expect(rows.length).toBe(0);

        try { ws.close(); } catch {}
    });

    it('should reject a connection with a replayed JTI', async () => {
        const sessionId = 'test-session-2';
        const jti = 'test-jti-2';
        const token = await generateTestJWT(sessionId, jti);

        const expiresAt = new Date(Date.now() + 600000);
        await pool.query('INSERT INTO sessions (session_id, owner_user_id, job_name, pod_ip, expires_at) VALUES ($1, $2, $3, $4, $5)',
            [sessionId, 'test-user', 'test-job-2', '1.2.3.4', expiresAt]);
        await pool.query('INSERT INTO token_jti (jti, session_id, expires_at) VALUES ($1, $2, $3)',
            [jti, sessionId, expiresAt]);

        // First connection should accept (but fail to proxy)
        const ws1 = new WebSocket(`ws://localhost:${port}/ws/${sessionId}?token=${token}`);
        await new Promise(res => {
            ws1.on('error', res);
            ws1.on('close', res);
            setTimeout(res, 1000);
        });
        ws1.close();

        // Second connection should fail immediately (JTI was deleted)
        const ws2 = new WebSocket(`ws://localhost:${port}/ws/${sessionId}?token=${token}`);

        const closedOrError = await new Promise((res) => {
            ws2.on('error', () => res(true));
            ws2.on('close', () => res(true));
            setTimeout(() => res(false), 1000);
        });

        expect(closedOrError).toBe(true);
    });

    it('should reject a connection with a mismatched session ID', async () => {
        const token = await generateTestJWT('wrong-session', 'jti-3');
        const ws = new WebSocket(`ws://localhost:${port}/ws/correct-session?token=${token}`);
        const closedOrError = await new Promise((res) => {
            ws.on('error', () => res(true));
            ws.on('close', () => res(true));
            setTimeout(() => res(false), 1000);
        });
        expect(closedOrError).toBe(true);
    });
});
