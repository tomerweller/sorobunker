import { Networks } from "@stellar/stellar-sdk";

export const RPC_URL = "https://soroban-testnet.stellar.org";
export const NETWORK_PASSPHRASE = Networks.TESTNET;

/** The SoroBunker wasm uploaded to testnet; "Create vault" instantiates it. */
export const VAULT_WASM_HASH = "b3608837f2ed9781c4bd96327d9aa4a99ecd864257c647b47277b19b0d0ec2b8";

/** Native XLM's Stellar Asset Contract on testnet. */
export const XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

export const EXPLORER_TX = "https://stellar.expert/explorer/testnet/tx/";
export const EXPLORER_CONTRACT = "https://stellar.expert/explorer/testnet/contract/";
