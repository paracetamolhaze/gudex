import type { CardAdditionalAttemptInput, CardAdditionalAttemptQuoteDto } from '@gudex/shared';

export type EligibleAdditionalAttempt = Extract<CardAdditionalAttemptQuoteDto, { eligible: true }>;

// Display and accept only this closed, broker-funded risk agreement from the server.
export function freshAdditionalAttempt(quote: CardAdditionalAttemptQuoteDto | undefined, now = Date.now()): EligibleAdditionalAttempt | null {
  if (!quote?.eligible || !quote.quoteToken || quote.termsVersion !== 'additional-issue-v1' || quote.asset !== 'USDT' ||
    quote.fundingSource !== 'broker' || quote.customerCharge !== '0' || quote.additionalBrokerCostUsd !== '10' ||
    quote.retainedBrokerReserveUsd !== '10' || quote.maximumCumulativeCostUsd !== '20' ||
    !Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= now) return null;
  return quote;
}

export function additionalAttemptConsent(quote: CardAdditionalAttemptQuoteDto | undefined, acceptedToken: string | null,
  idempotencyKey: string, now = Date.now()): CardAdditionalAttemptInput | null {
  const fresh = freshAdditionalAttempt(quote, now);
  return fresh && acceptedToken === fresh.quoteToken && idempotencyKey
    ? { quoteToken: fresh.quoteToken, idempotencyKey, acceptedRisk: true, termsVersion: fresh.termsVersion } : null;
}
