import { Networks } from "@stellar/stellar-sdk";

export const RPC_URL = "https://soroban-testnet.stellar.org";
export const NETWORK_PASSPHRASE = Networks.TESTNET;

/** The SoroBunker wasm uploaded to testnet; "Create vault" instantiates it. */
export const VAULT_WASM_HASH = "abf622d05530d32df967738ce5139e19f77201f2db8af03c80a9de5fe69846a5";

/** Native XLM's Stellar Asset Contract on testnet. */
export const XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

export const EXPLORER_TX = "https://stellar.expert/explorer/testnet/tx/";
export const EXPLORER_CONTRACT = "https://stellar.expert/explorer/testnet/contract/";
