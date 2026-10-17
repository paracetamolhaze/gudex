import { useQuery } from '@tanstack/react-query';
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
  createdAt: string;
  partnerCardId: string | null;
  last4: string | null;
}

export interface AdminClient {
  userId: string;
  telegramId: string;
  username: string | null;
  createdAt: string;
  billingAddress: { countryId: string; postalCode: string; address: string } | null;
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
}

export interface AdminApplications {
  items: { userId: string; telegramId: string; name: string; kycStatus: string; submissionState: string; hasPendingCard: boolean; createdAt: string }[];
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

export function useAdminProviderCards(userId: string, enabled: boolean) {
  return useQuery({ queryKey: [...adminKeys.all, 'provider-cards', userId],
    queryFn: ({ signal }) => request<AdminProviderCard[]>(`${PREFIX}/clients/${encodeURIComponent(userId)}/provider-cards`, { cache: 'no-store', signal }),
    enabled, retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false });
}

export function getAdminDocument(userId: string, documentId: string, signal: AbortSignal) {
  return request<AdminDocumentContent>(`${PREFIX}/clients/${encodeURIComponent(userId)}/documents/${encodeURIComponent(documentId)}`,
    { cache: 'no-store', signal });
}

export function updateAdminClient(userId: string, action: 'kyc' | 'reject' | 'card', body: object, confirmationToken: string) {
  return request<AdminClient>(`${PREFIX}/clients/${encodeURIComponent(userId)}/${action}`, { method: 'POST', body, cache: 'no-store',
    headers: { 'X-Confirmation-Token': confirmationToken } });
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
