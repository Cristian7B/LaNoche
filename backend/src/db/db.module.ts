import { Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

export const DB = Symbol('DB');
export type Database = PostgresJsDatabase<typeof schema>;

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  readonly client: ReturnType<typeof postgres>;
  readonly db: Database;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');
    this.client = postgres(connectionString, { max: 20, prepare: false });
    this.db = drizzle(this.client, { schema });
  }

  async onApplicationShutdown() {
    await this.client.end({ timeout: 5 });
  }
}

@Module({
  providers: [DatabaseService, { provide: DB, useFactory: (database: DatabaseService) => database.db, inject: [DatabaseService] }],
  exports: [DB, DatabaseService],
})
export class DbModule {}
