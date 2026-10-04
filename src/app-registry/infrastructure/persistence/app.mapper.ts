import { App } from '../../domain/app';
import type { AppRow } from './app.schema';

export const AppMapper = {
  toDomain(row: AppRow): App {
    return App.restore({
      id: row.id,
      clientId: row.client_id,
      name: row.name,
      clientType: row.client_type,
      clientSecretHash: row.client_secret_hash,
      redirectUris: row.redirect_uris,
      allowedOrigins: row.allowed_origins,
      emailFrom: row.email_from,
      postResetRedirectUri: row.post_reset_redirect_uri,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  },

  toPersistence(app: App): AppRow {
    return {
      id: app.id,
      client_id: app.clientId,
      name: app.name,
      client_type: app.clientType,
      client_secret_hash: app.clientSecretHash,
      redirect_uris: [...app.redirectUris],
      allowed_origins: [...app.allowedOrigins],
      email_from: app.emailFrom,
      post_reset_redirect_uri: app.postResetRedirectUri,
      status: app.status,
      created_at: app.createdAt,
      updated_at: app.updatedAt,
    };
  },
};
