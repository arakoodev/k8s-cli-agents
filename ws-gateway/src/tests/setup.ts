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
