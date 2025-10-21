import request from 'supertest';
import express from 'express';
import { pool } from '../db'; // This will be the mocked pool

// This is a simplified version of the server for testing purposes
// We will import the real app later if needed, but this is often easier.
let app: express.Application;

// Mocks need to be configured before imports
const mockCreateNamespacedJob = jest.fn().mockResolvedValue({ body: {} });
jest.mock('@kubernetes/client-node', () => ({
    KubeConfig: class {
        loadFromDefault = jest.fn();
        makeApiClient = () => ({
            createNamespacedJob: mockCreateNamespacedJob,
            listNamespacedPod: jest.fn().mockResolvedValue({
                body: {
                    items: [{
                        status: { podIP: '1.2.3.4' },
                        metadata: { name: 'test-pod' }
                    }]
                }
            }),
        });
    },
    BatchV1Api: class {},
    CoreV1Api: class {},
}));


describe('Controller API', () => {
    beforeEach(async () => {
        // Reset mocks and the database before each test
        mockCreateNamespacedJob.mockClear();
        const db = (pool as any).connect();
        await db.public.none('TRUNCATE sessions, token_jti RESTART IDENTITY');

        // Dynamically import the app to use the fresh mocks
        const module = await import('../server');
        app = (module as any).app;
    });

    describe('POST /api/sessions', () => {
        const validSessionRequest = {
            code_url: 'https://github.com/my/repo.git',
            command: 'npm test',
        };

        it('should create a session and a K8s job with correct security contexts', async () => {
            const response = await request(app)
                .post('/api/sessions')
                .set('Authorization', 'Bearer fake-token')
                .send(validSessionRequest)
                .expect(200);

            expect(response.body).toHaveProperty('sessionId');
            expect(response.body).toHaveProperty('token');
            expect(mockCreateNamespacedJob).toHaveBeenCalledTimes(1);

            const jobSpec = mockCreateNamespacedJob.mock.calls[0][1].spec;
            
            // Test for Pod Security Standards
            const podSecurityContext = jobSpec.template.spec.securityContext;
            expect(podSecurityContext.runAsNonRoot).toBe(true);
            expect(podSecurityContext.runAsUser).toBe(1001);
            expect(podSecurityContext.seccompProfile.type).toBe('RuntimeDefault');

            // Test for Container Security Standards
            const containerSecurityContext = jobSpec.template.spec.containers[0].securityContext;
            expect(containerSecurityContext.allowPrivilegeEscalation).toBe(false);
            expect(containerSecurityContext.capabilities.drop).toContain('ALL');
        });

        it('should reject requests with invalid code_url (SSRF attempt)', async () => {
            await request(app)
                .post('/api/sessions')
                .set('Authorization', 'Bearer fake-token')
                .send({ ...validSessionRequest, code_url: 'http://169.254.169.254/metadata' })
                .expect(400);
        });
        
        it('should reject requests with invalid command (injection attempt)', async () => {
            await request(app)
                .post('/api/sessions')
                .set('Authorization', 'Bearer fake-token')
                .send({ ...validSessionRequest, command: 'npm start; $(rm -rf /)' })
                .expect(400);
        });

        it('should enforce rate limiting', async () => {
            const agent = request.agent(app);
            
            // Exhaust the rate limit (5 requests)
            for (let i = 0; i < 5; i++) {
                await agent
                    .post('/api/sessions')
                    .set('Authorization', 'Bearer fake-token')
                    .send(validSessionRequest)
                    .expect(200);
            }

            // The 6th request should be rejected
            await agent
                .post('/api/sessions')
                .set('Authorization', 'Bearer fake-token')
                .send(validSessionRequest)
                .expect(429);
        });
    });

    describe('CORS', () => {
        it('should allow requests from an allowed origin', async () => {
            const response = await request(app)
                .get('/healthz')
                .set('Origin', 'https://yourdomain.com')
                .expect(200);
            expect(response.headers['access-control-allow-origin']).toBe('https://yourdomain.com');
        });

        it('should block requests from a disallowed origin', async () => {
            await request(app)
                .get('/healthz')
                .set('Origin', 'https://evil.com')
                .expect(500); // The cors library throws an error
        });
    });
});
