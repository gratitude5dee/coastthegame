# ADR-0004 — Identity via OAuth (+ optional Sign in with ChatGPT); wallets via Phantom Connect; minting via Metaplex

**Status:** proposed (2026-09-06; needs D-5/D-6) · **Refs:** goal.md A9, ID-*

## Context
The brief named thirdweb auth. thirdweb discontinued its Solana frontend SDK (2023) and its 2025 Solana support is server-side only (no user wallets/social login/NFT minting on Solana). WZRD's on-chain IP is on Solana. Sign in with ChatGPT grants only name/email/avatar and is partner-gated.

## Decision (proposed)
- Identity: Google/Apple OAuth handled in the Worker; guest mode always; Sign in with ChatGPT added only if partner access is granted.
- Wallet: Phantom Connect (embedded Solana wallets with social login; native Phantom users connect directly); Sign-in-with-Solana binds session ↔ wallet.
- Mint: Metaplex (Core preferred for cost; Token Metadata if marketplaces require) on devnet first; metadata = Cut provenance manifest; media pinned to IPFS + mirrored in R2.
- thirdweb only if EVM chains / x402 payments are added later.

## Open
Metaplex standard, royalties/splits, collection authority (D-6); music licensing for generated video (D-7).
