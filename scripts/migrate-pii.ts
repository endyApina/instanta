import "dotenv/config";
import { prisma } from "../src/config/prisma";
import { encryptPii, piiLookupHash } from "../src/services/pii.service";

async function main() {
  let count = 0;
  while (true) {
    const user = await prisma.user.findFirst({ where: { OR: [{ phoneNumber: { not: null } }, { emailLookupHash: null }] }, select: { id: true } });
    if (!user) break;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
      const current = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
      if (current.phoneNumber && current.phoneEncrypted) throw new Error("Conflicting encrypted and legacy phone. Resolve manually before migration.");
      if (current.phoneNumber && !/^\+234[789]\d{9}$/.test(current.phoneNumber)) {
        throw new Error("A legacy phone is not Nigerian E.164. Normalize through a verified support workflow, then retry.");
      }
      await tx.user.update({
        where: { id: user.id }, data: {
          ...(current.phoneNumber ? {
            phoneEncrypted: encryptPii(current.phoneNumber), phoneLookupHash: piiLookupHash(`phone:${current.phoneNumber}`),
          } : {}),
          phoneNumber: null,
          ...(!current.emailLookupHash ? {
            email: encryptPii(current.email.toLowerCase()), emailLookupHash: piiLookupHash(`email:${current.email.toLowerCase()}`),
            firstName: encryptPii(current.firstName), lastName: encryptPii(current.lastName),
          } : {}),
        },
      });
      await tx.auditEvent.create({ data: { actorId: "pii-migration", subjectId: user.id, action: "PROFILE_ENCRYPTED" } });
    });
    count++;
  }
  console.info(`Encrypted ${count} legacy profiles. No identity values were logged.`);
}
void main().catch(() => {
  console.error("PII migration failed. Check configuration and legacy E.164 normalization; no identity values are logged.");
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
