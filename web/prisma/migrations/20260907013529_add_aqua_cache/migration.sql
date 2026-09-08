-- CreateTable
CREATE TABLE "aqua_cache" (
    "key" VARCHAR(128) NOT NULL,
    "data" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "aqua_cache_pkey" PRIMARY KEY ("key")
);
