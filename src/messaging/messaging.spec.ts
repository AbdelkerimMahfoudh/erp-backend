import { BadRequestException } from '@nestjs/common';
import { createWhatsAppChannel } from './messaging.module';
import {
  DevelopmentLogWhatsAppChannel,
  DisabledWhatsAppChannel,
  TestWhatsAppChannel,
  maskDestination,
} from './channels';
import {
  ACCOUNT_DELETED_TEMPLATE,
  ACCOUNT_DELETION_TEMPLATE,
  ALL_TEMPLATES,
  AUTH_OTP_TEMPLATE,
  SUBSCRIPTION_TEMPLATES,
  assertLanguageSupported,
  getTemplate,
  validateTemplateVariables,
} from './templates';

/**
 * The messaging boundary (F1 Stage 4A).
 *
 * The claim under test is that a deployment with no provider is safe *by
 * construction* rather than by discipline: nothing reaches a network, nothing
 * pretends to have sent, and the one channel that can print a code cannot be
 * selected in production.
 */

describe('DisabledWhatsAppChannel — the production default', () => {
  it('reports itself disabled', () => {
    const channel = new DisabledWhatsAppChannel();
    expect(channel.isEnabled).toBe(false);
    expect(channel.name).toBe('disabled');
  });

  it('performs no network call', async () => {
    // There is no HTTP client in this project at all, so the strongest
    // available assertion is that nothing global is reached for.
    const fetchSpy = jest.spyOn(globalThis, 'fetch' as never);

    await new DisabledWhatsAppChannel().send({
      to: '+22231234567',
      template: AUTH_OTP_TEMPLATE.key,
      language: 'en',
      variables: { code: '123456', ttlMinutes: '5' },
      idempotencyKey: 'k1',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('returns a controlled failure rather than throwing or pretending', async () => {
    const result = await new DisabledWhatsAppChannel().send({
      to: '+22231234567',
      template: AUTH_OTP_TEMPLATE.key,
      language: 'en',
      variables: { code: '123456', ttlMinutes: '5' },
      idempotencyKey: 'k1',
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('channel_unavailable');
      // A caller must be able to tell "we did not send" from "we sent".
      expect(result.detail).toMatch(/no whatsapp provider/i);
    }
  });
});

describe('TestWhatsAppChannel — assertions, never production', () => {
  it('captures the template, language, destination and code', async () => {
    const channel = new TestWhatsAppChannel();

    await channel.send({
      to: '+22231234567',
      template: AUTH_OTP_TEMPLATE.key,
      language: 'ar',
      variables: { code: '000123', ttlMinutes: '5' },
      idempotencyKey: 'abc',
    });

    expect(channel.last).toMatchObject({
      to: '+22231234567',
      template: 'auth.otp',
      language: 'ar',
      variables: { code: '000123' },
    });
  });

  it('can be told to fail, so failure paths are testable', async () => {
    const channel = new TestWhatsAppChannel();
    channel.nextResult = {
      status: 'failed',
      reason: 'temporary',
      detail: 'simulated',
      provider: 'test',
    };

    const result = await channel.send({
      to: '+22231234567',
      template: AUTH_OTP_TEMPLATE.key,
      language: 'en',
      variables: { code: '123456', ttlMinutes: '5' },
      idempotencyKey: 'k',
    });

    expect(result.status).toBe('failed');
  });
});

describe('channel selection', () => {
  it('defaults to disabled', () => {
    expect(createWhatsAppChannel({ channel: '', isProduction: true }).name).toBe('disabled');
    expect(createWhatsAppChannel({ channel: 'disabled', isProduction: true }).name).toBe('disabled');
  });

  it('refuses the development channel in production', () => {
    // It writes codes to a local sink; in production that is a log full of
    // one-time codes.
    expect(() => createWhatsAppChannel({ channel: 'development-log', isProduction: true })).toThrow(
      /not permitted in production/i,
    );
  });

  it('allows the development channel outside production', () => {
    const channel = createWhatsAppChannel({ channel: 'development-log', isProduction: false });
    expect(channel).toBeInstanceOf(DevelopmentLogWhatsAppChannel);
  });

  it('never lets configuration select the test channel', () => {
    // It keeps plaintext codes in memory for assertions.
    expect(() => createWhatsAppChannel({ channel: 'test', isProduction: false })).toThrow(
      /not selectable by configuration/i,
    );
  });

  it('rejects an unknown channel rather than falling back', () => {
    expect(() => createWhatsAppChannel({ channel: 'meta-cloud', isProduction: false })).toThrow(
      /Unknown WHATSAPP_CHANNEL/,
    );
  });
});

describe('template registry', () => {
  it('rejects an arbitrary template key', () => {
    expect(() => getTemplate('anything.i.like')).toThrow(BadRequestException);
  });

  it('rejects a missing required variable', () => {
    expect(() => validateTemplateVariables(AUTH_OTP_TEMPLATE, { code: '123456' })).toThrow(
      /requires a non-empty "ttlMinutes"/,
    );
  });

  it('rejects an empty or whitespace value — a blank code reads as delivered', () => {
    expect(() =>
      validateTemplateVariables(AUTH_OTP_TEMPLATE, { code: '   ', ttlMinutes: '5' }),
    ).toThrow(/non-empty "code"/);
  });

  it('rejects an unexpected variable', () => {
    expect(() =>
      validateTemplateVariables(AUTH_OTP_TEMPLATE, {
        code: '123456',
        ttlMinutes: '5',
        amount: '5000',
      }),
    ).toThrow(/does not accept: amount/);
  });

  it('accepts exactly the declared variables', () => {
    expect(
      validateTemplateVariables(AUTH_OTP_TEMPLATE, { code: '123456', ttlMinutes: '5' }),
    ).toEqual({ code: '123456', ttlMinutes: '5' });
  });

  it('rejects an unsupported language', () => {
    expect(() => assertLanguageSupported(AUTH_OTP_TEMPLATE, 'de' as never)).toThrow(
      /has no de version/,
    );
  });

  it('declares every product language for the codes people must receive', () => {
    // The app ships in English, French and Arabic; a code that cannot be sent
    // in the reader's language is a code sent in a language they may not read.
    for (const template of [AUTH_OTP_TEMPLATE, ACCOUNT_DELETION_TEMPLATE, ACCOUNT_DELETED_TEMPLATE]) {
      expect([...template.languages].sort()).toEqual(['ar', 'en', 'fr']);
    }
  });

  it('has no provider template name until a provider is chosen', () => {
    // Guessing a name would turn a configuration mistake into a silent
    // non-delivery; every provider rejects an unapproved template anyway.
    // The provider's name is configuration, never source: it is an approval the
    // operator obtained, and it differs per deployment.
    expect(AUTH_OTP_TEMPLATE.configKey).toBe('WHATSAPP_TEMPLATE_AUTH_OTP');
    expect(AUTH_OTP_TEMPLATE.providerKind).toBe('authentication');
    expect(AUTH_OTP_TEMPLATE.category).toBe('authentication');
  });
});

describe('the portal instructions and the subscription messages (0099)', () => {
  it('are optional utility messages in every product language, each named by its own configuration key', () => {
    expect(SUBSCRIPTION_TEMPLATES.map((t) => [t.key, t.configKey, t.variables])).toEqual([
      ['portal.instructions', 'WHATSAPP_TEMPLATE_PORTAL_INSTRUCTIONS', ['business']],
      ['subscription.trial_reminder', 'WHATSAPP_TEMPLATE_TRIAL_REMINDER', ['business', 'remaining', 'ends']],
      ['subscription.trial_expired', 'WHATSAPP_TEMPLATE_TRIAL_EXPIRED', ['business', 'ended']],
      ['subscription.paid_reminder', 'WHATSAPP_TEMPLATE_PAID_REMINDER', ['business', 'remaining', 'ends']],
      ['subscription.grace_started', 'WHATSAPP_TEMPLATE_GRACE_STARTED', ['business', 'ended', 'graceEnds', 'usesLeft']],
      ['subscription.no_grace', 'WHATSAPP_TEMPLATE_NO_GRACE', ['business', 'ended']],
      ['subscription.grace_reminder', 'WHATSAPP_TEMPLATE_GRACE_REMINDER', ['business', 'remaining', 'graceEnds']],
      ['subscription.grace_ended', 'WHATSAPP_TEMPLATE_GRACE_ENDED', ['business', 'ended']],
    ]);
    for (const t of SUBSCRIPTION_TEMPLATES) {
      expect(t).toMatchObject({ category: 'account', providerKind: 'utility', use: 'optional' });
      expect([...t.languages].sort()).toEqual(['ar', 'en', 'fr']);
      expect(getTemplate(t.key)).toBe(t);
    }
  });

  it('take no link, token or identifier: the portal’s one address is part of the approved text', () => {
    for (const t of SUBSCRIPTION_TEMPLATES) {
      expect({ key: t.key, bad: t.variables.filter((v) => /link|url|token|id$|code/i.test(v)) }).toEqual({ key: t.key, bad: [] });
      expect(() => validateTemplateVariables(t, { ...Object.fromEntries(t.variables.map((v) => [v, 'x'])), link: 'https://x' })).toThrow(/does not accept: link/);
    }
    // Every template's keys are unique across the registry.
    expect(new Set(ALL_TEMPLATES.map((t) => t.key)).size).toBe(ALL_TEMPLATES.length);
    expect(new Set(ALL_TEMPLATES.map((t) => t.configKey)).size).toBe(ALL_TEMPLATES.length);
  });
});

describe('destination masking', () => {
  it('shows enough to recognise, never enough to dial', () => {
    const masked = maskDestination('+22231234567');
    expect(masked).toContain('+222');
    expect(masked).not.toContain('1234567');
    expect(masked).toMatch(/\*\*\*/);
  });

  it('does not leak a short value', () => {
    expect(maskDestination('+222')).toBe('***');
  });
});
