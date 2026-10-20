import { PartnerError, type PartnerCustomerInput } from '../types';

// Exact validators from the observed public SPA: useValidatorConf-BpQSzo7Q
// (validateEnAndSpace), index-CG_Ogqi_ exports au/aw/ax, and quick-open inputs.
const EMAIL = /^(?!\.)(?!.*\.\.)[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const NATIONAL_PHONE = /^[0-9]{5,13}$/;
const CHINA_PHONE = /^[1][3-9][0-9]{9}$/;
const present = (value: unknown): boolean => typeof value === 'string' && value.length > 0;

function assertName(value: unknown): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[^a-zA-Z\s]/.test(value)) {
    throw new PartnerError('UPay cardholder names must contain Latin letters and spaces only, at most 100 characters per field', false);
  }
}
function assertEmail(value: unknown): void {
  if (typeof value !== 'string' || !EMAIL.test(value)) throw new PartnerError('Email does not satisfy the UPay contact format', false);
}
function assertPhone(phone: unknown, globalCode: unknown): void {
  // The national number is validated separately. Never concatenate the dial
  // code, strip digits or silently change the customer's contact identity.
  if (typeof globalCode !== 'string' || !/^\+[1-9]\d{0,3}$/.test(globalCode) || typeof phone !== 'string'
    || !(globalCode === '+86' ? CHINA_PHONE : NATIONAL_PHONE).test(phone)) {
    throw new PartnerError('UPay requires a national phone number of 5-13 digits, or a valid 11-digit China mobile number for +86', false);
  }
}

export function assertNewCustomerCanUseCard(input: Pick<PartnerCustomerInput, 'firstName' | 'lastName' | 'email'>
  & { kyc?: Pick<NonNullable<PartnerCustomerInput['kyc']>, 'phone' | 'globalCode'> }): void {
  assertName(input.firstName);
  assertName(input.lastName);
  // The separate mandatory billing-address form also uses the full contact
  // name, whose native limit is 120. Do not create an unbillable customer.
  if (`${input.firstName} ${input.lastName}`.length > 120) throw new PartnerError('UPay billing contact name must not exceed 120 characters', false);
  assertEmail(input.email);
  assertPhone(input.kyc?.phone, input.kyc?.globalCode);
}

export function assertNativeIssuanceFields(detail: Record<string, unknown>, form: Record<string, unknown>, payload: Record<string, unknown>): void {
  const required = (field: string) => form.requiredInfo === true || present(payload[field]);
  const fields = Array.isArray(form.needParams) ? form.needParams : [];
  for (const field of ['givenName', 'lastName']) if (fields.includes(field) && required(field)) assertName(payload[field]);
  if (detail.isNeedBindEmail === true && required('email')) assertEmail(payload.email);
  if (detail.isNeedBindPhone === true && required('phone')) assertPhone(payload.phone, payload.globalCode);
}
