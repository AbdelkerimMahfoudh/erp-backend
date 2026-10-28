import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import { RETURN_WINDOW_MAX_HOURS, RETURN_WINDOW_NONE } from '../../settings/settings.constants';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsMoney } from '../../common/money/is-money.decorator';
import { PAYER_NUMBER_MAX_INPUT } from '../payer-number';
import { DEBT_DUE_MAX_DAYS } from '../customer-debt';

/**
 * A sale line is EITHER a serialized unit (scan its `identifier` — IMEI or
 * serial) OR a quantity product (`productId` + `quantity`). The client learns
 * which from POST /scan; it never picks the tracking mode.
 */
export class SaleLineDto {
  @ApiPropertyOptional({ description: 'Serialized unit identifier (IMEI or serial)', example: '123456789012347' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  identifier?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  @ApiPropertyOptional({ minimum: 0, description: 'Overrides the default price' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsMoney({ min: 0 })
  price?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsMoney({ min: 0 })
  discount?: number;
}

export class PaymentInputDto {
  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @ApiProperty({ minimum: 0.01 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @IsMoney({ min: 0.01 })
  amount: number;

  /**
   * Which receiving account the money landed in (E-CP1).
   *
   * Money going OUT was already attributed — refunds, supplier payments and
   * expenses all name an account — but money coming IN was not, so no account
   * could have an expected balance and none could be reconciled.
   *
   * Optional, and never guessed: a non-cash payment that names no account is
   * reported honestly as unattributed rather than being assigned to whichever
   * account looks likely. Must be absent for cash, which belongs to the drawer.
   */
  @ApiPropertyOptional({ format: 'uuid', description: 'Receiving account; omit for cash' })
  @IsOptional()
  @IsUUID()
  receivingAccountId?: string;

  /**
   * The phone or account number this money came FROM (D151, 0087) — optional,
   * non-cash only, normalised by the server (`sales/payer-number.ts`). Not the
   * customer's phone and not a transfer reference; no provider verified it.
   */
  @ApiPropertyOptional({
    maxLength: PAYER_NUMBER_MAX_INPUT,
    description: 'The number the payment came from: digits, spaces, hyphens, an optional leading +. Omit for cash.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(PAYER_NUMBER_MAX_INPUT)
  payerNumber?: string | null;
}

/**
 * A customer typed at the counter because they are not on the list yet.
 *
 * The name is what the shop will ask for when the balance is chased, so it is
 * required — and so is the phone (the owner's brief of 2026-10-17, superseding
 * the optional phone of 0074): a balance nobody can be called about is a debt
 * the shop will not collect. The service checks it (`parseCustomerPhone`).
 */
export class NewCustomerDto {
  @ApiProperty({ maxLength: 160 })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name: string;

  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;
}

export class CreateSaleDto {
  @ApiProperty({ type: [SaleLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SaleLineDto)
  lines: SaleLineDto[];

  /**
   * The money received NOW. May be empty (0074): a phone handed over with
   * nothing paid is a real sale, and the whole total is then owed by the
   * debtor named below. Each entry must still be a positive amount. At most
   * four entries, each to a different place (`assertPaymentParts`); together
   * they pay all or part of the total, never more, and whatever is left
   * unpaid needs a debtor — one method or a split alike.
   */
  @ApiProperty({ type: [PaymentInputDto], description: 'Money received now. Empty when nothing was paid at the counter.' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PaymentInputDto)
  payments: PaymentInputDto[];

  /** An existing customer. Chosen from the list, so no duplicate is created. */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  /**
   * A NEW customer who owes the balance (0074): a name, and a phone if the shop
   * has one. Never combined with `customerId` or `counterpartyId`.
   */
  @ApiPropertyOptional({ type: () => NewCustomerDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => NewCustomerDto)
  customer?: NewCustomerDto;

  /**
   * The phone number of an EXISTING customer who owes the balance and has none
   * saved yet (the owner's brief of 2026-10-17). Saved on the customer only
   * when they have no number; an existing number is never changed from a sale.
   */
  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  customerPhone?: string;

  /**
   * In how many days whatever this sale leaves owing is due (the owner's brief
   * of 2026-10-17). Required when money is owed, ignored when nothing is. The
   * server turns it into the due date from the sale's own business day; the
   * Owner is reminded by the overdue-debt notice from the day after.
   */
  @ApiPropertyOptional({ minimum: 1, maximum: DEBT_DUE_MAX_DAYS, description: 'Days until the balance is due' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(DEBT_DUE_MAX_DAYS)
  dueInDays?: number;

  /**
   * A partner store — connected or manual — that owes the balance (0074).
   * Never combined with a customer: one balance, one debtor.
   */
  @ApiPropertyOptional({ format: 'uuid', description: 'Partner store owing the balance' })
  @IsOptional()
  @IsUUID()
  counterpartyId?: string;

  @ApiPropertyOptional({ minimum: 0, description: 'Whole-sale discount' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsMoney({ min: 0 })
  saleDiscount?: number;

  @ApiPropertyOptional({ maxLength: 255, description: 'Required for below-cost / over-limit overrides' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  overrideReason?: string;

  /**
   * LEGACY — accepted and IGNORED (the owner's brief of 2026-10-28).
   *
   * The sale screen no longer chooses a return policy: the server resolves the
   * branch's configured policy at confirmation and snapshots it on the sale. An
   * older app that still sends a window is not refused — it sells, under the
   * configured policy, and can no longer override it. Still validated, so a
   * malformed value is not silently passed around.
   */
  @ApiPropertyOptional({
    minimum: RETURN_WINDOW_NONE,
    maximum: RETURN_WINDOW_MAX_HOURS,
    deprecated: true,
    description: 'Ignored: the branch policy is authoritative.',
  })
  @IsOptional()
  @IsInt()
  @Min(RETURN_WINDOW_NONE)
  @Max(RETURN_WINDOW_MAX_HOURS)
  returnWindowHours?: number;

  @ApiPropertyOptional({ maxLength: 255, deprecated: true, description: 'Ignored, with returnWindowHours.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  returnPolicyReason?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Offline idempotency key' })
  @IsOptional()
  @IsUUID()
  clientUuid?: string;

  /**
   * "Yes, I meant that" — the token the server issued with the warnings.
   *
   * Not a boolean. A flag in a body authorises nothing, because any client can
   * send one; this is signed over the exact payload and the exact warnings the
   * person was shown, so a changed price cannot reuse an old confirmation. See
   * `common/warnings/acknowledgement.ts`.
   */
  @ApiPropertyOptional({ description: 'Acknowledgement token returned with warnings_pending' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  acknowledgementToken?: string;
}
