import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { IntegrationStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { hashSecret, matchesSecret, newSecret } from '../common/security.js';
import { CreateIntegrationDto } from './integrations.dto.js';
@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);
  constructor(private readonly prisma: PrismaService) {}
  list() {
    return this.prisma.integrationClient.findMany({
      take: 100,
      orderBy: { createdAt: 'desc' },
      include: {
        credentials: {
          select: {
            id: true,
            revokedAt: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });
  }
  async create(dto: CreateIntegrationDto, actorId: string) {
    try {
      const client = await this.prisma.integrationClient.create({ data: dto });
      this.logger.log({
        event: 'integration_created',
        clientId: client.id,
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
    const result = await this.prisma.integrationClient.updateMany({
      where: { id },
      data: { status },
    });
    if (!result.count) throw new NotFoundException();
    this.logger.log({
      event: 'integration_status_changed',
      clientId: id,
      status,
      actorId,
    });
  }
  async createCredential(clientId: string, actorId: string) {
    if (
      !(await this.prisma.integrationClient.findUnique({
        where: { id: clientId },
      }))
    )
      throw new NotFoundException();
    const id = randomUUID();
    const secret = newSecret();
    await this.prisma.integrationCredential.create({
      data: { id, clientId, secretHash: hashSecret(secret) },
    });
    this.logger.log({
      event: 'integration_credential_created',
      clientId,
      credentialId: id,
      actorId,
    });
    return { id, apiKey: id + '.' + secret };
  }
  async revoke(clientId: string, id: string, actorId: string) {
    const result = await this.prisma.integrationCredential.updateMany({
      where: { id, clientId },
      data: { revokedAt: new Date() },
    });
    if (!result.count) throw new NotFoundException();
    this.logger.log({
      event: 'integration_credential_revoked',
      clientId,
      credentialId: id,
      actorId,
    });
  }
  async authenticate(apiKey: string) {
    const match =
      /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/.exec(
        apiKey,
      );
    if (!match) throw new UnauthorizedException();
    const record = await this.prisma.integrationCredential.findUnique({
      where: { id: match[1] },
      include: { client: true },
    });
    if (
      !record ||
      record.revokedAt ||
      record.client.status !== 'ACTIVE' ||
      !matchesSecret(match[2], record.secretHash)
    ) {
      this.logger.warn({ event: 'integration_auth_rejected' });
      throw new UnauthorizedException();
    }
    return record.client;
  }
}
