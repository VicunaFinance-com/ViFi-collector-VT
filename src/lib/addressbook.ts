import * as addressbook from 'blockchain-addressbook';
import { Chain } from './chain';
import { Hex } from 'viem';

export function getChainWNativeTokenDecimals(chain: Chain): number {
    if (chain === 'mode') {
        return 18;
    }
    const tokens = addressbook.addressBook[chain].tokens;
    return tokens.WNATIVE.decimals;
}

export function getChainWNativeTokenSymbol(chain: Chain): string {
    if (chain === 'mode') {
        return 'ETH';
    }
    const tokens = addressbook.addressBook[chain].tokens;
    return tokens.WNATIVE.symbol;
}

export function getChainWNativeTokenAddress(chain: Chain): Hex {
    if (chain === 'mode') {
        return '0x4200000000000000000000000000000000000006';
    }
    const tokens = addressbook.addressBook[chain].tokens;
    return tokens.WNATIVE.address as Hex;
}

export function getNetworkId(chain: Chain): number {
    if (chain === 'mode') {
        return 34443;
    }
    const tokens = addressbook.addressBook[chain].tokens;
    return tokens.WNATIVE.chainId;
}
