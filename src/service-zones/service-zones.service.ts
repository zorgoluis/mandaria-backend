import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { pageResult } from '../common/pagination.dto.js';
import { DomainException } from '../common/domain-error.js';
import { isUniqueViolation } from '../providers/provider-capacity.js';
import {
  InvalidBoundaryError,
  boundariesIntersect,
  boundingBox,
  containsPoint,
  parseBoundary,
} from '../geo/geometry.js';
import type { GeoPoint, ZoneBoundary } from '../geo/geometry.js';
import {
  CreateServiceZoneDto,
  ServiceZoneListQueryDto,
} from './service-zones.dto.js';

const summarySelect = {
  id: true,
  code: true,
  name: true,
  status: true,
  currency: true,
  minLatitude: true,
  maxLatitude: true,
  minLongitude: true,
  maxLongitude: true,
  createdAt: true,
  updatedAt: true,
} as const;
const detailSelect = { ...summarySelect, boundary: true } as const;
type Row = Prisma.ServiceZoneGetPayload<{ select: typeof summarySelect }>;
const view = <T extends Row>(row: T) => ({
  ...row,
  minLatitude: row.minLatitude.toNumber(),
  maxLatitude: row.maxLatitude.toNumber(),
  minLongitude: row.minLongitude.toNumber(),
  maxLongitude: row.maxLongitude.toNumber(),
});
// Serializes zone activations so two overlapping zones cannot become ACTIVE concurrently.
const ACTIVATION_LOCK = 71_600_001;

function parse(boundary: unknown) {
  try {
    const parsed = parseBoundary(boundary);
    return { parsed, bbox: boundingBox(parsed) };
  } catch (error) {
    if (error instanceof InvalidBoundaryError)
      throw new BadRequestException([`boundary: ${error.message}`]);
    throw error;
  }
}

@Injectable()
export class ServiceZonesService {
  private readonly logger = new Logger(ServiceZonesService.name);
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateServiceZoneDto, actorId: string) {
    const { parsed, bbox } = parse(dto.boundary);
    try {
      const zone = await this.prisma.serviceZone.create({
        data: {
          code: dto.code,
          name: dto.name,
          currency: dto.currency,
          boundary: parsed as unknown as Prisma.InputJsonValue,
          ...bbox,
        },
        select: detailSelect,
      });
      this.logger.log({
        event: 'SERVICE_ZONE_CREATED',
        serviceZoneId: zone.id,
        actorId,
      });
      return view(zone);
    } catch (error) {
      if (isUniqueViolation(error))
        throw new DomainException(
          'SERVICE_ZONE_CODE_EXISTS',
          409,
          'Service zone code already exists',
        );
      throw error;
    }
  }

  async list(query: ServiceZoneListQueryDto) {
    const where: Prisma.ServiceZoneWhereInput = {
      status: query.status,
      ...(query.search
        ? {
            OR: [
              { code: { contains: query.search, mode: 'insensitive' } },
              { name: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.serviceZone.findMany({
          where,
          select: summarySelect,
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          orderBy: [{ code: 'asc' }, { id: 'asc' }],
        }),
        this.prisma.serviceZone.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return pageResult(items.map(view), total, query);
  }

  async get(id: string) {
    const zone = await this.prisma.serviceZone.findUnique({
      where: { id },
      select: detailSelect,
    });
    if (!zone) throw new NotFoundException('Service zone not found');
    return view(zone);
  }

  async rename(id: string, name: string, actorId: string) {
    await this.get(id);
    const zone = await this.prisma.serviceZone.update({
      where: { id },
      data: { name },
      select: detailSelect,
    });
    this.logger.log({
      event: 'SERVICE_ZONE_UPDATED',
      serviceZoneId: id,
      actorId,
    });
    return view(zone);
  }

  /** Boundaries change only while INACTIVE, so an ACTIVE area never shifts under open quotes. */
  async replaceBoundary(id: string, boundary: unknown, actorId: string) {
    const { parsed, bbox } = parse(boundary);
    const zone = await this.prisma.$transaction(async (tx) => {
      const [current] = await tx.$queryRaw<
        { status: string }[]
      >`SELECT status FROM "ServiceZone" WHERE id = ${id}::uuid FOR UPDATE`;
      if (!current) throw new NotFoundException('Service zone not found');
      if (current.status !== 'INACTIVE')
        throw new DomainException(
          'SERVICE_ZONE_NOT_EDITABLE',
          409,
          'Deactivate the zone before replacing its boundary',
        );
      return tx.serviceZone.update({
        where: { id },
        data: { boundary: parsed as unknown as Prisma.InputJsonValue, ...bbox },
        select: detailSelect,
      });
    });
    this.logger.log({
      event: 'SERVICE_ZONE_BOUNDARY_REPLACED',
      serviceZoneId: id,
      actorId,
    });
    return view(zone);
  }

  async activate(id: string, actorId: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(${ACTIVATION_LOCK}::bigint)`;
      // Row lock also serializes with boundary replacement of this zone.
      await tx.$queryRaw`SELECT id FROM "ServiceZone" WHERE id = ${id}::uuid FOR UPDATE`;
      const zone = await tx.serviceZone.findUnique({
        where: { id },
        select: detailSelect,
      });
      if (!zone) throw new NotFoundException('Service zone not found');
      if (zone.status === 'ACTIVE') return { zone, changed: false };
      const boundary = parseBoundary(zone.boundary) as ZoneBoundary;
      const candidates = await tx.serviceZone.findMany({
        where: {
          status: 'ACTIVE',
          id: { not: id },
          minLatitude: { lte: zone.maxLatitude },
          maxLatitude: { gte: zone.minLatitude },
          minLongitude: { lte: zone.maxLongitude },
          maxLongitude: { gte: zone.minLongitude },
        },
        select: { code: true, boundary: true },
      });
      const overlap = candidates.find((c) =>
        boundariesIntersect(boundary, parseBoundary(c.boundary)),
      );
      if (overlap)
        throw new DomainException(
          'SERVICE_ZONE_OVERLAP',
          409,
          `Boundary intersects or touches active zone ${overlap.code}`,
        );
      return {
        zone: await tx.serviceZone.update({
          where: { id },
          data: { status: 'ACTIVE' },
          select: detailSelect,
        }),
        changed: true,
      };
    });
    if (result.changed)
      this.logger.log({
        event: 'SERVICE_ZONE_ACTIVATED',
        serviceZoneId: id,
        actorId,
      });
    return view(result.zone);
  }

  async deactivate(id: string, actorId: string) {
    const updated = await this.prisma.serviceZone.updateMany({
      where: { id, status: 'ACTIVE' },
      data: { status: 'INACTIVE' },
    });
    const zone = await this.get(id);
    if (updated.count)
      this.logger.log({
        event: 'SERVICE_ZONE_DEACTIVATED',
        serviceZoneId: id,
        actorId,
      });
    return zone;
  }

  /**
   * ACTIVE zones covering the point: bounding-box pre-filter in SQL, exact point-in-polygon in
   * the geometry module. Activation forbids overlaps, so more than one result is an anomaly.
   * Callers inside an interactive transaction must pass their `tx`: a query on the global client
   * would need a second pool connection while the transaction holds its own, which deadlocks the
   * pool under concurrency (see DeliveryQuotesService.quote).
   */
  async resolveActive(
    point: GeoPoint,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const candidates = await db.serviceZone.findMany({
      where: {
        status: 'ACTIVE',
        minLatitude: { lte: point.latitude },
        maxLatitude: { gte: point.latitude },
        minLongitude: { lte: point.longitude },
        maxLongitude: { gte: point.longitude },
      },
      select: { id: true, code: true, currency: true, boundary: true },
    });
    return candidates.filter((zone) =>
      containsPoint(parseBoundary(zone.boundary), point),
    );
  }
}
