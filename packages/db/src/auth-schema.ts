import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Better Auth's tables.
 *
 * Kept apart from the domain schema because their shape is the library's
 * contract, not ours: column names and types must match what Better Auth
 * expects, so this file changes when the library does and not otherwise. Text
 * ids rather than uuid for the same reason.
 *
 * Sessions live here, in the same database as the training data, which is the
 * whole argument for a library over a hosted identity service — a coach's
 * access to an athlete can be a foreign key rather than a reconciliation
 * against some external system.
 */

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified')
    .$defaultFn(() => false)
    .notNull(),
  image: text('image'),
  createdAt: timestamp('created_at')
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: timestamp('updated_at')
    .$defaultFn(() => new Date())
    .notNull(),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

/**
 * Credentials and linked providers.
 *
 * `password` holds a scrypt hash written by Better Auth — never a plaintext
 * password, and never something this codebase reads or compares itself.
 */
export const account = pgTable('account', {
  id: text('id').primaryKey(),
  /** Provider issuer. Required by Better Auth; empty string for credentials. */
  issuer: text('issuer').notNull().default(''),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at')
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: timestamp('updated_at')
    .$defaultFn(() => new Date())
    .notNull(),
});

export type User = typeof user.$inferSelect;
export type Session = typeof session.$inferSelect;
