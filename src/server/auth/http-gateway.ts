import type { IcosBetterAuth } from "./better-auth";
import type { AuthHttpGateway } from "./ports";

/**
 * Adapte les appels serveur Better Auth en résultats HTTP ICOS minimaux. Les
 * cookies sont conservés dans les en-têtes, tandis que le token natif reste
 * strictement interne à Better Auth.
 */
export class BetterAuthHttpGateway implements AuthHttpGateway {
  constructor(private readonly auth: IcosBetterAuth) {}

  async signIn(input: {
    email: string;
    password: string;
    headers: Headers;
  }): Promise<{ headers: Headers; userId: string }> {
    const result = await this.auth.api.signInEmail({
      body: {
        email: input.email,
        password: input.password,
      },
      headers: input.headers,
      returnHeaders: true,
      returnStatus: true,
    });

    return {
      headers: result.headers,
      userId: result.response.user.id,
    };
  }

  async signOut(headers: Headers): Promise<{ headers: Headers; success: boolean }> {
    const result = await this.auth.api.signOut({
      headers,
      returnHeaders: true,
      returnStatus: true,
    });

    return {
      headers: result.headers,
      success: result.response.success,
    };
  }
}
