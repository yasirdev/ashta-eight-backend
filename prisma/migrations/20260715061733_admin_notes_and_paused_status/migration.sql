-- AlterEnum
ALTER TYPE "SubscriptionStatus" ADD VALUE 'paused';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "notes" TEXT;
