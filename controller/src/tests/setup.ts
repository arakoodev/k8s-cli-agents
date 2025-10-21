import { newDb } from 'pg-mem';
import fs from 'fs';
import path from 'path';

// Mock the entire pg module
jest.mock('pg', () => {
  const originalPg = jest.requireActual('pg');
  const db = newDb();

  // Load the schema into the in-memory database
  const schemaSql = fs.readFileSync(path.join(__dirname, '../../../db/schema.sql'), 'utf8');
  db.public.none(schemaSql);

  // Create a mock Pool that returns the in-memory database
  const MockPool = class {
    constructor() {
      return db.public;
    }
  };

  return {
    ...originalPg,
    Pool: MockPool,
  };
});

// Mock Firebase Admin SDK
jest.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    verifyIdToken: jest.fn().mockResolvedValue({
      uid: 'test-user-uid',
      email: 'test@example.com',
    }),
  }),
}));

// Mock Kubernetes client
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromDefault = jest.fn();
    makeApiClient = () => ({
      createNamespacedJob: jest.fn().mockResolvedValue({ body: { metadata: { name: 'test-job' } } }),
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
