import { newDb, DataType } from 'pg-mem';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

// Mock the entire pg module
jest.mock('pg', () => {
  const originalPg = jest.requireActual('pg');
  const db = newDb();

  // Register the uuid-ossp extension
  db.registerExtension('uuid-ossp', (schema) => {
    schema.registerFunction({
      name: 'uuid_generate_v4',
      returns: DataType.uuid,
      implementation: randomUUID,
    });
  });

  // Load the schema into the in-memory database
  const schemaSql = fs.readFileSync(path.join(__dirname, '../../../db/schema.sql'), 'utf8');
  db.public.none(schemaSql);

  // Create a mock Pool that returns the in-memory database
  const MockPool = class {
    constructor() {
      return {
        ...db.public,
        on: jest.fn(),
        end: jest.fn(),
        connect: jest.fn().mockResolvedValue({
          query: db.public.query.bind(db.public),
          none: db.public.none.bind(db.public),
          many: db.public.many.bind(db.public),
          one: db.public.one.bind(db.public),
          release: jest.fn(),
        }),
      };
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
