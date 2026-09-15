import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';
import { matchesSecret } from '../common/security.js';
import { integrationSelect } from './integration.select.js';
import { INTEGRATION_SCOPES } from './integration-scopes.js';

const claimsSchema = z.object({
  sub: z.string().uuid(),
  credentialId: z.string().uuid(),
  principalType: z.literal('integration'),
  type: z.literal('integration_access'),
  scopes: z.array(z.enum(INTEGRATION_SCOPES)),
  exp: z.number().int(),
  iat: z.number().int(),
});
const dummyHash = '0'.repeat(64);

@Injectable()
export class IntegrationAuthService {
  private readonly logger = new Logger(IntegrationAuthService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}
  private reject(): never {
    this.logger.warn({ event: 'INTEGRATION_AUTH_FAILED' });
    throw new UnauthorizedException('Invalid integration credentials');
  }
  async token(clientId: string, clientSecret: string) {
    const credential = await this.prisma.integrationCredential.findUnique({
      where: { id: clientId },
      include: { client: { select: integrationSelect } },
    });
    // Always compute the digest comparison, including unknown identifiers.
    const validSecret = matchesSecret(
      clientSecret,
      credential?.secretHash ?? dummyHash,
    );
    if (
      !credential ||
      !validSecret ||
      credential.status !== 'ACTIVE' ||
      credential.revokedAt ||
      credential.client.status !== 'ACTIVE' ||
      (credential.expiresAt && credential.expiresAt <= new Date())
    )
      return this.reject();
    const configured = this.config.getOrThrow<number>(
      'INTEGRATION_ACCESS_TOKEN_EXPIRES_IN',
    );
    const expiresIn = credential.expiresAt
      ? Math.min(
          configured,
          Math.floor((credential.expiresAt.getTime() - Date.now()) / 1000),
        )
      : configured;
    if (expiresIn < 1) return this.reject();
    const accessToken = await this.jwt.signAsync(
      {
        sub: credential.clientId,
        credentialId: credential.id,
        scopes: credential.scopes,
        principalType: 'integration',
        type: 'integration_access',
      },
      {
        secret: this.config.getOrThrow<string>('INTEGRATION_JWT_SECRET'),
        expiresIn,
        issuer: 'mandaria',
        audience: 'mandaria-integrations',
        algorithm: 'HS256',
        jwtid: randomUUID(),
      },
    );
    await this.prisma.integrationCredential.update({
      where: { id: credential.id },
      data: { lastUsedAt: new Date() },
    });
    this.logger.log({
      event: 'INTEGRATION_AUTH_SUCCESS',
      integrationId: credential.clientId,
      credentialId: credential.id,
    });
    return { accessToken, tokenType: 'Bearer', expiresIn };
  }
  async authenticate(token: string) {
    let claims: z.infer<typeof claimsSchema>;
    try {
      claims = claimsSchema.parse(
        await this.jwt.verifyAsync(token, {
          secret: this.config.getOrThrow<string>('INTEGRATION_JWT_SECRET'),
          issuer: 'mandaria',
          audience: 'mandaria-integrations',
          algorithms: ['HS256'],
        }),
      );
    } catch {
      return this.reject();
    }
    const credential = await this.prisma.integrationCredential.findUnique({
      where: { id: claims.credentialId },
      include: { client: { select: integrationSelect } },
    });
    if (
      !credential ||
      credential.clientId !== claims.sub ||
      credential.status !== 'ACTIVE' ||
      credential.revokedAt ||
      credential.client.status !== 'ACTIVE' ||
      (credential.expiresAt && credential.expiresAt <= new Date())
    )
      return this.reject();
    // A token can never gain scopes that were not granted at issuance.
    return {
      ...credential.client,
      scopes: claims.scopes.filter((scope) =>
        credential.scopes.includes(scope),
      ),
    };
  }
}
