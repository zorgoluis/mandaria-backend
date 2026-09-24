-- V1.11-A MVP Delivery Completion, part 1 of 2: the new enum values only.
-- PostgreSQL forbids using an enum value in the same transaction that adds it, and the rules of
-- part 2 reference both literals in CHECK constraints, so they must be committed first.

-- AlterEnum: a service that was physically delivered and that Mandaria considers finished.
ALTER TYPE "DispatchStatus" ADD VALUE 'DELIVERED';

-- AlterEnum: the successful end of an assignment, alongside REASSIGNED and CANCELLED.
ALTER TYPE "DeliveryAssignmentStatus" ADD VALUE 'COMPLETED';
