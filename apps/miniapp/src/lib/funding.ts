import { fromMinor, isValidAddress, toMinor, type CardIssueQuoteDto, type DepositAddressDto, type Network, type WalletAsset, type WalletDto } from '@gudex/shared';

export function fundingEnabled(mode: unknown): mode is 'demo' | 'live' {
  return mode === 'demo' || mode === 'live';
}

export function cardIssueQuote(asset: WalletAsset, quote: CardIssueQuoteDto | undefined): CardIssueQuoteDto | null {
  try {
    if (!quote || quote.asset !== asset || (quote.fundingSource !== 'wallet' && quote.fundingSource !== 'broker')) return null;
    toMinor(quote.fee, 'USD');
    const charge = toMinor(quote.customerCharge, asset);
    if (quote.fundingSource === 'broker' && charge !== 0n) return null;
    return quote;
  } catch {
    return null;
  }
}

// The server quotes the customer charge; a broker-funded grant never uses the wallet.
export function cardIssueFunding(wallet: Pick<WalletDto, 'balances'>, asset: WalletAsset, quote: CardIssueQuoteDto | undefined): { enough: boolean; shortage: string | null } {
  try {
    const valid = cardIssueQuote(asset, quote);
    if (!valid) return { enough: false, shortage: null };
    if (valid.fundingSource === 'broker') return { enough: true, shortage: '0' };
    const balance = wallet.balances.find((entry) => entry.asset === asset);
    if (!balance) return { enough: false, shortage: null };
    const available = toMinor(balance.amount, asset);
    const charge = toMinor(valid.customerCharge, asset);
    return { enough: available >= charge, shortage: fromMinor(available < charge ? charge - available : 0n, asset) };
  } catch {
    return { enough: false, shortage: null };
  }
}

// Never expose a cached demo, wrong-network, or disabled-provider address for a real transfer.
export function liveDepositAddress(
  mode: unknown,
  asset: WalletAsset,
  network: Network,
  address: DepositAddressDto | undefined,
): DepositAddressDto | null {
  if (mode !== 'live' || !address || address.demo !== false || address.asset !== asset || address.network !== network ||
    !isValidAddress(network, address.address)) return null;
  return address;
}
