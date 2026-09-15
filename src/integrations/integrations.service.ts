import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { IntegrationStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { hashSecret, newSecret } from '../common/security.js';
import {
  CreateCredentialDto,
  CreateIntegrationDto,
} from './integrations.dto.js';
import { credentialSelect, integrationSelect } from './integration.select.js';

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);
  constructor(private readonly prisma: PrismaService) {}
  list() {
    return this.prisma.integrationClient.findMany({
      take: 100,
      orderBy: { createdAt: 'desc' },
      select: {
        ...integrationSelect,
        credentials: { select: credentialSelect, take: 100 },
      },
    });
  }
  async get(id: string) {
    const client = await this.prisma.integrationClient.findUnique({
      where: { id },
      select: integrationSelect,
    });
    if (!client) throw new NotFoundException();
    return client;
  }
  async create(dto: CreateIntegrationDto, actorId: string) {
    try {
      const client = await this.prisma.integrationClient.create({
        data: dto,
        select: integrationSelect,
      });
      this.logger.log({
        event: 'INTEGRATION_CREATED',
        integrationId: client.id,
        actorId,
      });
      return client;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new ConflictException('Integration code already exists');
      throw error;
    }
  }
  async setStatus(id: string, status: IntegrationStatus, actorId: string) {
    // REVOKED is terminal. SUSPENDED is reversible.
    const result = await this.prisma.integrationClient.updateMany({
      where: { id, status: { not: 'REVOKED' } },
      data: { status },
    });
    if (!result.count) {
      const client = await this.get(id);
      if (client.status === 'REVOKED' && status !== 'REVOKED')
        throw new ConflictException(
          'Revoked integrations cannot be reactivated',
        );
    }
    const event = {
      ACTIVE: 'INTEGRATION_ACTIVATED',
      SUSPENDED: 'INTEGRATION_SUSPENDED',
      REVOKED: 'INTEGRATION_REVOKED',
    }[status];
    this.logger.log({ event, integrationId: id, actorId });
  }
  async listCredentials(clientId: string) {
    await this.get(clientId);
    return this.prisma.integrationCredential.findMany({
      where: { clientId },
      select: credentialSelect,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
  private expiration(value?: string) {
    const expiresAt = value ? new Date(value) : null;
    if (expiresAt && expiresAt <= new Date())
      throw new BadRequestException(
        'Credential expiration must be in the future',
      );
    return expiresAt;
  }
  private async issue(
    tx: Prisma.TransactionClient,
    clientId: string,
    scopes: string[],
    expiresAt: Date | null,
  ) {
    const id = randomUUID();
    const secret = newSecret();
    await tx.integrationCredential.create({
      data: { id, clientId, secretHash: hashSecret(secret), scopes, expiresAt },
    });
    return { clientId: id, integrationId: clientId, clientSecret: secret };
  }
  async createCredential(
    clientId: string,
    dto: CreateCredentialDto,
    actorId: string,
  ) {
    const expiresAt = this.expiration(dto?.expiresAt);
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "IntegrationClient" WHERE id = ${clientId}::uuid FOR UPDATE`;
      const client = await tx.integrationClient.findUnique({
        where: { id: clientId },
      });
      if (!client) throw new NotFoundException();
      if (client.status === 'REVOKED')
        throw new ConflictException('Integration is revoked');
      return this.issue(tx, clientId, dto?.scopes ?? [], expiresAt);
    });
    this.logger.log({
      event: 'CREDENTIAL_CREATED',
      integrationId: clientId,
      credentialId: result.clientId,
      actorId,
    });
    return result;
  }
  async rotate(clientId: string, credentialId: string, actorId: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      // Lock parent first to serialize with terminal revocation and issuance.
      await tx.$queryRaw`SELECT id FROM "IntegrationClient" WHERE id = ${clientId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "IntegrationCredential" WHERE id = ${credentialId}::uuid FOR UPDATE`;
      const credential = await tx.integrationCredential.findFirst({
        where: { id: credentialId, clientId },
        include: { client: true },
      });
      if (!credential) throw new NotFoundException();
      if (
        credential.status !== 'ACTIVE' ||
        credential.revokedAt ||
        credential.client.status === 'REVOKED' ||
        (credential.expiresAt && credential.expiresAt <= new Date())
      )
        throw new ConflictException('Credential cannot be rotated');
      // Rotation creates B; A remains active until explicitly revoked.
      return this.issue(tx, clientId, credential.scopes, credential.expiresAt);
    });
    this.logger.log({
      event: 'CREDENTIAL_ROTATED',
      integrationId: clientId,
      previousCredentialId: credentialId,
      credentialId: result.clientId,
      actorId,
    });
    return result;
  }
  async revoke(clientId: string, id: string, actorId: string) {
    const result = await this.prisma.integrationCredential.updateMany({
      where: { id, clientId, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    if (
      !result.count &&
      !(await this.prisma.integrationCredential.findFirst({
        where: { id, clientId },
        select: { id: true },
      }))
    )
      throw new NotFoundException();
    this.logger.log({
      event: 'CREDENTIAL_REVOKED',
      integrationId: clientId,
      credentialId: id,
      actorId,
    });
  }
}
