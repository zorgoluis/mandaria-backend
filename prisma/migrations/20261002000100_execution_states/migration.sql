-- Commit enum additions before referencing them in the following migration.
ALTER TYPE "DispatchStatus" ADD VALUE 'RETURNED';
ALTER TYPE "DeliveryAssignmentStatus" ADD VALUE 'RETURNED';
ALTER TYPE "DeliveryAssignmentStatus" ADD VALUE 'TRANSFERRED';
