import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma, RoleKey } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { HashingService } from '../common/security/hashing.service';
import { newUuidV7Bin, binToUuid } from '../common/utils/uuid.util';
import {
  generatePersonalId,
  isEmail,
  normaliseEmail,
  normalisePhone,
} from '../auth/identifier';

/**
 * A shop signs itself up.
 *
 * Three rules shape everything here.
 *
 * **1. The shopkeeper types no identifier we invented.** No Store ID, no
 * company id, no branch id, no tenant code. They give their name, their
 * business's name, a first branch, a city, a contact and a password. Every
 * internal reference — the company id, the branch id, the public Store Account
 * ID, the personal ID — is generated on the server. That is the whole point:
 * asking somebody to invent or remember our identifiers is how the old sign-in
 * became unusable.
 *
 * **2. There is no free trial.** Registration creates the company, its first
 * branch, its Owner and a subscription in `pending_activation`. Nothing about
 * succeeding at registration grants operational access; a person decides that,
 * and the decision is recorded.
 *
 * **3. A retry must not create a second business.** Everything happens in one
 * transaction, keyed by an idempotency key the client generates. A dropped
 * response on a bad connection is the ordinary case in a Nouakchott shop, and
 * two companies with the same name and no way to tell which is yours is a
 * disaster the shopkeeper cannot fix themselves.
 */

export interface RegistrationInput {
  idempotencyKey: string;
  ownerName: string;
  businessName: string;
  branchName: string;
  city?: string;
  email?: string;
  phone?: string;
  password: string;
  language: 'en' | 'ar' | 'fr';
}

export interface RegistrationResult {
  companyId: string;
  /** Generated, never chosen. Shown afterwards as a support reference only. */
  publicStoreId: string;
  branchId: string;
  ownerUserId: string;
  status: 'pending_activation';
  /** True when this call did the work; false when it recognised a retry. */
  created: boolean;
}

/** Ten uppercase hex characters, matching the existing Store Account ID shape. */
function newPublicStoreId(): string {
  return randomBytes(5).toString('hex').toUpperCase();
}

@Injectable()
export class RegistrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
  ) {}

  async register(input: RegistrationInput): Promise<RegistrationResult> {
    const email = input.email?.trim() ? normaliseEmail(input.email) : null;
    const phone = input.phone?.trim() ? normalisePhone(input.phone) : null;

    // At least one contact, because it is the credential. An account with
    // neither cannot reach the sign-in screen at all.
    if (!email && !phone) {
      throw new BadRequestException(
        'Give an email address or a WhatsApp number — it is how you will sign in.',
      );
    }
    if (input.email?.trim() && !isEmail(input.email)) {
      throw new BadRequestException('That does not look like an email address.');
    }
    if (input.phone?.trim() && !phone) {
      throw new BadRequestException('That does not look like a WhatsApp number.');
    }
    if (!input.password || input.password.length < 8) {
      throw new BadRequestException('Use a password of at least 8 characters.');
    }
    if (!input.businessName?.trim()) throw new BadRequestException('Give your business a name.');
    if (!input.ownerName?.trim()) throw new BadRequestException('Give your own name.');
    if (!input.idempotencyKey?.trim()) throw new BadRequestException('Missing request key.');

    /*
     * The retry check, before any work.
     *
     * Deliberately NOT "does a company with this name exist" — two real shops
     * may share a name, and refusing the second would be wrong. The key is the
     * client's own, so only a retry of the same attempt matches.
     */
    const seen = await this.prisma.registrationAttempt.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (seen?.companyId) {
      return this.describe(seen.companyId, false);
    }

    const passwordHash = await this.hashing.hash(input.password);

    const companyId = newUuidV7Bin();
    const branchId = newUuidV7Bin();
    const userId = newUuidV7Bin();

    try {
      await this.prisma.$transaction(async (tx) => {
        // Claims the key. A concurrent duplicate loses on the unique index
        // here, before either has created a company.
        await tx.registrationAttempt.create({
          data: {
            id: newUuidV7Bin(),
            idempotencyKey: input.idempotencyKey,
            companyId,
            businessName: input.businessName.slice(0, 160),
            ownerName: input.ownerName.slice(0, 160),
            city: input.city?.slice(0, 120) ?? null,
            email,
            phone,
            language: input.language,
          },
        });

        await tx.company.create({
          data: {
            id: companyId,
            name: input.businessName.slice(0, 160),
            publicStoreId: newPublicStoreId(),
            city: input.city?.slice(0, 120) ?? null,
            currency: 'MRU',
            timezone: 'Africa/Nouakchott',
            settingsJson: {},
          },
        });

        await tx.branch.create({
          data: {
            id: branchId,
            companyId,
            // Localised "Main Store" by default, but the shopkeeper may rename
            // it — a business with one shop still knows what to call it.
            name: input.branchName?.trim()?.slice(0, 160) || 'Main Store',
            type: 'store',
          },
        });

        // The store-facing roles this company will use.
        const roleIds: Partial<Record<RoleKey, Buffer>> = {};
        for (const key of ['owner', 'store_manager', 'store_employee'] as RoleKey[]) {
          const id = newUuidV7Bin();
          roleIds[key] = id;
          await tx.role.create({
            data: {
              id,
              companyId,
              key,
              name:
                key === 'owner' ? 'Owner' : key === 'store_manager' ? 'Manager' : 'Employee',
            },
          });
        }

        await tx.user.create({
          data: {
            id: userId,
            companyId,
            name: input.ownerName.slice(0, 160),
            // An internal handle only. Never typed to sign in, never shown.
            login: `owner-${binToUuid(companyId).slice(0, 8)}`,
            email,
            phone,
            personalId: generatePersonalId(),
            passwordHash,
          },
        });

        await tx.userBranch.create({
          data: {
            id: newUuidV7Bin(),
            companyId,
            userId,
            branchId,
            roleId: roleIds.owner!,
          },
        });

        const subscriptionId = newUuidV7Bin();
        await tx.subscription.create({
          data: {
            id: subscriptionId,
            companyId,
            // No trial. Nothing is granted by registering.
            status: 'pending_activation',
            subscribedBranchCount: 1,
            additionalSeats: 0,
            currentPeriodEnd: null,
          },
        });

        await tx.subscriptionEvent.create({
          data: {
            id: newUuidV7Bin(),
            companyId,
            subscriptionId,
            kind: 'registered',
            note: 'Self-service registration. Awaiting activation.',
            actor: 'self-service',
          },
        });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const target = String((e.meta as { target?: string })?.target ?? '');

        // Two requests carrying the same key raced. The loser reports the
        // winner's result, which is exactly what an idempotent retry should do.
        if (target.includes('registration_idem') || target.includes('idempotency')) {
          const winner = await this.prisma.registrationAttempt.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
          });
          if (winner?.companyId) return this.describe(winner.companyId, false);
        }

        /*
         * A contact collision.
         *
         * Contacts are unique PER COMPANY, and this is a brand-new company, so
         * reaching here means something else — and either way the answer must
         * not confirm that an address is already registered. That would let
         * anybody test addresses against the platform.
         */
        throw new ConflictException({
          code: 'registration_failed',
          message: 'We could not complete that registration. Please try again.',
        });
      }
      throw e;
    }

    return this.describe(companyId, true);
  }

  private async describe(companyId: Buffer, created: boolean): Promise<RegistrationResult> {
    const company = await this.prisma.company.findUniqueOrThrow({
      where: { id: companyId },
      select: { id: true, publicStoreId: true },
    });
    const branch = await this.prisma.branch.findFirstOrThrow({
      where: { companyId },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    const owner = await this.prisma.user.findFirstOrThrow({
      where: { companyId },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });

    return {
      companyId: binToUuid(company.id),
      publicStoreId: company.publicStoreId,
      branchId: binToUuid(branch.id),
      ownerUserId: binToUuid(owner.id),
      status: 'pending_activation',
      created,
    };
  }
}
