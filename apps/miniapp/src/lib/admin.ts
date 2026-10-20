import type { CardTopupAddresses } from '@gudex/shared';
import { useQuery } from '@tanstack/react-query';
import type { SupportThreadDto, WalletTransferDto } from '@gudex/shared';
import { request } from './api';

export interface AdminDocument {
  id: string;
  kind: 'front' | 'back' | 'selfie';
  mimeType: 'image/jpeg' | 'image/png';
  size: number;
  expiresAt: string;
}

export interface AdminOperation {
  id: string;
  cardId: string;
  type: string;
  status: string;
  fulfillmentMode: 'manual' | 'automatic';
  asset: string | null;
  amount: string | null;
  fee: string | null;
  netUsd?: string | null;
  createdAt: string;
  partnerCardId: string | null;
  last4: string | null;
}

export interface AdminClient {
  userId: string;
  telegramId: string;
  username: string | null;
  createdAt: string;
  billingAddress: { countryId: string; countryName?: string | null; postalCode: string; address: string } | null;
  /** The client's email on our domain (given to UPay); codes sent there reach the client's Telegram. */
  mail: { address: string | null; suggested: string | null; domain: string | null };
  kyc: null | {
    status: string;
    submissionState: string;
    submissionId: string | null;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    globalCode: string | null;
    birthDate: string | null;
    citizenship: string | null;
    documentType: string | null;
    documentCountry: string | null;
    partnerCustomerId: string | null;
    updatedAt: string;
    documents: AdminDocument[];
  };
  operations: AdminOperation[];
  /** The client's cards (being prepared, active or frozen) with the top-up addresses the operator entered. */
  cards: { id: string; status: string; last4: string | null; topupAddresses: CardTopupAddresses }[];
}

export interface AdminApplications {
  items: { userId: string; telegramId: string; name: string; kycStatus: string; submissionState: string; hasPendingCard: boolean; hasCardRequest?: boolean; createdAt: string }[];
  page: number;
  limit: number;
  total: number;
}

export interface AdminDocumentContent {
  id: string;
  kind: AdminDocument['kind'];
  mimeType: AdminDocument['mimeType'];
  base64: string;
  expiresAt?: string;
}

export interface AdminSupportItem {
  userId: string;
  telegramId: string;
  username: string | null;
  name: string | null;
  status: 'open' | 'closed';
  unread: boolean;
  lastMessageAt: string;
  preview: { author: 'client' | 'support'; text: string } | null;
}

export interface AdminProviderCard {
  id: string;
  brokerCardId: string | null;
  last4: string | null;
  state: number;
  holderName: string | null;
}

const PREFIX = '/v1/admin';
export const adminKeys = { all: ['admin'] as const, me: ['admin', 'me'] as const };
export const adminQueryValid = (value: string) => /^[1-9]\d{0,19}$/.test(value) ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

// Authorization is decided by the API. Never infer it from a public Telegram profile.
export function useAdminAccess() {
  return useQuery({ queryKey: adminKeys.me, queryFn: ({ signal }) => request<{ isAdmin: true }>(`${PREFIX}/me`, { cache: 'no-store', signal }),
    retry: false, staleTime: 30_000, gcTime: 0, refetchOnWindowFocus: false });
}

export function useAdminApplications(page: number, enabled: boolean) {
  return useQuery({ queryKey: [...adminKeys.all, 'applications', page],
    queryFn: ({ signal }) => request<AdminApplications>(`${PREFIX}/applications?page=${page}&limit=20`, { cache: 'no-store', signal }),
    enabled, retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false });
}

export function useAdminClient(query: string | null, enabled: boolean) {
  return useQuery({ queryKey: [...adminKeys.all, 'client', query],
    queryFn: ({ signal }) => request<AdminClient>(`${PREFIX}/clients/${encodeURIComponent(query!)}`, { cache: 'no-store', signal }),
    enabled: enabled && Boolean(query), retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false });
}

// For an application under review the operator names the UPay customer; otherwise the verified one is used.
export function useAdminProviderCards(userId: string, customerNo: string | null, enabled: boolean) {
  return useQuery({ queryKey: [...adminKeys.all, 'provider-cards', userId, customerNo],
    queryFn: ({ signal }) => request<AdminProviderCard[]>(`${PREFIX}/clients/${encodeURIComponent(userId)}/provider-cards${
      customerNo ? `?customerNo=${encodeURIComponent(customerNo)}` : ''}`, { cache: 'no-store', signal }),
    enabled, retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false });
}

// Transfers to the app wallet that matched no payment request (wrong amount, late, other network).
export function useAdminWalletTransfers(enabled: boolean) {
  return useQuery({ queryKey: [...adminKeys.all, 'wallet-transfers'],
    queryFn: ({ signal }) => request<WalletTransferDto[]>(`${PREFIX}/wallet-transfers`, { cache: 'no-store', signal }),
    enabled, retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false });
}

export function assignWalletTransfer(id: string, query: string, confirmationToken: string) {
  return request<WalletTransferDto>(`${PREFIX}/wallet-transfers/${encodeURIComponent(id)}/assign`, { method: 'POST', body: { query }, cache: 'no-store',
    headers: { 'X-Confirmation-Token': confirmationToken } });
}

export function getAdminDocument(userId: string, documentId: string, signal: AbortSignal) {
  return request<AdminDocumentContent>(`${PREFIX}/clients/${encodeURIComponent(userId)}/documents/${encodeURIComponent(documentId)}`,
    { cache: 'no-store', signal });
}

export function updateAdminClient(userId: string, action: 'kyc' | 'reject' | 'card', body: object, confirmationToken: string) {
  return request<AdminClient>(`${PREFIX}/clients/${encodeURIComponent(userId)}/${action}`, { method: 'POST', body, cache: 'no-store',
    headers: { 'X-Confirmation-Token': confirmationToken } });
}

// The crypto addresses UPay gives the card for top-ups; an empty value removes that route.
export function saveCardTopupAddresses(userId: string, cardId: string, addresses: CardTopupAddresses, confirmationToken: string) {
  return request<AdminClient>(`${PREFIX}/clients/${encodeURIComponent(userId)}/cards/${encodeURIComponent(cardId)}/topup-addresses`,
    { method: 'POST', body: addresses, cache: 'no-store', headers: { 'X-Confirmation-Token': confirmationToken } });
}

// A top-up or freeze the operator performed in UPay (or declined).
export function resolveAdminRequest(userId: string, operationId: string, body: { done: true } | { done: false; reason: string }, confirmationToken: string) {
  return request<AdminClient>(`${PREFIX}/clients/${encodeURIComponent(userId)}/requests/${encodeURIComponent(operationId)}`, { method: 'POST', body,
    cache: 'no-store', headers: { 'X-Confirmation-Token': confirmationToken } });
}

// The old automatic UNKNOWN is only for investigation, never a manual fulfillment target.
export function canLinkManualCard(operation: AdminOperation) {
  return operation.type === 'issue' && operation.fulfillmentMode === 'manual' && operation.status === 'pending' && !operation.partnerCardId;
}

export function documentObjectUrl(content: AdminDocumentContent): string {
  if (!['image/jpeg', 'image/png'].includes(content.mimeType) || !content.base64 || content.base64.length > 12_000_000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(content.base64)) throw new Error('Некорректный документ');
  const decoded = atob(content.base64);
  const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: content.mimeType }));
}

export function saveClientMail(userId: string, address: string, confirmationToken: string) {
  return request<AdminClient>(`${PREFIX}/clients/${encodeURIComponent(userId)}/mail`, { method: 'POST', body: { address }, cache: 'no-store',
    headers: { 'X-Confirmation-Token': confirmationToken } });
}

// Same rule as the API: Latin letters, digits, dot, - and _, on our domain when it is set.
export function clientMailValid(value: string, domain: string | null): boolean {
  const match = /^([a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)@((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/.exec(value.trim().toLowerCase());
  return Boolean(match) && !match![1]!.includes('..') && (!domain || match![2] === domain);
}

// Support conversations: refreshed while the admin is open, so new questions show up by themselves.
export function useAdminSupportInbox(status: 'open' | 'all', enabled: boolean) {
  return useQuery({ queryKey: [...adminKeys.all, 'support', status],
    queryFn: ({ signal }) => request<AdminSupportItem[]>(`${PREFIX}/support?status=${status}`, { cache: 'no-store', signal }),
    enabled, retry: false, staleTime: 0, gcTime: 0, refetchInterval: 15_000, refetchIntervalInBackground: false });
}

export function useAdminSupportThread(userId: string) {
  return useQuery({ queryKey: [...adminKeys.all, 'support-thread', userId],
    queryFn: ({ signal }) => request<SupportThreadDto>(`${PREFIX}/support/${encodeURIComponent(userId)}`, { cache: 'no-store', signal }),
    retry: false, staleTime: 0, gcTime: 0, refetchInterval: 10_000, refetchIntervalInBackground: false });
}

// A chat answer needs no passcode confirmation: the admin session is already unlocked.
export function sendAdminSupport(userId: string, text: string) {
  return request<SupportThreadDto>(`${PREFIX}/support/${encodeURIComponent(userId)}/messages`, { method: 'POST', body: { text }, cache: 'no-store' });
}

export function setAdminSupportStatus(userId: string, status: 'open' | 'closed') {
  return request<SupportThreadDto>(`${PREFIX}/support/${encodeURIComponent(userId)}/status`, { method: 'POST', body: { status }, cache: 'no-store' });
}
