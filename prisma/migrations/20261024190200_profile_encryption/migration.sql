ALTER TABLE "User" ADD COLUMN "emailLookupHash" TEXT;
CREATE UNIQUE INDEX "User_emailLookupHash_key" ON "User"("emailLookupHash");
