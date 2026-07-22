# Uniswap LP API — verified reference (user-supplied docs, 2026-07-21)
Base URL: https://liquidity.api.uniswap.org (no version prefix). Auth: x-api-key header (get key: Uniswap Developer Platform dashboard). 409/401 without key.

Endpoints (all POST):
- /lp/check_approval  {walletAddress, protocol V2|V3|V4, chainId, lpTokens:[{tokenAddress,amount}], action CREATE|INCREASE|DECREASE|MIGRATE, generatePermitAsTransaction?}
  -> { transactions:[{transaction,cancelApproval,action,gasFee?}], v4BatchPermitData? , v3NftPermitData? }
- /lp/create  (V3/V4) {walletAddress, protocol, chainId, existingPool:{token0Address,token1Address,poolReference} | newPool:{...fee,tickSpacing,hooks?,initialPrice sqrtRatioX96}, independentToken:{tokenAddress,amount}, priceBounds:{minPrice,maxPrice} | tickBounds:{tickLower,tickUpper}, simulateTransaction}
  -> { requestId, token0, token1, tickLower, tickUpper, adjustedMinPrice, adjustedMaxPrice, create: TransactionRequest, gasFee? }
  NOTE: API snaps priceBounds to tick spacing — ALWAYS display adjusted prices.
- /lp/create_classic (V2, full-range) {poolParameters{token0,token1,chainId}, independentToken, dependentToken?}
- /lp/increase {protocol, chainId, token0Address, token1Address, nftTokenId (v3/v4), independentToken, slippageTolerance?}
- /lp/decrease {protocol, chainId, token0/1, nftTokenId, liquidityPercentageToDecrease 1-100, withdrawAsWeth?(v3), slippageTolerance?}
  NOTE v3: uncollected fees bundled into withdrawal automatically.
- /lp/claim_fees (V3/V4 only) {protocol, walletAddress, chainId, tokenId, collectAsWeth?(v3), simulateTransaction}
- /lp/pool_info — current pool state for a token pair (fee tier / price source with a key)

TransactionRequest: {to, from, data (NEVER empty/0x, NEVER modify), value, chainId, gasLimit?, maxFeePerGas?, maxPriorityFeePerGas?}
Native ETH = 0x0000000000000000000000000000000000000000 (API adds refundETH multicall).
v4: permit2 gasless approvals (sign typed data, pass batchPermitData+signature into create/increase). v3: NFT permit similar.
Slippage guidance: stable 0.05-0.5 / moderate 0.5-1 / volatile 1-5. Tx freshness ~30s — refetch stale. simulateTransaction:true => gasFee estimate.
429 => exponential backoff + 15s response caching.
Client responsibilities: RPC provider + web3 lib + wallet signing + broadcasting. API builds validated calldata only.
PHASE MAP: Phase 1 lens does NOT need this API (app+Rabby executes). Phase 2: one-click via /create with priceBounds from our recipe. Phase 3: full daemon analog = /create + local signer + RPC broadcast (dlmm-quant architecture on EVM).
